import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// The log writes under the home folder, so it's pointed at a temp one first:
// these tests must never touch the real ~/.llama-mui.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
});

const { Supervisor } = await import("../manager/supervisor.ts");

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  constructor(
    public pid: number,
    private stubborn = false,
  ) {
    super();
  }
  kill(signal: NodeJS.Signals | number = "SIGTERM") {
    this.signals.push(String(signal));
    if (signal === "SIGKILL" || !this.stubborn) setTimeout(() => this.emit("exit", null, signal), 0);
    return true;
  }
}

function setup({ stubborn = false, build }: { stubborn?: boolean; build?: () => Promise<unknown> } = {}) {
  const events: string[] = [];
  const children: FakeChild[] = [];
  const sup = new Supervisor({
    program: "node",
    args: ["server/main.ts"],
    killAfterMs: 20,
    spawn: () => {
      events.push("start");
      const c = new FakeChild(100 + children.length, stubborn);
      children.push(c);
      return c;
    },
    build: async () => {
      events.push("build");
      await build?.();
    },
  });
  const origStop = sup.stop.bind(sup);
  sup.stop = async () => {
    events.push("stop");
    await origStop();
  };
  return { sup, events, children };
}

describe("Supervisor", () => {
  it("starts the app and reports it", () => {
    const { sup, children } = setup();
    expect(sup.status().state).toBe("stopped");
    sup.start();
    const s = sup.status();
    expect(s.state).toBe("running");
    expect(s.pid).toBe(children[0].pid);
    expect(s.startedAt).toBeTypeOf("number");
    sup.start();
    expect(children).toHaveLength(1);
  });

  it("stops with SIGTERM and waits for the exit", async () => {
    const { sup, children } = setup();
    sup.start();
    await sup.stop();
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(sup.status()).toMatchObject({ state: "stopped", pid: null });
  });

  it("kills a stubborn child after the wait", async () => {
    const { sup, children } = setup({ stubborn: true });
    sup.start();
    await sup.stop();
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sup.status().state).toBe("stopped");
  });

  it("restarts in order: build, stop, start", async () => {
    const { sup, events, children } = setup();
    sup.start();
    events.length = 0;
    const r = await sup.restart({ build: true });
    expect(r).toEqual({ ok: true });
    expect(events).toEqual(["build", "stop", "start"]);
    expect(children).toHaveLength(2);
    const s = sup.status();
    expect(s.state).toBe("running");
    expect(s.pid).toBe(children[1].pid);
    expect(s.lastBuild?.ok).toBe(true);
    expect(s.lastRestart).toBeTypeOf("number");
  });

  it("keeps the old child when the build fails", async () => {
    const { sup, events, children } = setup({ build: () => Promise.reject(new Error("vite exploded\nmore")) });
    sup.start();
    events.length = 0;
    const r = await sup.restart({ build: true });
    expect(r).toEqual({ ok: false, reason: "build failed", error: "vite exploded" });
    expect(events).toEqual(["build"]);
    expect(children[0].signals).toEqual([]);
    const s = sup.status();
    expect(s).toMatchObject({ state: "running", pid: children[0].pid });
    expect(s.lastBuild?.ok).toBe(false);
  });

  it("refuses a second restart while one runs", async () => {
    let release = () => {};
    const { sup, children } = setup({ build: () => new Promise<void>((r) => (release = r)) });
    sup.start();
    const first = sup.restart({ build: true });
    const second = await sup.restart({ build: true });
    expect(second).toEqual({ ok: false, reason: "already restarting" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(children).toHaveLength(2);
  });

  it("records a crash and does not restart it", async () => {
    const { sup, events, children } = setup();
    sup.start();
    children[0].emit("exit", 1, null);
    expect(sup.status()).toMatchObject({ state: "crashed", pid: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["start"]);
    expect(children).toHaveLength(1);
  });
});
