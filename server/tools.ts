// Registry of the tools the model can call in chat, grouped for Settings →
// Tools. Tools are on unless the user turned them off; a group can also be
// unavailable until it's set up (disk tools need at least one folder).

import { DISK_TOOLS } from "./disk.ts";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { type Store, load, save } from "./store.ts";
import { ToolError, type ToolSpec } from "./toolkit.ts";
import { WEB_TOOLS } from "./web.ts";

interface Group {
  id: string;
  label: string;
  description: string;
  // Why the group's tools can't be offered yet, or null when they can.
  unavailable: (store: Store) => string | null;
  // What the model should know to use this group's tools well. Added to the
  // system prompt while any of them are offered.
  instructions: (store: Store) => string;
}

const GROUPS: Group[] = [
  {
    id: "disk",
    label: "Disk",
    description: "Read-only access to folders you choose on this Mac. Nothing here can change, delete or run files.",
    unavailable: (s) => (s.directories.length ? null : "Add a folder to use these tools."),
    instructions: (s) =>
      `You can read files on the user's computer, limited to these folders:\n` +
      s.directories.map((d) => `- ${d}`).join("\n") +
      `\nUse absolute paths, and mention which files you looked at.`,
  },
  {
    id: "web",
    label: "Web",
    description:
      "Search the web through DuckDuckGo. The model's search queries leave this machine and go to DuckDuckGo.",
    unavailable: () => null,
    instructions: () =>
      "You can search the web with web_search. Use it for current events, recent releases and facts you aren't " +
      "sure of, and always when the user asks you to search; don't answer those from memory. Cite the URLs you used.",
  },
];

// The system prompt for the tools offered right now, or null if none are.
function toolsSystemPrompt(store: Store): string | null {
  const groups = GROUPS.filter((g) => TOOLS.some((t) => t.group === g.id && isOffered(store, t)));
  if (groups.length === 0) return null;
  return [
    "You have tools. Use one when it helps answer the question; otherwise answer directly.",
    ...groups.map((g) => g.instructions(store)),
  ].join("\n\n");
}

const TOOLS: ToolSpec[] = [...DISK_TOOLS, ...WEB_TOOLS];

const isOffered = (store: Store, t: ToolSpec) =>
  !store.disabledTools.includes(t.name) && !GROUPS.find((g) => g.id === t.group)!.unavailable(store);

// Runs one tool call. Always returns text for the model, including errors.
async function runTool(name: string, rawArgs: unknown): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Error: there is no tool named ${name}`;
  const store = await load();
  if (!isOffered(store, tool)) return `Error: the ${name} tool is turned off`;
  let args: any;
  try {
    args = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
  } catch {
    return "Error: the tool arguments were not valid JSON";
  }
  try {
    return await tool.run(store, args);
  } catch (e: any) {
    if (e instanceof ToolError) return `Error: ${e.message}`;
    if (e.code === "EACCES" || e.code === "EPERM") return "Error: permission denied";
    throw e;
  }
}

// Handles /api/tools/*; returns false for anything else.
export async function toolRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "tools") return false;

  // Everything Settings and chat need: groups with each tool's state, plus
  // the definitions chat should send to the model right now.
  if (parts.length === 1 && method === "GET") {
    const store = await load();
    sendJson(res, 200, {
      groups: GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        description: g.description,
        unavailable: g.unavailable(store),
        tools: TOOLS.filter((t) => t.group === g.id).map((t) => ({
          name: t.name,
          label: t.label,
          summary: t.summary,
          enabled: !store.disabledTools.includes(t.name),
        })),
      })),
      directories: store.directories,
      definitions: TOOLS.filter((t) => isOffered(store, t)).map((t) => t.definition),
      systemPrompt: toolsSystemPrompt(store),
    });
    return true;
  }

  if (parts[1] === "call" && method === "POST") {
    const body = await readJson(req);
    sendJson(res, 200, { result: await runTool(String(body.name), body.arguments) });
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
