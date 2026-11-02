import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests write their own settings.json, never the real one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load, save, SETTINGS_FILE } = await import("../store.ts");
const { toolRoutes } = await import("../tools.ts");
const { connectorRoutes } = await import("../connectors.ts");

const KEY = "sk-test-secret-0123456789";
const appDir = path.dirname(SETTINGS_FILE);
const project = path.join(home.dir, "Projects", "app");

const invoke = async (handler: (r: any) => Promise<boolean>, parts: string[], method: string, body?: unknown) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    headers: {},
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, on() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await handler({ req, res, parts, method, search: "" });
  return { status: res.statusCode, text };
};

const call = async (name: string, args: object, attachments: string[], approved?: object) =>
  JSON.parse((await invoke(toolRoutes, ["tools", "call"], "POST", { name, arguments: args, chatId: "k", attachments, approved })).text);

beforeAll(async () => {
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.txt"), "nothing here\n");
  await save({
    ...(await load()),
    connectors: [{ id: "c1", name: "t", url: "http://127.0.0.1:1", apiKey: KEY, kind: "llama", api: "openai" }],
    activeId: "c1",
  });
});

describe("a saved API key", () => {
  it("is not in what the browser can list about connectors, only that one is set", async () => {
    const out = await invoke(connectorRoutes, ["connectors"], "GET");
    expect(out.text).not.toContain(KEY);
    expect(JSON.parse(out.text).connectors[0].hasKey).toBe(true);
  });

  it("can't be read with read_file or grep, even in an attached ~/.llama-mui", async () => {
    const read = await call("read_file", { path: SETTINGS_FILE }, [appDir]);
    expect(read.result).toContain("can't be read");
    const grep = await call("grep", { pattern: "apiKey|sk-test" }, [appDir]);
    expect(JSON.stringify([read, grep])).not.toContain(KEY);
  });

  it("can't be overwritten with write_file", async () => {
    const out = await call("write_file", { path: SETTINGS_FILE, content: "{}" }, [appDir]);
    expect(out.result).toContain("can't be written");
  });
});
