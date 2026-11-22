import { describe, expect, it } from 'vitest';
import {
  createHabitRequestSchema,
  habitReminderSchema,
  listHabitsQuerySchema,
  updateHabitRequestSchema,
} from '../src/index.js';

const TEAM = '00000000-0000-4000-8000-0000000000a1';
const reminder = { daysOfWeek: ['mon', 'fri'], remindAt: '07:30', timeZone: 'Europe/Berlin' };

describe('habitReminderSchema', () => {
  it('accepts a valid reminder', () => {
    expect(habitReminderSchema.safeParse(reminder).success).toBe(true);
  });

  it.each([
    ['an unknown time zone', { ...reminder, timeZone: 'Mars/Olympus' }],
    ['a missing time zone', { daysOfWeek: ['mon'], remindAt: '07:30' }],
    ['repeated days', { ...reminder, daysOfWeek: ['mon', 'mon'] }],
    ['no days', { ...reminder, daysOfWeek: [] }],
    ['an impossible time', { ...reminder, remindAt: '25:00' }],
    ['an undeclared field', { ...reminder, message: 'Drink water!' }],
  ])('rejects %s', (_name, input) => {
    expect(habitReminderSchema.safeParse(input).success).toBe(false);
  });
});

describe('createHabitRequestSchema', () => {
  const base = { title: '  Morning walk  ', activityType: 'walking' };

  it('defaults to private and trims the title', () => {
    const parsed = createHabitRequestSchema.parse(base);
    expect(parsed).toMatchObject({ title: 'Morning walk', visibility: 'private' });
  });

  it('requires a team for team visibility, and forbids one for private habits', () => {
    expect(createHabitRequestSchema.safeParse({ ...base, visibility: 'team' }).success).toBe(false);
    expect(
      createHabitRequestSchema.safeParse({ ...base, visibility: 'team', teamId: TEAM }).success,
    ).toBe(true);
    expect(createHabitRequestSchema.safeParse({ ...base, teamId: TEAM }).success).toBe(false);
  });

  it.each([
    ['an empty title', { ...base, title: '   ' }],
    ['a title over 80 characters', { ...base, title: 'x'.repeat(81) }],
    ['a description over 500 characters', { ...base, description: 'x'.repeat(501) }],
    ['an unknown activity type', { ...base, activityType: 'skydiving' }],
    ['an undeclared field such as the owner', { ...base, ownerUserId: TEAM }],
  ])('rejects %s', (_name, input) => {
    expect(createHabitRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('updateHabitRequestSchema', () => {
  it('rejects an empty update', () => {
    expect(updateHabitRequestSchema.safeParse({}).success).toBe(false);
  });

  it('allows null to clear the description and the reminder', () => {
    const parsed = updateHabitRequestSchema.parse({ description: null, reminder: null });
    expect(parsed).toEqual({ description: null, reminder: null });
  });

  it('states sharing changes unambiguously', () => {
    expect(updateHabitRequestSchema.safeParse({ visibility: 'team' }).success).toBe(false);
    expect(updateHabitRequestSchema.safeParse({ teamId: TEAM }).success).toBe(false);
    expect(
      updateHabitRequestSchema.safeParse({ visibility: 'private', teamId: TEAM }).success,
    ).toBe(false);
    expect(updateHabitRequestSchema.safeParse({ visibility: 'team', teamId: TEAM }).success).toBe(
      true,
    );
    expect(updateHabitRequestSchema.safeParse({ visibility: 'private' }).success).toBe(true);
  });
});

describe('listHabitsQuerySchema', () => {
  it('has sensible defaults', () => {
    expect(listHabitsQuerySchema.parse({})).toEqual({
      scope: 'mine',
      status: 'active',
      limit: 50,
    });
  });

  it('never lists other people archived habits, and scopes the team filter', () => {
    expect(listHabitsQuerySchema.safeParse({ scope: 'team', status: 'archived' }).success).toBe(
      false,
    );
    expect(listHabitsQuerySchema.safeParse({ scope: 'mine', teamId: TEAM }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ scope: 'team', teamId: TEAM }).success).toBe(true);
  });

  it('bounds the page size', () => {
    expect(listHabitsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listHabitsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listHabitsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });
});
