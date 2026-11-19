import { describe, expect, it } from "vitest";
import { ENVIRONMENT_KEYS, environmentOf } from "../sessionEnvironment.ts";

describe("session environment", () => {
  it("lists exactly these items", () => {
    expect(ENVIRONMENT_KEYS).toEqual(["connectorId", "model", "workingDir", "attachments", "autoApprove", "persona"]);
  });

  it("reads every item that is stored", () => {
    const s = { connectorId: "c1", model: "m", workingDir: "/w", attachments: [{ path: "/a" }], autoApprove: { commands: true }, persona: "p" };
    expect(environmentOf(s)).toEqual(s);
  });

  it("leaves out what is missing or empty, but keeps a null folder", () => {
    expect(environmentOf({ connectorId: "", model: 3 })).toEqual({});
    expect(environmentOf({ workingDir: null })).toEqual({ workingDir: null });
  });
});
