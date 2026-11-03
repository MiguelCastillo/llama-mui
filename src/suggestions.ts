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

function shuffled<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// `count` random starters. `random` is passed in so tests can fix it.
export function pickSuggestions(
  random: () => number = Math.random,
  count = 3,
  starters: string[] = STARTERS,
): string[] {
  return shuffled(starters, random).slice(0, count);
}

// How many suggestions show above the composer: three, two on a short screen,
// and one fewer when the My Todos button takes a place.
export function visibleCount(hasTodosButton: boolean, shortScreen: boolean): number {
  return (shortScreen ? 2 : 3) - (hasTodosButton ? 1 : 0);
}

// The creatures that can show above the empty chat's message, each in its
// own EmptyChat<Name>.tsx; EmptyChatCreature has the matching components.
export const CREATURES = ["whale", "llama", "snail", "robot", "owl", "crab"] as const;
export type Creature = (typeof CREATURES)[number];

// Which one shows this time, evenly.
export function pickCreature(random: () => number = Math.random): Creature {
  return CREATURES[Math.min(CREATURES.length - 1, Math.floor(random() * CREATURES.length))];
}
