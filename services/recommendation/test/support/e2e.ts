import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { migrate } from '@teampulse/db';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { PgliteDatabase } from '@teampulse/testing';
import { BASE_PATH, buildRecommendationApp } from '../../src/adapters/http/app.js';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { createUseCases } from '../../src/application/index.js';

export const NOW = '2026-11-20T08:00:00Z';
export const ISSUER = 'teampulse-identity';
export const AUDIENCE = 'teampulse-api';

/** Deterministic ids for people, habits and events, readable in assertions. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const ALICE = uuid(0xa1);
export const BOB = uuid(0xb1);
export const WALK = uuid(0x51);
export const READ = uuid(0x52);

export interface TokenSpec {
  userId: string;
  role?: 'employee' | 'manager' | 'admin';
  audience?: string;
}

/** Real PostgreSQL (PGlite) and real RS256 tokens verified through a JWKS. Only the clock is fixed. */
export async function createE2E() {
  const db = new PgliteDatabase();
  await migrate(db, MIGRATIONS);

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const clock = new FixedClock(NOW);
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'r-e2e',
    level: 'debug',
    write: (line) => logLines.push(line),
    pseudonymSalt: 'e2e-salt-e2e-salt',
  });
  const useCases = createUseCases({ uow: new PostgresUnitOfWork(db), clock, logger });

  let app: FastifyInstance | undefined;
  // Rate limits are per client address; every test gets a fresh "client" so they cannot affect each other.
  let clientNumber = 0;
  let remoteAddress = '10.0.0.1';

  async function token(spec: TokenSpec): Promise<string> {
    const issuedAt = Math.floor(clock.now().getTime() / 1000);
    return new SignJWT({ role: spec.role ?? 'employee', teams: [], managedTeams: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(spec.userId)
      .setIssuer(ISSUER)
      .setAudience(spec.audience ?? AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(privateKey);
  }

  async function start() {
    app = await buildRecommendationApp({
      logger,
      useCases,
      verifier: createLocalJwksVerifier(
        { keys: [jwk] },
        { issuer: ISSUER, audience: AUDIENCE, clock },
      ),
      readiness: { database: async () => void (await db.query('SELECT 1')) },
    });
    return app;
  }

  async function request(options: {
    method: 'GET' | 'POST';
    path: string;
    token?: string;
    body?: unknown;
  }) {
    if (app === undefined) throw new Error('call start() first');
    return app.inject({
      method: options.method,
      url: `${BASE_PATH}${options.path}`,
      remoteAddress,
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
  }

  /** Stores one completion, as an `ActivityCompleted` event would. */
  async function completed(userId: string, habitId: string, iso: string, eventNumber: number) {
    await useCases.recordActivityTime.execute({
      eventId: uuid(0xe000 + eventNumber),
      userId,
      habitId,
      occurredAt: new Date(iso),
    });
  }

  return {
    db,
    clock,
    logLines,
    useCases,
    token,
    start,
    request,
    completed,
    reset: async () => {
      await db.exec('TRUNCATE activity_times, decisions');
      logLines.length = 0;
      clock.set(NOW);
      clientNumber += 1;
      remoteAddress = `10.0.${Math.floor(clientNumber / 250)}.${(clientNumber % 250) + 1}`;
    },
    stop: async () => {
      await app?.close();
      await db.close();
    },
  };
}

export type E2E = Awaited<ReturnType<typeof createE2E>>;
