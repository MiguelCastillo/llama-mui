// Registry of the tools the model can call in chat, grouped for Settings →
// Tools. Tools are on unless the user turned them off.

import os from "node:os";
import { audit, noteSession, whoOf } from "./audit.ts";
import { currentCause, newId, runWithCause } from "./auditContext.ts";
import { DISK_TOOLS, checkAttachments, checkWorkingDir } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { RULE_TOOLS, governingRules, readRules, ruleTools, workingRules } from "./rules.ts";
import { readRecentFolders, withFolder, writeRecentFolders } from "./recentFolders.ts";
import { load, save } from "./store.ts";
import {
  AccessNeeded,
  LocateNeeded,
  ApprovalNeeded,
  type AccessRequest,
  type AttachmentTarget,
  type Approval,
  type ToolContext,
  ToolError,
  type ToolSpec,
} from "./toolkit.ts";
import { FETCH_TOOLS } from "./fetch.ts";
import { INSPECT_TOOLS } from "./inspect.ts";
import { PLAN_TOOLS, planInstructions } from "./plan.ts";
import { personaForChat } from "./personaChoice.ts";
import { BUILDER_NAME, type Persona, loadPersonas, personaPromptText } from "./personas.ts";
import { cleanPersona } from "../src/persona.ts";
import { readSession, sessionFolder } from "./sessionFile.ts";
import { SKILL_TOOLS, loadSkills, skillsPromptText } from "./skills.ts";
import { sessionHash } from "../src/sessionRoute.ts";
import { THREAD_TOOLS, threadInstructions } from "./threads.ts";
import { TODO_TOOLS, todoInstructions } from "./todos.ts";
import { REPLY_NOTE_TOOLS, replyNoteInstructions } from "./replyNotes.ts";
import { TERMINAL_TOOLS, exec } from "./terminal.ts";
import { WEB_TOOLS } from "./web.ts";
import { WORKTREE_TOOLS } from "./worktree.ts";
import { WRITE_TOOLS } from "./write.ts";

interface Group {
  id: string;
  label: string;
  description: string;
  // What the model should know to use this group's tools well. Part of the
  // system prompt, which never changes (see toolsSystemPrompt).
  instructions: string;
}

