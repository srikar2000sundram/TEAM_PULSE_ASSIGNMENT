import type { Principal } from '@teampulse/auth';
import { MAX_TEAM_CLAIMS } from '@teampulse/contracts';
import {
  conflictError,
  err,
  notFoundError,
  ok,
  validationError,
  type Clock,
  type IdGenerator,
  type Result,
} from '@teampulse/kernel';
import type { Team, TeamMember, TeamSummary } from '../domain/team.js';
import type { Logger } from '@teampulse/observability';
import type { UnitOfWork } from './ports.js';
import type { EventFactory } from '@teampulse/outbox';
import { requireActiveActor } from './support.js';

const NAME_MAX = 100;
const teamNotFound = () => notFoundError('team.not_found', 'Team not found');
const userNotFound = () => notFoundError('user.not_found', 'User not found');

export class CreateTeam {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator; logger: Logger },
  ) {}

  execute(input: { actor: Principal; name: string; managerUserId: string }): Promise<Result<Team>> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      return Promise.resolve(
        err(validationError('team.name_invalid', 'The team name is not valid')),
      );
    }

    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      const manager = await tx.users.findById(input.managerUserId);
      if (manager === null || !manager.isActive) return err(userNotFound());
      if (manager.role !== 'manager') {
        return err(
          validationError('team.manager_role', 'The team manager must have the manager role'),
        );
      }

      // Team ids travel inside access tokens, which are capped (see MAX_TEAM_CLAIMS). Refuse the
      // state that would make a token impossible to issue instead of failing at login time.
      if ((await tx.teams.teamIdsManagedBy(manager.id)).length >= MAX_TEAM_CLAIMS) {
        return err(
          conflictError(
            'manager.too_many_teams',
            `A manager can manage at most ${MAX_TEAM_CLAIMS} teams`,
          ),
        );
      }

      const team: Team = {
        id: this.deps.ids.next(),
        name,
        managerUserId: manager.id,
        createdAt: this.deps.clock.now(),
      };
      const inserted = await tx.teams.insert(team);
      if (!inserted.ok) return inserted;
      this.deps.logger.info(
        {
          event: 'team.created',
          actorUserId: actor.value.id,
          teamId: team.id,
          ownerUserId: manager.id,
        },
        'team created',
      );
      return ok(team);
    });
  }
}

/**
 * Admins see every team. Everyone else sees the teams they belong to (and managers also the
 * teams they manage), so the organisation chart is not exposed to every employee.
 */
export class ListTeams {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  execute(input: { actor: Principal }): Promise<Result<readonly TeamSummary[]>> {
    return this.deps.uow.run(async (tx) => {
      if (input.actor.role === 'admin') {
        const actor = await requireActiveActor(tx, input.actor, 'admin');
        return actor.ok ? ok(await tx.teams.listAll()) : actor;
      }
      return ok(await tx.teams.listForUser(input.actor.userId));
    });
  }
}

export class ListTeamMembers {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  /**
   * Visible to admins, the team's manager, and its members. Anyone else gets "not found", never
   * "forbidden", so the existence of a team is not revealed to outsiders.
   */
  execute(input: { actor: Principal; teamId: string }): Promise<Result<readonly TeamMember[]>> {
    return this.deps.uow.run(async (tx) => {
      const team = await tx.teams.findById(input.teamId);
      if (team === null) return err(teamNotFound());

      const actor = await tx.users.findById(input.actor.userId);
      if (actor === null || !actor.isActive) return err(teamNotFound());

      const allowed =
        actor.role === 'admin' ||
        team.managerUserId === actor.id ||
        (await tx.teams.isMember(team.id, actor.id));
      return allowed ? ok(await tx.teams.members(team.id)) : err(teamNotFound());
    });
  }
}

export class AddTeamMember {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; events: EventFactory; logger: Logger },
  ) {}

  execute(input: { actor: Principal; teamId: string; userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      if ((await tx.teams.findById(input.teamId)) === null) return err(teamNotFound());
      const user = await tx.users.findById(input.userId);
      if (user === null) return err(userNotFound());
      if (!user.isActive) {
        return err(conflictError('user.disabled', 'A disabled user cannot join a team'));
      }

      // Same token-size reasoning as for managers. Re-adding an existing member stays idempotent.
      if (
        !(await tx.teams.isMember(input.teamId, user.id)) &&
        (await tx.teams.teamIdsOfMember(user.id)).length >= MAX_TEAM_CLAIMS
      ) {
        return err(
          conflictError(
            'user.too_many_teams',
            `A user can belong to at most ${MAX_TEAM_CLAIMS} teams`,
          ),
        );
      }

      // Idempotent: adding an existing member succeeds quietly and emits nothing.
      const added = await tx.teams.addMember(input.teamId, user.id, this.deps.clock.now());
      if (added) {
        await tx.outbox.append(
          this.deps.events.create('TeamMembershipChanged', {
            userId: user.id,
            teamId: input.teamId,
            change: 'added',
          }),
        );
        this.deps.logger.info(
          {
            event: 'team.member_added',
            actorUserId: actor.value.id,
            userId: user.id,
            teamId: input.teamId,
          },
          'team member added',
        );
      }
      return ok(undefined);
    });
  }
}

export class RemoveTeamMember {
  constructor(private readonly deps: { uow: UnitOfWork; events: EventFactory; logger: Logger }) {}

  execute(input: { actor: Principal; teamId: string; userId: string }): Promise<Result<void>> {
    return this.deps.uow.run(async (tx) => {
      const actor = await requireActiveActor(tx, input.actor, 'admin');
      if (!actor.ok) return actor;

      if ((await tx.teams.findById(input.teamId)) === null) return err(teamNotFound());

      const removed = await tx.teams.removeMember(input.teamId, input.userId);
      if (removed) {
        await tx.outbox.append(
          this.deps.events.create('TeamMembershipChanged', {
            userId: input.userId,
            teamId: input.teamId,
            change: 'removed',
          }),
        );
        this.deps.logger.info(
          {
            event: 'team.member_removed',
            actorUserId: actor.value.id,
            userId: input.userId,
            teamId: input.teamId,
          },
          'team member removed',
        );
      }
      return ok(undefined);
    });
  }
}
