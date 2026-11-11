import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, setApiOrigin, streamChat } from "../api";

// The server runs plans with the page's client code, so the origin of /api can
// be set (see setApiOrigin). These tests run with no `location` at all, as in Node.

const urls: string[] = [];
function serve(body: () => Response) {
  urls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url instanceof Request ? url.url : url));
      return body();
    }),
  );
}

afterEach(() => {
  setApiOrigin(null);
  vi.unstubAllGlobals();
});

describe("setApiOrigin", () => {
  it("sends plain requests to the given origin, and the page's own paths when it is cleared", async () => {
    serve(() => Response.json({ data: [] }));
    setApiOrigin("http://127.0.0.1:5173/");
    await listModels("c1");
    expect(urls).toEqual(["http://127.0.0.1:5173/api/c/c1/v1/models?limit=1000"]);

    setApiOrigin(null);
    await listModels("c1");
    expect(urls[1]).toBe("/api/c/c1/v1/models?limit=1000");
  });

  it("points the chat SDKs at the same origin, with only the placeholder key", async () => {
    const sse = [{ choices: [{ delta: { content: "Hi" } }] }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const headers: Record<string, string>[] = [];
    urls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url instanceof Request ? url.url : url));
        // llama.cpp's /props, asked before the reply: not loaded here.
        if (String(url).includes("/props?")) return new Response("{}", { status: 400 });
        headers.push(Object.fromEntries(new Headers(init?.headers)));
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    setApiOrigin("http://127.0.0.1:4173");
    await streamChat(
      { connectorId: "c1", model: "m", api: "openai", kind: "llama", purpose: { kind: "background" }, messages: [{ role: "user", content: "hi" }] },
      () => {},
      new AbortController().signal,
    );
    expect(urls.filter((u) => !u.includes("/props?"))).toEqual(["http://127.0.0.1:4173/api/c/c1/v1/chat/completions"]);
    expect(urls.some((u) => u.startsWith("http://127.0.0.1:4173/api/c/c1/props?"))).toBe(true);
    expect(headers[0].authorization).toBe("Bearer set-by-the-server");
  });
});
