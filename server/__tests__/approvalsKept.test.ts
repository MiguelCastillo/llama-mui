import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Home folder pointed at a temp one: these tests never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { sessionRoutes } = await import("../sessions.ts");
const { settleSession } = await import("../restart.ts");
const { writeSession } = await import("../sessionFile.ts");

const onDisk = async (id: string) =>
  JSON.parse(await readFile(path.join(home.dir, ".llama-mui", "sessions", id, "session.json"), "utf8"));

const put = async (id: string, body: unknown) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse;
  await sessionRoutes({ req, res, parts: ["sessions", id], method: "PUT", search: "" });
  return res.statusCode;
};

const approved = { commands: true };
const started = [{ role: "user", content: "hi" }];

describe("approvals come back exactly as stored", () => {
  it("a save from an old page copy never adds or drops them, started or not", async () => {
    for (const [id, messages] of [["ap-new", []], ["ap-old", started]] as const) {
      await put(id, { id, messages, autoApprove: approved });
      await put(id, { id, messages, autoApprove: { changes: true } }); // adds
      expect((await onDisk(id)).autoApprove, id).toEqual(approved);
      await put(id, { id, messages }); // drops
      expect((await onDisk(id)).autoApprove, id).toEqual(approved);
      await put(id, { id, messages, autoApprove: {} }); // clears
      expect((await onDisk(id)).autoApprove, id).toEqual(approved);
    }
  });

  it("a chat that stored none does not gain any from a save", async () => {
    await put("ap-none", { id: "ap-none", messages: [] });
    await put("ap-none", { id: "ap-none", messages: [], autoApprove: approved });
    expect(await onDisk("ap-none")).not.toHaveProperty("autoApprove");
  });

  it("settling a dead run after a restart leaves them as they were", async () => {
    const now = Date.now();
    await writeSession("ap-dead", {
      id: "ap-dead",
      title: "t",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      messages: started,
      plan: null,
      autoApprove: approved,
      run: { status: "running", startedAt: 1, owner: { pid: process.pid + 1, port: 5175, checkedAt: now - 60_000 } },
    });
    expect(await settleSession("ap-dead")).toBe(true);
    const saved = await onDisk("ap-dead");
    expect(saved.run).toBeUndefined();
    expect(saved.autoApprove).toEqual(approved);
  });
});
