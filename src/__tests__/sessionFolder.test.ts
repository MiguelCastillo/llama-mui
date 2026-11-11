import { describe, expect, it } from "vitest";
import { folderForNewChat, folderIsFrozen, folderName } from "../sessionFolder";

describe("the folder chip's rules", () => {
  it("is a picker until the first reply fixes the prompt's folder, and again after Clear context", () => {
    expect(folderIsFrozen(undefined)).toBe(false);
    expect(folderIsFrozen("/work")).toBe(true);
    // A chat that started with no folder is fixed too.
    expect(folderIsFrozen(null)).toBe(true);
  });

  it("shows the last part of the path", () => {
    expect(folderName("/Users/me/app")).toBe("app");
    expect(folderName("/Users/me/app/")).toBe("app");
    expect(folderName("/")).toBe("/");
  });

  it("starts a new chat in the folder of the one that was open", () => {
    expect(folderForNewChat("/work")).toBe("/work");
    expect(folderForNewChat(null)).toBeNull();
  });
});
