import type { IncomingMessage, ServerResponse } from "node:http";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// A chat's persona: saved by name with the session, looked up when the prompt
// is built, and fixed once the first message is sent.

// Home folder pointed at a temp one, so the real personas, settings and sessions are untouched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { HttpError } = await import("../http.ts");
const { toolRoutes } = await import("../tools.ts");
const { sessionRoutes } = await import("../sessions.ts");
const { load, save } = await import("../store.ts");
const { appPersonasDir } = await import("../personas.ts");

// Personas come from a folder of the test's own, starting with the app's Builder.md.
const testPersonas = path.join(home.dir, ".llama-mui", "personas");
process.env.LLAMA_MUI_PERSONAS_DIR = testPersonas;
mkdirSync(testPersonas, { recursive: true });
copyFileSync(path.join(appPersonasDir(), "Builder.md"), path.join(testPersonas, "Builder.md"));

const send = async (route: typeof toolRoutes, parts: string[], method: string, body?: unknown) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as any).headers = {};
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  try {
    await route({ req, res, parts, method, search: "" } as any);
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: null as any };
    throw e;
  }
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
};

const context = async (body: object = {}) =>
  (await send(toolRoutes, ["tools", "context"], "POST", { attachments: [], promptDir: "/work", ...body })).body;
const putSession = (id: string, extra: object) =>
  send(sessionRoutes, ["sessions", id], "PUT", { id, title: id, model: "m", messages: [], ...extra });
const getSession = async (id: string) => (await send(sessionRoutes, ["sessions", id], "GET")).body;

