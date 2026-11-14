import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/api.ts";
import { COMPACT_FAILED, MAX_COMPACT_TRIES } from "../../src/compact.ts";
import type { RunnerEnv, RunnerHandle } from "../../src/runnerTypes.ts";
import { handles, makeSession, resetFakes } from "./fakeRun.ts";
import { fileOf, files, putFile } from "./memorySessions.ts";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui. The session
// files themselves are held in memory (see memorySessions.ts).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});
vi.mock("../sessionFile.ts", async (original) => (await import("./memorySessions.ts")).withMemory(await original<object>()));

const hub = await import("../runHub.ts");
const runners = await import("../runners.ts");
const reads = await import("../reads.ts");
const { compactInstruction } = await import("../compactInstruction.ts");

// Compaction on the server (src/compact.ts): after a reply that leaves the chat
// past the threshold, or before a message when there is no room left, or when
// the Compact session button asks, the model is asked for a summary as one more
// reply in the same run. The replies are fakes (what makeReply would do), so no
// model is needed. The model's window here is 1000 tokens.

const env = {
  connector: { id: "c", name: "C", url: "http://x", hasKey: true } as any,
  model: "m",
  models: [{ id: "m", contextSize: 1000 }] as any,
  toolContext: { definitions: [], checkCommands: {} } as any,
  toolsOn: false,
  modelOptions: {},
} as RunnerEnv;

const hello: ChatMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
];

interface Call {
  text: string;
  compact: boolean;
  before: ChatMessage[];
}
let calls: Call[] = [];
// How full the chat is after a normal reply, in tokens of the 1000-token window.
let contextAfterReply = 100;
// What the model says when asked for the summary. "" is a failed attempt.
let summaryText = "The summary.";
// Called while the compaction reply runs, to let a test stop it.
let duringCompaction: (h: RunnerHandle) => void = () => {};

// What makeReply does, in short: streams the messages into the session, sets the
// usage, and for a compaction that got a summary moves the history start.
function fakeReply(h: RunnerHandle) {
  handles.set(h.sessionId, h);
  return async (text: string, before: ChatMessage[], opts: { compact?: boolean } = {}) => {
    const compact = opts.compact === true;
    calls.push({ text, compact, before });
    const flag = compact ? { compaction: true } : {};
    const messages: ChatMessage[] = [
      ...before,
      { role: "user", content: text, ...flag },
      { role: "assistant", content: compact ? summaryText : "Fine.", ...flag },
    ];
    h.edit((s) => ({ ...s, messages, usage: { contextTokens: compact ? 900 : contextAfterReply } as any }));
    if (compact) {
      duringCompaction(h);
      if (summaryText.trim()) {
        h.edit((s) => ({ ...s, contextStart: before.length, usage: null }));
      }
    }
    return { ok: true, messages };
  };
}

function save(id: string, messages: ChatMessage[] = hello, extra: object = {}) {
  putFile(id, { ...makeSession(id, 0), plan: null, messages, revision: 4, ...extra });
}

const startedAt = (id: string, text = "And now?", options: { compact?: boolean } = {}) =>
  runners.startTurn(id, env, { text, planning: false, ...options }, { reply: fakeReply, save: (s) => hub.save(s.id, s) });

async function turn(id: string, text = "And now?") {
  const run = await startedAt(id, text);
  await run.done;
}

// What the run tells pages when it ends: the events the hub publishes.
let events: any[] = [];
let unsubscribe: () => void = () => {};
const endErrors = () => events.filter((e) => e.type === "status" && e.data?.run === null).map((e) => e.data.error);

beforeEach(() => {
  resetFakes();
  events = [];
  unsubscribe = hub.subscribe((e) => events.push(e));
  calls = [];
  contextAfterReply = 100;
  summaryText = "The summary.";
  duringCompaction = () => {};
});

afterEach(async () => {
  unsubscribe();
  await runners.resetRunners();
  files.clear();
});

