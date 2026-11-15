import { describe, expect, it } from "vitest";
import { currentCause, newId, runWithCause } from "../auditContext.ts";

describe("the audit cause", () => {
  it("is empty outside any run", () => {
    expect(currentCause()).toEqual({});
  });

  it("is visible inside an async run, across awaits and timers, and gone after it", async () => {
    const seen = await runWithCause({ session: "s1", call: "c1" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentCause();
    });
    expect(seen).toEqual({ session: "s1", call: "c1" });
    expect(currentCause()).toEqual({});
  });

  it("keeps parallel runs apart and lets a nested run add to the outer one", async () => {
    const [a, b] = await Promise.all([
      runWithCause({ call: "a" }, async () => (await Promise.resolve(), currentCause().call)),
      runWithCause({ call: "b" }, async () => (await new Promise((r) => setTimeout(r, 2)), currentCause().call)),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
    const nested = runWithCause({ request: "r" }, () => runWithCause({ call: "c" }, currentCause));
    expect(nested).toEqual({ request: "r", call: "c" });
  });

  it("makes short ids", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}$/);
  });
});
