/**
 * Creates demo data in the running local stack so the web app has something to show:
 *
 *   node tools/local/seed-demo.mjs [http://localhost:8080]
 *
 * People (all with the password "demo-passphrase-123", for LOCAL use only):
 *   maria@example.com  manager of the team "Platform"
 *   ada@example.com, bo@example.com, cy@example.com, di@example.com, ed@example.com  employees
 * plus an active challenge and a habit for each employee. Safe to run twice: existing people are kept.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:8080';
const envText = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'local', '.env'),
  'utf8',
);
const fromEnv = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(envText)?.[1]?.trim();
const PASSWORD = 'demo-passphrase-123';
const today = new Date().toISOString().slice(0, 10);
const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

async function call(service, method, path, { token, body, allow } = {}) {
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
  if (!response.ok && response.status !== allow) {
    throw new Error(`${method} ${service}${path} -> ${response.status} ${json?.code ?? ''}`);
  }
  return response.ok ? json : undefined;
}

const login = async (email, password) =>
  (await call('identity', 'POST', '/auth/login', { body: { email, password } })).accessToken;

const admin = await login(fromEnv('ADMIN_EMAIL'), fromEnv('ADMIN_PASSWORD'));
const users = await call('identity', 'GET', '/users?limit=100', { token: admin });

async function person(email, displayName, role) {
  const existing = users.items.find((user) => user.email === email);
  if (existing) return existing;
  return call('identity', 'POST', '/users', {
    token: admin,
    body: { email, displayName, role, password: PASSWORD },
  });
}

const maria = await person('maria@example.com', 'Maria Manager', 'manager');
const employees = [];
for (const [email, name] of [
  ['ada@example.com', 'Ada'],
  ['bo@example.com', 'Bo'],
  ['cy@example.com', 'Cy'],
  ['di@example.com', 'Di'],
  ['ed@example.com', 'Ed'],
]) {
  employees.push(await person(email, name, 'employee'));
}

const teams = await call('identity', 'GET', '/teams', { token: admin });
const team =
  teams.items.find((t) => t.name === 'Platform') ??
  (await call('identity', 'POST', '/teams', {
    token: admin,
    body: { name: 'Platform', managerUserId: maria.id },
  }));
for (const member of [maria, ...employees]) {
  await call('identity', 'POST', `/teams/${team.id}/members`, {
    token: admin,
    body: { userId: member.id },
  });
}

// Team memberships are carried in the access token, so sign in after adding them.
const mariaToken = await login('maria@example.com', PASSWORD);
const existing = await call('challenge', 'GET', '/challenges', { token: mariaToken });
let challenge = existing.items.find((c) => c.name === 'November steps');
if (!challenge) {
  const created = await call('challenge', 'POST', '/challenges', {
    token: mariaToken,
    body: {
      name: 'November steps',
      activityType: 'walking',
      teamId: team.id,
      startsOn: today,
      endsOn: nextMonth,
      badgeRules: [
        { kind: 'total', threshold: 3 },
        { kind: 'streak', threshold: 3 },
      ],
    },
  });
  challenge = await call('challenge', 'POST', `/challenges/${created.id}/start`, {
    token: mariaToken,
  });
}

for (const employee of employees) {
  const token = await login(employee.email, PASSWORD);
  await call('challenge', 'POST', `/challenges/${challenge.id}/join`, { token });
  const habits = await call('habit', 'GET', '/habits', { token });
  if (habits.items.length === 0) {
    await call('habit', 'POST', '/habits', {
      token,
      body: { title: 'Walk after lunch', activityType: 'walking', visibility: 'private' },
    });
  }
}
process.stdout.write(
  `Demo data ready. Sign in at ${base} as ada@example.com (employee) or maria@example.com (manager),\npassword: ${PASSWORD}\n`,
);
