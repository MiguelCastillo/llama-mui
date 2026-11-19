import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionProblem } from "../modelChoice";

const connectors = [{ id: "c1", name: "Studio" }];
const base = { loaded: true, connectors, storedId: "c1", listFailed: null };

describe("connectionProblem", () => {
  it("names a deleted connection by its stored id", () => {
    expect(connectionProblem({ ...base, storedId: "gone" })).toEqual({ kind: "deleted", id: "gone" });
    expect(connectionProblem({ ...base, connectors: [], storedId: "gone" })).toEqual({ kind: "deleted", id: "gone" });
  });
  it("names an unreachable connection by its name", () => {
    expect(connectionProblem({ ...base, listFailed: "c1" })).toEqual({ kind: "unreachable", id: "c1", name: "Studio" });
  });
  it("says nothing when it is unknown or fine", () => {
    expect(connectionProblem(base)).toBeNull();
    expect(connectionProblem({ ...base, loaded: false, storedId: "gone" })).toBeNull();
    expect(connectionProblem({ ...base, connectors: undefined, storedId: "gone" })).toBeNull();
    expect(connectionProblem({ ...base, storedId: null })).toBeNull();
    expect(connectionProblem({ ...base, listFailed: "c2" })).toBeNull();
  });
});

describe("the page uses it", () => {
  const chat = readFileSync(new URL("../Chat.tsx", import.meta.url), "utf8");
  it("blocks sending and words the two cases apart", () => {
    expect(chat).toMatch(/if \(missingModel \|\| problem\) return false;/);
    expect(chat).toMatch(/no longer exists. Nothing was sent/);
    expect(chat).toMatch(/can't be reached. Nothing was sent/);
  });
  it("never switches the connection because of it", () => {
    const i = chat.indexOf("const problem = ");
    expect(chat.slice(i, i + 300)).not.toMatch(/setConnectorId\(/);
  });
});
