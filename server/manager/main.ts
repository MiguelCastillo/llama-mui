// Entry point of `npm run prod`: builds the page once, starts the app as a child
// process, and listens on 127.0.0.1 for POST /restart and GET /status.
// The app restarts only when asked, never on file changes.
//
// Kept small: node builtins, the audited exec wrapper, the log, and the two
// manager files. It must not import app code.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "../io/exec.ts";
import { Supervisor } from "./supervisor.ts";
import { createManagerServer } from "./http.ts";

export const DEFAULT_MANAGER_PORT = 5170;

// MANAGER_PORT from the environment, or the default when it is missing or not a port.
export function readManagerPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MANAGER_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MANAGER_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_MANAGER_PORT;
}

// True when MANAGER_PORT is set but unusable, so the caller can say it fell back.
export function managerPortIsInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MANAGER_PORT;
  if (raw === undefined || raw.trim() === "") return false;
  return readManagerPort(env) === DEFAULT_MANAGER_PORT && Number(raw) !== DEFAULT_MANAGER_PORT;
}

// The app's environment: the manager's own, so HTTPS_PORT and HTTP_PORT pass through.
// The manager's port is not the app's business.
export function appEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.MANAGER_PORT;
  return copy;
}

async function run(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const port = readManagerPort();
  if (managerPortIsInvalid()) {
    console.error(`MANAGER_PORT is not a port number, using ${DEFAULT_MANAGER_PORT}.`);
  }

  try {
    await execFile("npx", ["vite", "build"], { cwd: root, timeout: 5 * 60_000 }, { why: "manager.build" });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    console.error("The page did not build, so nothing was started.");
    console.error(String(err.stderr || err.stdout || err.message || e).slice(-2000));
    process.exit(1);
  }

  const supervisor = new Supervisor({
    program: process.execPath,
    args: ["server/main.ts"],
    env: appEnvironment(),
    cwd: root,
  });
  supervisor.start();

  let stopping = false;
  const shutdown = async (code: number) => {
    await supervisor.stop();
    process.exit(code);
  };
  const onSignal = () => {
    if (stopping) process.exit(1);
    stopping = true;
    void shutdown(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const server = createManagerServer(supervisor);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use, so the restart manager can't start. Free it or set MANAGER_PORT to another port.`);
    } else {
      console.error(`The restart manager could not listen on port ${port}: ${err.message}`);
    }
    stopping = true;
    void shutdown(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Restart manager listening on http://127.0.0.1:${port} (app pid ${supervisor.status().pid}). POST /restart to restart the app.`);
  });
}

// Run only when started directly, not when a test imports the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run();
}
