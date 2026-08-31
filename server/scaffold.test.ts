import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createLunchServer, listen } from "./index.ts";

function closeServer(server: ReturnType<typeof createLunchServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

describe("project scaffold", () => {
  const apiServer = createLunchServer();
  let viteServer: ViteDevServer;
  const originalApiPort = process.env.LUNCH_PLINKO_API_PORT;

  beforeAll(async () => {
    await listen(apiServer, 0);
    const apiAddress = apiServer.address() as AddressInfo;
    process.env.LUNCH_PLINKO_API_PORT = String(apiAddress.port);
    viteServer = await createViteServer({
      configFile: "vite.config.ts",
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    });
    await viteServer.listen();
  });

  afterAll(async () => {
    await viteServer.close();
    await closeServer(apiServer);
    if (originalApiPort === undefined) {
      delete process.env.LUNCH_PLINKO_API_PORT;
    } else {
      process.env.LUNCH_PLINKO_API_PORT = originalApiPort;
    }
  });

  it("proxies API requests from the Vite server", async () => {
    const address = viteServer.httpServer?.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves the production build from a loopback socket", async () => {
    const distDirectory = await mkdtemp(join(tmpdir(), "lunch-plinko-dist-"));
    const productionServer = createLunchServer({ distDirectory });

    try {
      await writeFile(join(distDirectory, "index.html"), "one fair ball", "utf8");
      await listen(productionServer, 0);
      const address = productionServer.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/`);

      expect(address.address).toBe("127.0.0.1");
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("one fair ball");
    } finally {
      await closeServer(productionServer);
      await rm(distDirectory, { force: true, recursive: true });
    }
  });

  it("declares the supported runtime and required scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };

    expect(packageJson.engines.node).toBe(">=22.18");
    expect(Object.keys(packageJson.scripts).sort()).toEqual([
      "build",
      "dev",
      "start",
      "test",
      "typecheck",
    ]);
  });
});
