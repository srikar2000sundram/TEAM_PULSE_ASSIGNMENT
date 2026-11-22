import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@teampulse/config';
import { loadNotificationConfig } from '../../src/config/index.js';

const dev = {
  DATABASE_URL: 'postgres://notification:pw@db:5432/teampulse',
  IDENTITY_JWKS_URL: 'http://identity:3000/api/v1/identity/.well-known/jwks.json',
};

const prod = {
  ...dev,
  NODE_ENV: 'production',
  LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
  DATABASE_SSL: 'true',
  IDENTITY_JWKS_URL: 'https://identity.internal/api/v1/identity/.well-known/jwks.json',
  CORS_ORIGINS: 'https://app.teampulse.example',
  EVENTS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/notification-events',
};

const problems = (env: Record<string, string>) => {
  try {
    loadNotificationConfig(env);
    return [];
  } catch (error) {
    return (error as ConfigError).issues.map((issue) => issue.variable);
  }
};

describe('notification configuration', () => {
  it('needs a database and the identity key endpoint, and defaults the rest safely', () => {
    expect(loadNotificationConfig(dev)).toMatchObject({
      PORT: 3000,
      DATABASE_SCHEMA: 'notification',
      REMINDER_TICK_SECONDS: 30,
      REMINDER_WINDOW_MINUTES: 15,
      CORS_ORIGINS: [],
    });
  });

  it('fails fast, naming each missing variable', () => {
    expect(problems({})).toEqual(expect.arrayContaining(['DATABASE_URL', 'IDENTITY_JWKS_URL']));
  });

  it('bounds the reminder timing, so a typo cannot disable or flood reminders', () => {
    expect(problems({ ...dev, REMINDER_TICK_SECONDS: '1' })).toContain('REMINDER_TICK_SECONDS');
    expect(problems({ ...dev, REMINDER_TICK_SECONDS: '9999' })).toContain('REMINDER_TICK_SECONDS');
    expect(problems({ ...dev, REMINDER_WINDOW_MINUTES: '0' })).toContain('REMINDER_WINDOW_MINUTES');
    expect(problems({ ...dev, REMINDER_WINDOW_MINUTES: '1000' })).toContain(
      'REMINDER_WINDOW_MINUTES',
    );
  });

  it('only accepts a simple schema name', () => {
    expect(problems({ ...dev, DATABASE_SCHEMA: 'n; DROP' })).toContain('DATABASE_SCHEMA');
  });

  describe('production guard rails', () => {
    it('accepts a properly secured production configuration (it needs no event bus: it publishes nothing)', () => {
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
      ['no events queue', { EVENTS_QUEUE_URL: '' }, 'EVENTS_QUEUE_URL'],
      ['no pseudonymisation salt', { LOG_PSEUDONYM_SALT: '' }, 'LOG_PSEUDONYM_SALT'],
    ])('rejects %s', (_name, override, variable) => {
      expect(problems({ ...prod, ...override })).toContain(variable);
    });
  });

  it('never echoes a configuration value in its error', () => {
    try {
      loadNotificationConfig({
        ...dev,
        DATABASE_URL: 'postgres://u:supersecret@h/db',
        PORT: 'abc',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('supersecret');
    }
  });
});
