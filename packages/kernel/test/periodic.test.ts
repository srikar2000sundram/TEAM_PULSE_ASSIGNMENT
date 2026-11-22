import { describe, expect, it } from 'vitest';
import { startPeriodicTask } from '../src/periodic.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `condition` holds, for at most two seconds. */
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(2);
  }
}

describe('startPeriodicTask', () => {
  it('runs at once and then again and again', async () => {
    let runs = 0;
    const task = startPeriodicTask({
      intervalMs: 5,
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
      onError: () => undefined,
    });
    await until(() => runs >= 3);
    await task.stop();
    expect(runs).toBeGreaterThanOrEqual(3);
  });

  it('reports a failing run and carries on with the next', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const task = startPeriodicTask({
      intervalMs: 5,
      run: () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    await until(() => runs >= 3);
    await task.stop();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('also survives a run that throws synchronously', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const task = startPeriodicTask({
      intervalMs: 5,
      run: () => {
        runs += 1;
        throw new Error('sync boom');
      },
      onError: (error) => errors.push(error),
    });
    await until(() => runs >= 2);
    await task.stop();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('never overlaps two runs, however slow one is', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    const task = startPeriodicTask({
      intervalMs: 1,
      run: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(15);
        inFlight -= 1;
        runs += 1;
      },
      onError: () => undefined,
    });
    await until(() => runs >= 3);
    await task.stop();
    expect(maxInFlight).toBe(1);
  });

  it('stop wakes a long pause at once and waits for a run in progress', async () => {
    let finished = false;
    let started = false;
    const slow = startPeriodicTask({
      intervalMs: 60_000,
      run: async () => {
        started = true;
        await sleep(30);
        finished = true;
      },
      onError: () => undefined,
    });
    await until(() => started);
    await slow.stop();
    expect(finished).toBe(true);

    const idle = startPeriodicTask({
      intervalMs: 60_000,
      run: () => Promise.resolve(),
      onError: () => undefined,
    });
    await sleep(10);
    const before = Date.now();
    await idle.stop(); // would take a minute if the pause were not interrupted
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('calls onStart once and onStop when stopped, and runs nothing after stop', async () => {
    const calls: string[] = [];
    let runs = 0;
    const task = startPeriodicTask({
      intervalMs: 5,
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
      onError: () => undefined,
      onStart: () => calls.push('start'),
      onStop: () => calls.push('stop'),
    });
    await until(() => runs >= 2);
    await task.stop();
    const after = runs;
    await sleep(30);
    expect(runs).toBe(after);
    expect(calls).toEqual(['start', 'stop']);
  });
});
