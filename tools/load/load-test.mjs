/**
 * A small load test against the local stack (it needs `npm run local:up` and the demo data from
 * `node tools/local/seed-demo.mjs`).
 *
 *   node tools/load/load-test.mjs [--base http://localhost:8080] [--seconds 30] [--users 5] [--think-ms 1000]
 *   node tools/load/load-test.mjs --burst
 *
 * Normal mode: each virtual user signs in as one demo employee and then repeatedly does what a person
 * does (list habits, list challenges, record today's activity, read their own report, read their
 * notifications), pausing "think time" between requests. It reports requests, errors and latency
 * percentiles per endpoint.
 *
 * Burst mode: one user fires a rapid series of requests at one rate-limited route and checks that the
 * limiter answers 429 after its limit, that nothing answers 5xx, and that the service still serves a
 * normal request afterwards.
 *
 * Honest limits: this runs on one computer against containers on the same computer, so the numbers
 * show how the code behaves, not what AWS will do. The rate limits are per client address and every
 * request here comes from one address, so a long run is limited by them (that is reported as "429").
 */
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const base = flag('base', 'http://localhost:8080');
const seconds = Number(flag('seconds', '30'));
const users = Number(flag('users', '5'));
const thinkMs = Number(flag('think-ms', '1000'));
const burst = args.includes('--burst');
const PASSWORD = 'demo-passphrase-123';
const EMAILS = ['ada', 'bo', 'cy', 'di', 'ed'].map((name) => `${name}@example.com`);
const today = new Date().toISOString().slice(0, 10);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(service, method, path, { token, body } = {}) {
  const started = performance.now();
  let status = 0;
  let json;
  try {
    const response = await fetch(`${base}/api/v1/${service}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    status = response.status;
    const text = await response.text();
    json = text ? JSON.parse(text) : undefined;
  } catch {
    status = 0; // the connection itself failed
  }
  return { status, json, ms: performance.now() - started };
}

async function signIn(email) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await http('identity', 'POST', '/auth/login', {
      body: { email, password: PASSWORD },
    });
    if (result.status === 200) return result.json.accessToken;
    if (result.status !== 429) throw new Error(`Cannot sign in ${email}: status ${result.status}`);
    await wait(10_000); // the sign-in limit is 10 a minute; wait for the window to pass
  }
  throw new Error(`Still rate limited signing in ${email}`);
}

const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function report(samples, elapsedSeconds) {
  const byName = new Map();
  for (const sample of samples) {
    const entry = byName.get(sample.name) ?? {
      ms: [],
      ok: 0,
      limited: 0,
      client: 0,
      server: 0,
      failed: 0,
    };
    entry.ms.push(sample.ms);
    if (sample.status === 0) entry.failed += 1;
    else if (sample.status === 429) entry.limited += 1;
    else if (sample.status >= 500) entry.server += 1;
    else if (sample.status >= 400) entry.client += 1;
    else entry.ok += 1;
    byName.set(sample.name, entry);
  }
  console.log(
    '\nendpoint                      requests   ok  429  4xx  5xx  fail   p50    p95    p99  (ms)',
  );
  let totals = { requests: 0, server: 0, failed: 0, limited: 0 };
  for (const [name, entry] of [...byName].sort()) {
    const sorted = entry.ms.sort((a, b) => a - b);
    console.log(
      `${name.padEnd(28)} ${String(sorted.length).padStart(8)} ${String(entry.ok).padStart(4)} ${String(entry.limited).padStart(4)} ${String(entry.client).padStart(4)} ${String(entry.server).padStart(4)} ${String(entry.failed).padStart(5)} ${percentile(sorted, 50).toFixed(0).padStart(5)} ${percentile(sorted, 95).toFixed(0).padStart(6)} ${percentile(sorted, 99).toFixed(0).padStart(6)}`,
    );
    totals = {
      requests: totals.requests + sorted.length,
      server: totals.server + entry.server,
      failed: totals.failed + entry.failed,
      limited: totals.limited + entry.limited,
    };
  }
  console.log(
    `\n${totals.requests} requests in ${elapsedSeconds.toFixed(1)} s = ${(totals.requests / elapsedSeconds).toFixed(1)} requests/s; ` +
      `${totals.server} server errors, ${totals.failed} failed connections, ${totals.limited} rate limited.`,
  );
  return totals;
}

async function normalMode() {
  const tokens = [];
  for (let index = 0; index < users; index += 1)
    tokens.push(await signIn(EMAILS[index % EMAILS.length]));
  const habitIds = [];
  for (const token of tokens) {
    const habits = await http('habit', 'GET', '/habits', { token });
    habitIds.push(habits.json?.items?.[0]?.id);
  }
  const samples = [];
  const end = performance.now() + seconds * 1000;
  const started = performance.now();
  const record = (name, result) => samples.push({ name, ...result });

  await Promise.all(
    tokens.map(async (token, index) => {
      while (performance.now() < end) {
        record('GET habit/habits', await http('habit', 'GET', '/habits', { token }));
        await wait(thinkMs);
        record(
          'GET challenge/challenges',
          await http('challenge', 'GET', '/challenges', { token }),
        );
        await wait(thinkMs);
        if (habitIds[index]) {
          record(
            'POST event-tracking/activities',
            await http('event-tracking', 'POST', '/activities', {
              token,
              body: { habitId: habitIds[index], activityDate: today },
            }),
          );
          await wait(thinkMs);
        }
        record(
          'GET notification/notifications',
          await http('notification', 'GET', '/notifications?limit=10', { token }),
        );
        await wait(thinkMs);
        record(
          'GET insight/me/activity',
          await http('insight', 'GET', `/me/activity?from=${today}&to=${today}`, { token }),
        );
        await wait(thinkMs);
      }
    }),
  );
  const totals = report(samples, (performance.now() - started) / 1000);
  if (totals.server > 0 || totals.failed > 0) process.exitCode = 1;
}

async function burstMode() {
  const token = await signIn(EMAILS[0]);
  const habits = await http('habit', 'GET', '/habits', { token });
  const habitId = habits.json?.items?.[0]?.id;
  if (!habitId) throw new Error('Ada has no habit: run node tools/local/seed-demo.mjs first');
  // Wait for a fresh rate-limit window so the count below starts from zero.
  await wait(61_000);
  const samples = [];
  const started = performance.now();
  for (let index = 0; index < 150; index += 1) {
    const result = await http('event-tracking', 'POST', '/activities', {
      token,
      body: { habitId, activityDate: today },
    });
    samples.push({ name: 'POST event-tracking/activities', ...result });
  }
  const totals = report(samples, (performance.now() - started) / 1000);
  const firstLimited = samples.findIndex((sample) => sample.status === 429);
  console.log(
    `\nThe limiter first answered 429 on request number ${firstLimited + 1} (the configured limit is 120 a minute).`,
  );
  await wait(61_000);
  const after = await http('habit', 'GET', '/habits', { token });
  console.log(`A normal request after the window passed: status ${after.status}`);
  const passed =
    firstLimited > 0 && totals.server === 0 && totals.failed === 0 && after.status === 200;
  console.log(passed ? 'BURST CHECK PASSED' : 'BURST CHECK FAILED');
  if (!passed) process.exitCode = 1;
}

await (burst ? burstMode() : normalMode());
