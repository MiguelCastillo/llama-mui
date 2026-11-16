import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Point the home folder at a temp one: these tests must never touch ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { fileRunStore, ownerOf } = await import("../runRecord.ts");
const { writeSession, readSession } = await import("../sessionFile.ts");

const onDisk = async (id: string) =>
  JSON.parse(await readFile(path.join(home.dir, ".llama-mui", "sessions", id, "session.json"), "utf8"));
const owner = { pid: 123, port: 5173, checkedAt: 1000 };

describe("run record store", () => {
  it("reads null when the session has no record or doesn't exist", async () => {
    await writeSession("rr-none", { id: "rr-none", messages: [] });
    expect(await fileRunStore.read("rr-none")).toBeNull();
    expect(await fileRunStore.read("rr-missing")).toBeNull();
  });

  it("writes a record with its owner, reads it back, and counts a revision", async () => {
    await writeSession("rr-a", { id: "rr-a", messages: [], revision: 4 });
    await fileRunStore.write("rr-a", { status: "running", startedAt: 1, owner });
    expect(await fileRunStore.read("rr-a")).toEqual({ status: "running", startedAt: 1, owner });
    const disk = await onDisk("rr-a");
    expect(disk.run.owner).toEqual(owner);
    expect(disk.revision).toBe(5);
    expect(disk.messages).toEqual([]);
  });

  it("refuses to write for a session that isn't saved", async () => {
    await expect(fileRunStore.write("rr-nope", { startedAt: 1 })).rejects.toMatchObject({ status: 404 });
  });

  it("hands out copies, so changing one doesn't change the store", async () => {
    await writeSession("rr-copy", { id: "rr-copy", messages: [] });
    await fileRunStore.write("rr-copy", { status: "running", startedAt: 1, owner });
    const a = await fileRunStore.read("rr-copy");
    a!.owner!.pid = 999;
    expect((await fileRunStore.read("rr-copy"))!.owner!.pid).toBe(123);
  });

  it("updates by changing a copy, or by returning a replacement", async () => {
    await writeSession("rr-up", { id: "rr-up", messages: [] });
    await fileRunStore.write("rr-up", { status: "running", startedAt: 1, owner });
    const a = await fileRunStore.update("rr-up", (r) => void (r.owner!.checkedAt = 2000));
    expect(a!.owner!.checkedAt).toBe(2000);
    const b = await fileRunStore.update("rr-up", () => ({ status: "stopped", startedAt: 1 }));
    expect(b).toEqual({ status: "stopped", startedAt: 1 });
    expect((await onDisk("rr-up")).run).toEqual({ status: "stopped", startedAt: 1 });
  });

  it("writes nothing when updating a session with no record", async () => {
    await writeSession("rr-upnone", { id: "rr-upnone", messages: [], revision: 2 });
    expect(await fileRunStore.update("rr-upnone", (r) => void (r.status = "x"))).toBeNull();
    expect((await onDisk("rr-upnone")).revision).toBe(2);
  });

  it("removes the record and leaves the rest of the session", async () => {
    await writeSession("rr-rm", { id: "rr-rm", messages: [{ role: "user", content: "hi" }] });
    await fileRunStore.write("rr-rm", { startedAt: 1, owner });
    expect(await fileRunStore.remove("rr-rm")).toBe(true);
    expect(await fileRunStore.remove("rr-rm")).toBe(false);
    const s = await readSession("rr-rm");
    expect(s.run).toBeUndefined();
    expect(s.messages).toHaveLength(1);
  });

  it("ownerOf accepts a well-formed owner and rejects the rest", () => {
    expect(ownerOf({ owner })).toEqual(owner);
    expect(ownerOf({})).toBeNull();
    expect(ownerOf(null)).toBeNull();
    expect(ownerOf({ owner: { pid: "1", port: 1, checkedAt: 1 } })).toBeNull();
    expect(ownerOf({ owner: { pid: 1, port: 1 } })).toBeNull();
  });
});
