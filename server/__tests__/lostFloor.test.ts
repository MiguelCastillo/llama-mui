import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunPlanCallbacks } from "../../src/agent/agent.ts";
import type { Ask, RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";

// A run whose record was taken over by another server stops at its next
// check-in and writes nothing more. Two copies of the server modules stand in
// for two servers sharing one home folder (as in twoServers.test.ts).
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
  const runRecord = await import("../runRecord.ts");
  return { hub, runners, sessionFile, runRecord };
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

// A plan whose only step asks for approval, so the run waits there.
function waiting() {
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
        await handle.askUser(approval, new AbortController().signal);
        handle.edit((s) => ({ ...s, messages: [...s.messages, { role: "assistant", content: "A wrote this" } as any] }));
        cb.setStep(step.id, { status: "done" });
      } finally {
        cb.planRunningRef.current = false;
      }
    },
  };
}

const base = (id: string, revision: number) => ({
  id, title: id, model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null,
  plan: [{ id: "s1", text: "Step 1", status: "pending" }], revision,
});

afterAll(async () => {
  await A.runners.resetRunners();
  await B.runners.resetRunners();
});

describe("a run that lost the floor", () => {
  it("stops within one check-in when another server holds the record, and does not overwrite it", async () => {
    const ID = "replaced";
    await A.sessionFile.writeSession(ID, base(ID, 1));
    await A.runners.startRunner(ID, env, waiting());
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());
    expect(A.runRecord.serverId).not.toBe(B.runRecord.serverId);

    // Another server takes over: the session now says what it says, with its own record.
    const mine = (await A.sessionFile.readSession(ID)) as any;
    const taken = {
      ...mine,
      messages: [{ role: "assistant", content: "B's work" }],
      revision: mine.revision + 1,
      run: { status: "running", startedAt: Date.now(), owner: B.runRecord.ownerNow(5174) },
    };
    await A.sessionFile.writeSession(ID, taken);

    await A.hub.checkIn(ID);
    expect(A.hub.liveRun(ID)).toBeNull();
    expect(A.runners.isRunning(ID)).toBe(false);
    // The old run's later saves are refused, and the file is B's still.
    await expect(A.hub.save(ID, { ...mine, messages: [] })).rejects.toMatchObject({ status: 409, extra: { reason: "lost the floor" } });
    await new Promise((r) => setTimeout(r, 300));
    const after = (await A.sessionFile.readSession(ID)) as any;
    expect(after.messages).toEqual([{ role: "assistant", content: "B's work" }]);
    expect(after.run.owner.serverId).toBe(B.runRecord.serverId);
    expect(after.revision).toBe(taken.revision);
  }, 20_000);

  it("stops by itself on the 5-second check-in when the record is gone", async () => {
    const ID = "removed";
    await A.sessionFile.writeSession(ID, base(ID, 1));
    await A.runners.startRunner(ID, env, waiting());
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());

    const mine = (await A.sessionFile.readSession(ID)) as any;
    const { run: _gone, ...settled } = mine;
    await A.sessionFile.writeSession(ID, { ...settled, revision: mine.revision + 1, failed: "settled elsewhere" });

    await vi.waitFor(() => expect(A.hub.liveRun(ID)).toBeNull(), { timeout: 8_000, interval: 200 });
    expect(A.runners.isRunning(ID)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    const after = (await A.sessionFile.readSession(ID)) as any;
    expect(after.failed).toBe("settled elsewhere");
    expect(after.run).toBeUndefined();
    expect(after.revision).toBe(mine.revision + 1);
  }, 20_000);

  it("keeps a run that is still the holder", async () => {
    const ID = "holder";
    await A.sessionFile.writeSession(ID, base(ID, 1));
    const a = await A.runners.startRunner(ID, env, waiting());
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());
    await A.hub.checkIn(ID);
    expect(A.hub.liveRun(ID)).not.toBeNull();
    await A.runners.answerAsk(ID, A.hub.liveRun(ID)!.ask!.id, true);
    await a.done;
    expect(((await A.sessionFile.readSession(ID)) as any).messages.map((m: any) => m.content)).toEqual(["A wrote this"]);
  }, 20_000);
});
