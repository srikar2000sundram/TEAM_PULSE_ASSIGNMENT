# Guide 2: The demo video, word for word

A video of about **8 to 10 minutes**. Each scene has **Do** (what to click or type) and **Say** (what to
read aloud, in plain words). Say it in your own voice; the words are only a start.

## Before you press record (do this once, off camera)

1. Open PowerShell in the `teampulse` folder.
2. `npm run local:up` and wait until it ends (first time 5 to 10 minutes).
3. `node tools/local/compose.mjs ps`: every row `healthy`, or `Exited (0)` for `migrate` and `aws-setup`.
4. `node tools/local/seed-demo.mjs`: it prints "Demo data ready".
5. Open **two browser windows** at <http://localhost:8080>: one for Ada, one for Maria. Use a private
   window for the second so the sign-ins do not mix.
6. Open these files in your editor in tabs, ready to show: `README.md`,
   `docs/architecture/01-system-context.md`, `docs/architecture/14-local-stack.md`.
7. **Never show** `infra/local/.env`: it holds passwords. Close it.

## Scene 1: What TeamPulse is (about 1 minute)

**Do:** Show the `README.md` and scroll to the architecture picture.

**Say:** "TeamPulse is a platform where employees build healthy habits and join team challenges, and
where managers see how the team is doing without seeing any one person's private data. It has six
small services: Identity, Habit, Challenge, Event Tracking, Insight and Notification. They talk to
each other by sending events, and the website is a SvelteKit app."

## Scene 2: The architecture (about 1 minute)

**Do:** Show the diagram in `docs/architecture/14-local-stack.md`.

**Say:** "Here is how it runs. The browser talks to one address. A router sends each request to the
right service. Services keep their data in PostgreSQL. When something happens, such as a habit being
done, the service writes an event, and it is sent over an event bus to the other services. In AWS this
is EventBridge, queues, Lambda and DynamoDB. On my computer a stand-in called LocalStack plays AWS, so
I can show the whole flow."

## Scene 3: An employee's day (about 2 minutes)

**Do:** In Ada's window, sign in: `ada@example.com`, password `demo-passphrase-123`.

**Say:** "I am signing in as Ada, an employee."

**Do:** Open **Habits**. Press **Done today** on "Walk after lunch".

**Say:** "Ada did her walk and presses Done. The message says it was recorded."

**Do:** Open **Challenges**, then **November steps**.

**Say:** "In a second or two her point appears on the leaderboard. That point travelled through the
event bus: the Habit service said an activity was done, and the Challenge service heard it and scored
it."

**Do:** Go back and press **Done today** again.

**Say:** "If I press again, it says 'Already recorded' and nothing changes. Nobody can score twice for
the same day, even if a message is delivered twice."

**Do:** Open **My activity**.

**Say:** "This page shows only Ada's own numbers."

## Scene 4: The filters and the components (about 1 minute)

**Do:** On **My activity**, change the period or activity filter and watch the page update.

**Say:** "The filters update the page instantly with no reload. The progress ring, the leaderboard and
the chart are reusable web components, built once and used on several pages."

## Scene 5: A manager and privacy (about 2 minutes)

**Do:** In Maria's window, sign in: `maria@example.com`, same password. Open **Team activity**.

**Say:** "Maria is Ada's manager. She sees the team, but only totals. With fewer than five people
taking part, the page says 'Not enough participants'. That is a privacy rule: with only one or two
people, a total would reveal what one person did."

**Do:** In Ada's window sign out; sign in as `bo@example.com`, press **Done today**. Repeat for
`cy@example.com`, `di@example.com`, `ed@example.com`. Then reload Maria's **Team activity**.

**Say:** "Now five different people have taken part, so the numbers appear. Still no names, no
individual rows. Managers see groups, never persons."

**Do:** In Maria's window try the organisation report (or say it).

**Say:** "A manager cannot open the organisation-wide report. That is for the administrator only."

## Scene 6: Proof it all works (about 1 minute 30)

**Do:** In PowerShell run `npm run local:smoke` and let it finish.

**Say:** "This script creates new people and follows an activity through the whole system: the habit,
the event, the points, the badge, the notification, the team report and the streak in DynamoDB. It
prints PASS for each of 17 checks and ends with 'All checks passed'."

**Do:** Optional: run `npm run verify` beforehand and show the end of its output, or just say it.

**Say:** "The project also has about 1,400 automated tests, formatting and style checks, strict type
checking, and every diagram in the documentation is checked."

## Scene 7: The administrator and notifications (about 1 minute)

**Do:** Sign out, then sign in as the administrator from `infra/local/.env` (type the e-mail and password
off camera, or use a demo administrator you created beforehand). Open **Administration**.

**Say:** "The administrator manages people and teams. I can add a person, disable or enable an
account, create a team, and add people to it."

**Do:** Add a person with the form, then press **Disable** on them.

**Say:** "Every change shows a message, and the list updates."

**Do:** Sign in as Ada (a badge appears after a few activities) and open the bell, **Notifications**.

**Say:** "When Ada earns a badge, the Notification service tells her. Here it is; I can mark it as read."

## Scene 8: Being honest (about 1 minute)

**Say:** "What is not done yet: I have not deployed to real AWS; I wrote the plan and will build the
infrastructure code next. Editing a habit, reminders and sharing from the screen, and a few admin
extras such as password reset are still to come. Everything I showed is real, running code."

## If something goes wrong while recording

- **Points stay at 0:** wait two seconds and reload. If still 0, run `npm run local:smoke`.
- **Sign-in fails:** `node tools/local/compose.mjs ps` to see if a service is unhealthy; `npm run local:down`
  then `npm run local:up`.
- **The page does not load:** the stack is not up; run `npm run local:up`.
