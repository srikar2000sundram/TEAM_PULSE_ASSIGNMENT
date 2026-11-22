import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Runs `fn` with a correlation id that every logger call inside it picks up automatically.
 * HTTP adapters call this per request (reusing the incoming `x-correlation-id` when present);
 * queue consumers call it per message, using the event's `correlationId`.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';
