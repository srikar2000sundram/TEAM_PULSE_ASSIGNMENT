import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoDbStreakStore,
  type DocumentClientPort,
} from '../../src/adapters/dynamodb-streak-store.js';
import type { StreakState } from '../../src/domain/streak.js';

const state: StreakState = {
  userId: 'u1',
  habitId: 'h1',
  currentStreak: 4,
  longestStreak: 9,
  lastActivityDate: '2026-11-20',
  version: 2,
};

function fakeClient(respond: (command: GetCommand | PutCommand) => unknown = () => ({})) {
  const sent: (GetCommand | PutCommand)[] = [];
  const client: DocumentClientPort = {
    send: (command) => {
      sent.push(command);
      return Promise.resolve(respond(command) as { Item?: Record<string, unknown> });
    },
  };
  return { client, sent };
}

describe('DynamoDbStreakStore', () => {
  it('reads one item by partition and sort key, with a consistent read', async () => {
    const { client, sent } = fakeClient(() => ({
      Item: { currentStreak: 4, longestStreak: 9, lastActivityDate: '2026-11-20', version: 2 },
    }));
    const found = await new DynamoDbStreakStore(client, 'streaks').get('u1', 'h1');

    expect(found).toEqual(state);
    const input = (sent[0] as GetCommand).input;
    expect(input).toMatchObject({
      TableName: 'streaks',
      Key: { pk: 'USER#u1', sk: 'HABIT#h1' },
      ConsistentRead: true,
    });
  });

  it('returns null when there is no item', async () => {
    const { client } = fakeClient(() => ({}));
    expect(await new DynamoDbStreakStore(client, 'streaks').get('u1', 'h1')).toBeNull();
  });

  it('creates a new item only if none exists', async () => {
    const { client, sent } = fakeClient();
    expect(await new DynamoDbStreakStore(client, 'streaks').save(state, null)).toBe(true);
    const input = (sent[0] as PutCommand).input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(input.Item).toMatchObject({
      pk: 'USER#u1',
      sk: 'HABIT#h1',
      currentStreak: 4,
      longestStreak: 9,
      lastActivityDate: '2026-11-20',
      version: 2,
    });
  });

  it('updates only if the stored version is the one that was read', async () => {
    const { client, sent } = fakeClient();
    await new DynamoDbStreakStore(client, 'streaks').save(state, 1);
    const input = (sent[0] as PutCommand).input;
    expect(input.ConditionExpression).toBe('#version = :expected');
    expect(input.ExpressionAttributeValues).toEqual({ ':expected': 1 });
    expect(input.ExpressionAttributeNames).toEqual({ '#version': 'version' });
  });

  it('reports a lost race as false instead of an error', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });
    });
    expect(await new DynamoDbStreakStore(client, 'streaks').save(state, 1)).toBe(false);
  });

  it('lets every other failure through', async () => {
    const { client } = fakeClient(() => {
      throw new Error('ProvisionedThroughputExceededException');
    });
    await expect(new DynamoDbStreakStore(client, 'streaks').save(state, 1)).rejects.toThrow(
      /Throughput/,
    );
  });
});
