import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@teampulse/config';
import { loadRecommendationConfig } from '../../src/config/index.js';

const dev = {
  DATABASE_URL: 'postgres://recommendation:pw@db:5432/teampulse',
  IDENTITY_JWKS_URL: 'http://identity:3000/api/v1/identity/.well-known/jwks.json',
};

const prod = {
  ...dev,
  NODE_ENV: 'production',
  LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
  DATABASE_SSL: 'true',
  IDENTITY_JWKS_URL: 'https://identity.internal/api/v1/identity/.well-known/jwks.json',
  CORS_ORIGINS: 'https://app.teampulse.example',
  EVENTS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/recommendation-events',
};

const problems = (env: Record<string, string>) => {
  try {
    loadRecommendationConfig(env);
    return [];
  } catch (error) {
    return (error as ConfigError).issues.map((issue) => issue.variable);
  }
};

describe('recommendation configuration', () => {
  it('needs a database and the identity key endpoint, and defaults the rest safely', () => {
    expect(loadRecommendationConfig(dev)).toMatchObject({
      PORT: 3000,
      DATABASE_SCHEMA: 'recommendation',
      PURGE_INTERVAL_MINUTES: 360,
      CORS_ORIGINS: [],
    });
  });

  it('fails fast, naming each missing variable', () => {
    expect(problems({})).toEqual(expect.arrayContaining(['DATABASE_URL', 'IDENTITY_JWKS_URL']));
  });

  it('bounds the purge interval, so a typo cannot disable housekeeping or hammer the database', () => {
    expect(problems({ ...dev, PURGE_INTERVAL_MINUTES: '1' })).toContain('PURGE_INTERVAL_MINUTES');
    expect(problems({ ...dev, PURGE_INTERVAL_MINUTES: '99999' })).toContain(
      'PURGE_INTERVAL_MINUTES',
    );
  });

  it('only accepts a simple schema name', () => {
    expect(problems({ ...dev, DATABASE_SCHEMA: 'r; DROP' })).toContain('DATABASE_SCHEMA');
  });

  describe('production guard rails', () => {
    it('accepts a properly secured production configuration (it publishes nothing, so needs no bus)', () => {
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
    ])('rejects %s', (_name, change, variable) => {
      expect(problems({ ...prod, ...change })).toContain(variable);
    });
  });

  it('accepts a proxy count (the services run behind CloudFront and a load balancer)', () => {
    expect(loadRecommendationConfig({ ...dev, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
  });
});
