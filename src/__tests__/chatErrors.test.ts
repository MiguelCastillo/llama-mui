import { describe, expect, it } from "vitest";
import {
  clearOnShow,
  clearSendRefusal,
  dropSession,
  emptyChatErrors,
  leaveSession,
  mirrorRun,
  setGlobal,
  setSession,
  visibleError,
} from "../chatErrors";

describe("chatErrors", () => {
  it("shows a session's error only in that session", () => {
    const s = setSession(emptyChatErrors, "A", "A reply is still streaming");
    expect(visibleError(s, "A")).toBe("A reply is still streaming");
    expect(visibleError(s, "B")).toBeNull();
    expect(visibleError(s, null)).toBeNull();
  });

  it("shows a global error in every session", () => {
    const s = setGlobal(emptyChatErrors, "Server unreachable");
    expect(visibleError(s, "A")).toBe("Server unreachable");
    expect(visibleError(s, "B")).toBe("Server unreachable");
    expect(visibleError(s, null)).toBe("Server unreachable");
  });

  it("prefers the open session's own error over the global one", () => {
    let s = setGlobal(emptyChatErrors, "global");
    s = setSession(s, "A", "own");
    expect(visibleError(s, "A")).toBe("own");
    expect(visibleError(s, "B")).toBe("global");
  });

  it("clears a global or session error with null", () => {
    let s = setGlobal(emptyChatErrors, "g");
    s = setSession(s, "A", "a");
    s = setGlobal(s, null);
    s = setSession(s, "A", null);
    expect(s).toEqual(emptyChatErrors);
  });

  it("never changes the state it was given", () => {
    const start = setSession(setGlobal(emptyChatErrors, "g"), "A", "a");
    const snapshot = JSON.parse(JSON.stringify(start));
    setGlobal(start, "x");
    setSession(start, "A", "y");
    setSession(start, "B", "z");
    mirrorRun(start, "A", "run");
    mirrorRun(start, "A", null);
    clearSendRefusal(start, "A");
    leaveSession(start, "A");
    clearOnShow(start, "A");
    dropSession(start, "A");
    expect(start).toEqual(snapshot);
  });

  describe("mirrorRun", () => {
    it("sets a run error and replaces it when the run error changes", () => {
      let s = mirrorRun(emptyChatErrors, "A", "first");
      expect(s.bySession.A).toEqual({ message: "first", fromRun: true });
      s = mirrorRun(s, "A", "second");
      expect(s.bySession.A).toEqual({ message: "second", fromRun: true });
    });

    it("returns the same state when the same run error is already there", () => {
      const s = mirrorRun(emptyChatErrors, "A", "boom");
      expect(mirrorRun(s, "A", "boom")).toBe(s);
    });

    it("clears a run error when the run's error clears", () => {
      const s = mirrorRun(emptyChatErrors, "A", "boom");
      expect(visibleError(mirrorRun(s, "A", null), "A")).toBeNull();
    });

    it("leaves a refusal alone when the run has no error", () => {
      const s = setSession(emptyChatErrors, "A", "refused");
      const after = mirrorRun(s, "A", null);
      expect(after).toBe(s);
      expect(visibleError(after, "A")).toBe("refused");
    });

    it("only touches the session it is given", () => {
      let s = mirrorRun(emptyChatErrors, "A", "run A");
      s = mirrorRun(s, "B", "run B");
      s = mirrorRun(s, "A", null);
      expect(visibleError(s, "A")).toBeNull();
      expect(visibleError(s, "B")).toBe("run B");
    });
  });

  describe("clearSendRefusal", () => {
    it("drops a refusal", () => {
      const s = setSession(emptyChatErrors, "A", "refused");
      expect(visibleError(clearSendRefusal(s, "A"), "A")).toBeNull();
    });

    it("does not wipe a run error", () => {
      const s = mirrorRun(emptyChatErrors, "A", "boom");
      const after = clearSendRefusal(s, "A");
      expect(after).toBe(s);
      expect(visibleError(after, "A")).toBe("boom");
    });

    it("leaves other sessions and the global error alone", () => {
      let s = setGlobal(emptyChatErrors, "g");
      s = setSession(s, "A", "a");
      s = setSession(s, "B", "b");
      const after = clearSendRefusal(s, "A");
      expect(visibleError(after, "B")).toBe("b");
      expect(visibleError(after, "A")).toBe("g");
    });
  });

  describe("leaveSession", () => {
    it("drops a session's own error", () => {
      const s = setSession(emptyChatErrors, "A", "refused");
      const after = leaveSession(s, "A");
      expect(after.bySession).toEqual({});
    });

    it("keeps a run error, since the run goes on in the server", () => {
      const s = mirrorRun(emptyChatErrors, "A", "boom");
      expect(leaveSession(s, "A")).toBe(s);
      expect(visibleError(leaveSession(s, "A"), "A")).toBe("boom");
    });

    it("keeps the global error", () => {
      const s = setGlobal(setSession(emptyChatErrors, "A", "a"), "g");
      expect(leaveSession(s, "A").global).toBe("g");
    });
  });

  describe("clearOnShow", () => {
    it("drops the global error and the open session's own error", () => {
      let s = setGlobal(emptyChatErrors, "g");
      s = setSession(s, "A", "a");
      s = setSession(s, "B", "b");
      const after = clearOnShow(s, "A");
      expect(after.global).toBeNull();
      expect(after.bySession.A).toBeUndefined();
      expect(after.bySession.B).toEqual({ message: "b", fromRun: false });
    });

    it("keeps the open session's run error", () => {
      const s = mirrorRun(setGlobal(emptyChatErrors, "g"), "A", "boom");
      const after = clearOnShow(s, "A");
      expect(after.global).toBeNull();
      expect(visibleError(after, "A")).toBe("boom");
    });

    it("clears only the global error when no session is open", () => {
      const s = setSession(setGlobal(emptyChatErrors, "g"), "A", "a");
      const after = clearOnShow(s, null);
      expect(after.global).toBeNull();
      expect(after.bySession.A).toBeDefined();
    });
  });

  describe("dropSession", () => {
    it("forgets everything about the session, run errors included", () => {
      let s = mirrorRun(emptyChatErrors, "A", "boom");
      s = setSession(s, "B", "b");
      const after = dropSession(s, "A");
      expect(after.bySession.A).toBeUndefined();
      expect(after.bySession.B).toBeDefined();
    });

    it("keeps the global error and ignores an unknown session", () => {
      const s = setGlobal(emptyChatErrors, "g");
      expect(dropSession(s, "nope")).toBe(s);
      expect(visibleError(dropSession(s, "A"), "A")).toBe("g");
    });
  });
});
