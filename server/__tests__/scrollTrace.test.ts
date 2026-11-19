import { beforeEach, describe, expect, it, vi } from "vitest";

const logged: { event: string; fields: Record<string, unknown> }[] = [];
vi.mock("../log.ts", () => ({
  log: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
}));

const { cleanTrace, scrollTraceRoutes, SCROLL_TRACE_MAX_BYTES } = await import("../scrollTrace.ts");

function route(body: string) {
  const req = (async function* () {
    yield Buffer.from(body);
  })() as unknown as import("node:http").IncomingMessage;
  const res = { statusCode: 0, body: "", setHeader() {}, end(b: string) { this.body = b; } };
  return { r: { req, res: res as unknown as import("node:http").ServerResponse, parts: ["scroll-trace"], method: "POST", search: "" }, res };
}

beforeEach(() => {
  logged.length = 0;
});

describe("the scroll-trace route", () => {
  it("logs one scroll.trace line with only the known fields", async () => {
    const body = {
      session: "abc-123",
      summary: { frames: 2, worstOff: -31, worstAt: 600, suspects: [{ t: 590, what: "plan", kind: "resized", dh: -31, text: "secret" }] },
      frames: [{ t: 1, st: 2, off: -3, h: 1, text: "secret", extra: 5 }],
      changes: [{ t: 1, kind: "resized", what: "my words here", above: 1, dh: -31 }],
      marks: [{ t: 2, name: "hold:-31" }],
      prompt: "secret",
    };
    const { r, res } = route(JSON.stringify(body));
    expect(await scrollTraceRoutes(r)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(logged).toHaveLength(1);
    expect(logged[0].event).toBe("scroll.trace");
    const line = JSON.stringify(logged[0].fields);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("my words");
    expect(logged[0].fields).toMatchObject({ session: "abc-123", marks: [{ t: 2, name: "hold:-31" }] });
  });

  it("refuses a body over the size limit", async () => {
    const { r } = route("x".repeat(SCROLL_TRACE_MAX_BYTES + 1));
    await expect(scrollTraceRoutes(r)).rejects.toMatchObject({ status: 413 });
    expect(logged).toHaveLength(0);
  });

  it("refuses a body without a session id", () => {
    expect(cleanTrace({ frames: [] }).ok).toBe(false);
    expect(cleanTrace({ session: "../etc", frames: [] }).ok).toBe(false);
  });

  it("leaves other routes alone", async () => {
    const { r } = route("{}");
    expect(await scrollTraceRoutes({ ...r, parts: ["sessions"] })).toBe(false);
  });
});
