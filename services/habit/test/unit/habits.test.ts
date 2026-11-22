import { describe, expect, it } from 'vitest';
import { parseEvent } from '@teampulse/contracts';
import { unwrap, type Result } from '@teampulse/kernel';
import {
  ALICE,
  BOB,
  CAROL,
  DATA,
  DAVE,
  PLATFORM,
  REMINDER,
  buildHarness,
  principal,
  uuid,
} from '../support/harness.js';

const alice = principal(ALICE, { teams: [PLATFORM] });
const bob = principal(BOB, { teams: [PLATFORM] });
const carol = principal(CAROL, { teams: [DATA] });

const errorOf = (result: Result<unknown>) => (result.ok ? undefined : result.error);

describe('CreateHabit', () => {
  it('creates a private habit by default and publishes HabitCreated without any free text', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, {
      title: 'Secret therapy homework',
      description: 'private notes',
      reminder: REMINDER,
    });

    expect(habit).toMatchObject({ ownerUserId: ALICE, visibility: 'private', teamId: null });

    expect(h.outbox()).toHaveLength(1);
    const event = h.outbox()[0]!;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'HabitCreated',
      producer: 'habit',
      payload: {
        habitId: habit.id,
        ownerUserId: ALICE,
        visibility: 'private',
        activityType: 'walking',
        // Days arrive in calendar order, and the reminder includes its time zone.
        reminder: { daysOfWeek: ['mon', 'wed'], remindAt: '07:30', timeZone: 'Europe/Berlin' },
      },
    });
    // ADR-0005: titles and notes never leave the service.
    expect(JSON.stringify(event)).not.toContain('Secret therapy');
    expect(JSON.stringify(event)).not.toContain('private notes');
  });

  it('omits the reminder from the event when there is none', async () => {
    const h = buildHarness();
    await h.createHabit(alice);
    expect((h.outbox()[0] as { payload: object }).payload).not.toHaveProperty('reminder');
  });

  it('shares with a team the caller belongs to', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    expect(habit).toMatchObject({ visibility: 'team', teamId: PLATFORM });
  });

  it('refuses to share with a team the caller does not belong to', async () => {
    const h = buildHarness();
    const result = await h.app.createHabit.execute({
      actor: alice,
      title: 'Run',
      activityType: 'running',
      visibility: 'team',
      teamId: DATA,
    });
    expect(errorOf(result)).toMatchObject({ kind: 'forbidden', code: 'habit.team_not_member' });
    expect(h.outbox()).toHaveLength(0);
  });

  it('being the manager of a team is not membership', async () => {
    const h = buildHarness();
    const manager = principal(DAVE, { role: 'manager', manages: [PLATFORM] });
    const result = await h.app.createHabit.execute({
      actor: manager,
      title: 'Run',
      activityType: 'running',
      visibility: 'team',
      teamId: PLATFORM,
    });
    expect(errorOf(result)?.code).toBe('habit.team_not_member');
  });

  it('rejects inconsistent sharing even if the contract layer were bypassed', async () => {
    const h = buildHarness();
    const base = { actor: alice, title: 'Run', activityType: 'running' as const };
    expect(errorOf(await h.app.createHabit.execute({ ...base, visibility: 'team' }))?.code).toBe(
      'habit.sharing_invalid',
    );
    expect(
      errorOf(await h.app.createHabit.execute({ ...base, visibility: 'private', teamId: PLATFORM }))
        ?.code,
    ).toBe('habit.sharing_invalid');
  });

  it('rejects an invalid title with a validation error and writes nothing', async () => {
    const h = buildHarness();
    const result = await h.app.createHabit.execute({
      actor: alice,
      title: '   ',
      activityType: 'yoga',
      visibility: 'private',
    });
    expect(errorOf(result)).toMatchObject({ kind: 'validation', code: 'habit.title_invalid' });
    expect(h.uow.store.habits.size).toBe(0);
    expect(h.outbox()).toHaveLength(0);
  });

  it('enforces the active habit limit, and archiving frees a slot', async () => {
    const h = buildHarness({ maxActiveHabits: 2 });
    const first = await h.createHabit(alice, { title: 'One' });
    await h.createHabit(alice, { title: 'Two' });

    const third = await h.app.createHabit.execute({
      actor: alice,
      title: 'Three',
      activityType: 'yoga',
      visibility: 'private',
    });
    expect(errorOf(third)).toMatchObject({ kind: 'conflict', code: 'habit.limit_reached' });

    // Someone else is not affected by Alice's limit.
    await h.createHabit(bob, { title: 'Bob one' });

    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: first.id }));
    await expect(h.createHabit(alice, { title: 'Three' })).resolves.toBeDefined();
  });

  it('logs the creation without the title, and with the user id pseudonymised', async () => {
    const h = buildHarness();
    await h.createHabit(alice, { title: 'Very personal title' });
    const logs = h.logLines.join('\n');
    expect(logs).toContain('habit.created');
    expect(logs).not.toContain('Very personal title');
    expect(logs).not.toContain(ALICE);
  });
});

