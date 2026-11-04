import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

const { toolRoutes } = await import("../tools.ts");

const post = async (name: string, body: object, method = "POST") => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", name], method, search: "" });
  return JSON.parse(text);
};

const read = (chatId: string, attachments: string[], file: string) =>
  post("call", { name: "read_file", arguments: { path: file }, chatId, attachments });

describe("the system prompt", () => {
  it("names the home folder before the working directory, which stays last", async () => {
    const { systemPrompt } = await post("context", { attachments: [], promptDir: "/work" });
    const lines = systemPrompt.split("\n\n");
    expect(lines.at(-2)).toBe(`The user's home folder is ${home.dir}.`);
    expect(lines.at(-1)).toBe("Working directory: /work");
  });

  it("says there is no working directory when promptDir is null", async () => {
    const { systemPrompt } = await post("context", { attachments: [], promptDir: null });
    expect(systemPrompt.endsWith("There's no working directory: use absolute paths.")).toBe(true);
  });

  it("still says so with a folder attached: an attached folder is not a working directory", async () => {
    const { systemPrompt, update } = await post("context", { workingDir: null, attachments: [home.dir], promptDir: null });
    expect(systemPrompt.endsWith("There's no working directory: use absolute paths.")).toBe(true);
    expect(systemPrompt).not.toContain("Working directory:");
    // The folder is still listed, as attached, and no working directory is announced.
    expect(update).toContain(`Also attached:\n- ${home.dir}`);
    expect(update).not.toContain("working directory");
  });

  it("sends a relative path nowhere when a folder is attached and there is no working directory", async () => {
    await setUpFolders();
    const out = await readWith({ workingDir: null, attachments: [docs] }, "only-docs.txt");
    expect(out.result).toContain("Use an absolute path");
    expect(out.result).not.toContain("only in docs");
  });
});

// Two folders with a file of the same name, so which one a relative path
// meant shows in what is read.
const work = path.join(home.dir, "wd-work");
const docs = path.join(home.dir, "wd-docs");
const setUpFolders = async () => {
  for (const [dir, who] of [[work, "work"], [docs, "docs"]] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "same.txt"), `same file in ${who}\n`);
    await writeFile(path.join(dir, `only-${who}.txt`), `only in ${who}\n`);
  }
};

const readWith = (ctx: { workingDir?: string | null; attachments?: string[] }, file: string) =>
  post("call", { name: "read_file", arguments: { path: file }, chatId: "chat-wd", attachments: [], ...ctx });

