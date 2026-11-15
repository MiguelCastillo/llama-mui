import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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

const fsio = await import("../io/fs.ts");
const { runWithCause } = await import("../auditContext.ts");
const { auditDir } = await import("../audit.ts");

const raw = () =>
  (existsSync(auditDir()) ? readdirSync(auditDir()) : [])
    .sort()
    .map((f) => readFileSync(path.join(auditDir(), f), "utf8"))
    .join("");
const lines = () =>
  raw()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "io.fs");
const lastLine = () => lines().at(-1);

const work = realpathSync(mkdtempSync(path.join(home.dir, "work-")));

describe("io/fs", () => {
  it("each operation leaves exactly one line", async () => {
    const dir = path.join(work, "a", "b");
    const file = path.join(dir, "f.txt");
    const steps: [() => Promise<unknown>, string][] = [
      [() => fsio.mkdir(dir, { recursive: true }, { why: "t.mkdir" }), "mkdir"],
      [() => fsio.write(file, "hello", undefined, { why: "t.write" }), "write"],
      [() => fsio.append(file, " world", undefined, { why: "t.append" }), "append"],
      [() => fsio.rename(file, `${file}.moved`, { why: "t.rename" }), "rename"],
      [() => fsio.remove(`${file}.moved`, undefined, { why: "t.remove" }), "remove"],
    ];
    for (const [step, op] of steps) {
      const before = lines().length;
      await step();
      expect(lines().length).toBe(before + 1);
      expect(lastLine()).toMatchObject({ op });
    }
    expect(existsSync(`${file}.moved`)).toBe(false);
  });

  it("logs why, path and the byte size, and the rename target", async () => {
    const file = path.join(work, "bytes.txt");
    await fsio.write(file, "héllo", undefined, { why: "t.bytes" });
    expect(lastLine()).toMatchObject({ why: "t.bytes", op: "write", path: file, bytes: 6 });
    await fsio.write(file, Buffer.from([1, 2, 3]), undefined, { why: "t.bytes" });
    expect(lastLine().bytes).toBe(3);
    await fsio.rename(file, `${file}.2`, { why: "t.move" });
    expect(lastLine()).toMatchObject({ op: "rename", path: file, to: `${file}.2` });
    expect(lastLine().bytes).toBeUndefined();
  });

  it("never puts what was written in the line", async () => {
    await fsio.write(path.join(work, "secret.txt"), "sk-super-secret-value", undefined, { why: "t.secret" });
    expect(raw()).not.toContain("sk-super-secret-value");
  });

  it("keeps the file mode and the flag", async () => {
    const file = path.join(work, "mode.txt");
    await fsio.write(file, "x", { mode: 0o600 }, { why: "t.mode" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(fsio.write(file, "y", { flag: "wx" }, { why: "t.mode" })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("logs a failed write with its error, and throws it again", async () => {
    const file = path.join(work, "no-such-folder", "f.txt");
    await expect(fsio.write(file, "abc", undefined, { why: "t.fail" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(lastLine()).toMatchObject({ why: "t.fail", op: "write", path: file, bytes: 3, error: "ENOENT" });
  });

  it("logs a failed rename and a failed remove", async () => {
    await expect(fsio.rename(path.join(work, "nope"), path.join(work, "nope2"), { why: "t.fail" })).rejects.toThrow();
    expect(lastLine()).toMatchObject({ op: "rename", error: "ENOENT" });
    await expect(fsio.remove(path.join(work, "nope"), undefined, { why: "t.fail" })).rejects.toThrow();
    expect(lastLine()).toMatchObject({ op: "remove", error: "ENOENT" });
    await fsio.remove(path.join(work, "nope"), { force: true }, { why: "t.force" });
    expect(lastLine().error).toBeUndefined();
  });

  it("the sync versions and the temp folder leave a line too", async () => {
    const dir = path.join(work, "sync");
    fsio.mkdirSync(dir, { recursive: true }, { why: "t.sync" });
    expect(lastLine()).toMatchObject({ op: "mkdir", path: dir });
    fsio.writeSync(path.join(dir, "f"), "abcd", undefined, { why: "t.sync" });
    expect(lastLine()).toMatchObject({ op: "write", bytes: 4 });
    const made = await fsio.makeTempDir(path.join(work, "tmp-"), { why: "t.temp" });
    expect(existsSync(made)).toBe(true);
    expect(lastLine()).toMatchObject({ op: "mkdir", path: made, why: "t.temp" });
  });

  it("carries the cause", async () => {
    await runWithCause({ session: "sess-1", call: "c1", request: "r1" }, () =>
      fsio.write(path.join(work, "cause.txt"), "x", undefined, { why: "t.cause" }),
    );
    expect(lastLine()).toMatchObject({ session: "sess-1", call: "c1", request: "r1" });
    await fsio.write(path.join(work, "cause2.txt"), "x", undefined, { why: "t.cause" });
    expect(lastLine().session).toBeUndefined();
  });
});
