import {
  baseConfigSchema,
  csv,
  loadServiceConfig,
  publisherConfigShape,
  requireEventing,
  z,
} from '@teampulse/config';

/** Environment variables often carry PEM keys with literal "\n"; restore the real newlines. */
const pem = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n'));

/** A JSON array of PEM public keys, for key rotation. Absent means none. */
const pemList = z
  .string()
  .optional()
  .transform((value, context) => {
    if (value === undefined || value.trim() === '') return [] as string[];
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed.map((item: string) => item.replace(/\\n/g, '\n'));
      }
    } catch {
      // fall through to the issue below
    }
    context.addIssue({ code: 'custom', message: 'must be a JSON array of PEM strings' });
    return z.NEVER;
  });

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a simple lower-case name');

/** Seconds as a bounded integer, so a typo cannot create a 10-year token. */
const seconds = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const identityConfigSchema = baseConfigSchema
  .extend({
    DATABASE_URL: z.string().min(1),
    DATABASE_SCHEMA: schemaName.default('identity'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_SSL: z.stringbool().default(false),

    JWT_PRIVATE_KEY_PEM: pem,
    JWT_PREVIOUS_PUBLIC_KEYS_PEM: pemList,
    JWT_ISSUER: z.string().min(1).default('teampulse-identity'),
    JWT_AUDIENCE: z.string().min(1).default('teampulse-api'),

    ACCESS_TOKEN_TTL_SECONDS: seconds(60, 3_600, 900),
    REFRESH_TOKEN_TTL_SECONDS: seconds(3_600, 30 * 86_400, 7 * 86_400),
    REFRESH_FAMILY_MAX_AGE_SECONDS: seconds(86_400, 90 * 86_400, 30 * 86_400),
    REFRESH_REUSE_GRACE_SECONDS: seconds(0, 60, 10),

    LOCKOUT_MAX_FAILED_ATTEMPTS: seconds(3, 20, 5),
    LOCKOUT_MINUTES: seconds(1, 24 * 60, 15),

    COOKIE_SECURE: z.stringbool().default(true),
    CORS_ORIGINS: csv.default([]),
    TRUST_PROXY: z.stringbool().default(false),

    ...publisherConfigShape,
  })
  .superRefine((config, context) => {
    // Guard rails: a production deployment must not be able to run with weakened transport security.
    requireEventing(
      config,
      (variable, message) => context.addIssue({ code: 'custom', path: [variable], message }),
      { consumes: false },
    );
    if (config.NODE_ENV !== 'production') return;
    const require = (ok: boolean, path: string, message: string) => {
      if (!ok) context.addIssue({ code: 'custom', path: [path], message });
    };
    require(config.COOKIE_SECURE, 'COOKIE_SECURE', 'must be true in production');
    require(config.DATABASE_SSL, 'DATABASE_SSL', 'must be true in production');
    require(config.CORS_ORIGINS.length >
      0, 'CORS_ORIGINS', 'must list the web app origin in production');
    require(config.CORS_ORIGINS.every((origin) =>
      origin.startsWith('https://'),
    ), 'CORS_ORIGINS', 'must use https:// origins in production');
    require(config.REFRESH_FAMILY_MAX_AGE_SECONDS >=
      config.REFRESH_TOKEN_TTL_SECONDS, 'REFRESH_FAMILY_MAX_AGE_SECONDS', 'must be at least REFRESH_TOKEN_TTL_SECONDS');
  });

export type IdentityConfig = z.infer<typeof identityConfigSchema>;

export function loadIdentityConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<IdentityConfig> {
  return loadServiceConfig(identityConfigSchema, env);
}

/** The subset the one-off CLI tools (migrate, bootstrap-admin) need. */
export const databaseOnlySchema = baseConfigSchema.extend({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: schemaName.default('identity'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  DATABASE_SSL: z.stringbool().default(false),
});
