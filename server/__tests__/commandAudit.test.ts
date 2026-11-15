import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
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

const send = async (method: string, body: object) => {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "user-agent": "test-agent" },
  }) as unknown as IncomingMessage;
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", "check-command"], method, search: "" });
  return JSON.parse(text);
};

const lines = async (event: string) => {
  const dir = auditDir();
  const files = (await readdir(dir).catch(() => [])).sort();
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
  return all.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === event);
};

describe("the check command", () => {
  it("leaves a command.run line with the command, folder, exit code, duration and who", async () => {
    const folder = path.join(home.dir, "checked");
    await mkdir(folder, { recursive: true });
    await send("PUT", { folder, command: "exit 3" });
    const out = await send("POST", { folder, workingDir: folder, attachments: [], chatId: "chat-check" });
    expect(out.passed).toBe(false);
    const found = await lines("command.run");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      via: "check-command",
      command: "exit 3",
      folder,
      exit: 3,
      who: { address: "127.0.0.1", agent: "test-agent" },
    });
    expect(typeof found[0].ms).toBe("number");
    // The command's output is not recorded.
    expect(JSON.stringify(found[0])).not.toContain("output");
  });
});
