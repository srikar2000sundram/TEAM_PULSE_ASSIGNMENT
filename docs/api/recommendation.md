# Recommendation API

Base path: `/api/v1/recommendation`. All bodies are JSON (`Content-Type: application/json`); other
content types get `415`. Every endpoint needs `Authorization: Bearer <access token>` issued by the
[Identity API](identity.md), and only ever touches the caller's own data. Errors are
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details (`application/problem+json`).

The machine-readable description is generated from the code and committed as
[`recommendation.openapi.json`](recommendation.openapi.json); a test fails if it drifts. A running
service also serves it at `/api/v1/recommendation/openapi.json`.

## Endpoints

| Method | Path                                 | Purpose                                               | Success |
| ------ | ------------------------------------ | ----------------------------------------------------- | ------- |
| GET    | `/recommendations?timeZone=...`      | Your timing recommendations, strongest evidence first | 200     |
| POST   | `/recommendations/{habitId}/accept`  | Accept a recommendation (idempotent). Limit: 60/min   | 200     |
| POST   | `/recommendations/{habitId}/dismiss` | Dismiss a recommendation (idempotent). Limit: 60/min  | 200     |

Operational endpoints (no `/api/v1` prefix): `GET /healthz`, `GET /readyz`.

Recommendations are built by the service itself from your completed habits (the `ActivityCompleted`
event). There is no endpoint to create one, and no way to see anyone else's.

## Listing

`GET /recommendations?timeZone=Europe/Berlin`. `timeZone` is required: an IANA zone name.

```http
HTTP/1.1 200 OK

{
  "items": [
    {
      "habitId": "6f1c...",
      "suggestedTime": "07:00",
      "timeZone": "Europe/Berlin",
      "sampleSize": 6,
      "matching": 5,
      "confidence": "high",
      "status": "pending"
    }
  ]
}
```

- A habit appears only once it has at least 5 completions in the last 60 days and one hour of the day
  holds at least 40 % of them. Otherwise there is nothing to recommend, and the list is empty.
- `suggestedTime` is the start of the person's busiest hour, in `timeZone`.
- `confidence` is `high` (70 % or more of completions in that hour), `medium` (50 % or more) or `low`.
- `status` is `pending`, `accepted` or `dismissed`, for exactly this suggestion (habit, time, zone).
  If the pattern later moves to a different hour, a new `pending` suggestion appears.

## Accepting and dismissing

```http
POST /api/v1/recommendation/recommendations/6f1c.../accept
Content-Type: application/json

{ "suggestedTime": "07:00", "timeZone": "Europe/Berlin" }
```

```http
HTTP/1.1 200 OK

{ "habitId": "6f1c...", "suggestedTime": "07:00", "timeZone": "Europe/Berlin", "status": "accepted" }
```

The time and zone are sent back so the decision is about the suggestion the person saw. Deciding the
same way twice changes nothing; deciding the other way replaces the earlier decision.

**Accepting does not itself change the habit.** The web app then sets the habit's reminder with
`PATCH /api/v1/habit/habits/{habitId}` (`reminder`: every day at `suggestedTime` in `timeZone`).

## Errors

| Status | Code                                       | When                                                      |
| ------ | ------------------------------------------ | --------------------------------------------------------- |
| 400    | `validation`                               | Missing or unknown `timeZone`, bad time, undeclared field |
| 401    | `auth.missing_token`, `auth.invalid_token` | Missing, expired or wrongly addressed token               |
| 429    | `rate_limited`                             | Too many requests                                         |
| 503    | `service.unavailable`                      | The database is briefly unavailable; retry shortly        |
