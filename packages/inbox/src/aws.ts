import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from '@teampulse/observability';
import { EventConsumer, type EventHandlers, type Message, type MessageSource } from './consumer.js';

/**
 * Real SQS queue for production. Credentials come from the ECS task role (default provider chain).
 * Kept out of the package root so tests and handlers do not load the AWS SDK.
 */
export function createSqsMessageSource(options: {
  queueUrl: string;
  region?: string;
}): MessageSource {
  const client = new SQSClient({
    ...(options.region === undefined ? {} : { region: options.region }),
    maxAttempts: 3,
  });
  return {
    async receive(max, waitSeconds): Promise<readonly Message[]> {
      const output = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: Math.min(max, 10),
          WaitTimeSeconds: waitSeconds,
        }),
      );
      return (output.Messages ?? []).flatMap((message) =>
        message.ReceiptHandle === undefined || message.Body === undefined
          ? []
          : [{ id: message.ReceiptHandle, body: message.Body }],
      );
    },
    async remove(message) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: options.queueUrl, ReceiptHandle: message.id }),
      );
    },
  };
}

export interface ConsumerSettings {
  readonly queueUrl: string | undefined;
  readonly region?: string | undefined;
  readonly handlers: EventHandlers;
  readonly logger: Logger;
}

/**
 * Starts consuming a service's queue in the background. Returns a handle whose `stop()` ends the
 * loop. Without a queue URL nothing starts (local development).
 */
export function startEventConsumer(settings: ConsumerSettings): { stop(): Promise<void> } {
  if (settings.queueUrl === undefined) {
    settings.logger.warn(
      { event: 'consumer.disabled' },
      'EVENTS_QUEUE_URL is not set: this service is not consuming events',
    );
    return { stop: () => Promise.resolve() };
  }
  const consumer = new EventConsumer({
    source: createSqsMessageSource({
      queueUrl: settings.queueUrl,
      ...(settings.region === undefined ? {} : { region: settings.region }),
    }),
    handlers: settings.handlers,
    logger: settings.logger,
  });
  const controller = new AbortController();
  const running = consumer.run({ signal: controller.signal });
  return {
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}
