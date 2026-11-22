import type { ActivityType, HabitResponse } from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { ActivityApi, HabitApi } from '../api/index.js';
import { localDate, messageOf } from '../format.js';

/** Your habits: list, create, archive, and mark done for today. */
export class HabitsState {
  readonly habits = new AsyncValue<HabitResponse[]>();
  /** Habits marked done during this visit (the server is the record; this is feedback). */
  done = $state<ReadonlySet<string>>(new Set());
  /** A message for the last action: success or a friendly error. */
  notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  busy = $state(false);

  constructor(
    private readonly habitApi: HabitApi,
    private readonly activityApi: ActivityApi,
    private readonly today: () => string = localDate,
  ) {}

  async load(): Promise<void> {
    await this.habits.load(async () => (await this.habitApi.list({ status: 'active' })).items);
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

  /** Recording twice is harmless: the server says `alreadyRecorded`, and we say so. */
  markDone(habit: HabitResponse): Promise<void> {
    return this.act(async () => {
      const result = await this.activityApi.record(habit.id, this.today());
      this.done = new Set([...this.done, habit.id]);
      return result.alreadyRecorded
        ? 'Already recorded for today.'
        : 'Nice work! Recorded for today.';
    });
  }

  create(input: { title: string; activityType: ActivityType }): Promise<void> {
    return this.act(async () => {
      await this.habitApi.create({
        title: input.title,
        activityType: input.activityType,
        visibility: 'private',
      });
      await this.load();
      return 'Habit created.';
    });
  }

  archive(habit: HabitResponse): Promise<void> {
    return this.act(async () => {
      await this.habitApi.archive(habit.id);
      await this.load();
      return 'Habit archived.';
    });
  }
}
