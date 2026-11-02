// Read-only disk tools, limited to the files and folders attached to the chat
// the call came from, plus the route chat uses to check an attachment.
//
// Every path the model sends goes through resolveAllowed(), which checks it
// against the attachments after resolving symlinks and "../", so neither can
// reach outside. A path outside isn't refused outright: it throws
// AccessNeeded, and chat asks the user whether to attach it, or, if nothing
// is there, to point to the right file or folder. Walks for
// find_files and grep skip symlinks, so they never leave what's attached.

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { markRead } from "./reads.ts";
import { SETTINGS_FILE } from "./store.ts";
import { AccessNeeded, type AttachmentTarget, LocateNeeded, ToolError, type ToolSpec, fn } from "./toolkit.ts";

const MAX_LIST_ENTRIES = 300;
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_READ_LINES = 400;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_RESULTS = 50;
const MAX_WALK_FILES = 5000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
// Long lines (minified code) are cut before matching so one bad regex can't
// stall the server on them.
const MAX_GREP_LINE_CHARS = 1000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

export const sessionsDir = path.join(os.homedir(), ".llama-mui", "sessions");

export const isInside = (child: string, root: string) =>
  child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The one place the model may work with no access prompt and no change
// approval: a worktree, ~/.llama-mui/sessions/<id>/worktrees/. The rest of a
// session's folder (its chat file and plans), ~/.llama-mui and everything else
// stay behind the normal prompts, so the model can't rewrite its own history.
//
// `real` is a path with symlinks already resolved (by resolveAllowed or
// resolveWritable), so a link in a worktree that points at the chat file
// resolves outside and doesn't count. The sessions folder is also checked by
// its real path, in case ~/.llama-mui is itself reached by a link.
export async function inSessionWorktrees(real: string): Promise<boolean> {
  for (const root of [sessionsDir, await realpath(sessionsDir).catch(() => sessionsDir)]) {
    if (!isInside(real, root)) continue;
    const [id, folder] = path.relative(root, real).split(path.sep);
    if (id && folder === "worktrees") return true;
  }
  return false;
}

// settings.json holds API keys, so no tool may read it even inside an attached folder.
export const isSettingsFile = (p: string) => p.startsWith(SETTINGS_FILE);

// The path the model sent, made absolute: ~ expanded, "../" resolved.
// The chat's working directory: its first attachment, if that's a folder.
// Chat sends it first (see attachedPaths in Chat.tsx). Relative paths and
// run_command use it, and the system prompt names it (see tools.ts).
export async function workingDirOf(roots: string[]): Promise<string | null> {
  return roots.length && (await stat(roots[0]).catch(() => null))?.isDirectory() ? roots[0] : null;
}

export async function toAbsolute(roots: string[], raw: unknown): Promise<{ given: string; abs: string }> {
  const given = expandHome(String(raw ?? "").trim());
  if (!given) throw new ToolError("path is required");
  if (path.isAbsolute(given)) return { given, abs: path.resolve(given) };
  const dir = await workingDirOf(roots);
  if (dir) return { given, abs: path.resolve(dir, given) };
  throw new ToolError(roots.length ? `Use an absolute path inside one of: ${roots.join(", ")}` : "Use an absolute path");
}

// Throws AccessNeeded for the attachment that would cover `real`.
export async function needAccess(real: string): Promise<never> {
  const target = await resolveAttachment(real).catch((e) => {
    throw new ToolError(e.message);
  });
  throw new AccessNeeded(target);
}

export async function resolveAllowed(roots: string[], raw: unknown): Promise<string> {
  const { given, abs } = await toAbsolute(roots, raw);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e: any) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    // Outside the attachments, a missing path is usually a guess; the user
    // may know where the real one is.
    if (!roots.some((r) => isInside(abs, r)) && !(await inSessionWorktrees(abs))) throw new AccessNeeded({ path: abs, kind: null });
    throw new ToolError(`${given} does not exist`);
  }
  if (isSettingsFile(real)) throw new ToolError(`${given} holds this app's API keys and can't be read`);
  if (!roots.some((r) => isInside(real, r)) && !(await inSessionWorktrees(real))) await needAccess(real);
  return real;
}

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

