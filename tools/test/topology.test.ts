import { describe, expect, it } from 'vitest';
import { eventSchemas } from '@teampulse/contracts';
import { buildChallengeEventHandlers } from '../../services/challenge/src/adapters/events/handlers.js';
import { buildEventTrackingEventHandlers } from '../../services/event-tracking/src/adapters/events/handlers.js';
import { buildHabitEventHandlers } from '../../services/habit/src/adapters/events/handlers.js';
import { buildInsightEventHandlers } from '../../services/insight/src/adapters/events/handlers.js';
import { buildNotificationEventHandlers } from '../../services/notification/src/adapters/events/handlers.js';
import { LAMBDA_QUEUES, SERVICE_QUEUES, allQueues, patternFor } from '../local/topology.mjs';

/** The handlers a service registers, without needing its use cases (they are only closed over). */
const registered = (build: (useCases: never) => object) => Object.keys(build({} as never)).sort();

describe('event routing (tools/local/topology.mjs)', () => {
  it('routes to each service exactly the events its handlers accept, so nothing is dropped or ignored', () => {
    expect([...SERVICE_QUEUES.habit].sort()).toEqual(registered(buildHabitEventHandlers));
    expect([...SERVICE_QUEUES['event-tracking']].sort()).toEqual(
      registered(buildEventTrackingEventHandlers),
    );
    expect([...SERVICE_QUEUES.notification].sort()).toEqual(
      registered(buildNotificationEventHandlers),
    );
    expect([...SERVICE_QUEUES.challenge].sort()).toEqual(registered(buildChallengeEventHandlers));
    expect([...SERVICE_QUEUES.insight].sort()).toEqual(registered(buildInsightEventHandlers));
  });

  it('only routes event types that exist in the contracts', () => {
    const known = new Set(Object.keys(eventSchemas));
    for (const { name, events } of allQueues()) {
      for (const type of events) expect(known.has(type), `${name}: ${type}`).toBe(true);
    }
  });

  it('gives every event that someone produces at least one consumer, except the ones nobody uses yet', () => {
    const routed = new Set(allQueues().flatMap((queue) => queue.events));
    const unused = Object.keys(eventSchemas).filter((type) => !routed.has(type));
    // Known and documented: no service consumes these yet.
    expect(unused.sort()).toEqual(['ChallengeProgressUpdated', 'UserRegistered']);
  });

  it('feeds the Lambdas the events they handle', () => {
    expect(LAMBDA_QUEUES['streak'].events).toEqual(['ActivityCompleted']);
    expect(LAMBDA_QUEUES['badge-streak'].events).toEqual(['StreakUpdated']);
    expect(LAMBDA_QUEUES['badge-totals'].events).toEqual(['ActivityCompleted']);
  });

  it('has unique queue names and valid rule patterns', () => {
    const names = allQueues().map((queue) => queue.name);
    expect(new Set(names).size).toBe(names.length);
    expect(JSON.parse(patternFor(['A', 'B']))).toEqual({ 'detail-type': ['A', 'B'] });
  });
});
