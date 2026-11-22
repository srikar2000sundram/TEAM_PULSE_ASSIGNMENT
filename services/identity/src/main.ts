import { randomBytes } from 'node:crypto';
import { PgDatabase } from '@teampulse/db';
import { startOutboxRelay } from '@teampulse/outbox/aws';
import { SystemClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { runServer } from '@teampulse/http';
import { buildIdentityApp } from './adapters/http/app.js';
import { PostgresUnitOfWork } from './adapters/persistence/repositories.js';
import { Argon2PasswordHasher } from './adapters/security/argon2-password-hasher.js';
import { JwtAccessTokenIssuer, KeyRing } from './adapters/security/jwt-access-token-issuer.js';
import { CryptoOpaqueTokens } from './adapters/security/opaque-tokens.js';
import { createUseCases } from './application/index.js';
import { loadIdentityConfig } from './config/index.js';
import type { RotationPolicy } from './domain/refresh-token.js';
import type { LockoutPolicy } from './domain/user.js';

/**
 * Composition root: the only place that knows every concrete class. It reads configuration once,
 * builds the adapters, hands them to the application core, and starts the server.
 */
async function main(): Promise<void> {
  const config = loadIdentityConfig();

  const logger = createLogger({
    service: 'identity-service',
    level: config.LOG_LEVEL,
    pseudonymSalt: config.LOG_PSEUDONYM_SALT,
  });

  const db = new PgDatabase({
    connectionString: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    maxConnections: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL,
  });

  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const keyRing = await KeyRing.fromPem({
    privateKeyPem: config.JWT_PRIVATE_KEY_PEM,
    previousPublicKeyPems: config.JWT_PREVIOUS_PUBLIC_KEYS_PEM,
  });
  const hasher = new Argon2PasswordHasher();

  const lockout: LockoutPolicy = {
    maxFailedAttempts: config.LOCKOUT_MAX_FAILED_ATTEMPTS,
    lockoutMs: config.LOCKOUT_MINUTES * 60_000,
  };
  const rotation: RotationPolicy = {
    tokenTtlMs: config.REFRESH_TOKEN_TTL_SECONDS * 1_000,
    familyMaxAgeMs: config.REFRESH_FAMILY_MAX_AGE_SECONDS * 1_000,
    reuseGraceMs: config.REFRESH_REUSE_GRACE_SECONDS * 1_000,
  };

  const useCases = createUseCases({
    uow: new PostgresUnitOfWork(db),
    hasher,
    tokenIssuer: new JwtAccessTokenIssuer(
      keyRing,
      {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      },
      clock,
      ids,
    ),
    opaqueTokens: new CryptoOpaqueTokens(),
    clock,
    ids,
    logger,
    lockout,
    rotation,
    // Computed once per process: costs one real hash, buys equal timing for unknown accounts.
    decoyPasswordHash: await hasher.hash(randomBytes(32).toString('hex')),
  });

  const app = await buildIdentityApp({
    logger,
    useCases,
    keyRing,
    clock,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    cookieSecure: config.COOKIE_SECURE,
    corsOrigins: config.CORS_ORIGINS,
    trustProxy: config.TRUST_PROXY,
    readiness: { database: async () => void (await db.query('SELECT 1')) },
  });

  // Publishes the outbox rows written by the use cases (UserRegistered, TeamMembershipChanged,
  // UserDeleted) to the event bus.
  const relay = startOutboxRelay({
    db,
    logger,
    clock,
    eventBusName: config.EVENT_BUS_NAME,
    region: config.AWS_REGION,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    retentionDays: config.OUTBOX_RETENTION_DAYS,
  });

  await runServer(app, {
    port: config.PORT,
    logger,
    onShutdown: async () => {
      await relay.stop();
      await db.close();
    },
  });
}

main().catch((error: unknown) => {
  // No logger exists yet if configuration failed. ConfigError messages name variables, never values.
  process.stderr.write(
    `identity-service failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
