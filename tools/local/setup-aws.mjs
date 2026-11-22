/**
 * Creates the "AWS" the platform needs inside LocalStack: the event bus, one queue per consumer (each
 * with a dead-letter queue), the rules that route events to the queues, and the DynamoDB tables.
 *
 * Safe to run again: everything that already exists is left alone. Uses the AWS SDK's standard
 * AWS_ENDPOINT_URL setting, so the same code would work against real AWS.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  BUS_NAME,
  TABLES,
  allQueues,
  dlqName,
  patternFor,
  queueName,
  ruleName,
} from './topology.mjs';

const sqs = new SQSClient({});
const events = new EventBridgeClient({});
const dynamo = new DynamoDBClient({});
const log = (message) => process.stdout.write(`${message}\n`);

/** LocalStack needs a few seconds after start-up; retry the first call instead of failing. */
async function withRetry(label, work, attempts = 30) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`waiting for ${label} (${attempt}/${attempts}): ${error.name}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function ensureQueue(name, attributes = {}) {
  const { QueueUrl } = await withRetry(`queue ${name}`, () =>
    sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes })),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  return { url: QueueUrl, arn: Attributes.QueueArn };
}

async function ensureTable(name) {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: name }));
    return;
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
  }
  await dynamo.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
  log(`created table ${name}`);
}

await withRetry('the event bus', () =>
  events.send(new CreateEventBusCommand({ Name: BUS_NAME })).catch((error) => {
    if (error.name === 'ResourceAlreadyExistsException') return;
    throw error;
  }),
);
log(`event bus ${BUS_NAME} ready`);

for (const { name, events: eventTypes } of allQueues()) {
  const dlq = await ensureQueue(dlqName(name));
  const queue = await ensureQueue(queueName(name), {
    VisibilityTimeout: '30',
    // After five failed deliveries a message moves to the dead-letter queue instead of looping.
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: '5' }),
  });
  await events.send(
    new PutRuleCommand({
      Name: ruleName(name),
      EventBusName: BUS_NAME,
      EventPattern: patternFor(eventTypes),
      State: 'ENABLED',
    }),
  );
  await events.send(
    new PutTargetsCommand({
      Rule: ruleName(name),
      EventBusName: BUS_NAME,
      Targets: [{ Id: 'queue', Arn: queue.arn }],
    }),
  );
  log(`queue ${queueName(name)} receives ${eventTypes.join(', ')}`);
}

for (const table of Object.values(TABLES))
  await withRetry(`table ${table}`, () => ensureTable(table));
for (const table of [TABLES.aggregates, TABLES.personal]) {
  // Counters delete themselves after the retention period (see the Insight architecture document).
  await dynamo.send(
    new UpdateTimeToLiveCommand({
      TableName: table,
      TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
    }),
  );
}
log('local AWS resources ready');
