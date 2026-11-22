import { FixedClock, SequentialIdGenerator } from '@teampulse/kernel';
import { runWithCorrelationId } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import { EventFactory } from '../src/index.js';

const USER = '00000000-0000-4000-8000-0000000000a1';

describe('EventFactory', () => {
  const build = () =>
    new EventFactory(new FixedClock('2026-11-20T08:00:00Z'), new SequentialIdGenerator());

  it('creates a validated event with id, time and producer', () => {
    const event = build().create('UserDeleted', { userId: USER });
    expect(event).toMatchObject({
      eventType: 'UserDeleted',
      producer: 'identity',
      occurredAt: '2026-11-20T08:00:00.000Z',
      payload: { userId: USER },
    });
  });

  it('uses the current request correlation id when there is one', () => {
    const correlationId = '00000000-0000-4000-8000-0000000000c1';
    const event = runWithCorrelationId(correlationId, () =>
      build().create('UserDeleted', { userId: USER }),
    );
    expect(event.correlationId).toBe(correlationId);
  });

  it('rejects a payload with an undeclared field, so free text cannot reach the bus', () => {
    expect(() =>
      build().create('UserDeleted', { userId: USER, email: 'a@example.com' } as never),
    ).toThrow();
  });
});
