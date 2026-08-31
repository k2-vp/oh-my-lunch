import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const children: ChildProcess[] = [];
let stopping = false;

function start(name: string, arguments_: string[]): ChildProcess {
  const child = spawn(process.execPath, arguments_, {
    env: process.env,
    stdio: "inherit",
  });

  children.push(child);
  child.once("error", (error) => {
    console.error(`${name} could not start.`, error);
    void stop(1);
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    console.error(`${name} stopped with ${reason}.`);
    void stop(code ?? 1);
  });

  return child;
}

async function stop(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  await Promise.all(children.map((child) => new Promise<void>((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    child.once("exit", () => resolvePromise());
  })));

  process.exit(exitCode);
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

start("API server", ["--watch", "server/index.ts"]);
start("Vite", [resolve("node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"]);
