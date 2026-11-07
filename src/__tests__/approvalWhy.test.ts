import { describe, expect, it } from "vitest";
import { approvalWhy } from "../approvalWhy.ts";

describe("approvalWhy", () => {
  it("shows the reason after 'Why:'", () => {
    expect(approvalWhy("Checking which commit that hash is")).toEqual({ text: "Why: Checking which commit that hash is", missing: false });
  });

  it("trims the reason", () => {
    expect(approvalWhy("  Fixing the typo \n")).toEqual({ text: "Why: Fixing the typo", missing: false });
  });

  it("says no reason was given when it is absent or blank", () => {
    for (const r of [undefined, null, "", "   \n"]) {
      expect(approvalWhy(r)).toEqual({ text: "No reason given", missing: true });
    }
  });
});