const GROUPS: Group[] = [
  {
    id: "rules",
    label: "Rules",
    description:
      "The model can add a rule to your standing rules (rules.md) when you ask it to remember " +
      "something. You see the exact line and approve it; it is never approved for you.",
    instructions: ruleTools,
  },
  {
    id: "plan",
    label: "Plan",
    description:
      "Before changing files, the model writes the steps as a checklist. Chat runs one step per turn and " +
      "checks each one, so a step that isn't really done shows up instead of a reply that says it is.",
    instructions: planInstructions,
  },
  {
    id: "todos",
    label: "Todos",
    description:
      "Things you want to come back to. When you ask, the model saves one in the session; My Todos, on the " +
      "empty chat, lists them across sessions and starts one where it was saved.",
    instructions: todoInstructions,
  },
  {
    id: "replyNotes",
    label: "Ideas and action items",
    description:
      "Instead of writing an idea or something left for you at the end of a reply, the model hands it over as a " +
      "note shown in its own box under the reply. Not available to side questions.",
    instructions: replyNoteInstructions,
  },
  {
    id: "threads",
    label: "Threads",
    description:
      "When a plan runs in its own session (a thread), the chat that started it gets a short report. This lets " +
      "the model ask the thread's own model for a fuller summary when you ask about the result.",
    instructions: threadInstructions,
  },
  {
    id: "skills",
    label: "Skills",
    description:
      "Lets the model open a skill (a folder of instructions in ~/.llama-mui/skills) when a task matches it. " +
      "Only the skill's name and description are in the prompt; this reads the rest. It changes nothing.",
    // The skill list, with its own sentence about load_skill, is added to the prompt by skillsPromptText.
    instructions: "",
  },
  {
    id: "disk",
    label: "Disk",
    description:
      "Read-only access to the files and folders attached to a chat (Session settings, next to the message box). " +
      "When the model asks for anything else, you're asked to allow it first. Nothing here can change, delete or run files.",
    instructions:
      "Relative paths are relative to the working directory, named at the end of this prompt. Other files and " +
      'folders the user attached are in "Chat update" notes on their messages; the latest one is current. ' +
      "If the user asks about other files or folders on this computer and gives " +
      "their absolute path, call the disk tools with it: the user is asked to allow it. If they name one without " +
      'its path ("my notes", "the llama-mui project"), don\'t guess paths: call locate_path and they\'ll pick it. ' +
      "Mention which files you looked at.",
  },
  {
    id: "write",
    label: "Write",
    description:
      "Create and change files in what's attached to a chat. Each change shows as a diff, and nothing is " +
      "written until you approve it. Files can't be deleted or run.",
    instructions:
      "You can create and change files with write_file and edit_file. The user sees each change and approves " +
      "it before it's written; if they don't, ask what they'd like instead. Read a file before editing it, and " +
      "use edit_file for changes to part of a file.",
  },
  {
    id: "worktree",
    label: "Worktrees",
    description:
      "Turning this on lets the model create git worktrees of a repo in your home folder, in this session's own " +
      "folder, without asking you; that also adds a branch to the repo. You approve a worktree being removed, " +
      "not made. A worktree holds only the files git tracks.",
    instructions:
      "To change a repo without touching the user's own checkout, call create_worktree with the repo's path " +
      "(it must be in their home folder). It makes the worktree on a new branch in this session's own folder " +
      "without asking the user, and you can then read, write and run commands in it with no further approval, " +
      "using its path as cwd. It holds only the files git tracks, so install dependencies before running " +
      "tests. Remove it with remove_worktree when done: that is the one step the user is asked to approve. " +
      "The branch and its commits stay.",
  },
  {
    id: "terminal",
    label: "Terminal",
    description:
      "Run shell commands the model suggests, in a folder attached to a chat. You see each command and approve " +
      "it before it runs. Commands run as you, with your network access and credentials (git, gh and so on).",
    instructions:
      "You can run shell commands with run_command, for example git, gh or npm; it runs on the user's computer, " +
      "which has network access and their credentials even though you don't. The user approves each command " +
      "before it runs. Run one command at a time, explain what it's for, and never run anything destructive " +
      "(rm -rf, force pushes, resets) unless the user asked for it. Whenever a tool needs the user's approval, " +
      "always fill `reason` with one plain sentence about why, in terms of what the user asked for, not a " +
      "restatement of the command or path (good: 'Checking which commit that hash is'; bad: 'Running git log').",
  },
  {
    id: "web",
    label: "Web",
    description:
      "Search the web through DuckDuckGo, and open web pages, as text or in a headless Chrome to check layout. " +
      "Search queries go to DuckDuckGo; pages are fetched from this machine, so they can include ones on your network. " +
      "Chrome pages on localhost open at once; any other site asks you first.",
    instructions:
      "You can search the web with web_search and read a page with fetch_url. Use them for current events, recent " +
      "releases and facts you aren't sure of, and always when the user asks you to search; don't answer those " +
      "from memory. Search first, then open the most relevant results to read them. Cite the URLs you used. To check how a page looks or is laid out, " +
      "use inspect_page: it opens the URL in Chrome and returns its structure, and the result of a script you give it.",
  },
];

const wrapped = new WeakSet<ToolSpec>();
// True for a spec that withAudit has wrapped (the coverage test checks it).
export const isAudited = (t: ToolSpec): boolean => wrapped.has(t);

const TOOLS: ToolSpec[] = withAudit([
  ...RULE_TOOLS,
  ...PLAN_TOOLS,
  ...TODO_TOOLS,
  ...REPLY_NOTE_TOOLS,
  ...THREAD_TOOLS,
  ...SKILL_TOOLS,
  ...DISK_TOOLS,
  ...WRITE_TOOLS,
  ...WORKTREE_TOOLS,
  ...TERMINAL_TOOLS,
  ...WEB_TOOLS,
  ...FETCH_TOOLS,
  ...INSPECT_TOOLS,
]);

// The registry's (wrapped) specs, for tests that check every one is covered.
export const toolSpecs = (): readonly ToolSpec[] => TOOLS;

