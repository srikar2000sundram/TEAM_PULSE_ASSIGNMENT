import { describe, expect, it } from 'vitest';
import { unwrap, type Result } from '@teampulse/kernel';
import { type InMemoryAnalyticsStore } from '../support/in-memory.js';
import {
  ADMIN,
  MANAGER,
  OTHER_TEAM,
  TEAM,
  admin,
  buildHarness,
  manager,
  person,
  principalOf,
  uuid,
} from '../support/harness.js';

const period = { from: '2026-11-01', to: '2026-11-30' };
const errorOf = (result: Result<unknown>) => (result.ok ? undefined : result.error);

describe('RecordActivityAnalytics', () => {
  it('counts an activity in the organisation and in each team of the snapshot', async () => {
    const h = buildHarness();
    await h.crowd(5, { teams: [TEAM, OTHER_TEAM] });

    for (const teamId of [TEAM, OTHER_TEAM]) {
      const result = unwrap(await h.app.getTeamActivity.execute({ actor: admin, teamId, period }));
      expect(result.report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
    }
    const org = unwrap(await h.app.getOrganizationActivity.execute({ actor: admin, period }));
    // Five people, not ten: one person in two teams is still one person in the organisation.
    expect(org.report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
  });

  it('counts a redelivered event once', async () => {
    const h = buildHarness();
    const eventId = uuid(0x999);
    expect(unwrap(await h.app.recordActivity.execute(input(eventId))).counted).toBe(true);
    expect(unwrap(await h.app.recordActivity.execute(input(eventId))).counted).toBe(false);
    const mine = unwrap(
      await h.app.getMyActivity.execute({ actor: principalOf(person(1)), period }),
    );
    expect(mine.total).toBe(1);

    function input(id: string) {
      return {
        eventId: id,
        userId: person(1),
        teamIds: [TEAM],
        activityType: 'walking' as const,
        activityDate: '2026-11-20',
      };
    }
  });

  it('counts a person in the organisation only once even if a team id is repeated', async () => {
    const h = buildHarness();
    await h.record(person(1), { teams: [TEAM, TEAM] });
    expect(
      (await h.store.readCells('SCOPE#TEAM#' + TEAM, '2026-11-20', '2026-11-20'))[0]?.completions,
    ).toBe(1);
  });

  it('stores only pseudonyms in the cells: no user id, and different tokens in different scopes', async () => {
    const h = buildHarness();
    await h.crowd(3, { teams: [TEAM] });
    const stored = (h.store as InMemoryAnalyticsStore).dumpCells();
    for (let n = 1; n <= 3; n += 1) expect(stored).not.toContain(person(n));

    const org = await h.store.readCells('SCOPE#ORG', '2026-11-20', '2026-11-20');
    const team = await h.store.readCells(`SCOPE#TEAM#${TEAM}`, '2026-11-20', '2026-11-20');
    const orgTokens = new Set(org[0]?.participants);
    const teamTokens = team[0]?.participants ?? [];
    expect(orgTokens.size).toBe(3);
    // Nothing links a person's token in one scope to the token in another.
    expect(teamTokens.filter((token) => orgTokens.has(token))).toEqual([]);
  });

  it('keeps counters until the retention period after the activity day', async () => {
    const h = buildHarness({ retentionDays: 31 });
    await h.record(person(1), { date: '2026-11-20' });
    const [day] = await h.store.readPersonal(person(1), '2026-11-20', '2026-11-20');
    expect(day?.expiresAt.toISOString()).toBe('2026-12-21T00:00:00.000Z');
  });
});

describe('who may read team analytics', () => {
  it('lets members of the team, managers of the team and administrators in', async () => {
    const h = buildHarness();
    await h.crowd(5);
    const actors = [
      principalOf(person(1), { teams: [TEAM] }),
      principalOf(uuid(0xe2), { role: 'manager', manages: [TEAM] }),
      admin,
    ];
    for (const actor of actors) {
      const result = await h.app.getTeamActivity.execute({ actor, teamId: TEAM, period });
      expect(result.ok, actor.role).toBe(true);
    }
  });

  it('answers an outsider exactly as for a team that does not exist', async () => {
    const h = buildHarness();
    await h.crowd(5);
    const outsider = principalOf(person(99), { teams: [OTHER_TEAM] });
    const otherManager = principalOf(uuid(0xe3), { role: 'manager', manages: [OTHER_TEAM] });
    for (const actor of [outsider, otherManager]) {
      const real = errorOf(await h.app.getTeamActivity.execute({ actor, teamId: TEAM, period }));
      const missing = errorOf(
        await h.app.getTeamActivity.execute({ actor, teamId: uuid(0x404), period }),
      );
      expect(real?.kind).toBe('not_found');
      expect(real?.code).toBe('team.not_found');
      expect(real?.message).toBe(missing?.message);
    }
  });

  it('shows the whole organisation to administrators only', async () => {
    const h = buildHarness();
    expect((await h.app.getOrganizationActivity.execute({ actor: admin, period })).ok).toBe(true);
    for (const actor of [manager, principalOf(person(1))]) {
      expect(errorOf(await h.app.getOrganizationActivity.execute({ actor, period }))?.kind).toBe(
        'forbidden',
      );
    }
  });
});

describe('privacy of team analytics', () => {
  it('hides a team of fewer than K people entirely', async () => {
    const h = buildHarness();
    await h.crowd(4);
    const { report } = unwrap(
      await h.app.getTeamActivity.execute({ actor: manager, teamId: TEAM, period }),
    );
    expect(report.total).toEqual({ suppressed: true, reason: 'cohort_too_small' });
    expect(report.byDay.every((day) => day.cell.suppressed)).toBe(true);
  });

  it('shows it as soon as the K-th different person joins', async () => {
    const h = buildHarness();
    await h.crowd(4);
    const ask = async () =>
      unwrap(await h.app.getTeamActivity.execute({ actor: manager, teamId: TEAM, period })).report
        .total;
    expect((await ask()).suppressed).toBe(true);
    await h.record(person(5));
    expect(await ask()).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
  });

  it('counts different people, not completions: one very active person does not make a group', async () => {
    const h = buildHarness();
    for (let i = 0; i < 20; i += 1) await h.record(person(1));
    const { report } = unwrap(
      await h.app.getTeamActivity.execute({ actor: manager, teamId: TEAM, period }),
    );
    expect(report.total.suppressed).toBe(true);
  });

  it('uses the configured minimum', async () => {
    const h = buildHarness({ minCohortSize: 3 });
    await h.crowd(3);
    const { report, minCohortSize } = unwrap(
      await h.app.getTeamActivity.execute({ actor: manager, teamId: TEAM, period }),
    );
    expect(minCohortSize).toBe(3);
    expect(report.total.suppressed).toBe(false);
  });

  it('only reads the requested period', async () => {
    const h = buildHarness();
    await h.crowd(5, { date: '2026-10-15' });
    const { report } = unwrap(
      await h.app.getTeamActivity.execute({ actor: manager, teamId: TEAM, period }),
    );
    expect(report.byDay).toEqual([]);
  });
});

describe('GetMyActivity', () => {
  it('returns only the caller’s own numbers', async () => {
    const h = buildHarness();
    await h.record(person(1), { type: 'yoga' });
    await h.record(person(1), { type: 'yoga', date: '2026-11-19' });
    await h.record(person(2), { type: 'running' });

    const mine = unwrap(
      await h.app.getMyActivity.execute({ actor: principalOf(person(1)), period }),
    );
    expect(mine.total).toBe(2);
    expect(mine.byActivityType).toEqual({ yoga: 2 });
    const stranger = unwrap(
      await h.app.getMyActivity.execute({ actor: principalOf(person(3)), period }),
    );
    expect(stranger.total).toBe(0);
  });
});

describe('EraseUserAnalytics', () => {
  it('removes the person’s counters and takes their share out of every team and the organisation', async () => {
    const h = buildHarness();
    await h.crowd(6, { teams: [TEAM, OTHER_TEAM] }); // persons 1..6
    await h.record(person(1), { teams: [TEAM], date: '2026-11-19', type: 'yoga' });

    const erased = unwrap(await h.app.eraseUserAnalytics.execute({ userId: person(1) }));
    expect(erased.erasedDays).toBe(2);

    expect(
      unwrap(await h.app.getMyActivity.execute({ actor: principalOf(person(1)), period })).total,
    ).toBe(0);
    for (const teamId of [TEAM, OTHER_TEAM]) {
      const { report } = unwrap(
        await h.app.getTeamActivity.execute({ actor: admin, teamId, period }),
      );
      // 6 people became 5 and the 7 completions became 5: nothing of person 1 is left.
      expect(report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
      expect(Object.keys(report.byActivityType)).toEqual(['walking']);
    }
    const org = unwrap(await h.app.getOrganizationActivity.execute({ actor: admin, period }));
    expect(org.report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
  });

  it('can be repeated without taking anything more away', async () => {
    const h = buildHarness();
    await h.crowd(6);
    await h.app.eraseUserAnalytics.execute({ userId: person(1) });
    const second = unwrap(await h.app.eraseUserAnalytics.execute({ userId: person(1) }));
    expect(second.erasedDays).toBe(0);
    const { report } = unwrap(
      await h.app.getTeamActivity.execute({ actor: admin, teamId: TEAM, period }),
    );
    expect(report.total).toEqual({ suppressed: false, value: 5, cohortSize: 5 });
  });

  it('does nothing for a person who has no data', async () => {
    const h = buildHarness();
    expect(unwrap(await h.app.eraseUserAnalytics.execute({ userId: person(42) })).erasedDays).toBe(
      0,
    );
  });

  it('logs the erasure without the user id', async () => {
    const h = buildHarness();
    await h.record(person(1));
    await h.app.eraseUserAnalytics.execute({ userId: person(1) });
    expect(h.logLines.join('\n')).toContain('insight.user_erased');
    expect(h.logLines.join('\n')).not.toContain(person(1));
    expect(h.logLines.join('\n')).not.toContain(ADMIN);
    expect(h.logLines.join('\n')).not.toContain(MANAGER);
  });
});
