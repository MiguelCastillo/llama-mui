// Is the model making progress? A reply can make a lot of tool calls and be
// working the whole time (reading, editing, running tests until they pass) or
// be stuck (the same failure again and again, re-reading files that haven't
// changed). A count of rounds can't tell the two apart; this looks at what the
// calls did. Pure, with no React and no knowledge of any language or tool's
// output format: it only compares calls and results with each other.
//
// Two signals stop a reply:
//  - commands gave the same output SAME_OUTPUT_LIMIT times in a row, whatever
//    the commands were (a model changes a flag or a pipe each time and gets the
//    same failure) and whatever it edited in between;
//  - IDLE_ROUNDS rounds in a row brought nothing new: every call was a repeat,
//    a re-read of a file that hasn't changed, or an error it had already got.
//
// A successful write or edit is always news. A read after an edit of that file
// is news. Anything the model hasn't seen before is news.

import type { ToolCall } from "../api.ts";
import { callKey } from "./helpers.ts";

export const SAME_OUTPUT_LIMIT = 4;
export const IDLE_ROUNDS = 6;

const READS = new Set(["read_file", "grep", "list_directory", "find_files"]);
const WRITES = new Set(["write_file", "edit_file"]);

// A result with what changes from run to run taken out: colours, timings, a
// clock time. Counts stay, so "3 failed" and "2 failed" are different (that is
// progress).
export function fingerprint(result: string): string {
  return result
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/^\s*(Start at|Duration|Time)\b.*$/gim, "")
    .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, "#")
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

const argsOf = (call: ToolCall): Record<string, unknown> => {
  try {
    const a = JSON.parse(call.arguments);
    return a && typeof a === "object" ? a : {};
  } catch {
    return {};
  }
};

const pathOf = (call: ToolCall): string => {
  const a = argsOf(call);
  return typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
};

// A command, shortened for a message.
const brief = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 90)}…` : one;
};

export class ProgressWatch {
  // Per path: how many times it has been written or edited successfully, and
  // how many writes there have been in all (a search or a listing covers
  // folders, so any write may change what it finds).
  private versions = new Map<string, number>();
  private writes = 0;
  // A read call (its key) -> the version of its file when it last ran.
  private reads = new Map<string, number>();
  // The output of the last command and how many commands in a row gave it,
  // and every command output seen so far.
  private lastPrint: string | null = null;
  private streak = 0;
  private prints = new Set<string>();
  // Calls and results already seen (key + fingerprint), to tell an old error from a new one.
  private seen = new Set<string>();
  private newThisRound = false;
  private idle = 0;
  private stuck: string | null = null;

  // Records one tool call and what it returned, in the order they ran.
  record(call: ToolCall, result: string): void {
    const failed = result.startsWith("Error:");
    const key = callKey(call);
    const print = fingerprint(result);
    const path = pathOf(call);

    if (WRITES.has(call.name) && !failed) {
      this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
      this.writes++;
      this.newThisRound = true;
      this.seen.add(`${key}\n${print}`);
      return;
    }

    if (call.name === "run_command") {
      const command = String(argsOf(call).command ?? "");
      // What the command printed: the server starts every result with "$ <command>",
      // which would make two different commands that fail the same way look
      // different. A command that succeeded keeps it, so a run of silent
      // successes (mkdir, mv, cp: all "(no output)") is never mistaken for a loop.
      const header = `$ ${command.trim()}\n`;
      const succeeded = /\[exit code 0\]\s*$/.test(result);
      const shown = succeeded ? print : fingerprint(result.startsWith(header) ? result.slice(header.length) : result);
      if (succeeded) {
        this.streak = 0;
        this.lastPrint = null;
      } else {
        this.streak = this.lastPrint === shown ? this.streak + 1 : 1;
        this.lastPrint = shown;
      }
      if (this.streak >= SAME_OUTPUT_LIMIT && !this.stuck) {
        this.stuck = `the last ${this.streak} commands all gave the same output (the last: \`${brief(command)}\`).`;
      }
      // Output it hasn't seen from any command before is news; the same again is not.
      if (!this.prints.has(shown)) this.newThisRound = true;
      this.prints.add(shown);
      this.seen.add(`${key}\n${shown}`);
      return;
    }

    if (READS.has(call.name)) {
      const version = call.name === "read_file" ? (this.versions.get(path) ?? 0) : this.writes;
      const before = this.reads.get(key);
      this.reads.set(key, version);
      // The same read of a file nothing has written since: nothing to learn.
      if (before !== undefined && before === version) return;
      this.newThisRound = true;
      this.seen.add(`${key}\n${print}`);
      return;
    }

    // Anything else: new unless this exact call already gave this exact result
    // (an old error counts as nothing new).
    const mark = `${key}\n${print}`;
    if (!this.seen.has(mark)) this.newThisRound = true;
    this.seen.add(mark);
  }

  // Call once a round's calls have all been recorded. A plain-words reason when
  // the reply should stop, else null.
  endRound(): string | null {
    if (this.stuck) return this.stuck;
    this.idle = this.newThisRound ? 0 : this.idle + 1;
    this.newThisRound = false;
    if (this.idle >= IDLE_ROUNDS) {
      return `the last ${this.idle} rounds brought nothing new: repeated calls, files read again that hadn't changed, or errors it had already seen.`;
    }
    return null;
  }
}
