import type { Clock, IdGenerator } from '@teampulse/kernel';
import type { Logger } from '@teampulse/observability';
import type { LockoutPolicy } from '../domain/user.js';
import type { RotationPolicy } from '../domain/refresh-token.js';
import { ChangePassword, Login, Logout, RefreshSession } from './auth.js';
import type { AccessTokenIssuer, OpaqueTokens, PasswordHasher, UnitOfWork } from './ports.js';
import { EventFactory } from '@teampulse/outbox';
import {
  AddTeamMember,
  CreateTeam,
  ListTeamMembers,
  ListTeams,
  RemoveTeamMember,
} from './teams.js';
import {
  BootstrapAdmin,
  CreateUser,
  DeleteUser,
  GetCurrentUser,
  ListUsers,
  UpdateUser,
} from './users.js';

export interface ApplicationDeps {
  readonly uow: UnitOfWork;
  readonly hasher: PasswordHasher;
  readonly tokenIssuer: AccessTokenIssuer;
  readonly opaqueTokens: OpaqueTokens;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly lockout: LockoutPolicy;
  readonly rotation: RotationPolicy;
  /** See `LoginDeps.decoyPasswordHash`. */
  readonly decoyPasswordHash: string;
}

export type IdentityUseCases = ReturnType<typeof createUseCases>;

/**
 * The single place where use cases are assembled from their dependencies. Production, the CLI
 * tools and the tests all call this, so they cannot disagree about how the application is wired.
 */
export function createUseCases(deps: ApplicationDeps) {
  const { uow, hasher, clock, ids, logger } = deps;
  const events = new EventFactory(clock, ids);
  const creation = { uow, hasher, clock, ids, events, logger };

  return {
    login: new Login(deps),
    refresh: new RefreshSession(deps),
    logout: new Logout({ uow, opaqueTokens: deps.opaqueTokens, clock }),
    changePassword: new ChangePassword({ uow, hasher, clock, logger, lockout: deps.lockout }),
    createUser: new CreateUser(creation),
    bootstrapAdmin: new BootstrapAdmin(creation),
    deleteUser: new DeleteUser({ uow, clock, events, logger }),
    updateUser: new UpdateUser({ uow, clock, logger }),
    listUsers: new ListUsers({ uow }),
    getCurrentUser: new GetCurrentUser({ uow }),
    createTeam: new CreateTeam({ uow, clock, ids, logger }),
    listTeams: new ListTeams({ uow }),
    listTeamMembers: new ListTeamMembers({ uow }),
    addTeamMember: new AddTeamMember({ uow, clock, events, logger }),
    removeTeamMember: new RemoveTeamMember({ uow, events, logger }),
  };
}
