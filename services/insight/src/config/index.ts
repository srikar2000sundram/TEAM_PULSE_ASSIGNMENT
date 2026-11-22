import {
  baseConfigSchema,
  consumerConfigShape,
  csv,
  loadServiceConfig,
  requireEventing,
  z,
} from '@teampulse/config';
import { DEFAULT_MIN_COHORT_SIZE, MIN_ALLOWED_COHORT_SIZE } from '@teampulse/privacy';

/** Only for local development and tests. Production refuses to start with it. */
export const DEVELOPMENT_PSEUDONYM_KEY = 'development-only-insight-pseudonym-key-0123456789';

const tableName = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+$/, 'must be a DynamoDB table name');

export const insightConfigSchema = baseConfigSchema
  .extend({
    /** Cells and event markers. Holds no user ids. */
    AGGREGATES_TABLE_NAME: tableName,
    /** Personal counters, readable only by their owner. */
    PERSONAL_TABLE_NAME: tableName,
    AWS_REGION: z.string().min(1).optional(),

    /** Groups smaller than this are never shown. A policy value for HR and legal to confirm. */
    MIN_COHORT_SIZE: z.coerce
      .number()
      .int()
      .min(MIN_ALLOWED_COHORT_SIZE)
      .max(100)
      .default(DEFAULT_MIN_COHORT_SIZE),
    /** How long counters are kept after the day they describe. */
    RETENTION_DAYS: z.coerce.number().int().min(31).max(3650).default(400),
    /** Secret for the pseudonyms stored in cells. Losing it only makes new counts unlinkable to old. */
    INSIGHT_PSEUDONYM_KEY: z.string().min(32).default(DEVELOPMENT_PSEUDONYM_KEY),

    IDENTITY_JWKS_URL: z.url(),
    JWT_ISSUER: z.string().min(1).default('teampulse-identity'),
    JWT_AUDIENCE: z.string().min(1).default('teampulse-api'),

    ...consumerConfigShape,

    CORS_ORIGINS: csv.default([]),
    TRUST_PROXY: z.stringbool().default(false),
  })
  .superRefine((config, context) => {
    // This service publishes no events, so it needs no event bus, only its queue.
    requireEventing(
      {
        NODE_ENV: config.NODE_ENV,
        EVENT_BUS_NAME: 'not-needed',
        EVENTS_QUEUE_URL: config.EVENTS_QUEUE_URL,
      },
      (variable, message) => context.addIssue({ code: 'custom', path: [variable], message }),
      { consumes: true },
    );
    if (config.NODE_ENV !== 'production') return;
    const require = (ok: boolean, path: string, message: string) => {
      if (!ok) context.addIssue({ code: 'custom', path: [path], message });
    };
    require(config.INSIGHT_PSEUDONYM_KEY !==
      DEVELOPMENT_PSEUDONYM_KEY, 'INSIGHT_PSEUDONYM_KEY', 'must be set to a secret value in production');
    require(config.IDENTITY_JWKS_URL.startsWith(
      'https://',
    ), 'IDENTITY_JWKS_URL', 'must use https:// in production');
    require(config.CORS_ORIGINS.length >
      0, 'CORS_ORIGINS', 'must list the web app origin in production');
    require(config.CORS_ORIGINS.every((origin) =>
      origin.startsWith('https://'),
    ), 'CORS_ORIGINS', 'must use https:// origins in production');
  });

export type InsightConfig = z.infer<typeof insightConfigSchema>;

export function loadInsightConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<InsightConfig> {
  return loadServiceConfig(insightConfigSchema, env);
}
