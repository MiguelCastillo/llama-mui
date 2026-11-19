import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connection } from "../connections";
import { unlistedModel } from "../modelChoice";

const list = [{ id: "a" }, { id: "b" }];
const base = { loaded: true, connectorId: "c1", listRead: "c1", chosen: "gone", options: list };

describe("a stored model the connection does not list", () => {
  it("is named when a list read for this connection lacks it", () => {
    expect(unlistedModel("llama", base)).toBe("gone");
    expect(unlistedModel("anthropic", base)).toBe("gone");
  });
  it("is not named when the list holds it", () => {
    expect(unlistedModel("llama", { ...base, chosen: "b" })).toBeNull();
  });
  it("says nothing when the answer is unknown: chat not answered, no list read, list failed, list for another connection, no model", () => {
    expect(unlistedModel("llama", { ...base, loaded: false })).toBeNull();
    expect(unlistedModel("llama", { ...base, listRead: null })).toBeNull();
    expect(unlistedModel("llama", { ...base, listRead: "c2" })).toBeNull();
    expect(unlistedModel("llama", { ...base, connectorId: null })).toBeNull();
    expect(unlistedModel("llama", { ...base, chosen: "" })).toBeNull();
  });
  it("is decided by the connection, which every connection answers", () => {
    for (const kind of ["llama", "anthropic"] as const) {
      expect(connection(kind).listsModel(list, "a")).toBe(true);
      expect(connection(kind).listsModel([], "a")).toBe(false);
    }
  });
});

describe("the page uses it", () => {
  const chat = readFileSync(new URL("../Chat.tsx", import.meta.url), "utf8");
  it("blocks sending and draws a notice worded apart from the 'isn't loaded' one", () => {
    expect(chat).toMatch(/if \(missingModel \|\| problem\) return false;/);
    expect(chat).toMatch(/drawnActions\(loaded, serverActions, !!model && !missingModel && !problem, runActive\)/);
    expect(chat).toMatch(/is not in the list that/);
    expect(chat).toMatch(/isn't loaded, so nothing was sent/);
  });
  it("never sets the model because it is unlisted", () => {
    const i = chat.indexOf("const missingModel = ");
    expect(chat.slice(i, i + 400)).not.toMatch(/setModel\(/);
  });
});
