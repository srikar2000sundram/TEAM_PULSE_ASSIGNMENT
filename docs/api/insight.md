# Insight API

Base path: `/api/v1/insight`. Every endpoint is a `GET` and needs `Authorization: Bearer <access token>`
issued by the [Identity API](identity.md). Errors are
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`insight.openapi.json`](insight.openapi.json); a test fails if it drifts. A running service also
serves it at `/api/v1/insight/openapi.json`.

## Endpoints

| Method | Path                       | Who                                   | Purpose                                     | Success |
| ------ | -------------------------- | ------------------------------------- | ------------------------------------------- | ------- |
| GET    | `/teams/{teamId}/activity` | members, managers of the team, admins | A team's activity, small groups hidden      | 200     |
| GET    | `/organization/activity`   | administrators                        | The whole organisation, small groups hidden | 200     |
| GET    | `/me/activity`             | any signed-in user                    | Your own activity                           | 200     |

All three take the period as query parameters: `from` and `to`, both `YYYY-MM-DD` and both included,
at most 92 days apart. Rate limits: 60 per minute for team and organisation reports, 120 for your own.
Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

Insight has no endpoint to write anything: it learns about activity from events.

## Team and organisation reports

`GET /teams/{teamId}/activity?from=2026-11-01&to=2026-11-30`

```http
HTTP/1.1 200 OK

{
  "scope": "team",
  "teamId": "7a1f...",
  "from": "2026-11-01",
  "to": "2026-11-30",
  "minCohortSize": 5,
  "total": { "suppressed": false, "completions": 132, "participants": 11 },
  "byActivityType": {
    "walking": { "suppressed": false, "completions": 80, "participants": 9 },
    "yoga": { "suppressed": true, "reason": "cohort_too_small" },
    "cycling": { "suppressed": true, "reason": "complementary" }
  },
  "byDay": [
    { "date": "2026-11-19", "cell": { "suppressed": false, "completions": 24, "participants": 8 } },
    { "date": "2026-11-20", "cell": { "suppressed": false, "completions": 31, "participants": 9 } }
  ]
}
```

- A number is shown only when at least `minCohortSize` **different people** stand behind it. A hidden
  cell has **no number and no group size**, only a `reason`.
- `cohort_too_small`: fewer people than the minimum.
- `complementary`: a number that could have been shown was hidden as well, because with exactly one
  hidden number in a breakdown the reader could otherwise work it out by subtraction. Treat both
  reasons as "not enough participants" in the interface.
- If the total is hidden, everything is hidden.
- Only activity types and days that have data are listed.
- `participants` is how many different people, not how many completions; one person doing ten
  activities is one participant.
- The administrator's organisation report has `"scope": "organization"` and no `teamId`.
- Reports contain no user ids.

## Your own activity

`GET /me/activity?from=2026-11-01&to=2026-11-30`

```http
HTTP/1.1 200 OK

{
  "from": "2026-11-01",
  "to": "2026-11-30",
  "total": 14,
  "byActivityType": { "walking": 9, "yoga": 5 },
  "byDay": [{ "date": "2026-11-19", "completions": 2 }, { "date": "2026-11-20", "completions": 1 }]
}
```

Nothing is hidden: the numbers are about you alone. There is no way to ask for another person.

## Error codes

Clients should branch on `code`, never on `detail`. Every error carries a `correlationId`, also the
`X-Correlation-Id` response header.

| Status | `code`                                     | Meaning                                                                |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| 400    | `request.invalid`                          | Missing, reversed or over-long period, malformed id, unknown parameter |
| 401    | `auth.missing_token`, `auth.invalid_token` | No token, or expired, forged, or for another audience                  |
| 403    | `auth.forbidden`                           | The organisation report is for administrators                          |
| 404    | `team.not_found`                           | No such team, or not one you may read                                  |
| 404    | `route.not_found`                          | No such endpoint                                                       |
| 429    | `rate_limited`                             | Slow down; see `Retry-After`                                           |
| 500    | `internal_error`                           | A bug; nothing internal is revealed. Quote the `correlationId`         |
| 503    | `service.unavailable`                      | The data store is down; retry after `Retry-After` seconds              |
