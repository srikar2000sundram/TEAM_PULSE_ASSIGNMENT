import {
  baseConfigSchema,
  consumerConfigShape,
  csv,
  loadServiceConfig,
  requireEventing,
  trustedProxies,
  z,
} from '@teampulse/config';

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a simple lower-case name');

export const notificationConfigSchema = baseConfigSchema
  .extend({
    DATABASE_URL: z.string().min(1),
    DATABASE_SCHEMA: schemaName.default('notification'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_SSL: z.stringbool().default(false),

    /** Where to fetch the public keys that verify access tokens (the Identity Service). */
    IDENTITY_JWKS_URL: z.url(),
    JWT_ISSUER: z.string().min(1).default('teampulse-identity'),
    JWT_AUDIENCE: z.string().min(1).default('teampulse-api'),

    /** How often the service looks for reminders that are due. */
    REMINDER_TICK_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    /** How long after its time a reminder may still be sent (covers short outages). */
    REMINDER_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

    AWS_REGION: z.string().min(1).optional(),
    ...consumerConfigShape,

    CORS_ORIGINS: csv.default([]),
    TRUST_PROXY: trustedProxies,
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
    // Guard rails: a production deployment must not be able to run with weakened transport security.
    if (config.NODE_ENV !== 'production') return;
    const require = (ok: boolean, path: string, message: string) => {
      if (!ok) context.addIssue({ code: 'custom', path: [path], message });
    };
    require(config.DATABASE_SSL, 'DATABASE_SSL', 'must be true in production');
    require(config.IDENTITY_JWKS_URL.startsWith(
      'https://',
    ), 'IDENTITY_JWKS_URL', 'must use https:// in production');
    require(config.CORS_ORIGINS.length >
      0, 'CORS_ORIGINS', 'must list the web app origin in production');
    require(config.CORS_ORIGINS.every((origin) =>
      origin.startsWith('https://'),
    ), 'CORS_ORIGINS', 'must use https:// origins in production');
  });

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;

export function loadNotificationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<NotificationConfig> {
  return loadServiceConfig(notificationConfigSchema, env);
}

/** The subset the one-off migrate command needs. */
export const databaseOnlySchema = baseConfigSchema.extend({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: schemaName.default('notification'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  DATABASE_SSL: z.stringbool().default(false),
});
