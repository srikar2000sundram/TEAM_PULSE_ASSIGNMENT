/** A loop running in the background that can be stopped during graceful shutdown. */
export interface PeriodicTask {
  /** Ends the loop, without waiting out the pause, and waits for a run in progress to finish. */
  stop(): Promise<void>;
}

export interface PeriodicTaskOptions {
  /** Pause between the end of one run and the start of the next. */
  readonly intervalMs: number;
  /** One round of work. */
  readonly run: () => Promise<void>;
  /** A failed run is reported here and the loop carries on: the next run is a retry. */
  readonly onError: (error: unknown) => void;
  readonly onStart?: () => void;
  readonly onStop?: () => void;
}

/**
 * Runs `run` again and again with a pause in between, starting immediately.
 *
 * - Runs never overlap: the pause starts when a run ends, so a slow run delays the next one instead
 *   of stacking up behind it.
 * - A run that throws (or rejects) is handed to `onError`, never stops the loop.
 * - `stop()` wakes the pause at once, so shutdown is not held up by a long interval.
 */
export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTask {
  const controller = new AbortController();

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      // `stop()` may have been called while a run was in progress: an abort that already happened
      // fires no event, so check for it, or the pause would last the whole interval.
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      }
      controller.signal.addEventListener('abort', done, { once: true });
    });

  const loop = async () => {
    options.onStart?.();
    while (!controller.signal.aborted) {
      try {
        await options.run();
      } catch (error) {
        options.onError(error);
      }
      await pause(options.intervalMs);
    }
    options.onStop?.();
  };

  const running = loop();
  return {
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}
