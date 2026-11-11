import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, Session } from "../api";
import type { RunTurnCallbacks, RunTurnConfig } from "../agent/agent";
import type { RunnerEnv, RunnerHandle } from "../runnerTypes";

const { mockRunTurn, mockListModels, mockRename, mockName } = vi.hoisted(() => ({
  mockRunTurn: vi.fn(),
  mockListModels: vi.fn(),
  mockRename: vi.fn(),
  mockName: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listModels: mockListModels, renameSession: mockRename };
});
vi.mock("../agent/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/agent")>();
  return { ...actual, runTurn: mockRunTurn };
});
vi.mock("../agent/sessionNaming", () => ({ askForSessionName: mockName }));

import { attachedPaths, makeReply } from "../runnerReply";

// No model and no server: runTurn is a mock that reports through the callbacks
// the way the real one does. The handle is a bare session in a variable.

const env = {
  connector: { id: "c", kind: "openai", api: "openai-chat" } as any,
  model: "m",
  models: [],
  toolContext: { definitions: [{ name: "t" }], checkCommands: {}, systemPrompt: "sys", update: "ctx" } as any,
  toolsOn: true,
  modelOptions: {},
} as RunnerEnv;

function makeHandle(patch: Partial<Session> = {}) {
  let session: Session = {
    id: "a",
    title: "a",
    model: "m",
    messages: [],
    contextStart: 0,
    workingDir: "/work",
    attachments: [{ path: "/docs", kind: "folder", source: "user" } as any, { path: "/work/x.txt", kind: "file", source: "user" } as any],
    usage: null,
    failed: null,
    plan: [{ id: "s1", text: "One", status: "running" }],
    ...patch,
  };
  const askUser = vi.fn();
  const setError = vi.fn();
  const setAbort = vi.fn();
  const readImage = vi.fn();
  const handle: RunnerHandle = {
    sessionId: "a",
    env,
    getSession: () => session,
    edit: (fn) => {
      session = fn(session);
    },
    setError,
    setAbort,
    askUser,
    planRunningRef: { current: true },
    planRef: {
      get current() {
        return session.plan;
      },
      set current(plan) {
        session = { ...session, plan };
      },
    },
    readImage,
  };
  return { handle, session: () => session, askUser, setError, setAbort, readImage };
}

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

// A turn that streams one reply and finishes.
function okTurn(seen?: { failedDuring?: (string | null)[] }, session?: () => Session) {
  mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
    cb.setError(null);
    cb.setFailed(null);
    const c = new AbortController();
    cb.setAbort(c);
    seen?.failedDuring?.push(session!().failed);
    const messages = [...config.forgotten, ...config.history, user(config.text), assistant("Done.")];
    cb.setMessages(messages);
    cb.setUsage({ contextTokens: 42, promptTokens: 40 });
    cb.setAbort(null);
    return { ok: true, messages, attached: config.attached };
  });
}

beforeEach(() => {
  mockRunTurn.mockReset();
  mockListModels.mockReset().mockResolvedValue([{ id: "m", status: "loaded" }]);
  mockRename.mockReset().mockResolvedValue({});
  mockName.mockReset().mockResolvedValue(null);
});

describe("attachedPaths", () => {
  it("lists the attachments in order, with no working directory among them", () => {
    expect(
      attachedPaths([
        { path: "/a/f.txt", kind: "file", source: "user" } as any,
        { path: "/a", kind: "folder", source: "user" } as any,
      ]),
    ).toEqual(["/a/f.txt", "/a"]);
  });
});

