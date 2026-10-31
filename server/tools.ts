// Registry of the tools the model can call in chat, grouped for Settings →
// Tools. Tools are on unless the user turned them off.

import { DISK_TOOLS, checkAttachments } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { load, save } from "./store.ts";
import {
  AccessNeeded,
  ApprovalNeeded,
  type AttachmentTarget,
  type Approval,
  type ToolContext,
  ToolError,
  type ToolSpec,
} from "./toolkit.ts";
import { FETCH_TOOLS } from "./fetch.ts";
import { TERMINAL_TOOLS } from "./terminal.ts";
import { WEB_TOOLS } from "./web.ts";
import { WRITE_TOOLS } from "./write.ts";

interface Group {
  id: string;
  label: string;
  description: string;
  // What the model should know to use this group's tools well. Added to the
  // system prompt while any of them are offered.
  instructions: (ctx: ToolContext) => string;
}

const GROUPS: Group[] = [
  {
    id: "disk",
    label: "Disk",
    description:
      "Read-only access to the files and folders attached to a chat (Chat settings, next to the message box). " +
      "When the model asks for anything else, you're asked to allow it first. Nothing here can change, delete or run files.",
    instructions: (ctx) =>
      (ctx.attachments.length
        ? `The user attached these files and folders to this chat:\n${ctx.attachments.map((d) => `- ${d}`).join("\n")}\n`
        : "Nothing is attached to this chat yet.\n") +
      `If the user asks about ${ctx.attachments.length ? "other " : ""}files or folders on this computer, call the ` +
      "disk tools with their absolute path: the user is asked to allow it. Mention which files you looked at.",
  },
  {
    id: "write",
    label: "Write",
    description:
      "Create and change files in what's attached to a chat. Each change shows as a diff, and nothing is " +
      "written until you approve it. Files can't be deleted or run.",
    instructions: () =>
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
    instructions: () =>
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
    instructions: () =>
      "You can search the web with web_search and read a page with fetch_url. Use them for current events, recent " +
      "releases and facts you aren't sure of, and always when the user asks you to search; don't answer those " +
      "from memory. Search first, then open the most relevant results to read them. Cite the URLs you used.",
  },
];

const TOOLS: ToolSpec[] = [...DISK_TOOLS, ...WRITE_TOOLS, ...TERMINAL_TOOLS, ...WEB_TOOLS, ...FETCH_TOOLS];

const isOffered = (ctx: ToolContext, t: ToolSpec) => !ctx.store.disabledTools.includes(t.name);

// The system prompt for the tools offered in this chat, or null if none are.
function toolsSystemPrompt(ctx: ToolContext): string | null {
  const groups = GROUPS.filter((g) => TOOLS.some((t) => t.group === g.id && isOffered(ctx, t)));
  if (groups.length === 0) return null;
  return [
    "You have tools. Use one when it helps answer the question; otherwise answer directly.",
    ...groups.map((g) => g.instructions(ctx)),
  ].join("\n\n");
}

const contextFor = async (body: any): Promise<ToolContext> => ({
  store: await load(),
  attachments: await checkAttachments(body.attachments),
  // Re-serialized here so the comparison in requireApproval doesn't depend on
  // how the client formatted its JSON.
  approved: body.approved && typeof body.approved === "object" ? JSON.stringify(body.approved) : null,
});

// Text for the model (errors included), a path the user must allow before
// the call can run, or something the user must approve first.
type Outcome = { result: string } | { needsAccess: AttachmentTarget } | { needsApproval: Approval };

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
    const ctx = await contextFor(await readJson(req));
    sendJson(res, 200, {
      definitions: TOOLS.filter((t) => isOffered(ctx, t)).map((t) => t.definition),
      systemPrompt: toolsSystemPrompt(ctx),
    });
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
