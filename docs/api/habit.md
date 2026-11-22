# Habit API

Base path: `/api/v1/habit`. All bodies are JSON (`Content-Type: application/json`); other content
types get `415`. Every endpoint needs `Authorization: Bearer <access token>` issued by the
[Identity API](identity.md). Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`habit.openapi.json`](habit.openapi.json); a test fails if it drifts. A running service also serves
it at `/api/v1/habit/openapi.json`.

## Endpoints

| Method | Path                        | Purpose                                                             | Success |
| ------ | --------------------------- | ------------------------------------------------------------------- | ------- |
| POST   | `/habits`                   | Create a habit. Limit: 30 per minute                                | 201     |
| GET    | `/habits`                   | List your habits, or habits teammates shared with your teams        | 200     |
| GET    | `/habits/{habitId}`         | One habit you may see                                               | 200     |
| PATCH  | `/habits/{habitId}`         | Change your habit: details, sharing, reminder. Limit: 60 per minute | 200     |
| POST   | `/habits/{habitId}/archive` | Archive your habit. Idempotent. Limit: 60 per minute                | 200     |

Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

Nobody is special here: admins and managers see exactly what any other person would. See
[08 Habit Service](../architecture/08-habit-service.md).

## Examples

### Create a private habit with a reminder

```http
POST /api/v1/habit/habits
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{
  "title": "Morning walk",
  "activityType": "walking",
  "reminder": { "daysOfWeek": ["mon", "wed", "fri"], "remindAt": "07:30", "timeZone": "Europe/Berlin" }
}
```

```http
HTTP/1.1 201 Created

{
  "id": "5d3f...", "ownerUserId": "a1...", "isOwner": true,
  "title": "Morning walk", "activityType": "walking", "visibility": "private",
  "reminder": { "daysOfWeek": ["mon", "wed", "fri"], "remindAt": "07:30", "timeZone": "Europe/Berlin" },
  "createdAt": "2026-11-20T08:00:00.000Z", "updatedAt": "2026-11-20T08:00:00.000Z"
}
```

`visibility` defaults to `private`. To share, send `"visibility": "team", "teamId": "<one of your teams>"`.

### Share an existing habit, and clear its reminder

```http
PATCH /api/v1/habit/habits/5d3f...
Content-Type: application/json

{ "visibility": "team", "teamId": "71...", "reminder": null }
```

`null` clears an optional field (`description`, `reminder`); an absent field is left alone. A sharing
change always names both `visibility` and `teamId` (or `visibility: "private"` alone).

### What teammates shared with you

`GET /habits?scope=team` (optionally `&teamId=...`, `&activityType=yoga`). `GET /habits?status=archived`
lists your archived habits. Paging: `?limit=50` returns `{ "items": [...], "nextCursor": "..." }`;
pass `nextCursor` back as `?cursor=...`. The cursor is opaque; a missing `nextCursor` means the last
page. Newest first.

## Error codes

Clients should branch on `code`, never on `detail`. Every error carries a `correlationId`, also the
`X-Correlation-Id` response header.

| Status | `code`                                             | Meaning                                                        |
| ------ | -------------------------------------------------- | -------------------------------------------------------------- |
| 400    | `request.invalid`                                  | Body, query or path failed validation; see `errors[]`          |
| 400    | `habit.title_invalid`, `habit.description_invalid` | Field-level business validation                                |
| 400    | `habit.sharing_invalid`, `cursor.invalid`          | Inconsistent sharing fields; malformed cursor                  |
| 401    | `auth.missing_token`, `auth.invalid_token`         | No token, or expired, forged, or for another audience          |
| 403    | `habit.not_owner`                                  | You can see this shared habit but only its owner can change it |
| 403    | `habit.team_not_member`                            | You can only share with teams you belong to                    |
| 404    | `habit.not_found`                                  | Does not exist **or you may not know it exists**               |
| 404    | `route.not_found`                                  | No such endpoint                                               |
| 409    | `habit.archived`                                   | An archived habit cannot be changed                            |
| 409    | `habit.limit_reached`                              | At most 50 active habits; archive one first                    |
| 415    | `http.unsupported_media_type`                      | Send `application/json`                                        |
| 429    | `rate_limited`                                     | Slow down; see `Retry-After`                                   |
| 500    | `internal_error`                                   | A bug; nothing internal is revealed. Quote the `correlationId` |
| 503    | `service.unavailable`                              | A dependency is down; retry after `Retry-After` seconds        |

## Field rules

- `title`: 1 to 80 characters after trimming. `description`: at most 500; blank means none.
- `activityType`: `walking`, `running`, `cycling`, `strength`, `yoga`, `meditation`, `sleep`,
  `hydration`, `nutrition`, `other`.
- `reminder`: 1 to 7 distinct `daysOfWeek` (`mon` to `sun`), `remindAt` as `HH:mm`, and an IANA
  `timeZone` such as `Europe/Berlin`.
- The owner is always the caller. A request that includes `ownerUserId` is rejected.
