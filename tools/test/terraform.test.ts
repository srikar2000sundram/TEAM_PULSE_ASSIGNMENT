import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadChallengeConfig } from '../../services/challenge/src/config/index.js';
import { loadEventTrackingConfig } from '../../services/event-tracking/src/config/index.js';
import { loadHabitConfig } from '../../services/habit/src/config/index.js';
import { loadIdentityConfig } from '../../services/identity/src/config/index.js';
import { loadInsightConfig } from '../../services/insight/src/config/index.js';
import { loadNotificationConfig } from '../../services/notification/src/config/index.js';
import { loadRecommendationConfig } from '../../services/recommendation/src/config/index.js';
import { LAMBDA_QUEUES, SERVICE_QUEUES, TABLES } from '../local/topology.mjs';

/*
 * Terraform is not run by the test suite (it needs AWS and a binary), so these tests read the .tf files
 * as text and check the facts that must agree with the rest of the repository: the event routing, the
 * names the services log under, the Content-Security-Policy, and the settings the services need to start
 * in production. A mismatch here is the kind of mistake that only shows up as a failed deployment.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tfDir = join(root, 'infra', 'terraform');
const tf = (name: string) => readFileSync(join(tfDir, name), 'utf8');
const allTf = readdirSync(tfDir)
  .filter((file) => file.endsWith('.tf'))
  .map((file) => tf(file))
  .join('\n');

/** The list `name = ["A", "B"]` from a block in the text. */
const listsIn = (text: string, names: string[]): Record<string, string[]> =>
  Object.fromEntries(
    names.map((name) => {
      const match = new RegExp(
        `^\\s*${name.replace('-', '\\-')}\\s*=\\s*\\[([^\\]]*)\\]`,
        'm',
      ).exec(text);
      return [name, [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '')];
    }),
  );

