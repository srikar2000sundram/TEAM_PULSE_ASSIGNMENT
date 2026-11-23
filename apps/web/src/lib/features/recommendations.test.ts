import type {
  HabitResponse,
  RecommendationResponse,
  UpdateHabitRequest,
} from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http.js';
import type { HabitApi, RecommendationApi } from '../api/index.js';
import { RecommendationsState } from './recommendations.svelte.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-11-20T08:00:00.000Z';
const ZONE = 'Europe/Berlin';

const habit = (n: number, title: string): HabitResponse => ({
  id: id(n),
  ownerUserId: id(0xa1),
  isOwner: true,
  title,
  activityType: 'walking',
  visibility: 'private',
  createdAt: NOW,
  updatedAt: NOW,
});

const recommendation = (n: number): RecommendationResponse => ({
  habitId: id(n),
  suggestedTime: '07:00',
  timeZone: ZONE,
  sampleSize: 6,
  matching: 5,
  confidence: 'high',
  status: 'pending',
});

function setup(options: { recommendations?: RecommendationResponse[]; failUpdate?: boolean } = {}) {
  const calls: string[] = [];
  const updates: Array<{ habitId: string; request: UpdateHabitRequest }> = [];
  const recommendations: RecommendationApi = {
    list: (timeZone) => {
      calls.push(`list ${timeZone}`);
      return Promise.resolve({ items: options.recommendations ?? [recommendation(1)] });
    },
    accept: (habitId, request) => {
      calls.push(`accept ${habitId}`);
      return Promise.resolve({ habitId, ...request, status: 'accepted' });
    },
    dismiss: (habitId, request) => {
      calls.push(`dismiss ${habitId}`);
      return Promise.resolve({ habitId, ...request, status: 'dismissed' });
    },
  };
  const habits = {
    list: () => Promise.resolve({ items: [habit(1, 'Morning walk')] }),
    update: (habitId: string, request: UpdateHabitRequest) => {
      calls.push(`update ${habitId}`);
      if (options.failUpdate === true) {
        return Promise.reject(new ApiError(503, 'service.unavailable', 'Try again shortly'));
      }
      updates.push({ habitId, request });
      return Promise.resolve(habit(1, 'Morning walk'));
    },
  } as unknown as HabitApi;
  const state = new RecommendationsState(recommendations, habits, () => ZONE);
  return { state, calls, updates };
}

describe('RecommendationsState', () => {
  it('loads recommendations for the browser zone and shows the habit title', async () => {
    const { state, calls } = setup();
    await state.load();
    expect(calls).toEqual([`list ${ZONE}`]);
    expect(state.items.value).toEqual([{ ...recommendation(1), habitTitle: 'Morning walk' }]);
  });

  it('hides a recommendation whose habit is not in the active list', async () => {
    const { state } = setup({ recommendations: [recommendation(1), recommendation(2)] });
    await state.load();
    expect(state.items.value?.map((item) => item.habitId)).toEqual([id(1)]);
  });

  it('accepting records the decision, then sets a daily reminder at the suggested time', async () => {
    const { state, calls, updates } = setup();
    await state.load();
    await state.accept(state.items.value![0]!);

    expect(calls).toEqual([`list ${ZONE}`, `accept ${id(1)}`, `update ${id(1)}`]);
    expect(updates[0]?.request.reminder).toEqual({
      daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      remindAt: '07:00',
      timeZone: ZONE,
    });
    expect(state.items.value?.[0]?.status).toBe('accepted');
    expect(state.notice).toEqual({ kind: 'ok', text: 'Reminder set for 07:00 every day.' });
  });

  it('keeps the acceptance and says so when the reminder could not be set', async () => {
    const { state } = setup({ failUpdate: true });
    await state.load();
    await state.accept(state.items.value![0]!);
    expect(state.items.value?.[0]?.status).toBe('accepted');
    expect(state.notice?.kind).toBe('error');
    expect(state.busy).toBe(false);
  });

  it('dismissing records the decision and leaves the habit alone', async () => {
    const { state, calls, updates } = setup();
    await state.load();
    await state.dismiss(state.items.value![0]!);
    expect(calls).toEqual([`list ${ZONE}`, `dismiss ${id(1)}`]);
    expect(updates).toEqual([]);
    expect(state.items.value?.[0]?.status).toBe('dismissed');
  });
});
