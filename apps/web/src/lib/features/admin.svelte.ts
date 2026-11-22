import type { Role, TeamResponse, UserResponse } from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { AdminApi, IdentityApi } from '../api/index.js';
import { messageOf } from '../format.js';

/** The administrator's view of people and teams. The server enforces who may do any of this. */
export class AdminState {
  readonly users = new AsyncValue<UserResponse[]>();
  readonly teams = new AsyncValue<TeamResponse[]>();
  notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  busy = $state(false);

  constructor(
    private readonly admin: AdminApi,
    private readonly identity: IdentityApi,
  ) {}

  async load(): Promise<void> {
    await Promise.all([
      this.users.load(async () => (await this.admin.users({ limit: 100 })).items),
      this.teams.load(async () => (await this.identity.teams()).items),
    ]);
  }

  private async act(work: () => Promise<string>): Promise<void> {
    this.busy = true;
    this.notice = null;
    try {
      const text = await work();
      await this.load();
      this.notice = { kind: 'ok', text };
    } catch (error) {
      this.notice = { kind: 'error', text: messageOf(error) };
    } finally {
      this.busy = false;
    }
  }

  createUser(input: {
    email: string;
    displayName: string;
    role: Role;
    password: string;
  }): Promise<void> {
    return this.act(async () => {
      await this.admin.createUser(input);
      return `Created ${input.displayName}.`;
    });
  }

  setStatus(user: UserResponse, status: 'active' | 'disabled'): Promise<void> {
    return this.act(async () => {
      await this.admin.updateUser(user.id, { status });
      return status === 'disabled'
        ? `Disabled ${user.displayName}.`
        : `Enabled ${user.displayName}.`;
    });
  }

  createTeam(name: string, managerUserId: string): Promise<void> {
    return this.act(async () => {
      await this.admin.createTeam({ name, managerUserId });
      return `Created team ${name}.`;
    });
  }

  addMember(team: TeamResponse, userId: string): Promise<void> {
    return this.act(async () => {
      await this.admin.addTeamMember(team.id, userId);
      return `Added to ${team.name}.`;
    });
  }
}
