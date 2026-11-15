import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audit, auditDir } from "../audit";
import { runWithCause } from "../auditContext";

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(mkdtempSync(path.join(os.tmpdir(), "audit-cause-")));
});
afterEach(() => vi.restoreAllMocks());

const lines = () => readdirSync(auditDir()).flatMap((f) => readFileSync(path.join(auditDir(), f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

describe("audit and the current cause", () => {
  it("adds session, call and request from the cause, not who", async () => {
    await runWithCause({ session: "s1", call: "c1", request: "r1", who: { address: "a", agent: "b" } }, async () => {
      await new Promise((r) => setTimeout(r, 2));
      audit("x.event", { n: 1 });
    });
    expect(lines()[0]).toMatchObject({ event: "x.event", n: 1, session: "s1", call: "c1", request: "r1" });
    expect(lines()[0]).not.toHaveProperty("who");
  });

  it("lets a field the caller gives win over the cause", () => {
    runWithCause({ session: "s1", call: "c1" }, () => audit("x.event", { session: "other" }));
    expect(lines()[0]).toMatchObject({ session: "other", call: "c1" });
  });

  it("adds nothing outside any cause", () => {
    audit("x.event");
    const l = lines()[0];
    expect(l).not.toHaveProperty("session");
    expect(l).not.toHaveProperty("call");
    expect(l).not.toHaveProperty("request");
  });
});
