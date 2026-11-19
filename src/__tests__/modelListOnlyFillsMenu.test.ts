import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { afterModelList, menuValue, shownModel } from "../modelChoice";

const list = [
  { id: "a", status: "loaded" as const },
  { id: "b", status: "unloaded" as const },
];

describe("a model list only fills the menu", () => {
  it("leaves a stored model that the list holds as it was", () => {
    expect(afterModelList("b", list)).toEqual({ options: list, chosen: "b" });
  });
  it("leaves a stored model that the list does not hold shown as chosen", () => {
    const r = afterModelList("gone", list);
    expect(r.chosen).toBe("gone");
    expect(shownModel(true, r.chosen)).toBe("gone");
    expect(menuValue(true, r.chosen, r.options)).toBe(""); // no matching option, the name is still drawn
  });
  it("picks nothing when the chat has no stored model: not the loaded one, not the first", () => {
    expect(afterModelList("", list).chosen).toBe("");
  });
  it("picks nothing from an empty list, and keeps the stored model", () => {
    expect(afterModelList("a", [])).toEqual({ options: [], chosen: "a" });
  });
  it("a list that arrives before the chat's answer chooses nothing, and the answer's model is then shown whatever the list", () => {
    const early = afterModelList("", list); // list first: model still unknown
    expect(early.chosen).toBe("");
    expect(shownModel(false, "")).toBeNull(); // nothing drawn until the chat has answered
    expect(menuValue(true, "b", early.options)).toBe("b"); // the answer arrives: its model is the choice
    expect(shownModel(true, "unlisted")).toBe("unlisted");
  });
  it("a list that arrives after the answer leaves its model alone", () => {
    expect(afterModelList("b", list).chosen).toBe("b");
  });
});

describe("the page uses them", () => {
  const chat = readFileSync(new URL("../Chat.tsx", import.meta.url), "utf8");
  const start = chat.indexOf("const refreshModels = ");
  const body = chat.slice(start, chat.indexOf("refreshModelsAfterTurn.current = ", start));
  it("the loader goes through afterModelList and never sets the model or connection", () => {
    expect(body).toMatch(/afterModelList\(/);
    expect(body).not.toMatch(/setModel\(|setConnectorId\(/);
  });
  it("the page has no fallback chain", () => {
    expect(chat).not.toMatch(/pickModel\(/);
  });
});
