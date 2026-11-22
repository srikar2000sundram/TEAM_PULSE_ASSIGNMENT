# Guide 1: Run TeamPulse on your computer and test it

**Who this is for:** someone who has never run this project. Every step says what to type, what you
should see, and what to do if you do not. Commands are for **Windows PowerShell**; macOS and Linux
users can use the same commands in a terminal (the notes say where they differ).

**How long:** Part A (tests) about 30 minutes including installs. Part D (everything in containers) about 20 minutes plus the first build.

## 0. What works on your computer today, and what does not

TeamPulse is many programs that talk to each other through a database and an event bus. On your own
computer, without Docker and without an AWS account, here is the honest picture:

| What you want to do                                               | Works locally now? | What it needs                           |
| ----------------------------------------------------------------- | ------------------ | --------------------------------------- |
| Run all automated tests (they prove the rules work)               | **Yes** (Part A)   | Node.js only                            |
| Open the web app and sign in                                      | **Yes** (Part C)   | Node.js and PostgreSQL                  |
| Create users and teams, create habits, create and join challenges | **Yes** (Part C)   | Node.js and PostgreSQL                  |
| Mark a habit "done today"                                         | **Not yet**        | The event bus (AWS EventBridge and SQS) |
| Streaks, badges, notifications, challenge points                  | **Not yet**        | The event bus and AWS Lambda            |
| Team and personal analytics pages                                 | **Not yet**        | DynamoDB (AWS)                          |

Why "not yet": when you create a habit, the Habit Service announces it on the event bus, and the
Event Tracking Service only accepts "done today" for habits it has heard about. The bus is Amazon
EventBridge and SQS. A local copy of them (LocalStack, run with Docker or Podman) is what **Part D** starts. Without it,
the tests are how everything that depends on the bus is proven: they replace the bus with a test
double.

You will see the pages that need the bus show a friendly error message. That is expected, not a bug.

> **The easy way to run everything:** Part D starts the whole platform, including the event bus,
> DynamoDB and the Lambda functions, with one command using Docker or Podman, and then **every row of
> the table above works**. Parts B and C show how the pieces work without containers; if you only want
> to use the app, go straight to Part D after Part A.

## 1. Install the tools

### 1.1 Node.js (required)

1. Go to <https://nodejs.org> and download the **LTS** version (22 or newer).
2. Run the installer and accept the defaults.
3. Open a **new** PowerShell window (Start menu, type `powershell`) and check:

```powershell
node --version
npm --version
```

You should see something like `v22.11.0` (any number from 22 up is fine; this project was built on
Node 26) and `10.x.x`. If you see "not recognized", close PowerShell, open a new one, and try
again; if it still fails, re-run the installer.

### 1.2 A code editor (recommended)

Install **Visual Studio Code** from <https://code.visualstudio.com>. It is optional, but it makes
reading the code and documents much easier. Useful extensions: "Svelte for VS Code" and "Markdown
Preview Mermaid Support" (the documents contain diagrams).

### 1.3 PostgreSQL (only for Part C)

1. Go to <https://www.postgresql.org/download/windows/> and download the installer (version 16 or
   newer).
2. In the installer keep the defaults: port **5432**, and tick **pgAdmin 4** and **Command Line
   Tools**.
3. When asked, choose a password for the `postgres` user and **write it down**. In this guide it is
   written as `YOUR_PG_PASSWORD`.
4. Check it is installed (open a new PowerShell): `psql --version`.

You do not need PostgreSQL for Part A: the tests carry their own copy of PostgreSQL.

## 2. Get the project ready

Open PowerShell and go to the project folder (the one that contains `package.json` and `docs`):

```powershell
cd "C:\Users\<you>\...\ASSIGNMENT_5\teampulse"
```

Install the libraries the project uses (this downloads about 1 GB the first time, and can take a few
minutes; warnings about "deprecated" or "audit" are normal):

```powershell
npm install
```

Compile the shared code:

```powershell
npm run build
```

You should see no red error text. If a command ends with `ERR!` or `error TS`, read the first error
line: it names the file and the problem. Section 8 lists the common ones.

