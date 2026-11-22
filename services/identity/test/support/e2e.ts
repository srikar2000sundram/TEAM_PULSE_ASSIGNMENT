import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { migrate } from '@teampulse/db';
import { PgliteDatabase } from '@teampulse/testing';
import { FixedClock, UuidGenerator, unwrap } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { BASE_PATH, buildIdentityApp } from '../../src/adapters/http/app.js';
import { MIGRATIONS } from '../../src/adapters/persistence/migrations.js';
import { PostgresUnitOfWork } from '../../src/adapters/persistence/repositories.js';
import { Argon2PasswordHasher } from '../../src/adapters/security/argon2-password-hasher.js';
import {
  JwtAccessTokenIssuer,
  KeyRing,
} from '../../src/adapters/security/jwt-access-token-issuer.js';
import { CryptoOpaqueTokens } from '../../src/adapters/security/opaque-tokens.js';
import { createUseCases } from '../../src/application/index.js';
import { DEFAULT_ROTATION_POLICY } from '../../src/domain/refresh-token.js';
import { DEFAULT_LOCKOUT_POLICY } from '../../src/domain/user.js';

export const NOW = '2026-11-20T08:00:00Z';
export const ISSUER = 'teampulse-identity';
export const AUDIENCE = 'teampulse-api';
export const ADMIN_PASSWORD = 'quartz-lantern-meadow-7';
export const CLIENT_HEADERS = { 'x-requested-with': 'teampulse-web' } as const;

/** Real PostgreSQL, real Argon2 (cheap cost), real RS256 keys. Only the clock is fixed. */
export async function createE2E() {
  const db = new PgliteDatabase();
  await migrate(db, MIGRATIONS);

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyRing = await KeyRing.fromPem({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  });

  const clock = new FixedClock(NOW);
  const ids = new UuidGenerator();
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'identity-e2e',
    level: 'debug',
    write: (line) => logLines.push(line),
    pseudonymSalt: 'e2e-salt-e2e-salt',
  });
  const hasher = new Argon2PasswordHasher({ memoryCostKiB: 64, timeCost: 1, parallelism: 1 });
  const uow = new PostgresUnitOfWork(db);

  const useCases = createUseCases({
    uow,
    hasher,
    tokenIssuer: new JwtAccessTokenIssuer(
      keyRing,
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900 },
      clock,
      ids,
    ),
    opaqueTokens: new CryptoOpaqueTokens(),
    clock,
    ids,
    logger,
    lockout: DEFAULT_LOCKOUT_POLICY,
    rotation: DEFAULT_ROTATION_POLICY,
    decoyPasswordHash: await hasher.hash('decoy-password-for-timing'),
  });

  let app: FastifyInstance | undefined;
  const bodies: string[] = [];

  async function start(
    overrides: {
      cookieSecure?: boolean;
      defaultRateLimitPerMinute?: number;
      corsOrigins?: string[];
    } = {},
  ) {
    app = await buildIdentityApp({
      logger,
      useCases,
      keyRing,
      clock,
      issuer: ISSUER,
      audience: AUDIENCE,
      cookieSecure: overrides.cookieSecure ?? true,
      readiness: { database: async () => void (await db.query('SELECT 1')) },
      ...(overrides.corsOrigins === undefined ? {} : { corsOrigins: overrides.corsOrigins }),
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
    refreshCookie?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }) {
    if (app === undefined) throw new Error('call start() first');
    const response = await app.inject({
      method: options.method,
      url: `${BASE_PATH}${options.path}`,
      ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.refreshCookie === undefined
          ? {}
          : { cookie: `tp_refresh=${options.refreshCookie}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
    bodies.push(response.body);
    return response;
  }

  async function login(email: string, password: string, remoteAddress?: string) {
    const response = await request({
      method: 'POST',
      path: '/auth/login',
      body: { email, password },
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });
    const refreshCookie = response.cookies.find((c) => c.name === 'tp_refresh');
    return {
      response,
      status: response.statusCode,
      body: response.json<{ accessToken?: string; user?: { id: string; role: string } }>(),
      accessToken:
        response.statusCode === 200
          ? response.json<{ accessToken: string }>().accessToken
          : undefined,
      refreshCookie: refreshCookie?.value,
    };
  }

  /** Creates the first admin directly, then signs in over HTTP. */
  async function adminSession() {
    unwrap(
      await useCases.bootstrapAdmin.execute({
        email: 'admin@example.com',
        displayName: 'Root Admin',
        password: ADMIN_PASSWORD,
      }),
    );
    const session = await login('admin@example.com', ADMIN_PASSWORD);
    if (session.accessToken === undefined) throw new Error('admin login failed');
    return { token: session.accessToken, userId: session.body.user!.id };
  }

  async function createUser(
    adminToken: string,
    user: {
      email: string;
      displayName: string;
      role: 'employee' | 'manager' | 'admin';
      password: string;
    },
  ) {
    const response = await request({
      method: 'POST',
      path: '/users',
      token: adminToken,
      body: user,
    });
    if (response.statusCode !== 201) throw new Error(`createUser failed: ${response.body}`);
    return response.json<{ id: string }>().id;
  }

  const verifier = () =>
    createLocalJwksVerifier(keyRing.jwks(), { issuer: ISSUER, audience: AUDIENCE, clock });

  return {
    db,
    clock,
    logLines,
    bodies,
    keyRing,
    useCases,
    start,
    request,
    login,
    adminSession,
    createUser,
    verifier,
    reset: async () => {
      await db.exec('TRUNCATE users, teams, team_members, refresh_tokens, outbox CASCADE');
      logLines.length = 0;
      bodies.length = 0;
      clock.set(NOW);
    },
    stop: async () => {
      await app?.close();
      await db.close();
    },
    close: async () => {
      await app?.close();
      app = undefined;
    },
  };
}

export type E2E = Awaited<ReturnType<typeof createE2E>>;
