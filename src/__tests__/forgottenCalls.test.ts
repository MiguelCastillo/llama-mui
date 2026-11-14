import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../api";
import { repeatedCalls } from "../forgottenCalls";

const call = (name: string, args: object, role: "assistant" | "tool" = "assistant"): ChatMessage => ({
  role,
  content: "",
  toolCalls: [{ id: Math.random().toString(36), name, arguments: JSON.stringify(args) }],
});

describe("repeatedCalls", () => {
  const earlier = [call("read_file", { path: "/a", from: 1 }), call("run_command", { command: "npm test" })];

  it("counts the calls that repeat one from before", () => {
    const written = [call("read_file", { path: "/a", from: 1 }), call("read_file", { path: "/b" })];
    expect(repeatedCalls(written, earlier)).toBe(1);
  });

  it("compares arguments by meaning, not key order", () => {
    expect(repeatedCalls([call("read_file", { from: 1, path: "/a" })], earlier)).toBe(1);
  });

  it("needs the same tool and the same arguments", () => {
    expect(repeatedCalls([call("read_file", { path: "/a", from: 2 })], earlier)).toBe(0);
    expect(repeatedCalls([call("write_file", { path: "/a", from: 1 })], earlier)).toBe(0);
  });

  it("counts each repeat, including the same one twice", () => {
    const again = call("run_command", { command: "npm test" });
    expect(repeatedCalls([again, again], earlier)).toBe(2);
  });

  it("is 0 when nothing was called before or nothing is written", () => {
    expect(repeatedCalls([call("read_file", { path: "/a" })], [])).toBe(0);
    expect(repeatedCalls([], earlier)).toBe(0);
    expect(repeatedCalls([{ role: "user", content: "hi" }], earlier)).toBe(0);
  });
});
