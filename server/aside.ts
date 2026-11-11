// A side question: one reply, asked while a plan runs in the session, answered
// beside the plan instead of waiting for it. The question and the answer go
// into the session as messages with `aside: true`, so the chat shows them, but
// no plan step sees them (src/asides.ts); a chat turn after the plan does.
//
//  - It is a reply of its own (src/agent's runTurn, the same loop a chat reply
//    runs) on a request of its own. The plan's request is not touched.
//  - It sees the chat so far (not the plan steps' own messages, which would
//    fill its context) and a note on the question: that it is a side question,
//    that it can only read, and where the plan stands now.
//  - It may read, with the planning turn's read-only tools minus the ones that
//    change the plan or the todos (ASIDE_TOOLS). A question the tools would
//    need the user for (a path that isn't attached) is turned down, so it never
//    competes with the plan's own question.
//  - Its messages are written through the run (openAside in runners.ts), the
//    one writer of the session while the plan runs, so the plan's saves carry
//    them and can't undo them.
//  - One at a time per session: a second is refused (409) with a plain reason.
//    Stop, or the end of the run, ends it, keeping what was written.
//
// A local model server may serve one request at a time, so the answer can wait
// behind the plan's own request.

import { type RunTurnCallbacks, runTurn } from "../src/agent/agent.ts";
import { failureLine } from "../src/agent/helpers.ts";
import { ASIDE_TOOLS } from "../src/agent/plan.ts";
import type { ChatMessage } from "../src/api.ts";
import { asideNote, isAside } from "../src/asides.ts";
import { attachedPaths } from "../src/runnerReply.ts";
import type { RunnerEnv } from "../src/runnerTypes.ts";
import { HttpError } from "./http.ts";
import { abortAside, openAside } from "./runners.ts";

export interface AsideDeps {
  // Runs the reply; runTurn unless a test passes a fake.
  turn?: typeof runTurn;
}

const toolName = (d: unknown): string => {
  const x = d as { name?: string; function?: { name?: string } };
  return x?.function?.name ?? x?.name ?? "";
};

// Starts a side question in a session whose plan is running, and answers once
// the question is in the session; the answer streams in after that. `done`
// settles when the answer is over. Refused (409) if no plan is running here,
// if one is being answered already, or there is no server to ask; 400 for no
// text.
export async function startAside(
  id: string,
  env: RunnerEnv,
  text: string,
  deps: AsideDeps = {},
): Promise<{ done: Promise<void> }> {
  const question = text.trim();
  if (!question) throw new HttpError(400, "text must be given");
  const { connector } = env;
  if (!connector) throw new HttpError(409, "No server is chosen, so the question wasn't sent.", { reason: "no server" });

  const slot = openAside(id);
  try {
    const run = deps.turn ?? runTurn;
    const s = slot.session();

    // The chat so far, as the model saw it, without the steps' own messages
    // (they are under the steps, and a step starts with a fresh context). Earlier
    // side questions stay: they are part of the conversation. The flag comes off
    // the copy, so what this reply writes is told apart from them.
    const history: ChatMessage[] = s.messages
      .slice(Math.max(0, s.contextStart ?? 0))
      .filter((m) => !m.planStep)
      .map(({ aside: _aside, ...m }) => m);
    const seen = [...history].reverse().find((m) => m.update)?.update ?? "";

    // What the running step said last, so "what is it doing?" has an answer.
    const running = s.plan?.find((st) => st.status === "running")?.id;
    const latest = running
      ? [...s.messages].reverse().find((m) => m.planStep === running && m.role === "assistant" && m.content.trim())?.content
      : undefined;

    let mine: ChatMessage[] = [];
    let said: string | null = null;
    const noop = () => {};
    const callbacks: RunTurnCallbacks = {
      // Everything the reply writes has `aside` on it; the rest is the history.
      setMessages: (messages) => {
        mine = messages.filter(isAside);
        slot.setMessages(mine);
      },
      setError: (err) => void (said = err),
      // The plan's own failure state, usage and attachments are not this
      // question's to change.
      setFailed: noop,
      setUsage: noop,
      setAbort: noop,
      refreshModels: noop,
      askUser: async () => false,
      attach: noop,
      setWorkingDir: noop,
      setPlanProposal: noop,
      setPastPlans: noop,
      setPlanAnchor: noop,
      setPlanContext: noop,
      setPlanSummary: noop,
      changePlan: noop,
      todosRef: { current: s.todos ?? [] },
      changeTodos: noop,
      planRef: { current: s.plan ?? null },
      planRunningRef: { current: true },
      planAnchor: null,
      planContext: null,
      planSummary: null,
    };

    const failed = (why: string) => {
      if (slot.controller.signal.aborted) return;
      slot.setMessages([
        ...mine,
        { role: "assistant", content: `The side question failed: ${failureLine(why, connector.name || connector.kind)}`, aside: true },
      ]);
    };

    const done = (async () => {
      const result = await run(
        {
          connectorId: connector.id,
          kind: connector.kind,
          api: connector.api,
          model: env.model,
          toolsOn: env.toolsOn,
          modelOptions: env.modelOptions,
          planning: false,
          aside: true,
          note: asideNote(s.plan, latest),
          allowedTools: ASIDE_TOOLS,
          systemPrompt: env.toolContext.systemPrompt,
          toolDefinitions: env.toolContext.definitions.filter((d) => ASIDE_TOOLS.has(toolName(d))),
          // No chat update on the question: what the model saw last stands.
          toolContextUpdate: seen,
          seenUpdate: seen,
          history,
          forgotten: [],
          workingDir: s.workingDir ?? null,
          attached: attachedPaths(s.attachments ?? []),
          chatId: id,
          controller: slot.controller,
          started: performance.now(),
          text: question,
        },
        callbacks,
      );
      if (!result.ok) {
        const why = result.error ?? said;
        if (why) failed(why);
      }
    })()
      .catch((err) => failed(String(err?.message ?? err)))
      .finally(() => slot.release());
    slot.track(done);
    return { done };
  } catch (err) {
    slot.release();
    throw err;
  }
}

// Stops the side question being answered in this session, keeping what it has
// written, and nothing else: the plan goes on. False if there is none.
export const stopAside = (id: string): boolean => abortAside(id);
