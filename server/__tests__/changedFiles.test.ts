import { mkdtempSync, realpathSync } from "node:fs";
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
const hub = await import("../runHub.ts");
const { runWithCause } = await import("../auditContext.ts");
const { fileRunStore } = await import("../runRecord.ts");
const { setChangedFileSink } = await import("../changedFiles.ts");
const { writeSession } = await import("../sessionFile.ts");

const work = realpathSync(mkdtempSync(path.join(home.dir, "work-")));
const settled = () => new Promise((r) => setTimeout(r, 50));

describe("files changed during a run, kept in the run record", () => {
  it("a change made for a chat is appended to its record, once, apart from the audit line", async () => {
    await writeSession("cf1", { id: "cf1", messages: [] });
    await hub.beginRun("cf1");
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    await runWithCause({ session: "cf1" }, async () => {
      await fsio.write(a, "x", undefined, { why: "t.write" });
      await fsio.write(a, "y", undefined, { why: "t.write" });
      await fsio.write(b, "x", undefined, { why: "t.write" });
    });
    await settled();
    expect((await fileRunStore.read("cf1"))?.changed).toEqual([a, b]);
    await hub.endRun("cf1");
  });

  it("a failed change, another chat's change and a chat with no live run add nothing", async () => {
    await writeSession("cf2", { id: "cf2", messages: [] });
    await hub.beginRun("cf2");
    await runWithCause({ session: "cf2" }, () => fsio.write(path.join(work, "no-such-dir", "f.txt"), "x", undefined, { why: "t.bad" }).catch(() => {}));
    await runWithCause({ session: "someone-else" }, () => fsio.write(path.join(work, "c.txt"), "x", undefined, { why: "t.write" }));
    await settled();
    expect((await fileRunStore.read("cf2"))?.changed).toBeUndefined();
    await hub.endRun("cf2");
  });

  it("the wrapper reaches the list through its own call, not through the audit", async () => {
    const seen: [string, string][] = [];
    setChangedFileSink((s, p) => void seen.push([s, p]));
    const f = path.join(work, "d.txt");
    await runWithCause({ session: "cf3" }, () => fsio.write(f, "x", undefined, { why: "t.write" }));
    expect(seen).toEqual([["cf3", f]]);
    setChangedFileSink((s, p) => void hub.noteChanged(s, p));
  });
});
