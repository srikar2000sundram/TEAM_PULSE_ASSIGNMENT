# Notification API

Base path: `/api/v1/notification`. All bodies are JSON (`Content-Type: application/json`); other
content types get `415`. Every endpoint needs `Authorization: Bearer <access token>` issued by the
[Identity API](identity.md), and only ever touches the caller's own data. Errors are
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`notification.openapi.json`](notification.openapi.json); a test fails if it drifts. A running
service also serves it at `/api/v1/notification/openapi.json`.

## Endpoints

| Method | Path                       | Purpose                                       | Success |
| ------ | -------------------------- | --------------------------------------------- | ------- |
| GET    | `/notifications`           | List your notifications, newest first         | 200     |
| POST   | `/notifications/{id}/read` | Mark one as read (idempotent). Limit: 120/min | 200     |
| GET    | `/preferences`             | Which kinds you receive                       | 200     |
| PATCH  | `/preferences`             | Switch kinds on or off. Limit: 30/min         | 200     |

Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

Notifications are created by the service itself from events (milestones, badges, challenge results,
habit reminders); there is no endpoint to create one.

## Listing

`GET /notifications?unread=true&limit=50&cursor=...`

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "9b1c...", "kind": "milestone", "title": "Streak milestone",
      "body": "You kept a habit going for 30 days in a row. Well done!",
      "createdAt": "2026-11-20T08:00:00.000Z"
    }
  ],
  "unreadCount": 3,
  "nextCursor": "..."
}
```

- `readAt` appears once a notification has been read.
- `unreadCount` is the total number of unread notifications, not only those on this page, so it can
  drive a badge in the UI.
- `nextCursor` is opaque; pass it back as `cursor`. A missing `nextCursor` means the last page.
- Kinds: `milestone`, `badge`, `challenge_completed`, `reminder`. The `title` and `body` are
  ready to display and may change wording over time; branch on `kind`, not on the text.

## Preferences

```http
PATCH /api/v1/notification/preferences
Content-Type: application/json

{ "reminders": false }
```

```http
HTTP/1.1 200 OK

{ "milestones": true, "badges": true, "challenges": true, "reminders": false }
```

Everything is on until you switch it off. Only the categories you send change. Switching a category
off stops new notifications of that kind; existing ones stay.

## Error codes

Clients should branch on `code`, never on `detail`. Every error carries a `correlationId`, also the
`X-Correlation-Id` response header.

| Status | `code`                                     | Meaning                                                        |
| ------ | ------------------------------------------ | -------------------------------------------------------------- |
| 400    | `request.invalid`                          | Body, query or path failed validation; see `errors[]`          |
| 400    | `cursor.invalid`                           | Malformed cursor                                               |
| 401    | `auth.missing_token`, `auth.invalid_token` | No token, or expired, forged, or for another audience          |
| 404    | `notification.not_found`                   | No such notification, or it is not yours                       |
| 404    | `route.not_found`                          | No such endpoint                                               |
| 415    | `http.unsupported_media_type`              | Send `application/json`                                        |
| 429    | `rate_limited`                             | Slow down; see `Retry-After`                                   |
| 500    | `internal_error`                           | A bug; nothing internal is revealed. Quote the `correlationId` |
| 503    | `service.unavailable`                      | A dependency is down; retry after `Retry-After` seconds        |
