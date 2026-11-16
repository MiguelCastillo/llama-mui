import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunPlanCallbacks } from "../../src/agent/agent.ts";
import type { Ask, RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";

// Taking over another server's live run: settled as interrupted at once, the
// record removed, and the old holder stops at its next check-in. Two copies of
// the server modules stand in for two servers (as in lostFloor.test.ts).
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
  const restart = await import("../restart.ts");
  return { hub, runners, sessionFile, restart };
}
const A = await loadServer();
const B = await loadServer();
A.hub.setOwnerPort(5175);
B.hub.setOwnerPort(5172);

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: false } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

const approval = { needsApproval: { name: "write_file", type: "change" } } as unknown as Ask;

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
        cb.setStep(step.id, { status: "done" });
      } finally {
        cb.planRunningRef.current = false;
      }
    },
  };
}

const base = (id: string) => ({
  id, title: id, model: "m", messages: [], contextStart: 0, attachments: [], usage: null, failed: null,
  plan: [{ id: "s1", text: "Step 1", status: "pending" }], revision: 1,
});

afterAll(async () => {
  await A.runners.resetRunners();
  await B.runners.resetRunners();
});

describe("takeover", () => {
  it("settles another server's run as interrupted, removes the record, and the old holder stops", async () => {
    const ID = "taken";
    await A.sessionFile.writeSession(ID, base(ID));
    await A.runners.startRunner(ID, env, waiting());
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());

    const heard: any[] = [];
    const off = B.hub.subscribe((e: any) => void heard.push(e));
    const out = await B.restart.takeOverSession(ID);
    off();
    expect(heard).toContainEqual({ type: "status", id: ID, data: { run: null } });
    expect(out.port).toBe(5175);
    expect(out.reason).toContain("5175");

    const after = (await B.sessionFile.readSession(ID)) as any;
    expect(after.run).toBeUndefined();
    expect(after.plan[0].status).toBe("pending");
    expect(after.plan[0].note).toContain("port 5175");
    expect(after.failed).toBeTruthy();

    await A.hub.checkIn(ID);
    expect(A.hub.liveRun(ID)).toBeNull();
    expect(A.runners.isRunning(ID)).toBe(false);
    const last = (await B.sessionFile.readSession(ID)) as any;
    expect(last.revision).toBe(after.revision);
    expect(last.run).toBeUndefined();
  }, 20_000);

  it("is refused for this server's own run", async () => {
    const ID = "own";
    await A.sessionFile.writeSession(ID, base(ID));
    await A.runners.startRunner(ID, env, waiting());
    await vi.waitFor(() => expect(A.hub.liveRun(ID)?.ask).toBeTruthy());
    await expect(A.restart.takeOverSession(ID)).rejects.toMatchObject({ status: 409 });
    expect(A.hub.liveRun(ID)).not.toBeNull();
    expect(((await A.sessionFile.readSession(ID)) as any).run).toBeTruthy();
    await A.runners.stopRun(ID, { force: true });
  }, 20_000);

  it("is refused when no run is live", async () => {
    const ID = "idle";
    await A.sessionFile.writeSession(ID, base(ID));
    await expect(A.restart.takeOverSession(ID)).rejects.toMatchObject({ status: 409, extra: { reason: "not running elsewhere" } });
    expect(((await A.sessionFile.readSession(ID)) as any).revision).toBe(1);
  });
});
