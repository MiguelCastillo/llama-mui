import { describe, expect, it, vi } from "vitest";
import { SESSION_KEY, sessionFromHash, sessionHash, takeSessionRoute } from "../sessionRoute";

const ID = "c570be3a-86ba-4256-bda7-46fee952753e";

describe("sessionFromHash", () => {
  it("reads the id from a session address", () => {
    expect(sessionFromHash(`#/session/${ID}`)).toBe(ID);
    expect(sessionFromHash(sessionHash("abc-1"))).toBe("abc-1");
  });

  it("ignores every other address", () => {
    for (const hash of ["", "#/settings/models", "#/welcome", `#/pair/${ID}`, "#/session/", "#/sessions/x", `#/session/${ID}/more`]) {
      expect(sessionFromHash(hash)).toBeNull();
    }
  });

  it("refuses an id the server would refuse", () => {
    expect(sessionFromHash("#/session/Has%20Spaces")).toBeNull();
    expect(sessionFromHash("#/session/UPPER")).toBeNull();
    expect(sessionFromHash("#/session/../x")).toBeNull();
    expect(sessionFromHash(`#/session/${"a".repeat(65)}`)).toBeNull();
  });
});

describe("takeSessionRoute", () => {
  it("makes the named chat the open one and clears the address", () => {
    const setItem = vi.fn();
    const clear = vi.fn();
    expect(takeSessionRoute(`#/session/${ID}`, { setItem }, clear)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(SESSION_KEY, ID);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does nothing for any other address", () => {
    const setItem = vi.fn();
    const clear = vi.fn();
    expect(takeSessionRoute("#/settings/models", { setItem }, clear)).toBe(false);
    expect(takeSessionRoute("", { setItem }, clear)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("leaves the address alone when storage can't be written, so nothing looks opened that isn't", () => {
    const clear = vi.fn();
    const setItem = () => {
      throw new Error("blocked");
    };
    expect(takeSessionRoute(`#/session/${ID}`, { setItem }, clear)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});
