import { describe, expect, it } from 'vitest';
import { unwrap } from '@teampulse/kernel';
import { Habit, type Sharing } from '../../src/domain/habit.js';
import { ALICE, BOB, DATA, PLATFORM, REMINDER, uuid } from '../support/harness.js';

const NOW = new Date('2026-11-20T08:00:00Z');
const LATER = new Date('2026-11-21T08:00:00Z');

const create = (
  overrides: { title?: string; description?: string | null; sharing?: Sharing } = {},
) =>
  Habit.create({
    id: uuid(1),
    ownerUserId: ALICE,
    title: overrides.title ?? 'Morning walk',
    description: overrides.description,
    activityType: 'walking',
    sharing: overrides.sharing ?? { visibility: 'private' },
    now: NOW,
  });

describe('Habit.create', () => {
  it('trims the title and starts active and private', () => {
    const habit = unwrap(create({ title: '  Morning walk  ' }));
    expect(habit).toMatchObject({
      title: 'Morning walk',
      visibility: 'private',
      teamId: null,
      description: null,
      reminder: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(habit.isArchived).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(81)],
  ])('rejects a title that is %s', (_name, title) => {
    const result = create({ title });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('habit.title_invalid');
  });

  it('accepts a title at the length limit', () => {
    expect(create({ title: 'x'.repeat(80) }).ok).toBe(true);
  });

  it('stores a blank description as no description', () => {
    expect(unwrap(create({ description: '   ' })).description).toBeNull();
    expect(unwrap(create({ description: ' keep it short ' })).description).toBe('keep it short');
  });

  it('rejects an over-long description', () => {
    const result = create({ description: 'x'.repeat(501) });
    expect(!result.ok && result.error.code).toBe('habit.description_invalid');
  });

  it('puts reminder days in calendar order so equal reminders look equal', () => {
    const habit = unwrap(
      Habit.create({
        id: uuid(1),
        ownerUserId: ALICE,
        title: 'Stretch',
        activityType: 'yoga',
        sharing: { visibility: 'private' },
        reminder: { ...REMINDER, daysOfWeek: ['fri', 'mon', 'wed'] },
        now: NOW,
      }),
    );
    expect(habit.reminder?.daysOfWeek).toEqual(['mon', 'wed', 'fri']);
  });

  it('exposes the team of a shared habit', () => {
    const habit = unwrap(create({ sharing: { visibility: 'team', teamId: PLATFORM } }));
    expect(habit.visibility).toBe('team');
    expect(habit.teamId).toBe(PLATFORM);
  });
});

describe('Habit.apply', () => {
  const base = () => unwrap(create({ description: 'before' }));

  it('changes only the fields that are given, and stamps the update time', () => {
    const updated = unwrap(base().apply({ title: 'Evening walk' }, LATER));
    expect(updated).toMatchObject({
      title: 'Evening walk',
      description: 'before',
      activityType: 'walking',
      updatedAt: LATER,
      createdAt: NOW,
    });
  });

  it('clears the description and the reminder with null', () => {
    const withReminder = unwrap(base().apply({ reminder: REMINDER }, NOW));
    expect(withReminder.reminder).not.toBeNull();
    const cleared = unwrap(withReminder.apply({ description: null, reminder: null }, LATER));
    expect(cleared.description).toBeNull();
    expect(cleared.reminder).toBeNull();
  });

  it('does not modify the original (immutability)', () => {
    const original = base();
    original.apply({ title: 'Other' }, LATER);
    expect(original.title).toBe('Morning walk');
  });

  it('validates the new title like a new habit', () => {
    const result = base().apply({ title: '   ' }, LATER);
    expect(!result.ok && result.error.code).toBe('habit.title_invalid');
  });

  it('refuses to change an archived habit', () => {
    const archived = base().archive(NOW);
    const result = archived.apply({ title: 'Nope' }, LATER);
    expect(!result.ok && result.error.kind).toBe('conflict');
    expect(!result.ok && result.error.code).toBe('habit.archived');
  });
});

describe('Habit.archive and makePrivate', () => {
  it('archives once: archiving again keeps the first time', () => {
    const first = unwrap(create()).archive(NOW);
    const second = first.archive(LATER);
    expect(second).toBe(first);
    expect(second.archivedAt).toEqual(NOW);
  });

  it('withdraws a habit from its team', () => {
    const shared = unwrap(create({ sharing: { visibility: 'team', teamId: PLATFORM } }));
    const withdrawn = shared.makePrivate(LATER);
    expect(withdrawn).toMatchObject({ visibility: 'private', teamId: null, updatedAt: LATER });
  });
});

describe('Habit.isVisibleTo: the single visibility rule', () => {
  const shared = unwrap(create({ sharing: { visibility: 'team', teamId: PLATFORM } }));
  const priv = unwrap(create());

  it('the owner always sees their own habit, shared or not, archived or not', () => {
    const viewer = { userId: ALICE, teamIds: [] };
    expect(priv.isVisibleTo(viewer)).toBe(true);
    expect(shared.isVisibleTo(viewer)).toBe(true);
    expect(priv.archive(NOW).isVisibleTo(viewer)).toBe(true);
    expect(shared.archive(NOW).isVisibleTo(viewer)).toBe(true);
  });

  it('a member of the team sees a shared active habit', () => {
    expect(shared.isVisibleTo({ userId: BOB, teamIds: [PLATFORM] })).toBe(true);
    expect(shared.isVisibleTo({ userId: BOB, teamIds: [DATA, PLATFORM] })).toBe(true);
  });

  it('nobody else sees a private habit', () => {
    expect(priv.isVisibleTo({ userId: BOB, teamIds: [PLATFORM] })).toBe(false);
  });

  it('a member of another team does not see a team habit', () => {
    expect(shared.isVisibleTo({ userId: BOB, teamIds: [DATA] })).toBe(false);
    expect(shared.isVisibleTo({ userId: BOB, teamIds: [] })).toBe(false);
  });

  it('an archived habit disappears for everyone but the owner', () => {
    expect(shared.archive(NOW).isVisibleTo({ userId: BOB, teamIds: [PLATFORM] })).toBe(false);
  });
});

describe('Habit.differsForSubscribers', () => {
  const base = unwrap(create());

  it('ignores title and description: other services never see them', () => {
    const edited = unwrap(base.apply({ title: 'Renamed', description: 'New notes' }, LATER));
    expect(base.differsForSubscribers(edited)).toBe(false);
  });

  it('notices activity type, sharing and reminder changes', () => {
    expect(base.differsForSubscribers(unwrap(base.apply({ activityType: 'yoga' }, LATER)))).toBe(
      true,
    );
    expect(
      base.differsForSubscribers(
        unwrap(base.apply({ sharing: { visibility: 'team', teamId: PLATFORM } }, LATER)),
      ),
    ).toBe(true);
    expect(base.differsForSubscribers(unwrap(base.apply({ reminder: REMINDER }, LATER)))).toBe(
      true,
    );
  });

  it('treats the same reminder as unchanged however its days were ordered', () => {
    const a = unwrap(base.apply({ reminder: REMINDER }, LATER));
    const b = unwrap(a.apply({ reminder: { ...REMINDER, daysOfWeek: ['mon', 'wed'] } }, LATER));
    expect(a.differsForSubscribers(b)).toBe(false);
  });
});
