import {
  baseConfigSchema,
  consumerConfigShape,
  csv,
  loadServiceConfig,
  publisherConfigShape,
  requireEventing,
  trustedProxies,
  z,
} from '@teampulse/config';

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a simple lower-case name');

export const challengeConfigSchema = baseConfigSchema
  .extend({
    DATABASE_URL: z.string().min(1),
    DATABASE_SCHEMA: schemaName.default('challenge'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_SSL: z.stringbool().default(false),

    /** Where to fetch the public keys that verify access tokens (the Identity Service). */
    IDENTITY_JWKS_URL: z.url(),
    JWT_ISSUER: z.string().min(1).default('teampulse-identity'),
    JWT_AUDIENCE: z.string().min(1).default('teampulse-api'),

    /** How often challenges are started and completed according to the calendar. */
    CHALLENGE_TICK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /** Days after a challenge's end date during which activities for its last day still count. */
    CHALLENGE_GRACE_DAYS: z.coerce.number().int().min(0).max(7).default(1),

    CORS_ORIGINS: csv.default([]),
    TRUST_PROXY: trustedProxies,

    ...publisherConfigShape,
    ...consumerConfigShape,
  })
  .superRefine((config, context) => {
    requireEventing(
      config,
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

export type ChallengeConfig = z.infer<typeof challengeConfigSchema>;

export function loadChallengeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<ChallengeConfig> {
  return loadServiceConfig(challengeConfigSchema, env);
}

/** The subset the one-off migrate command needs. */
export const databaseOnlySchema = baseConfigSchema.extend({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: schemaName.default('challenge'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  DATABASE_SSL: z.stringbool().default(false),
});
