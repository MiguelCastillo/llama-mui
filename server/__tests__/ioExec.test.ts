import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Home is a temp folder before anything loads: never the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { execFile, spawn } = await import("../io/exec.ts");
const { runWithCause } = await import("../auditContext.ts");
const { auditDir } = await import("../audit.ts");

const lines = () =>
  readdirSync(auditDir())
    .sort()
    .map((f) => readFileSync(path.join(auditDir(), f), "utf8"))
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "io.exec");

const lastLine = () => lines().at(-1);

const closed = (child: import("node:child_process").ChildProcess) => new Promise((r) => child.on("close", r));

describe("io.exec: execFile", () => {
  it("writes one line for a run that works, with the cause", async () => {
    const out = await runWithCause({ session: "s1", call: "c1" }, () => execFile("echo", ["hello"], undefined, { why: "test.echo" }));
    expect(out.stdout).toBe("hello\n");
    const l = lastLine();
    expect(l).toMatchObject({ why: "test.echo", session: "s1", call: "c1", program: "echo", argv: ["hello"], exit: 0, signal: null, timedOut: false });
    expect(typeof l.ms).toBe("number");
  });

  it("writes the exit code of a run that fails, and still rejects with its output", async () => {
    await expect(execFile("sh", ["-c", "echo oops >&2; exit 3"], undefined, { why: "test.fail" })).rejects.toMatchObject({ stderr: "oops\n" });
    expect(lastLine()).toMatchObject({ why: "test.fail", exit: 3, timedOut: false });
  });

  it("writes an error code when the program is missing", async () => {
    await expect(execFile("no-such-program-xyz", [], undefined, { why: "test.missing" })).rejects.toThrow();
    expect(lastLine()).toMatchObject({ why: "test.missing", exit: null, error: "ENOENT" });
  });

  it("marks a run that hit its time limit", async () => {
    await expect(execFile("sleep", ["5"], { timeout: 100 }, { why: "test.slow" })).rejects.toThrow();
    expect(lastLine()).toMatchObject({ why: "test.slow", timedOut: true, signal: "SIGTERM" });
  });

  it("writes a line by default, and none for a call marked quiet", async () => {
    const before = lines().length;
    await execFile("echo", ["loud"], undefined, { why: "test.loud" });
    expect(lines().length).toBe(before + 1);
    await execFile("echo", ["hush"], undefined, { why: "test.hush", quiet: true });
    await expect(execFile("sh", ["-c", "exit 1"], undefined, { why: "test.hush-fail", quiet: true })).rejects.toThrow();
    expect(lines().length).toBe(before + 1);
    expect(JSON.stringify(lines())).not.toContain("test.hush");
  });

  it("never writes the environment or the output", async () => {
    await execFile("sh", ["-c", "echo PRINTED-OUTPUT"], { env: { ...process.env, SECRET_TOKEN: "ENV-SECRET" } }, { why: "test.secret" });
    const raw = JSON.stringify(lines());
    expect(raw).not.toContain("ENV-SECRET");
    expect(raw).not.toContain("PRINTED-OUTPUT\\n");
    expect(lastLine()).not.toHaveProperty("stdout");
    expect(lastLine()).not.toHaveProperty("env");
  });
});

describe("io.exec: spawn", () => {
  it("writes one line when the child ends, with the cause", async () => {
    const child = runWithCause({ request: "r1" }, () => spawn("sh", ["-c", "exit 2"], { stdio: "ignore" }, { why: "test.spawn" }));
    await closed(child);
    expect(lastLine()).toMatchObject({ why: "test.spawn", request: "r1", program: "sh", exit: 2, timedOut: false });
  });

  it("kills at the time limit, says so on the child and in the line", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore", detached: true }, { why: "test.spawn-slow", timeoutMs: 100 });
    const timeout = new Promise((r) => child.once("timeout", r));
    await Promise.all([timeout, closed(child)]);
    expect(child.timedOut).toBe(true);
    expect(lastLine()).toMatchObject({ why: "test.spawn-slow", timedOut: true, signal: "SIGKILL" });
  });

  it("writes no line for a quiet spawn", async () => {
    const before = lines().length;
    const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" }, { why: "test.spawn-quiet", quiet: true });
    await closed(child);
    expect(lines().length).toBe(before);
  });

  it("writes a line when the program can't start", async () => {
    const child = spawn("no-such-program-xyz", [], { stdio: "ignore" }, { why: "test.spawn-missing" });
    await new Promise((r) => child.on("error", r));
    expect(lastLine()).toMatchObject({ why: "test.spawn-missing", exit: null, error: "ENOENT" });
  });
});
