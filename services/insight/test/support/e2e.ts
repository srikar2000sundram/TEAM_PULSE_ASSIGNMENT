import type { FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createLocalJwksVerifier } from '@teampulse/auth/jwt';
import { FixedClock } from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { HmacPseudonymizer } from '../../src/adapters/hmac-pseudonymizer.js';
import { BASE_PATH, buildInsightApp } from '../../src/adapters/http/app.js';
import { createUseCases } from '../../src/application/index.js';
import { InMemoryAnalyticsStore } from './in-memory.js';
import { KEY } from './harness.js';

export const NOW = '2026-11-20T08:00:00Z';
export const ISSUER = 'teampulse-identity';
export const AUDIENCE = 'teampulse-api';

export interface TokenSpec {
  userId: string;
  role?: 'employee' | 'manager' | 'admin';
  teams?: string[];
  manages?: string[];
  expiresInSeconds?: number;
}

/** Real RS256 tokens verified through a JWKS, the real HTTP layer, an in-memory store. */
export async function createE2E(options: { store?: InMemoryAnalyticsStore } = {}) {
  const store = options.store ?? new InMemoryAnalyticsStore();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const clock = new FixedClock(NOW);
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'i-e2e',
    level: 'debug',
    write: (line) => logLines.push(line),
    pseudonymSalt: 'e2e-salt-e2e-salt',
  });
  const useCases = createUseCases({
    store,
    pseudonyms: new HmacPseudonymizer(KEY),
    clock,
    logger,
    minCohortSize: 5,
    retentionDays: 400,
  });

  let app: FastifyInstance | undefined;
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
      .setAudience(AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (spec.expiresInSeconds ?? 900))
      .sign(privateKey);
  }

  async function start() {
    app = await buildInsightApp({
      logger,
      useCases,
      verifier: createLocalJwksVerifier(
        { keys: [jwk] },
        { issuer: ISSUER, audience: AUDIENCE, clock },
      ),
      readiness: { database: () => store.ping() },
    });
    return app;
  }

  async function request(options: { path: string; token?: string }) {
    if (app === undefined) throw new Error('call start() first');
    const response = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}${options.path}`,
      remoteAddress,
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
    });
    bodies.push(response.body);
    return response;
  }

  return {
    store,
    useCases,
    logLines,
    bodies,
    token,
    start,
    request,
    reset: () => {
      store.clear();
      logLines.length = 0;
      bodies.length = 0;
      clientNumber += 1;
      remoteAddress = `10.0.${Math.floor(clientNumber / 250)}.${(clientNumber % 250) + 1}`;
    },
    probe: (url: string) => {
      if (app === undefined) throw new Error('call start() first');
      return app.inject({ method: 'GET', url });
    },
    stop: async () => {
      await app?.close();
    },
  };
}

export type E2E = Awaited<ReturnType<typeof createE2E>>;
