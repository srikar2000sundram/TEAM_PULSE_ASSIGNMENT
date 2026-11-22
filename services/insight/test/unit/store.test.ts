import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoDbAnalyticsStore } from '../../src/adapters/dynamodb-store.js';
import { FakeDynamo } from '../support/fake-dynamo.js';
import { InMemoryAnalyticsStore } from '../support/in-memory.js';
import { describeAnalyticsStoreContract } from '../support/store-contract.js';

const TABLES = { aggregates: 'aggregates', personal: 'personal' };
const EXPIRES = new Date('2027-01-01T00:00:00Z');

describeAnalyticsStoreContract('in-memory store', () => new InMemoryAnalyticsStore());
describeAnalyticsStoreContract(
  'DynamoDB store on a fake DynamoDB',
  () => new DynamoDbAnalyticsStore(new FakeDynamo(), TABLES),
);
describeAnalyticsStoreContract('DynamoDB store reading in tiny pages', () => {
  const dynamo = new FakeDynamo();
  dynamo.pageSize = 1;
  return new DynamoDbAnalyticsStore(dynamo, TABLES);
});

const observation = (eventId = 'e1', userId = 'user-1') => ({
  eventId,
  userId,
  day: '2026-11-20',
  activityType: 'walking' as const,
  contributions: [
    { scopeKey: 'SCOPE#ORG', participant: 'tok-org' },
    { scopeKey: 'SCOPE#TEAM#t1', participant: 'tok-team' },
  ],
  expiresAt: EXPIRES,
});

describe('DynamoDbAnalyticsStore: what it sends', () => {
  it('counts an event in ONE transaction: marker first, then personal counter, then each cell', async () => {
    const dynamo = new FakeDynamo();
    await new DynamoDbAnalyticsStore(dynamo, TABLES).record(observation());

    expect(dynamo.sent).toHaveLength(1);
    const items = (dynamo.sent[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(items).toHaveLength(4);
    expect(items[0]?.Put).toMatchObject({
      TableName: 'aggregates',
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: 'EVENT#e1', sk: 'MARK', expiresAt: EXPIRES.getTime() / 1000 },
    });
    expect(items[1]?.Update).toMatchObject({
      TableName: 'personal',
      Key: { pk: 'USER#user-1', sk: 'DAY#2026-11-20#TYPE#walking' },
    });
    expect(items.slice(2).map((item) => item.Update?.Key)).toEqual([
      { pk: 'SCOPE#ORG', sk: 'DAY#2026-11-20#TYPE#walking' },
      { pk: 'SCOPE#TEAM#t1', sk: 'DAY#2026-11-20#TYPE#walking' },
    ]);
    for (const item of items.slice(1)) {
      expect(item.Update?.ExpressionAttributeValues?.[':ttl']).toBe(EXPIRES.getTime() / 1000);
    }
  });

  it('puts no user id into the aggregates table, only into the personal one', async () => {
    const dynamo = new FakeDynamo();
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    await store.record(observation('e1', 'user-secret-id'));
    await store.record(observation('e2', 'user-secret-id'));
    expect(dynamo.dump('aggregates')).not.toContain('user-secret-id');
    expect(dynamo.dump('personal')).toContain('user-secret-id');
  });

  it('reports a redelivery as a duplicate and changes nothing', async () => {
    const dynamo = new FakeDynamo();
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    await store.record(observation());
    const before = dynamo.dump('aggregates') + dynamo.dump('personal');
    expect(await store.record(observation())).toBe('duplicate');
    expect(dynamo.dump('aggregates') + dynamo.dump('personal')).toBe(before);
  });

  it('throws any other cancellation, so the message is retried instead of lost', async () => {
    const dynamo = new FakeDynamo();
    dynamo.failNextTransactionWith = 'TransactionConflict';
    await expect(new DynamoDbAnalyticsStore(dynamo, TABLES).record(observation())).rejects.toThrow(
      TransactionCanceledException,
    );
    // The retry then works.
    expect(await new DynamoDbAnalyticsStore(dynamo, TABLES).record(observation())).toBe('recorded');
  });

  it('does not treat a conflict on a later item as a duplicate', async () => {
    const dynamo = new FakeDynamo();
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    const real = dynamo.send.bind(dynamo);
    dynamo.send = (command: TransactWriteCommand | QueryCommand) => {
      if (command instanceof TransactWriteCommand) {
        return Promise.reject(
          new TransactionCanceledException({
            message: 'x',
            $metadata: {},
            CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
          }),
        );
      }
      return real(command);
    };
    await expect(store.record(observation())).rejects.toThrow();
  });

  it('queries an inclusive key range, so the last day is included and the next day is not', async () => {
    const dynamo = new FakeDynamo();
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    await store.readCells('SCOPE#ORG', '2026-11-01', '2026-11-30');
    const input = (dynamo.sent[0] as QueryCommand).input;
    expect(input.KeyConditionExpression).toBe('pk = :pk AND sk BETWEEN :from AND :to');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'SCOPE#ORG',
      ':from': 'DAY#2026-11-01',
      ':to': 'DAY#2026-11-30~',
    });
    const key = 'DAY#2026-11-30#TYPE#yoga';
    expect(key >= 'DAY#2026-11-01' && key <= 'DAY#2026-11-30~').toBe(true);
    expect('DAY#2026-12-01#TYPE#yoga' <= 'DAY#2026-11-30~').toBe(false);
  });

  it('follows LastEvaluatedKey until every page is read', async () => {
    const dynamo = new FakeDynamo();
    dynamo.pageSize = 2;
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    for (let day = 1; day <= 5; day += 1) {
      await store.record({
        ...observation(`e${day}`),
        day: `2026-11-0${day}`,
      });
    }
    const queriesBefore = dynamo.sent.length;
    const cells = await store.readCells('SCOPE#ORG', '2026-11-01', '2026-11-30');
    expect(cells).toHaveLength(5);
    expect(dynamo.sent.length - queriesBefore).toBe(3);
  });

  it('skips items whose sort key is not a day and an activity type, instead of failing', async () => {
    const dynamo = new FakeDynamo();
    dynamo.table('aggregates').set('x', {
      pk: 'SCOPE#ORG',
      sk: 'DAY#2026-11-20#TYPE#not-a-type',
      completions: 3,
      people: new Set(['a']),
    });
    expect(
      await new DynamoDbAnalyticsStore(dynamo, TABLES).readCells(
        'SCOPE#ORG',
        '2026-11-01',
        '2026-11-30',
      ),
    ).toEqual([]);
  });

  it('erases a personal day atomically, with the delete first and conditional', async () => {
    const dynamo = new FakeDynamo();
    const store = new DynamoDbAnalyticsStore(dynamo, TABLES);
    await store.record(observation());
    const [day] = await store.readPersonal('user-1', '2026-11-20', '2026-11-20');
    dynamo.sent.length = 0;
    await store.erasePersonalDay('user-1', day!, observation().contributions);

    expect(dynamo.sent).toHaveLength(1);
    const items = (dynamo.sent[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(items[0]?.Delete).toMatchObject({
      TableName: 'personal',
      Key: { pk: 'USER#user-1', sk: 'DAY#2026-11-20#TYPE#walking' },
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(items).toHaveLength(3);
  });

  it('pings with a cheap one-item query', async () => {
    const dynamo = new FakeDynamo();
    await new DynamoDbAnalyticsStore(dynamo, TABLES).ping();
    expect((dynamo.sent[0] as QueryCommand).input.Limit).toBe(1);
  });
});