describe('GetHabit: who may see what', () => {
  it('the owner sees a private habit', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    const result = await h.app.getHabit.execute({ actor: alice, habitId: habit.id });
    expect(result.ok && result.value.id).toBe(habit.id);
  });

  it('teammates see a shared habit but not a private one', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const priv = await h.createHabit(alice, { title: 'Private' });

    expect((await h.app.getHabit.execute({ actor: bob, habitId: shared.id })).ok).toBe(true);
    expect(errorOf(await h.app.getHabit.execute({ actor: bob, habitId: priv.id }))?.kind).toBe(
      'not_found',
    );
  });

  it('a hidden habit is indistinguishable from one that does not exist', async () => {
    const h = buildHarness();
    const priv = await h.createHabit(alice);
    const hidden = await h.app.getHabit.execute({ actor: bob, habitId: priv.id });
    const missing = await h.app.getHabit.execute({ actor: bob, habitId: uuid(0x999) });
    expect(errorOf(hidden)).toEqual(errorOf(missing));
    expect(errorOf(hidden)?.code).toBe('habit.not_found');
  });

  it('people in other teams see nothing', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const result = await h.app.getHabit.execute({ actor: carol, habitId: shared.id });
    expect(errorOf(result)?.code).toBe('habit.not_found');
  });

  it('roles grant nothing: managers and admins follow the same rule as everyone', async () => {
    const h = buildHarness();
    const priv = await h.createHabit(alice, { title: 'Private' });
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });

    // The manager of Alice's team, who is not a member of it, and a global admin.
    const manager = principal(DAVE, { role: 'manager', manages: [PLATFORM] });
    const admin = principal(uuid(0xad), { role: 'admin' });

    for (const actor of [manager, admin]) {
      for (const habit of [priv, shared]) {
        const result = await h.app.getHabit.execute({ actor, habitId: habit.id });
        expect(errorOf(result)?.code).toBe('habit.not_found');
      }
    }
  });

  it('an archived habit is gone for teammates but still visible to its owner', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: shared.id }));

    expect(errorOf(await h.app.getHabit.execute({ actor: bob, habitId: shared.id }))?.kind).toBe(
      'not_found',
    );
    const own = await h.app.getHabit.execute({ actor: alice, habitId: shared.id });
    expect(own.ok && own.value.isArchived).toBe(true);
  });
});

