import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AccessTokenVerifier } from '@teampulse/auth';
import {
  SequentialIdGenerator,
  err,
  forbiddenError,
  ok,
  rateLimitedError,
  unauthorizedError,
} from '@teampulse/kernel';
import { createLogger } from '@teampulse/observability';
import { createServer, defineRoute, registerRoutes } from '../../packages/http/src/index.js';
import { LAMBDA_QUEUES, SERVICE_QUEUES, TABLES, allQueues, dlqName } from '../local/topology.mjs';
import { extractValue, matches, parseFilter } from '../observability/log-filter.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw: unknown = JSON.parse(
  readFileSync(join(root, 'infra', 'observability', 'monitoring.json'), 'utf8'),
);

const PLACEHOLDERS = [
  'service',
  'queue',
  'lambda',
  'table',
  'cluster',
  'loadBalancer',
  'database',
] as const;
/** Placeholders the infrastructure code fills in with the names it creates. */
const INFRASTRUCTURE = new Set(['cluster', 'loadBalancer', 'database']);

const logMetric = z.strictObject({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]+$/),
  unit: z.enum(['Count', 'Milliseconds']),
  pattern: z.string(),
  value: z.string(),
  appliesTo: z.union([z.literal('services'), z.literal('lambdas'), z.array(z.string()).min(1)]),
});

const alarm = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  severity: z.enum(['page', 'ticket']),
  title: z.string().min(10),
  type: z.enum(['metric', 'ratio', 'aws']),
  metric: z.string().optional(),
  numerator: z.string().optional(),
  denominator: z.string().optional(),
  namespace: z.string().optional(),
  statistic: z.enum(['Sum', 'Average', 'Maximum', 'Minimum', 'p95']).optional(),
  dimensions: z.record(z.string(), z.string()),
  period: z
    .number()
    .int()
    .refine((value) => value % 60 === 0),
  evaluationPeriods: z.number().int().min(1),
  datapointsToAlarm: z.number().int().min(1),
  threshold: z.number(),
  comparison: z.enum(['GreaterThanThreshold', 'LessThanThreshold']),
  treatMissingData: z.enum(['notBreaching', 'breaching']),
  expand: z.enum(['services', 'lambdas', 'deadLetterQueues', 'tables', 'none']),
  action: z.string().min(20),
});

const widget = z.strictObject({
  title: z.string(),
  metric: z.string(),
  namespace: z.string().optional(),
  statistic: z.string(),
  per: z.enum(['service', 'lambda', 'deadLetterQueue', 'identity', 'database']),
});

const monitoringSchema = z.strictObject({
  $comment: z.string(),
  namespace: z.literal('TeamPulse'),
  services: z.array(z.string()).min(1),
  lambdas: z.array(z.string()).min(1),
  logMetrics: z.array(logMetric).min(1),
  alarms: z.array(alarm).min(1),
  dashboard: z.strictObject({
    title: z.string(),
    rows: z.array(z.strictObject({ title: z.string(), widgets: z.array(widget).min(1) })),
  }),
});

const monitoring = monitoringSchema.parse(raw);
const metricNames = new Set(monitoring.logMetrics.map((metric) => metric.name));

describe('monitoring.json', () => {
  it('lists exactly the services and Lambda functions the platform has', () => {
    expect([...monitoring.services].sort()).toEqual(
      ['identity', ...Object.keys(SERVICE_QUEUES)].sort(),
    );
    expect([...monitoring.lambdas].sort()).toEqual(Object.keys(LAMBDA_QUEUES).sort());
  });

  it('has unique metric names and alarm ids', () => {
    expect(metricNames.size).toBe(monitoring.logMetrics.length);
    const ids = monitoring.alarms.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only filters services and Lambdas that exist', () => {
    for (const metric of monitoring.logMetrics) {
      if (Array.isArray(metric.appliesTo)) {
        for (const name of metric.appliesTo) expect(monitoring.services).toContain(name);
      }
    }
  });
});

