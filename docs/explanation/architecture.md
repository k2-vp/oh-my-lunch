# Architecture

The project is a static page plus a small Node server, with no framework and only two runtime dependencies: Three.js for the scene and a text-measurement library for the lane labels.

## The layers

```
data/restaurants.json      the list and the settings, owned by people
server/                    Node server: static files, config, the week's record
src/config/                validates the config and names the broken field
src/draw/                  the fair draw: who is in play, who wins
src/drop/                  geometry, deterministic physics, path selection
src/run/                   the day's choreography: countdown, balls, ties, re-drop
src/scene/                 Three.js board, HTML overlay, theme, celebration
src/main.ts                wires the layers together on page load
```

## One geometry, two consumers

`src/drop/geometry.ts` is the single source for every board measurement: peg positions, lane widths, wall thickness, the release point. Both the physics simulation and the rendered scene consume it. Neither declares a board number of its own, and a test scans the source tree to keep it that way. This is what makes the fairness argument airtight: the board you see is the board the simulation ran on.

The lattice is built per list size. Fourteen restaurants get a fourteen-lane board with the pegs to match.

## Decision first, rendering second

The modules form a strict order:

1. `draw` picks the destination lane with a flat draw. It knows nothing about physics.
2. `drop` finds a deterministic path that lands there. It knows nothing about restaurants.
3. `run` sequences the day: countdown, five balls, tie rounds, the confirm window.
4. `scene` renders whatever the run tells it. It never chooses anything.

Data flows one way. The renderer cannot influence the outcome because nothing downstream of the draw feeds back into it.

## The overlay

Text is HTML, not textures. The countdown, tallies, lane names, week panel, and reveal card are DOM elements positioned by projecting board coordinates to screen pixels. Text stays crisp at any resolution, and the browser tests can assert on real elements instead of reading pixels. The lane names measure themselves with the same font stack they render in, so a name never wraps differently than the fitting math predicted.

## The server

`server/index.ts` uses only the Node standard library. It serves the built page, reads the config fresh on every request, and owns `data/state.json`, the week's record. State changes go through explicit endpoints with conflict checks, so a stale page cannot double-record a day.

## Tests

Two vitest projects:

- **node** runs the pure logic: the draw proofs, the simulation proofs, the sequence choreography, config validation, and the server.
- **browser** runs headless Chromium for everything visual: label fitting, theme rendering, overlay layout, and the harness states.

`harness.html` drives the scene through fixture states for eyes-on checks, and `scripts/e2e-redrop.ts` plays a full day against a real dev server with real key presses.