const clip = (s: string) =>
  s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… (output cut at ${MAX_OUTPUT_CHARS} characters)` : s;

// Directories first, then by name, so listings are stable.
const byTypeThenName = (a: Dirent, b: Dirent) =>
  Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name);

// "*.md" style globs; text without wildcards matches as a substring.
function namePattern(raw: string): RegExp {
  if (!/[*?]/.test(raw)) return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const body = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

interface WalkResult {
  files: AsyncGenerator<{ full: string; entry: Dirent }>;
  // Read after iterating: true if the walk stopped at MAX_WALK_FILES.
  capped: () => boolean;
}

// Breadth-first, so shallow files come first. Yields files and directories.
// A start that is a file (an attached file, or grep on one file) is yielded
// as-is instead of walked.
function walk(starts: string[]): WalkResult {
  let visited = 0;
  async function* files() {
    const queue: string[] = [];
    for (const start of starts) {
      if (!(await stat(start).catch(() => null))?.isFile()) queue.push(start);
      else if (!isSettingsFile(start) && ++visited <= MAX_WALK_FILES) {
        yield { full: start, entry: { name: path.basename(start), isFile: () => true, isDirectory: () => false } as Dirent };
      }
    }
    while (queue.length) {
      const dir = queue.shift()!;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort(byTypeThenName)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(full);
        } else if (!entry.isFile() || isSettingsFile(full)) {
          continue;
        } else if (++visited > MAX_WALK_FILES) {
          return;
        }
        yield { full, entry };
      }
    }
  }
  return { files: files(), capped: () => visited > MAX_WALK_FILES };
}

function summarize(results: string[], capped: boolean, none: string): string {
  if (results.length === 0) return capped ? `${none} in the first ${MAX_WALK_FILES} files; narrow the path.` : `${none}.`;
  const note =
    results.length >= MAX_RESULTS
      ? `\n… stopped at ${MAX_RESULTS} results; narrow the pattern or path`
      : capped
        ? `\n… stopped after ${MAX_WALK_FILES} files; narrow the path`
        : "";
  return clip(`${results.join("\n")}${note}`);
}

async function startsFor(roots: string[], raw: unknown): Promise<string[]> {
  if (raw) return [await resolveAllowed(roots, raw)];
  if (roots.length === 0) throw new ToolError("Nothing is attached to this chat yet; pass an absolute path");
  return [...roots];
}

const listDirectory: ToolSpec = {
  name: "list_directory",
  group: "disk",
  label: "List folders",
  summary: "See which files and folders a folder contains, with sizes.",
  definition: fn(
    "list_directory",
    "List the files and folders in a directory. Call it with no path to see what's attached to this chat.",
    { type: "object", properties: { path: { type: "string", description: "Path of the directory, absolute or relative to the working directory." } } },
  ),
  async run({ attachments: roots }, args) {
    if (!args.path) {
      const lines = await Promise.all(
        roots.map(async (r) => ((await stat(r).catch(() => null))?.isDirectory() ? `${r}/` : r)),
      );
      return roots.length ? `Attached to this chat:\n${lines.join("\n")}` : "Nothing is attached to this chat.";
    }
    const dir = await resolveAllowed(roots, args.path);
    if (!(await stat(dir)).isDirectory()) throw new ToolError(`${dir} is a file; use read_file`);
    const entries = (await readdir(dir, { withFileTypes: true })).sort(byTypeThenName);
    const lines = await Promise.all(
      entries.slice(0, MAX_LIST_ENTRIES).map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        if (e.isSymbolicLink()) return `${e.name} (link)`;
        const s = await stat(path.join(dir, e.name)).catch(() => null);
        return s ? `${e.name}  ${formatSize(s.size)}` : e.name;
      }),
    );
    const more = entries.length > MAX_LIST_ENTRIES ? `\n… and ${entries.length - MAX_LIST_ENTRIES} more` : "";
    return `${dir} (${entries.length} entries)\n${lines.join("\n")}${more}`;
  },
};

const readTextFile: ToolSpec = {
  name: "read_file",
  group: "disk",
  label: "Read files",
  summary: `Read text files, ${DEFAULT_READ_LINES} lines at a time. Binary files and files over ${formatSize(MAX_READ_FILE_BYTES)} are refused.`,
  definition: fn(
    "read_file",
    `Read a text file. Returns up to ${DEFAULT_READ_LINES} lines at a time; use start_line to read further.`,
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file, absolute or relative to the working directory." },
        start_line: { type: "integer", description: "First line to return, starting at 1." },
        max_lines: { type: "integer", description: `How many lines to return (default ${DEFAULT_READ_LINES}).` },
      },
      required: ["path"],
    },
  ),
  async run({ attachments, chatId }, args) {
    const file = await resolveAllowed(attachments, args.path);
    const s = await stat(file);
    if (s.isDirectory()) throw new ToolError(`${file} is a directory; use list_directory`);
    if (s.size > MAX_READ_FILE_BYTES) throw new ToolError(`${file} is ${formatSize(s.size)}, too large to read`);
    const buf = await readFile(file);
    if (looksBinary(buf)) throw new ToolError(`${file} is a binary file (${formatSize(s.size)})`);

    const text = buf.toString("utf8");
    markRead(chatId, file, text);
    const lines = text.split("\n");
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    const count = Math.max(1, Math.floor(Number(args.max_lines) || DEFAULT_READ_LINES));
    const end = Math.min(lines.length, start + count - 1);
    if (start > lines.length) throw new ToolError(`${file} has only ${lines.length} lines`);
    const rest = end < lines.length ? `\n… (${lines.length - end} more lines; continue with start_line=${end + 1})` : "";
    return clip(`${file} (lines ${start}-${end} of ${lines.length})\n${lines.slice(start - 1, end).join("\n")}${rest}`);
  },
};

const findFiles: ToolSpec = {
  name: "find_files",
  group: "disk",
  label: "Find files",
  summary: "Find files and folders by name, like *.md or lisbon*.",
  definition: fn(
    "find_files",
    "Find files and folders whose name matches a pattern. Use * and ? as wildcards (\"*.md\"); text without wildcards matches anywhere in the name. Case-insensitive. Skips .git and node_modules.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Name pattern, e.g. \"*.md\" or \"invoice\"." },
        path: { type: "string", description: "Directory to search in. Defaults to everything attached." },
      },
      required: ["pattern"],
    },
  ),
  async run({ attachments }, args) {
    const raw = String(args.pattern ?? "").trim();
    if (!raw) throw new ToolError("pattern is required");
    const re = namePattern(raw);
    const w = walk(await startsFor(attachments, args.path));
    const results: string[] = [];
    for await (const { full, entry } of w.files) {
      if (re.test(entry.name)) results.push(entry.isDirectory() ? `${full}/` : full);
      if (results.length >= MAX_RESULTS) break;
    }
    return summarize(results, w.capped(), `No names match "${raw}"`);
  },
};

const grep: ToolSpec = {
  name: "grep",
  group: "disk",
  label: "Grep",
  summary: "Search inside files with a regular expression, optionally only in files like *.ts.",
  definition: fn(
    "grep",
    "Search file contents for a regular expression (JavaScript syntax) and return matching lines as path:line: text. Skips binary files, files over 1 MB, .git and node_modules.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression, e.g. \"TODO|FIXME\" or \"function \\\\w+Chat\"." },
        path: { type: "string", description: "File or directory to search. Defaults to everything attached." },
        include: { type: "string", description: "Only search files whose name matches this, e.g. \"*.ts\"." },
        ignore_case: { type: "boolean", description: "Match regardless of case. Default false." },
      },
      required: ["pattern"],
    },
  ),
  async run({ attachments }, args) {
    const raw = String(args.pattern ?? "");
    if (!raw) throw new ToolError("pattern is required");
    let re: RegExp;
    try {
      re = new RegExp(raw, args.ignore_case ? "i" : "");
    } catch (e: any) {
      throw new ToolError(e.message);
    }
    const include = args.include ? namePattern(String(args.include)) : null;

    const w = walk(await startsFor(attachments, args.path));
    const results: string[] = [];
    for await (const { full, entry } of w.files) {
      if (!entry.isFile() || (include && !include.test(entry.name))) continue;
      const s = await stat(full).catch(() => null);
      if (!s || s.size > MAX_GREP_FILE_BYTES) continue;
      const buf = await readFile(full).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
        const line = lines[i].slice(0, MAX_GREP_LINE_CHARS);
        if (re.test(line)) results.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`);
      }
      if (results.length >= MAX_RESULTS) break;
    }
    return summarize(results, w.capped(), `No lines match /${raw}/`);
  },
};

