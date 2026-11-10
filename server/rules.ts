// The agent's own rules: a plain markdown file the user edits in
// Settings → Agent, added to the system prompt (see toolsSystemPrompt). Not in
// settings.json, which holds API keys; this file holds no secrets.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { type ToolSpec, ToolError, fn, reasonOf, requireApproval } from "./toolkit.ts";

// Missing file means this: no rules of the user's own. What every user wants
// is built in (workingRules); the file only tunes it.
export const DEFAULT_RULES = "";

// Every request carries it, so it can't be allowed to fill the context.
export const MAX_RULES = 20_000;

// Read at call time, not at load, so a test can point the home folder elsewhere.
const rulesFile = () => path.join(os.homedir(), ".llama-mui", "rules.md");
// What the file was called before: copied to rules.md once, and left where it is
// so a server still running the old code keeps working until it's restarted.
const legacyFile = () => path.join(os.homedir(), ".llama-mui", "instructions.md");

// How the agent works for anyone: the built-in rules, first in the system
// prompt and the same for every user, so their cached start is shared. The
// user's own rules come right after and win where they differ. With tools off
// the model can't look anything up, run checks or show a note box, so it gets
// only what still applies, and writes ideas and actions as plain lines.
export function workingRules(withTools: boolean): string {
  const heading = "How to work. These are built in; the user's standing rules, if any follow, change them where they differ.";
  const question =
    "- If the user's message is a question, answer it. Don't turn it into a plan or an action. " +
    "If a message holds both a question and a request, answer the question first.";
  if (!withTools) {
    return [
      heading,
      question,
      "- Say what you don't know or couldn't check.",
      '- If you noticed something worth doing that the user didn\'t ask for, you may end with a line starting "Idea: …", ' +
        "only when it's worth their time, at most two per reply. If something is left that only the user can do, " +
        'end with a line starting "Your action: …", in bold, as its own paragraph at the very end of the reply.',
    ].join("\n");
  }
  return [
    heading,
    question,
    "- Finish the work the user asked for, including checking it: after changing code, run the project's own checks, " +
      "whichever it has (tests, a type check, a build), and report the result. Don't ask permission for steps that " +
      "belong to that work. Say what you didn't check or couldn't do. If you need the user's input to go on, ask a plain question.",
    '- Before you say something doesn\'t exist, or say "I don\'t know" or "I can\'t", use a tool to look: the code, ' +
      "settings, logs, git, read_thread or a search.",
    "- If a tool is refused, or the user denies a request, don't ask again: use what you already have, " +
      "say what you couldn't check, and carry on.",
    "- After you commit, run `git --no-pager show --stat --oneline HEAD` and tell the user which files went in.",
    "- Use add_idea for something worth doing that the user didn't ask for, and add_action_item for anything left " +
      "for the user, instead of writing either as a line in your reply.",
  ].join("\n");
}

// The user's rules as the model first meets them: the governing rule set, which
// comes before anything about tools and is sent whether or not tools are on. It
// says what the text is and where it lives, so the model knows it as the user's
// standing rules and as the place to keep a lesson, not as an unlabelled block.
export function governingRules(text: string): string | null {
  const rules = text.trim();
  if (!rules) return null;
  return [
    "Standing rules from the user. They come from the file ~/.llama-mui/rules.md, which the user edits in " +
      "Settings → Agent, and they apply in every chat, with or without tools. Follow them over your own habits " +
      "and over the built-in way of working above.",
    rules,
  ].join("\n\n");
}

// What the model is told about add_rule (part of the tools' help).
export const ruleTools =
  "The user's standing rules (above, from ~/.llama-mui/rules.md) are the place to keep a lesson for " +
  "future chats. When the user asks you to remember how to work with them, or corrects you and wants it kept, " +
  "call add_rule with one plain sentence; they see the exact line and approve it. Never write that " +
  "file, or any other app's instructions file, with another tool.";