// Every tool name the app has, whether or not it is turned off in Settings.
export const allToolNames = (): string[] => TOOLS.map((t) => t.name);

const isOffered = (ctx: ToolContext, t: ToolSpec) => ctx.store.toolsEnabled && !ctx.store.disabledTools.includes(t.name);

// The system prompt: what holds for the whole session. It never changes in a
// session, since it's the start of every request and a change made llama.cpp
// reprocess the whole chat (about a minute for 40k tokens). The tool list, also
// at the start, lists every tool for the same reason; one that's off is refused
// when it's called (runTool). See docs/guide.md, "What the model is told".
//
// Everything but the last line is the same in every session, so a new one
// reuses another's cached start (the tool list comes first, then this). The
// user's rules (~/.llama-mui/rules.md) are read each time the
// prompt is built, not frozen per session like the working directory: freezing
// them would mean saving their text in the session. An edit therefore makes the
// next message reprocess the start once, and the same for every session. Only
// the working directory differs, so it must stay last: anything per-session
// earlier would make each new session reprocess the rest. The built-in way of
// working (workingRules) opens it, the same for every user; the user's rules
// follow because they tune it and govern everything after them; an edit to
// them reprocesses the tools' help too, which is a few hundred tokens. The home folder is
// the same in every session; without it a model with nothing attached guessed
// Linux paths like /home/user. The session's own address (sessionNote) is the
// one line no other session shares, so it is last: the working directory is
// shared by every session in a project, and a session reuses another's cache
// up to the first line that differs.
// personaText is the chat's persona instructions (personas/*.md).
function toolsSystemPrompt(
  promptDir: string | null,
  rulesText: string,
  withTools: boolean,
  sessionLine: string | null = null,
  personaText = "",
  skillsText = "",
): string {
  // The built-in way of working comes first (the same for everyone), then the
  // user's rules, which tune it; the tools' help, the home folder and the
  // working directory follow, and only when there are tools.
  const rules = governingRules(rulesText);
  const start = [workingRules(withTools, personaText), ...(rules ? [rules] : [])];
  if (!withTools) return start.join("\n\n");
  return [
    ...start,
    "You have tools. Use one when it helps answer the question; otherwise answer directly.",
    ...GROUPS.map((g) => g.instructions).filter(Boolean),
    ...(skillsText ? [skillsText] : []),
    `The user's home folder is ${os.homedir()}.`,
    promptDir ? `Working directory: ${promptDir}` : "There's no working directory: use absolute paths.",
    ...(sessionLine ? [sessionLine] : []),
  ].join("\n\n");
}

// Where this session shows in a browser, for a model that can open pages. Each
// inspect_page starts a fresh browser that remembers nothing, so a plain
// address shows an empty chat; this one opens this session (see sessionRoute.ts
// in the page). The port is the one the request came to, with localhost for
// the host, which inspect_page opens without asking. Null when there is no
// session id, it isn't a plain one, or the request names no usable host.
export function sessionNote(chatId: string, host: unknown): string | null {
  try {
    sessionFolder(chatId);
  } catch {
    return null;
  }
  if (typeof host !== "string") return null;
  let port: string;
  try {
    port = new URL(`http://${host}`).port;
  } catch {
    return null;
  }
  const address = `http://localhost${port ? `:${port}` : ""}/${sessionHash(chatId)}`;
  return (
    `This session's id is ${chatId}. To see this chat in a browser, open ${address} with inspect_page. ` +
    "The plain address shows an empty chat, not this one."
  );
}

// A chat update: what changed in the session since its system prompt, which
// chat sends after the user's next message when it differs from the last one
// (see `update` on ChatMessage). The working directory, if it's not the one
// the system prompt names; the attachments (the working directory is not one);
// and tools that are off.
async function chatUpdate(ctx: ToolContext, promptDir: string | null, personaNote: string | null = null): Promise<string> {
  const dir = ctx.workingDir;
  const others = ctx.attachments;
  const off = TOOLS.filter((t) => !isOffered(ctx, t)).map((t) => t.name);
  return [
    "Chat update:",
    ...(dir !== promptDir ? [dir ? `The working directory is now ${dir}.` : "There's no working directory now."] : []),
    ...(personaNote ? [personaNote] : []),
    others.length ? `Also attached:\n${others.map((d) => `- ${d}`).join("\n")}` : "Nothing else is attached.",
    ...(!ctx.store.toolsEnabled
      ? ["Tools are turned off in Settings, so calls to any of them fail."]
      : off.length
        ? [`Turned off in Settings, so calls to them fail: ${off.join(", ")}.`]
        : []),
  ].join("\n");
}

