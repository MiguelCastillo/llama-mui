import { describe, expect, it } from "vitest";
import type { ToolCall } from "../api";
import { IDLE_ROUNDS, ProgressWatch, SAME_OUTPUT_LIMIT, fingerprint } from "../agent/progress";

let n = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, arguments: JSON.stringify(args) });
const read = (path: string) => call("read_file", { path });
const edit = (path: string, old = "a", next = "b") => call("edit_file", { path, old_text: old, new_text: next });
const run = (command: string) => call("run_command", { command });

// Records one round (a list of [call, result]) and returns what the watch says after it.
const round = (w: ProgressWatch, ...calls: [ToolCall, string][]) => {
  for (const [c, r] of calls) w.record(c, r);
  return w.endRound();
};

describe("fingerprint", () => {
  it("drops colours and timings but keeps counts", () => {
    const a = "\u001b[31mTests 3 failed\u001b[39m (12ms)\n   Duration  1.2s\n Start at 10:11:12";
    const b = "Tests 3 failed (40ms)\nDuration 9.9s\nStart at 10:15:00";
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint("Tests 3 failed")).not.toBe(fingerprint("Tests 2 failed"));
  });
});

describe("commands that give the same output", () => {
  it(`stop it after ${SAME_OUTPUT_LIMIT} in a row, edits in between or not`, () => {
    const w = new ProgressWatch();
    const out = "FAIL x\nError: expected undefined to be defined";
    expect(round(w, [run("npx vitest run a"), out])).toBeNull();
    expect(round(w, [edit("/w/a.ts"), "Edited."], [run("npx vitest run a"), out])).toBeNull();
    expect(round(w, [edit("/w/a.ts", "b", "c"), "Edited."], [run("npx vitest run a"), out])).toBeNull();
    const stuck = round(w, [edit("/w/a.ts", "c", "d"), "Edited."], [run("npx vitest run a"), out]);
    expect(stuck).toBe("the last 4 commands all gave the same output (the last: `npx vitest run a`).");
  });

  it("keeps going while the output changes, even when the error text is the same", () => {
    const w = new ProgressWatch();
    for (const counts of ["3 failed", "2 failed | 1 passed", "1 failed | 2 passed", "1 failed | 2 passed (slower)", "3 passed"]) {
      expect(round(w, [edit("/w/a.ts", counts, counts + "!"), "Edited."], [run("npx vitest run a"), `Error: expected undefined to be defined\nTests ${counts}`])).toBeNull();
    }
  });

  it("count whatever the commands were: a model changes a flag and gets the same failure", () => {
    const w = new ProgressWatch();
    for (const c of ["npx vitest run a", "npx vitest run a --reporter=dot", "npx vitest run a 2>&1"]) expect(round(w, [run(c), "FAIL x"])).toBeNull();
    expect(round(w, [run("npx vitest run a 2>&1 | tail -40"), "FAIL x"])).toMatch(/the last 4 commands all gave the same output/);
  });

  it("don't count the same output when something else happened in between that changed it", () => {
    const w = new ProgressWatch();
    for (const out of ["FAIL x", "FAIL x", "ok", "FAIL x", "FAIL x", "ok", "FAIL x"]) expect(round(w, [run("make"), out])).toBeNull();
  });
});

describe("rounds with nothing new", () => {
  it(`stops after ${IDLE_ROUNDS} in a row of reading files that haven't changed`, () => {
    const w = new ProgressWatch();
    expect(round(w, [read("/w/a.ts"), "text a"], [read("/w/b.ts"), "text b"])).toBeNull();
    let said: string | null = null;
    for (let i = 0; i < IDLE_ROUNDS; i++) said = round(w, [read("/w/a.ts"), "text a"], [read("/w/b.ts"), "text b"]);
    expect(said).toMatch(/the last 6 rounds brought nothing new/);
  });

  it("counts calls alternating back and forth the same way", () => {
    const w = new ProgressWatch();
    round(w, [read("/w/a.ts"), "A"]);
    round(w, [read("/w/b.ts"), "B"]);
    let said: string | null = null;
    for (let i = 0; i < IDLE_ROUNDS; i++) said = round(w, [read(i % 2 ? "/w/a.ts" : "/w/b.ts"), i % 2 ? "A" : "B"]);
    expect(said).not.toBeNull();
  });

  it("is reset by anything new, a write most of all", () => {
    const w = new ProgressWatch();
    round(w, [read("/w/a.ts"), "A"]);
    for (let i = 0; i < IDLE_ROUNDS - 1; i++) expect(round(w, [read("/w/a.ts"), "A"])).toBeNull();
    expect(round(w, [edit("/w/a.ts"), "Edited."])).toBeNull();
    for (let i = 0; i < IDLE_ROUNDS - 1; i++) expect(round(w, [read("/w/a.ts"), "A2"])).toBeNull();
  });

  it("treats a read after an edit of that file as new, and a failed edit as no news", () => {
    const w = new ProgressWatch();
    round(w, [read("/w/a.ts"), "A"]);
    round(w, [edit("/w/a.ts"), "Edited."]);
    expect(round(w, [read("/w/a.ts"), "A edited"])).toBeNull();
    const w2 = new ProgressWatch();
    round(w2, [read("/w/a.ts"), "A"]);
    let said: string | null = null;
    // The first failure is news; the same failure again, and a read of a file that didn't change, are not.
    for (let i = 0; i < IDLE_ROUNDS + 1; i++) said = round(w2, [edit("/w/a.ts"), "Error: old_text isn't in the file"], [read("/w/a.ts"), "A"]);
    expect(said).not.toBeNull();
  });

  it("counts an error it already got as nothing new, but a new error as news", () => {
    const w = new ProgressWatch();
    const bad = call("grep", { pattern: "x", path: "/nope" });
    round(w, [bad, "Error: no such folder"]);
    let said: string | null = null;
    for (let i = 0; i < IDLE_ROUNDS; i++) said = round(w, [bad, "Error: no such folder"]);
    expect(said).not.toBeNull();
    const w2 = new ProgressWatch();
    for (let i = 0; i < IDLE_ROUNDS * 2; i++) expect(round(w2, [call("grep", { pattern: `x${i}`, path: "/w" }), `Error: nothing for x${i}`])).toBeNull();
  });
});

