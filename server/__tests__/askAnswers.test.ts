import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunPlanCallbacks } from "../../src/agent/agent.ts";
import type { Ask, RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";

// Approval answers live in the run record: a page on either server writes the
// answer there, the first one wins, and the owning server picks it up. Two
// copies of the server modules stand in for the two servers.
const home = vi.hoisted(() => ({ dir: "" }));
const audited = vi.hoisted(() => ({ calls: [] as [string, any][] }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../audit.ts", () => ({
  audit: (event: string, fields: any) => void audited.calls.push([event, fields]),
  noteSession: () => {},
  auditSessionDeleted: () => {},
}));

async function loadServer() {
  vi.resetModules();
  const hub = await import("../runHub.ts");
  const runners = await import("../runners.ts");
  const sessionFile = await import("../sessionFile.ts");
  return { hub, runners, sessionFile };
}
const A = await loadServer();
const B = await loadServer();

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: false } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;
const approval = { needsApproval: { name: "write_file", type: "change" } } as unknown as Ask;
const ID = "ask-session";

// One step that asks for approval and records what the answer was.
function asking(result: { answer?: unknown }) {
  let handle: RunnerHandle;
  return {
    reply: (h: RunnerHandle) => {
      handle = h;
      return async (_t: string, before: any) => ({ ok: true, messages: before });
    },
    run: async (cb: RunPlanCallbacks) => {
      cb.planRunningRef.current = true;
      try {
        const step = cb.planRef.current![0];
        cb.setStep(step.id, { status: "running" });
        result.answer = await handle.askUser(approval, new AbortController().signal);
        cb.setStep(step.id, { status: "done" });
      } finally {
        cb.planRunningRef.current = false;
      }
    },
  };
}

afterAll(async () => {
  await A.runners.resetRunners();
  await B.runners.resetRunners();
});

const start = async () => {
  await A.sessionFile.writeSession(ID, {
    id: ID, title: ID, model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null,
    plan: [{ id: "s1", text: "Step 1", status: "pending" }], revision: 1,
  });
  const result: { answer?: unknown } = {};
  const run = await A.runners.startRunner(ID, env, asking(result));
  await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());
  return { result, run, askId: A.hub.liveRun(ID)!.ask!.id };
};

describe("answering a question through the run record", () => {
  it("takes an answer from the other server's page, and the owner picks it up", async () => {
    audited.calls.length = 0;
    const { result, run, askId } = await start();
    await B.runners.answerAsk(ID, askId, true);
    // The answer is in the record; the owner (A) resolves its question from it.
    await run.done;
    expect(result.answer).toBe(true);
    expect(audited.calls.filter(([e]) => e === "ask.late")).toEqual([]);
  }, 20_000);

  it("the first answer wins; a late one from either server is refused and audited", async () => {
    audited.calls.length = 0;
    const { result, run, askId } = await start();
    await B.runners.answerAsk(ID, askId, false);
    // Written to the record already, before the owner has picked it up.
    await expect(A.runners.answerAsk(ID, askId, true)).rejects.toMatchObject({ status: 409, extra: { reason: "stale ask" } });
    await expect(B.runners.answerAsk(ID, askId, true)).rejects.toMatchObject({ status: 409, extra: { reason: "stale ask" } });
    await run.done;
    expect(result.answer).toBe(false); // the first answer, not the later "yes"
    const late = audited.calls.filter(([e]) => e === "ask.late");
    expect(late).toHaveLength(2);
    expect(late[0][1]).toMatchObject({ session: ID, askId, reason: "already answered" });
  }, 20_000);

  it("an answer for another question is refused as stale and writes nothing", async () => {
    const { run, askId } = await start();
    await expect(B.runners.answerAsk(ID, "not-it", true)).rejects.toMatchObject({ extra: { reason: "stale ask" } });
    expect(((await A.sessionFile.readSession(ID)) as any).run.ask.answer).toBeUndefined();
    await A.runners.answerAsk(ID, askId, true);
    await run.done;
  }, 20_000);
});
