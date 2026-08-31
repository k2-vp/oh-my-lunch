# HTTP API

The server exposes a small JSON API next to the static page. In development the Vite server proxies `/api` through to it, so the same paths work on port 5173 and port 4173.

All responses are JSON except the plain-text errors for wrong methods and unknown routes.

## GET /api/health

Returns `{ "ok": true }` when the server is up.

## GET /api/restaurants

Returns the validated configuration from `data/restaurants.json`. If the file is invalid, the response is an error object that names the broken field:

```json
{ "error": { "field": "settings.mode", "message": "must be auto, light, or dark" } }
```

## GET /api/state

Returns the current week's record. The server rolls to a fresh record when the ISO week changes.

```json
{
  "week": "2026-W36",
  "date": "2026-08-31",
  "winners": { "2026-08-31": "Golden Bowl" },
  "rejectedToday": null,
  "redropUsed": false
}
```

| Field | Meaning |
|---|---|
| `week` | ISO year and week, `YYYY-Www` |
| `date` | Today, as a local ISO date |
| `winners` | Accepted winner per date, for this week |
| `rejectedToday` | The restaurant rejected by today's re-drop, or null |
| `redropUsed` | True once today's re-drop is spent |

## POST /api/state/accept

Records today's winner. The board calls this when the host presses Enter or the window runs out.

Body: `{ "winner": "Golden Bowl" }`. Add `"completesRedrop": true` when the accepted result came from a re-drop. Returns the updated record.

## POST /api/state/redrop

Records that today's first result was rejected. Body: `{ "rejected": "Golden Bowl" }`. Returns the updated record.

## POST /api/state/reset

Erases the week's record and returns the fresh one. No body needed.

## Errors

| Status | Meaning |
|---|---|
| 400 | Bad input, such as a missing `winner` field |
| 404 | Unknown API route |
| 405 | Wrong method on a state route |
| 409 | The change conflicts with the recorded state, for example a second re-drop on the same day |
