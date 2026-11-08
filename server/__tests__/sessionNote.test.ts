import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { toolRoutes, sessionNote } = await import("../tools.ts");

const ID = "c570be3a-86ba-4256-bda7-46fee952753e";

// A request to the tools routes, with the Host the page was reached at.
const send = async (name: string, body: object, host?: string, method = "POST") => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as any).headers = host ? { host } : {};
  let text = "";
  const res = { statusCode: 200, setHeader() {}, end: (t: string) => void (text = t) } as unknown as ServerResponse;
  await toolRoutes({ req, res, parts: ["tools", name], method, search: "" });
  return JSON.parse(text);
};
const prompt = async (body: object, host?: string): Promise<string> =>
  (await send("context", { attachments: [], promptDir: "/work", ...body }, host)).systemPrompt;

describe("sessionNote", () => {
  it("gives the session's address on localhost, at the port the request came to", () => {
    expect(sessionNote(ID, "localhost:5173")).toBe(
      `This session's id is ${ID}. To see this chat in a browser, open http://localhost:5173/#/session/${ID} with inspect_page. ` +
        "The plain address shows an empty chat, not this one.",
    );
  });

  it("uses localhost whatever host the page was reached by, since only localhost opens without asking", () => {
    expect(sessionNote(ID, "192.168.0.168:5173")).toContain(`http://localhost:5173/#/session/${ID}`);
    expect(sessionNote(ID, "my-mac.local:5174")).toContain(`http://localhost:5174/#/session/${ID}`);
    expect(sessionNote(ID, "[::1]:5173")).toContain(`http://localhost:5173/#/session/${ID}`);
  });

  it("leaves the port out when the request had none", () => {
    expect(sessionNote(ID, "localhost")).toContain(`http://localhost/#/session/${ID}`);
  });

  it("says nothing without a plain session id or a usable host", () => {
    expect(sessionNote("", "localhost:5173")).toBeNull();
    expect(sessionNote("../etc", "localhost:5173")).toBeNull();
    expect(sessionNote("Has Spaces", "localhost:5173")).toBeNull();
    expect(sessionNote(ID, undefined)).toBeNull();
    expect(sessionNote(ID, "not a host")).toBeNull();
  });
});

describe("the system prompt's session line", () => {
  it("comes last, after the working directory, when the session id is given", async () => {
    const lines = (await prompt({ chatId: ID }, "localhost:5173")).split("\n\n");
    expect(lines.at(-2)).toBe("Working directory: /work");
    expect(lines.at(-1)).toContain(`http://localhost:5173/#/session/${ID}`);
  });

  it("is not there without a session id, so the working directory stays last", async () => {
    const lines = (await prompt({}, "localhost:5173")).split("\n\n");
    expect(lines.at(-1)).toBe("Working directory: /work");
  });

  it("is not there for an id that is not a plain one", async () => {
    expect(await prompt({ chatId: "../etc" }, "localhost:5173")).not.toContain("This session's id");
  });

  it("is not there when inspect_page is off, since the address is for opening pages", async () => {
    await send("inspect_page", { enabled: false }, undefined, "PUT");
    try {
      expect(await prompt({ chatId: ID }, "localhost:5173")).not.toContain("This session's id");
    } finally {
      await send("inspect_page", { enabled: true }, undefined, "PUT");
    }
    expect(await prompt({ chatId: ID }, "localhost:5173")).toContain("This session's id");
  });
});