## Part A: Run the automated tests

### A.1 Everything at once

```powershell
npm run verify
```

This runs six checks in order and stops at the first failure:

| Step | What it does                                                          | Why it matters                                         |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| 1    | `format:check`: is every file formatted the same way                  | Keeps changes small and readable                       |
| 2    | `lint`: rules for code quality and architecture                       | Fails if, say, business code imports a database driver |
| 3    | `typecheck`: the TypeScript compiler on every package and the web app | Catches wrong types before they run                    |
| 4    | `test`: the unit tests, the web tests, then the integration tests     | Proves behaviour (see below)                           |
| 5    | `docs:check`: every Mermaid diagram in the documents                  | Diagrams that do not render are bugs                   |

It takes several minutes; the integration tests start a real PostgreSQL inside the test process.
**When it works,** the last lines look like this and the command prints nothing red:

```text
 Test Files  60 passed (60)
      Tests  787 passed (787)
 ...
 Test Files  25 passed (25)
      Tests  539 passed (539)
65/65 Mermaid diagrams valid
```

(The numbers grow as the project grows.) If your computer is short of memory, close the browser and
other programs first. The tests are deliberately run in small groups for this reason.

### A.2 One part at a time

| Command                                                 | What it runs                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `npm run test:unit`                                     | Business rules, with no database: seconds                      |
| `npm run test:integration`                              | Real PostgreSQL, real login cryptography, the whole HTTP stack |
| `npx vitest run --project frontend`                     | The web components and the web app's logic                     |
| `npx vitest run --project unit services/challenge`      | Only the Challenge Service's unit tests                        |
| `npx vitest run --project integration services/insight` | Only the Insight Service's integration tests                   |
| `npm run lint`                                          | Code rules only                                                |
| `npm run docs:check`                                    | Diagram check only                                             |
| `npm run format`                                        | **Fixes** formatting in every file (the only one that edits)   |

### A.3 What each kind of test proves

| Kind        | Where                                         | Example of what it proves                                                             |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unit        | `services/*/test/unit`                        | A group of fewer than 5 people never gets its numbers shown                           |
| Integration | `services/*/test/integration`                 | Signing in with a real token and calling the real HTTP routes against a real database |
| Contract    | `test/support/repository-contract.ts`         | The in-memory fake and PostgreSQL behave identically, so unit tests can be trusted    |
| Frontend    | `packages/ui/test`, `apps/web/src/**.test.ts` | A hidden number is never drawn as zero; an expired login is refreshed once            |
| Docs        | `npm run docs:check`                          | Every diagram is valid                                                                |

### A.4 Seeing a test fail on purpose (to trust it)

1. Open `lambdas/badge/src/domain/milestones.ts` and change `[7, 14, 30, 60, 100, 365]` to
   `[8, 14, 30, 60, 100, 365]`.
2. Run `npx vitest run --project unit lambdas/badge`. Tests fail and name the rule that broke.
3. Change it back and run again: green.

A test suite you have watched fail is one you can believe.

## Part B: Look at the web app without a backend

```powershell
npm run dev -w @teampulse/web
```

Open <http://localhost:5173>. You should see the sign-in page. Signing in fails because no backend is
running yet: you will see a short red message. Press `Ctrl+C` in the terminal to stop the server.

To see the production build the way it will be hosted:

```powershell
npm run build -w @teampulse/web      # creates apps/web/build (plain HTML, JS and CSS)
npm run preview -w @teampulse/web    # serves that build locally
```

## Part C: Run the backend and use the app

You will start five small servers (Identity, Habit, Event Tracking, Challenge, Notification) and the
web app. Each runs in **its own PowerShell window**, because each keeps running until you stop it.
Use this table; every service gets its own port.

| Service        | Port | Database schema  |
| -------------- | ---- | ---------------- |
| Identity       | 3001 | `identity`       |
| Habit          | 3002 | `habit`          |
| Event Tracking | 3003 | `event_tracking` |
| Challenge      | 3004 | `challenge`      |
| Notification   | 3006 | `notification`   |
| Web app        | 5173 | none             |

