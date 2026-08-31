import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRestaurantConfig } from "../src/config/restaurants.ts";
import { StateConflictError, createStateStore, type StateStore } from "./state.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MAX_STATE_BODY_BYTES = 16 * 1024;

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ServerOptions {
  distDirectory?: string;
  restaurantsFile?: string;
  stateFile?: string;
}

class HttpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpInputError";
  }
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function sendJson(response: ServerResponse, status: number, value: unknown, headOnly: boolean): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(headOnly ? undefined : body);
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_STATE_BODY_BYTES) {
      throw new HttpInputError("The request body is too large.");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HttpInputError("The request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpInputError("The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredName(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpInputError(`${field} must be a restaurant name.`);
  }
  return value;
}

async function serveState(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  store: StateStore,
): Promise<void> {
  const method = request.method ?? "GET";
  if (pathname === "/api/state" && (method === "GET" || method === "HEAD")) {
    sendJson(response, 200, await store.read(), method === "HEAD");
    return;
  }

  if (method !== "POST") {
    sendText(response, 405, "Method not allowed.\n");
    return;
  }

  const body = await readJsonObject(request);
  if (pathname === "/api/state/accept") {
    const completesRedrop = body.completesRedrop;
    if (completesRedrop !== undefined && typeof completesRedrop !== "boolean") {
      throw new HttpInputError("completesRedrop must be a boolean.");
    }
    const state = await store.acceptWinner(requiredName(body, "winner"), {
      ...(typeof completesRedrop === "boolean" ? { completesRedrop } : {}),
    });
    sendJson(response, 200, state, false);
    return;
  }

  if (pathname === "/api/state/redrop") {
    const state = await store.recordRedrop(requiredName(body, "rejected"));
    sendJson(response, 200, state, false);
    return;
  }

  if (pathname === "/api/state/reset") {
    sendJson(response, 200, await store.resetWeek(), false);
    return;
  }

  sendText(response, 404, "Unknown API route.\n");
}

// The restaurant list is read from disk on every request, never cached. The
// page stays open between runs, so a run must see an edit with nothing
// restarted (R12). A file that is missing, is not valid JSON, or fails
// validation returns a 500 that names the bad field. It never falls back to an
// empty list, because that would hide the mistake and drop the group's
// restaurants without telling anyone.
async function serveRestaurants(
  response: ServerResponse,
  restaurantsFile: string,
  headOnly: boolean,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(restaurantsFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      sendJson(
        response,
        500,
        { error: { field: "(file)", message: `The restaurant file is missing: ${restaurantsFile}` } },
        headOnly,
      );
      return;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    sendJson(
      response,
      500,
      { error: { field: "(root)", message: `The restaurant file is not valid JSON: ${(error as Error).message}` } },
      headOnly,
    );
    return;
  }

  const result = parseRestaurantConfig(raw);
  if (!result.ok) {
    sendJson(response, 500, { error: { field: result.field, message: result.message } }, headOnly);
    return;
  }

  sendJson(response, 200, result.config, headOnly);
}

async function serveFile(
  response: ServerResponse,
  distDirectory: string,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(distDirectory, relativePath);
  const distPrefix = `${resolve(distDirectory)}${sep}`;

  if (filePath !== resolve(distDirectory) && !filePath.startsWith(distPrefix)) {
    sendText(response, 400, "Invalid path.\n");
    return;
  }

  try {
    await access(filePath);
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      sendText(response, 404, "Not found.\n");
      return;
    }

    response.writeHead(200, {
      "content-length": fileStats.size,
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });

    if (headOnly) {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const message = pathname === "/"
        ? "Build output is missing. Run npm run build before npm start.\n"
        : "Not found.\n";
      sendText(response, 404, message);
      return;
    }
    throw error;
  }
}

export function createLunchServer(options: ServerOptions = {}): Server {
  const distDirectory = options.distDirectory ?? resolve("dist");
  const restaurantsFile = options.restaurantsFile ?? resolve("data/restaurants.json");
  const stateFile = options.stateFile ?? resolve("data/state.json");
  const stateStore = createStateStore({ file: stateFile });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? DEFAULT_HOST}`);
      const headOnly = request.method === "HEAD";

      if (url.pathname === "/api/state" || url.pathname.startsWith("/api/state/")) {
        await serveState(request, response, url.pathname, stateStore);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed.\n");
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" }, headOnly);
        return;
      }

      if (url.pathname === "/api/restaurants") {
        await serveRestaurants(response, restaurantsFile, headOnly);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendText(response, 404, "Unknown API route.\n");
        return;
      }

      await serveFile(response, distDirectory, decodeURIComponent(url.pathname), headOnly);
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendJson(response, 400, { error: { code: "bad-request", message: error.message } }, false);
        return;
      }
      if (error instanceof StateConflictError) {
        sendJson(response, 409, { error: { code: "state-conflict", message: error.message } }, false);
        return;
      }
      console.error(error);
      if (!response.headersSent) {
        sendText(response, 500, "Internal server error.\n");
      } else {
        response.destroy(error as Error);
      }
    }
  });
}

export function listen(
  server: Server,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function main(): Promise<void> {
  const server = createLunchServer();
  await listen(server);
  console.log(`Lunch Plinko is listening at http://${DEFAULT_HOST}:${DEFAULT_PORT}`);

  const stop = async (): Promise<void> => {
    await close(server);
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error: unknown) => {
    console.error("Could not start Lunch Plinko.", error);
    process.exitCode = 1;
  });
}
