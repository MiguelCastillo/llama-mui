// A plan run with no model, for the runner's tests: it walks the plan the way
// runPlan does (gate, step running, step done) and waits for the test to finish
// each step.

import type { RunPlanCallbacks } from "../../src/agent/agent.ts";
import type { PlanStep, Session } from "../../src/api.ts";
import type { Answer, Ask, RunnerHandle } from "../../src/runnerTypes.ts";

export type Patch = Omit<PlanStep, "id" | "text">;
interface Deferred {
  promise: Promise<Patch | void>;
  resolve: (patch?: Patch) => void;
}

const jobs = new Map<string, Deferred>();
const asking = new Map<string, Ask>();
const answers = new Map<string, Answer>();
export const handles = new Map<string, RunnerHandle>();
export const started: string[] = [];

export function resetFakes() {
  jobs.clear();
  asking.clear();
  answers.clear();
  handles.clear();
  started.length = 0;
}

function job(key: string): Deferred {
  let d = jobs.get(key);
  if (!d) {
    let resolve!: Deferred["resolve"];
    const promise = new Promise<Patch | void>((r) => (resolve = r as Deferred["resolve"]));
    jobs.set(key, (d = { promise, resolve }));
  }
  return d;
}

// Lets step `step` of session `id` finish, with the given result (done by default).
export const finish = (id: string, step: string, patch?: Patch) => job(`${id}/${step}`).resolve(patch);
// Makes the step ask before it works.
export const askOn = (id: string, step: string, ask: Ask) => void asking.set(`${id}/${step}`, ask);
export const askedAnswer = (id: string, step: string) => answers.get(`${id}/${step}`);

export async function fakeRun(id: string, cb: RunPlanCallbacks) {
  cb.planRunningRef.current = true;
  try {
    for (;;) {
      const next = cb.planRef.current?.find((s) => s.status === "pending");
      if (!next) break;
      if (cb.gate && !(await cb.gate())) break;
      const key = `${id}/${next.id}`;
      started.push(next.id);
      cb.setStep(next.id, { status: "running" });
      const c = new AbortController();
      cb.setAbort(c);
      let patch: Patch | void = undefined;
      try {
        const ask = asking.get(key);
        if (ask) answers.set(key, await handles.get(id)!.askUser(ask, c.signal));
        if (!c.signal.aborted) {
          patch = await Promise.race([
            job(key).promise,
            new Promise<void>((r) => c.signal.addEventListener("abort", () => r())),
          ]);
        }
      } finally {
        cb.setAbort(null);
      }
      if (c.signal.aborted) break;
      cb.setStep(next.id, patch ?? { status: "done" });
      if (patch && patch.status !== "done") break;
    }
  } finally {
    cb.planRunningRef.current = false;
  }
}

export function makeSession(id: string, steps = 3): Session {
  return {
    id,
    title: id,
    model: "m",
    messages: [],
    contextStart: 0,
    attachments: [],
    usage: null,
    failed: null,
    plan: Array.from({ length: steps }, (_, i) => ({ id: `s${i + 1}`, text: `Step ${i + 1}`, status: "pending" as const })),
  };
}
