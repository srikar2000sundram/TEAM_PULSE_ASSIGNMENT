export * from './clock.js';
export * from './cursor.js';
export * from './deterministic-id.js';
export * from './errors.js';
export * from './id.js';
export * from './periodic.js';
export * from './result.js';

/** Compile-time exhaustiveness check for `switch` statements over unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
