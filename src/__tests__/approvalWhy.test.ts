import { describe, expect, it } from "vitest";
import { approvalWhy, readOnlyLabel } from "../approvalWhy.ts";

describe("readOnlyLabel", () => {
  it("says 'Looks only' for true and 'Changes things' for false", () => {
    expect(readOnlyLabel(true)).toEqual({ text: "Looks only", missing: false });
    expect(readOnlyLabel(false)).toEqual({ text: "Changes things", missing: false });
  });

  it("says it was not stated when absent", () => {
    for (const v of [undefined, null]) {
      expect(readOnlyLabel(v)).toEqual({ text: "Not stated by the model", missing: true });
    }
  });
});

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
