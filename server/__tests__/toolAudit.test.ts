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
const { load, save } = await import("../store.ts");
const { auditDir } = await import("../audit.ts");

const call = async (body: object) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "call"], method: "POST", search: "" });
  return JSON.parse(text);
};

// The audit lines written so far for a session, oldest first.
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
const setUp = async () => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.txt"), "SECRET-CONTENT\n");
};

describe("the audit line for a tool call", () => {
  it("records a result with the tool, group, outcome, duration and argument sizes, never the values", async () => {
    await setUp();
    await call({ name: "read_file", arguments: { path: path.join(dir, "a.txt") }, chatId: "s-result", attachments: [dir] });
    const lines = await linesFor("s-result");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "read_file", group: "disk", outcome: "result" });
    expect(typeof lines[0].ms).toBe("number");
    expect(lines[0].args).toEqual({ path: `string:${path.join(dir, "a.txt").length}` });
    expect(JSON.stringify(lines[0])).not.toContain("SECRET-CONTENT");
  });

  it("gives the line a short call id, and nothing is left set after the call", async () => {
    await setUp();
    await call({ name: "read_file", arguments: { path: path.join(dir, "a.txt") }, chatId: "s-callid", attachments: [dir] });
    const lines = await linesFor("s-callid");
    expect(lines[0].call).toMatch(/^[0-9a-f]{8}$/);
    const { currentCause } = await import("../auditContext.ts");
    expect(currentCause()).toEqual({});
  });

  it("records a tool's error text as outcome error", async () => {
    await setUp();
    // Outside the attachments, an existing file asks for access; a bad argument is a plain error.
    await call({ name: "read_file", arguments: {}, chatId: "s-error", attachments: [dir] });
    const lines = await linesFor("s-error");
    expect(lines).toHaveLength(1);
    expect(["error", "needs-access"]).toContain(lines[0].outcome);
  });

  it("records an unknown tool, a tool turned off, and bad JSON arguments as refusals", async () => {
    await call({ name: "no_such_tool", arguments: {}, chatId: "s-unknown" });
    expect((await linesFor("s-unknown"))[0]).toMatchObject({ tool: "no_such_tool", outcome: "refused:unknown" });

    await call({ name: "read_file", arguments: "{not json", chatId: "s-bad" });
    const bad = (await linesFor("s-bad"))[0];
    expect(bad).toMatchObject({ tool: "read_file", outcome: "refused:bad-args" });
    expect(bad.args).toBe("raw:9");

    const store = await load();
    store.disabledTools.push("list_directory");
    await save(store);
    await call({ name: "list_directory", arguments: { path: dir }, chatId: "s-off" });
    expect((await linesFor("s-off"))[0]).toMatchObject({ tool: "list_directory", outcome: "refused:off" });
    store.disabledTools = store.disabledTools.filter((n) => n !== "list_directory");
    await save(store);
  });

  it("records a persona refusal under the persona's name", async () => {
    const personas = path.join(home.dir, "personas");
    await mkdir(personas, { recursive: true });
    await writeFile(path.join(personas, "Reviewer.md"), "---\nname: Reviewer\ndescription: x\ntools: read_file\n---\nLook.\n");
    process.env.LLAMA_MUI_PERSONAS_DIR = personas;
    const store = await load();
    store.defaultPersona = "Reviewer";
    await save(store);
    try {
      await call({ name: "list_directory", arguments: { path: dir }, chatId: "s-persona", attachments: [dir] });
    } finally {
      delete process.env.LLAMA_MUI_PERSONAS_DIR;
      store.defaultPersona = "";
      await save(store);
    }
    expect(await linesFor("s-persona")).toHaveLength(1);
    expect((await linesFor("s-persona"))[0]).toMatchObject({ tool: "list_directory", persona: "Reviewer", outcome: "refused:persona" });
  });

  it("records a call that needs approval with the approval's type and target, and one that carries it", async () => {
    await setUp();
    const file = path.join(dir, "new.txt");
    const out = await call({ name: "write_file", arguments: { path: file, content: "HELLO-BODY" }, chatId: "s-approve", workingDir: dir, attachments: [] });
    expect(out.needsApproval).toBeTruthy();
    const [first] = await linesFor("s-approve");
    expect(first).toMatchObject({ tool: "write_file", group: "write", outcome: "needs-approval", needs: { type: "change", target: file } });

    await call({
      name: "write_file",
      arguments: { path: file, content: "HELLO-BODY" },
      chatId: "s-approve",
      workingDir: dir,
      attachments: [],
      approved: out.needsApproval,
    });
    const lines = await linesFor("s-approve");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ outcome: "result", approval: { type: "change", target: file } });
    const text = JSON.stringify(lines);
    expect(text).not.toContain("HELLO-BODY");
    expect(text).not.toContain('"diff"');
  });

  it("logs exactly once for each refusal", async () => {
    await call({ name: "no_such_tool", arguments: {}, chatId: "s-once-unknown" });
    await call({ name: "read_file", arguments: "{not json", chatId: "s-once-bad" });
    expect(await linesFor("s-once-unknown")).toHaveLength(1);
    expect(await linesFor("s-once-bad")).toHaveLength(1);

    const store = await load();
    store.disabledTools.push("list_directory");
    await save(store);
    await call({ name: "list_directory", arguments: { path: dir }, chatId: "s-once-off" });
    store.disabledTools = store.disabledTools.filter((n) => n !== "list_directory");
    await save(store);
    expect(await linesFor("s-once-off")).toHaveLength(1);
  });

  it("logs a call made straight to a spec's run, without runTool", async () => {
    await setUp();
    const { allToolNames, isAudited } = await import("../tools.ts");
    const { DISK_TOOLS } = await import("../disk.ts");
    expect(allToolNames()).toContain("read_file");
    // The raw spec is unwrapped; the registry's copy is wrapped. Reach it through the route's own registry.
    expect(isAudited(DISK_TOOLS[0])).toBe(false);
    const { toolSpecs } = await import("../tools.ts");
    const spec = toolSpecs().find((t) => t.name === "read_file")!;
    expect(isAudited(spec)).toBe(true);
    const ctx = { store: await load(), chatId: "s-direct", workingDir: null, attachments: [dir], approved: null, todos: [] };
    await spec.run(ctx, { path: path.join(dir, "a.txt") });
    expect(await linesFor("s-direct")).toHaveLength(1);
  });

  it("keeps a ':check' suffix on the session id", async () => {
    await call({ name: "no_such_tool", arguments: {}, chatId: "s-check:check" });
    expect((await linesFor("s-check:check"))).toHaveLength(1);
  });
});