const contextFor = async (body: any): Promise<ToolContext> => ({
  store: await load(),
  chatId: String(body.chatId ?? ""),
  workingDir: await checkWorkingDir(body.workingDir),
  attachments: await checkAttachments(body.attachments),
  // Re-serialized here so the comparison in requireApproval doesn't depend on
  // how the client formatted its JSON.
  approved: body.approved && typeof body.approved === "object" ? JSON.stringify(body.approved) : null,
  connectorId: typeof body.connectorId === "string" ? body.connectorId : undefined,
  model: typeof body.model === "string" ? body.model : undefined,
  todos: Array.isArray(body.todos)
    ? body.todos
        .filter((t: any) => typeof t?.id === "string" && typeof t?.summary === "string")
        .map((t: any) => ({ id: t.id, summary: t.summary }))
    : [],
});

// Text for the model (errors included), a path the user must allow before
// the call can run, or something the user must approve first.
type Outcome =
  | { result: string }
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"]; canSetWorkingDir?: boolean } }
  | { needsApproval: Approval };

// A path the model made up, where nothing exists, is first answered with an
// error it can correct from. Asking the user each time made a model that kept
// guessing (once 14 paths in a row) cost a Deny click per guess; only one that
// keeps going is brought to them. Any call that works starts the count over.
const MISSING_PATH_ERRORS = 2;
const missingPaths = new Map<string, number>();

// Tools every persona may use, whatever its list says: the base instructions
// tell every persona to use them.
export const ALWAYS_ALLOWED_TOOLS = ["add_idea", "add_action_item"];

// The persona a tool call is made under: the one saved with the chat's
// session, else the default (the same choice the prompt makes). The chat id
// may carry a suffix after ":" (a step's check runs under "<session>:check");
// the session is the part before it. A session that can't be read, or has no
// persona saved, uses the default.
export async function personaForCall(chatId: string, defaultPersona: string): Promise<Persona> {
  let saved: string | undefined;
  try {
    saved = cleanPersona((await readSession(chatId.split(":")[0]))?.persona);
  } catch {
    saved = undefined;
  }
  const { personas } = await loadPersonas();
  return (await personaForChat(saved, defaultPersona, personas)).persona;
}

// The plain error for a tool outside the persona's list, or null if allowed.
// A persona with no list may use every tool.
export function personaRefusal(name: string, persona: Persona): string | null {
  if (!persona.tools || persona.tools.includes(name) || ALWAYS_ALLOWED_TOOLS.includes(name)) return null;
  return `Error: the ${name} tool is not available to the ${persona.name} persona this chat works as. Use one of its tools: ${persona.tools.join(", ")}.`;
}

// What an argument holds, without its value: a type and a size.
const shapeOf = (v: unknown): string =>
  typeof v === "string" ? `string:${v.length}` : Array.isArray(v) ? `array:${v.length}` : v === null ? "null" : typeof v;

// The names and sizes of a call's arguments, never the values.
function argShape(args: unknown): Record<string, string> | string {
  if (typeof args === "string") return args; // already "raw:<size>" from safeParse
  if (!args || typeof args !== "object") return shapeOf(args);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, shapeOf(v)]));
}

// An approval as plain facts: its type and what it targets, never its diff.
function approvalFacts(a: any): { type: string; target: string } | null {
  if (!a || typeof a !== "object" || typeof a.type !== "string") return null;
  const target =
    a.type === "change" ? a.path : a.type === "command" ? a.command : a.type === "worktree" ? a.path : a.type === "page" ? a.url : "";
  return { type: a.type, target: String(target ?? "") };
}