(Port 3005 is kept for the Insight Service, which needs DynamoDB and so is not started here.)

### C.1 Create the database

1. Open the **SQL Shell (psql)** from the Start menu (installed with PostgreSQL), press Enter to
   accept the defaults for server, database, port and user, and type your password.
2. Type:

```sql
CREATE DATABASE teampulse;
\q
```

All services share this one database and each keeps its tables in its own **schema**, the way each
service owns its own data in production.

### C.2 Make a signing key for logins

Identity signs login tokens with a private key. Generate one (once):

```powershell
node services/identity/dist/cli/generate-jwt-key.js
```

It prints two blocks. Copy the block that starts with `-----BEGIN PRIVATE KEY-----` and ends with
`-----END PRIVATE KEY-----` (include those two lines) into a new file called `private.pem` in the
project folder. **Never share or commit this file.** (`.gitignore` does not list it, so keep it out
of any repository you create.)

### C.3 Set the settings every window needs

Environment variables are how you give settings to a program. They last only for that PowerShell
window, so repeat this block in **every** new window (change `YOUR_PG_PASSWORD`):

```powershell
$env:DATABASE_URL = "postgres://postgres:YOUR_PG_PASSWORD@localhost:5432/teampulse"
$env:IDENTITY_JWKS_URL = "http://localhost:3001/api/v1/identity/.well-known/jwks.json"
```

### C.4 Create the tables (once)

In a PowerShell window with the block above set, run all five:

```powershell
npm run migrate -w @teampulse/svc-identity
npm run migrate -w @teampulse/svc-habit
npm run migrate -w @teampulse/svc-event-tracking
npm run migrate -w @teampulse/svc-challenge
npm run migrate -w @teampulse/svc-notification
```

Each prints a line such as `migrations applied`. Running them again is safe: they say
`database is up to date`.

### C.5 Create the first administrator (once)

```powershell
$env:JWT_PRIVATE_KEY_PEM = Get-Content private.pem -Raw
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "a-long-passphrase-7"
npm run bootstrap-admin -w @teampulse/svc-identity
```

You should see `administrator created: <an id>`. Passwords must be at least 12 characters. The
command refuses to run a second time once an administrator exists.

### C.6 Start the servers

Open **six** PowerShell windows in the project folder. In each, first run the block from C.3. Then:

**Window 1, Identity** (it also needs the key and local-only cookie settings):

```powershell
$env:JWT_PRIVATE_KEY_PEM = Get-Content private.pem -Raw
$env:COOKIE_SECURE = "false"      # we use http locally; the cookie is secure in production
$env:PORT = "3001"
npm start -w @teampulse/svc-identity
```

**Window 2, Habit:** `$env:PORT = "3002"` then `npm start -w @teampulse/svc-habit`

**Window 3, Event Tracking:** `$env:PORT = "3003"` then `npm start -w @teampulse/svc-event-tracking`

**Window 4, Challenge:** `$env:PORT = "3004"` then `npm start -w @teampulse/svc-challenge`

**Window 5, Notification:** `$env:PORT = "3006"` then `npm start -w @teampulse/svc-notification`

**Window 6, the web app:** `npm run dev -w @teampulse/web`

Each service prints a line saying it is listening. The services also print warnings such as
`consumer.disabled` and `outbox.relay_disabled`: that is the missing event bus (section 0), and it is
expected.

Check one is alive: open <http://localhost:3001/healthz> in your browser. You should see
`{"status":"ok","service":"identity-service"}`. <http://localhost:3001/readyz> additionally checks the database.

### C.7 Create people and a team

The web app has no administrator screens yet, so you create users and a team with the API. This is
also a good way to learn what the API looks like. In any PowerShell window:

