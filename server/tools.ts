// Registry of the tools the model can call in chat, grouped for Settings →
// Tools. Tools are on unless the user turned them off.

import { DISK_TOOLS, checkAttachments, workingDirOf } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
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
import { PLAN_TOOLS, planInstructions } from "./plan.ts";
import { TERMINAL_TOOLS, exec } from "./terminal.ts";
import { WEB_TOOLS } from "./web.ts";
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
    id: "plan",
    label: "Plan",
    description:
      "Before changing files, the model writes the steps as a checklist. Chat runs one step per turn and " +
      "checks each one, so a step that isn't really done shows up instead of a reply that says it is.",
    instructions: planInstructions,
  },
  {
    id: "disk",
    label: "Disk",
    description:
      "Read-only access to the files and folders attached to a chat (Chat settings, next to the message box). " +
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
    id: "terminal",
    label: "Terminal",
    description:
      "Run shell commands the model suggests, in a folder attached to a chat. You see each command and approve " +
      "it before it runs. Commands run as you, with your network access and credentials (git, gh and so on).",
    instructions:
      "You can run shell commands with run_command, for example git, gh or npm; it runs on the user's computer, " +
      "which has network access and their credentials even though you don't. The user approves each command " +
      "before it runs. Run one command at a time, explain what it's for, and never run anything destructive " +
      "(rm -rf, force pushes, resets) unless the user asked for it.",
  },
  {
    id: "web",
    label: "Web",
    description:
      "Search the web through DuckDuckGo, and open web pages. Search queries go to DuckDuckGo; pages are fetched " +
      "from this machine, so they can include ones on your network.",
    instructions:
      "You can search the web with web_search and read a page with fetch_url. Use them for current events, recent " +
      "releases and facts you aren't sure of, and always when the user asks you to search; don't answer those " +
      "from memory. Search first, then open the most relevant results to read them. Cite the URLs you used.",
  },
];

const TOOLS: ToolSpec[] = [...PLAN_TOOLS, ...DISK_TOOLS, ...WRITE_TOOLS, ...TERMINAL_TOOLS, ...WEB_TOOLS, ...FETCH_TOOLS];

const isOffered = (ctx: ToolContext, t: ToolSpec) => !ctx.store.disabledTools.includes(t.name);

// The system prompt: what holds for the whole session. It never changes in a
// session, since it's the start of every request and a change made llama.cpp
// reprocess the whole chat (about a minute for 40k tokens). The tool list, also
// at the start, lists every tool for the same reason; one that's off is refused
// when it's called (runTool). See README, "What the model is told".
//
// Everything but the last line is the same in every session, so a new one
// reuses another's cached start (the tool list comes first, then this). Only
// the working directory differs, so it must stay last: anything per-session
// earlier would make each new session reprocess the rest.
function toolsSystemPrompt(promptDir: string | null): string {
  return [
    "You have tools. Use one when it helps answer the question; otherwise answer directly.",
    ...GROUPS.map((g) => g.instructions),
    promptDir ? `Working directory: ${promptDir}` : "There's no working directory: use absolute paths.",
  ].join("\n\n");
}

// A chat update: what changed in the session since its system prompt, which
// chat sends after the user's next message when it differs from the last one
// (see `update` on ChatMessage). The working directory, if it's not the one
// the system prompt names; the other attachments; and tools that are off.
async function chatUpdate(ctx: ToolContext, promptDir: string | null): Promise<string> {
  const dir = await workingDirOf(ctx.attachments);
  const others = ctx.attachments.filter((a) => a !== dir);
  const off = TOOLS.filter((t) => !isOffered(ctx, t)).map((t) => t.name);
  return [
    "Chat update:",
    ...(dir !== promptDir ? [dir ? `The working directory is now ${dir}.` : "There's no working directory now."] : []),
    others.length ? `Also attached:\n${others.map((d) => `- ${d}`).join("\n")}` : "Nothing else is attached.",
    ...(off.length ? [`Turned off in Settings, so calls to them fail: ${off.join(", ")}.`] : []),
  ].join("\n");
}

const contextFor = async (body: any): Promise<ToolContext> => ({
  store: await load(),
  chatId: String(body.chatId ?? ""),
  attachments: await checkAttachments(body.attachments),
  // Re-serialized here so the comparison in requireApproval doesn't depend on
  // how the client formatted its JSON.
  approved: body.approved && typeof body.approved === "object" ? JSON.stringify(body.approved) : null,
});

// Text for the model (errors included), a path the user must allow before
// the call can run, or something the user must approve first.
type Outcome =
  | { result: string }
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"] } }
  | { needsApproval: Approval };

async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<Outcome> {
  const text = (result: string) => ({ result });
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`Error: there is no tool named ${name}`);
  if (!isOffered(ctx, tool)) return text(`Error: the ${name} tool is turned off in Settings`);
  let args: any;
  try {
    args = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
  } catch {
    return text("Error: the tool arguments were not valid JSON");
  }
  try {
    return text(await tool.run(ctx, args));
  } catch (e: any) {
    if (e instanceof AccessNeeded) return { needsAccess: e.target };
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

  // For chat: what to send the model given this chat's attachments.
  if (parts[1] === "context" && method === "POST") {
    const body = await readJson(req);
    const ctx = await contextFor(body);
    // The working directory the session's system prompt names: fixed at its
    // first message (see promptDir in Chat.tsx), so it can differ from now's.
    const promptDir = typeof body.promptDir === "string" ? body.promptDir : null;
    sendJson(res, 200, {
      definitions: TOOLS.map((t) => t.definition),
      systemPrompt: toolsSystemPrompt(promptDir),
      offered: TOOLS.filter((t) => isOffered(ctx, t)).map((t) => t.name),
      update: await chatUpdate(ctx, promptDir),
      checkCommands: Object.fromEntries(
        ctx.attachments.filter((a) => ctx.store.checkCommands[a]).map((a) => [a, ctx.store.checkCommands[a]]),
      ),
    });
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
    const command = ctx.attachments.includes(folder) ? ctx.store.checkCommands[folder] : undefined;
    if (!command) throw new HttpError(404, "No check command for that folder");
    const output = await exec(command, folder);
    sendJson(res, 200, { command, passed: output.endsWith("[exit code 0]"), output });
    return true;
  }

  if (parts[1] === "call" && method === "POST") {
    const body = await readJson(req);
    sendJson(res, 200, await runTool(String(body.name), body.arguments, await contextFor(body)));
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
