# Challenge API

Base path: `/api/v1/challenge`. All bodies are JSON (`Content-Type: application/json`); other content
types get `415`. Every endpoint needs `Authorization: Bearer <access token>` issued by the
[Identity API](identity.md). Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`challenge.openapi.json`](challenge.openapi.json); a test fails if it drifts. A running service also
serves it at `/api/v1/challenge/openapi.json`.

## Endpoints

| Method | Path                           | Who                                        | Purpose                                              | Success |
| ------ | ------------------------------ | ------------------------------------------ | ---------------------------------------------------- | ------- |
| POST   | `/challenges`                  | managers of the team, admins               | Create a challenge (a draft). Limit: 30/min          | 201     |
| GET    | `/challenges`                  | any signed-in user                         | Challenges you may see, newest first                 | 200     |
| GET    | `/challenges/{id}`             | who may see it                             | One challenge                                        | 200     |
| POST   | `/challenges/{id}/start`       | managers of the team, admins               | Start a draft now. Limit: 30/min                     | 200     |
| POST   | `/challenges/{id}/cancel`      | managers of the team, admins               | Cancel a draft or active challenge. Limit: 30/min    | 200     |
| POST   | `/challenges/{id}/join`        | members of the team                        | Join an active challenge (idempotent). Limit: 30/min | 200     |
| GET    | `/challenges/{id}/leaderboard` | participants, managers of the team, admins | The standings                                        | 200     |
| GET    | `/challenges/{id}/progress`    | participants                               | Your points, streak and badges                       | 200     |

Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

Points, badges and completion are not set through the API: activities score automatically, and the
service moves challenges through their calendar.

## Creating a challenge

```http
POST /api/v1/challenge/challenges
Content-Type: application/json

{
  "name": "Walk the world",
  "activityType": "walking",
  "teamId": "7a1f...",
  "startsOn": "2026-11-20",
  "endsOn": "2026-11-30",
  "badgeRules": [
    { "kind": "streak", "threshold": 5 },
    { "kind": "total", "threshold": 20 }
  ]
}
```

```http
HTTP/1.1 201 Created

{
  "id": "c0de...", "name": "Walk the world", "activityType": "walking", "teamId": "7a1f...",
  "startsOn": "2026-11-20", "endsOn": "2026-11-30", "status": "draft",
  "badgeRules": [{ "id": "b4d6...", "kind": "streak", "threshold": 5 }, { "id": "f00d...", "kind": "total", "threshold": 20 }],
  "participantCount": 0, "joined": false, "createdAt": "2026-11-20T08:00:00.000Z"
}
```

- A manager can create challenges for the teams they manage, an administrator for any team.
- Only activities of `activityType` score, on days from `startsOn` to `endsOn`, both included. A
  challenge lasts at most 366 days and its last day cannot be in the past.
- Badge rules (at most ten, thresholds 1 to 1000, no repeats): `streak` is the longest run of
  consecutive days with an activity, `total` is the number of activities, `milestone` is the number
  of different days with an activity. Each is awarded once per person when met.
- A new challenge is a **draft**: only managers of its team, its creator and administrators can see
  it, and nobody can join it. Start it with `/start`, or it starts by itself on `startsOn`.
- Unknown fields are rejected.

## Lifecycle

```text
draft --start--> active --(last day and a grace day pass)--> completed
  |                |
  +----cancel------+--> cancelled
```

`start` and `cancel` in a state that does not allow them return `409 challenge.invalid_state`.

## Listing

`GET /challenges?status=active&limit=50&cursor=...`

- Returns the challenges you may see: those of your teams once started, those you manage (drafts
  included), and all for administrators.
- `joined` says whether you take part; `participantCount` how many people do.
- `nextCursor` is opaque; pass it back as `cursor`. A missing `nextCursor` means the last page.
- A challenge you may not see is absent here and gives `404` when asked for by id, exactly like one
  that does not exist.

## Leaderboard and progress

`GET /challenges/{id}/leaderboard?limit=50`

```http
HTTP/1.1 200 OK

{
  "challengeId": "c0de...", "status": "active", "participantCount": 12,
  "entries": [
    { "rank": 1, "userId": "a1...", "points": 14, "isYou": false },
    { "rank": 2, "userId": "b1...", "points": 11, "isYou": true },
    { "rank": 2, "userId": "c1...", "points": 11, "isYou": false }
  ],
  "you": { "rank": 2, "points": 11 }
}
```

- Equal points share a rank and the next rank is skipped (1, 2, 2, 4).
- `you` is your place even when you are not among the entries shown; it is absent if you are not
  taking part (managers and administrators reading the standings).
- Another member of the team who has not joined gets `403 challenge.not_participant`: they know the
  challenge exists, but not who is winning.

`GET /challenges/{id}/progress`

```http
HTTP/1.1 200 OK

{
  "challengeId": "c0de...", "points": 11, "activeDays": 9, "longestStreak": 5,
  "badges": [{ "badgeRuleId": "b4d6...", "kind": "streak", "threshold": 5, "awardedOn": "2026-11-24" }]
}
```

## Error codes

Clients should branch on `code`, never on `detail`. Every error carries a `correlationId`, also the
`X-Correlation-Id` response header.

| Status | `code`                                                                                                                                                                 | Meaning                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 400    | `request.invalid`                                                                                                                                                      | Body, query or path failed validation; see `errors[]`                      |
| 400    | `cursor.invalid`                                                                                                                                                       | Malformed cursor                                                           |
| 400    | `challenge.in_the_past`                                                                                                                                                | The challenge would already be over (creating, or starting one that ended) |
| 400    | `challenge.name_invalid`, `challenge.dates_invalid`, `challenge.too_long`, `challenge.too_many_badges`, `challenge.badges_repeat`, `challenge.badge_threshold_invalid` | A rule of the domain, checked again after the schema                       |
| 401    | `auth.missing_token`, `auth.invalid_token`                                                                                                                             | No token, or expired, forged, or for another audience                      |
| 403    | `challenge.team_not_managed`                                                                                                                                           | Creating a challenge for a team you do not manage                          |
| 403    | `challenge.not_manager`                                                                                                                                                | You can see the challenge but may not start or cancel it                   |
| 403    | `challenge.team_not_member`                                                                                                                                            | Joining a challenge of a team you are not a member of                      |
| 403    | `challenge.not_participant`                                                                                                                                            | Standings and progress are for people taking part                          |
| 404    | `challenge.not_found`                                                                                                                                                  | No such challenge, or not one you may see                                  |
| 404    | `route.not_found`                                                                                                                                                      | No such endpoint                                                           |
| 409    | `challenge.invalid_state`                                                                                                                                              | The challenge is not in a state that allows this                           |
| 409    | `challenge.not_joinable`                                                                                                                                               | Not active, or its last day has passed                                     |
| 415    | `http.unsupported_media_type`                                                                                                                                          | Send `application/json`                                                    |
| 429    | `rate_limited`                                                                                                                                                         | Slow down; see `Retry-After`                                               |
| 500    | `internal_error`                                                                                                                                                       | A bug; nothing internal is revealed. Quote the `correlationId`             |
| 503    | `service.unavailable`                                                                                                                                                  | The database is down; retry after `Retry-After` seconds                    |