const locatePath: ToolSpec = {
  name: "locate_path",
  group: "disk",
  label: "Ask where things are",
  summary: "Ask you to pick a file or folder the model only knows by name, like \"the llama-mui project\".",
  definition: fn(
    "locate_path",
    "Ask the user to pick a file or folder they mentioned without its full path, like \"my notes\" or \"the " +
      "llama-mui project\". They choose it in a file dialog, it's attached to the chat, and you get its path. " +
      "Use this instead of guessing paths.",
    {
      type: "object",
      properties: {
        description: { type: "string", description: "What to find, in the user's words, e.g. \"the llama-mui project\"." },
        kind: { type: "string", enum: ["file", "folder"], description: "Whether it's a file or a folder." },
      },
      required: ["description", "kind"],
    },
  ),
  async run(_ctx, args) {
    const description = String(args.description ?? "").trim();
    if (!description) throw new ToolError("description is required");
    throw new LocateNeeded({ description, kind: args.kind === "file" ? "file" : "folder" });
  },
};

export const DISK_TOOLS = [listDirectory, readTextFile, findFiles, grep, locatePath];

// Resolves a path the user wants to attach: ~ expanded, symlinks followed.
// Throws a message meant for the user if it can't be attached.
async function resolveAttachment(raw: unknown): Promise<AttachmentTarget> {
  const given = expandHome(String(raw ?? "").trim());
  if (!path.isAbsolute(given)) throw new Error("Enter a full path, like ~/Projects or /Users/you/notes.txt");
  let real: string;
  try {
    real = await realpath(given);
  } catch {
    throw new Error(`${given} does not exist`);
  }
  if (isSettingsFile(real)) throw new Error("That file holds this app's API keys and can't be attached");
  const s = await stat(real);
  if (!s.isFile() && !s.isDirectory()) throw new Error(`${real} is not a file or folder`);
  return { path: real, kind: s.isDirectory() ? "folder" : "file" };
}

