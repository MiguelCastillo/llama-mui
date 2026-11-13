import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// exec reads the login shell's environment once. A plain sh with a temp home
// is used here, so no profile of the real user's runs (one that waits for a
// passphrase would hang the test).
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "llama-mui-terminal-")));
process.env.SHELL = "/bin/sh";
process.env.HOME = dir;
const { exec } = await import("../terminal.ts");

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
