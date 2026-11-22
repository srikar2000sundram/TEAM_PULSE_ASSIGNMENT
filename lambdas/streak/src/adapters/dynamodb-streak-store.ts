import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { StreakStore } from '../application/update-streak.js';
import type { StreakState } from '../domain/streak.js';

/** The one method of the DynamoDB document client we use, so tests need no AWS. */
export interface DocumentClientPort {
  send(command: GetCommand | PutCommand): Promise<{ Item?: Record<string, unknown> | undefined }>;
}

/**
 * Streak state in DynamoDB. One item per user and habit: partition key `USER#<id>`, sort key
 * `HABIT#<id>`, so all of a person's streaks sit together.
 *
 * Writes are conditional (`attribute_not_exists` for a new item, `version = :expected` for an
 * update), so two invocations racing on the same streak cannot overwrite each other: the loser is
 * told to re-read and try again.
 */
export class DynamoDbStreakStore implements StreakStore {
  constructor(
    private readonly client: DocumentClientPort,
    private readonly tableName: string,
  ) {}

  private key(userId: string, habitId: string) {
    return { pk: `USER#${userId}`, sk: `HABIT#${habitId}` };
  }

  async get(userId: string, habitId: string): Promise<StreakState | null> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(userId, habitId),
        // Streaks decide what is written next, so read the latest write, not a stale replica.
        ConsistentRead: true,
      }),
    );
    const item = output.Item;
    if (item === undefined) return null;
    return {
      userId,
      habitId,
      currentStreak: Number(item['currentStreak']),
      longestStreak: Number(item['longestStreak']),
      lastActivityDate: String(item['lastActivityDate']),
      version: Number(item['version']),
    };
  }

  async save(state: StreakState, expectedVersion: number | null): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...this.key(state.userId, state.habitId),
            currentStreak: state.currentStreak,
            longestStreak: state.longestStreak,
            lastActivityDate: state.lastActivityDate,
            version: state.version,
          },
          ...(expectedVersion === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {
                ConditionExpression: '#version = :expected',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expected': expectedVersion },
              }),
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}
