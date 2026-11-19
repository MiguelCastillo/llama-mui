import { describe, expect, it } from "vitest";
import { connectionForChat, defaultIfListed } from "../modelChoice";

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

describe("defaultIfListed", () => {
  const models = [{ id: "m1" }, { id: "m2" }];

  it("offers the connection's default when it lists it", () => {
    expect(defaultIfListed("m2", models)).toBe("m2");
  });

  it("offers nothing otherwise: no loaded or first model is picked for the user", () => {
    expect(defaultIfListed("nope", models)).toBe("");
    expect(defaultIfListed(undefined, models)).toBe("");
    expect(defaultIfListed("m1", [])).toBe("");
  });
});