```powershell
$api = "http://localhost:3001/api/v1/identity"
$json = "application/json"

# 1. Sign in as the administrator and keep the token
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType $json `
  -Headers @{ "X-Requested-With" = "teampulse-web" } `
  -Body (@{ email = "admin@example.com"; password = "a-long-passphrase-7" } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.accessToken)" }

# 2. A manager and two employees (passwords need 12+ characters)
$manager = Invoke-RestMethod -Method Post -Uri "$api/users" -Headers $h -ContentType $json `
  -Body (@{ email = "maria@example.com"; displayName = "Maria Manager"; role = "manager"; password = "manager-passphrase-1" } | ConvertTo-Json)
$ada = Invoke-RestMethod -Method Post -Uri "$api/users" -Headers $h -ContentType $json `
  -Body (@{ email = "ada@example.com"; displayName = "Ada Employee"; role = "employee"; password = "employee-passphrase-1" } | ConvertTo-Json)

# 3. A team managed by Maria, with Ada as a member (and Maria too)
$team = Invoke-RestMethod -Method Post -Uri "$api/teams" -Headers $h -ContentType $json `
  -Body (@{ name = "Platform"; managerUserId = $manager.id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$api/teams/$($team.id)/members" -Headers $h -ContentType $json -Body (@{ userId = $ada.id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$api/teams/$($team.id)/members" -Headers $h -ContentType $json -Body (@{ userId = $manager.id } | ConvertTo-Json)
```

Each command prints the object it created. If one fails you will see an error such as
`Cannot validate` or a `400`: read the `detail` in the message (a short password is the usual cause).

### C.8 Use the app

1. Open <http://localhost:5173>.
2. **Sign in as the manager** (`maria@example.com` / `manager-passphrase-1`). You land on the
   dashboard. The activity numbers show an error because Insight needs DynamoDB: expected.
3. Open **Challenges**, scroll to **Create a challenge**, fill in a name, the activity, the team, a
   start date of today and an end date next week, and press **Create draft**. The challenge starts as
   a **draft**: only managers see it.
4. Click the challenge, then **Start now**. Its status becomes `active`.
5. **Sign out**, then **sign in as Ada** (`ada@example.com` / `employee-passphrase-1`).
6. Open **Challenges**: you see the active challenge. Press **Join**. Open it to see the (empty)
   standings and your progress.
7. Open **Habits**, add "Walk after lunch" with type Walking, and press **Add habit**. It appears in
   the list. Pressing **Done today** shows an error: Event Tracking has not heard of the habit
   because there is no event bus locally (section 0).
8. Try the filter bar on **Challenges** (activity, status, dates). Notice the address bar changes:
   you can copy the link and the same filtered view opens.

### C.9 Look at the data and the API yourself

- **pgAdmin 4** (installed with PostgreSQL): connect to the `teampulse` database and open
  `Schemas`. You will see `identity`, `habit`, `challenge` and so on, each with its own tables. Look
  at `habit.outbox`: the events waiting for a bus that does not exist locally.
- Every service describes its API in a machine-readable file under `docs/api/*.openapi.json` and in a
  readable page under `docs/api/*.md`.
- Try an error on purpose: sign in with a wrong password. You get a polite message and the same
  message for an unknown email, so nobody can find out which emails exist.

### C.10 Stop everything

Press `Ctrl+C` in each window. The data stays in PostgreSQL. To start fresh, in `psql` run
`DROP DATABASE teampulse;` and repeat from C.1.

## Part D: Run the whole platform with one command (Docker or Podman)

This starts PostgreSQL, a pretend AWS (LocalStack: the event bus, queues and DynamoDB), the six
services, the two Lambda functions and the web app, all wired together as they are in AWS. You do
**not** need PostgreSQL installed for this part.

### D.1 Install a container engine (once)

A container is a small, sealed copy of a program with everything it needs. You need one of:

- **Podman** (free, no account): <https://podman.io/docs/installation#windows>, or in PowerShell
  `winget install RedHat.Podman`. Then create and start its small virtual machine:

```powershell
podman machine init
podman machine set --memory 4096     # the platform needs about 3 GB; the default 2 GB is tight
podman machine start
podman info                           # should print details, not an error
```

- **Docker Desktop**: <https://www.docker.com/products/docker-desktop/>. Start it and wait until it
  says "running". (Its licence has conditions for larger companies: Podman has none.)

You also need Node.js (section 1.1) and the project set up (section 2). The command below uses
Docker if it is installed and Podman otherwise.

### D.2 Create your local secrets (once)

```powershell
npm run local:env
```

This writes `infra/local/.env` with random passwords and a signing key. It never overwrites an
existing file and never prints a secret. Open the file to read the administrator's e-mail and
password (`ADMIN_EMAIL`, `ADMIN_PASSWORD`). **Never commit this file** (it is already ignored).

### D.3 Start everything

```powershell
npm run local:up
```

The first run downloads images and compiles the project inside the container: **about 5 to 10
minutes**. Later runs take under a minute. At the end you should see lines like
`Container teampulse-web-1 Started`. Check the state:

```powershell
node tools/local/compose.mjs ps
```

Every row should say `Up ... (healthy)` (the `lambdas` row has no health check, and `migrate` and
`aws-setup` say `Exited (0)`: they are one-off jobs that finished successfully).

### D.4 Fill it with demo data and look around

```powershell
node tools/local/seed-demo.mjs
```

Open <http://localhost:8080> and sign in as:

| Who                | E-mail                  | Password                | What to try                                     |
| ------------------ | ----------------------- | ----------------------- | ----------------------------------------------- |
| An employee        | `ada@example.com`       | `demo-passphrase-123`   | Habits, **Done today**, Challenges, My activity |
| The team's manager | `maria@example.com`     | `demo-passphrase-123`   | Create and start challenges, Team activity      |
| The administrator  | from `infra/local/.env` | from `infra/local/.env` | Organisation activity                           |

(The demo password is for your own computer only.) A good first tour as Ada:

1. **Habits**: press **Done today**. You see "Nice work! Recorded for today."
2. **Challenges** then **November steps**: your points went from 0 to 1 within a second or two, your
   name is in the standings, and the ring shows progress toward the badges.
3. Press **Done today** again: it says "Already recorded", and the points do not change.
4. **My activity** shows your own numbers.
5. Sign out, sign in as Maria, open **Team**: with only one active person the numbers say "Not enough
   participants". Record activity as Bo, Cy, Di and Ed too (sign in as each) and look again: when
   five different people have taken part, the numbers appear. This is the privacy rule at work.

### D.5 Check it automatically

```powershell
npm run local:smoke
```

It creates new people and follows an activity through the whole system, printing `PASS` or `FAIL`
for 17 steps, and ends with `All checks passed.` Run it any time you change something.

### D.6 Look inside

| What                          | How                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| What a service is saying      | `node tools/local/compose.mjs logs habit` (any service name)                                                     |
| The database                  | Connect any PostgreSQL tool to `localhost:5433`, user `postgres`, database `teampulse`, the password from `.env` |
| The queues and event bus      | `http://localhost:4566/_localstack/health` shows the pretend AWS services                                        |
| Events that failed five times | The `teampulse-*-dlq` queues (dead-letter queues)                                                                |

### D.7 Stop and start over

| Goal                            | Command               |
| ------------------------------- | --------------------- |
| Stop everything, keep your data | `npm run local:down`  |
| Start again                     | `npm run local:up`    |
| Stop and **delete all data**    | `npm run local:reset` |

### D.8 When something goes wrong in Part D

| What you see                                      | Likely cause and fix                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Neither docker nor podman was found`             | Install one (D.1) and open a **new** PowerShell                                                                   |
| `Cannot connect to Podman` / `podman info` fails  | Start the machine: `podman machine start`                                                                         |
| `Missing infra/local/.env`                        | Run `npm run local:env`                                                                                           |
| The build is killed or "out of memory"            | Give the machine 4 GB: `podman machine stop`, `podman machine set --memory 4096`, `podman machine start`          |
| `port is already allocated` (8080, 5433 or 4566)  | Another program uses the port. Close it, or change the left-hand number of the port in `infra/local/compose.yaml` |
| A service says `unhealthy`                        | `node tools/local/compose.mjs logs <service>`: the first red line names the setting or dependency                 |
| Sign-in fails after you changed `.env`            | The database still has the old administrator. `npm run local:reset` and start again                               |
| LocalStack exits with "License activation failed" | Someone changed its version to `latest`. It must stay `3.8.1` (see ADR-0019)                                      |
| The page loads but numbers stay at 0              | Events take a second or two. Wait, then reload. If it never changes, run `npm run local:smoke`                    |

## 7. A map of the project

| Folder               | What is in it                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `services/`          | The six backend services (identity, habit, event-tracking, challenge, insight, notification) |
| `lambdas/`           | The two AWS Lambda functions (streak, badge)                                                 |
| `packages/`          | Shared code: contracts, database helpers, outbox, privacy rules, the UI components           |
| `apps/web/`          | The SvelteKit web app                                                                        |
| `docs/architecture/` | How it is built, with diagrams, one document per part                                        |
| `docs/api/`          | The API of each service                                                                      |
| `docs/adr/`          | Why each big decision was made                                                               |
| `docs/guides/`       | These guides                                                                                 |

A good reading order: `README.md`, then `docs/architecture/01` to `03`, then the document of
whichever service you are curious about.

## 8. When something goes wrong

| What you see                                          | Likely cause and fix                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `'node' is not recognized`                            | Node.js is not installed or the window is old. Install it, open a **new** PowerShell                          |
| `npm ERR! ... EACCES` or file-lock errors on OneDrive | The project lives in a OneDrive folder that is syncing. Pause OneDrive sync, or copy the project to `C:\work` |
| `error TS...` after `npm run build`                   | Read the first error: it names a file. Make sure `npm install` finished; run it again                         |
| Tests time out or the computer freezes                | Close other programs. Run `npm run test:unit` first, then `npm run test:integration` alone                    |
| `Invalid configuration: DATABASE_URL: ...`            | A setting is missing in **this** window. Repeat block C.3. The message names the variable, never its value    |
| `password authentication failed for user "postgres"`  | The password in `DATABASE_URL` is wrong. Use the one you chose when installing PostgreSQL                     |
| `ECONNREFUSED 127.0.0.1:5432`                         | PostgreSQL is not running. Start the "postgresql" service (Services app) or reboot                            |
| `EADDRINUSE` (port already in use)                    | A previous copy is still running. Close its window, or choose another `$env:PORT`                             |
| Sign-in page says "Something went wrong"              | Identity is not running (window 1) or `COOKIE_SECURE` is not `false`. Check <http://localhost:3001/readyz>    |
| Signed in but pages are empty or show errors          | A service is down, or it was started without `IDENTITY_JWKS_URL`. Restart it with block C.3                   |
| The web app loses the sign-in when you reload         | Expected if Identity is down: the reload asks Identity for a new token with the cookie                        |
| "Done today" shows an error                           | Expected without the event bus (section 0)                                                                    |
| `npm run migrate` says a relation already exists      | You ran it against a half-reset database. `DROP DATABASE teampulse;` and start from C.1                       |

## 9. Words used in this guide

| Word                 | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Service              | A small program with one job (login, habits, challenges...) and its own data                          |
| Schema               | A folder of tables inside a PostgreSQL database                                                       |
| Migration            | A script that creates or changes tables, run once per change                                          |
| Event                | A short message such as "a habit was completed" that one service sends and others react to            |
| Event bus            | The mail system that carries events between services (EventBridge and SQS on AWS)                     |
| Outbox               | A table where a service writes its events together with its data, so none is lost; a relay sends them |
| Token                | A signed proof of who you are, sent with each request instead of your password                        |
| Environment variable | A setting given to a program from outside, such as the database address                               |
| Unit test            | A fast test of one rule with no database; an integration test uses the real database and HTTP         |

## 10. What comes next

- **Roadmap step 10** adds the automated pipeline (CI) and **step 11** the AWS infrastructure code.
- **Guide 2** covers deploying to AWS and **Guide 3** covers security; they are written once the
  infrastructure code (steps 9 to 12) exists, so that every step in them is one you can really follow.
