import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mgr-http-"));
vi.spyOn(os, "homedir").mockReturnValue(tmp);

let createManagerServer: typeof import("../manager/http.ts").createManagerServer;
beforeAll(async () => {
  ({ createManagerServer } = await import("../manager/http.ts"));
});

const status = { state: "running", pid: 42, startedAt: 1, lastRestart: null, lastBuild: null } as const;

function fake() {
  const calls: string[] = [];
  return {
    calls,
    status: () => ({ ...status }),
    restart: vi.fn(async () => {
      calls.push("restart");
      return { ok: true } as const;
    }),
  };
}

let server: http.Server | undefined;
async function boot(sup: ReturnType<typeof fake>, delay = 2000) {
  server = createManagerServer(sup, delay);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}
function call(port: number, method: string, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ code: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ code: res.statusCode!, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("manager http", () => {
  it("GET /status returns the supervisor's status", async () => {
    const port = await boot(fake());
    const r = await call(port, "GET", "/status");
    expect(r.code).toBe(200);
    expect(r.body).toEqual(status);
  });

  it("POST /restart answers 202 before it acts, then restarts after the delay", async () => {
    const sup = fake();
    const port = await boot(sup);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = await call(port, "POST", "/restart");
    expect(r.code).toBe(202);
    expect(r.body).toEqual({ restarting: true, inSeconds: 2 });
    expect(sup.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sup.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sup.restart).toHaveBeenCalledWith({ build: true });
  });

  it("answers 409 while a restart is pending", async () => {
    const sup = fake();
    const port = await boot(sup);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    expect((await call(port, "POST", "/restart")).code).toBe(202);
    const again = await call(port, "POST", "/restart");
    expect(again.code).toBe(409);
    expect(again.body.error).toBe("already restarting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sup.restart).toHaveBeenCalledTimes(1);
  });

  it("refuses a call carrying a proxy header", async () => {
    const sup = fake();
    const port = await boot(sup);
    for (const h of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
      const r = await call(port, "POST", "/restart", { [h]: "1.2.3.4" });
      expect(r.code).toBe(403);
    }
    expect((await call(port, "GET", "/status", { "x-forwarded-for": "1.2.3.4" })).code).toBe(403);
    expect(sup.restart).not.toHaveBeenCalled();
  });

  it("answers 404 for unknown paths and 405 with Allow for wrong methods", async () => {
    const port = await boot(fake());
    expect((await call(port, "GET", "/nope")).code).toBe(404);
    const a = await call(port, "GET", "/restart");
    expect(a.code).toBe(405);
    expect(a.headers.allow).toBe("POST");
    const b = await call(port, "POST", "/status");
    expect(b.code).toBe(405);
    expect(b.headers.allow).toBe("GET");
  });
});
