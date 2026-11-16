import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunPlanCallbacks } from "../../src/agent/agent.ts";
import type { Ask, RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";

// Reproduction: the dev server and the prod server share ~/.llama-mui, and
// each keeps its runs in its own memory. Two copies of the server modules
// (loaded twice with vi.resetModules) stand in for the two processes; they
// share one temp home folder and the real lock files, as the two servers do.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

async function loadServer() {
  vi.resetModules();
  const hub = await import("../runHub.ts");
  const runners = await import("../runners.ts");
  const sessionFile = await import("../sessionFile.ts");
  return { hub, runners, sessionFile };
}
const A = await loadServer(); // prod, :5172
const B = await loadServer(); // dev, :5174

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: false } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

const approval = { needsApproval: { name: "write_file", type: "change" } } as unknown as Ask;
const ID = "plan-session";

// A plan run with no model, picking steps the way runPlan does (the first step
// that isn't done). Step 4 asks for approval; a denial fails it.
function runOn(name: string) {
  let handle: RunnerHandle;
  return {
    reply: (h: RunnerHandle) => {
      handle = h;
      return async (_t: string, before: any) => ({ ok: true, messages: before });
    },
    run: async (cb: RunPlanCallbacks) => {
      cb.planRunningRef.current = true;
      try {
        for (;;) {
          const i = cb.planRef.current!.findIndex((s) => s.status !== "done");
          if (i < 0) break;
          const step = cb.planRef.current![i];
          cb.setStep(step.id, { status: "running" });
          let ok = true;
          if (step.id === "s4") ok = (await handle.askUser(approval, new AbortController().signal)) === true;
          handle.edit((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: `${name} did step ${i + 1}` } as any] }));
          cb.setStep(step.id, ok ? { status: "done" } : { status: "failed", note: `Denied on ${name}` });
          if (!ok) break;
        }
      } finally {
        cb.planRunningRef.current = false;
      }
    },
  };
}

const statuses = async () => ((await A.sessionFile.readSession(ID)) as any).plan.map((s: any) => s.status);
const messages = async () => ((await A.sessionFile.readSession(ID)) as any).messages.map((m: any) => m.content);

afterAll(async () => {
  await A.runners.resetRunners();
  await B.runners.resetRunners();
});

const plan = () => [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, text: `Step ${n}`, status: n <= 3 ? "done" : "pending" }));

describe("two servers on one ~/.llama-mui", () => {
  it("refuses a second run of a plan that the other server is running, so nothing is overwritten", async () => {
    await A.sessionFile.writeSession(ID, {
      id: ID, title: ID, model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null,
      plan: plan(), revision: 1,
    });

    // Server A runs the plan; step 4 asks for approval and A waits.
    const a = await A.runners.startRunner(ID, env, runOn("A"));
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());
    const askA = A.hub.liveRun(ID)!.ask!.id;

    // Continue on server B is refused with a plain message, and B has no run.
    await expect(B.runners.startRunner(ID, env, runOn("B"))).rejects.toMatchObject({
      status: 409,
      extra: { reason: "running elsewhere" },
      message: expect.stringContaining("already running on another server"),
    });
    expect(B.hub.liveRun(ID)).toBeNull();
    // A turn (Resend) is refused the same way.
    await expect(B.runners.startTurn(ID, env, { text: "hi", planning: false }, runOn("B"))).rejects.toMatchObject({ status: 409, extra: { reason: "running elsewhere" } });
    // The record is A's still, and A's run was not marked interrupted.
    expect(((await A.sessionFile.readSession(ID)) as any).run).toMatchObject({ status: "waiting" });

    await A.runners.answerAsk(ID, askA, true);
    await a.done;
    expect(await statuses()).toEqual(["done", "done", "done", "done", "done"]);
    expect(await messages()).toEqual(["A did step 4", "A did step 5"]);
  }, 20_000);

  it("settles a record whose owner is dead, then starts the new run", async () => {
    await A.sessionFile.writeSession(ID, {
      id: ID, title: ID, model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null,
      plan: plan(), revision: 10,
      run: { status: "running", startedAt: Date.now() - 60_000, owner: { pid: 99999, port: 5173, checkedAt: Date.now() - 60_000 } },
    });
    const b = await B.runners.startRunner(ID, env, runOn("B"));
    await vi.waitFor(() => expect(B.hub.liveRun(ID)?.ask).toBeTruthy());
    // The old run was settled, and the new one is B's own.
    expect(((await A.sessionFile.readSession(ID)) as any).run.owner.checkedAt).toBeGreaterThan(Date.now() - 5_000);
    await B.runners.answerAsk(ID, B.hub.liveRun(ID)!.ask!.id, true);
    await b.done;
    expect(await statuses()).toEqual(["done", "done", "done", "done", "done"]);
    expect(((await A.sessionFile.readSession(ID)) as any).run).toBeUndefined();
  }, 20_000);
});
