import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@teampulse/config';
import { DEVELOPMENT_PSEUDONYM_KEY, loadInsightConfig } from '../../src/config/index.js';
import { HmacPseudonymizer } from '../../src/adapters/hmac-pseudonymizer.js';

const dev = {
  AGGREGATES_TABLE_NAME: 'teampulse-insight-aggregates',
  PERSONAL_TABLE_NAME: 'teampulse-insight-personal',
  IDENTITY_JWKS_URL: 'http://identity:3000/api/v1/identity/.well-known/jwks.json',
};

const prod = {
  ...dev,
  NODE_ENV: 'production',
  LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
  INSIGHT_PSEUDONYM_KEY: 'a-production-secret-that-is-long-enough-1234',
  IDENTITY_JWKS_URL: 'https://identity.internal/api/v1/identity/.well-known/jwks.json',
  CORS_ORIGINS: 'https://app.teampulse.example',
  EVENTS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/insight-events',
};

const problems = (env: Record<string, string>) => {
  try {
    loadInsightConfig(env);
    return [];
  } catch (error) {
    return (error as ConfigError).issues.map((issue) => issue.variable);
  }
};

describe('insight configuration', () => {
  it('needs the two tables and the identity key endpoint, and defaults the rest safely', () => {
    expect(loadInsightConfig(dev)).toMatchObject({
      PORT: 3000,
      MIN_COHORT_SIZE: 5,
      RETENTION_DAYS: 400,
      CORS_ORIGINS: [],
    });
  });

  it('fails fast, naming each missing variable', () => {
    expect(problems({})).toEqual(
      expect.arrayContaining(['AGGREGATES_TABLE_NAME', 'PERSONAL_TABLE_NAME', 'IDENTITY_JWKS_URL']),
    );
  });

  it('refuses a minimum group size below 3, which would hide almost nothing', () => {
    expect(problems({ ...dev, MIN_COHORT_SIZE: '2' })).toContain('MIN_COHORT_SIZE');
    expect(problems({ ...dev, MIN_COHORT_SIZE: '1' })).toContain('MIN_COHORT_SIZE');
    expect(problems({ ...dev, MIN_COHORT_SIZE: 'five' })).toContain('MIN_COHORT_SIZE');
    expect(problems({ ...dev, MIN_COHORT_SIZE: '3' })).toEqual([]);
  });

  it('bounds retention', () => {
    expect(problems({ ...dev, RETENTION_DAYS: '7' })).toContain('RETENTION_DAYS');
    expect(problems({ ...dev, RETENTION_DAYS: '99999' })).toContain('RETENTION_DAYS');
  });

  it('only accepts plain table names', () => {
    expect(problems({ ...dev, AGGREGATES_TABLE_NAME: 'a b; drop' })).toContain(
      'AGGREGATES_TABLE_NAME',
    );
  });

  describe('production guard rails', () => {
    it('accepts a properly secured production configuration', () => {
      expect(problems(prod)).toEqual([]);
    });

    it.each([
      ['the development pseudonym key', { INSIGHT_PSEUDONYM_KEY: DEVELOPMENT_PSEUDONYM_KEY }],
      ['a key that is too short', { INSIGHT_PSEUDONYM_KEY: 'short' }],
    ])('rejects %s', (_name, override) => {
      expect(problems({ ...prod, ...override })).toContain('INSIGHT_PSEUDONYM_KEY');
    });

    it.each([
      [
        'key endpoint over plain http',
        { IDENTITY_JWKS_URL: 'http://identity.internal/jwks.json' },
        'IDENTITY_JWKS_URL',
      ],
      ['no CORS origin', { CORS_ORIGINS: '' }, 'CORS_ORIGINS'],
      ['an http CORS origin', { CORS_ORIGINS: 'http://app.example' }, 'CORS_ORIGINS'],
      ['no events queue', { EVENTS_QUEUE_URL: '' }, 'EVENTS_QUEUE_URL'],
      ['no pseudonymisation salt', { LOG_PSEUDONYM_SALT: '' }, 'LOG_PSEUDONYM_SALT'],
    ])('rejects %s', (_name, override, variable) => {
      expect(problems({ ...prod, ...override })).toContain(variable);
    });
  });

  it('never echoes a configuration value in its error', () => {
    try {
      loadInsightConfig({ ...dev, INSIGHT_PSEUDONYM_KEY: 'tooshort-secret', PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('tooshort-secret');
    }
  });
});

describe('HmacPseudonymizer', () => {
  const KEY = 'k'.repeat(40);

  it('is stable, short and hides the user id', () => {
    const p = new HmacPseudonymizer(KEY);
    const token = p.participant('SCOPE#ORG', 'user-1');
    expect(token).toBe(p.participant('SCOPE#ORG', 'user-1'));
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    expect(token).not.toContain('user-1');
  });

  it('gives one person unrelated tokens in different scopes and different people different tokens', () => {
    const p = new HmacPseudonymizer(KEY);
    expect(p.participant('SCOPE#ORG', 'user-1')).not.toBe(p.participant('SCOPE#TEAM#a', 'user-1'));
    expect(p.participant('SCOPE#ORG', 'user-1')).not.toBe(p.participant('SCOPE#ORG', 'user-2'));
  });

  it('depends on the secret key, so ids cannot be tested against stored tokens without it', () => {
    expect(new HmacPseudonymizer(KEY).participant('SCOPE#ORG', 'user-1')).not.toBe(
      new HmacPseudonymizer('z'.repeat(40)).participant('SCOPE#ORG', 'user-1'),
    );
  });

  it('refuses a weak key', () => {
    expect(() => new HmacPseudonymizer('short')).toThrow(RangeError);
  });
});