describe('ListHabits', () => {
  it('lists your own habits newest first, and not other people', async () => {
    const h = buildHarness();
    const first = await h.createHabit(alice, { title: 'First' });
    h.clock.advanceMs(1_000);
    const second = await h.createHabit(alice, { title: 'Second' });
    await h.createHabit(bob, { title: 'Bobs' });

    const page = unwrap(
      await h.app.listHabits.execute({
        actor: alice,
        scope: 'mine',
        status: 'active',
        limit: 10,
      }),
    );
    expect(page.items.map((x) => x.id)).toEqual([second.id, first.id]);
  });

  it('separates active and archived', async () => {
    const h = buildHarness();
    const keep = await h.createHabit(alice, { title: 'Keep' });
    const drop = await h.createHabit(alice, { title: 'Drop' });
    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: drop.id }));

    const list = async (status: 'active' | 'archived') =>
      unwrap(await h.app.listHabits.execute({ actor: alice, scope: 'mine', status, limit: 10 }))
        .items;
    expect((await list('active')).map((x) => x.id)).toEqual([keep.id]);
    expect((await list('archived')).map((x) => x.id)).toEqual([drop.id]);
  });

  it('team scope shows what teammates shared, and nothing private or archived or foreign', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, {
      title: 'Shared',
      visibility: 'team',
      teamId: PLATFORM,
    });
    await h.createHabit(alice, { title: 'Private' });
    const gone = await h.createHabit(alice, {
      title: 'Gone',
      visibility: 'team',
      teamId: PLATFORM,
    });
    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: gone.id }));
    await h.createHabit(carol, { title: 'Other team', visibility: 'team', teamId: DATA });
    await h.createHabit(bob, { title: 'Mine', visibility: 'team', teamId: PLATFORM });

    const seen = unwrap(
      await h.app.listHabits.execute({ actor: bob, scope: 'team', status: 'active', limit: 10 }),
    ).items;
    // Only Alice's active, shared habit: not her private or archived ones, not Carol's team's, and
    // not Bob's own (those are under scope "mine").
    expect(seen.map((x) => x.id)).toEqual([shared.id]);
  });

  it('team scope for someone in no team, or filtered to a foreign team, is empty (not an error)', async () => {
    const h = buildHarness();
    await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });

    const loner = principal(uuid(0x1), { teams: [] });
    const none = unwrap(
      await h.app.listHabits.execute({ actor: loner, scope: 'team', status: 'active', limit: 10 }),
    );
    expect(none.items).toEqual([]);

    const foreignFilter = unwrap(
      await h.app.listHabits.execute({
        actor: carol,
        scope: 'team',
        status: 'active',
        teamId: PLATFORM,
        limit: 10,
      }),
    );
    expect(foreignFilter.items).toEqual([]);
  });

  it('filters by activity type', async () => {
    const h = buildHarness();
    await h.createHabit(alice, { title: 'Walk', activityType: 'walking' });
    const yoga = await h.createHabit(alice, { title: 'Yoga', activityType: 'yoga' });
    const page = unwrap(
      await h.app.listHabits.execute({
        actor: alice,
        scope: 'mine',
        status: 'active',
        activityType: 'yoga',
        limit: 10,
      }),
    );
    expect(page.items.map((x) => x.id)).toEqual([yoga.id]);
  });

  it('pages through everything exactly once, even when timestamps are equal', async () => {
    const h = buildHarness();
    const created: string[] = [];
    // All created at the same instant: only the id tie-breaker separates them.
    for (let i = 0; i < 7; i += 1)
      created.push((await h.createHabit(alice, { title: `H${i}` })).id);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = unwrap(
        await h.app.listHabits.execute({
          actor: alice,
          scope: 'mine',
          status: 'active',
          limit: 3,
          cursor,
        }),
      );
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it('rejects a malformed cursor', async () => {
    const h = buildHarness();
    const result = await h.app.listHabits.execute({
      actor: alice,
      scope: 'mine',
      status: 'active',
      limit: 10,
      cursor: 'garbage',
    });
    expect(errorOf(result)).toMatchObject({ kind: 'validation', code: 'cursor.invalid' });
  });
});

