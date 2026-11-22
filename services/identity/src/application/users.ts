import type { Role } from '@teampulse/contracts';
import { requireRole, type Principal } from '@teampulse/auth';
import {
  conflictError,
  decodeCursor,
  err,
  notFoundError,
  pageOf,
  ok,
  validationError,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import { Email } from '../domain/email.js';
import { validateNewPassword } from '../domain/password-policy.js';
import { User } from '../domain/user.js';
import type { PasswordHasher, Transaction, UnitOfWork } from './ports.js';
import type { EventFactory } from '@teampulse/outbox';
import { requireActiveActor } from './support.js';

const DISPLAY_NAME_MAX = 100;

interface NewUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly password: string;
}

export interface UserCreationDeps {
  readonly uow: UnitOfWork;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventFactory;
  readonly logger: Logger;
}

/** Validates input, hashes the password, and stores the user plus its event atomically. */
async function registerUser(
  deps: UserCreationDeps,
  input: NewUserInput,
  preflight?: (tx: Transaction) => Promise<Result<void>>,
  actorUserId?: string,
): Promise<Result<User>> {
  const email = Email.create(input.email);
  if (!email.ok) return email;

  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
    return err(validationError('user.display_name_invalid', 'The display name is not valid'));
  }

  const passwordCheck = validateNewPassword(input.password, email.value);
  if (!passwordCheck.ok) return passwordCheck;

  const passwordHash = await deps.hasher.hash(input.password);
  const user = User.create({
    id: deps.ids.next(),
    email: email.value,
    displayName,
    passwordHash,
    role: input.role,
    now: deps.clock.now(),
  });

  return deps.uow.run(async (tx) => {
    if (preflight !== undefined) {
      const allowed = await preflight(tx);
      if (!allowed.ok) return allowed;
    }
    const inserted = await tx.users.insert(user);
    if (!inserted.ok) return inserted;
    await tx.outbox.append(
      deps.events.create('UserRegistered', { userId: user.id, role: user.role }),
    );
    deps.logger.info(
      {
        event: 'user.created',
        ...(actorUserId === undefined ? {} : { actorUserId }),
        userId: user.id,
        role: user.role,
      },
      'user created',
    );
    return ok(user);
  });
}

/* ------------------------------------------------------------------------------------------ */

export class CreateUser {
  constructor(private readonly deps: UserCreationDeps) {}

  execute(input: NewUserInput & { actor: Principal }): Promise<Result<User>> {
    // Cheap check on the token's role first, so an unauthorised caller cannot make the server
    // spend CPU on password hashing. The authoritative check against the database follows,
    // inside the same transaction as the insert.
    const claim = requireRole(input.actor, 'admin');
    if (!claim.ok) return Promise.resolve(claim);

    return registerUser(
      this.deps,
      input,
      async (tx) => {
        const actor = await requireActiveActor(tx, input.actor, 'admin');
        return actor.ok ? ok(undefined) : actor;
      },
      input.actor.userId,
    );
  }
}

/**
 * Creates the first administrator. Refuses to run once an active administrator exists, so it can
 * never be used to add a second one behind the normal authorization rules.
 */
export class BootstrapAdmin {
  constructor(private readonly deps: UserCreationDeps) {}

  execute(input: Omit<NewUserInput, 'role'>): Promise<Result<User>> {
    return registerUser(this.deps, { ...input, role: 'admin' }, async (tx) =>
      (await tx.users.countActiveAdmins()) === 0
        ? ok(undefined)
        : err(conflictError('user.admin_exists', 'An administrator already exists')),
    );
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface DeleteUserDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly events: EventFactory;
  readonly logger: Logger;
}

/**
 * Deletes an account (right to erasure). Memberships and sessions go with it, and `UserDeleted`
 * tells every other service to erase or anonymise what it holds about the person.
 */
export class DeleteUser {
  constructor(private readonly deps: DeleteUserDeps) {}

