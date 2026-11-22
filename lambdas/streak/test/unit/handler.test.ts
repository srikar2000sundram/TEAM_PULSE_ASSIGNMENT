import { createEvent } from '@teampulse/contracts';
import { createLogger, getCorrelationId } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import { createHandler } from '../../src/handler.js';
import { USER, activity, id, setup } from '../support/fakes.js';

function build() {
  const ctx = setup();
  const logs: string[] = [];
  const handler = createHandler({
    updateStreak: ctx.update,
    logger: createLogger({ service: 'handler-test', level: 'debug', write: (l) => logs.push(l) }),
  });
  return { ...ctx, handler, handlerLogs: logs };
}

/** What EventBridge hands a Lambda target. */
const envelope = (detail: unknown) => ({
  version: '0',
  'detail-type': 'ActivityCompleted',
  source: 'teampulse.event-tracking',
  detail,
});

describe('streak Lambda handler', () => {
  it('processes an EventBridge delivery of ActivityCompleted', async () => {
    const { handler, state, publisher } = build();
    await handler(envelope(activity('2026-11-20')));
    expect(state()).toMatchObject({ currentStreak: 1 });
    expect(publisher.published).toHaveLength(1);
  });

  it('runs the work inside the event correlation id', async () => {
    const ctx = build();
    const source = activity('2026-11-20');
    let seen: string | undefined;
    const handler = createHandler({
      logger: createLogger({ service: 't', level: 'silent', write: () => undefined }),
      updateStreak: {
        execute: () => {
          seen = getCorrelationId();
          return Promise.resolve();
        },
      } as never,
    });
    await handler(envelope(source));
    expect(seen).toBe(source.correlationId);
    void ctx;
  });

  it.each([
    ['no detail', { version: '0' }],
    ['a string', 'ActivityCompleted'],
    ['null', null],
    ['an invalid detail', envelope({ eventType: 'ActivityCompleted', payload: {} })],
  ])('throws for %s, so Lambda retries and then dead-letters', async (_name, input) => {
    const { handler, state } = build();
    await expect(handler(input)).rejects.toThrow(/invalid event/);
    expect(state()).toBeUndefined();
  });

  it('does not log the content of an invalid event', async () => {
    const { handler, handlerLogs } = build();
    const secret = 'ada.lovelace@example.com';
    await expect(
      handler(envelope({ eventType: 'ActivityCompleted', payload: { email: secret } })),
    ).rejects.toThrow();
    expect(handlerLogs.join('\n')).toContain('streak.invalid_event');
    expect(handlerLogs.join('\n')).not.toContain(secret);
  });

  it('rejects a valid event of another type instead of ignoring it silently', async () => {
    const { handler } = build();
    const other = createEvent('UserDeleted', {
      eventId: id(1),
      occurredAt: new Date('2026-11-20T08:00:00Z'),
      correlationId: id(2),
      payload: { userId: USER },
    });
    await expect(handler(envelope(other))).rejects.toThrow(/unexpected event type UserDeleted/);
  });
});
