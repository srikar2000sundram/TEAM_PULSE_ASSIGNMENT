import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@teampulse/config';
import { loadIdentityConfig } from '../../src/config/index.js';

const KEY = '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----';

const dev = {
  DATABASE_URL: 'postgres://identity:pw@db:5432/teampulse',
  JWT_PRIVATE_KEY_PEM: KEY,
};

const prod = {
  ...dev,
  NODE_ENV: 'production',
  LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
  COOKIE_SECURE: 'true',
  DATABASE_SSL: 'true',
  CORS_ORIGINS: 'https://app.teampulse.example',
  EVENT_BUS_NAME: 'teampulse-bus',
};

const problems = (env: Record<string, string>) => {
  try {
    loadIdentityConfig(env);
    return [];
  } catch (error) {
    return (error as ConfigError).issues.map((issue) => issue.variable);
  }
};

describe('identity configuration', () => {
  it('needs only a database and a signing key, and defaults everything else safely', () => {
    const config = loadIdentityConfig(dev);
    expect(config).toMatchObject({
      PORT: 3000,
      DATABASE_SCHEMA: 'identity',
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_SECONDS: 604_800,
      REFRESH_FAMILY_MAX_AGE_SECONDS: 2_592_000,
      LOCKOUT_MAX_FAILED_ATTEMPTS: 5,
      LOCKOUT_MINUTES: 15,
      COOKIE_SECURE: true, // secure unless explicitly turned off for local development
      TRUST_PROXY: false,
      CORS_ORIGINS: [],
      JWT_PREVIOUS_PUBLIC_KEYS_PEM: [],
    });
  });

  it('restores real newlines in PEM keys passed through environment variables', () => {
    expect(loadIdentityConfig(dev).JWT_PRIVATE_KEY_PEM).toBe(
      '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----',
    );
  });

  it('parses a JSON list of retired public keys and rejects anything else', () => {
    const ok = loadIdentityConfig({
      ...dev,
      JWT_PREVIOUS_PUBLIC_KEYS_PEM: JSON.stringify(['one\\ntwo']),
    });
    expect(ok.JWT_PREVIOUS_PUBLIC_KEYS_PEM).toEqual(['one\ntwo']);
    expect(problems({ ...dev, JWT_PREVIOUS_PUBLIC_KEYS_PEM: 'not json' })).toContain(
      'JWT_PREVIOUS_PUBLIC_KEYS_PEM',
    );
    expect(problems({ ...dev, JWT_PREVIOUS_PUBLIC_KEYS_PEM: '{"a":1}' })).toContain(
      'JWT_PREVIOUS_PUBLIC_KEYS_PEM',
    );
  });

  it('reports missing required values by name', () => {
    expect(problems({})).toEqual(expect.arrayContaining(['DATABASE_URL', 'JWT_PRIVATE_KEY_PEM']));
  });

  it('bounds lifetimes so a typo cannot create an enormous token lifetime', () => {
    expect(problems({ ...dev, ACCESS_TOKEN_TTL_SECONDS: '999999999' })).toContain(
      'ACCESS_TOKEN_TTL_SECONDS',
    );
    expect(problems({ ...dev, ACCESS_TOKEN_TTL_SECONDS: '5' })).toContain(
      'ACCESS_TOKEN_TTL_SECONDS',
    );
    expect(problems({ ...dev, LOCKOUT_MAX_FAILED_ATTEMPTS: '1' })).toContain(
      'LOCKOUT_MAX_FAILED_ATTEMPTS',
    );
  });

  it('only accepts a simple schema name (it is placed into SQL)', () => {
    expect(problems({ ...dev, DATABASE_SCHEMA: 'identity; DROP TABLE users' })).toContain(
      'DATABASE_SCHEMA',
    );
    expect(problems({ ...dev, DATABASE_SCHEMA: 'Identity' })).toContain('DATABASE_SCHEMA');
    expect(problems({ ...dev, DATABASE_SCHEMA: 'identity_v2' })).toEqual([]);
  });

  it('splits CORS origins from a comma-separated list', () => {
    const config = loadIdentityConfig({
      ...dev,
      CORS_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
    });
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  describe('production guard rails', () => {
    it('accepts a correctly hardened production configuration', () => {
      expect(problems(prod)).toEqual([]);
    });

    // Each case describes how to break an otherwise valid production environment.
    const breakers: [string, (env: Record<string, string>) => Record<string, string>, string][] = [
      ['insecure cookies', (env) => ({ ...env, COOKIE_SECURE: 'false' }), 'COOKIE_SECURE'],
      [
        'no event bus, so no events would ever be published',
        ({ EVENT_BUS_NAME: _removed, ...env }) => env,
        'EVENT_BUS_NAME',
      ],
      [
        'a database connection without TLS',
        (env) => ({ ...env, DATABASE_SSL: 'false' }),
        'DATABASE_SSL',
      ],
      ['no allowed web origin', (env) => ({ ...env, CORS_ORIGINS: '' }), 'CORS_ORIGINS'],
      [
        'a plain-http origin',
        (env) => ({ ...env, CORS_ORIGINS: 'http://app.teampulse.example' }),
        'CORS_ORIGINS',
      ],
      [
        'no log pseudonym salt',
        ({ LOG_PSEUDONYM_SALT: _omitted, ...rest }) => rest,
        'LOG_PSEUDONYM_SALT',
      ],
    ];

    it.each(breakers)('refuses to start with %s', (_name, breakIt, variable) => {
      expect(problems(breakIt(prod))).toContain(variable);
    });

    it('refuses a session cap shorter than a single refresh token', () => {
      expect(
        problems({
          ...prod,
          REFRESH_TOKEN_TTL_SECONDS: '1209600',
          REFRESH_FAMILY_MAX_AGE_SECONDS: '86400',
        }),
      ).toContain('REFRESH_FAMILY_MAX_AGE_SECONDS');
    });

    it('allows the same relaxed settings in development', () => {
      expect(problems({ ...dev, COOKIE_SECURE: 'false', DATABASE_SSL: 'false' })).toEqual([]);
    });
  });
});
