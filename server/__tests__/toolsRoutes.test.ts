import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
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

const { toolRoutes } = await import("../tools.ts");

const post = async (name: string, body: object) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", name], method: "POST", search: "" });
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
