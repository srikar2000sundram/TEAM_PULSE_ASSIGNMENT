# Event Tracking API

Base path: `/api/v1/event-tracking`. All bodies are JSON (`Content-Type: application/json`); other
content types get `415`. Every endpoint needs `Authorization: Bearer <access token>` issued by the
[Identity API](identity.md). Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`event-tracking.openapi.json`](event-tracking.openapi.json); a test fails if it drifts. A running
service also serves it at `/api/v1/event-tracking/openapi.json`.

## Endpoints

| Method | Path          | Purpose                                                    | Success |
| ------ | ------------- | ---------------------------------------------------------- | ------- |
| POST   | `/activities` | Record that you completed a habit on a day. Limit: 120/min | 201     |
| GET    | `/activities` | List your recorded activities, newest recorded first       | 200     |

Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

## Recording an activity

```http
POST /api/v1/event-tracking/activities
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{ "habitId": "5d3f...", "activityDate": "2026-11-20" }
```

```http
HTTP/1.1 201 Created

{
  "id": "9b1c...", "habitId": "5d3f...", "activityType": "walking",
  "activityDate": "2026-11-20", "createdAt": "2026-11-20T08:15:00.000Z",
  "alreadyRecorded": false
}
```

- The user, the activity type and the team snapshot are **not** in the request. They come from your
  token and from the habit, so nobody can record an activity for someone else. Extra fields are
  rejected with `400`.
- **Retrying is always safe.** One completion exists per user, habit and day. Sending the same
  request again returns the same activity with `"alreadyRecorded": true`, still `201`, and does not
  count the day twice. Simultaneous duplicates are handled too.
- **A new habit may take a moment.** The service learns about habits from events, so right after a
  habit is created this call can return `404 habit.not_found` for a short time. Retry shortly.

## Listing

`GET /activities?from=2026-11-01&to=2026-11-30&habitId=...&limit=50&cursor=...`

All filters are optional. `from` and `to` are inclusive days. The response is
`{ "items": [...], "nextCursor": "..." }`; pass `nextCursor` back as `cursor`. A missing
`nextCursor` means the last page. You only ever see your own activities.

## Error codes

Clients should branch on `code`, never on `detail`. Every error carries a `correlationId`, also the
`X-Correlation-Id` response header.

| Status | `code`                                     | Meaning                                                        |
| ------ | ------------------------------------------ | -------------------------------------------------------------- |
| 400    | `request.invalid`                          | Body, query or path failed validation; see `errors[]`          |
| 400    | `activity.date_in_future`                  | The day is more than one day ahead of today (UTC)              |
| 400    | `activity.date_too_old`                    | The day is beyond the back-fill window (7 days by default)     |
| 400    | `cursor.invalid`                           | Malformed cursor                                               |
| 401    | `auth.missing_token`, `auth.invalid_token` | No token, or expired, forged, or for another audience          |
| 404    | `habit.not_found`                          | No such habit, not yours, or not known to this service yet     |
| 409    | `habit.archived`                           | Archived habits accept no new activities                       |
| 415    | `http.unsupported_media_type`              | Send `application/json`                                        |
| 429    | `rate_limited`                             | Slow down; see `Retry-After`                                   |
| 500    | `internal_error`                           | A bug; nothing internal is revealed. Quote the `correlationId` |
| 503    | `service.unavailable`                      | A dependency is down; retry after `Retry-After` seconds        |

## Date rules

`activityDate` is a calendar day (`YYYY-MM-DD`) with no time zone. It may be today, up to 7 days
back, or tomorrow's UTC date (someone east of UTC is already there). "Today" is the server's UTC day.
There is no way to remove a recorded activity yet.
