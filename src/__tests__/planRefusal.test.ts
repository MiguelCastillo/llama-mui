import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../api";
import { refusedPlan } from "../planRefusal";

const call = (id: string, name = "update_plan"): ToolCall => ({ id, name, arguments: "{}" });
const round = (...calls: ToolCall[]): ChatMessage => ({ role: "assistant", content: "", toolCalls: calls });
const REFUSED = "Error: step 2 text is 824 characters, over the 600 limit; shorten it or split the step";
const results = (m: Record<string, string>) => (id: string) => m[id];

describe("refusedPlan", () => {
  it("gives the tool's own message when the reply's plan call was refused", () => {
    expect(refusedPlan([round(call("a"))], results({ a: REFUSED }))).toBe(
      "step 2 text is 824 characters, over the 600 limit; shorten it or split the step",
    );
  });

  it("is null when the plan was saved", () => {
    expect(refusedPlan([round(call("a"))], results({ a: "Plan saved: 3 steps." }))).toBeNull();
  });

  it("is null when the model fixed it and the second call worked", () => {
    const parts = [round(call("a")), round(call("b"))];
    expect(refusedPlan(parts, results({ a: REFUSED, b: "Plan saved: 3 steps." }))).toBeNull();
  });

  it("speaks when the model tried again and was refused again", () => {
    const parts = [round(call("a")), round(call("b"))];
    expect(refusedPlan(parts, results({ a: REFUSED, b: "Error: at most 12 steps; merge some" }))).toBe("at most 12 steps; merge some");
  });

  it("says nothing without a plan call, or while the call has no result yet", () => {
    expect(refusedPlan([round(call("a", "read_file"))], results({ a: "Error: no such file" }))).toBeNull();
    expect(refusedPlan([{ role: "assistant", content: "hi" }], results({}))).toBeNull();
    expect(refusedPlan([round(call("a"))], results({}))).toBeNull();
  });

  it("only looks at assistant rounds, and gives a plain line for a bare error", () => {
    const user: ChatMessage = { role: "user", content: "plan it", toolCalls: [call("u")] };
    expect(refusedPlan([user], results({ u: REFUSED }))).toBeNull();
    expect(refusedPlan([round(call("a"))], results({ a: "Error:" }))).toBe("the plan was refused");
  });
});
