import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SkillsList from "../SkillsList";

const render = (list: Partial<Parameters<typeof SkillsList>[0]["list"]> = {}) =>
  renderToStaticMarkup(<SkillsList list={{ skills: [], problems: [], folder: "/home/me/.llama-mui/skills", ...list }} />);

describe("skills in settings", () => {
  it("says there are none and shows the folder", () => {
    const html = render();
    expect(html).toContain("No skills yet");
    expect(html).toContain("/home/me/.llama-mui/skills");
    expect(html).not.toContain("skills-problems");
  });

  it("lists each skill with its description", () => {
    const html = render({ skills: [{ name: "pdf-forms", description: "Fill in PDF forms" }] });
    expect(html).toContain("pdf-forms");
    expect(html).toContain("Fill in PDF forms");
    expect(html).not.toContain("No skills yet");
  });

  it("shows problems in plain words", () => {
    const html = render({ problems: [{ file: "a/SKILL.md", message: "a/SKILL.md has no name in its header, so it was skipped." }] });
    expect(html).toContain("skills-problems");
    expect(html).toContain("has no name");
  });
});
