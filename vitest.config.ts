import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const PATH_SELECTION_PROOFS = [
  "src/drop/select.test.ts",
  "src/run/tie-closure.test.ts",
];

// Three projects, split by where and when a test can execute.
//
// Most of the code is pure: the draw, the week rollover, the physics, and the
// server. Those run in the fast Node runner with no browser at all.
//
// The scene and label code measures text through a real canvas context. pretext
// reads glyph metrics from CanvasRenderingContext2D, which Node and jsdom do not
// provide, so those tests run in headless Chromium instead. Without this split
// the label tests would be files that cannot run.
//
// The path-selection proofs simulate every legal tie board, both to select a
// path for each one and to prove the tie round closes it. They stay in the full
// suite, but run after the regular Node and browser projects so competing
// workers cannot spend their timeout budget.
//
// Routing rule, so a test lands in the right runner without anyone having to
// remember a flag:
//   - anything under src/scene/ needs canvas, so it goes to the browser runner
//   - any file named *.browser.test.ts goes to the browser runner
//   - the path-selection proofs run last in their own one-worker Node project
//   - everything else runs in the regular Node project
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "server/**/*.test.ts",
            "scripts/**/*.test.ts",
            "src/**/*.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "src/scene/**",
            "**/*.browser.test.ts",
            ...PATH_SELECTION_PROOFS,
          ],
        },
      },
      {
        test: {
          name: "browser",
          include: [
            "src/scene/**/*.test.ts",
            "src/**/*.browser.test.ts",
          ],
          exclude: ["**/node_modules/**"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        test: {
          name: "slow-path-selection",
          environment: "node",
          include: PATH_SELECTION_PROOFS,
          exclude: ["**/node_modules/**"],
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
