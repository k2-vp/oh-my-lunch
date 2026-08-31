# Getting started

This walk takes about ten minutes. At the end, the board has picked a lunch and recorded it.

## What you need

- Node 22.18 or newer
- A browser

## 1. Install and run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. You get the board with its sample list of fourteen restaurants along the bottom, a countdown on the left, and the week panel on the right.

## 2. Watch the drop

The countdown runs for 60 seconds, then five balls drop, one at a time. Each ball rattles through the pegs and lands in a lane. The tallies above the lanes count the votes.

If two or more lanes tie for the lead, the board closes every other lane and drops one deciding ball. Whatever it hits wins.

## 3. Lock it in

A card appears with the winner. You have 90 seconds to act:

- Press **Enter** to accept. The card shows a green check, and the pick is final.
- Press **R** to reject and drop again. The rejected lane closes, the remaining lanes spread out, and the next result is final.
- Do nothing, and the first result accepts itself when the window runs out.

## 4. Look at the record

The winner now sits in the week panel under today. Reload the page: the board shows the decided day instead of starting a new countdown. The record lives in `data/state.json`, one small JSON file you can read and delete.

Tomorrow the board runs again, with yesterday's winner sitting out. On Monday everyone is back in.

## Next steps

- Put your own restaurants on the board: [edit the lunch list](../how-to/edit-the-lunch-list.md).
- Move it to the room where lunch gets decided: [put it on the office TV](../how-to/put-it-on-the-office-tv.md).
