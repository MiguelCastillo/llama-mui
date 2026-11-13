import type { IncomingMessage, ServerResponse } from "node:http";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// A tool call is refused when the tool is outside the chat's persona list. The
// persona comes from the session saved under the call's chat id.

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { toolRoutes } = await import("../tools.ts");
const { sessionRoutes } = await import("../sessions.ts");
const { load, save } = await import("../store.ts");
const { appPersonasDir } = await import("../personas.ts");

const testPersonas = path.join(home.dir, ".llama-mui", "personas");
process.env.LLAMA_MUI_PERSONAS_DIR = testPersonas;
mkdirSync(testPersonas, { recursive: true });
for (const f of ["Builder.md", "Explainer.md", "Reviewer.md"]) copyFileSync(path.join(appPersonasDir(), f), path.join(testPersonas, f));

const send = async (route: typeof toolRoutes, parts: string[], method: string, body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as any).headers = {};
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await route({ req, res, parts, method, search: "" } as any);
  return text ? JSON.parse(text) : null;
};

const putSession = (id: string, persona?: string) =>
  send(sessionRoutes, ["sessions", id], "PUT", { id, title: id, model: "m", messages: [{ role: "user", content: "hi" }], ...(persona ? { persona } : {}) });
const call = (chatId: string, name: string, args: object = {}) =>
  send(toolRoutes, ["tools", "call"], "POST", { name, arguments: args, chatId, attachments: [] });

const refused = (r: any, persona: string, tool: string) => {
  expect(r.result).toContain(`the ${tool} tool is not available to the ${persona} persona`);
};
const notRefused = (r: any) => expect(JSON.stringify(r)).not.toContain("persona this chat works as");

describe("tool calls under a persona", () => {
  it("refuses a tool outside Reviewer's list, naming the persona and the tool", async () => {
    await putSession("rev1", "Reviewer");
    refused(await call("rev1", "edit_file", { path: "a.txt", old_text: "a", new_text: "b" }), "Reviewer", "edit_file");
    refused(await call("rev1", "update_plan", { steps: [] }), "Reviewer", "update_plan");
  });

  it("allows Reviewer's own tools, run_command included", async () => {
    await putSession("rev2", "Reviewer");
    notRefused(await call("rev2", "read_file", { path: "nothing-here.txt" }));
    notRefused(await call("rev2", "run_command", { command: "ls" }));
  });

  it("refuses Explainer run_command, which Reviewer has", async () => {
    await putSession("exp1", "Explainer");
    refused(await call("exp1", "run_command", { command: "ls" }), "Explainer", "run_command");
    notRefused(await call("exp1", "grep", { pattern: "x" }));
  });

  it("allows Builder every tool", async () => {
    await putSession("bld1", "Builder");
    notRefused(await call("bld1", "edit_file", { path: "nothing.txt", old_text: "a", new_text: "b" }));
    notRefused(await call("bld1", "update_plan", { steps: [{ summary: "s", text: "t" }] }));
    notRefused(await call("bld1", "run_command", { command: "ls" }));
  });

  it("uses the default persona when the chat has none saved or no session exists", async () => {
    notRefused(await call("nosession", "edit_file", { path: "nothing.txt", old_text: "a", new_text: "b" }));
    const store = await load();
    await save({ ...store, defaultPersona: "Reviewer" });
    try {
      refused(await call("nosession", "edit_file", { path: "a.txt", old_text: "a", new_text: "b" }), "Reviewer", "edit_file");
    } finally {
      await save(store);
    }
  });

  it("finds the session for a step's check run (id with a suffix)", async () => {
    await putSession("rev3", "Reviewer");
    refused(await call("rev3:check", "write_file", { path: "a.txt", content: "x" }), "Reviewer", "write_file");
  });

  it("always allows the note tools, whatever the persona says", async () => {
    await putSession("rev4", "Reviewer");
    notRefused(await call("rev4", "add_idea", { text: "An idea." }));
    notRefused(await call("rev4", "add_action_item", { text: "Do this." }));
  });

  it("leaves the tool definitions the model gets unchanged", async () => {
    const withPersona = await send(toolRoutes, ["tools", "context"], "POST", { attachments: [], persona: "Reviewer" });
    const without = await send(toolRoutes, ["tools", "context"], "POST", { attachments: [], persona: "Builder" });
    expect(withPersona.definitions).toEqual(without.definitions);
  });
});
