import { describe, expect, it } from "vitest";
import { connection, type Connection, type StreamEvent, type Wire } from "../connections/index";
import { anthropic } from "../connections/anthropic";
import { llama } from "../connections/llama";

// Type-level: both vendor modules are a Connection, so they have a wire(api)
// that gives a Wire. A compile error here (tsc) means one stopped fitting.
const vendors: Connection[] = [anthropic, llama];
const wireOf: (c: Connection) => Wire = (c) => c.wire("anthropic");
const events: StreamEvent[] = [
  { type: "text", text: "hi" },
  { type: "thinking", text: "hm" },
  { type: "call", id: "1", name: "x", arguments: "{}" },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } as any },
  { type: "error", message: "boom" },
  { type: "stop", reason: "end_turn" },
];

describe("wire(api)", () => {
  it("fits both vendor modules", () => {
    expect(vendors.map((c) => wireOf(c).name)).toEqual(["anthropic", "anthropic"]);
    expect(events).toHaveLength(6);
  });

  it("gives llama.cpp the wire of each API it serves", () => {
    expect(llama.wire("openai").name).toBe("openai");
    expect(llama.wire("anthropic").name).toBe("anthropic");
    expect(llama.wire().name).toBe("anthropic");
  });

  it("llama.cpp doesn't retry; its error bodies are read", () => {
    expect(llama.maxRetries).toBe(0);
    expect(llama.errorMessage({ error: { message: "ctx full" } }, "fb")).toBe("ctx full");
    expect(llama.errorMessage({ message: "inner" }, "fb")).toBe("inner");
    expect(llama.errorMessage(undefined, "fb")).toBe("fb");
  });

  it("Anthropic keeps the SDK's retries; its error bodies are read", () => {
    expect(anthropic.maxRetries).toBeUndefined();
    expect(anthropic.errorMessage({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "fb")).toBe("Overloaded");
    expect(anthropic.errorMessage("plain", "fb")).toBe("fb");
  });

  it("gives Anthropic the Messages wire whatever the API says", () => {
    expect(anthropic.wire("openai").name).toBe("anthropic");
    expect(connection("anthropic").wire("anthropic")).toBe(anthropic.wire());
  });
});