describe('alarms', () => {
  it('refer only to metrics that are defined, or that AWS provides', () => {
    for (const a of monitoring.alarms) {
      if (a.type === 'aws') {
        expect(a.namespace, a.id).toMatch(/^AWS\//);
        expect(a.metric, a.id).toBeTruthy();
      } else if (a.type === 'ratio') {
        expect(metricNames, a.id).toContain(a.numerator);
        expect(metricNames, a.id).toContain(a.denominator);
      } else {
        expect(metricNames, a.id).toContain(a.metric);
      }
    }
  });

  it('never ask for more breaching points than there are points', () => {
    for (const a of monitoring.alarms) {
      expect(a.datapointsToAlarm, a.id).toBeLessThanOrEqual(a.evaluationPeriods);
    }
  });

  it('use only placeholders that their expansion (or the infrastructure) fills in', () => {
    const provided: Record<string, string | undefined> = {
      services: 'service',
      lambdas: 'lambda',
      deadLetterQueues: 'queue',
      tables: 'table',
      none: undefined,
    };
    for (const a of monitoring.alarms) {
      const text = JSON.stringify([a.title, a.dimensions]);
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
        expect(PLACEHOLDERS, `${a.id}: {${name}}`).toContain(name);
        if (!INFRASTRUCTURE.has(name!)) {
          expect(provided[a.expand], `${a.id} uses {${name}}`).toBe(name);
        }
      }
      if (a.expand !== 'none') {
        expect(text, `${a.id} says it expands but has no placeholder`).toContain(
          `{${provided[a.expand]}}`,
        );
      }
    }
  });

  it('put a custom metric on a dimension its filter really has', () => {
    for (const a of monitoring.alarms.filter((x) => x.type !== 'aws')) {
      const names = a.type === 'ratio' ? [a.numerator!, a.denominator!] : [a.metric!];
      for (const name of names) {
        const definition = monitoring.logMetrics.find((metric) => metric.name === name)!;
        expect(Object.keys(a.dimensions), a.id).toEqual(['Service']);
        const service = a.dimensions['Service']!;
        if (Array.isArray(definition.appliesTo)) {
          expect(definition.appliesTo, `${a.id}: ${name}`).toContain(service);
        } else if (service !== '{service}') {
          expect(definition.appliesTo === 'services', `${a.id}: ${name}`).toBe(true);
          expect(monitoring.services).toContain(service);
        }
      }
    }
  });

  it('alarm on dead-letter queues, which the event topology names', () => {
    const dlqs = allQueues().map((queue) => dlqName(queue.name));
    expect(dlqs.length).toBeGreaterThan(0);
    for (const name of dlqs) expect(name).toMatch(/^teampulse-[a-z-]+-dlq$/);
    const alarmed = monitoring.alarms.find((a) => a.id === 'dead-letter-queue-not-empty');
    expect(alarmed?.expand).toBe('deadLetterQueues');
  });

  it('alarm on every DynamoDB table the platform creates', () => {
    const alarmed = monitoring.alarms.find((a) => a.id === 'dynamodb-throttling');
    expect(alarmed?.expand).toBe('tables');
    expect(Object.values(TABLES).length).toBeGreaterThan(0);
  });

  it('has an action for the person who is woken up', () => {
    for (const a of monitoring.alarms) expect(a.action.length, a.id).toBeGreaterThan(20);
  });
});

describe('dashboard', () => {
  it('shows only metrics that exist', () => {
    for (const row of monitoring.dashboard.rows) {
      for (const w of row.widgets) {
        if (w.namespace === undefined) expect(metricNames, w.title).toContain(w.metric);
        else expect(w.namespace, w.title).toMatch(/^AWS\//);
      }
    }
  });
});

/* ---------------------- the filters against what the code really logs ---------------------- */

const verifier: AccessTokenVerifier = {
  verify: () => Promise.resolve(err(unauthorizedError('auth.invalid_token', 'bad'))),
};

const apps: { close: () => Promise<undefined> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Runs requests through the real HTTP server and returns the log lines it wrote. */
async function requestLines(): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    level: 'info',
    write: (line) => lines.push(line),
    pseudonymSalt: 'salt-salt-salt-salt',
  });
  const app = await createServer({
    serviceName: 'test-service',
    logger,
    idGenerator: new SequentialIdGenerator(),
  });
  const empty = z.strictObject({});
  const route = (path: string, result: () => ReturnType<typeof ok<object>> | never) =>
    defineRoute({
      method: 'GET',
      path,
      summary: path,
      auth: 'public',
      success: { status: 200, schema: empty },
      handler: () => Promise.resolve(result() as never),
    });
  registerRoutes(
    app,
    [
      route('/fine', () => ok({})),
      route('/no-token', () => err(unauthorizedError('auth.missing_token', 'x')) as never),
      route('/not-allowed', () => err(forbiddenError('auth.forbidden', 'x')) as never),
      route('/too-many', () => err(rateLimitedError('rate.limited', 'x')) as never),
      route('/broken', () => {
        throw new Error('boom');
      }),
    ],
    { verifier, basePath: '/api/v1/test' },
  );
  apps.push(app as never);
  for (const path of ['/fine', '/no-token', '/not-allowed', '/too-many', '/broken', '/unknown']) {
    await app.inject({ method: 'GET', url: `/api/v1/test${path}` });
  }
  await app.inject({ method: 'GET', url: '/healthz' });
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['msg'] === 'request completed');
}

