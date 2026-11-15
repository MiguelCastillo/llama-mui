import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Home is a temp folder before anything loads: never the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { auditedFetch } = await import("../io/fetch.ts");
const { runWithCause } = await import("../auditContext.ts");
const { auditDir } = await import("../audit.ts");

const raw = () =>
  readdirSync(auditDir())
    .sort()
    .map((f) => readFileSync(path.join(auditDir(), f), "utf8"))
    .join("");
const lines = () =>
  raw()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "io.fetch");
const lastLine = () => lines().at(-1);

let base = "";
const server = createServer((req, res) => {
  if (req.url?.startsWith("/slow")) return; // never answers
  if (req.url?.startsWith("/stream")) {
    res.write("first\n");
    setTimeout(() => res.end("second\n"), 200);
    return;
  }
  res.statusCode = req.url?.startsWith("/missing") ? 404 : 200;
  res.end("ok");
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("io.fetch", () => {
  it("writes one line for a request that works, with the cause", async () => {
    const res = await runWithCause({ session: "s1", request: "r1" }, () => auditedFetch(`${base}/page`, undefined, { why: "test.page" }));
    expect(await res.text()).toBe("ok");
    const l = lastLine();
    expect(l).toMatchObject({ why: "test.page", session: "s1", request: "r1", method: "GET", host: base.replace("http://", ""), path: "/page", status: 200 });
    expect(typeof l.ms).toBe("number");
    expect(l.error).toBeUndefined();
  });

  it("logs a status that is an error answer", async () => {
    await auditedFetch(`${base}/missing`, { method: "post" }, { why: "test.missing" });
    expect(lastLine()).toMatchObject({ why: "test.missing", method: "POST", status: 404 });
  });

  it("logs a connection failure with its error and rethrows", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await expect(auditedFetch(`http://127.0.0.1:${port}/x`, undefined, { why: "test.refused" })).rejects.toThrow();
    const l = lastLine();
    expect(l).toMatchObject({ why: "test.refused", path: "/x" });
    expect(l.status).toBeUndefined();
    expect(l.error).toBe("ECONNREFUSED");
  });

  it("keeps the caller's timeout working and logs it", async () => {
    await expect(auditedFetch(`${base}/slow`, { signal: AbortSignal.timeout(100) }, { why: "test.slow" })).rejects.toThrow();
    expect(lastLine()).toMatchObject({ why: "test.slow", error: "TimeoutError" });
  });

  it("hands back a streaming body before it ends", async () => {
    const res = await auditedFetch(`${base}/stream`, undefined, { why: "test.stream" });
    const reader = res.body!.getReader();
    const t = Date.now();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("first\n");
    expect(Date.now() - t).toBeLessThan(150);
    await reader.cancel();
  });

  it("never writes the query, headers or body", async () => {
    await auditedFetch(
      `${base}/search?q=secret-query&key=sk-12345`,
      { method: "POST", headers: { Authorization: "Bearer sk-header-token" }, body: "body-secret-text" },
      { why: "test.secret" },
    );
    const l = lastLine();
    expect(l.path).toBe("/search");
    const all = raw();
    for (const s of ["secret-query", "sk-12345", "sk-header-token", "body-secret-text", "Authorization"]) expect(all).not.toContain(s);
  });
});