describe("the working directory in the tool context", () => {
  beforeAll(setUpFolders);

  it("is named by the chat update, which lists only the attachments under 'Also attached'", async () => {
    const { update } = await post("context", { workingDir: work, attachments: [docs], promptDir: null });
    expect(update).toContain(`The working directory is now ${work}.`);
    const [, attached] = update.split("Also attached:");
    expect(attached).toContain(`- ${docs}`);
    expect(attached).not.toContain(work);
  });

  it("says nothing about the working directory when it is the one the system prompt names", async () => {
    const { update } = await post("context", { workingDir: work, attachments: [docs], promptDir: work });
    expect(update).not.toContain("working directory");
    expect(update).toContain(`Also attached:\n- ${docs}`);
  });

  it("says Nothing else is attached when only the working directory is set", async () => {
    const { update } = await post("context", { workingDir: work, attachments: [], promptDir: work });
    expect(update).toBe("Chat update:\nNothing else is attached.");
  });

  it("announces that there is none now, when the system prompt named one", async () => {
    const { update } = await post("context", { workingDir: null, attachments: [docs], promptDir: work });
    expect(update).toContain("There's no working directory now.");
    expect(update).toContain(`Also attached:\n- ${docs}`);
  });

  it("is dropped, as if there were none, when it is not a folder that exists", async () => {
    const file = path.join(work, "only-work.txt");
    const missing = path.join(home.dir, "wd-gone");
    for (const workingDir of [file, missing, 5]) {
      const { update } = await post("context", { workingDir, attachments: [], promptDir: work });
      expect(update).toContain("There's no working directory now.");
    }
  });

  it("is where a relative path starts, not an attached folder", async () => {
    const out = await readWith({ workingDir: work, attachments: [docs] }, "same.txt");
    expect(out.result).toContain("same file in work");
    expect((await readWith({ workingDir: work, attachments: [docs] }, "only-docs.txt")).result).toContain("does not exist");
  });

  it("is reachable by absolute paths without being an attachment, and so are the attachments", async () => {
    const ctx = { workingDir: work, attachments: [docs] };
    expect((await readWith({ workingDir: work, attachments: [] }, path.join(work, "only-work.txt"))).result).toContain("only in work");
    expect((await readWith(ctx, path.join(docs, "only-docs.txt"))).result).toContain("only in docs");
    expect((await readWith(ctx, path.join(docs, "same.txt"))).result).toContain("same file in docs");
  });

  it("does not make an attached folder the place a relative path starts, with no working directory", async () => {
    const ctx = { workingDir: null, attachments: [docs] };
    const out = await readWith(ctx, "same.txt");
    expect(out.result).toContain("Use an absolute path");
    expect(out.result).toContain(docs);
    expect((await readWith(ctx, path.join(docs, "same.txt"))).result).toContain("same file in docs");
  });

  it("is the folder run_command starts in, and cwd may name an attached folder", async () => {
    const run = (ctx: object, args: object) =>
      post("call", { name: "run_command", arguments: { command: "ls", ...args }, chatId: "chat-wd", attachments: [], ...ctx });
    const inWork = await run({ workingDir: work, attachments: [docs] }, {});
    expect(inWork.needsApproval).toEqual({ type: "command", command: "ls", cwd: work });
    const inDocs = await run({ workingDir: work, attachments: [docs] }, { cwd: docs });
    expect(inDocs.needsApproval).toEqual({ type: "command", command: "ls", cwd: docs });
  });

  it("is required by run_command when no cwd is given, even with a folder attached", async () => {
    const out = await post("call", {
      name: "run_command",
      arguments: { command: "ls" },
      chatId: "chat-wd",
      workingDir: null,
      attachments: [docs],
    });
    expect(out.needsApproval).toBeUndefined();
    expect(out.result).toContain("no working directory");
  });

  it("is where the check command runs, and only its own: an attached folder's is not sent", async () => {
    await post("check-command", { folder: work, command: "echo work" }, "PUT");
    await post("check-command", { folder: docs, command: "echo docs" }, "PUT");
    const both = await post("context", { workingDir: work, attachments: [docs], promptDir: work });
    expect(both.checkCommands).toEqual({ [work]: "echo work" });
    const none = await post("context", { workingDir: null, attachments: [docs, work], promptDir: null });
    expect(none.checkCommands).toEqual({});
  });
});

describe("a file that does not exist yet, in a folder that exists but is not attached", () => {
  it("asks to allow that folder at once, not to find the file", async () => {
    const dir = path.join(home.dir, "fresh-folder");
    await mkdir(dir, { recursive: true });
    const out = await read("chat-new", [], path.join(dir, "new.txt"));
    expect(out.result).toBeUndefined();
    expect(out.needsAccess).toMatchObject({ path: dir, kind: "folder" });
  });

  it("is a plain error once the folder is attached, with nothing to ask", async () => {
    const dir = path.join(home.dir, "fresh-folder-2");
    await mkdir(dir, { recursive: true });
    const out = await read("chat-new-2", [dir], path.join(dir, "new.txt"));
    expect(out.needsAccess).toBeUndefined();
    expect(out.result).toContain("does not exist");
  });

  it("still asks to find it when the folder is missing too", async () => {
    const out = await read("chat-new-3", [], path.join(home.dir, "no-such-folder", "new.txt"));
    expect(out.result).toContain("locate_path");
  });
});

describe("a path that does not exist, outside everything attached", () => {
  const guess = (n: number) => path.join("/home/user", `guess-${n}.ts`);

  it("is answered with an error naming locate_path for the first two guesses, then asks the user", async () => {
    const results = [];
    for (let i = 1; i <= 3; i++) results.push(await read("chat-a", [], guess(i)));
    for (const r of results.slice(0, 2)) {
      expect(r.result).toContain("doesn't exist");
      expect(r.result).toContain("locate_path");
    }
    expect(results[2].needsAccess).toEqual({ path: guess(3), kind: null });
  });

  it("counts each chat on its own", async () => {
    for (let i = 1; i <= 3; i++) await read("chat-b", [], guess(i));
    const other = await read("chat-c", [], guess(1));
    expect(other.result).toContain("locate_path");
  });

  it("starts the count over after a call that works", async () => {
    const dir = path.join(home.dir, "project");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    for (let i = 1; i <= 2; i++) await read("chat-d", [dir], guess(i));
    expect((await read("chat-d", [dir], path.join(dir, "a.txt"))).result).toContain("hello");
    const after = await read("chat-d", [dir], guess(3));
    expect(after.result).toContain("locate_path");
  });
});
