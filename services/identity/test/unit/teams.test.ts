import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import type { Result } from '@teampulse/kernel';
import { buildHarness } from '../support/harness.js';

function errorOf<T>(result: Result<T>) {
  if (result.ok) throw new Error('expected a failure but the operation succeeded');
  return result.error;
}

async function setup() {
  const h = buildHarness();
  const admin = await h.seedUser({ email: 'admin@example.com', role: 'admin' });
  const manager = await h.seedUser({
    email: 'manager@example.com',
    role: 'manager',
    displayName: 'Mia Manager',
  });
  const alice = await h.seedUser({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = await h.seedUser({ email: 'bob@example.com', displayName: 'Bob' });
  return { h, admin, manager, alice, bob, adminActor: await h.principalOf(admin) };
}

describe('CreateTeam', () => {
  it('lets an admin create a team managed by a manager', async () => {
    const { h, manager, adminActor } = await setup();
    const result = await h.app.createTeam.execute({
      actor: adminActor,
      name: '  Platform  ',
      managerUserId: manager.id,
    });
    expect(result.ok && result.value).toMatchObject({
      name: 'Platform',
      managerUserId: manager.id,
    });
  });

  it('requires the manager role for the team manager', async () => {
    const { h, alice, adminActor } = await setup();
    const result = await h.app.createTeam.execute({
      actor: adminActor,
      name: 'X',
      managerUserId: alice.id,
    });
    expect(errorOf(result).code).toBe('team.manager_role');
  });

  it('rejects an unknown or disabled manager', async () => {
    const { h, adminActor } = await setup();
    const disabled = await h.seedUser({
      email: 'old@example.com',
      role: 'manager',
      disabled: true,
    });
    expect(
      errorOf(
        await h.app.createTeam.execute({
          actor: adminActor,
          name: 'X',
          managerUserId: disabled.id,
        }),
      ).code,
    ).toBe('user.not_found');
    expect(
      errorOf(
        await h.app.createTeam.execute({
          actor: adminActor,
          name: 'X',
          managerUserId: '99999999-9999-4999-8999-999999999999',
        }),
      ).code,
    ).toBe('user.not_found');
  });

  it('rejects duplicate names regardless of case, and invalid names', async () => {
    const { h, manager, adminActor } = await setup();
    await h.app.createTeam.execute({
      actor: adminActor,
      name: 'Platform',
      managerUserId: manager.id,
    });
    expect(
      errorOf(
        await h.app.createTeam.execute({
          actor: adminActor,
          name: 'PLATFORM',
          managerUserId: manager.id,
        }),
      ).code,
    ).toBe('team.name_taken');
    expect(
      errorOf(
        await h.app.createTeam.execute({
          actor: adminActor,
          name: '   ',
          managerUserId: manager.id,
        }),
      ).code,
    ).toBe('team.name_invalid');
  });

  it('is admin only', async () => {
    const { h, manager } = await setup();
    const result = await h.app.createTeam.execute({
      actor: await h.principalOf(manager),
      name: 'Mine',
      managerUserId: manager.id,
    });
    expect(errorOf(result).kind).toBe('forbidden');
  });
});

describe('membership', () => {
  it('adds a member and emits one valid TeamMembershipChanged event', async () => {
    const { h, manager, alice, adminActor } = await setup();
    const team = await h.seedTeam(manager);

    const result = await h.app.addTeamMember.execute({
      actor: adminActor,
      teamId: team.id,
      userId: alice.id,
    });

    expect(result.ok).toBe(true);
    expect(await h.uow.run((tx) => tx.teams.isMember(team.id, alice.id))).toBe(true);
    const [event] = h.uow.store.outbox;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'TeamMembershipChanged',
      payload: { userId: alice.id, teamId: team.id, change: 'added' },
    });
  });

  it('is idempotent: adding twice succeeds but emits only once', async () => {
    const { h, manager, alice, adminActor } = await setup();
    const team = await h.seedTeam(manager);
    await h.app.addTeamMember.execute({ actor: adminActor, teamId: team.id, userId: alice.id });
    const again = await h.app.addTeamMember.execute({
      actor: adminActor,
      teamId: team.id,
      userId: alice.id,
    });
    expect(again.ok).toBe(true);
    expect(h.uow.store.outbox).toHaveLength(1);
  });

  it('rejects unknown teams and users, and disabled users', async () => {
    const { h, manager, alice, adminActor } = await setup();
    const team = await h.seedTeam(manager);
    const disabled = await h.seedUser({ email: 'gone@example.com', disabled: true });
    const ghost = '99999999-9999-4999-8999-999999999999';

    expect(
      errorOf(
        await h.app.addTeamMember.execute({ actor: adminActor, teamId: ghost, userId: alice.id }),
      ).code,
    ).toBe('team.not_found');
    expect(
      errorOf(
        await h.app.addTeamMember.execute({ actor: adminActor, teamId: team.id, userId: ghost }),
      ).code,
    ).toBe('user.not_found');
    expect(
      errorOf(
        await h.app.addTeamMember.execute({
          actor: adminActor,
          teamId: team.id,
          userId: disabled.id,
        }),
      ).code,
    ).toBe('user.disabled');
    expect(h.uow.store.outbox).toHaveLength(0);
  });

  it('removes a member and emits an event only when something was actually removed', async () => {
    const { h, manager, alice, adminActor } = await setup();
    const team = await h.seedTeam(manager);
    await h.app.addTeamMember.execute({ actor: adminActor, teamId: team.id, userId: alice.id });

    await h.app.removeTeamMember.execute({ actor: adminActor, teamId: team.id, userId: alice.id });
    await h.app.removeTeamMember.execute({ actor: adminActor, teamId: team.id, userId: alice.id });

    const changes = h.uow.store.outbox.map(
      (e) => (e as { payload: { change: string } }).payload.change,
    );
    expect(changes).toEqual(['added', 'removed']);
  });

  it('only admins can change membership, even the team manager cannot', async () => {
    const { h, manager, alice } = await setup();
    const team = await h.seedTeam(manager);
    const result = await h.app.addTeamMember.execute({
      actor: await h.principalOf(manager),
      teamId: team.id,
      userId: alice.id,
    });
    expect(errorOf(result).kind).toBe('forbidden');
  });
});

