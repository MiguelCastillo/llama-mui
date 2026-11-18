import { describe, expect, it } from "vitest";
import { appEnvironment, managerPortIsInvalid, readManagerPort } from "../manager/main.ts";

describe("manager entry point settings", () => {
  it("defaults to 5170", () => {
    expect(readManagerPort({})).toBe(5170);
    expect(readManagerPort({ MANAGER_PORT: "" })).toBe(5170);
  });
  it("reads MANAGER_PORT", () => {
    expect(readManagerPort({ MANAGER_PORT: "5160" })).toBe(5160);
  });
  it("falls back on a bad value and says so", () => {
    expect(readManagerPort({ MANAGER_PORT: "abc" })).toBe(5170);
    expect(readManagerPort({ MANAGER_PORT: "70000" })).toBe(5170);
    expect(managerPortIsInvalid({ MANAGER_PORT: "abc" })).toBe(true);
    expect(managerPortIsInvalid({ MANAGER_PORT: "5160" })).toBe(false);
    expect(managerPortIsInvalid({})).toBe(false);
  });
  it("passes the app's ports through and keeps MANAGER_PORT out", () => {
    const env = appEnvironment({ HTTPS_PORT: "5167", HTTP_PORT: "5166", MANAGER_PORT: "5160" });
    expect(env.HTTPS_PORT).toBe("5167");
    expect(env.HTTP_PORT).toBe("5166");
    expect(env.MANAGER_PORT).toBeUndefined();
  });
});