function carriedApproval(approved: string | null) {
  if (!approved) return null;
  try {
    return approvalFacts(JSON.parse(approved));
  } catch {
    return null;
  }
}

// Writes the tool.call line. Used by the wrapper around every spec's run
// (withAudit) and by runTool's refusals, which never reach a run.
function logToolCall(o: {
  name: string;
  tool: ToolSpec | undefined;
  ctx: ToolContext;
  rawArgs: unknown;
  kind: string;
  started: number;
  needs?: { type: string; target: string } | null;
}) {
  const { name, tool, ctx, rawArgs } = o;
  let facts: Record<string, unknown> | undefined;
  try {
    const parsed = typeof rawArgs === "string" ? safeParse(rawArgs) : rawArgs;
    facts = tool?.audit && parsed && typeof parsed === "object" ? tool.audit(parsed) : undefined;
  } catch {
    facts = undefined;
  }
  noteSession(ctx.chatId);
  const call = currentCause().call;
  audit("tool.call", {
    session: ctx.chatId,
    ...(call ? { call } : {}),
    tool: name,
    group: tool?.group,
    persona: ctx.persona,
    outcome: o.kind,
    ms: Date.now() - o.started,
    args: argShape(typeof rawArgs === "string" ? safeParse(rawArgs) : rawArgs),
    facts,
    approval: carriedApproval(ctx.approved),
    ...(o.needs ? { needs: o.needs } : {}),
    noted: ctx.noted,
  });
}

// Wraps every spec's run so a call leaves its audit line whoever calls it, not
// only runTool: a tool added to the list is covered without remembering to log.
// A call logs once: a result, an error, or a question for the user.
function withAudit(specs: ToolSpec[]): ToolSpec[] {
  return specs.map((spec) => {
    const inner = spec.run;
    const out: ToolSpec = {
      ...spec,
      run: (ctx, args) =>
        // Everything the tool starts, and the line below, carry this call's cause.
        runWithCause({ ...(ctx.chatId ? { session: ctx.chatId } : {}), call: newId() }, async () => {
          const started = Date.now();
          ctx.noted = ctx.noted ?? {};
          let kind = "crash";
          let needs: { type: string; target: string } | null = null;
          try {
            const result = await inner(ctx, args);
            kind = result.startsWith("Error:") ? "error" : "result";
            return result;
          } catch (e: any) {
            if (e instanceof AccessNeeded) {
              kind = "needs-access";
              needs = { type: "access", target: e.target.path };
            } else if (e instanceof LocateNeeded) kind = "needs-location";
            else if (e instanceof ApprovalNeeded) {
              kind = "needs-approval";
              needs = approvalFacts(e.approval);
            } else if (e instanceof ToolError || e?.code === "EACCES" || e?.code === "EPERM") kind = "error";
            throw e;
          } finally {
            logToolCall({ name: spec.name, tool: out, ctx, rawArgs: args, kind, started, needs });
          }
        }),
    };
    wrapped.add(out);
    return out;
  });
}

// Every model tool call goes through here. A call that runs is logged by the
// wrapper around the tool's run; the refusals that stop it before it runs
// (unknown, off, persona, bad arguments) are logged here.
async function runTool(name: string, rawArgs: unknown, ctx: ToolContext, persona: Persona | null = null): Promise<Outcome> {
  const started = Date.now();
  const tool = TOOLS.find((t) => t.name === name);
  ctx.noted = ctx.noted ?? {};
  ctx.persona = persona?.name;
  return runToolChecked(name, tool, rawArgs, ctx, persona, (kind) =>
    logToolCall({ name, tool, ctx, rawArgs, kind, started }),
  );
}

const safeParse = (s: string): unknown => {
  try {
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return `raw:${s.length}`;
  }
};

