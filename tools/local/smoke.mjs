/**
 * End-to-end check of the running local stack, through the same address the browser uses:
 *
 *   node tools/local/smoke.mjs [http://localhost:8080]
 *
 * It signs in as the administrator (password read from infra/local/.env, never printed), creates a
 * manager, five employees and a team, then follows one activity all the way through: Habit -> event
 * bus -> Event Tracking -> bus -> streak Lambda, Challenge, Insight and Notification. Each step waits
 * for the asynchronous part (events travel through queues) and fails with a clear message if it
 * does not arrive. Uses fresh random e-mail addresses, so it can be run again and again.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:8080';
const envText = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'local', '.env'),
  'utf8',
);
const fromEnv = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(envText)?.[1]?.trim();

const run = randomBytes(3).toString('hex');
const today = new Date().toISOString().slice(0, 10);
const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
let failed = 0;

async function call(service, method, path, { token, body } = {}) {
  const response = await fetch(`${base}/api/v1/${service}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok)
    throw Object.assign(
      new Error(`${method} ${service}${path} -> ${response.status} ${json?.code ?? ''}`),
      { status: response.status },
    );
  return json;
}

/** Retries until `check` returns a truthy value: events take a moment to travel through the queues. */
async function eventually(label, check, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`${label}: not seen within ${seconds}s${last ? ` (${last.message})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function step(label, work) {
  try {
    const result = await work();
    process.stdout.write(`PASS  ${label}\n`);
    return result;
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL  ${label}: ${error.message}\n`);
    return undefined;
  }
}

const login = async (email, password) =>
  (await call('identity', 'POST', '/auth/login', { body: { email, password } })).accessToken;

const adminToken = await step('administrator signs in', () =>
  login(fromEnv('ADMIN_EMAIL'), fromEnv('ADMIN_PASSWORD')),
);
if (adminToken === undefined) process.exit(1);

const password = `smoke-${run}-passphrase`;
const mk = (name, role) =>
  call('identity', 'POST', '/users', {
    token: adminToken,
    body: { email: `${name}-${run}@example.com`, displayName: `${name} ${run}`, role, password },
  });

const manager = await step('create a manager', () => mk('manager', 'manager'));
const people = [];
for (let n = 1; n <= 5; n += 1)
  people.push(await step(`create employee ${n}`, () => mk(`employee${n}`, 'employee')));
const team = await step('create a team', () =>
  call('identity', 'POST', '/teams', {
    token: adminToken,
    body: { name: `Smoke ${run}`, managerUserId: manager.id },
  }),
);
for (const person of [manager, ...people]) {
  await call('identity', 'POST', `/teams/${team.id}/members`, {
    token: adminToken,
    body: { userId: person.id },
  });
}

// Tokens carry the team memberships, so sign in only after they were added.
const managerToken = await login(`manager-${run}@example.com`, password);
const tokens = [];
for (let n = 1; n <= 5; n += 1)
  tokens.push(await login(`employee${n}-${run}@example.com`, password));

const challenge = await step(
  'manager creates and starts a challenge with a "first activity" badge',
  async () => {
    const created = await call('challenge', 'POST', '/challenges', {
      token: managerToken,
      body: {
        name: `Smoke walk ${run}`,
        activityType: 'walking',
        teamId: team.id,
        startsOn: today,
        endsOn: inAWeek,
        badgeRules: [{ kind: 'total', threshold: 1 }],
      },
    });
    return call('challenge', 'POST', `/challenges/${created.id}/start`, { token: managerToken });
  },
);
for (const token of tokens)
  await call('challenge', 'POST', `/challenges/${challenge.id}/join`, { token });

const habits = [];
for (const [index, token] of tokens.entries()) {
  habits.push(
    await call('habit', 'POST', '/habits', {
      token,
      body: { title: `Walk ${index + 1}`, activityType: 'walking', visibility: 'private' },
    }),
  );
}

await step(
  'Event Tracking learns about the habits from the event bus and records activities',
  async () => {
    for (const [index, token] of tokens.entries()) {
      // The habit becomes known to Event Tracking when HabitCreated has travelled through the bus.
      await eventually(`activity ${index + 1}`, () =>
        call('event-tracking', 'POST', '/activities', {
          token,
          body: { habitId: habits[index].id, activityDate: today },
        }),
      );
    }
    return true;
  },
);

await step('the same request again is harmless (idempotent)', async () => {
  const again = await call('event-tracking', 'POST', '/activities', {
    token: tokens[0],
    body: { habitId: habits[0].id, activityDate: today },
  });
  return again.alreadyRecorded === true;
});

await step('Challenge scores each activity (event bus -> Challenge Service)', () =>
  eventually('leaderboard', async () => {
    const board = await call('challenge', 'GET', `/challenges/${challenge.id}/leaderboard`, {
      token: tokens[0],
    });
    return board.entries.length === 5 && board.entries.every((entry) => entry.points === 1);
  }),
);

await step('the "first activity" badge is awarded and Notification tells the person', () =>
  eventually('badge notification', async () => {
    const list = await call('notification', 'GET', '/notifications', { token: tokens[0] });
    return list.items.some((item) => item.kind === 'badge');
  }),
);

await step('Insight shows the team numbers (5 different people reach the privacy threshold)', () =>
  eventually('team report', async () => {
    const report = await call(
      'insight',
      'GET',
      `/teams/${team.id}/activity?from=${today}&to=${today}`,
      { token: managerToken },
    );
    return (
      report.total.suppressed === false &&
      report.total.participants === 5 &&
      report.total.completions === 5
    );
  }),
);

await step('a manager cannot read the organisation report (administrators only)', async () => {
  try {
    await call('insight', 'GET', `/organization/activity?from=${today}&to=${today}`, {
      token: managerToken,
    });
    return false;
  } catch (error) {
    return error.status === 403;
  }
});

await step('an employee sees their own activity', () =>
  eventually('personal report', async () => {
    const mine = await call('insight', 'GET', `/me/activity?from=${today}&to=${today}`, {
      token: tokens[0],
    });
    return mine.total === 1;
  }),
);

await step('the streak Lambda stored a streak of 1 for each person (DynamoDB in LocalStack)', () =>
  eventually('streak items', async () => {
    const response = await fetch('http://localhost:4566/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'DynamoDB_20120810.Scan',
        authorization:
          'AWS4-HMAC-SHA256 Credential=test/20260101/eu-west-1/dynamodb/aws4_request, SignedHeaders=host, Signature=x',
      },
      body: JSON.stringify({ TableName: 'teampulse-streaks' }),
    });
    const { Items = [] } = await response.json();
    const mine = new Set(people.map((p) => `USER#${p.id}`));
    return (
      Items.filter((item) => mine.has(item.pk?.S) && item.currentStreak?.N === '1').length === 5
    );
  }),
);

process.stdout.write(failed === 0 ? '\nAll checks passed.\n' : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
