import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectInstructionsLine from "../ProjectInstructionsLine";

const render = (project: { file: string; text: string } | null | undefined) => renderToStaticMarkup(<ProjectInstructionsLine project={project} />);

describe("the project instructions line under the first message of the context", () => {
  it("names the file that was loaded", () => {
    const html = render({ file: "AGENTS.md", text: "short" });
    expect(html).toContain('data-testid="project-instructions"');
    expect(html).toContain("Project instructions loaded: AGENTS.md");
    expect(html).not.toContain("are long");
  });

  it("also shows the recommendation when the file is long", () => {
    const html = render({ file: "CLAUDE.md", text: "x".repeat(25_000) });
    expect(html).toContain("Project instructions loaded: CLAUDE.md");
    expect(html).toContain("Project instructions are long (25,000 characters); keeping CLAUDE.md under 20,000 is recommended.");
  });

  it("shows nothing when there is no file", () => {
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });
});
