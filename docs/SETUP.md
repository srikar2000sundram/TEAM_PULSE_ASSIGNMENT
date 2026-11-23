# Setup guide: run TeamPulse locally with Docker Compose

This starts the whole platform on your computer with one command: PostgreSQL, a local stand-in for AWS
(LocalStack), the seven services, the streak and badge functions, and the web app. It is the same
code and settings as in AWS; only the place differs ([14 Local stack](architecture/14-local-stack.md)).

## What you need

| Need                                 | Notes                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Node.js 22 or newer and npm          | `node --version`                                                                    |
| Docker (with Compose) **or** Podman  | `docker --version` or `podman --version`. The scripts pick Docker, otherwise Podman |
| About 4 GB of free memory, 5 GB disk | With Podman: `podman machine set --memory 4096` before `podman machine start`       |
| Git                                  | To clone the repository                                                             |

## Steps

1. **Get the code and install**

   ```bash
   git clone https://github.com/srikar2000sundram/TEAM_PULSE_ASSIGNMENT.git
   cd TEAM_PULSE_ASSIGNMENT
   npm ci
   ```

2. **Create your local secrets** (random values, written to `infra/local/.env`, never committed)

   ```bash
   npm run local:env
   ```

3. **Start everything** (the first run builds the images and takes several minutes)

   ```bash
   npm run local:up
   ```

   It builds the backend and web images, starts PostgreSQL and LocalStack, creates the tables and the
   first administrator, creates the event bus, queues and rules, then starts the services and the web
   app. It ends when every service reports healthy.

4. **Check it is healthy**

   ```bash
   node tools/local/compose.mjs ps
   ```

   Every service should say `healthy` (`migrate` and `aws-setup` say `exited (0)`: they are one-off jobs).

5. **Add demo data** (people, a team, a challenge, one habit each, and a week of history for Ada)

   ```bash
   node tools/local/seed-demo.mjs
   node tools/local/seed-history.mjs
   ```

6. **Open the app** at <http://localhost:8080>

   | Sign in as          | Role          | Password                                 |
   | ------------------- | ------------- | ---------------------------------------- |
   | `ada@example.com`   | employee      | `demo-passphrase-123`                    |
   | `maria@example.com` | manager       | `demo-passphrase-123`                    |
   | `admin@example.com` | administrator | in `infra/local/.env` (`ADMIN_PASSWORD`) |

   The demo password exists only on your computer and only in the seed script.

7. **Run the end-to-end check** (optional, about a minute)

   ```bash
   npm run local:smoke
   ```

   It creates fresh people and follows an activity through the habit, the event bus, the streak,
   points, badge and notification, and the privacy-protected team report. It ends with
   `All checks passed`.

## Day to day

| Command                                   | Does                                       |
| ----------------------------------------- | ------------------------------------------ |
| `npm run local:down`                      | Stop everything, keep the data             |
| `npm run local:up`                        | Start again                                |
| `npm run local:reset`                     | Stop and **delete all data** (start fresh) |
| `node tools/local/compose.mjs logs habit` | Read one service's log (any service name)  |

## Run the tests instead (no containers needed)

```bash
npm run verify    # formatting, build, lint, types, all tests, diagram check
```

## If something goes wrong

| Symptom                                 | Fix                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Neither docker nor podman was found`   | Install one, then open a **new** terminal                                                                        |
| `Missing infra/local/.env`              | Run `npm run local:env`                                                                                          |
| The build is killed or out of memory    | Give the engine 4 GB (Podman: `podman machine stop`, `podman machine set --memory 4096`, `podman machine start`) |
| A service stays `unhealthy`             | `node tools/local/compose.mjs logs <service>`: the first red line names the problem                              |
| Sign-in fails after you edited `.env`   | The database still holds the old administrator: `npm run local:reset`, then start again                          |
| Numbers stay at 0 right after an action | Events take a second or two; reload. If it never changes, run `npm run local:smoke`                              |
| Recommendations page is empty           | A habit needs 5 completions in one hour of the day. Run `node tools/local/seed-history.mjs`                      |
