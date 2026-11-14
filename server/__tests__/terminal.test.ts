import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// exec reads the login shell's environment once. A plain sh with a temp home
// is used here, so no profile of the real user's runs (one that waits for a
// passphrase would hang the test).
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "llama-mui-terminal-")));
process.env.SHELL = "/bin/sh";
process.env.HOME = dir;
const { exec, readLoginEnv } = await import("../terminal.ts");

// A stand-in for the user's shell: a script that ignores its arguments and runs
// `body` as its "profile".
function fakeShell(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("readLoginEnv", () => {
  it("reads the environment the profile sets", async () => {
    const shell = fakeShell("plain.sh", "FROM_PROFILE=yes exec /usr/bin/env -0");
    const { env, fallback } = await readLoginEnv(shell, 5000);
    expect(fallback).toBeNull();
    expect(env.FROM_PROFILE).toBe("yes");
  });

  it("gives a profile no terminal to prompt on, so a prompt fails instead of waiting", async () => {
    // What ssh-add does when it wants a passphrase: read it from /dev/tty.
    const shell = fakeShell(
      "prompt.sh",
      "if read answer < /dev/tty; then PROMPTED=yes; else PROMPTED=no; fi\nPROMPTED=$PROMPTED exec /usr/bin/env -0",
    );
    const { env, fallback } = await readLoginEnv(shell, 5000);
    expect(fallback).toBeNull();
    expect(env.PROMPTED).toBe("no");
  });

  it("gives up on a profile that hangs, kills it, and falls back to the server's environment", async () => {
    const shell = fakeShell("hang.sh", "exec /bin/sleep 30");
    const started = Date.now();
    const { env, fallback } = await readLoginEnv(shell, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fallback).toMatch(/took longer/);
    expect(env).toBe(process.env);
  });

  it("falls back when the login shell fails", async () => {
    const shell = fakeShell("fail.sh", "exit 3");
    const { env, fallback } = await readLoginEnv(shell, 5000);
    expect(fallback).toMatch(/code 3/);
    expect(env).toBe(process.env);
  });
});

describe("exec", () => {
  it("runs a command and says how it ended", async () => {
    expect(await exec("echo hi", dir)).toBe("$ echo hi\nhi\n[exit code 0]");
  });

  it("stops a command at once when the caller gives up (Stop everything)", async () => {
    const c = new AbortController();
    const started = Date.now();
    const running = exec("sleep 30", dir, c.signal);
    setTimeout(() => c.abort(), 200);
    await expect(running).rejects.toThrow("Stopped by the user");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("doesn't start a command that was given up on already", async () => {
    const c = new AbortController();
    c.abort();
    await expect(exec("echo never", dir, c.signal)).rejects.toThrow("Stopped by the user");
  });
});
