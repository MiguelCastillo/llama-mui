import { describe, expect, it } from "vitest";
import { connectionForChat, pickModel } from "../modelChoice";

const a = { id: "a", name: "A" };
const b = { id: "b", name: "B" };
const c = { id: "c", name: "C" };

describe("connectionForChat", () => {
  it("keeps the connection the chat saved", () => {
    expect(connectionForChat([a, b, c], "b", "c")).toBe(b);
  });

  it("returns null when the saved connection was deleted, without switching", () => {
    expect(connectionForChat([a, c], "b", "c")).toBeNull();
    expect(connectionForChat([a, c], "b", null)).toBeNull();
  });

  it("uses the last used connection for an old chat with none saved", () => {
    expect(connectionForChat([a, b, c], undefined, "c")).toBe(c);
    expect(connectionForChat([a, b, c], null, "b")).toBe(b);
  });

  it("uses the first connection when nothing was saved and the last used one is gone", () => {
    expect(connectionForChat([a, b], undefined, "gone")).toBe(a);
    expect(connectionForChat([a, b], undefined, null)).toBe(a);
  });

  it("starts a new chat on the last used connection", () => {
    expect(connectionForChat([a, b, c], null, "b")).toBe(b);
  });

  it("returns null when there are no connections", () => {
    expect(connectionForChat([], "a", "a")).toBeNull();
    expect(connectionForChat([], null, null)).toBeNull();
  });
});

describe("pickModel", () => {
  const models = [
    { id: "m1", status: "unloaded" as const },
    { id: "m2", status: "loaded" as const },
    { id: "m3", status: "unloaded" as const },
  ];

  it("keeps the current model when the connection lists it", () => {
    expect(pickModel({ current: "m3", defaultModel: "m1", models })).toBe("m3");
  });

  it("uses the new connection's default when the current model isn't listed", () => {
    expect(pickModel({ current: "other", defaultModel: "m3", models })).toBe("m3");
  });

  it("uses a loaded model when neither current nor default is listed", () => {
    expect(pickModel({ current: "other", defaultModel: "nope", models })).toBe("m2");
    expect(pickModel({ current: "", models })).toBe("m2");
  });

  it("uses the first model when none are loaded", () => {
    const none = models.map((m) => ({ ...m, status: "unloaded" as const }));
    expect(pickModel({ current: "", models: none })).toBe("m1");
  });

  it("starts a new chat on the connection's default model", () => {
    expect(pickModel({ current: "", defaultModel: "m3", models })).toBe("m3");
  });

  it("returns an empty model for an empty list", () => {
    expect(pickModel({ current: "m1", defaultModel: "m1", models: [] })).toBe("");
  });
});
