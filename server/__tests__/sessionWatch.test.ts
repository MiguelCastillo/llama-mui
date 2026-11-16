import { afterAll, describe, expect, it, vi } from "vitest";

// Two copies of the server modules stand in for two processes sharing one
// sessions folder. A change the first one writes must reach a page's event
// stream on the second.
const h = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  h.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => h.dir, default: { ...actual, homedir: () => h.dir } };
});

async function loadServer() {
  vi.resetModules();
  const hub = await import("../runHub.ts");
  const watcher = await import("../sessionWatch.ts");
  return { hub, watcher };
}
const A = await loadServer();
const B = await loadServer();

const session = (id: string, title: string) => ({ id, title, updatedAt: 1, messages: [] as any[] });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe("changes written by another process", () => {
  const stops: (() => void)[] = [];
  afterAll(() => stops.forEach((s) => s()));

  it.each([
    ["file notices", 60_000],
    ["the poll alone", 100],
  ])("reach a page's event stream (%s)", async (_name, pollMs) => {
    const id = pollMs === 100 ? "poll-one" : "watch-one";
    await A.hub.replace(id, () => session(id, "first"));
    const stop = B.watcher.startSessionWatch({ pollMs, debounceMs: 10 });
    stops.push(stop);
    await new Promise((r) => setTimeout(r, 300)); // the first look is done

    const events: any[] = [];
    const page = await B.hub.watch(id, (e) => events.push(e));
    expect(page).not.toBeNull();

    await A.hub.replace(id, (old) => ({ ...old, title: "renamed elsewhere" }));
    await until(() => events.some((e) => e.type === "saved"));
    page!.stop();
    stop();

    const saved = events.find((e) => e.type === "saved");
    expect(saved.data.summary.title).toBe("renamed elsewhere");
  });

  it("publishes a run another process starts, and when it ends", async () => {
    const id = "watch-run";
    await A.hub.replace(id, () => session(id, "run"));
    const stop = B.watcher.startSessionWatch({ pollMs: 100, debounceMs: 10 });
    stops.push(stop);
    await new Promise((r) => setTimeout(r, 300));
    const events: any[] = [];
    const page = await B.hub.watch(id, (e) => events.push(e));

    await A.hub.beginRun(id, { session: () => session(id, "run") });
    await until(() => events.some((e) => e.type === "status" && e.data.run));
    expect(events.find((e) => e.type === "status").data.run.status).toBe("running");

    await A.hub.endRun(id);
    await until(() => events.some((e) => e.type === "status" && e.data.run === null));
    page!.stop();
    stop();
    expect(events.some((e) => e.type === "status" && e.data.run === null)).toBe(true);
  });

  it("does not publish a process's own writes a second time", async () => {
    const id = "watch-own";
    await B.hub.replace(id, () => session(id, "mine"));
    const stop = B.watcher.startSessionWatch({ pollMs: 100, debounceMs: 10 });
    stops.push(stop);
    await new Promise((r) => setTimeout(r, 300));
    const events: any[] = [];
    const page = await B.hub.watch(id, (e) => events.push(e));
    await B.hub.replace(id, (old) => ({ ...old, title: "own change" }));
    await new Promise((r) => setTimeout(r, 500));
    page!.stop();
    stop();
    expect(events.filter((e) => e.type === "saved")).toHaveLength(1);
  });
});
