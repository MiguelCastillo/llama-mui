import { describe, expect, it } from "vitest";
import { optimisticSend } from "../optimisticSend";

type M = { role: string; content: string };
const old: M = { role: "assistant", content: "earlier" };
const msg: M = { role: "user", content: "hi" };

function setup(opts: { canShow?: () => boolean; canRestore?: () => boolean } = {}) {
  const shown: M[][] = [];
  let settle!: (went: boolean) => void;
  let fail!: (e: Error) => void;
  // Stands in for saveSession + uploads + sendChat: settled by hand.
  const work = () =>
    new Promise<boolean>((res, rej) => {
      settle = res;
      fail = rej;
    });
  const run = () =>
    optimisticSend<M>({
      before: [old],
      message: msg,
      prior: [old],
      setMessages: (m) => shown.push(m),
      canShow: opts.canShow ?? (() => true),
      canRestore: opts.canRestore ?? (() => true),
      work,
    });
  return { shown, run, settle: (w: boolean) => settle(w), fail: (e: Error) => fail(e) };
}

describe("optimisticSend", () => {
  it("shows the message before the slow part resolves, and keeps it once it went", async () => {
    const t = setup();
    const p = t.run();
    // Nothing has resolved yet, and the message is already in the history.
    expect(t.shown).toEqual([[old, msg]]);
    t.settle(true);
    expect(await p).toBe(true);
    expect(t.shown).toEqual([[old, msg]]);
  });

  it("puts the earlier messages back when it didn't go", async () => {
    const t = setup();
    const p = t.run();
    expect(t.shown).toEqual([[old, msg]]);
    t.settle(false);
    expect(await p).toBe(false);
    expect(t.shown).toEqual([[old, msg], [old]]);
  });

  it("puts them back, and rethrows, if the slow part throws", async () => {
    const t = setup();
    const p = t.run();
    t.fail(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(t.shown).toEqual([[old, msg], [old]]);
  });

  it("doesn't put them back once the server's session has replaced what was shown", async () => {
    const t = setup({ canRestore: () => false });
    const p = t.run();
    t.settle(false);
    await p;
    expect(t.shown).toEqual([[old, msg]]);
  });

  it("shows nothing when another chat is open", async () => {
    const t = setup({ canShow: () => false, canRestore: () => false });
    const p = t.run();
    t.settle(true);
    await p;
    expect(t.shown).toEqual([]);
  });
});
