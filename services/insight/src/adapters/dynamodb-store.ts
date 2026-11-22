import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { activityTypeSchema } from '@teampulse/contracts';
import type { ActivityObservation, AnalyticsStore, Contribution } from '../application/ports.js';
import type { CellData, PersonalDay } from '../domain/report.js';

/** The two document client calls we use, so tests need no AWS. */
export interface DocumentClientPort {
  send(command: TransactWriteCommand): Promise<unknown>;
  send(command: QueryCommand): Promise<{
    Items?: Record<string, unknown>[] | undefined;
    LastEvaluatedKey?: Record<string, unknown> | undefined;
  }>;
}

export interface DynamoDbStoreTables {
  /** Cells (per scope, day and type) and the event markers. Holds no user ids. */
  readonly aggregates: string;
  /** Personal counters. Only ever read for the signed-in person. */
  readonly personal: string;
}

const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const sortKey = (day: string, activityType: string) => `DAY#${day}#TYPE#${activityType}`;
const SORT_KEY_PATTERN = /^DAY#(\d{4}-\d{2}-\d{2})#TYPE#([a-z]+)$/;

/** Sort keys between two days, whatever the type: `~` sorts after `#`, so the last day is included. */
const rangeStart = (from: string) => `DAY#${from}`;
const rangeEnd = (to: string) => `DAY#${to}~`;

const asStrings = (value: unknown): string[] =>
  value instanceof Set ? [...(value as Set<unknown>)].map(String) : [];

/**
 * Aggregates in DynamoDB: two tables, so that permissions can differ.
 *
 * **Counting once.** Every event is counted in one `TransactWriteItems` call that also creates a
 * marker item for the event id with `attribute_not_exists`. A redelivered event fails that
 * condition, the whole transaction is cancelled and nothing is counted twice. Because the marker is
 * the first item, a cancellation caused by it is recognisable and reported as `duplicate`; any
 * other cancellation (throttling, a conflicting transaction) is thrown, so the message is retried.
 *
 * **Distinct people.** A cell keeps a *set* of pseudonyms next to its counter. Adding to a set is
 * naturally idempotent, and the size of the set is the number of different people. An item may be
 * 400 KB, which holds roughly 20,000 pseudonyms: enough for one team, and a limit to revisit for
 * a very large organisation scope (see the architecture document).
 */
export class DynamoDbAnalyticsStore implements AnalyticsStore {
  constructor(
    private readonly client: DocumentClientPort,
    private readonly tables: DynamoDbStoreTables,
  ) {}

  async record(observation: ActivityObservation): Promise<'recorded' | 'duplicate'> {
    const ttl = epochSeconds(observation.expiresAt);
    const key = sortKey(observation.day, observation.activityType);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Must stay first: `duplicate` is recognised by this item's cancellation reason.
              Put: {
                TableName: this.tables.aggregates,
                Item: { pk: `EVENT#${observation.eventId}`, sk: 'MARK', expiresAt: ttl },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.tables.personal,
                Key: { pk: `USER#${observation.userId}`, sk: key },
                UpdateExpression: 'ADD completions :one, scopes :scopes SET expiresAt = :ttl',
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':scopes': new Set(observation.contributions.map((c) => c.scopeKey)),
                  ':ttl': ttl,
                },
              },
            },
            ...observation.contributions.map((contribution) => ({
              Update: {
                TableName: this.tables.aggregates,
                Key: { pk: contribution.scopeKey, sk: key },
                UpdateExpression: 'ADD completions :one, people :person SET expiresAt = :ttl',
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':person': new Set([contribution.participant]),
                  ':ttl': ttl,
                },
              },
            })),
          ],
        }),
      );
      return 'recorded';
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
      ) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async readCells(scopeKey: string, from: string, to: string): Promise<readonly CellData[]> {
    const items = await this.query(this.tables.aggregates, scopeKey, from, to);
    return items.flatMap((item): CellData[] => {
      const parsed = this.parseKey(item);
      const completions = Number(item['completions'] ?? 0);
      const participants = asStrings(item['people']);
      // An emptied cell (everyone erased) is left behind until it expires; it carries no data.
      if (parsed === null || completions <= 0 || participants.length === 0) return [];
      return [{ ...parsed, completions, participants }];
    });
  }

  async readPersonal(userId: string, from: string, to: string): Promise<readonly PersonalDay[]> {
    const items = await this.query(this.tables.personal, `USER#${userId}`, from, to);
    return items.flatMap((item): PersonalDay[] => {
      const parsed = this.parseKey(item);
      const completions = Number(item['completions'] ?? 0);
      if (parsed === null || completions <= 0) return [];
      return [
        {
          day: parsed.day,
          activityType: parsed.activityType,
          completions,
          scopeKeys: asStrings(item['scopes']),
          expiresAt: new Date(Number(item['expiresAt'] ?? 0) * 1000),
        },
      ];
    });
  }

  async erasePersonalDay(
    userId: string,
    day: PersonalDay,
    contributions: readonly Contribution[],
  ): Promise<void> {
    const key = sortKey(day.day, day.activityType);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Must stay first. If the personal day is already gone, a previous attempt finished
              // it (this transaction is all or nothing), so there is nothing left to take back.
              Delete: {
                TableName: this.tables.personal,
                Key: { pk: `USER#${userId}`, sk: key },
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            ...contributions.map((contribution) => ({
              Update: {
                TableName: this.tables.aggregates,
                Key: { pk: contribution.scopeKey, sk: key },
                UpdateExpression:
                  'ADD completions :minus DELETE people :person SET expiresAt = if_not_exists(expiresAt, :ttl)',
                ExpressionAttributeValues: {
                  ':minus': -day.completions,
                  ':person': new Set([contribution.participant]),
                  ':ttl': epochSeconds(day.expiresAt),
                },
              },
            })),
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
      ) {
        return;
      }
      throw error;
    }
  }

  async ping(): Promise<void> {
    await this.client.send(
      new QueryCommand({
        TableName: this.tables.aggregates,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'PING' },
        Limit: 1,
      }),
    );
  }

  /** Reads every page of a key range; a long period can exceed one response. */
  private async query(
    tableName: string,
    pk: string,
    from: string,
    to: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': pk, ':from': rangeStart(from), ':to': rangeEnd(to) },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  private parseKey(
    item: Record<string, unknown>,
  ): { day: string; activityType: CellData['activityType'] } | null {
    const match = SORT_KEY_PATTERN.exec(typeof item['sk'] === 'string' ? item['sk'] : '');
    const type = activityTypeSchema.safeParse(match?.[2]);
    if (match === null || !type.success) return null;
    return { day: match[1] ?? '', activityType: type.data };
  }
}
