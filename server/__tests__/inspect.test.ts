import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  MAX_CHARS,
  NO_CHROME,
  capText,
  chromeCandidates,
  findChrome,
  formatReport,
  isLocalHost,
  wrapScript,
  INSPECT_TOOLS,
} from "../inspect.ts";
import { ApprovalNeeded, type ToolContext } from "../toolkit.ts";

const ctx = (approved: string | null = null) => ({ approved }) as unknown as ToolContext;
const tool = INSPECT_TOOLS[0];

describe("inspect_page host rule", () => {
  it("lets this computer's own hosts through", () => {
    for (const u of ["http://localhost:5173/", "http://127.0.0.1:1/", "http://[::1]:8080/x", "http://app.localhost/"]) {
      expect(isLocalHost(new URL(u)), u).toBe(true);
    }
  });
  it("does not trust look-alikes or other hosts", () => {
    for (const u of ["https://example.com/", "http://localhost.evil.com/", "http://192.168.1.5/", "http://127.0.0.1.evil.com/"]) {
      expect(isLocalHost(new URL(u)), u).toBe(false);
    }
  });
  it("asks for approval for another host, before opening anything", async () => {
    const err = await tool.run(ctx(), { url: "https://example.com/a" }).catch((e) => e);
    // Without Chrome the tool says so first; with it, it asks.
    if (findChrome()) {
      expect(err).toBeInstanceOf(ApprovalNeeded);
      expect(err.approval).toEqual({ type: "page", url: "https://example.com/a", host: "example.com" });
    } else {
      expect(String(err.message)).toBe(NO_CHROME);
    }
  });
  it("rejects bad input with a message that says what to do", async () => {
    await expect(tool.run(ctx(), { url: "example.com" })).rejects.toThrow(/full URL/);
    await expect(tool.run(ctx(), { url: "file:///etc/passwd" })).rejects.toThrow(/only http/);
  });
});

describe("finding Chrome", () => {
  it("prefers LLAMA_MUI_CHROME", () => {
    expect(chromeCandidates({ LLAMA_MUI_CHROME: "/x/chrome" }, "linux")[0]).toBe("/x/chrome");
    expect(findChrome({ LLAMA_MUI_CHROME: "/x/chrome" }, "darwin", (p) => p === "/x/chrome")).toBe("/x/chrome");
  });
  it("knows the usual places on each system", () => {
    expect(chromeCandidates({}, "darwin")).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(chromeCandidates({}, "linux")).toContain("/usr/bin/google-chrome");
    expect(chromeCandidates({ PROGRAMFILES: "C:\\Program Files" }, "win32")[0]).toMatch(/chrome\.exe$/);
  });
  it("returns null when there is none, and the message says what to do", () => {
    expect(findChrome({}, "linux", () => false)).toBeNull();
    expect(NO_CHROME).toMatch(/LLAMA_MUI_CHROME/);
    expect(NO_CHROME).toMatch(/install/i);
  });
});

describe("output shaping", () => {
  it("says when text was cut", () => {
    expect(capText("abc", 10)).toBe("abc");
    const cut = capText("x".repeat(50), 10);
    expect(cut).toContain("cut: 40 more characters");
  });
  it("keeps the outline from crowding out the script result", () => {
    const out = formatReport({ url: "http://a/", title: "T", outline: "o".repeat(MAX_CHARS * 2), scriptResult: "RESULT" });
    expect(out).toContain("RESULT");
    expect(out).toContain("Title: T");
    expect(out).toContain("cut:");
  });
  it("omits the script section when there was no script", () => {
    expect(formatReport({ url: "http://a/", title: "", outline: "" })).not.toContain("Script result");
  });
  it("wraps expressions and statements", () => {
    expect(wrapScript("1 + 1")).toContain("return (1 + 1);");
    expect(wrapScript("const a = 1; return a;")).toContain("const a = 1; return a;");
  });
});

const chrome = findChrome();
describe.skipIf(!chrome)("inspect_page in a real browser", () => {
  it("reads a local page's title, structure and script result", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>Tiny</title><h1>Hello</h1><button id=b style="width:120px;height:30px">Go</button>` +
          `<label>Name <input type=text value=Ann></label><a href="/x">More</a><p style="display:none">secret</p>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const out = await tool.run(ctx(), { url, script: "document.querySelector('#b').getBoundingClientRect().width" });
      expect(out).toContain("Title: Tiny");
      expect(out).toContain("[h1] Hello");
      expect(out).toContain("[button] Go");
      expect(out).toContain('[text] Name = "Ann"');
      expect(out).toContain("[link] More -> /x");
      expect(out).not.toContain("secret");
      expect(out).toContain("Script result:\n120");
      const bad = await tool.run(ctx(), { url, script: "nope.x" });
      expect(bad).toContain("the script failed");
    } finally {
      server.close();
    }
  }, 60_000);
});
if (!chrome) console.warn("inspect_page browser test skipped: no Chrome found (install Chrome or set LLAMA_MUI_CHROME)");
