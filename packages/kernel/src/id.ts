import { randomUUID } from 'node:crypto';

/** Port for identifier creation. Inject it so tests can predict ids. */
export interface IdGenerator {
  next(): string;
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/** Test double producing valid, predictable version 4 UUIDs: ...0001, ...0002, and so on. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
  }
}
