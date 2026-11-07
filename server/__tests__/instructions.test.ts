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
const { INSTRUCTION_TOOLS } = await import("../instructions.ts");
const { ApprovalNeeded } = await import("../toolkit.ts");
const { autoApproves } = await import("../../src/autoApprove.ts");

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
  it("opens with the labelled rules, then the tools' help, the home folder, and the working directory last", async () => {
    await invoke("DELETE");
    let parts = (await prompt()).split("\n\n");
    expect(parts[0]).toMatch(/^Standing rules from the user\..*~\/\.llama-mui\/instructions\.md.*with or without tools/s);
    expect(parts[1]).toBe(DEFAULT_INSTRUCTIONS);
    expect(parts[2]).toMatch(/^You have tools/);
    expect(parts.at(-2)).toBe(`The user's home folder is ${home.dir}.`);
    expect(parts.at(-1)).toBe("Working directory: /work");
    expect(parts[3]).toMatch(/add_instruction/);

    await invoke("PUT", { text: "Be brief." });
    parts = (await prompt()).split("\n\n");
    expect(parts[1]).toBe("Be brief.");
    expect(parts).not.toContain(DEFAULT_INSTRUCTIONS);
  });

  it("has no rules block for an empty file", async () => {
    await invoke("PUT", { text: "  \n" });
    const parts = (await prompt()).split("\n\n");
    expect(parts[0]).toMatch(/^You have tools/);
    expect(parts.some((p) => p.startsWith("Standing rules"))).toBe(false);
  });

  it("is the same for every session except the last line", async () => {
    await invoke("DELETE");
    expect(await prompt()).toBe(await prompt());
  });

  it("still carries the rules, and nothing about tools, when tools are off", async () => {
    await invoke("PUT", { text: "Be brief." });
    const { save } = await import("../store.ts").then((m) => ({ save: (m as any).save }));
    const store = await (await import("../store.ts")).load();
    await save({ ...store, toolsEnabled: false });
    try {
      const text = await prompt();
      expect(text).toMatch(/^Standing rules from the user\./);
      expect(text).toContain("Be brief.");
      expect(text).not.toContain("You have tools");
      expect(text).not.toContain("Working directory");
    } finally {
      await save(store);
    }
  });
});

describe("add_instruction", () => {
  const ctx = (approved: string | null = null) => ({ approved }) as any;
  const run = (args: unknown, approved: string | null = null) => INSTRUCTION_TOOLS[0].run(ctx(approved), args);
  const asked = async (args: unknown) => {
    try {
      await run(args);
    } catch (e) {
      if (e instanceof ApprovalNeeded) return e.approval;
      throw e;
    }
    throw new Error("expected an approval");
  };

  it("asks first with the exact line as a diff, and writes nothing until approved", async () => {
    await invoke("PUT", { text: "Be brief." });
    const approval = await asked({ text: "Check git before saying who wrote a commit.", reason: "You asked me to keep that" });
    expect(approval).toMatchObject({ type: "change", path: file(), action: "edit", reason: "You asked me to keep that" });
    expect((approval as any).diff).toContain("+- Check git before saying who wrote a commit.");
    expect(await readFile(file(), "utf8")).toBe("Be brief.");
  });

  it("appends the line once the user approved exactly that", async () => {
    await invoke("PUT", { text: "Be brief.\n" });
    const args = { text: "- Check git first." };
    const approval = await asked(args);
    const out = await run(args, JSON.stringify(approval));
    expect(out).toMatch(/Added to your standing instructions: - Check git first\./);
    expect(await readFile(file(), "utf8")).toBe("Be brief.\n- Check git first.\n");
  });

  it("asks again if the file changed after the user saw the diff", async () => {
    await invoke("PUT", { text: "Be brief." });
    const args = { text: "Check git first." };
    const approval = await asked(args);
    await invoke("PUT", { text: "Be brief.\nSomething else." });
    await expect(run(args, JSON.stringify(approval))).rejects.toBeInstanceOf(ApprovalNeeded);
  });

  it("creates the file from the default when there is none", async () => {
    await invoke("DELETE");
    const approval = await asked({ text: "Check git first." });
    expect((approval as any).action).toBe("create");
    await run({ text: "Check git first." }, JSON.stringify(approval));
    expect(await readFile(file(), "utf8")).toBe(`${DEFAULT_INSTRUCTIONS}\n- Check git first.\n`);
  });

  it("refuses an empty rule, a repeat, a long one, and one that would pass the size limit", async () => {
    await invoke("PUT", { text: "- Be brief." });
    await expect(run({ text: "  " })).rejects.toThrow(/text is required/);
    await expect(run({ text: "Be brief." })).rejects.toThrow(/already in the instructions/);
    await expect(run({ text: "a".repeat(601) })).rejects.toThrow(/one sentence/);
    await invoke("PUT", { text: "a".repeat(MAX_INSTRUCTIONS - 5) });
    await expect(run({ text: "Check git first." })).rejects.toThrow(/over 20000/);
  });

  it("is never approved by 'approve all changes'", async () => {
    await invoke("PUT", { text: "Be brief." });
    const approval = (await asked({ text: "Check git first." })) as any;
    expect(autoApproves({ changes: true }, approval)).toBe(false);
    expect(autoApproves({ changes: true }, { ...approval, path: "/x/README.md" })).toBe(true);
  });
});
