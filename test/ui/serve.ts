// Starts the real app (app/server.ts) for a browser test on a port the OS picks.
// Fixed ports per file used to collide when the full suite ran files side by side:
// the second server failed to bind, and its tests quietly talked to another file's
// server (other data, other settings) until that one was stopped mid-test.

import { spawn, type ChildProcess } from "node:child_process";

/** Spawns the server with PORT=0 and resolves once it prints the address it listens on. */
export function startServer(env: Record<string, string>): Promise<{ server: ChildProcess; base: string }> {
  const server = spawn(process.execPath, ["app/server.ts"], { env: { ...process.env, ...env, PORT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error("server did not start")), 30_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      server.kill();
      reject(e);
    };
    server.once("exit", (code) => fail(new Error(`server exited (${code}) before listening`)));
    server.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      const m = /on the air:\s+(http:\/\/[^\s]+?):(\d+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      server.removeAllListeners("exit");
      server.stdout!.removeAllListeners("data");
      server.stdout!.resume(); // keep draining so the server never blocks on a full pipe
      resolve({ server, base: `http://127.0.0.1:${m[2]}` });
    });
  });
}