describe('UpdateHabit', () => {
  it('changes details without publishing anything other services could use', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    h.clearOutbox();

    const updated = unwrap(
      await h.app.updateHabit.execute({
        actor: alice,
        habitId: habit.id,
        title: 'Evening walk',
        description: 'after dinner',
      }),
    );
    expect(updated).toMatchObject({ title: 'Evening walk', description: 'after dinner' });
    expect(h.outbox()).toHaveLength(0);
  });

  it('publishes HabitUpdated when sharing, activity type or reminder change', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    h.clearOutbox();

    unwrap(
      await h.app.updateHabit.execute({
        actor: alice,
        habitId: habit.id,
        visibility: 'team',
        teamId: PLATFORM,
        reminder: REMINDER,
      }),
    );
    expect(h.outbox()).toHaveLength(1);
    const event = h.outbox()[0]!;
    expect(parseEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      eventType: 'HabitUpdated',
      payload: { habitId: habit.id, visibility: 'team', reminder: { remindAt: '07:30' } },
    });
  });

  it('clearing the reminder publishes an update without one, so the schedule is dropped', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, { reminder: REMINDER });
    h.clearOutbox();
    unwrap(await h.app.updateHabit.execute({ actor: alice, habitId: habit.id, reminder: null }));
    expect((h.outbox()[0] as { payload: object }).payload).not.toHaveProperty('reminder');
  });

  it('can make a shared habit private again', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const updated = unwrap(
      await h.app.updateHabit.execute({ actor: alice, habitId: habit.id, visibility: 'private' }),
    );
    expect(updated).toMatchObject({ visibility: 'private', teamId: null });
    expect(errorOf(await h.app.getHabit.execute({ actor: bob, habitId: habit.id }))?.kind).toBe(
      'not_found',
    );
  });

  it('a teammate who can see a shared habit still cannot change it (403, not 404)', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const result = await h.app.updateHabit.execute({
      actor: bob,
      habitId: habit.id,
      title: 'Mine now',
    });
    expect(errorOf(result)).toMatchObject({ kind: 'forbidden', code: 'habit.not_owner' });
    expect(h.uow.store.habits.get(habit.id)?.title).toBe('Morning walk');
  });

  it('a stranger gets the same 404 as for a missing habit, so a private habit is not revealed', async () => {
    const h = buildHarness();
    const priv = await h.createHabit(alice);
    const hidden = await h.app.updateHabit.execute({ actor: bob, habitId: priv.id, title: 'x' });
    const missing = await h.app.updateHabit.execute({
      actor: bob,
      habitId: uuid(0x999),
      title: 'x',
    });
    expect(errorOf(hidden)).toEqual(errorOf(missing));
    expect(errorOf(hidden)?.kind).toBe('not_found');
  });

  it('refuses to share with a team the owner is not in', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    const result = await h.app.updateHabit.execute({
      actor: alice,
      habitId: habit.id,
      visibility: 'team',
      teamId: DATA,
    });
    expect(errorOf(result)?.code).toBe('habit.team_not_member');
  });

  it('refuses a team without a visibility', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    const result = await h.app.updateHabit.execute({
      actor: alice,
      habitId: habit.id,
      teamId: PLATFORM,
    });
    expect(errorOf(result)?.code).toBe('habit.sharing_invalid');
  });

  it('an archived habit is read-only', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: habit.id }));
    const result = await h.app.updateHabit.execute({ actor: alice, habitId: habit.id, title: 'x' });
    expect(errorOf(result)).toMatchObject({ kind: 'conflict', code: 'habit.archived' });
  });

  it('rolls back everything when the update fails validation', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    h.clearOutbox();
    const result = await h.app.updateHabit.execute({
      actor: alice,
      habitId: habit.id,
      activityType: 'yoga',
      title: '   ',
    });
    expect(errorOf(result)?.code).toBe('habit.title_invalid');
    expect(h.uow.store.habits.get(habit.id)?.activityType).toBe('walking');
    expect(h.outbox()).toHaveLength(0);
  });
});