// Re-checks the attachments a chat sends with each request, since the
// browser could send anything: keeps the ones that still resolve.
export async function checkAttachments(raw: unknown): Promise<string[]> {
  const given = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  const resolved = await Promise.all(given.map((p) => resolveAttachment(p).catch(() => null)));
  return [...new Set(resolved.filter((r) => r !== null).map((r) => r.path))];
}

// Opens the macOS file or folder dialog and returns the POSIX paths picked,
// or none if the user cancels. The browser can't do this: its file picker
// hides where a file lives, and the disk tools need the real path.
function pickPaths(kind: "file" | "folder"): Promise<string[]> {
  const script = [
    // Brings the dialog to the front; otherwise it can open behind the browser.
    "activate",
    `set picked to choose ${kind} with prompt "Attach to this chat" with multiple selections allowed`,
    'set out to ""',
    'repeat with p in picked\nset out to out & POSIX path of p & linefeed\nend repeat',
    "out",
  ].join("\n");
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      // -128 is "User canceled".
      if (err) return stderr.includes("-128") ? resolve([]) : reject(new Error(stderr.trim() || err.message));
      resolve(stdout.split("\n").filter(Boolean));
    }),
  );
}

// Handles /api/attachments/{check,pick}; returns false for anything else.
export async function attachmentRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "attachments" || method !== "POST") return false;
  if (parts[1] === "check") {
    const { path: raw } = await readJson(req);
    try {
      sendJson(res, 200, await resolveAttachment(raw));
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
    return true;
  }
  if (parts[1] === "pick") {
    if (process.platform !== "darwin") throw new HttpError(501, "The file dialog is only available on macOS");
    const { kind } = await readJson(req);
    const picked = await pickPaths(kind === "folder" ? "folder" : "file");
    const targets = await Promise.all(picked.map((p) => resolveAttachment(p).catch(() => null)));
    sendJson(res, 200, { attachments: targets.filter((t) => t !== null) });
    return true;
  }
  return false;
}