// `mark` is called with the reason when a call is refused before it runs
// (the refusals are plain text for the model).
async function runToolChecked(
  name: string,
  tool: ToolSpec | undefined,
  rawArgs: unknown,
  ctx: ToolContext,
  persona: Persona | null,
  mark: (kind: string) => void,
): Promise<Outcome> {
  const text = (result: string) => ({ result });
  if (!tool) {
    mark("refused:unknown");
    return text(`Error: there is no tool named ${name}`);
  }
  if (!isOffered(ctx, tool)) {
    mark("refused:off");
    return text(`Error: the ${name} tool is turned off in Settings`);
  }
  const refusal = persona && personaRefusal(name, persona);
  if (refusal) {
    mark("refused:persona");
    return text(refusal);
  }
  let args: any;
  try {
    args = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
  } catch {
    mark("refused:bad-args");
    return text("Error: the tool arguments were not valid JSON");
  }
  try {
    const result = await tool.run(ctx, args);
    missingPaths.delete(ctx.chatId);
    return text(result);
  } catch (e: any) {
    if (e instanceof AccessNeeded) {
      if (e.target.kind === null) {
        const misses = (missingPaths.get(ctx.chatId) ?? 0) + 1;
        missingPaths.set(ctx.chatId, misses);
        if (misses <= MISSING_PATH_ERRORS) {
          return text(
            `Error: ${e.target.path} doesn't exist. Don't guess paths: call locate_path so the user can pick it, or ask them.`,
          );
        }
      }
      return { needsAccess: e.target };
    }
    if (e instanceof LocateNeeded) return { needsLocation: e.request };
    if (e instanceof ApprovalNeeded) return { needsApproval: e.approval };
    if (e instanceof ToolError) return text(`Error: ${e.message}`);
    if (e.code === "EACCES" || e.code === "EPERM") return text("Error: permission denied");
    throw e;
  }
}

