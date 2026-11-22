import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentClientPort } from '../../src/adapters/dynamodb-store.js';

type Item = Record<string, unknown>;

/**
 * A small DynamoDB stand-in that executes the expressions the store sends: conditions, `ADD`,
 * `DELETE` and `SET` update clauses, `BETWEEN` key ranges, paging, and all-or-nothing transactions.
 *
 * It refuses expressions it does not understand, so changing an expression in the store forces a
 * conscious change here too. It is not DynamoDB: what it cannot show is real throttling, item size
 * limits and consistency behaviour (see the architecture document).
 */
export class FakeDynamo implements DocumentClientPort {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly sent: (TransactWriteCommand | QueryCommand)[] = [];
  /** Items per Query page, to exercise `LastEvaluatedKey` handling. */
  pageSize = 1000;
  /** Makes the next transaction fail with this cancellation code instead of running. */
  failNextTransactionWith: string | undefined;

  send(command: TransactWriteCommand): Promise<unknown>;
  send(command: QueryCommand): Promise<{
    Items?: Item[] | undefined;
    LastEvaluatedKey?: Item | undefined;
  }>;
  send(command: TransactWriteCommand | QueryCommand): Promise<unknown> {
    this.sent.push(command);
    try {
      return Promise.resolve(
        command instanceof TransactWriteCommand ? this.transact(command) : this.query(command),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  table(name: string): Map<string, Item> {
    let table = this.tables.get(name);
    if (table === undefined) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  /** All stored items of a table, as JSON text. */
  dump(name: string): string {
    return JSON.stringify([...this.table(name).values()], (_k, v: unknown) =>
      v instanceof Set ? [...(v as Set<unknown>)] : v,
    );
  }

  private transact(command: TransactWriteCommand): unknown {
    const items = command.input.TransactItems ?? [];
    if (this.failNextTransactionWith !== undefined) {
      const code = this.failNextTransactionWith;
      this.failNextTransactionWith = undefined;
      throw cancelled(items.map(() => code));
    }

    // Phase 1: evaluate every condition against the current state, as DynamoDB does.
    const reasons = items.map((item) => {
      const put = item.Put;
      const del = item.Delete;
      const condition = put?.ConditionExpression ?? del?.ConditionExpression;
      if (condition === undefined) return 'None';
      const name = (put ?? del)?.TableName ?? '';
      const key = put === undefined ? (del?.Key ?? {}) : (put.Item ?? {});
      const exists = this.table(name).has(keyOf(key));
      if (condition === 'attribute_not_exists(pk)')
        return exists ? 'ConditionalCheckFailed' : 'None';
      if (condition === 'attribute_exists(pk)') return exists ? 'None' : 'ConditionalCheckFailed';
      throw new Error(`FakeDynamo does not understand the condition "${condition}"`);
    });
    if (reasons.some((reason) => reason !== 'None')) throw cancelled(reasons);

    // Phase 2: apply everything.
    for (const item of items) {
      if (item.Put !== undefined) {
        this.table(item.Put.TableName ?? '').set(keyOf(item.Put.Item ?? {}), { ...item.Put.Item });
      } else if (item.Delete !== undefined) {
        this.table(item.Delete.TableName ?? '').delete(keyOf(item.Delete.Key ?? {}));
      } else if (item.Update !== undefined) {
        const table = this.table(item.Update.TableName ?? '');
        const key = item.Update.Key ?? {};
        const existing = table.get(keyOf(key)) ?? { ...key };
        table.set(
          keyOf(key),
          applyUpdate(
            existing,
            item.Update.UpdateExpression ?? '',
            item.Update.ExpressionAttributeValues ?? {},
          ),
        );
      }
    }
    return {};
  }

  private query(command: QueryCommand): { Items: Item[]; LastEvaluatedKey?: Item } {
    const input = command.input;
    const values = input.ExpressionAttributeValues ?? {};
    const expression = input.KeyConditionExpression ?? '';
    const between = expression === 'pk = :pk AND sk BETWEEN :from AND :to';
    if (!between && expression !== 'pk = :pk') {
      throw new Error(`FakeDynamo does not understand the key condition "${expression}"`);
    }
    const rows = [...this.table(input.TableName ?? '').values()]
      .filter((item) => item['pk'] === values[':pk'])
      .filter(
        (item) =>
          !between ||
          (String(item['sk']) >= String(values[':from']) &&
            String(item['sk']) <= String(values[':to'])),
      )
      .sort((a, b) => (String(a['sk']) < String(b['sk']) ? -1 : 1));

    const start = input.ExclusiveStartKey;
    const after = start === undefined ? 0 : rows.findIndex((row) => row['sk'] === start['sk']) + 1;
    const limit = Math.min(input.Limit ?? this.pageSize, this.pageSize);
    const page = rows.slice(after, after + limit);
    const more = after + limit < rows.length;
    const last = page[page.length - 1];
    return {
      Items: page,
      ...(more && last !== undefined
        ? { LastEvaluatedKey: { pk: last['pk'], sk: last['sk'] } }
        : {}),
    };
  }
}

const keyOf = (key: Item): string => `${String(key['pk'])}\u0000${String(key['sk'])}`;

function cancelled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

/** Executes `SET`, `ADD` and `DELETE` clauses against an item. */
function applyUpdate(item: Item, expression: string, values: Record<string, unknown>): Item {
  const result: Item = { ...item };
  const clauses = expression.split(/(?=\b(?:SET|ADD|DELETE) )/).map((c) => c.trim());
  for (const clause of clauses) {
    const [verb, ...rest] = clause.split(' ');
    const body = rest.join(' ');
    if (verb === 'SET') {
      for (const assignment of body.split(/, (?=\w+ =)/)) {
        const match = /^(\w+) = (?:(:\w+)|if_not_exists\((\w+), (:\w+)\))$/.exec(assignment.trim());
        if (match === null) throw new Error(`FakeDynamo does not understand "${assignment}"`);
        const [, attribute = '', direct, guarded, fallback] = match;
        if (direct !== undefined) result[attribute] = values[direct];
        else if (result[guarded ?? ''] === undefined) result[attribute] = values[fallback ?? ''];
      }
    } else if (verb === 'ADD' || verb === 'DELETE') {
      for (const pair of body.split(', ')) {
        const [attribute = '', placeholder = ''] = pair.trim().split(' ');
        const operand = values[placeholder];
        if (verb === 'ADD' && typeof operand === 'number') {
          result[attribute] = Number(result[attribute] ?? 0) + operand;
        } else if (verb === 'ADD' && operand instanceof Set) {
          const current = result[attribute];
          result[attribute] = new Set([
            ...(current instanceof Set ? (current as Set<unknown>) : []),
            ...(operand as Set<unknown>),
          ]);
        } else if (verb === 'DELETE' && operand instanceof Set) {
          const current = result[attribute];
          if (current instanceof Set) {
            const remaining = new Set(
              [...(current as Set<unknown>)].filter((x) => !(operand as Set<unknown>).has(x)),
            );
            // DynamoDB cannot hold an empty set: the attribute disappears.
            if (remaining.size === 0) delete result[attribute];
            else result[attribute] = remaining;
          }
        } else {
          throw new Error(`FakeDynamo does not understand "${verb} ${pair}"`);
        }
      }
    } else {
      throw new Error(`FakeDynamo does not understand the update clause "${clause}"`);
    }
  }
  return result;
}
