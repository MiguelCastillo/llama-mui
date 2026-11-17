import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectServers, describeServer, type Deps } from "../why/servers";

const j = (o: object) => JSON.stringify(o);

function root(lines: object[]) {
  const r = mkdtempSync(path.join(os.tmpdir(), "why-srv-"));
  mkdirSync(path.join(r, "logs"));
  writeFileSync(path.join(r, "logs", "server-2026-11-17.log"), lines.map(j).join("\n"));
  return r;
}

const deps = (alive: number[], git: string | null): Deps & { since: string[] } => {
  const since: string[] = [];
  return {
    since,
    isAlive: (p) => alive.includes(p),
    gitLog: async (s) => {
      since.push(s);
      return git;
    },
  };
};

const prod = [
  { t: "2026-11-17T10:00:00.000Z", pid: 10, event: "server.start", mode: "prod" },
  { t: "2026-11-17T10:00:01.000Z", pid: 10, event: "server.listening", port: 5173 },
  { t: "2026-11-17T10:00:01.000Z", pid: 10, event: "server.listening", port: 5172 },
];

describe("why: servers", () => {
  it("lists a live server with ports, start time and changed code", async () => {
    const d = deps([10], "abc1234\ndef5678\n");
    const r = await collectServers({ root: root(prod), deps: d });
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({ pid: 10, mode: "prod", pagePort: 5173, apiPort: 5172, codeChanged: true, commits: 2 });
    expect(d.since).toEqual(["2026-11-17T10:00:00.000Z"]);
    expect(describeServer(r.servers[0])).toContain("code changed since it started: yes (2 commits)");
    expect(r.missing.join(" ")).toContain("no server id");
  });

  it("says no when git lists nothing", async () => {
    const r = await collectServers({ root: root(prod), deps: deps([10], "") });
    expect(r.servers[0].codeChanged).toBe(false);
  });

  it("puts a git failure in Missing instead of guessing", async () => {
    const r = await collectServers({ root: root(prod), deps: deps([10], null) });
    expect(r.servers[0].codeChanged).toBeNull();
    expect(r.missing.join(" ")).toContain("git could not say");
  });

  it("skips closed servers and dead processes", async () => {
    const closed = root([...prod, { t: "2026-11-17T10:30:00.000Z", pid: 10, event: "server.close", reason: "reload" }]);
    expect((await collectServers({ root: closed, deps: deps([10], "") })).servers).toEqual([]);
    const dead = await collectServers({ root: root(prod), deps: deps([], "") });
    expect(dead.servers).toEqual([]);
    expect(dead.missing.join(" ")).toContain("No server is listening");
  });

  it("does not guess ports for an unknown mode", async () => {
    const r = await collectServers({
      root: root([
        { t: "2026-11-17T10:00:00.000Z", pid: 11, event: "server.start", mode: "weird" },
        { t: "2026-11-17T10:00:01.000Z", pid: 11, event: "server.listening", port: 9000 },
      ]),
      deps: deps([11], ""),
    });
    expect(r.servers[0].pagePort).toBeNull();
    expect(r.servers[0].apiPort).toBeNull();
    expect(r.missing.join(" ")).toContain("could not tell which port is the page");
  });

  it("reports missing logs", async () => {
    const r = await collectServers({ root: mkdtempSync(path.join(os.tmpdir(), "why-srv-")), deps: deps([], "") });
    expect(r.missing[0]).toContain("No server start lines");
  });
});