// Handles /api/tools/*; returns false for anything else.
export async function toolRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "tools") return false;

  // For Settings: groups with each tool's on/off state.
  if (parts.length === 1 && method === "GET") {
    const store = await load();
    sendJson(res, 200, {
      enabled: store.toolsEnabled,
      groups: GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        description: g.description,
        tools: TOOLS.filter((t) => t.group === g.id).map((t) => ({
          name: t.name,
          label: t.label,
          summary: t.summary,
          enabled: !store.disabledTools.includes(t.name),
        })),
      })),
    });
    return true;
  }

  // For chat: what to send the model given this chat's working directory and
  // attachments.
  if (parts[1] === "context" && method === "POST") {
    const body = await readJson(req);
    const ctx = await contextFor(body);
    // The working directory the session's system prompt names: fixed at its
    // first message (see promptDir in Chat.tsx), so it can differ from now's.
    const promptDir = typeof body.promptDir === "string" ? body.promptDir : null;
    const offered = TOOLS.filter((t) => isOffered(ctx, t)).map((t) => t.name);
    // The persona: its name is the chat's saved one, or the default when none
    // is saved yet (see personaForChat). Its text is fixed with the prompt at
    // the first reply and again after Clear context, like promptDir, so
    // editing a persona file never changes a running chat's prompt: the page
    // sends the fixed text back as `personaText`,
    // and only an unfixed chat has the files read.
    const fixedText: string | undefined = typeof body.personaText === "string" ? body.personaText : undefined;
    let personaName: string;
    let personaText: string;
    let personaNote: string | null = null;
    if (fixedText !== undefined) {
      personaName = cleanPersona(body.persona) ?? (ctx.store.defaultPersona || BUILDER_NAME);
      personaText = fixedText;
    } else {
      const { personas } = await loadPersonas();
      const chosen = await personaForChat(cleanPersona(body.persona), ctx.store.defaultPersona, personas);
      personaName = chosen.persona.name;
      personaText = personaPromptText(chosen.persona);
      personaNote = chosen.note;
    }
    sendJson(res, 200, {
      definitions: TOOLS.map((t) => t.definition),
      // The user's rules go out with or without tools; the rest only with them.
      systemPrompt: toolsSystemPrompt(
        promptDir,
        (await readRules()).text,
        offered.length > 0,
        offered.includes("inspect_page") ? sessionNote(ctx.chatId, req.headers?.host) : null,
        personaText,
        skillsPromptText((await loadSkills()).skills),
      ),
      offered,
      persona: personaName,
      // The text the prompt was built with, for the chat to fix at its first reply.
      personaText,
      update: await chatUpdate(ctx, promptDir, personaNote),
      // The working directory's only: attachments have none (see SessionSettings).
      checkCommands: ctx.workingDir && ctx.store.checkCommands[ctx.workingDir]
        ? { [ctx.workingDir]: ctx.store.checkCommands[ctx.workingDir] }
        : {},
    });
    return true;
  }

  // The working directories chosen lately, newest first, for the picker in
  // Session settings (see recentFolders.ts). One that is gone from the disk is
  // left out of the list but kept in the file until it is pushed out, in case
  // a drive comes back.
  if (parts[1] === "recent-folders" && method === "GET") {
    const folders = (await Promise.all((await readRecentFolders()).map(checkWorkingDir))).filter((f) => f !== null);
    sendJson(res, 200, { folders });
    return true;
  }
  // Remembers a folder the user just chose as a working directory.
  if (parts[1] === "recent-folders" && method === "POST") {
    const { folder } = await readJson(req);
    const real = await checkWorkingDir(folder);
    if (!real) throw new HttpError(400, "That isn't a folder that exists.");
    const folders = withFolder(await readRecentFolders(), real);
    await writeRecentFolders(folders);
    sendJson(res, 200, { folders });
    return true;
  }

  // A folder's check command: set (empty clears it), or run. It runs without
  // asking, unlike run_command: the user typed it, the model can't change it,
  // and this only runs what's saved for an attached folder.
  if (parts[1] === "check-command" && method === "PUT") {
    const { folder, command } = await readJson(req);
    const [real] = await checkAttachments([folder]);
    if (!real) throw new HttpError(400, "No such folder");
    const store = await load();
    const text = String(command ?? "").trim();
    if (text) store.checkCommands[real] = text;
    else delete store.checkCommands[real];
    await save(store);
    sendJson(res, 200, { folder: real, command: text });
    return true;
  }
  if (parts[1] === "check-command" && method === "POST") {
    const body = await readJson(req);
    const ctx = await contextFor(body);
    const folder = String(body.folder ?? "");
    const command = ctx.workingDir && folder === ctx.workingDir ? ctx.store.checkCommands[folder] : undefined;
    if (!command) throw new HttpError(404, "No check command for that folder");
    // Recorded because nothing asked: this is the one command that runs unasked.
    const started = Date.now();
    const output = await exec(command, folder, undefined, "check.run");
    const exitCode = /\[exit code (-?\d+)\]$/.exec(output)?.[1];
    audit("command.run", {
      via: "check-command",
      command,
      folder,
      exit: exitCode === undefined ? null : Number(exitCode),
      ms: Date.now() - started,
      who: whoOf(req),
    });
    sendJson(res, 200, { command, passed: output.endsWith("[exit code 0]"), output });
    return true;
  }

  if (parts[1] === "call" && method === "POST") {
    const body = await readJson(req);
    // The caller hung up before the answer was sent (Stop everything aborts
    // the request): whatever the tool started is stopped.
    const gone = new AbortController();
    // (A test's stand-in response may have no events.)
    res.on?.("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    const ctx = { ...(await contextFor(body)), signal: gone.signal };
    // The chat's persona is fixed once it starts, so the saved session names it.
    const persona = await personaForCall(ctx.chatId, ctx.store.defaultPersona);
    sendJson(res, 200, await runTool(String(body.name), body.arguments, ctx, persona));
    return true;
  }

  // The master switch: every tool off or on, each one's own setting kept.
  if (parts.length === 1 && method === "PUT") {
    const { enabled } = await readJson(req);
    const store = await load();
    store.toolsEnabled = !!enabled;
    await save(store);
    sendJson(res, 200, { enabled: store.toolsEnabled });
    return true;
  }

  if (parts.length === 2 && method === "PUT") {
    if (!TOOLS.some((t) => t.name === parts[1])) throw new HttpError(404, "No such tool");
    const { enabled } = await readJson(req);
    const store = await load();
    store.disabledTools = store.disabledTools.filter((n) => n !== parts[1]);
    if (!enabled) store.disabledTools.push(parts[1]);
    await save(store);
    sendJson(res, 200, { name: parts[1], enabled: !!enabled });
    return true;
  }

  return false;
}
