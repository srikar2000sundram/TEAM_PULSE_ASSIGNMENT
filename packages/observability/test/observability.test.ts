import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  createLogger,
  createRedactor,
  getCorrelationId,
  pseudonymize,
  runWithCorrelationId,
  type LoggerOptions,
} from '../src/index.js';

function setup(options: Partial<LoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'habit-service',
    write: (line) => lines.push(line),
    now: () => new Date('2026-11-20T08:15:00Z'),
    ...options,
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('logger output', () => {
  it('writes one JSON line with level, time, service and message', () => {
    const { logger, records } = setup();
    logger.info({ habitId: 'h-1' }, 'habit created');
    expect(records()).toEqual([
      {
        habitId: 'h-1',
        level: 'info',
        time: '2026-11-20T08:15:00.000Z',
        service: 'habit-service',
        msg: 'habit created',
      },
    ]);
  });

  it('accepts a bare message', () => {
    const { logger, records } = setup();
    logger.warn('disk almost full');
    expect(records()[0]).toMatchObject({ level: 'warn', msg: 'disk almost full' });
  });

  it('filters below the configured level and supports silent', () => {
    const quiet = setup({ level: 'warn' });
    quiet.logger.info('ignored');
    quiet.logger.error('kept');
    expect(quiet.records().map((r) => r.msg)).toEqual(['kept']);

    const silent = setup({ level: 'silent' });
    silent.logger.fatal('even this is dropped');
    expect(silent.lines).toHaveLength(0);
  });

  it('child loggers carry bindings and do not affect the parent', () => {
    const { logger, records } = setup();
    const child = logger.child({ component: 'outbox-relay' });
    child.info('tick');
    logger.info('plain');
    expect(records()[0]).toMatchObject({ component: 'outbox-relay', msg: 'tick' });
    expect(records()[1]).not.toHaveProperty('component');
  });

  it('does not let callers overwrite reserved fields', () => {
    const { logger, records } = setup();
    logger.info({ level: 'fatal', service: 'evil', time: 'never' }, 'x');
    expect(records()[0]).toMatchObject({
      level: 'info',
      service: 'habit-service',
      time: '2026-11-20T08:15:00.000Z',
    });
  });

  it('serialises Error objects with type, message and stack', () => {
    const { logger, records } = setup();
    logger.error({ err: new TypeError('bad input') }, 'failed');
    const err = records()[0]?.err as Record<string, unknown>;
    expect(err).toMatchObject({ type: 'TypeError', message: 'bad input' });
    expect(typeof err.stack).toBe('string');
  });

  it('never throws, even when a field cannot be serialised', () => {
    const { logger, records } = setup();
    expect(() => logger.info({ big: 10n }, 'bigint')).not.toThrow();
    expect(records()[0]).toMatchObject({ msg: 'log serialisation failed' });
  });
});

describe('correlation id', () => {
  it('is attached automatically inside a correlation scope, across async boundaries', async () => {
    const { logger, records } = setup();
    await runWithCorrelationId('corr-1', async () => {
      await Promise.resolve();
      logger.info('inside');
      expect(getCorrelationId()).toBe('corr-1');
    });
    logger.info('outside');
    expect(records()[0]).toMatchObject({ correlationId: 'corr-1' });
    expect(records()[1]).not.toHaveProperty('correlationId');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('keeps concurrent scopes isolated', async () => {
    const { logger, records } = setup();
    await Promise.all([
      runWithCorrelationId('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info('from a');
      }),
      runWithCorrelationId('b', () => {
        logger.info('from b');
        return Promise.resolve();
      }),
    ]);
    const byMessage = Object.fromEntries(records().map((r) => [r.msg, r.correlationId]));
    expect(byMessage).toEqual({ 'from a': 'a', 'from b': 'b' });
  });
});

describe('redaction (privacy)', () => {
  it('redacts credentials and wellness content, including nested and differently cased keys', () => {
    const { logger, records } = setup();
    logger.info(
      {
        password: 'hunter2',
        headers: { Authorization: 'Bearer abc', 'set-cookie': 'sid=1' },
        habit: { habit_title: 'Therapy', notes: 'felt anxious', activityType: 'walking' },
        list: [{ refreshToken: 'r' }],
      },
      'request',
    );
    expect(records()[0]).toMatchObject({
      password: REDACTED,
      headers: { Authorization: REDACTED, 'set-cookie': REDACTED },
      habit: { habit_title: REDACTED, notes: REDACTED, activityType: 'walking' },
      list: [{ refreshToken: REDACTED }],
    });
  });

  it('never leaks a secret value into the serialised line', () => {
    const { logger, lines } = setup();
    logger.info({ password: 'hunter2', email: 'alice@example.com' }, 'login');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('alice@example.com');
  });

  it('redacts user ids by default', () => {
    const { logger, records } = setup();
    logger.info({ userId: 'user-123', ownerUserId: 'user-456', actorUserId: 'user-789' }, 'x');
    expect(records()[0]).toMatchObject({
      userId: REDACTED,
      ownerUserId: REDACTED,
      actorUserId: REDACTED,
    });
  });

  it('pseudonymises user ids when a salt is configured: stable, non-reversible, salt-dependent', () => {
    const { logger, records } = setup({ pseudonymSalt: 'salt-a' });
    logger.info({ userId: 'user-123' }, 'one');
    logger.info({ userId: 'user-123' }, 'two');
    const [one, two] = records();
    expect(one?.userId).toBe(two?.userId);
    expect(one?.userId).not.toContain('user-123');
    expect(one?.userId).toBe(pseudonymize('user-123', 'salt-a'));
    expect(pseudonymize('user-123', 'salt-b')).not.toBe(pseudonymize('user-123', 'salt-a'));
  });

  it('supports extra sensitive keys', () => {
    const { logger, records } = setup({ extraSensitiveKeys: ['employeeNumber'] });
    logger.info({ employee_number: 'E-77' }, 'x');
    expect(records()[0]).toMatchObject({ employee_number: REDACTED });
  });

  it('survives circular references and very deep objects', () => {
    const redact = createRedactor();
    const loop: Record<string, unknown> = { name: 'a' };
    loop.self = loop;
    expect(redact(loop)).toEqual({ name: 'a', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]');
  });

  it('does not mutate the caller object', () => {
    const input = { password: 'p', nested: { token: 't' } };
    createRedactor()(input);
    expect(input).toEqual({ password: 'p', nested: { token: 't' } });
  });
});
