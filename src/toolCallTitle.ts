// The one line that names a tool call: its tool and what it works on, for
// example `read_file src/Chat.tsx`. It is the title of the call's row in the
// steps, and what the live line says while that call runs.

import type { ToolCall } from "./api.ts";

export function toolCallTitle(call: ToolCall): string {
  let args: any = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    // Shown without its target; the server reports the bad JSON to the model.
  }
  // find_files and grep take a pattern, web_search a query; show it along with
  // where they looked. run_command shows its command, fetch_url its URL,
  // locate_path what it's looking for.
  const term = args.pattern ?? args.query;
  const target =
    args.command !== undefined || args.url !== undefined || args.description !== undefined
      ? String(args.command ?? args.url ?? args.description)
      : term !== undefined
        ? `"${term}"${args.path ? ` in ${args.path}` : ""}`
        : (args.path ?? "");
  return `${call.name}${target ? ` ${target}` : ""}`;
}
