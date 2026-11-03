import { describe, expect, it } from "vitest";
import type { PlanStep, Session } from "../../src/api.ts";
import { chooseThread } from "../chooseThread.ts";

const plan: PlanStep[] = [{ id: "s1", text: "One", status: "pending" }];
const session = (id: string): Session => ({
  id,
  title: id,
  model: "m",
  messages: [],
  contextStart: 0,
  attachments: [],
  usage: null,
  failed: null,
  plan,
});

describe("chooseThread", () => {
  it("always makes a new thread, until a router replaces it", () => {
    expect(chooseThread(session("a"), plan)).toEqual({ kind: "new" });
    expect(chooseThread({ ...session("b"), threads: [{ sessionId: "t", summary: "s", anchor: null }] }, plan)).toEqual({ kind: "new" });
  });
});
