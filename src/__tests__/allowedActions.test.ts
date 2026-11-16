import { describe, expect, it } from "vitest";
import { allowedActions, planState, type Holder, type PlanState } from "../allowedActions";
import type { PlanStep } from "../api";

const step = (status: PlanStep["status"], note?: string): PlanStep => ({ id: status + (note ?? ""), text: "t", status, ...(note ? { note } : {}) }) as PlanStep;
const list = (s: ReturnType<typeof allowedActions>) => [...s].sort();

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

  for (const holder of ["none", "here"] as Holder[]) {
    describe(`when ${holder === "none" ? "no one runs it" : "this server runs it"}`, () => {
      const go = (plan: PlanState | null, extra: object = {}) => list(allowedActions({ ...base, holder, plan, ...extra }));

      it("a chat with no plan: send and resend", () => {
        expect(go(null)).toEqual(["resend", "send"]);
        expect(go(null, { hasModel: false })).toEqual(["resend"]);
      });
      it("a plan that hasn't started: Run, Edit, Discard", () => {
        expect(go(plan({}))).toEqual(["discard", "edit", "resend", "run", "send"]);
      });
      it("a plan that has started: Continue instead of Run", () => {
        expect(go(plan({ started: true }))).toEqual(["continue", "discard", "edit", "resend", "send"]);
      });
      it("a running plan: Pause, and sending even with no model; no Discard, Run or Continue", () => {
        expect(go(plan({ running: true, started: true }), { hasModel: false })).toEqual(["edit", "pause", "resend", "send"]);
      });
      it("a finished plan: Clone only if it can be cloned; nothing to run, edit or discard", () => {
        const done = plan({ finished: true, unfinished: false, started: true });
        expect(go(done)).toEqual(["clone", "resend", "send"]);
        expect(go(done, { canClone: false })).toEqual(["resend", "send"]);
      });
      it("never offers Take over", () => {
        expect(go(plan({}))).not.toContain("takeOver");
        expect(go(null)).not.toContain("takeOver");
      });
    });
  }
});