describe("a long honest job", () => {
  // The test runs of a real plan step that the old cap of 50 rounds stopped:
  // what each run said, in order. It read and edited between them.
  const runs = [
    "no tests", "1 failed | 18 passed (19)", "1 failed | 18 passed (19)", "1 failed | 18 passed (19)", "19 passed (19)",
    "3 failed | 917 passed (920)", "3 failed | 18 passed (21)", "19 passed (19)", "3 failed (3)", "2 failed | 1 passed (3)",
    "1 failed | 2 skipped (3)", "1 failed | 2 skipped (3)", "2 failed | 1 passed (3)", "1 failed | 2 skipped (3)",
    "1 failed | 2 skipped (3)", "1 failed | 2 passed (3)", "3 passed (3)", "19 passed (19)", "3 failed | 920 passed (923)",
  ];

  it("never stops: reads, edits and test runs that keep changing are progress", () => {
    const w = new ProgressWatch();
    let said: string | null = null;
    runs.forEach((tests, i) => {
      // Two rounds of reading and editing, then a test run whose output is not the one before it.
      said ??= round(w, [read("/w/api.ts"), "api"], [read("/w/runner.ts"), `runner ${i}`]);
      said ??= round(w, [edit("/w/runner.test.ts", `old${i}`, `new${i}`), "Edited."]);
      said ??= round(w, [run("npx vitest run server/__tests__/runnerImages.test.ts 2>&1"), `Error: expected undefined to be defined\nTests  ${tests}\n  Duration ${i}.${i}s`]);
    });
    expect(said).toBeNull();
  });
});

// What the server really returns for run_command: "$ <command>", the output,
// then "[exit code N]" (see exec in server/terminal.ts).
const printed = (command: string, output: string, code = 1) => `$ ${command}\n${output}\n[exit code ${code}]`;

describe("commands as the server really prints them", () => {
  it(`stop a model that changes the command but gets the same failure ${SAME_OUTPUT_LIMIT} times`, () => {
    const w = new ProgressWatch();
    const out = "FAIL x\nError: expected undefined to be defined";
    let said: string | null = null;
    for (let i = 0; i < SAME_OUTPUT_LIMIT; i++) said = round(w, [run(`npx vitest run # ${i}`), printed(`npx vitest run # ${i}`, out)]);
    expect(said).toMatch(/^the last 4 commands all gave the same output/);
  });

  it("does not take a run of silent successes for a loop", () => {
    const w = new ProgressWatch();
    let said: string | null = null;
    for (let i = 0; i < IDLE_ROUNDS * 2; i++) said ??= round(w, [run(`mkdir d${i}`), printed(`mkdir d${i}`, "(no output)", 0)]);
    expect(said).toBeNull();
  });

  it("a success in between starts the count over", () => {
    const w = new ProgressWatch();
    const out = "Error: boom";
    for (let i = 0; i < SAME_OUTPUT_LIMIT - 1; i++) expect(round(w, [run(`t ${i}`), printed(`t ${i}`, out)])).toBeNull();
    expect(round(w, [run("ls"), printed("ls", "a b", 0)])).toBeNull();
    expect(round(w, [run("t 9"), printed("t 9", out)])).toBeNull();
  });

  it("handles a command that spans lines", () => {
    const w = new ProgressWatch();
    let said: string | null = null;
    for (let i = 0; i < SAME_OUTPUT_LIMIT; i++) {
      const cmd = `echo ${i}\nfalse`;
      said = round(w, [run(cmd), printed(cmd, "Error: boom")]);
    }
    expect(said).not.toBeNull();
  });
});
