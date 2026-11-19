import { describe, expect, it } from "vitest";
import type { PlanStep } from "../../src/api.ts";
import { allowedActions, holderKind, planState, sessionActions, type Holder, type PlanState } from "../allowedActions.ts";

const step = (status: PlanStep["status"], note?: string): PlanStep => ({ id: status + (note ?? ""), text: "t", status, ...(note ? { note } : {}) }) as PlanStep;
const list = (s: ReadonlySet<string>) => [...s].sort();

const base = { loaded: true, canClone: true, hasModel: true };

describe("planState", () => {
  it("reads a plan's steps", () => {
    expect(planState([step("pending"), step("pending")], false)).toEqual({ finished: false, unfinished: true, started: false, running: false });
    expect(planState([step("done"), step("pending")], false)).toMatchObject({ unfinished: true, started: true });
    expect(planState([step("pending", "stopped")], false)).toMatchObject({ started: true });
    expect(planState([step("done"), step("done")], false)).toMatchObject({ finished: true, unfinished: false });
    expect(planState([step("done"), step("failed")], true)).toMatchObject({ unfinished: true, running: true });
  });
});

describe("allowedActions", () => {
  const plan = (p: Partial<PlanState>): PlanState => ({ finished: false, unfinished: true, started: false, running: false, ...p });

  it("offers nothing until the chat is loaded and the holder is known", () => {
    expect(list(allowedActions({ ...base, loaded: false, holder: "none", plan: plan({}) }))).toEqual([]);
    expect(list(allowedActions({ ...base, holder: "unknown", plan: plan({}) }))).toEqual([]);
    expect(list(allowedActions({ ...base, loaded: false, holder: "unknown", plan: null }))).toEqual([]);
  });

  it("offers only Take over while another server holds the run, whatever the plan", () => {
    for (const p of [null, plan({}), plan({ running: true }), plan({ started: true }), plan({ finished: true, unfinished: false })]) {
      expect(list(allowedActions({ ...base, holder: "elsewhere", plan: p }))).toEqual(["takeOver"]);
    }
  });

  it("never offers Approve while another server holds the run or the owner is unknown", () => {
    for (const holder of ["elsewhere", "unknown"] as Holder[]) {
      for (const p of [null, plan({}), plan({ running: true })]) {
        expect(list(allowedActions({ ...base, holder, plan: p }))).not.toContain("approve");
      }
    }
  });

  for (const holder of ["none", "here"] as Holder[]) {
    describe(`when ${holder === "none" ? "no one runs it" : "this server runs it"}`, () => {
      const go = (plan: PlanState | null, extra: object = {}) => list(allowedActions({ ...base, holder, plan, ...extra }));

      it("a chat with no plan: send and resend", () => {
        expect(go(null)).toEqual(["approve", "resend", "send"]);
        expect(go(null, { hasModel: false })).toEqual(["approve", "resend"]);
      });
      it("a plan that hasn't started: Run, Edit, Discard", () => {
        expect(go(plan({}))).toEqual(["approve", "discard", "edit", "resend", "run", "send"]);
      });
      it("a plan that has started: Continue instead of Run", () => {
        expect(go(plan({ started: true }))).toEqual(["approve", "continue", "discard", "edit", "resend", "send"]);
      });
      it("a running plan: Pause, and sending even with no model; no Discard, Run or Continue", () => {
        expect(go(plan({ running: true, started: true }), { hasModel: false })).toEqual(["approve", "edit", "pause", "resend", "send"]);
      });
      it("a finished plan: Clone only if it can be cloned; nothing to run, edit or discard", () => {
        const done = plan({ finished: true, unfinished: false, started: true });
        expect(go(done)).toEqual(["approve", "clone", "resend", "send"]);
        expect(go(done, { canClone: false })).toEqual(["approve", "resend", "send"]);
      });
      it("never offers Take over", () => {
        expect(go(plan({}))).not.toContain("takeOver");
        expect(go(null)).not.toContain("takeOver");
      });
    });
  }
});

describe("sessionActions: the holder is decided from the run record", () => {
  const now = 1_000_000;
  const me = "me";
  const owner = (over: object = {}) => ({ pid: 1, port: 5173, checkedAt: now - 1000, serverId: "me", ...over });
  const record = (over: object = {}) => ({ startedAt: now - 5000, owner: owner(), ...over });
  const session = (...statuses: PlanStep["status"][]) => ({ plan: statuses.map((s) => step(s)) });
  const actions = (s: any, run: any) => sessionActions(s, run, now, me);

  it("tells who holds the run", () => {
    expect(holderKind(null, now, me)).toBe("none");
    expect(holderKind(record(), now, me)).toBe("here");
    expect(holderKind(record({ owner: owner({ serverId: "other" }) }), now, me)).toBe("elsewhere");
    expect(holderKind(record({ owner: owner({ serverId: undefined }) }), now, me)).toBe("elsewhere");
    expect(holderKind(record({ owner: owner({ checkedAt: now - 60_000, serverId: "other" }) }), now, me)).toBe("none");
  });

  it("no run: the idle set for an unstarted plan", () => {
    expect(actions(session("pending"), null)).toEqual(["approve", "discard", "edit", "resend", "run", "send"]);
  });

  it("this server's run: Pause, no Run or Discard", () => {
    expect(actions(session("done", "running"), record())).toEqual(["approve", "edit", "pause", "resend", "send"]);
  });

  it("another server owns the run, with a step marked running: only Take over", () => {
    const other = record({ owner: owner({ serverId: "other" }) });
    expect(actions(session("done", "running"), other)).toEqual(["takeOver"]);
    expect(actions({}, other)).toEqual(["takeOver"]);
  });

  it("the other server's owner has gone stale: back to the idle set", () => {
    const stale = record({ owner: owner({ serverId: "other", checkedAt: now - 60_000 }) });
    expect(actions(session("done", "running"), stale)).toEqual(["approve", "discard", "edit", "resend", "send"]);
    expect(actions(session("done", "pending"), stale)).toEqual(["approve", "continue", "discard", "edit", "resend", "send"]);
  });

  it("an unreadable record gives nothing", () => {
    expect(actions(session("pending"), { startedAt: 1 })).toEqual([]); // no owner
    expect(actions(session("pending"), { startedAt: 1, owner: { pid: "x" } })).toEqual([]);
    expect(actions(session("pending"), "garbage")).toEqual([]);
    expect(actions(null, null)).toEqual([]);
  });

  // A thread that is "done, not committed" has every step done, so the server
  // lists the same actions as for a plain finished one (the thread's status
  // never feeds the list); nothing is added, and another or unknown owner removes them.
  it("a finished thread with uncommitted files gets the finished plan's actions, and nothing when the owner is elsewhere or unknown", () => {
    const finished = session("done", "done");
    expect(actions(finished, null)).toEqual(["approve", "clone", "resend", "send"]);
    expect(actions(finished, record({ owner: owner({ serverId: "other" }) }))).toEqual(["takeOver"]);
    expect(actions(finished, { startedAt: 1 })).toEqual([]);
    expect(actions(finished, "garbage")).toEqual([]);
  });

  it("a finished plan can be cloned only when no run is active", () => {
    expect(actions(session("done", "done"), null)).toEqual(["approve", "clone", "resend", "send"]);
    expect(actions(session("done", "done"), record({ kind: "turn" }))).toEqual(["approve", "resend", "send"]);
  });
});
