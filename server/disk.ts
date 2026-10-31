// Read-only disk tools, limited to the folders listed under Settings → Tools →
// Disk, plus the routes that manage that list.
//
// Every path the model sends goes through resolveAllowed(), which checks it
// against the allowed folders both as written and after resolving symlinks,
// so neither "../" nor a symlink inside an allowed folder can reach outside.
// Walks for find_files and grep skip symlinks for the same reason.

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError, type Route, readJson, sendJson } from "./http.ts";
import { SETTINGS_FILE, type Store, load, save } from "./store.ts";
import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

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

const isInside = (child: string, root: string) =>
  child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// settings.json holds API keys, so no tool may read it even inside an allowed folder.
const isSettingsFile = (p: string) => p.startsWith(SETTINGS_FILE);

async function resolveAllowed(roots: string[], raw: unknown): Promise<string> {
  if (roots.length === 0) throw new ToolError("No folders are allowed. The user can add some in Settings → Tools.");
  const given = expandHome(String(raw ?? "").trim());
  if (!given) throw new ToolError("path is required");
  // With a single allowed folder, relative paths are unambiguous; small
  // models often send them.
  let abs: string;
  if (path.isAbsolute(given)) abs = path.resolve(given);
  else if (roots.length === 1) abs = path.resolve(roots[0], given);
  else throw new ToolError(`Use an absolute path inside one of: ${roots.join(", ")}`);

  // Checking before realpath keeps errors from revealing what exists outside.
  const outside = new ToolError(`${given} is outside the folders you may read: ${roots.join(", ")}`);
  if (!roots.some((r) => isInside(abs, r))) throw outside;
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e: any) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") throw new ToolError(`${given} does not exist`);
    throw e;
  }
  if (!roots.some((r) => isInside(real, r))) throw outside;
  if (isSettingsFile(real)) throw new ToolError(`${given} holds this app's API keys and can't be read`);
  return real;
}

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

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
function walk(starts: string[]): WalkResult {
  let visited = 0;
  async function* files() {
    const queue = [...starts];
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

const startsFor = async (store: Store, raw: unknown) =>
  raw ? [await resolveAllowed(store.directories, raw)] : [...store.directories];

const listDirectory: ToolSpec = {
  name: "list_directory",
  group: "disk",
  label: "List folders",
  summary: "See which files and folders a folder contains, with sizes.",
  definition: fn(
    "list_directory",
    "List the files and folders in a directory. Call it with no path to see the folders you may read.",
    { type: "object", properties: { path: { type: "string", description: "Absolute path of the directory." } } },
  ),
  async run(store, args) {
    const roots = store.directories;
    if (!args.path) return `Folders you may read:\n${roots.map((r) => `${r}/`).join("\n")}`;
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
        path: { type: "string", description: "Absolute path of the file." },
        start_line: { type: "integer", description: "First line to return, starting at 1." },
        max_lines: { type: "integer", description: `How many lines to return (default ${DEFAULT_READ_LINES}).` },
      },
      required: ["path"],
    },
  ),
  async run(store, args) {
    const file = await resolveAllowed(store.directories, args.path);
    const s = await stat(file);
    if (s.isDirectory()) throw new ToolError(`${file} is a directory; use list_directory`);
    if (s.size > MAX_READ_FILE_BYTES) throw new ToolError(`${file} is ${formatSize(s.size)}, too large to read`);
    const buf = await readFile(file);
    if (looksBinary(buf)) throw new ToolError(`${file} is a binary file (${formatSize(s.size)})`);

    const lines = buf.toString("utf8").split("\n");
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
        path: { type: "string", description: "Directory to search in. Defaults to every allowed folder." },
      },
      required: ["pattern"],
    },
  ),
  async run(store, args) {
    const raw = String(args.pattern ?? "").trim();
    if (!raw) throw new ToolError("pattern is required");
    const re = namePattern(raw);
    const w = walk(await startsFor(store, args.path));
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
        path: { type: "string", description: "File or directory to search. Defaults to every allowed folder." },
        include: { type: "string", description: "Only search files whose name matches this, e.g. \"*.ts\"." },
        ignore_case: { type: "boolean", description: "Match regardless of case. Default false." },
      },
      required: ["pattern"],
    },
  ),
  async run(store, args) {
    const raw = String(args.pattern ?? "");
    if (!raw) throw new ToolError("pattern is required");
    let re: RegExp;
    try {
      re = new RegExp(raw, args.ignore_case ? "i" : "");
    } catch (e: any) {
      throw new ToolError(e.message);
    }
    const include = args.include ? namePattern(String(args.include)) : null;

    // A file path searches just that file; a directory is walked.
    const starts = await startsFor(store, args.path);
    const single = args.path && (await stat(starts[0])).isFile() ? starts[0] : null;
    const w = walk(single ? [] : starts);
    const candidates = single
      ? (async function* () {
          yield { full: single, entry: { isFile: () => true, name: path.basename(single) } as Dirent };
        })()
      : w.files;

    const results: string[] = [];
    for await (const { full, entry } of candidates) {
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

export const DISK_TOOLS = [listDirectory, readTextFile, findFiles, grep];

async function validateDirectory(raw: unknown): Promise<string> {
  const given = expandHome(String(raw ?? "").trim());
  if (!path.isAbsolute(given)) throw new HttpError(400, "Enter a full path, like ~/Projects or /Users/you/notes");
  let real: string;
  try {
    real = await realpath(given);
  } catch {
    throw new HttpError(400, `${given} does not exist`);
  }
  if (!(await stat(real)).isDirectory()) throw new HttpError(400, `${real} is a file, not a folder`);
  return real;
}

// Handles /api/directories; returns false for anything else.
export async function directoryRoutes({ req, res, parts, method }: Route): Promise<boolean> {
  if (parts[0] !== "directories" || parts.length !== 1) return false;
  if (method === "GET") {
    sendJson(res, 200, { directories: (await load()).directories });
    return true;
  }
  // The path goes in the body for both, since it's full of slashes.
  if (method === "POST" || method === "DELETE") {
    const body = await readJson(req);
    const store = await load();
    if (method === "POST") {
      const dir = await validateDirectory(body.path);
      if (!store.directories.includes(dir)) store.directories.push(dir);
    } else {
      store.directories = store.directories.filter((d) => d !== body.path);
    }
    await save(store);
    sendJson(res, 200, { directories: store.directories });
    return true;
  }
  return false;
}
