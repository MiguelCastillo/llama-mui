import type { PlanStep } from "./api";

export interface Suggestion {
  text: string;
  // The session an old todo came from; starters have none.
  from?: string;
}

// What the picker needs of a saved session: its title and plan.
export interface PastSession {
  title: string;
  plan: PlanStep[] | null | undefined;
}

export const STARTERS = [
  "Explain something I use every day",
  "Quiz me on a topic I pick",
  "Suggest a small project for the weekend",
  "Teach me a word from another language",
  "Give me a riddle, and don't tell me the answer yet",
  "Help me plan a simple dinner from what's in the fridge",
  "Tell me a surprising fact about space",
  "Walk me through a mental model for making decisions",
  "Write a short story about a lighthouse keeper",
  "Explain a famous paradox like I'm ten",
  "Suggest a book to read next, and ask me what I like first",
  "Teach me a keyboard shortcut I probably don't know",
];

// Steps left over in plans that never finished: not done, with text, and in
// a plan that isn't wholly done or empty. A "failed" step counts as unfinished.
export function oldTodos(sessions: PastSession[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of sessions) {
    const steps = s.plan ?? [];
    if (!steps.length || steps.every((p) => p.status === "done")) continue;
    for (const p of steps) {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (p.status !== "done" && text) out.push({ text: `Continue: ${text}`, from: s.title });
    }
  }
  return out;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// About `count` suggestions: up to two old todos, filled up with starters.
// `random` is passed in so tests can fix it.
export function pickSuggestions(
  todos: Suggestion[],
  random: () => number = Math.random,
  count = 3,
  starters: string[] = STARTERS,
): Suggestion[] {
  const picked = shuffled(todos, random).slice(0, Math.min(2, count));
  const rest = shuffled(starters, random)
    .slice(0, count - picked.length)
    .map((text) => ({ text }));
  return shuffled([...picked, ...rest], random);
}

// The creatures that can show above the empty chat's message, each in its
// own EmptyChat<Name>.tsx; EmptyChatCreature has the matching components.
export const CREATURES = ["whale", "llama", "snail", "robot", "owl", "crab"] as const;
export type Creature = (typeof CREATURES)[number];

// Which one shows this time, evenly.
export function pickCreature(random: () => number = Math.random): Creature {
  return CREATURES[Math.min(CREATURES.length - 1, Math.floor(random() * CREATURES.length))];
}
