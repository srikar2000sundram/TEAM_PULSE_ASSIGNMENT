import { daysOfWeek, type HabitResponse, type RecommendationResponse } from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { HabitApi, RecommendationApi } from '../api/index.js';
import { messageOf } from '../format.js';

/** A recommendation joined with the habit it is about, so the page can show the habit's title. */
export interface RecommendationView extends RecommendationResponse {
  readonly habitTitle: string;
}

/** The browser's own time zone, so "07:00" means 07:00 where the person actually is. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Your personalised timing recommendations. Accepting one records the decision and then sets the
 * habit's reminder to the suggested time, every day, so the suggestion has an effect (ADR-0023).
 */
export class RecommendationsState {
  readonly items = new AsyncValue<RecommendationView[]>();
  notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  busy = $state(false);

  constructor(
    private readonly api: RecommendationApi,
    private readonly habits: HabitApi,
    private readonly timeZone: () => string = browserTimeZone,
  ) {}

  async load(): Promise<void> {
    await this.items.load(async () => {
      const [recommendations, habits] = await Promise.all([
        this.api.list(this.timeZone()),
        this.habits.list({ status: 'active' }),
      ]);
      const titles = new Map(habits.items.map((habit: HabitResponse) => [habit.id, habit.title]));
      // A recommendation for a habit that is archived (or not yours to see) is simply not shown.
      return recommendations.items.flatMap((item) => {
        const habitTitle = titles.get(item.habitId);
        return habitTitle === undefined ? [] : [{ ...item, habitTitle }];
      });
    });
  }

  private async act(work: () => Promise<string>): Promise<void> {
    this.busy = true;
    this.notice = null;
    try {
      this.notice = { kind: 'ok', text: await work() };
    } catch (error) {
      this.notice = { kind: 'error', text: messageOf(error) };
    } finally {
      this.busy = false;
    }
  }

  private setStatus(habitId: string, status: 'accepted' | 'dismissed'): void {
    this.items.value = (this.items.value ?? []).map((item) =>
      item.habitId === habitId ? { ...item, status } : item,
    );
  }

  accept(item: RecommendationView): Promise<void> {
    const decision = { suggestedTime: item.suggestedTime, timeZone: item.timeZone };
    return this.act(async () => {
      await this.api.accept(item.habitId, decision);
      this.setStatus(item.habitId, 'accepted');
      // The decision is saved first. If setting the reminder then fails, the person is told and
      // can set it by hand; the suggestion is not lost.
      await this.habits.update(item.habitId, {
        reminder: {
          daysOfWeek: [...daysOfWeek],
          remindAt: item.suggestedTime,
          timeZone: item.timeZone,
        },
      });
      return `Reminder set for ${item.suggestedTime} every day.`;
    });
  }

  dismiss(item: RecommendationView): Promise<void> {
    return this.act(async () => {
      await this.api.dismiss(item.habitId, {
        suggestedTime: item.suggestedTime,
        timeZone: item.timeZone,
      });
      this.setStatus(item.habitId, 'dismissed');
      return 'Dismissed. We will not suggest this time again.';
    });
  }
}
