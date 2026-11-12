import { describe, expect, it } from "vitest";
import { composeMessage, splitMessage } from "../documents";

describe("composeMessage and splitMessage", () => {
  it("puts the words first, then each file, and splits them back", () => {
    const docs = [
      { name: "a.txt", text: "one", truncated: false },
      { name: "b.md", text: "two\n```js\nx\n```", truncated: false },
    ];
    const text = composeMessage("look at these", docs);
    expect(text.startsWith("look at these\n\nFile: a.txt")).toBe(true);
    expect(splitMessage(text)).toEqual({ words: "look at these", files: docs });
  });

  it("works with files only", () => {
    const docs = [{ name: "a.txt", text: "one", truncated: false }];
    expect(splitMessage(composeMessage("", docs))).toEqual({ words: "", files: docs });
  });

  it("cuts files to the total cap and says so", () => {
    const docs = [
      { name: "a.txt", text: "x".repeat(10), truncated: false },
      { name: "b.txt", text: "y".repeat(10), truncated: false },
    ];
    const text = composeMessage("hi", docs, 15);
    expect(text).toContain("(cut: only the first 5 characters are included)");
    const { files } = splitMessage(text);
    expect(files.map((f) => [f.name, f.text.length, f.truncated])).toEqual([
      ["a.txt", 10, false],
      ["b.txt", 5, true],
    ]);
  });

  it("keeps a file's own cut mark", () => {
    const text = composeMessage("", [{ name: "a.txt", text: "abc", truncated: true }]);
    expect(splitMessage(text).files[0]).toEqual({ name: "a.txt", text: "abc", truncated: true });
  });

  it("leaves ordinary messages alone", () => {
    expect(splitMessage("hello")).toEqual({ words: "hello", files: [] });
    const lookalike = "File: x\n```\nnot sent as a file\n```\nand more words";
    expect(splitMessage(lookalike)).toEqual({ words: lookalike, files: [] });
  });
});