const writePersona = (file: string, text: string) => {
  const dir = path.join(home.dir, ".llama-mui", "personas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const REVIEWER = "---\nname: Reviewer\ndescription: Reads code\n---\nLook, don't touch.";
const BUILDER_LINE = "Finish the work the user asked for";

describe("the prompt's persona", () => {
  it("is the default when the chat has none saved, and the page is told which", async () => {
    const c = await context();
    expect(c.persona).toBe("Builder");
    expect(c.systemPrompt).toContain(BUILDER_LINE);
    expect(c.update).not.toMatch(/persona/);
  });

  it("follows the default-persona setting when the chat has none saved", async () => {
    writePersona("Reviewer.md", REVIEWER);
    const store = await load();
    await save({ ...store, defaultPersona: "Reviewer" });
    try {
      const c = await context();
      expect(c.persona).toBe("Reviewer");
      expect(c.systemPrompt).toContain("Look, don't touch.");
      expect(c.systemPrompt).not.toContain(BUILDER_LINE);
    } finally {
      await save(store);
    }
  });

  it("uses the persona saved with the chat, not the default", async () => {
    writePersona("Reviewer.md", REVIEWER);
    const c = await context({ persona: "Reviewer" });
    expect(c.persona).toBe("Reviewer");
    expect(c.systemPrompt).toContain("Look, don't touch.");
    expect(c.systemPrompt).not.toContain(BUILDER_LINE);
    expect(c.update).not.toMatch(/persona/);
  });

  it("falls back to Builder, with a note in the chat update, when the saved one is gone", async () => {
    const c = await context({ persona: "Vanished" });
    expect(c.persona).toBe("Builder");
    expect(c.systemPrompt).toContain(BUILDER_LINE);
    expect(c.update).toContain('The persona "Vanished" this chat started with doesn\'t exist any more');

    // The saved name is left alone, so the persona is back when its file is.
    writePersona("Vanished.md", "---\nname: Vanished\ndescription: Back again\n---\nI returned.");
    const back = await context({ persona: "Vanished" });
    expect(back.persona).toBe("Vanished");
    expect(back.systemPrompt).toContain("I returned.");
    expect(back.update).not.toMatch(/persona/);
  });

  it("says which text it was built with: the persona file's", async () => {
    writePersona("Reviewer.md", REVIEWER);
    expect((await context({ persona: "Reviewer" })).personaText).toBe("Look, don't touch.");
    expect((await context()).personaText).toContain(BUILDER_LINE);
  });

  it("reads the file while the chat's text isn't fixed, so an edit shows before the first reply", async () => {
    writePersona("Reviewer.md", REVIEWER.replace("Look, don't touch.", "Only look."));
    expect((await context({ persona: "Reviewer" })).systemPrompt).toContain("Only look.");
  });
});

describe("the persona text fixed with the prompt", () => {
  it("is used as it was fixed: an edited file doesn't change the prompt", async () => {
    writePersona("Reviewer.md", REVIEWER.replace("Look, don't touch.", "Edited since."));
    const c = await context({ persona: "Reviewer", personaText: "Look, don't touch." });
    expect(c.systemPrompt).toContain("Look, don't touch.");
    expect(c.systemPrompt).not.toContain("Edited since.");
    expect(c.personaText).toBe("Look, don't touch.");
  });

  it("is used even when the file is gone, with no note", async () => {
    const c = await context({ persona: "Vanished", personaText: "Still here." });
    expect(c.persona).toBe("Vanished");
    expect(c.systemPrompt).toContain("Still here.");
    expect(c.update).not.toMatch(/persona/);
  });

  it("with tools off, the persona is left out", async () => {
    const store = await load();
    await save({ ...store, toolsEnabled: false });
    try {
      expect((await context()).systemPrompt).not.toContain(BUILDER_LINE);
      expect((await context({ persona: "Reviewer", personaText: "Look, don't touch." })).systemPrompt).not.toContain("Look, don't touch.");
    } finally {
      await save(store);
    }
  });

  it("with no Builder.md, a chat gets no persona text, and the list says why", async () => {
    rmSync(path.join(testPersonas, "Builder.md"));
    try {
      const c = await context();
      expect(c.persona).toBe("Builder");
      expect(c.personaText).toBe("");
      expect(c.systemPrompt).not.toContain(BUILDER_LINE);
    } finally {
      copyFileSync(path.join(appPersonasDir(), "Builder.md"), path.join(testPersonas, "Builder.md"));
    }
  });
});

describe("saving the persona with the session", () => {
  it("saves the name, and no text until the prompt fixes it, and reopens with it", async () => {
    writePersona("Reviewer.md", REVIEWER);
    await putSession("chosen", { persona: "Reviewer" });
    const reopened = await getSession("chosen");
    expect(reopened.persona).toBe("Reviewer");
    expect(JSON.stringify(reopened)).not.toContain("Look, don't touch.");
  });

  it("can be changed freely before the first message", async () => {
    await putSession("early", { persona: "Reviewer" });
    await putSession("early", { persona: "Builder" });
    expect((await getSession("early")).persona).toBe("Builder");
    await putSession("early", {});
    expect((await getSession("early")).persona).toBeUndefined();
  });

  it("is fixed once the first message is sent: a later save can't change or clear it", async () => {
    // The save that carries the first message also carries the choice.
    await putSession("fixed", { persona: "Reviewer", messages: [{ role: "user", content: "hi" }] });
    expect((await getSession("fixed")).persona).toBe("Reviewer");

    const messages = [{ role: "user", content: "hi" }];
    await putSession("fixed", { persona: "Builder", messages });
    expect((await getSession("fixed")).persona).toBe("Reviewer");
    await putSession("fixed", { messages });
    expect((await getSession("fixed")).persona).toBe("Reviewer");
  });

  it("is fixed after Clear context too (the messages stay saved)", async () => {
    const messages = [{ role: "user", content: "hi" }];
    await putSession("cleared", { persona: "Reviewer", messages, promptDir: null });
    await putSession("cleared", { persona: "Builder", messages, contextStart: 1, promptDir: undefined });
    expect((await getSession("cleared")).persona).toBe("Reviewer");
  });

  it("is not added to a chat that started without one (it uses the default)", async () => {
    await putSession("older", { messages: [{ role: "user", content: "hi" }] });
    await putSession("older", { persona: "Reviewer", messages: [{ role: "user", content: "hi" }] });
    expect((await getSession("older")).persona).toBeUndefined();
  });

  it("ignores a name that isn't text", async () => {
    await putSession("odd", { persona: 42 });
    expect((await getSession("odd")).persona).toBeUndefined();
  });
});
