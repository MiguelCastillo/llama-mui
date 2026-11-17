// `npm run why -- <chat id or title words> [--at HH:MM]`. Prints the report
// and exits 0, also when facts are missing. Not recovery code.

import { buildReport } from "./report.ts";

const args = process.argv.slice(2);
let at: string | null = null;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--at") at = args[++i] ?? null;
  else if (args[i].startsWith("--at=")) at = args[i].slice(5);
  else words.push(args[i]);
}

if (!words.length) {
  console.log("Usage: npm run why -- <chat id or title words> [--at HH:MM]");
} else {
  console.log(await buildReport(words.join(" "), { at }));
}
