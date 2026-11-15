import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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

const { toolRoutes } = await import("../tools.ts");
const { auditDir } = await import("../audit.ts");

const call = async (body: object) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "call"], method: "POST", search: "" });
  return JSON.parse(text);
};

const linesFor = async (session: string) => {
  const dir = auditDir();
  const files = (await readdir(dir).catch(() => [])).sort();
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  return all
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "tool.call" && l.session === session);
};

const dir = path.join(home.dir, "proj");

describe("facts a tool adds to its audit line", () => {
  it("an edit in a session worktree, which asks nothing, says approvedBy worktree", async () => {
    const wt = path.join(home.dir, ".llama-mui", "sessions", "s-wt", "worktrees", "w1");
    await mkdir(wt, { recursive: true });
    const file = path.join(wt, "x.txt");
    const out = await call({ name: "write_file", arguments: { path: file, content: "WT-BODY" }, chatId: "s-wt", workingDir: null, attachments: [] });
    expect(out.result).toContain("Created");
    const lines = await linesFor("s-wt");
    expect(lines).toHaveLength(1);
    expect(lines[0].facts).toMatchObject({ path: file, action: "write", bytes: 7 });
    expect(lines[0].noted).toMatchObject({ approvedBy: "worktree", action: "create", bytes: 7 });
    expect(JSON.stringify(lines)).not.toContain("WT-BODY");
  });

  it("an approved edit says approvedBy approval, with sizes and never the text", async () => {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "e.txt");
    await writeFile(file, "OLD-SECRET here\n");
    const base = { chatId: "s-edit", workingDir: dir, attachments: [] };
    await call({ name: "read_file", arguments: { path: file }, ...base });
    const args = { path: file, old_text: "OLD-SECRET", new_text: "NEW-SECRET" };
    const asked = await call({ name: "edit_file", arguments: args, ...base });
    expect(asked.needsApproval).toBeTruthy();
    await call({ name: "edit_file", arguments: args, ...base, approved: asked.needsApproval });
    const edits = (await linesFor("s-edit")).filter((l) => l.tool === "edit_file");
    expect(edits).toHaveLength(2);
    expect(edits[0].outcome).toBe("needs-approval");
    expect(edits[1].outcome).toBe("result");
    expect(edits[1].facts).toMatchObject({ path: file, action: "edit", oldBytes: 10, newBytes: 10, replaceAll: false });
    expect(edits[1].noted).toMatchObject({ approvedBy: "approval", action: "edit" });
    const text = JSON.stringify(edits);
    expect(text).not.toContain("OLD-SECRET");
    expect(text).not.toContain("NEW-SECRET");
  });

  it("a command shows its command, folder, read-only claim and exit code", async () => {
    await mkdir(dir, { recursive: true });
    const args = { command: "echo hi; exit 3", read_only: true };
    const base = { chatId: "s-cmd", workingDir: dir, attachments: [] };
    const asked = await call({ name: "run_command", arguments: args, ...base });
    expect(asked.needsApproval).toBeTruthy();
    await call({ name: "run_command", arguments: args, ...base, approved: asked.needsApproval });
    const lines = await linesFor("s-cmd");
    expect(lines).toHaveLength(2);
    expect(lines[1].facts).toMatchObject({ command: "echo hi; exit 3", cwd: "", readOnlyClaim: true });
    expect(lines[1].noted).toMatchObject({ exit: 3 });
    expect(lines[1].approval).toMatchObject({ type: "command" });
  });

  it("fetch_url and web_search describe where the call goes, without a query string", async () => {
    const { toolSpecs } = await import("../tools.ts");
    const get = (n: string) => toolSpecs().find((t) => t.name === n)!;
    expect(get("fetch_url").audit!({ url: "https://example.com/a/b?token=SECRET#frag" })).toEqual({
      host: "example.com",
      url: "https://example.com/a/b",
    });
    expect(get("inspect_page").audit!({ url: "http://localhost:5173/x?k=1", script: "abc" })).toMatchObject({
      host: "localhost:5173",
      scriptBytes: 3,
    });
    expect(get("web_search").audit!({ query: "llama news" })).toEqual({ query: "llama news" });
    expect(get("add_rule").audit!({ text: "Be brief." })).toEqual({ chars: 9 });
    expect(get("create_worktree").audit!({ repo: "/r", name: "n" })).toMatchObject({ repo: "/r", name: "n" });
  });
});