describe('ArchiveHabit', () => {
  it('archives and publishes HabitArchived once', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    h.clearOutbox();

    const archived = unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: habit.id }));
    expect(archived.isArchived).toBe(true);
    expect(h.outbox()).toHaveLength(1);
    expect(h.outbox()[0]).toMatchObject({
      eventType: 'HabitArchived',
      payload: { habitId: habit.id, ownerUserId: ALICE },
    });
  });

  it('is idempotent: archiving again succeeds and publishes nothing more', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice);
    const first = unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: habit.id }));
    h.clock.advanceMs(60_000);
    h.clearOutbox();
    const again = unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: habit.id }));
    expect(again.archivedAt).toEqual(first.archivedAt);
    expect(h.outbox()).toHaveLength(0);
  });

  it('only the owner can archive; others get 403 when they can see it and 404 when they cannot', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const priv = await h.createHabit(alice);
    expect(
      errorOf(await h.app.archiveHabit.execute({ actor: bob, habitId: shared.id }))?.kind,
    ).toBe('forbidden');
    expect(errorOf(await h.app.archiveHabit.execute({ actor: bob, habitId: priv.id }))?.kind).toBe(
      'not_found',
    );
    expect(h.uow.store.habits.get(shared.id)?.isArchived).toBe(false);
  });
});

describe('reacting to Identity events', () => {
  it('UserDeleted removes every habit of the user and nothing else', async () => {
    const h = buildHarness();
    await h.createHabit(alice, { title: 'A1' });
    await h.createHabit(alice, { title: 'A2', visibility: 'team', teamId: PLATFORM });
    const keep = await h.createHabit(bob, { title: 'B1' });

    const result = unwrap(await h.app.eraseUserHabits.execute({ userId: ALICE }));
    expect(result.removed).toBe(2);
    expect([...h.uow.store.habits.keys()]).toEqual([keep.id]);
  });

  it('erasure is idempotent', async () => {
    const h = buildHarness();
    await h.createHabit(alice);
    unwrap(await h.app.eraseUserHabits.execute({ userId: ALICE }));
    const again = unwrap(await h.app.eraseUserHabits.execute({ userId: ALICE }));
    expect(again.removed).toBe(0);
  });

  it('leaving a team makes that persons shared habits private and tells subscribers', async () => {
    const h = buildHarness();
    const shared = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    const other = await h.createHabit(principal(ALICE, { teams: [PLATFORM, DATA] }), {
      visibility: 'team',
      teamId: DATA,
    });
    h.clearOutbox();

    const result = unwrap(
      await h.app.withdrawHabitsFromTeam.execute({ userId: ALICE, teamId: PLATFORM }),
    );
    expect(result.withdrawn).toBe(1);
    expect(h.uow.store.habits.get(shared.id)).toMatchObject({ visibility: 'private' });
    expect(h.uow.store.habits.get(other.id)).toMatchObject({ visibility: 'team', teamId: DATA });

    // Bob is still in the team, and no longer sees the habit.
    expect(errorOf(await h.app.getHabit.execute({ actor: bob, habitId: shared.id }))?.kind).toBe(
      'not_found',
    );
    expect(h.outbox()).toHaveLength(1);
    expect(h.outbox()[0]).toMatchObject({
      eventType: 'HabitUpdated',
      payload: { habitId: shared.id, visibility: 'private' },
    });
  });

  it('does not announce archived habits that were withdrawn', async () => {
    const h = buildHarness();
    const habit = await h.createHabit(alice, { visibility: 'team', teamId: PLATFORM });
    unwrap(await h.app.archiveHabit.execute({ actor: alice, habitId: habit.id }));
    h.clearOutbox();
    const result = unwrap(
      await h.app.withdrawHabitsFromTeam.execute({ userId: ALICE, teamId: PLATFORM }),
    );
    expect(result.withdrawn).toBe(1);
    expect(h.outbox()).toHaveLength(0);
  });

  it('is idempotent and ignores other peoples habits', async () => {
    const h = buildHarness();
    const bobs = await h.createHabit(bob, { visibility: 'team', teamId: PLATFORM });
    unwrap(await h.app.withdrawHabitsFromTeam.execute({ userId: ALICE, teamId: PLATFORM }));
    unwrap(await h.app.withdrawHabitsFromTeam.execute({ userId: ALICE, teamId: PLATFORM }));
    expect(h.uow.store.habits.get(bobs.id)?.visibility).toBe('team');
  });
});
