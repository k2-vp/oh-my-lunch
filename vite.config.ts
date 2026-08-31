import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const apiPort = process.env.LUNCH_PLINKO_API_PORT ?? "4173";

  // The URL test controls exist only outside a production build. A plain
  // `vite build` runs in production mode and compiles the flag to false, so the
  // control branch and its parameter names are dropped from the bundle. The e2e
  // build passes `--mode e2e` to keep them. The dev-only harness page is a
  // separate HTML file that is never a build input, so it is absent from dist
  // regardless of this flag.
  const testControls = mode !== "production";

  return {
    define: {
      __PLINKO_TEST_CONTROLS__: JSON.stringify(testControls),
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
