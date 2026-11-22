import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { getCorrelationId, createLogger } from '@teampulse/observability';
import { describe, expect, it } from 'vitest';
import {
  EventConsumer,
  InvalidDeliveryError,
  decodeLambdaEvent,
  type EventHandlers,
  type Message,
  type MessageSource,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const userDeleted = (n: number, correlation = id(900)): TeamPulseEvent<'UserDeleted'> =>
  createEvent('UserDeleted', {
    eventId: id(n),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: correlation,
    payload: { userId: id(1) },
  });

class FakeSource implements MessageSource {
  removed: string[] = [];
  removeError: Error | undefined;
  constructor(private queue: Message[]) {}
  receive(max: number) {
    const batch = this.queue.splice(0, max);
    return Promise.resolve(batch);
  }
  remove(message: Message) {
    if (this.removeError !== undefined) return Promise.reject(this.removeError);
    this.removed.push(message.id);
    return Promise.resolve();
  }
}

const message = (idValue: string, body: unknown): Message => ({
  id: idValue,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function setup(messages: Message[], handlers: EventHandlers) {
  const source = new FakeSource(messages);
  const logs: string[] = [];
  const consumer = new EventConsumer({
    source,
    handlers,
    logger: createLogger({ service: 'consumer-test', level: 'debug', write: (l) => logs.push(l) }),
    waitSeconds: 0,
  });
  return { source, consumer, logs };
}

describe('EventConsumer', () => {
  it('runs the handler for a bare event and removes the message', async () => {
    const seen: string[] = [];
    const { consumer, source } = setup([message('m1', userDeleted(1))], {
      UserDeleted: (event) => {
        seen.push(event.payload.userId);
        return Promise.resolve();
      },
    });

    expect(await consumer.runOnce()).toEqual({ handled: 1, ignored: 0, failed: 0, rejected: 0 });
    expect(seen).toEqual([id(1)]);
    expect(source.removed).toEqual(['m1']);
  });

  it('unwraps an EventBridge delivery, whose detail holds the event', async () => {
    const seen: string[] = [];
    const wrapped = {
      version: '0',
      'detail-type': 'UserDeleted',
      source: 'teampulse.identity',
      detail: userDeleted(2),
    };
    const { consumer } = setup([message('m1', wrapped)], {
      UserDeleted: (event) => {
        seen.push(event.eventId);
        return Promise.resolve();
      },
    });
    expect((await consumer.runOnce()).handled).toBe(1);
    expect(seen).toEqual([id(2)]);
  });

  it('runs the handler inside the event correlation id, so logs link back to the request', async () => {
    const correlation = id(777);
    let seen: string | undefined;
    const { consumer } = setup([message('m1', userDeleted(1, correlation))], {
      UserDeleted: () => {
        seen = getCorrelationId();
        return Promise.resolve();
      },
    });
    await consumer.runOnce();
    expect(seen).toBe(correlation);
  });

  it('leaves a message for retry when its handler fails', async () => {
    const { consumer, source, logs } = setup([message('m1', userDeleted(1))], {
      UserDeleted: () => Promise.reject(new Error('database down')),
    });
    expect(await consumer.runOnce()).toEqual({ handled: 0, ignored: 0, failed: 1, rejected: 0 });
    expect(source.removed).toEqual([]);
    expect(logs.join('\n')).toContain('consumer.handler_failed');
  });

  it('leaves invalid messages alone so the queue can dead-letter them, without logging their content', async () => {
    const secret = 'ada.lovelace@example.com';
    const { consumer, source, logs } = setup(
      [
        message('bad-json', 'not json at all'),
        message('bad-shape', { eventType: 'UserDeleted', payload: { email: secret } }),
        message('unknown', { eventType: 'NoSuchEvent' }),
      ],
      { UserDeleted: () => Promise.resolve() },
    );
    expect(await consumer.runOnce()).toEqual({ handled: 0, ignored: 0, failed: 0, rejected: 3 });
    expect(source.removed).toEqual([]);
    expect(logs.join('\n')).toContain('consumer.invalid_message');
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('drops valid events that nobody here handles, with a warning', async () => {
    const { consumer, source, logs } = setup([message('m1', userDeleted(1))], {});
    expect(await consumer.runOnce()).toEqual({ handled: 0, ignored: 1, failed: 0, rejected: 0 });
    expect(source.removed).toEqual(['m1']);
    expect(logs.join('\n')).toContain('consumer.unhandled');
  });

  it('one failing message does not stop the rest of the batch', async () => {
    const { consumer, source } = setup(
      [message('m1', userDeleted(1)), message('m2', userDeleted(2)), message('m3', userDeleted(3))],
      {
        UserDeleted: (event) =>
          event.eventId === id(2) ? Promise.reject(new Error('boom')) : Promise.resolve(),
      },
    );
    expect(await consumer.runOnce()).toEqual({ handled: 2, ignored: 0, failed: 1, rejected: 0 });
    expect(source.removed).toEqual(['m1', 'm3']);
  });

  it('survives a failed delete: the event will simply be delivered again', async () => {
    const { consumer, source, logs } = setup([message('m1', userDeleted(1))], {
      UserDeleted: () => Promise.resolve(),
    });
    source.removeError = new Error('throttled');
    expect(await consumer.runOnce()).toEqual({ handled: 1, ignored: 0, failed: 0, rejected: 0 });
    expect(logs.join('\n')).toContain('consumer.remove_failed');
  });

  it('run() keeps polling after a source error and stops when aborted', async () => {
    let calls = 0;
    const seen: string[] = [];
    const source: MessageSource = {
      receive: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('queue unreachable'));
        return Promise.resolve(calls === 2 ? [message('m1', userDeleted(1))] : []);
      },
      remove: () => Promise.resolve(),
    };
    const controller = new AbortController();
    const consumer = new EventConsumer({
      source,
      handlers: {
        UserDeleted: () => {
          seen.push('done');
          controller.abort();
          return Promise.resolve();
        },
      },
      logger: createLogger({ service: 'consumer-test', level: 'silent', write: () => undefined }),
      waitSeconds: 0,
    });
    await consumer.run({ signal: controller.signal, errorBackoffMs: 5 });
    expect(seen).toEqual(['done']);
    expect(calls).toBe(2);
  });
});

describe('decodeLambdaEvent', () => {
  const envelope = (detail: unknown) => ({ version: '0', 'detail-type': 'UserDeleted', detail });

  it('returns the typed event from an EventBridge delivery', () => {
    const event = decodeLambdaEvent(envelope(userDeleted(1)), 'UserDeleted');
    expect(event.payload.userId).toBe(id(1));
  });

  it.each([
    ['no detail', { version: '0' }],
    ['a string', 'UserDeleted'],
    ['null', null],
    ['an invalid detail', envelope({ eventType: 'UserDeleted', payload: {} })],
  ])('throws for %s', (_name, input) => {
    expect(() => decodeLambdaEvent(input, 'UserDeleted')).toThrow(InvalidDeliveryError);
  });

  it('throws for a valid event of another type', () => {
    expect(() => decodeLambdaEvent(envelope(userDeleted(1)), 'HabitCreated')).toThrow(
      /unexpected event type UserDeleted/,
    );
  });

  it('names fields but never leaks content', () => {
    const secret = 'ada.lovelace@example.com';
    try {
      decodeLambdaEvent(
        envelope({ eventType: 'UserDeleted', payload: { email: secret } }),
        'UserDeleted',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
