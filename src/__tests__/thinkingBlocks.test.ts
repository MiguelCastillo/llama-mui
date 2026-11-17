import { describe, expect, it } from "vitest";
import { signatureLabel } from "../connections/anthropicSignature";
import { connection } from "../connections/index";
import { NARRATION_SIGNATURE, THINKING_SIGNATURE } from "./realSignatures";

// What a thinking block is, as each connection answers it. The signatures are
// real ones saved from a Claude chat (realSignatures.ts).

const claude = connection("anthropic");
const llama = connection("llama");
const SUMMARIZED = { thinking: { type: "adaptive", display: "summarized" } };
const UPDATES = { thinking: { type: "adaptive", display: "updates" } };

// A well-formed signature with an unseen label, built by hand: outer 08 04,
// field 2 { field 1 { 08 13, field 8 = "other" } }.
function withLabel(label: string): string {
  const text = [...label].map((c) => c.charCodeAt(0));
  const head = [0x08, 0x13, 0x42, text.length, ...text];
  const second = [0x0a, head.length, ...head];
  const outer = [0x08, 0x04, 0x12, second.length, ...second];
  return btoa(String.fromCharCode(...outer));
}

describe("reading a signature's label", () => {
  it("finds 'narration' and 'thinking' in real signatures", () => {
    expect(signatureLabel(NARRATION_SIGNATURE)).toEqual({ label: "narration" });
    expect(signatureLabel(THINKING_SIGNATURE)).toEqual({ label: "thinking" });
  });

  it("reads the label as a field, not by searching for the word", () => {
    expect(signatureLabel(withLabel("other"))).toEqual({ label: "other" });
    // 'narration' where field 8 isn't: inside another field's bytes.
    const buried = btoa(String.fromCharCode(0x08, 0x04, 0x12, 0x0b, 0x0a, 0x09, ...[..."narration"].map((c) => c.charCodeAt(0))));
    expect(signatureLabel(buried)).not.toEqual({ label: "narration" });
  });

  it("calls anything that isn't that shape unreadable", () => {
    expect(signatureLabel(undefined)).toBe("unreadable");
    expect(signatureLabel("")).toBe("unreadable");
    expect(signatureLabel("not base64 !!")).toBe("unreadable");
    expect(signatureLabel(btoa("narration"))).toBe("unreadable"); // the old test's input
    expect(signatureLabel(NARRATION_SIGNATURE.slice(0, 200))).toBe("unreadable"); // cut short
  });
});

describe("Claude's connection classifies a thinking block", () => {
  it("asked for 'updates': any text is a note, empty is reasoning, whatever the signature", () => {
    expect(claude.classifyThinking({ hasText: true, signature: THINKING_SIGNATURE }, UPDATES)).toBe("progress");
    expect(claude.classifyThinking({ hasText: true }, UPDATES)).toBe("progress");
    expect(claude.classifyThinking({ hasText: false, signature: THINKING_SIGNATURE }, UPDATES)).toBe("reasoning");
    expect(claude.classifyThinking({ hasText: false, signature: NARRATION_SIGNATURE }, UPDATES)).toBe("reasoning");
  });

  it("asked for 'summarized': the signature's label decides", () => {
    expect(claude.classifyThinking({ hasText: true, signature: NARRATION_SIGNATURE }, SUMMARIZED)).toBe("progress");
    expect(claude.classifyThinking({ hasText: true, signature: THINKING_SIGNATURE }, SUMMARIZED)).toBe("reasoning");
    // Nothing sent about thinking at all behaves the same as 'summarized'.
    expect(claude.classifyThinking({ hasText: true, signature: NARRATION_SIGNATURE }, {})).toBe("progress");
  });

  it("says unknown when it can't tell, instead of guessing", () => {
    expect(claude.classifyThinking({ hasText: true, signature: withLabel("other") }, SUMMARIZED)).toBe("unknown");
    expect(claude.classifyThinking({ hasText: true, signature: "garbage" }, SUMMARIZED)).toBe("unknown");
    expect(claude.classifyThinking({ hasText: true }, SUMMARIZED)).toBe("unknown");
  });
});

describe("llama.cpp's connection", () => {
  it("always says reasoning and never looks at a signature", () => {
    expect(llama.classifyThinking({ hasText: true }, {})).toBe("reasoning");
    // Even a Claude note signature or a request that says 'updates' changes nothing.
    expect(llama.classifyThinking({ hasText: true, signature: NARRATION_SIGNATURE }, UPDATES)).toBe("reasoning");
    expect(llama.classifyThinking({ hasText: false, signature: "garbage" }, {})).toBe("reasoning");
  });
});
