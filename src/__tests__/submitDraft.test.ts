import { describe, expect, it } from "vitest";
import { submitDraft } from "../submitDraft";

// A box that records what happened to it, and a send the test settles by hand
// (standing in for saveSession + uploads + sendChat).
function setup(opts: { shown?: () => boolean } = {}) {
  const log: string[] = [];
  let settle!: (went: boolean) => void;
  const server = new Promise<boolean>((r) => (settle = r));
  const run = (acceptNow: boolean) =>
    submitDraft({
      text: "hi",
      images: [1],
      stillShown: opts.shown ?? (() => true),
      send: async (accepted) => {
        if (!acceptNow) return false; // refused before it started
        accepted();
        log.push("accepted");
        return server;
      },
      clear: () => log.push("clear"),
      restore: () => log.push("restore"),
      done: (shown) => log.push(`done:${shown}`),
    });
  return { log, settle, run };
}

describe("submitDraft", () => {
  it("empties the box when the send is accepted, before the server answers", async () => {
    const { log, settle, run } = setup();
    const p = run(true);
    await Promise.resolve();
    expect(log).toEqual(["clear", "accepted"]);
    settle(true);
    expect(await p).toBe(true);
    expect(log).toEqual(["clear", "accepted", "done:true"]);
  });

  it("puts the text back when the send fails after the box was emptied", async () => {
    const { log, settle, run } = setup();
    const p = run(true);
    await Promise.resolve();
    settle(false);
    expect(await p).toBe(false);
    expect(log).toEqual(["clear", "accepted", "restore"]);
  });

  it("leaves the box alone when the send is refused before it starts", async () => {
    const { log, run } = setup();
    expect(await run(false)).toBe(false);
    expect(log).toEqual([]);
  });

  it("doesn't touch the box when another chat is open", async () => {
    let shown = false;
    const { log, settle, run } = setup({ shown: () => shown });
    const p = run(true);
    await Promise.resolve();
    settle(false);
    expect(await p).toBe(false);
    expect(log).toEqual(["accepted"]);
    // And a send that went reports it, without emptying a box that isn't there.
    const again = setup({ shown: () => shown });
    const q = again.run(true);
    await Promise.resolve();
    again.settle(true);
    await q;
    expect(again.log).toEqual(["accepted", "done:false"]);
  });
});
