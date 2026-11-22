import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@teampulse/config';
import { loadHabitConfig } from '../../src/config/index.js';

const dev = {
  DATABASE_URL: 'postgres://habit:pw@db:5432/teampulse',
  IDENTITY_JWKS_URL: 'http://identity:3000/api/v1/identity/.well-known/jwks.json',
};

const prod = {
  ...dev,
  NODE_ENV: 'production',
  LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
  DATABASE_SSL: 'true',
  IDENTITY_JWKS_URL: 'https://identity.internal/api/v1/identity/.well-known/jwks.json',
  CORS_ORIGINS: 'https://app.teampulse.example',
  EVENT_BUS_NAME: 'teampulse-bus',
  EVENTS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/habit-events',
};

const problems = (env: Record<string, string>) => {
  try {
    loadHabitConfig(env);
    return [];
  } catch (error) {
    return (error as ConfigError).issues.map((issue) => issue.variable);
  }
};

describe('habit configuration', () => {
  it('needs a database and the identity key endpoint, and defaults the rest safely', () => {
    expect(loadHabitConfig(dev)).toMatchObject({
      PORT: 3000,
      DATABASE_SCHEMA: 'habit',
      JWT_ISSUER: 'teampulse-identity',
      JWT_AUDIENCE: 'teampulse-api',
      MAX_ACTIVE_HABITS_PER_USER: 50,
      TRUST_PROXY: false,
      CORS_ORIGINS: [],
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_RETENTION_DAYS: 14,
    });
  });

  it('fails fast, naming each missing variable', () => {
    expect(problems({})).toEqual(expect.arrayContaining(['DATABASE_URL', 'IDENTITY_JWKS_URL']));
  });

  it('rejects a malformed key endpoint and an out-of-range habit limit', () => {
    expect(problems({ ...dev, IDENTITY_JWKS_URL: 'not a url' })).toContain('IDENTITY_JWKS_URL');
    expect(problems({ ...dev, MAX_ACTIVE_HABITS_PER_USER: '0' })).toContain(
      'MAX_ACTIVE_HABITS_PER_USER',
    );
    expect(problems({ ...dev, MAX_ACTIVE_HABITS_PER_USER: '100000' })).toContain(
      'MAX_ACTIVE_HABITS_PER_USER',
    );
  });

  it('only accepts a simple schema name', () => {
    expect(problems({ ...dev, DATABASE_SCHEMA: 'habit; DROP' })).toContain('DATABASE_SCHEMA');
  });

  describe('production guard rails', () => {
    it('accepts a properly secured production configuration', () => {
      expect(problems(prod)).toEqual([]);
    });

    it.each([
      ['database without TLS', { DATABASE_SSL: 'false' }, 'DATABASE_SSL'],
      [
        'key endpoint over plain http',
        { IDENTITY_JWKS_URL: 'http://identity.internal/jwks.json' },
        'IDENTITY_JWKS_URL',
      ],
      ['no CORS origin', { CORS_ORIGINS: '' }, 'CORS_ORIGINS'],
      ['an http CORS origin', { CORS_ORIGINS: 'http://app.example' }, 'CORS_ORIGINS'],
      ['no event bus', { EVENT_BUS_NAME: '' }, 'EVENT_BUS_NAME'],
      ['no events queue', { EVENTS_QUEUE_URL: '' }, 'EVENTS_QUEUE_URL'],
      ['no pseudonymisation salt', { LOG_PSEUDONYM_SALT: '' }, 'LOG_PSEUDONYM_SALT'],
    ])('rejects %s', (_name, override, variable) => {
      expect(problems({ ...prod, ...override })).toContain(variable);
    });
  });

  it('never echoes a configuration value in its error', () => {
    try {
      loadHabitConfig({ ...dev, DATABASE_URL: 'postgres://u:supersecret@h/db', PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('supersecret');
    }
  });
});
