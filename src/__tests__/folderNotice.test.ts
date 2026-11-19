import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { folderNotice } from "../folderNotice";

describe("folderNotice", () => {
  it("says nothing when the server found no problem", () => {
    expect(folderNotice([])).toBeNull();
  });

  it("names each stored path exactly, and says nothing was sent, run or changed", () => {
    const text = folderNotice([
      { item: "workingDir", path: "/work/gone", why: "missing" },
      { item: "attachments", path: "/data/docs", why: "can't be read" },
    ])!;
    expect(text).toContain("working folder /work/gone (missing)");
    expect(text).toContain("attached folder /data/docs (can't be read)");
    expect(text).toMatch(/Nothing was sent or run/);
    expect(text).toMatch(/left unchanged/);
    expect(text).toMatch(/no other folder is used/);
  });
});

describe("the chat page and folder problems", () => {
  const chat = readFileSync("src/Chat.tsx", "utf8");
  it("takes the problems only from the server's answers, and blocks sending while there are any", () => {
    expect(chat).toContain("setFolderProblems(s.folderProblems ?? [])");
    expect(chat).toContain("setFolderProblems(r.folderProblems ?? [])");
    expect(chat).toMatch(/if \(folderProblems\.length\) return false;/);
  });
  it("changes folders of a chat the server holds only through the explicit request", () => {
    expect(chat).toContain('chooseFolders("workingDir", dir,');
    expect(chat).toContain('chooseFolders("attachments", next,');
  });
});
