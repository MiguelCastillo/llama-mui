// Tools that create and change files inside what's attached to the chat.
// Nothing is written until the user approves the exact change: the first call
// throws ApprovalNeeded with a diff, and chat runs the call again once the
// user allows it. If the file changed in between, the diff no longer matches
// and the user is asked again.

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { isInside, isSettingsFile, looksBinary, needAccess, toAbsolute } from "./disk.ts";
import { type Approval, type ToolContext, ToolError, type ToolSpec, fn, requireApproval } from "./toolkit.ts";

const MAX_WRITE_BYTES = 1024 * 1024;

// Where a write lands, with symlinks resolved. The file may not exist yet;
// then its nearest existing folder is resolved, so a symlink can't lead the
// new file outside what's attached.
async function resolveWritable(roots: string[], raw: unknown): Promise<string> {
  const { given, abs } = await toAbsolute(roots, raw);
  const missing: string[] = [];
  let existing = abs;
  let real: string;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch (e: any) {
      if (e.code === "ENOTDIR") throw new ToolError(`part of ${given} is a file, not a folder`);
      if (e.code !== "ENOENT") throw e;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const isDir = (await stat(real)).isDirectory();
  if (!missing.length && isDir) throw new ToolError(`${given} is a folder`);
  if (missing.length && !isDir) throw new ToolError(`${real} is a file, not a folder`);
  const target = path.join(real, ...missing);
  if (isSettingsFile(target)) throw new ToolError(`${given} holds this app's API keys and can't be written`);
  if (!roots.some((r) => isInside(target, r))) await needAccess(missing.length ? real : target);
  return target;
}

// The file's text, or null if it doesn't exist yet.
async function readText(file: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (looksBinary(buf)) throw new ToolError(`${file} is a binary file and can't be changed`);
  return buf.toString("utf8");
}

const hunks = (file: string, before: string, after: string) => {
  const patch = createTwoFilesPatch(file, file, before, after, "", "", { context: 3 });
  return patch.slice(patch.indexOf("@@"));
};

const countLines = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

// Writes `after` once the user has approved exactly this change.
type ChangeAction = Extract<Approval, { type: "change" }>["action"];

async function commit(ctx: ToolContext, file: string, before: string | null, after: string, action: ChangeAction) {
  if (Buffer.byteLength(after) > MAX_WRITE_BYTES) throw new ToolError("the new content is over 1 MB");
  if (before === after) throw new ToolError(`${file} already has that content; nothing to change`);
  requireApproval(ctx, { type: "change", path: file, action, diff: hunks(file, before ?? "", after) });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, after);
}

const writeTextFile: ToolSpec = {
  name: "write_file",
  group: "write",
  label: "Write files",
  summary: "Create a file, or replace everything in one.",
  definition: fn(
    "write_file",
    "Create a text file, or replace all of an existing file's content. Missing folders are created. " +
      "The user sees the change and approves it before it's written. To change part of a file, use edit_file.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        content: { type: "string", description: "The complete new content of the file." },
      },
      required: ["path", "content"],
    },
  ),
  async run(ctx, args) {
    if (typeof args.content !== "string") throw new ToolError("content is required");
    const file = await resolveWritable(ctx.attachments, args.path);
    const before = await readText(file);
    await commit(ctx, file, before, args.content, before === null ? "create" : "overwrite");
    const lines = countLines(args.content);
    return `${before === null ? "Created" : "Replaced"} ${file} (${lines} line${lines === 1 ? "" : "s"})`;
  },
};

const editTextFile: ToolSpec = {
  name: "edit_file",
  group: "write",
  label: "Edit files",
  summary: "Replace exact text in a file, for changes to part of it.",
  definition: fn(
    "edit_file",
    "Replace text in an existing file. old_text must match the file exactly, including spaces and line breaks, " +
      "and appear only once unless replace_all is true; include nearby lines to make it unique. " +
      "The user sees the change and approves it before it's written.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        old_text: { type: "string", description: "The exact text to replace." },
        new_text: { type: "string", description: "The text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
      },
      required: ["path", "old_text", "new_text"],
    },
  ),
  async run(ctx, args) {
    const oldText = String(args.old_text ?? "");
    if (!oldText) throw new ToolError("old_text is required");
    const file = await resolveWritable(ctx.attachments, args.path);
    const before = await readText(file);
    if (before === null) throw new ToolError(`${file} does not exist; use write_file to create it`);
    const count = before.split(oldText).length - 1;
    if (count === 0) throw new ToolError(`old_text isn't in ${file}; read the file again and copy the text exactly`);
    if (count > 1 && !args.replace_all) {
      throw new ToolError(`old_text appears ${count} times in ${file}; include more lines around it, or set replace_all`);
    }
    const newText = String(args.new_text ?? "");
    // A replacer function, so "$&" and the like in new_text stay literal.
    const after = args.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
    await commit(ctx, file, before, after, "edit");
    const n = args.replace_all ? count : 1;
    return `Edited ${file}: replaced ${n} occurrence${n === 1 ? "" : "s"}`;
  },
};

export const WRITE_TOOLS = [writeTextFile, editTextFile];
