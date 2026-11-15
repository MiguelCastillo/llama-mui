import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's a temp one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { handler } = await import("../plugin.ts");
const { auditDir } = await import("../audit.ts");

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => handler(req, res, () => {}));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => void server.close());

function send(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers: { "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      // The audit line is written when the response closes.
      res.on("close", () => setTimeout(() => resolve(res.statusCode ?? 0), 20));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const lines = () =>
  (existsSync(auditDir()) ? readdirSync(auditDir()) : []).flatMap((f) =>
    readFileSync(`${auditDir()}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l)),
  ).filter((l) => l.event === "api.request");

const id = "11111111-2222-4333-8444-555555555555";

describe("api.request audit", () => {
  it("records an accepted session save, without the body", async () => {
    const before = lines().length;
    expect(await send("PUT", `/sessions/${id}`, { messages: [{ role: "user", content: "SECRET PROMPT" }] })).toBe(200);
    const got = lines().slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: "PUT", route: `/api/sessions/${id}`, session: id, status: 200 });
    expect(typeof got[0].ms).toBe("number");
    expect(got[0].who).toHaveProperty("address");
    expect(JSON.stringify(got[0])).not.toContain("SECRET");
  });

  it("records a save refused as stale, with the reason", async () => {
    const before = lines().length;
    expect(await send("PUT", `/sessions/${id}`, { messages: [], revision: 0 })).toBe(409);
    const got = lines().slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ status: 409, session: id });
    expect(got[0].reason).toBeTruthy();
  });

  it("records an approve command", async () => {
    const before = lines().length;
    const status = await send("POST", `/sessions/${id}/commands/approve`, { allow: true, askId: "nope" });
    const got = lines().slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: "POST", route: `/api/sessions/${id}/commands/approve`, status });
  });

  it("records an unpaired device", async () => {
    const before = lines().length;
    expect(await send("GET", "/sessions", undefined, { "x-forwarded-for": "10.0.0.9" })).toBe(401);
    const got = lines().slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: "GET", status: 401, reason: "unpaired" });
  });

  it("records a cross-site request", async () => {
    const before = lines().length;
    expect(await send("POST", `/sessions/${id}/commands/approve`, {}, { "sec-fetch-site": "cross-site" })).toBe(403);
    const got = lines().slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ status: 403, reason: "cross-site" });
  });

  it("skips a GET that worked", async () => {
    const before = lines().length;
    expect(await send("GET", `/sessions/${id}`)).toBe(200);
    expect(lines().length).toBe(before);
  });
});
