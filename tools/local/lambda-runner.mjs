/**
 * Runs the Lambda functions locally. In AWS, an EventBridge rule invokes the function. Here the rule
 * feeds a queue and this process reads it and calls the very same handler function with the same
 * kind of event (an EventBridge delivery), so the function code is what runs in both places.
 *
 * A message is deleted only when the handler succeeds. A failure leaves it on the queue, and after
 * five attempts the queue moves it to the dead-letter queue, as a Lambda with a retry policy would.
 */
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { pathToFileURL } from 'node:url';
import { LAMBDA_QUEUES, queueName } from './topology.mjs';

const sqs = new SQSClient({});
const log = (message) => process.stdout.write(`${message}\n`);

async function queueUrl(name) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName(`lambda-${name}`) })))
        .QueueUrl;
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function run(name, spec) {
  const url = await queueUrl(name);
  const handler = (await import(pathToFileURL(spec.module).href))[spec.export];
  log(`lambda ${name}: listening on ${url}`);
  for (;;) {
    try {
      const output = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 5, WaitTimeSeconds: 10 }),
      );
      for (const message of output.Messages ?? []) {
        try {
          await handler(JSON.parse(message.Body));
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
          );
        } catch (error) {
          log(`lambda ${name}: invocation failed, will be retried: ${error.message}`);
        }
      }
    } catch (error) {
      log(`lambda ${name}: could not read the queue: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

await Promise.all(Object.entries(LAMBDA_QUEUES).map(([name, spec]) => run(name, spec)));