describe('visibility of teams and rosters', () => {
  it('shows each person only the teams that concern them', async () => {
    const { h, manager, alice, bob, adminActor } = await setup();
    const platform = await h.seedTeam(manager, 'Platform');
    const other = await h.seedTeam(manager, 'Other');
    await h.uow.run((tx) => tx.teams.addMember(platform.id, alice.id, h.clock.now()));

    const names = async (user: typeof alice, role = user.role) => {
      const result = await h.app.listTeams.execute({
        actor: { ...(await h.principalOf(user)), role },
      });
      return result.ok ? result.value.map((s) => s.team.name) : [];
    };

    expect(await names(alice)).toEqual(['Platform']);
    expect(await names(bob)).toEqual([]);
    expect(await names(manager)).toEqual(['Other', 'Platform']);
    const all = await h.app.listTeams.execute({ actor: adminActor });
    expect(all.ok && all.value.map((s) => s.team.id).sort()).toEqual(
      [other.id, platform.id].sort(),
    );
    expect(all.ok && all.value.find((s) => s.team.id === platform.id)?.memberCount).toBe(1);
  });

  it('shows a roster to its members, manager and admins, and hides it from everyone else', async () => {
    const { h, manager, alice, bob, adminActor } = await setup();
    const team = await h.seedTeam(manager);
    await h.uow.run((tx) => tx.teams.addMember(team.id, alice.id, h.clock.now()));

    const roster = async (actor: Parameters<typeof h.app.listTeamMembers.execute>[0]['actor']) =>
      h.app.listTeamMembers.execute({ actor, teamId: team.id });

    for (const actor of [adminActor, await h.principalOf(manager), await h.principalOf(alice)]) {
      const result = await roster(actor);
      expect(result.ok && result.value).toEqual([{ id: alice.id, displayName: 'Alice' }]);
    }

    const outsider = await roster(await h.principalOf(bob));
    const missing = await h.app.listTeamMembers.execute({
      actor: await h.principalOf(bob),
      teamId: '99999999-9999-4999-8999-999999999999',
    });
    // Same error for "exists but not yours" and "does not exist": team existence is not revealed.
    expect(errorOf(outsider)).toMatchObject({ kind: 'not_found', code: 'team.not_found' });
    expect(errorOf(missing)).toMatchObject({ kind: 'not_found', code: 'team.not_found' });
  });
});

describe('team limits that keep access tokens issuable', () => {
  it('stops a user joining more teams than a token can carry, but stays idempotent for existing ones', async () => {
    const { h, manager, alice, adminActor } = await setup();
    const teamIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const team = await h.seedTeam(manager, `Team ${String.fromCharCode(65 + i)}`);
      teamIds.push(team.id);
      expect(
        (
          await h.app.addTeamMember.execute({
            actor: adminActor,
            teamId: team.id,
            userId: alice.id,
          })
        ).ok,
      ).toBe(true);
    }
    const extra = await h.seedTeam(manager, 'Team Overflow');

    const result = await h.app.addTeamMember.execute({
      actor: adminActor,
      teamId: extra.id,
      userId: alice.id,
    });
    expect(errorOf(result)).toMatchObject({ kind: 'conflict', code: 'user.too_many_teams' });

    // Re-adding to a team they already belong to is still fine.
    expect(
      (
        await h.app.addTeamMember.execute({
          actor: adminActor,
          teamId: teamIds[0]!,
          userId: alice.id,
        })
      ).ok,
    ).toBe(true);
  });

  it('stops a manager owning more teams than a token can carry', async () => {
    const { h, manager, adminActor } = await setup();
    for (let i = 0; i < 20; i += 1) {
      const created = await h.app.createTeam.execute({
        actor: adminActor,
        name: `Team ${String.fromCharCode(65 + i)}`,
        managerUserId: manager.id,
      });
      expect(created.ok).toBe(true);
    }
    const result = await h.app.createTeam.execute({
      actor: adminActor,
      name: 'Overflow',
      managerUserId: manager.id,
    });
    expect(errorOf(result).code).toBe('manager.too_many_teams');
  });
});
