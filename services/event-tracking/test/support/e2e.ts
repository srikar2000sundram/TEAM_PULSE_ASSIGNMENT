import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { migrate } from '@teampulse/db';
import { FixedClock, UuidGenerator } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { PgliteDatabase } from '@teampulse/testing';
import { BASE_PATH, buildEventTrackingApp } from '../../src/adapters/http/app.js';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { createUseCases, type UnitOfWork } from '../../src/application/index.js';

export const NOW = '2026-11-20T08:00:00Z';
export const ISSUER = 'teampulse-identity';
export const AUDIENCE = 'teampulse-api';

export interface TokenSpec {
  userId: string;
  role?: 'employee' | 'manager' | 'admin';
  teams?: string[];
  manages?: string[];
  audience?: string;
  expiresInSeconds?: number;
}

/** Real PostgreSQL (PGlite) and real RS256 tokens verified through a JWKS. Only the clock is fixed. */
export async function createE2E(options: { uow?: UnitOfWork } = {}) {
  const db = new PgliteDatabase();
  await migrate(db, MIGRATIONS);

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const clock = new FixedClock(NOW);
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'et-e2e',
    level: 'debug',
    write: (line) => logLines.push(line),
    pseudonymSalt: 'e2e-salt-e2e-salt',
  });

  const useCases = createUseCases({
    uow: options.uow ?? new PostgresUnitOfWork(db),
    clock,
    ids: new UuidGenerator(),
    logger,
    datePolicy: { backfillDays: 7 },
  });

  let app: FastifyInstance | undefined;
  // Rate limits are per client address; every test gets a fresh "client" so they cannot affect each other.
  let clientNumber = 0;
  let remoteAddress = '10.0.0.1';
  const bodies: string[] = [];

  async function token(spec: TokenSpec): Promise<string> {
    const issuedAt = Math.floor(clock.now().getTime() / 1000);
    return new SignJWT({
      role: spec.role ?? 'employee',
      teams: spec.teams ?? [],
      managedTeams: spec.manages ?? [],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(spec.userId)
      .setIssuer(ISSUER)
      .setAudience(spec.audience ?? AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (spec.expiresInSeconds ?? 900))
      .sign(privateKey);
  }

  async function start(overrides: { defaultRateLimitPerMinute?: number } = {}) {
    app = await buildEventTrackingApp({
      logger,
      useCases,
      verifier: createLocalJwksVerifier(
        { keys: [jwk] },
        { issuer: ISSUER, audience: AUDIENCE, clock },
      ),
      readiness: { database: async () => void (await db.query('SELECT 1')) },
      ...(overrides.defaultRateLimitPerMinute === undefined
        ? {}
        : { defaultRateLimitPerMinute: overrides.defaultRateLimitPerMinute }),
    });
    return app;
  }

  async function request(options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) {
    if (app === undefined) throw new Error('call start() first');
    const response = await app.inject({
      method: options.method,
      url: `${BASE_PATH}${options.path}`,
      remoteAddress,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
    bodies.push(response.body);
    return response;
  }

  return {
    db,
    clock,
    logLines,
    bodies,
    useCases,
    token,
    start,
    request,
    readOutbox: async () =>
      (
        await db.query<{ payload: { eventType: string; payload: Record<string, unknown> } }>(
          'SELECT payload FROM outbox ORDER BY created_at, id',
        )
      ).rows.map((row) => row.payload),
    reset: async () => {
      await db.exec('TRUNCATE activities, known_habits, outbox');
      logLines.length = 0;
      bodies.length = 0;
      clock.set(NOW);
      clientNumber += 1;
      remoteAddress = `10.0.${Math.floor(clientNumber / 250)}.${(clientNumber % 250) + 1}`;
    },
    probe: (url: string) => {
      if (app === undefined) throw new Error('call start() first');
      return app.inject({ method: 'GET', url });
    },
    stop: async () => {
      await app?.close();
      await db.close();
    },
  };
}

export type E2E = Awaited<ReturnType<typeof createE2E>>;
