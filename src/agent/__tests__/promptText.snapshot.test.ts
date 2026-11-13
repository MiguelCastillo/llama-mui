import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLANNING_NOTE } from "../plan";

// These store the exact text the model is told today, in two plain files under
// __snapshots__, so a later change shows precisely what moved. Update them only
// on purpose (vitest -u) and say in the commit what changed.
//
// Change log:
// - Builder body: the line "For a task that changes files, first call
//   update_plan..." was replaced by the size rule as two levels, Light and
//   Standard, using the wording of DEFAULT_WORK_POLICY.
// - Planning note: no longer repeats the size rule; it is only the question
//   line ("...just answer it, and don't mention plans.").

function builderBody(): string {
  const raw = readFileSync(resolve(__dirname, "../../../personas/Builder.md"), "utf8");
  const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : raw;
}

describe("prompt text snapshots", () => {
  it("per-message planning note", async () => {
    await expect(PLANNING_NOTE).toMatchFileSnapshot("./__snapshots__/planning-note.txt");
  });

  it("Builder persona body", async () => {
    await expect(builderBody()).toMatchFileSnapshot("./__snapshots__/builder-body.txt");
  });
});
