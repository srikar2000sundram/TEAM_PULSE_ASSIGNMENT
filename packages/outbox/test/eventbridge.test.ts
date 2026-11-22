import { createEvent, type TeamPulseEvent } from '@teampulse/contracts';
import { describe, expect, it } from 'vitest';
import {
  EventBridgePublisher,
  type EventBridgeClientPort,
  type PutEventsEntry,
  type PutEventsResult,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const event = (n: number): TeamPulseEvent =>
  createEvent('UserDeleted', {
    eventId: id(n),
    occurredAt: new Date('2026-11-20T08:00:00Z'),
    correlationId: id(900),
    payload: { userId: id(1) },
  });

function fakeClient(respond: (entries: readonly PutEventsEntry[]) => PutEventsResult) {
  const calls: (readonly PutEventsEntry[])[] = [];
  const client: EventBridgeClientPort = {
    putEvents: (entries) => {
      calls.push(entries);
      return Promise.resolve(respond(entries));
    },
  };
  return { client, calls };
}

const allOk = (entries: readonly PutEventsEntry[]): PutEventsResult => ({
  FailedEntryCount: 0,
  Entries: entries.map((_, i) => ({ EventId: `aws-${i}` })),
});

describe('EventBridgePublisher', () => {
  it('maps an event to Source, DetailType and the full envelope as Detail', async () => {
    const { client, calls } = fakeClient(allOk);
    const outcomes = await new EventBridgePublisher(client, 'teampulse-bus').publish([event(1)]);

    expect(outcomes).toEqual([{ eventId: id(1) }]);
    expect(calls[0]?.[0]).toMatchObject({
      Source: 'teampulse.identity',
      DetailType: 'UserDeleted',
      EventBusName: 'teampulse-bus',
    });
    expect(JSON.parse(calls[0]![0]!.Detail)).toMatchObject({
      eventId: id(1),
      eventType: 'UserDeleted',
      payload: { userId: id(1) },
    });
  });

  it('splits more than 10 events into several calls of at most 10', async () => {
    const { client, calls } = fakeClient(allOk);
    const events = Array.from({ length: 23 }, (_, i) => event(i + 1));
    const outcomes = await new EventBridgePublisher(client, 'bus').publish(events);
    expect(calls.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(outcomes.every((o) => o.error === undefined)).toBe(true);
    expect(outcomes.map((o) => o.eventId)).toEqual(events.map((e) => e.eventId));
  });

  it('reports a failure only for the entries EventBridge rejected', async () => {
    const { client } = fakeClient((entries) => ({
      FailedEntryCount: 1,
      Entries: entries.map((_, i) =>
        i === 1
          ? { ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }
          : { EventId: 'ok' },
      ),
    }));
    const outcomes = await new EventBridgePublisher(client, 'bus').publish([
      event(1),
      event(2),
      event(3),
    ]);
    expect(outcomes.map((o) => o.error)).toEqual([undefined, 'ThrottlingException', undefined]);
  });

  it('treats a missing result entry as a failure rather than assuming success', async () => {
    const { client } = fakeClient(() => ({ FailedEntryCount: 0, Entries: [] }));
    const [outcome] = await new EventBridgePublisher(client, 'bus').publish([event(1)]);
    expect(outcome?.error).toBeDefined();
  });

  it('fails every event of a call that throws, and still sends the other calls', async () => {
    let call = 0;
    const client: EventBridgeClientPort = {
      putEvents: (entries) => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('network down'))
          : Promise.resolve(allOk(entries));
      },
    };
    const events = Array.from({ length: 12 }, (_, i) => event(i + 1));
    const outcomes = await new EventBridgePublisher(client, 'bus').publish(events);
    expect(outcomes.slice(0, 10).every((o) => o.error === 'network down')).toBe(true);
    expect(outcomes.slice(10).every((o) => o.error === undefined)).toBe(true);
  });
});
