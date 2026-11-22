import { describe, expect, it } from 'vitest';
import type { AnalyticsStore } from '../../src/application/ports.js';

const EXPIRES = new Date('2027-12-31T00:00:00Z');
const ORG = 'SCOPE#ORG';
const TEAM = 'SCOPE#TEAM#t1';

const observation = (
  overrides: Partial<{
    eventId: string;
    userId: string;
    day: string;
    activityType: 'walking' | 'yoga';
    participants: Record<string, string>;
  }> = {},
) => {
  const participants = overrides.participants ?? { [ORG]: 'p-org', [TEAM]: 'p-team' };
  return {
    eventId: overrides.eventId ?? 'e1',
    userId: overrides.userId ?? 'u1',
    day: overrides.day ?? '2026-11-20',
    activityType: overrides.activityType ?? ('walking' as const),
    contributions: Object.entries(participants).map(([scopeKey, participant]) => ({
      scopeKey,
      participant,
    })),
    expiresAt: EXPIRES,
  };
};

/**
 * Behaviour every `AnalyticsStore` must have. It runs against the in-memory fake and against the
 * DynamoDB adapter on a fake DynamoDB, so the fake used by the other tests cannot drift from the
 * real adapter's behaviour.
 */
export function describeAnalyticsStoreContract(name: string, create: () => AnalyticsStore): void {
  describe(`${name}: analytics store contract`, () => {
    it('counts an activity in the person’s counters and in every scope', async () => {
      const store = create();
      expect(await store.record(observation())).toBe('recorded');

      expect(await store.readCells(ORG, '2026-11-01', '2026-11-30')).toEqual([
        { day: '2026-11-20', activityType: 'walking', completions: 1, participants: ['p-org'] },
      ]);
      expect(await store.readCells(TEAM, '2026-11-01', '2026-11-30')).toEqual([
        { day: '2026-11-20', activityType: 'walking', completions: 1, participants: ['p-team'] },
      ]);
      const mine = await store.readPersonal('u1', '2026-11-01', '2026-11-30');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ day: '2026-11-20', activityType: 'walking', completions: 1 });
      expect([...(mine[0]?.scopeKeys ?? [])].sort()).toEqual([ORG, TEAM]);
      expect(mine[0]?.expiresAt.getTime()).toBe(EXPIRES.getTime());
    });

    it('counts a redelivered event once', async () => {
      const store = create();
      expect(await store.record(observation())).toBe('recorded');
      expect(await store.record(observation())).toBe('duplicate');
      expect((await store.readCells(ORG, '2026-11-20', '2026-11-20'))[0]?.completions).toBe(1);
      expect((await store.readPersonal('u1', '2026-11-20', '2026-11-20'))[0]?.completions).toBe(1);
    });

    it('counts different events of one person as more completions but the same one person', async () => {
      const store = create();
      await store.record(observation({ eventId: 'e1' }));
      await store.record(observation({ eventId: 'e2' }));
      await store.record(observation({ eventId: 'e3', activityType: 'yoga' }));
      const cells = await store.readCells(ORG, '2026-11-20', '2026-11-20');
      expect(cells.find((c) => c.activityType === 'walking')).toMatchObject({
        completions: 2,
        participants: ['p-org'],
      });
      expect(cells.find((c) => c.activityType === 'yoga')?.completions).toBe(1);
    });

    it('counts different people in one cell, each once', async () => {
      const store = create();
      await store.record(observation({ eventId: 'e1', participants: { [ORG]: 'a' } }));
      await store.record(
        observation({ eventId: 'e2', userId: 'u2', participants: { [ORG]: 'b' } }),
      );
      await store.record(observation({ eventId: 'e3', participants: { [ORG]: 'a' } }));
      const [cell] = await store.readCells(ORG, '2026-11-20', '2026-11-20');
      expect(cell?.completions).toBe(3);
      expect([...(cell?.participants ?? [])].sort()).toEqual(['a', 'b']);
    });

    it('reads the inclusive range of days and nothing outside it', async () => {
      const store = create();
      for (const [i, day] of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].entries()) {
        await store.record(observation({ eventId: `e${i}`, day }));
      }
      const days = async (from: string, to: string) =>
        (await store.readCells(ORG, from, to)).map((c) => c.day).sort();
      expect(await days('2026-11-19', '2026-11-20')).toEqual(['2026-11-19', '2026-11-20']);
      expect(await days('2026-11-20', '2026-11-20')).toEqual(['2026-11-20']);
      expect(await days('2026-12-01', '2026-12-31')).toEqual([]);
    });

    it('keeps scopes and people apart', async () => {
      const store = create();
      await store.record(observation({ eventId: 'e1', participants: { [ORG]: 'a' } }));
      await store.record(
        observation({ eventId: 'e2', userId: 'u2', participants: { 'SCOPE#TEAM#other': 'b' } }),
      );
      expect(await store.readCells(TEAM, '2026-11-20', '2026-11-20')).toEqual([]);
      expect(await store.readPersonal('u2', '2026-11-20', '2026-11-20')).toHaveLength(1);
      expect(await store.readPersonal('nobody', '2026-11-20', '2026-11-20')).toEqual([]);
    });

    it('takes one personal day back out of the cells, and only that person’s share', async () => {
      const store = create();
      await store.record(
        observation({ eventId: 'e1', participants: { [ORG]: 'a', [TEAM]: 'ta' } }),
      );
      await store.record(
        observation({ eventId: 'e2', participants: { [ORG]: 'a', [TEAM]: 'ta' } }),
      );
      await store.record(
        observation({ eventId: 'e3', userId: 'u2', participants: { [ORG]: 'b', [TEAM]: 'tb' } }),
      );

      const [day] = await store.readPersonal('u1', '2026-11-20', '2026-11-20');
      expect(day?.completions).toBe(2);
      await store.erasePersonalDay('u1', day!, [
        { scopeKey: ORG, participant: 'a' },
        { scopeKey: TEAM, participant: 'ta' },
      ]);

      expect(await store.readPersonal('u1', '2026-11-01', '2026-11-30')).toEqual([]);
      expect(await store.readCells(ORG, '2026-11-20', '2026-11-20')).toEqual([
        { day: '2026-11-20', activityType: 'walking', completions: 1, participants: ['b'] },
      ]);
      expect(await store.readCells(TEAM, '2026-11-20', '2026-11-20')).toEqual([
        { day: '2026-11-20', activityType: 'walking', completions: 1, participants: ['tb'] },
      ]);
    });

    it('is safe to erase twice: the second time takes nothing more away', async () => {
      const store = create();
      await store.record(observation({ eventId: 'e1', participants: { [ORG]: 'a' } }));
      await store.record(
        observation({ eventId: 'e2', userId: 'u2', participants: { [ORG]: 'b' } }),
      );
      const [day] = await store.readPersonal('u1', '2026-11-20', '2026-11-20');
      const contributions = [{ scopeKey: ORG, participant: 'a' }];
      await store.erasePersonalDay('u1', day!, contributions);
      await store.erasePersonalDay('u1', day!, contributions);
      expect(await store.readCells(ORG, '2026-11-20', '2026-11-20')).toEqual([
        { day: '2026-11-20', activityType: 'walking', completions: 1, participants: ['b'] },
      ]);
    });

    it('leaves nothing readable once the only person in a cell is erased', async () => {
      const store = create();
      await store.record(observation({ participants: { [ORG]: 'a' } }));
      const [day] = await store.readPersonal('u1', '2026-11-20', '2026-11-20');
      await store.erasePersonalDay('u1', day!, [{ scopeKey: ORG, participant: 'a' }]);
      expect(await store.readCells(ORG, '2026-11-01', '2026-11-30')).toEqual([]);
    });

    it('answers a ping', async () => {
      await expect(create().ping()).resolves.toBeUndefined();
    });
  });
}