describe("compaction after a reply", () => {
  it("asks for no summary while the chat is under the threshold", async () => {
    save("a");
    contextAfterReply = 599;
    await turn("a");
    expect(calls.map((c) => c.compact)).toEqual([false]);
    expect(fileOf("a").contextStart).toBe(0);
  });

  it("asks for a summary as one more reply once the chat is past it, and moves the history start to the request", async () => {
    save("a");
    contextAfterReply = 600;
    await turn("a");
    expect(calls.map((c) => c.compact)).toEqual([false, true]);
    expect(calls[1].text).toBe(await compactInstruction());
    const saved = fileOf("a");
    // Nothing was deleted: the request and the summary follow the reply.
    expect(saved.messages).toHaveLength(hello.length + 4);
    expect(saved.messages.slice(0, hello.length)).toEqual(hello);
    expect(saved.messages[hello.length + 2]).toMatchObject({ role: "user", content: await compactInstruction(), compaction: true });
    expect(saved.messages[hello.length + 3]).toMatchObject({ role: "assistant", content: "The summary.", compaction: true });
    expect(saved.contextStart).toBe(hello.length + 2);
    // The token count was of the old history, so it is gone until the next reply.
    expect(saved.usage).toBeNull();
    expect(saved.failed ?? null).toBeNull();
  });

  it("makes the model forget which files it has read, so it reads them again before a change", async () => {
    save("a");
    reads.markRead("a", "/f.txt", "text");
    expect(() => reads.requireRead("a", "/f.txt", "text")).not.toThrow();
    contextAfterReply = 900;
    await turn("a");
    expect(() => reads.requireRead("a", "/f.txt", "text")).toThrow(/read \/f\.txt with read_file/);
  });

  it("puts the chat back as it was when there is no summary, without failing the reply", async () => {
    save("a");
    contextAfterReply = 900;
    summaryText = "  ";
    const run = await startedAt("a");
    await run.done;
    const saved = fileOf("a");
    expect(saved.messages).toEqual([...hello, { role: "user", content: "And now?" }, { role: "assistant", content: "Fine." }]);
    expect(saved.contextStart).toBe(0);
    // The token count is the one the reply left, not the failed request's.
    expect(saved.usage).toMatchObject({ contextTokens: 900 });
    expect(saved.failed ?? null).toBeNull();
    expect(hub.liveRun("a")).toBeNull();
  });

  it("tries again after the next reply, a limited number of times in a row", async () => {
    save("a");
    contextAfterReply = 900;
    summaryText = "";
    for (let i = 0; i < MAX_COMPACT_TRIES + 2; i++) await turn("a", `m${i}`);
    // Each reply, then a try after it, until the tries are used up.
    expect(calls.filter((c) => c.compact)).toHaveLength(MAX_COMPACT_TRIES);
    expect(calls).toHaveLength(MAX_COMPACT_TRIES + 2 + MAX_COMPACT_TRIES);
  });

  it("counts from zero again once a reply leaves the chat under the threshold", async () => {
    save("a");
    contextAfterReply = 900;
    summaryText = "";
    for (let i = 0; i < MAX_COMPACT_TRIES; i++) await turn("a", `m${i}`);
    contextAfterReply = 100;
    await turn("a", "short");
    calls = [];
    contextAfterReply = 900;
    await turn("a", "again");
    expect(calls.map((c) => c.compact)).toEqual([false, true]);
  });

  it("does not count Stop during the summary as a failed try", async () => {
    save("a");
    contextAfterReply = 900;
    duringCompaction = () => void runners.stopRun("a").catch(() => {});
    summaryText = "";
    for (let i = 0; i < MAX_COMPACT_TRIES + 1; i++) {
      calls = [];
      await turn("a", `m${i}`);
      expect(calls.some((c) => c.compact)).toBe(true);
    }
  });
});

