// Ask the model to name the conversation so far (3-6 words), and parse its
// reply. Called once after the first successful reply.

import { type Api, type Kind, type ChatMessage, streamChat, type StreamDelta } from "../api";

// Build the prompt the model receives to name the conversation.
export function namingPrompt(messages: ChatMessage[]): string {
  // Show the last few messages so the model can see what the conversation
  // is about. The first user message is the session title source.
  const recent = messages.slice(-10);
  const text = recent.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  return `Name this conversation in 3 to 6 words. Reply with only the name, nothing else.\n\nConversation so far:\n${text}`;
}

// Parse the model's answer: take the first meaningful line that looks like
// a name (3-6 words, not a preamble), trim it, and keep only 3-6 words.
// Returns null when the answer isn't useful.
export function parseNamingAnswer(answer: string): string | null {
  const lines = answer
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // Preamble patterns the model might add before the actual name.
  const preambleRe = /^(sure|okay|ok|here|the\s+name\s+is|how\s+about|i\s+think|maybe|perhaps|here's|here is|this could be|let's\s+call)/i;

  // Try each line: skip preambles, take the first that has 3-6 words.
  for (const line of lines) {
    if (preambleRe.test(line)) continue;
    const stripped = line.replace(/^["'–-]+|["'–-]+$/g, "").trim();
    const words = stripped.split(/\s+/).filter((w) => w.length > 0);
    if (words.length >= 3 && words.length <= 6) {
      return words.join(" ");
    }
  }
  return null;
}

// Ask the model to name the conversation, stream its reply, and parse the
// result. Returns the parsed name or null when the request fails.
export async function askForSessionName(
  messages: ChatMessage[],
  connectorId: string,
  model: string,
  signal: AbortSignal,
  api?: Api,
  kind?: Kind,
): Promise<string | null> {
  const prompt = namingPrompt(messages);
  const fullAnswer: string[] = [];
  try {
    await streamChat(
      {
        connectorId,
        kind,
        api,
        model,
        messages: [{ role: "user", content: prompt }],
        think: false,
        tools: [],
      },
      (d: StreamDelta) => {
        if (d.content) fullAnswer.push(d.content);
      },
      signal,
    );
    return parseNamingAnswer(fullAnswer.join(""));
  } catch {
    return null;
  }
}
