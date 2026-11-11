import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_KEY, openChatHash, routeSession, sessionFromHash, sessionHash, setSessionAddress } from "../sessionRoute";

const ID = "c570be3a-86ba-4256-bda7-46fee952753e";

afterEach(() => vi.unstubAllGlobals());

describe("setSessionAddress", () => {
  const fake = (hash: string, pushThrows = false) => {
    const pushState = vi.fn(() => {
      if (pushThrows) throw new Error("blocked");
    });
    const replaceState = vi.fn();
    vi.stubGlobal("location", { hash });
    vi.stubGlobal("history", { pushState, replaceState });
    return { pushState, replaceState };
  };

  it("pushes a new history entry in push mode", () => {
    const { pushState, replaceState } = fake("");
    setSessionAddress(ID, "push");
    expect(pushState).toHaveBeenCalledWith(null, "", `#/session/${ID}`);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("rewrites the current entry in replace mode", () => {
    const { pushState, replaceState } = fake("#/session/other");
    setSessionAddress(ID, "replace");
    expect(replaceState).toHaveBeenCalledWith(null, "", `#/session/${ID}`);
    expect(pushState).not.toHaveBeenCalled();
  });

  it("does nothing when the address already names the chat", () => {
    const { pushState, replaceState } = fake(`#/session/${ID}`);
    setSessionAddress(ID, "push");
    setSessionAddress(ID, "replace");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("doesn't throw when the address can't be changed", () => {
    fake("", true);
    expect(() => setSessionAddress(ID, "push")).not.toThrow();
  });
});

describe("openChatHash", () => {
  const store = (value: string | null) => vi.stubGlobal("localStorage", { getItem: () => value });

  it("is the address of the remembered chat", () => {
    store(ID);
    expect(openChatHash()).toBe(`#/session/${ID}`);
  });

  it("is empty when nothing or a bad id is remembered", () => {
    store(null);
    expect(openChatHash()).toBe("");
    store("UPPER");
    expect(openChatHash()).toBe("");
  });

  it("is empty when storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(openChatHash()).toBe("");
  });
});

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

describe("routeSession", () => {
  it("returns the named id and remembers it as the open chat", () => {
    const setItem = vi.fn();
    expect(routeSession(`#/session/${ID}`, { setItem })).toBe(ID);
    expect(setItem).toHaveBeenCalledWith(SESSION_KEY, ID);
  });

  it("returns null and remembers nothing for other addresses", () => {
    const setItem = vi.fn();
    expect(routeSession("#/settings/models", { setItem })).toBeNull();
    expect(routeSession("", { setItem })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("returns null and remembers nothing for a bad id", () => {
    const setItem = vi.fn();
    expect(routeSession("#/session/UPPER", { setItem })).toBeNull();
    expect(routeSession("#/session/../x", { setItem })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("still returns the id when storage can't be written", () => {
    const setItem = () => {
      throw new Error("blocked");
    };
    expect(routeSession(`#/session/${ID}`, { setItem })).toBe(ID);
  });
});
