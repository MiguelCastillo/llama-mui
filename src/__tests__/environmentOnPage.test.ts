import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, changeEnvironment, forgetRevisions, getSession, saveSession, type Session } from "../api";
import { drawnActions } from "../actions";
import { choiceFromSession } from "../modelChoice";

const session = (id: string): Session => ({ id, title: "T", model: "stored", connectorId: "c-1", messages: [], contextStart: 0, attachments: [], usage: null, failed: null, plan: null });

// Answers each fetch with the next reply and keeps what was sent.
function serve(...replies: { status?: number; body: unknown }[]) {
  const sent: { method: string; url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = replies.shift()!;
      const status = r.status ?? 200;
      return { ok: status < 400, status, statusText: "", json: async () => r.body } as Response;
    }),
  );
  return sent;
}

beforeEach(() => forgetRevisions());
afterEach(() => vi.unstubAllGlobals());

describe("the page and the chat's model and connection", () => {
  it("leaves them out of a save for a chat the server holds, and sends them for a new one", async () => {
    const sent = serve({ body: { id: "a", revision: 1 } }, { body: { id: "a", revision: 2 } });
    await saveSession(session("a"), { leaveOutModelAndConnection: true });
    await saveSession(session("a"));
    expect(sent[0].body).not.toHaveProperty("model");
    expect(sent[0].body).not.toHaveProperty("connectorId");
    expect(sent[0].body.title).toBe("T");
    expect(sent[1].body).toMatchObject({ model: "stored", connectorId: "c-1" });
  });

  it("changes one item through the explicit request, and the next save is not taken as stale", async () => {
    const sent = serve(
      { body: { ...session("a"), revision: 4 } },
      { body: { id: "a", revision: 5, environment: { model: "other" } } },
      { body: { id: "a", revision: 6 } },
    );
    await getSession("a");
    await changeEnvironment("a", "model", "other");
    await saveSession(session("a"), { leaveOutModelAndConnection: true });
    expect(sent[1]).toMatchObject({ method: "POST", url: "/api/sessions/a/environment", body: { item: "model", value: "other" } });
    expect(sent[2].body.revision).toBe(5);
  });

  it("shows the server's reason when the change is refused", async () => {
    serve({ status: 409, body: { error: "A reply is running in this chat, so the model was not changed." } });
    const err = await changeEnvironment("a", "model", "other").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/was not changed/);
  });
});

describe("what a chat shows once the server has answered", () => {
  it("is the stored model and connection, for a saved copy and a run's copy alike", () => {
    const saved = session("a");
    const duringRun = { ...saved, run: { status: "running", startedAt: 1 } };
    expect(choiceFromSession(saved)).toEqual({ model: "stored", connectorId: "c-1" });
    expect(choiceFromSession(duringRun)).toEqual(choiceFromSession(saved));
  });

  it("is empty, never the previous chat's model, when the server stored none", () => {
    expect(choiceFromSession({ ...session("b"), model: "", connectorId: undefined })).toEqual({ model: "", connectorId: null });
    expect(choiceFromSession({})).toEqual({ model: "", connectorId: null });
  });
});

describe("nothing can be changed before the chat has answered", () => {
  it("draws no way to change the environment until the chat has loaded", () => {
    expect(drawnActions(false, ["send", "changeEnvironment"], true, false).has("changeEnvironment")).toBe(false);
  });

  it("draws it only when the server lists it", () => {
    expect(drawnActions(true, ["send"], true, false).has("changeEnvironment")).toBe(false);
    expect(drawnActions(true, [], true, false).has("changeEnvironment")).toBe(false);
    expect(drawnActions(true, ["changeEnvironment"], true, false).has("changeEnvironment")).toBe(true);
  });
});
