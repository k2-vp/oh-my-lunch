# Controls

## Keys

The page listens for keys on the machine that shows it. Nothing on screen is clickable except the two footer links.

| Key | When | What it does |
|---|---|---|
| Enter | Reveal card is open | Accepts the winner and records it |
| R (configurable) | Reveal card is open, re-drop not yet used today | Rejects the winner, closes that lane, and drops again |

The reveal card stays open for `redropWindowSeconds`, 90 by default. When the window runs out, the first result accepts itself. The result after a re-drop is final and offers Enter only.

Change the re-drop key with `settings.redropKey` in the [configuration](configuration.md).

## URL parameters

These exist for development and testing. They work on the dev server. A production build ignores them.

| Parameter | Effect |
|---|---|
| `fast=1` | Shrinks the countdown, the pauses, and the ball animation so a full run takes a few seconds |
| `seedStart=N` | Starts the seed sequence at N, so a run can be replayed exactly |
| `seedCount=N` | How many seeds the sequence provides |

Example: `http://127.0.0.1:5173/?fast=1&seedStart=7` runs the same drop every time you load it.

## The harness

`harness.html` on the dev server shows every visual state of the board side by side, with fixture data: countdown, tallies, ties, spent lanes, the reveal, and the locked-in card. Open http://127.0.0.1:5173/harness.html and click through the states. It is the fastest way to check a visual change without playing a full round.