describe('request metric filters match what the HTTP server logs', () => {
  const statuses = (lines: Record<string, unknown>[], name: string) => {
    const metric = monitoring.logMetrics.find((m) => m.name === name)!;
    return lines.filter((line) => matches(metric.pattern, line)).map((line) => line['status']);
  };

  it('counts every request, once, and not the health checks', async () => {
    const lines = await requestLines();
    expect(statuses(lines, 'Requests').sort()).toEqual([200, 401, 403, 404, 429, 500]);
  });

  it('counts only 5xx as server errors', async () => {
    expect(statuses(await requestLines(), 'ServerErrors')).toEqual([500]);
  });

  it('counts 401, 403 and 429 separately', async () => {
    const lines = await requestLines();
    expect(statuses(lines, 'Unauthorized')).toEqual([401]);
    expect(statuses(lines, 'Forbidden')).toEqual([403]);
    expect(statuses(lines, 'RateLimited')).toEqual([429]);
  });

  it('extracts a number for the latency of every request', async () => {
    const latency = monitoring.logMetrics.find((m) => m.name === 'Latency')!;
    for (const line of await requestLines()) {
      expect(typeof extractValue(latency.value, line), JSON.stringify(line)).toBe('number');
    }
  });
});

describe('event metric filters match events the code really logs', () => {
  const sources: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'test', 'build'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        sources.push(readFileSync(path, 'utf8'));
      }
    }
  };
  for (const parent of ['packages', 'services', 'lambdas']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(root, parent, entry.name, 'src'));
    }
  }
  const code = sources.join('\n');

  const eventMetrics = monitoring.logMetrics.filter((m) => m.pattern.includes('$.event'));

  it('covers the failure signals', () => {
    expect(eventMetrics.map((m) => m.name)).toEqual(
      expect.arrayContaining([
        'EventHandlerFailures',
        'OutboxPublishFailures',
        'LoginFailures',
        'RefreshTokenReuse',
      ]),
    );
  });

  for (const metric of eventMetrics) {
    it(`${metric.name}: every event name in the filter is logged by the code`, () => {
      const names = [...metric.pattern.matchAll(/\$\.event = "([^"]+)"/g)].map((m) => m[1]!);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(code, `no \`event: '${name}'\` in the sources`).toContain(`event: '${name}'`);
        expect(matches(metric.pattern, { service: 'x-service', event: name })).toBe(true);
      }
      expect(matches(metric.pattern, { event: 'something.else' })).toBe(false);
      expect(matches(metric.pattern, { msg: 'request completed', status: 200 })).toBe(false);
    });
  }
});

describe('the filter evaluator', () => {
  it('compares numbers and strings, and treats a missing field as no match', () => {
    expect(matches('{ $.status >= 500 }', { status: 503 })).toBe(true);
    expect(matches('{ $.status >= 500 }', { status: 499 })).toBe(false);
    expect(matches('{ $.status >= 500 }', {})).toBe(false);
    expect(matches('{ $.msg = "a b" }', { msg: 'a b' })).toBe(true);
    expect(matches('{ $.msg = "a b" }', { msg: 'a' })).toBe(false);
  });

  it('lets && bind tighter than ||', () => {
    const pattern = '{ $.a = "x" && $.b = 1 || $.c = "y" }';
    expect(matches(pattern, { a: 'x', b: 1 })).toBe(true);
    expect(matches(pattern, { a: 'x', b: 2 })).toBe(false);
    expect(matches(pattern, { c: 'y' })).toBe(true);
  });

  it('refuses syntax it cannot evaluate rather than guessing', () => {
    expect(() => parseFilter('{ ($.a = 1) }')).toThrow();
    expect(() => parseFilter('$.a = 1')).toThrow();
    expect(() => parseFilter('{ $.a ~ 1 }')).toThrow();
  });
});