describe("what the user is told", () => {
  it("nothing when it worked: the divider says so", async () => {
    save("a");
    contextAfterReply = 900;
    await turn("a");
    expect(endErrors().every((e) => !e)).toBe(true);
  });

  it('"Session compaction failed." when there was no summary', async () => {
    save("a");
    contextAfterReply = 900;
    summaryText = "";
    await turn("a");
    expect(endErrors()).toEqual([COMPACT_FAILED]);
    expect(COMPACT_FAILED).toBe("Session compaction failed.");
  });

  it("the same for the button", async () => {
    save("a");
    summaryText = "";
    const run = await startedAt("a", "", { compact: true });
    await run.done;
    expect(endErrors()).toEqual([COMPACT_FAILED]);
  });

  it("nothing when the user stopped it", async () => {
    save("a");
    contextAfterReply = 900;
    duringCompaction = () => void runners.stopRun("a").catch(() => {});
    summaryText = "";
    await turn("a");
    expect(endErrors().every((e) => !e)).toBe(true);
  });

  it("doesn't pause the queue: a message waiting for the reply still goes", async () => {
    const item = { id: "q1", text: "queued", options: { connectorId: "c", model: "m", toolsOn: true, modelOptions: {}, planning: false }, queuedAt: 1 };
    save("a", hello, { queue: [item] });
    contextAfterReply = 900;
    summaryText = "";
    const sent: string[] = [];
    const run = await runners.startTurn(
      "a",
      env,
      { text: "And now?", planning: false },
      { reply: fakeReply, save: (s) => hub.save(s.id, s), next: async (_id, queued) => void sent.push(queued.text) },
    );
    await run.done;
    expect(endErrors()).toEqual([COMPACT_FAILED]);
    expect(sent).toEqual(["queued"]);
    expect(fileOf("a").queuePaused).toBeFalsy();
  });
});

describe("compaction before a message", () => {
  it("summarizes first when the chat has no room left, then answers from the summary", async () => {
    save("a", hello, { usage: { contextTokens: 1000 } });
    await turn("a", "Next question");
    expect(calls.map((c) => c.compact)).toEqual([true, false]);
    // The reply after it starts from the chat as the summary left it.
    expect(calls[1].before.at(-1)).toMatchObject({ role: "assistant", content: "The summary.", compaction: true });
    const saved = fileOf("a");
    expect(saved.contextStart).toBe(hello.length);
    expect(saved.messages.at(-1)).toMatchObject({ role: "assistant", content: "Fine." });
  });

  it("goes straight to the message when the chat still has room", async () => {
    save("a", hello, { usage: { contextTokens: 999 } });
    contextAfterReply = 100;
    await turn("a");
    expect(calls.map((c) => c.compact)).toEqual([false]);
  });

  it("answers the message anyway when the summary couldn't be had", async () => {
    save("a", hello, { usage: { contextTokens: 1200 } });
    summaryText = "";
    await turn("a", "Next question");
    expect(calls.map((c) => c.compact)).toEqual([true, false]);
    expect(fileOf("a").messages.at(-1)).toMatchObject({ role: "assistant", content: "Fine." });
  });
});

describe("the Compact session button", () => {
  it("asks for the summary only, whatever the chat's size, without a reply of its own", async () => {
    save("a", hello, { usage: { contextTokens: 100 } });
    const run = await startedAt("a", "", { compact: true });
    await run.done;
    expect(calls.map((c) => c.compact)).toEqual([true]);
    expect(fileOf("a").contextStart).toBe(hello.length);
  });

  it("still works after the automatic tries are used up", async () => {
    save("a");
    contextAfterReply = 900;
    summaryText = "";
    for (let i = 0; i < MAX_COMPACT_TRIES; i++) await turn("a", `m${i}`);
    summaryText = "Now it works.";
    calls = [];
    const run = await startedAt("a", "", { compact: true });
    await run.done;
    expect(calls.map((c) => c.compact)).toEqual([true]);
    expect(fileOf("a").messages.at(-1)).toMatchObject({ content: "Now it works." });
  });

  it("is refused while a reply is running", async () => {
    save("a");
    duringCompaction = () => {};
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 20));
    const first = runners.startTurn(
      "a",
      env,
      { text: "slow", planning: false },
      {
        reply: (h) => {
          handles.set(h.sessionId, h);
          return async (_t: string, before: ChatMessage[]) => {
            await slow;
            return { ok: true, messages: before };
          };
        },
        save: (s) => hub.save(s.id, s),
      },
    );
    const run = await first;
    await expect(startedAt("a", "", { compact: true })).rejects.toMatchObject({ status: 409 });
    await run.done;
  });
});
