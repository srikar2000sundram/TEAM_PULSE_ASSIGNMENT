import { z } from 'zod';

export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

/**
 * Thrown at startup when configuration is missing or invalid.
 * The message names the variables and the rule they broke, but never echoes their values,
 * because a mistyped secret must not end up in logs.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parses and validates environment variables once, at startup, and returns a typed, immutable
 * object. The rest of the program receives this object instead of reading `process.env`,
 * so there is exactly one place where configuration is read and one place where it can be wrong.
 */
export function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<z.infer<Schema>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return Object.freeze(result.data);
}

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/** Settings every service needs. Extend it with `baseConfigSchema.extend({ ... })`. */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Salt for pseudonymising user ids in logs. Required in production so ids are never plain. */
  LOG_PSEUDONYM_SALT: z.string().min(16).optional(),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

/** Production must pseudonymise log user ids; `loadServiceConfig` enforces it. */
export function loadServiceConfig<Schema extends typeof baseConfigSchema>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<z.infer<Schema>> {
  const config = loadConfig(schema, env);
  if (config.NODE_ENV === 'production' && config.LOG_PSEUDONYM_SALT === undefined) {
    throw new ConfigError([
      { variable: 'LOG_PSEUDONYM_SALT', message: 'is required when NODE_ENV is production' },
    ]);
  }
  return config;
}

/** Comma-separated list, for example `A,B,C`. Empty entries are dropped. */
export const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/**
 * Settings of a service that publishes events (it has an outbox). Spread into `.extend({...})`.
 * With no bus configured the relay does not start: events simply accumulate in the outbox, which
 * is safe for local development. Production requires a bus (see `requireEventing`).
 */
export const publisherConfigShape = {
  EVENT_BUS_NAME: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  /** Published outbox rows older than this are deleted. */
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
} as const;

/** Settings of a service that consumes events from its own queue. */
export const consumerConfigShape = {
  EVENTS_QUEUE_URL: z.url().optional(),
} as const;

/** A production service must not silently run without its event plumbing. */
export function requireEventing(
  config: {
    NODE_ENV: string;
    EVENT_BUS_NAME?: string | undefined;
    EVENTS_QUEUE_URL?: string | undefined;
  },
  issue: (variable: string, message: string) => void,
  options: { consumes: boolean },
): void {
  if (config.NODE_ENV !== 'production') return;
  if (config.EVENT_BUS_NAME === undefined) issue('EVENT_BUS_NAME', 'is required in production');
  if (options.consumes && config.EVENTS_QUEUE_URL === undefined) {
    issue('EVENTS_QUEUE_URL', 'is required in production');
  }
}

export { z };
