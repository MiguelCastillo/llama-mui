import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS, instructionRoutes } = await import("../instructions.ts");
const { toolRoutes } = await import("../tools.ts");

const file = () => path.join(home.dir, ".llama-mui", "instructions.md");

const invoke = async (method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await instructionRoutes({ req, res, parts: ["instructions"], method, search: "" });
  return { status: res.statusCode, body: JSON.parse(text) };
};

const prompt = async () => {
  const req = Readable.from([Buffer.from(JSON.stringify({ attachments: [], promptDir: "/work" }))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "context"], method: "POST", search: "" });
  return JSON.parse(text).systemPrompt as string;
};

describe("the agent's instructions file", () => {
  it("is the default when the file is missing", async () => {
    expect((await invoke("GET")).body).toEqual({ text: DEFAULT_INSTRUCTIONS, isDefault: true });
  });

  it("is written by save and read back", async () => {
    const out = await invoke("PUT", { text: "Answer in French." });
    expect(out.body).toEqual({ text: "Answer in French.", isDefault: false });
    expect(await readFile(file(), "utf8")).toBe("Answer in French.");
    expect((await invoke("GET")).body).toEqual({ text: "Answer in French.", isDefault: false });
  });

  it("can be saved empty, which means no extra instructions rather than the default", async () => {
    await invoke("PUT", { text: "" });
    expect((await invoke("GET")).body).toEqual({ text: "", isDefault: false });
  });

  it("is removed by reset, so the default applies again", async () => {
    await invoke("PUT", { text: "x" });
    expect((await invoke("DELETE")).body).toEqual({ text: DEFAULT_INSTRUCTIONS, isDefault: true });
    await expect(readFile(file())).rejects.toThrow(/ENOENT/);
    // Resetting with nothing to remove is fine.
    expect((await invoke("DELETE")).body.isDefault).toBe(true);
  });

  it("refuses text over the limit with the sizes in the message, and keeps the old file", async () => {
    await invoke("PUT", { text: "keep me" });
    await expect(invoke("PUT", { text: "a".repeat(MAX_INSTRUCTIONS + 1) })).rejects.toThrow(/limit is 20000/);
    expect(await readFile(file(), "utf8")).toBe("keep me");
    expect((await invoke("PUT", { text: "a".repeat(MAX_INSTRUCTIONS) })).status).toBe(200);
  });

  it("must be a string", async () => {
    await expect(invoke("PUT", { text: 3 })).rejects.toThrow(/string/);
  });
});

describe("the system prompt", () => {
  it("has the instructions after the tool groups and before the home folder, with the working directory last", async () => {
    await invoke("DELETE");
    let parts = (await prompt()).split("\n\n");
    expect(parts.at(-3)).toBe(DEFAULT_INSTRUCTIONS);
    expect(parts.at(-2)).toBe(`The user's home folder is ${home.dir}.`);
    expect(parts.at(-1)).toBe("Working directory: /work");
    expect(parts.at(-4)).toMatch(/search the web/);

    await invoke("PUT", { text: "Be brief." });
    parts = (await prompt()).split("\n\n");
    expect(parts.at(-3)).toBe("Be brief.");
    expect(parts).not.toContain(DEFAULT_INSTRUCTIONS);
  });

  it("adds nothing for an empty file", async () => {
    await invoke("PUT", { text: "  \n" });
    const parts = (await prompt()).split("\n\n");
    expect(parts.at(-2)).toBe(`The user's home folder is ${home.dir}.`);
    expect(parts.at(-3)).toMatch(/search the web/);
  });

  it("is the same for every session except the last line", async () => {
    await invoke("DELETE");
    expect(await prompt()).toBe(await prompt());
  });
});