describe('event routing', () => {
  const locals = tf('locals.tf');
  const block = /service_events = \{([\s\S]*?)\n  \}/.exec(locals)?.[1] ?? '';

  it('routes each event to the same services as the local stack does', () => {
    expect(listsIn(block, Object.keys(SERVICE_QUEUES))).toEqual(SERVICE_QUEUES);
  });

  it('has no consumer the local stack lacks', () => {
    const names = [...block.matchAll(/^\s*([a-z-]+)\s*=\s*\[/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(SERVICE_QUEUES).sort());
  });

  it('wires the Lambda functions to the same events', () => {
    for (const [name, lambda] of Object.entries(LAMBDA_QUEUES)) {
      const match = new RegExp(`${name}\\s*=\\s*\\{[^}]*events\\s*=\\s*\\[([^\\]]*)\\]`).exec(
        locals,
      );
      const events = [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(events, name).toEqual(lambda.events);
    }
  });

  it('names the DynamoDB tables as the local stack does, apart from the environment prefix', () => {
    for (const table of Object.values(TABLES)) {
      expect(locals).toContain(`"\${local.name}-${table.replace('teampulse-', '')}"`);
    }
  });
});

describe('the platform and the monitoring file list the same things', () => {
  const monitoring = JSON.parse(
    readFileSync(join(root, 'infra', 'observability', 'monitoring.json'), 'utf8'),
  ) as { services: string[]; lambdas: string[] };
  const locals = tf('locals.tf');

  it('services', () => {
    const block = /services = \{([\s\S]*?)\n  \}/.exec(locals)?.[1] ?? '';
    const names = [...block.matchAll(/^\s{4}([a-z-]+)\s*= \{ priority/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual([...monitoring.services].sort());
  });

  it('Lambda functions', () => {
    const block = /lambdas = \{([\s\S]*?)\n  \}\n\n  tables/.exec(locals)?.[1] ?? '';
    const names = [...block.matchAll(/^\s{4}([a-z-]+)\s*= \{/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual([...monitoring.lambdas].sort());
  });
});

describe('log service names', () => {
  it('are "<service>-service", which the alarm dimensions are built from', () => {
    expect(tf('monitoring.tf')).toContain('"${name}-service"');
    for (const name of [
      'identity',
      'habit',
      'event-tracking',
      'challenge',
      'insight',
      'notification',
      'recommendation',
    ]) {
      const main = readFileSync(join(root, 'services', name, 'src', 'main.ts'), 'utf8');
      expect(main, name).toContain(`service: '${name}-service'`);
    }
  });
});

describe('Content-Security-Policy', () => {
  it('is the same in CloudFront as in the nginx image', () => {
    const template = readFileSync(
      join(root, 'infra', 'docker', 'security-headers.conf.template'),
      'utf8',
    );
    const nginx = /Content-Security-Policy "([^"]*)"/.exec(template)?.[1];
    const cloudfront = /content_security_policy = "(default-src.*)"$/m.exec(tf('frontend.tf'))?.[1];
    expect(nginx).toBeDefined();
    expect(cloudfront?.replace('${join(" ", local.script_hashes)}', '__SCRIPT_HASHES__')).toBe(
      nginx,
    );
  });

  it('sets the other headers the nginx image sets', () => {
    const frontend = tf('frontend.tf');
    for (const header of ['Permissions-Policy', 'Cross-Origin-Opener-Policy']) {
      expect(frontend).toContain(header);
    }
    expect(frontend).toContain('strict_transport_security');
    expect(frontend).toContain('frame_option = "DENY"');
  });
});

describe('what each service is given to start in production', () => {
  /** The values Terraform puts in each task. Names are checked against the .tf text below. */
  const dbUrl = 'postgres://u:p@db.example.internal:5432/teampulse';
  const common = {
    NODE_ENV: 'production',
    PORT: '3000',
    LOG_LEVEL: 'info',
    AWS_REGION: 'eu-west-1',
    TRUST_PROXY: '2',
    CORS_ORIGINS: 'https://d111111abcdef8.cloudfront.net',
    LOG_PSEUDONYM_SALT: 's'.repeat(32),
    EVENT_BUS_NAME: 'teampulse-dev-bus',
  };
  const database = { DATABASE_URL: dbUrl, DATABASE_SSL: 'true' };
  const jwks = {
    IDENTITY_JWKS_URL:
      'https://d111111abcdef8.cloudfront.net/api/v1/identity/.well-known/jwks.json',
  };
  const queue = (name: string) => ({
    EVENTS_QUEUE_URL: `https://sqs.eu-west-1.amazonaws.com/123456789012/teampulse-dev-${name}`,
  });

  const cases: Array<[string, () => { TRUST_PROXY: false | number }]> = [
    [
      'identity',
      () =>
        loadIdentityConfig({
          ...common,
          ...database,
          COOKIE_SECURE: 'true',
          JWT_PRIVATE_KEY_PEM: 'pem',
        }),
    ],
    ['habit', () => loadHabitConfig({ ...common, ...database, ...jwks, ...queue('habit') })],
    [
      'event-tracking',
      () =>
        loadEventTrackingConfig({ ...common, ...database, ...jwks, ...queue('event-tracking') }),
    ],
    [
      'challenge',
      () => loadChallengeConfig({ ...common, ...database, ...jwks, ...queue('challenge') }),
    ],
    [
      'notification',
      () => loadNotificationConfig({ ...common, ...database, ...jwks, ...queue('notification') }),
    ],
    [
      'recommendation',
      () =>
        loadRecommendationConfig({ ...common, ...database, ...jwks, ...queue('recommendation') }),
    ],
    [
      'insight',
      () =>
        loadInsightConfig({
          ...common,
          ...jwks,
          ...queue('insight'),
          AGGREGATES_TABLE_NAME: 'teampulse-dev-insight-aggregates',
          PERSONAL_TABLE_NAME: 'teampulse-dev-insight-personal',
          INSIGHT_PSEUDONYM_KEY: 'k'.repeat(40),
        }),
    ],
  ];

  it.each(cases)('%s accepts the production settings and trusts two proxies', (_name, load) => {
    expect(load().TRUST_PROXY).toBe(2);
  });

  it('is set by ecs.tf under the names used above', () => {
    const ecs = tf('ecs.tf');
    const names = [
      ...Object.keys(common).filter((n) => n !== 'LOG_PSEUDONYM_SALT'),
      'DATABASE_URL',
      'DATABASE_SSL',
      'IDENTITY_JWKS_URL',
      'COOKIE_SECURE',
      'JWT_PRIVATE_KEY_PEM',
      'LOG_PSEUDONYM_SALT',
      'EVENTS_QUEUE_URL',
      'AGGREGATES_TABLE_NAME',
      'PERSONAL_TABLE_NAME',
      'INSIGHT_PSEUDONYM_KEY',
    ];
    for (const name of names) expect(ecs, name).toContain(name);
    expect(ecs).toContain('TRUST_PROXY  = "2"');
  });
});

describe('security rules in the Terraform', () => {
  it('has no wildcard action in any policy it writes', () => {
    expect(allTf).not.toMatch(/actions\s*=\s*\[[^\]]*"\*"/);
    expect(allTf).not.toMatch(/"Action"\s*[:=]\s*"\*"/);
  });

  it('gives every wildcard resource a reason', () => {
    const wildcards = [...allTf.matchAll(/resources\s*=\s*\["\*"\]([^\n]*)/g)];
    for (const match of wildcards) expect(match[1], 'resources = ["*"]').toContain('#');
  });

  it('never opens a port to the whole internet except HTTPS egress', () => {
    const ingress = [...allTf.matchAll(/aws_vpc_security_group_ingress_rule[\s\S]*?\n}/g)];
    for (const [rule] of ingress) expect(rule).not.toContain('0.0.0.0/0');
  });

  it('keeps the database private and encrypted', () => {
    const data = tf('data.tf');
    expect(data).toContain('publicly_accessible    = false');
    expect(data).toContain('storage_encrypted     = true');
    expect(data).toContain('"rds.force_ssl"');
  });

  it('does not write a secret value into a file in the repository', () => {
    expect(allTf).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(allTf).not.toMatch(/password\s*=\s*"[^"$]+"/);
  });
});
