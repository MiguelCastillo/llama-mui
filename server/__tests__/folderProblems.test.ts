import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, realpathSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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

const { TERMINAL_TOOLS } = await import("../terminal.ts");
const { ApprovalNeeded } = await import("../toolkit.ts");
const { folderProblems } = await import("../folderProblems.ts");
const { sessionRoutes } = await import("../sessions.ts");
const { HttpError } = await import("../http.ts");
const { writeSession } = await import("../sessionFile.ts");
import type { ToolContext } from "../toolkit.ts";

const make = (name: string) => realpathSync(mkdtempSync(path.join(home.dir, `${name}-`)));
const run = TERMINAL_TOOLS.find((t) => t.name === "run_command")!;
const ctx = (workingDir: string | null, attachments: string[] = [], approved: string | null = null) =>
  ({ chatId: "folder-chat", workingDir, attachments, approved }) as unknown as ToolContext;

const call = async (method: string, parts: string[], body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    await sessionRoutes({ req, res, parts: ["sessions", ...parts], method, search: "" });
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ...e.extra, error: e.message } as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null } as { status: number; body: any };
};

describe("a folder of the chat that is gone", () => {
  it("is found and named, for the working folder and an attached folder, and nothing else is reported", async () => {
    const here = make("here");
    const gone = path.join(home.dir, "gone-work");
    const goneAttached = path.join(home.dir, "gone-attached");
    const file = path.join(here, "note.txt");
    writeFileSync(file, "x");
    const found = await folderProblems({
      workingDir: gone,
      attachments: [
        { path: goneAttached, kind: "folder" },
        { path: here, kind: "folder" },
        { path: file, kind: "file" },
      ],
    });
    expect(found).toEqual([
      { item: "workingDir", path: gone, why: "missing" },
      { item: "attachments", path: goneAttached, why: "missing" },
    ]);
    expect(await folderProblems({ workingDir: null, attachments: [] })).toEqual([]);
    expect(await folderProblems({ workingDir: here })).toEqual([]);
  });

  it("blocks run_command, names the folder, asks for no approval and runs nothing anywhere else", async () => {
    const elsewhere = make("elsewhere");
    const dir = make("vanishing");
    const marker = path.join(elsewhere, "ran.txt");
    rmSync(dir, { recursive: true });
    // Neither the default folder nor a folder the model names is used in its place.
    for (const args of [{ command: `touch ${marker}` }, { command: `touch ${marker}`, cwd: elsewhere }]) {
      const err = await run.run(ctx(dir), args).catch((e) => e);
      expect(err).not.toBeInstanceOf(ApprovalNeeded);
      expect(String(err.message)).toContain(dir);
      expect(String(err.message)).toMatch(/Nothing was run/);
    }
    // Also with an approval in hand.
    const err = await run.run(ctx(dir, [], JSON.stringify({ type: "command", command: `touch ${marker}`, cwd: elsewhere })), { command: `touch ${marker}`, cwd: elsewhere }).catch((e) => e);
    expect(String(err.message)).toContain(dir);
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks run_command when an attached folder is gone, naming it", async () => {
    const dir = make("work");
    const attached = path.join(home.dir, "gone-attached-2");
    const err = await run.run(ctx(dir, [attached]), { command: "true" }).catch((e) => e);
    expect(String(err.message)).toContain(attached);
    expect(String(err.message)).toMatch(/attached folder/);
  });

  it("still asks for approval and runs when every folder is there", async () => {
    const dir = make("fine");
    const err = await run.run(ctx(dir, [dir]), { command: "true" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalNeeded);
  });

  it("comes with the session's answer, and the stored folder is kept", async () => {
    const dir = make("session-folder");
    const stored = { id: "fp", title: "t", messages: [{ role: "user", content: "hi" }], workingDir: dir, attachments: [], createdAt: 1, updatedAt: 1 };
    await writeSession("fp", stored);
    expect((await call("GET", ["fp"])).body.folderProblems).toEqual([]);
    rmSync(dir, { recursive: true });
    const r = await call("GET", ["fp"]);
    expect(r.body.folderProblems).toEqual([{ item: "workingDir", path: dir, why: "missing" }]);
    expect(r.body.workingDir).toBe(dir);
    // Choosing another folder clears it, through the explicit request.
    const other = make("another");
    const changed = await call("POST", ["fp", "environment"], { item: "workingDir", value: other });
    expect(changed.status).toBe(200);
    expect(changed.body.folderProblems).toEqual([]);
  });
});
