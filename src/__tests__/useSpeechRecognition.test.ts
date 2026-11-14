import { describe, expect, it } from "vitest";
import { updateBoxText } from "../useSpeechRecognition";

describe("updateBoxText", () => {
  it("returns startText when nothing has been transcribed yet", () => {
    expect(updateBoxText("hello ", "", "")).toBe("hello ");
  });

  it("appends the final transcript to startText", () => {
    expect(updateBoxText("say ", "my name is ", "")).toBe("say my name is ");
  });

  it("appends interim text after final", () => {
    expect(updateBoxText("say ", "my name is ", "miguel...")).toBe(
      "say my name is miguel..."
    );
  });

  it("handles an empty start", () => {
    expect(updateBoxText("", "hello world", "")).toBe("hello world");
  });

  it("handles all empty strings", () => {
    expect(updateBoxText("", "", "")).toBe("");
  });

  it("handles multiple final segments accumulated over time", () => {
    expect(updateBoxText("start ", "first second ", "third")).toBe(
      "start first second third"
    );
  });
});