  execute(input: { actor: Principal; userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      if (actor.value.id === input.userId) {
        return err(conflictError('user.cannot_delete_self', 'You cannot delete your own account'));
      }

      const target = await tx.users.findById(input.userId);
      if (target === null) return err(notFoundError('user.not_found', 'User not found'));

      // Invariant: at least one active administrator always remains. The actor is an active admin
      // (checked above) and cannot delete themselves (checked above), so whoever is deleted here,
      // the actor survives. No separate "last admin" check is needed.
      if ((await tx.teams.teamIdsManagedBy(target.id)).length > 0) {
        return err(
          conflictError(
            'user.manages_teams',
            'Assign the teams of this manager to someone else first',
          ),
        );
      }

      await tx.tokens.revokeAllForUser(target.id, this.deps.clock.now());
      await tx.users.delete(target.id);
      await tx.outbox.append(this.deps.events.create('UserDeleted', { userId: target.id }));
      this.deps.logger.info(
        { event: 'user.deleted', actorUserId: actor.value.id, userId: target.id },
        'user deleted',
      );
      return ok(undefined);
    });
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface UpdateUserDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Changes a user's role and/or status (offboarding without erasing data, promotions).
 * An administrator cannot change their own account: that single rule guarantees that at least one
 * active administrator always remains, and prevents locking everyone out by accident.
 */
export class UpdateUser {
  constructor(private readonly deps: UpdateUserDeps) {}

  execute(input: {
    actor: Principal;
    userId: string;
    role?: Role | undefined;
    status?: 'active' | 'disabled' | undefined;
  }): Promise<Result<User>> {
    if (input.role === undefined && input.status === undefined) {
      return Promise.resolve(
        err(validationError('user.update_empty', 'Provide a role, a status, or both')),
      );
    }

    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      if (actor.value.id === input.userId) {
        return err(conflictError('user.cannot_modify_self', 'You cannot change your own account'));
      }

      const target = await tx.users.findByIdForUpdate(input.userId);
      if (target === null) return err(notFoundError('user.not_found', 'User not found'));

      const now = this.deps.clock.now();
      let updated = target;

      if (input.role !== undefined && input.role !== target.role) {
        // A manager's teams would be left without a valid manager.
        if (target.role === 'manager' && (await tx.teams.teamIdsManagedBy(target.id)).length > 0) {
          return err(
            conflictError(
              'user.manages_teams',
              'Assign the teams of this manager to someone else first',
            ),
          );
        }
        updated = updated.changeRole(input.role, now);
      }

      if (input.status === 'disabled') updated = updated.disable(now);
      if (input.status === 'active') updated = updated.enable(now);

      if (updated !== target) await tx.users.update(updated);

      // A disabled account must not be able to renew its session.
      if (target.isActive && !updated.isActive) await tx.tokens.revokeAllForUser(target.id, now);

      // Audit trail: who changed what. Ids are pseudonymised by the logger.
      this.deps.logger.info(
        {
          event: 'user.updated',
          actorUserId: actor.value.id,
          userId: target.id,
          roleChanged: updated.role !== target.role,
          statusChanged: updated.status !== target.status,
          newRole: updated.role,
          newStatus: updated.status,
        },
        'user updated',
      );
      return ok(updated);
    });
  }
}

/* ------------------------------------------------------------------------------------------ */

export interface UserPage {
  readonly items: readonly User[];
  readonly nextCursor: string | undefined;
}

export class ListUsers {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: {
    actor: Principal;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Result<UserPage>> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (after !== undefined && !after.ok) return Promise.resolve(after);

    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      // Ask for one extra row to learn whether another page exists without a count query.
      const rows = await tx.users.list({
        limit: input.limit + 1,
        ...(after === undefined ? {} : { after: after.value }),
      });
      return ok(pageOf(rows, input.limit));
    });
  }
}

/* ------------------------------------------------------------------------------------------ */

export class GetCurrentUser {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal }): Promise<Result<User>> {
    return this.deps.uow.run(async (tx) => {
      const user = await tx.users.findById(input.actor.userId);
      return user === null || !user.isActive
        ? err(notFoundError('user.not_found', 'User not found'))
        : ok(user);
    });
  }
}
