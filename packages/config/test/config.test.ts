import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  baseConfigSchema,
  csv,
  loadConfig,
  loadServiceConfig,
  trustedProxies,
  z,
} from '../src/index.js';

describe('trustedProxies', () => {
  const parse = (value?: string) => trustedProxies.safeParse(value);
  it('is off by default and for false or 0', () => {
    expect(parse(undefined).data).toBe(false);
    expect(parse('false').data).toBe(false);
    expect(parse('0').data).toBe(false);
  });
  it('treats true as one proxy and accepts a count from 1 to 3', () => {
    expect(parse('true').data).toBe(1);
    expect(parse('2').data).toBe(2);
    expect(parse('3').data).toBe(3);
  });
  it('rejects anything else, so a typo cannot widen trust', () => {
    for (const bad of ['4', '-1', '1.5', 'yes', 'all']) expect(parse(bad).success, bad).toBe(false);
  });
});

describe('loadConfig', () => {
  it('applies defaults and coerces numbers', () => {
    const config = loadConfig(baseConfigSchema, { PORT: '8080' });
    expect(config).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info', PORT: 8080 });
  });

  it('returns an immutable object', () => {
    const config = loadConfig(baseConfigSchema, {});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reports every problem at once, naming variables', () => {
    const schema = baseConfigSchema.extend({ DATABASE_URL: z.url() });
    try {
      loadConfig(schema, { PORT: 'abc', LOG_LEVEL: 'loud' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const variables = (error as ConfigError).issues.map((issue) => issue.variable);
      expect(variables).toEqual(expect.arrayContaining(['PORT', 'LOG_LEVEL', 'DATABASE_URL']));
    }
  });

  it('never echoes a rejected value, so a mistyped secret cannot reach the logs', () => {
    const schema = z.object({ API_KEY: z.string().min(40) });
    try {
      loadConfig(schema, { API_KEY: 'super-secret-but-too-short' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('API_KEY');
      expect((error as Error).message).not.toContain('super-secret-but-too-short');
    }
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig(baseConfigSchema, { PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig(baseConfigSchema, { PORT: '0' })).toThrow(ConfigError);
  });
});

describe('loadServiceConfig', () => {
  it('requires the log pseudonym salt in production', () => {
    expect(() => loadServiceConfig(baseConfigSchema, { NODE_ENV: 'production' })).toThrow(
      /LOG_PSEUDONYM_SALT/,
    );
  });

  it('accepts production with a sufficiently long salt', () => {
    const config = loadServiceConfig(baseConfigSchema, {
      NODE_ENV: 'production',
      LOG_PSEUDONYM_SALT: 'a-sufficiently-long-salt',
    });
    expect(config.NODE_ENV).toBe('production');
  });

  it('does not demand a salt in development', () => {
    expect(() => loadServiceConfig(baseConfigSchema, {})).not.toThrow();
  });
});

describe('csv helper', () => {
  it('splits, trims and drops empty entries', () => {
    expect(csv.parse(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(csv.parse('')).toEqual([]);
  });
});
