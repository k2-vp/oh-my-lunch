# Manage a day

The server keeps one record per week in `data/state.json`. These are the moves you have while a day is in play.

## Use the re-drop

The reveal card offers two keys for 90 seconds. Enter accepts the winner. The re-drop key, R by default, rejects it and drops again with that lane closed.

- The re-drop works once per day. The second result offers Enter only.
- If nobody presses anything, the first result accepts itself when the window runs out.
- A rejected restaurant sits out for the rest of the day and returns tomorrow.

## Reopen a decided day

Reload the page after a winner is locked in. The board shows the decided day with its winner instead of starting a new run. This is the normal state for the rest of the afternoon.

## Reset a day

To erase the week's record and start today over:

```bash
curl -X POST http://127.0.0.1:4173/api/state/reset
```

Then reload the page. Use the port your server runs on. The reset erases the whole week, not just today, so use it for testing and mistakes rather than for a second opinion. The room already had its second opinion. That was the re-drop.

## Hand-edit the record

`data/state.json` is small and readable:

```json
{
  "week": "2026-W36",
  "date": "2026-08-31",
  "winners": { "2026-08-31": "Golden Bowl" },
  "rejectedToday": null,
  "redropUsed": false
}
```

Stop the server before you edit it by hand. The server validates the file when it reads it and refuses a malformed one.

## What Monday does

The record is keyed to the ISO week. On the first run of a new week the server starts a fresh record, and every restaurant is back in play.
