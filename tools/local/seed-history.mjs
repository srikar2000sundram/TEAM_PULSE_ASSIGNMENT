/**
 * Gives one demo person a week of history so the Recommendations page has something to show:
 *
 *   node tools/local/seed-history.mjs [http://localhost:8080] [email] [habit title]
 *
 * It signs in as that person (default ada@example.com, created by seed-demo.mjs), takes the habit
 * with the given title (default: her first habit) and records it for each of the last six days. The platform stores WHEN each completion
 * happened (right now), so all six fall in the same hour and the Recommendation Service sees a clear
 * pattern. In real use the same pattern builds up over days of ordinary use.
 *
 * Safe to run twice: a habit can be recorded only once per day, and the server says so.
 */
const base = process.argv[2] ?? 'http://localhost:8080';
const email = process.argv[3] ?? 'ada@example.com';
const title = process.argv[4];
// The demo password; set DEMO_PASSWORD if you created the person with a different one.
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-passphrase-123';
const DAYS = 6;

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
  if (!response.ok) {
    throw new Error(`${method} ${service}${path} -> ${response.status} ${json?.code ?? ''}`);
  }
  return json;
}

const { accessToken: token } = await call('identity', 'POST', '/auth/login', {
  body: { email, password: PASSWORD },
});
const habits = await call('habit', 'GET', '/habits', { token });
const habit = habits.items.find(
  (item) => item.isOwner && (title === undefined || item.title === title),
);
if (!habit)
  throw new Error(
    `${email} has no matching habit. Create one first (or run tools/local/seed-demo.mjs).`,
  );

let recorded = 0;
for (let ago = 0; ago < DAYS; ago += 1) {
  const day = new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const result = await call('event-tracking', 'POST', '/activities', {
    token,
    body: { habitId: habit.id, activityDate: day },
  });
  if (!result.alreadyRecorded) recorded += 1;
}
process.stdout.write(
  `Recorded ${recorded} new day(s) of "${habit.title}" for ${email}.\n` +
    'Wait a few seconds for the events to arrive, then sign in and open Recommendations.\n',
);