describe("makeReply", () => {
  it("writes what the turn reports into the session", async () => {
    const h = makeHandle();
    const seen = { failedDuring: [] as (string | null)[] };
    okTurn(seen, h.session);
    const reply = makeReply(h.handle);

    const result = await reply("Do step one", [user("earlier")], { planStep: "s1" });

    expect(result.ok).toBe(true);
    expect(result.messages.map((m) => m.content)).toEqual(["earlier", "Do step one", "Done."]);
    expect(h.session().messages).toEqual(result.messages);
    expect(h.session().usage).toEqual({ contextTokens: 42, promptTokens: 40 });
    // Saved as interrupted while the request was in flight, clear afterwards.
    expect(seen.failedDuring).toEqual(["interrupted"]);
    expect(h.session().failed).toBeNull();
    // The request controller reaches the runner, then is cleared.
    expect(h.setAbort.mock.calls.map((c) => c[0] !== null)).toEqual([true, false]);
  });

  it("leaves a side question out of a step's history, and keeps it in the session", async () => {
    const h = makeHandle();
    okTurn();
    const side = { ...user("what is it doing?"), aside: true };
    const sideAnswer = { ...assistant("Editing a file."), aside: true };
    const before = [user("request"), side, sideAnswer, assistant("working")];

    const result = await makeReply(h.handle)("Go", before, { planStep: "s1" });

    const config = mockRunTurn.mock.calls[0][0] as RunTurnConfig;
    expect(config.history.map((m) => m.content)).toEqual(["request", "working"]);
    // The step's result is the plan's own list; the session has the question back in place.
    expect(result.messages.map((m) => m.content)).toEqual(["request", "working", "Go", "Done."]);
    expect(h.session().messages.map((m) => m.content)).toEqual([
      "request", "what is it doing?", "Editing a file.", "working", "Go", "Done.",
    ]);
  });

  it("gives a chat turn after the plan the side questions as context", async () => {
    const h = makeHandle();
    okTurn();
    const side = { ...user("what is it doing?"), aside: true };
    const sideAnswer = { ...assistant("Editing a file."), aside: true };

    await makeReply(h.handle)("Thanks", [user("request"), side, sideAnswer, assistant("done")]);

    const config = mockRunTurn.mock.calls[0][0] as RunTurnConfig;
    expect(config.history.map((m) => m.content)).toEqual(["request", "what is it doing?", "Editing a file.", "done"]);
  });

  it("sends the step's history and the session's settings to runTurn", async () => {
    const h = makeHandle({ contextStart: 1 });
    okTurn();
    await makeReply(h.handle)("Go", [user("old"), user("kept")], { planStep: "s1", from: 0 });

    const config = mockRunTurn.mock.calls[0][0] as RunTurnConfig;
    // `from` can't go before the session's own start; the rest is forgotten.
    expect(config.history.map((m) => m.content)).toEqual(["kept"]);
    expect(config.forgotten.map((m) => m.content)).toEqual(["old"]);
    expect(config).toMatchObject({
      connectorId: "c",
      kind: "openai",
      api: "openai-chat",
      model: "m",
      toolsOn: true,
      planning: false,
      planStep: "s1",
      systemPrompt: "sys",
      toolContextUpdate: "ctx",
      seenUpdate: "",
      workingDir: "/work",
      attached: ["/docs", "/work/x.txt"],
      chatId: "a",
      text: "Go",
    });
  });

  it("reads the new message's image refs, once each, and tolerates a missing file", async () => {
    const h = makeHandle();
    okTurn();
    h.readImage.mockImplementation(async (_sid: string, id: string) => {
      if (id === "gone") throw new Error("ENOENT");
      return Buffer.from(id);
    });
    const refs = [
      { id: "new1", mediaType: "image/png" },
      { id: "gone", mediaType: "image/png" },
    ];
    const history = [{ ...user("earlier"), images: [{ id: "new1", mediaType: "image/png" }] }];
    const result = await makeReply(h.handle)("look", history, { images: refs });

    expect(result.ok).toBe(true);
    expect(h.readImage).toHaveBeenCalledWith("a", "new1");
    expect(h.readImage).toHaveBeenCalledWith("a", "gone");
    // "new1" is in both history and the new message: read once.
    expect(h.readImage.mock.calls.filter((c) => c[1] === "new1")).toHaveLength(1);
    const config = mockRunTurn.mock.calls[0][0] as RunTurnConfig;
    expect(config.images).toEqual(refs);
    expect(config.imagesBase64).toEqual({ new1: Buffer.from("new1").toString("base64") });
  });

  it("fixes the prompt directory from the working directory, once", async () => {
    const h = makeHandle();
    okTurn();
    const reply = makeReply(h.handle);
    await reply("one", []);
    expect(h.session().promptDir).toBe("/work");

    // The working directory changes later; the prompt directory stays.
    h.handle.edit((s) => ({ ...s, workingDir: "/other" }));
    await reply("two", []);
    expect(h.session().promptDir).toBe("/work");

    // No folder at the first reply: null, and it stays null.
    const bare = makeHandle({ workingDir: null });
    await makeReply(bare.handle)("one", []);
    expect(bare.session().promptDir).toBeNull();
  });

  it("only sends a context update the model hasn't seen", async () => {
    const h = makeHandle();
    okTurn();
    await makeReply(h.handle)("go", [{ ...user("first"), update: "ctx" }]);
    expect((mockRunTurn.mock.calls[0][0] as RunTurnConfig).seenUpdate).toBe("ctx");
  });

  it("tells the model how the chat's threads ended, in the context update", async () => {
    const h = makeHandle({
      threads: [{ sessionId: "c", summary: "Move the runners", anchor: null, status: "done", report: { text: "All steps passed.", at: 1 } }],
    });
    okTurn();
    await makeReply(h.handle)("go", []);
    const update = (mockRunTurn.mock.calls[0][0] as RunTurnConfig).toolContextUpdate;
    expect(update).toContain("ctx");
    expect(update).toContain("- done: Move the runners");
    expect(update).toContain("Report: All steps passed.");
  });

  it("hands asks to the runner, and the runner's own refs to the turn", async () => {
    const h = makeHandle();
    okTurn();
    await makeReply(h.handle)("go", []);
    const cb = mockRunTurn.mock.calls[0][1] as RunTurnCallbacks;
    expect(cb.askUser).toBe(h.askUser);
    expect(cb.setError).toBe(h.setError);
    expect(cb.planRunningRef).toBe(h.handle.planRunningRef);
    expect(cb.planRef).toBe(h.handle.planRef);
  });

  it("keeps a failure after the request ends", async () => {
    const h = makeHandle();
    mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      cb.setAbort(new AbortController());
      cb.setFailed("boom");
      cb.setAbort(null);
      return { ok: false, messages: [user(config.text)], attached: [], error: "boom" };
    });
    const result = await makeReply(h.handle)("go", []);
    expect(result).toMatchObject({ ok: false, error: "boom" });
    expect(h.session().failed).toBe("boom");
  });

  it("writes plan, todos, attachments and past plans into the session", async () => {
    const h = makeHandle();
    mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      const todo = { id: "t1", summary: "Later", description: "", context: "", status: "open" as const, createdAt: 1 };
      cb.changeTodos([todo]);
      expect(cb.todosRef.current).toEqual([todo]);
      cb.attach({ path: "/new", kind: "file", source: "request" });
      cb.attach({ path: "/new", kind: "file", source: "request" });
      cb.setPastPlans((p) => [...p, { steps: [], anchor: null }]);
      cb.setPlanProposal([{ id: "p", text: "P", status: "pending" }]);
      cb.setPlanAnchor("call_1");
      cb.setPlanContext("ctx");
      cb.setPlanSummary("sum");
      cb.changePlan([{ id: "s1", text: "One", status: "done" }]);
      return { ok: true, messages: [user(config.text)], attached: [] };
    });
    await makeReply(h.handle)("go", []);
    const s = h.session();
    expect(s.todos?.map((t) => t.id)).toEqual(["t1"]);
    expect(s.attachments.filter((a) => a.path === "/new")).toHaveLength(1);
    expect(s.pastPlans).toHaveLength(1);
    expect(s.planProposal?.map((p) => p.id)).toEqual(["p"]);
    expect([s.planAnchor, s.planContext, s.planSummary]).toEqual(["call_1", "ctx", "sum"]);
    expect(s.plan?.[0].status).toBe("done");
  });

  // The model may ask for a folder to read (a 'Model asked' attachment). That
  // is access to read it, never a change of where relative paths start.
  it("adds what the model asked for as an attachment and never changes the working directory", async () => {
    const h = makeHandle();
    const dirs: (string | null | undefined)[] = [];
    mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      cb.attach({ path: "/asked", kind: "folder", source: "request" });
      dirs.push(h.session().workingDir);
      return { ok: true, messages: [user(config.text)], attached: [] };
    });
    await makeReply(h.handle)("go", []);
    const s = h.session();
    expect(s.attachments.map((a) => [a.path, a.source])).toEqual([["/docs", "user"], ["/work/x.txt", "user"], ["/asked", "request"]]);
    expect(dirs).toEqual(["/work"]);
    expect(s.workingDir).toBe("/work");
    // The folder it asked for is not the prompt's folder either.
    expect(s.promptDir).toBe("/work");
  });

  // The other way a folder arrives: the user ticked "Make it the working
  // directory" in the find-this-folder prompt (see Picked).
  it("sets the working directory when the user chose a folder as one, and only in a chat with none", async () => {
    const bare = makeHandle({ workingDir: null, attachments: [] });
    mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      cb.setWorkingDir("/chosen");
      return { ok: true, messages: [user(config.text)], attached: [] };
    });
    await makeReply(bare.handle)("go", []);
    expect(bare.session().workingDir).toBe("/chosen");
    // It is not also an attachment, and the prompt's folder stays what it was at the first reply.
    expect(bare.session().attachments).toEqual([]);
    expect(bare.session().promptDir).toBeNull();
    // The next reply starts in it.
    await makeReply(bare.handle)("again", []);
    expect(mockRunTurn.mock.calls[1][0]).toMatchObject({ workingDir: "/chosen", attached: [] });

    // A chat that has one keeps it.
    const set = makeHandle();
    await makeReply(set.handle)("go", []);
    expect(set.session().workingDir).toBe("/work");
  });

  it("keeps a chat with no working directory without one when the model asks for a folder", async () => {
    const h = makeHandle({ workingDir: null, attachments: [] });
    mockRunTurn.mockImplementation(async (config: RunTurnConfig, cb: RunTurnCallbacks) => {
      cb.attach({ path: "/asked", kind: "folder", source: "request" });
      return { ok: true, messages: [user(config.text)], attached: [] };
    });
    await makeReply(h.handle)("go", []);
    expect(h.session().workingDir).toBeNull();
    expect(h.session().promptDir).toBeNull();
    expect(h.session().attachments.map((a) => a.path)).toEqual(["/asked"]);
    // The next turn still has no working directory, with the folder attached.
    await makeReply(h.handle)("again", []);
    expect(mockRunTurn.mock.calls[1][0]).toMatchObject({ workingDir: null, attached: ["/asked"] });
  });

  it("sends nothing and sets the error when the model isn't loaded", async () => {
    mockListModels.mockResolvedValue([{ id: "m", status: "unloaded" }]);
    const h = makeHandle();
    const before = [user("earlier")];
    const result = await makeReply(h.handle)("go", before, { planStep: "s1" });
    expect(result).toEqual({ ok: false, messages: before });
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining("isn't loaded"));
    expect(h.session().promptDir).toBeUndefined();
  });

  it("says the model is still loading, when it is", async () => {
    mockListModels.mockResolvedValue([{ id: "m", status: "loading" }]);
    const h = makeHandle();
    expect((await makeReply(h.handle)("go", [])).ok).toBe(false);
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining("still loading"));
  });

  it("goes ahead when the server can't say whether the model is loaded", async () => {
    mockListModels.mockRejectedValue(new Error("down"));
    const h = makeHandle();
    okTurn();
    expect((await makeReply(h.handle)("go", [])).ok).toBe(true);
  });

  it("fails without a connector", async () => {
    const h = makeHandle();
    h.handle.env = { ...env, connector: null };
    const result = await makeReply(h.handle)("go", []);
    expect(result.ok).toBe(false);
    expect(mockRunTurn).not.toHaveBeenCalled();
  });

  describe("naming the session", () => {
    it("names it after the first good reply, in the run's session", async () => {
      mockName.mockResolvedValue("Fix the login");
      const h = makeHandle();
      okTurn();
      await makeReply(h.handle)("go", []);
      expect(mockName).toHaveBeenCalledTimes(1);
      expect(h.session()).toMatchObject({ modelName: "Fix the login", title: "Fix the login" });
    });

    // A rename request that is not waited for can land after the run has
    // ended, as one more write that leaves the page's revision behind: its next
    // save (attaching a folder after the reply) is then refused as stale and
    // dropped. The run saves the name itself, so no request is sent.
    it("sends no rename request to the server, which could write after the run ended", async () => {
      mockName.mockResolvedValue("Fix the login");
      const h = makeHandle();
      okTurn();
      await makeReply(h.handle)("go", []);
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRename).not.toHaveBeenCalled();
    });

    it("doesn't ask when the session has a name, or the reply failed", async () => {
      okTurn();
      const named = makeHandle({ modelName: "Already" });
      await makeReply(named.handle)("go", []);
      expect(mockName).not.toHaveBeenCalled();

      mockRunTurn.mockResolvedValue({ ok: false, messages: [], attached: [] });
      const failed = makeHandle();
      await makeReply(failed.handle)("go", []);
      expect(mockName).not.toHaveBeenCalled();
      expect(failed.session().modelName).toBeUndefined();
    });

    it("keeps the session unnamed when the model gives no name", async () => {
      okTurn();
      const none = makeHandle();
      await makeReply(none.handle)("go", []);
      expect(none.session().modelName).toBeUndefined();
    });
  });
});