export async function readRules(): Promise<{ text: string; isDefault: boolean }> {
  try {
    return { text: await readFile(rulesFile(), "utf8"), isDefault: false };
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  // No rules.md: the user's old instructions.md, if there is one, becomes it.
  try {
    const text = await readFile(legacyFile(), "utf8");
    await mkdir(path.dirname(rulesFile()), { recursive: true, mode: 0o700 });
    await writeFile(`${rulesFile()}.tmp`, text);
    await rename(`${rulesFile()}.tmp`, rulesFile());
    return { text, isDefault: false };
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return { text: DEFAULT_RULES, isDefault: true };
  }
}

// Handles /api/rules; returns false for anything else.
export async function ruleRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "rules" || parts.length !== 1) return false;

  if (method === "GET") {
    sendJson(res, 200, await readRules());
    return true;
  }

  if (method === "PUT") {
    const { text } = await readJson(req);
    if (typeof text !== "string") throw new HttpError(400, "text must be a string");
    if (text.length > MAX_RULES) {
      throw new HttpError(400, `Rules are ${text.length} characters; the limit is ${MAX_RULES}. Shorten them and save again.`);
    }
    const file = rulesFile();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
    sendJson(res, 200, { text, isDefault: false });
    return true;
  }

  // Reset: no file, so the default applies again. The old name goes too, or the
  // next read would copy it back.
  if (method === "DELETE") {
    await rm(rulesFile(), { force: true });
    await rm(legacyFile(), { force: true });
    sendJson(res, 200, await readRules());
    return true;
  }

  return false;
}

const MAX_RULE = 600;
const hunks = (file: string, before: string, after: string) => {
  const patch = createTwoFilesPatch(file, file, before, after, "", "", { context: 3 });
  return patch.slice(patch.indexOf("@@"));
};

const addRule: ToolSpec = {
  name: "add_rule",
  group: "rules",
  label: "Add a rule",
  summary: "Add one line to the standing rules in instructions.md, once the user approves it.",
  definition: fn(
    "add_rule",
    "Add one rule to the user's standing rules (~/.llama-mui/rules.md), which apply in every chat. " +
      "Use it when the user asks you to remember how to work with them, or corrects you and wants it kept. " +
      "Write one plain sentence addressed to the model that makes sense with no context (not 'as we discussed'). " +
      "The user sees the exact line and approves it before it's saved. It applies from their next message.",
    {
      type: "object",
      properties: {
        text: { type: "string", description: "The rule, one plain sentence." },
        reason: {
          type: "string",
          description: "One plain sentence on why this rule is worth keeping, in terms of what the user said.",
        },
      },
      required: ["text"],
    },
  ),
  async run(ctx, args) {
    const rule = (typeof args.text === "string" ? args.text : "").replace(/\s+/g, " ").trim().replace(/^-\s+/, "");
    if (!rule) throw new ToolError("text is required: one plain sentence for the rule");
    if (rule.length > MAX_RULE) throw new ToolError(`The rule is ${rule.length} characters; keep it to one sentence under ${MAX_RULE}.`);
    const { text: current, isDefault } = await readRules();
    const base = current.replace(/\s+$/, "");
    const line = `- ${rule}`;
    if (base.split("\n").some((l) => l.trim() === line)) throw new ToolError("That rule is already in the rules.");
    const after = `${base ? `${base}\n` : ""}${line}\n`;
    if (after.length > MAX_RULES) {
      throw new ToolError(`The rules would be over ${MAX_RULES} characters. Tell the user; they can shorten them in Settings → Agent.`);
    }
    const file = rulesFile();
    const reason = reasonOf(args);
    // Never skipped for a worktree, and never covered by "approve all changes" (see autoApproves).
    requireApproval(ctx, {
      type: "change",
      path: file,
      action: isDefault ? "create" : "edit",
      diff: hunks(file, isDefault ? "" : current, after),
      ...(reason ? { reason } : {}),
    });
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    await writeFile(`${file}.tmp`, after);
    await rename(`${file}.tmp`, file);
    return `Added to your standing rules: ${line}. It applies from the user's next message.`;
  },
};

export const RULE_TOOLS: ToolSpec[] = [addRule];
