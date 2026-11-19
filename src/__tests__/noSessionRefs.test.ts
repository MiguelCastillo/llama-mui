import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The open chat's data lives in one place, the session store (src/sessionStore.ts).
// Chat.tsx once kept a mirror copy in refs (sessionRef, planRef, todosRef) next to
// its render state; the two drifted apart and Send dropped messages. This guard
// keeps that second copy from coming back.

const SRC = join(__dirname, "..");
const NAMES = ["sessionRef", "planRef", "todosRef"];
const HINT = "read the open chat with store.get() and change it with store.update (src/sessionStore.ts); don't keep a copy in a ref";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("the open chat has no copy in a ref", () => {
  it("Chat.tsx never names sessionRef, planRef or todosRef", () => {
    const text = readFileSync(join(SRC, "Chat.tsx"), "utf8");
    const found = NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    expect(found, `Chat.tsx uses ${found.join(", ")}: ${HINT}`).toEqual([]);
  });

  // The agent loop and the plan runner take a planRef/todosRef in their callbacks;
  // that is their interface, fed from the store, not a page copy. What must not
  // appear anywhere is a React ref by these names holding the chat.
  it("no file in src declares a useRef named sessionRef, planRef or todosRef", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const n of NAMES) {
        if (new RegExp(`\\b${n}\\s*=\\s*useRef\\b`).test(text)) bad.push(`${relative(SRC, file)}: ${n}`);
      }
    }
    expect(bad, `${bad.join("; ")}: ${HINT}`).toEqual([]);
  });
});
