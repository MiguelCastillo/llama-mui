import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectInstructionsLine from "../ProjectInstructionsLine";

const render = (update: string | undefined) => renderToStaticMarkup(<ProjectInstructionsLine update={update} />);

describe("the project instructions line under a chat's first message", () => {
  it("names the file that was loaded", () => {
    const html = render("Chat update:\nProject instructions loaded: AGENTS.md\nNothing else is attached.");
    expect(html).toContain('data-testid="project-instructions"');
    expect(html).toContain("Project instructions loaded: AGENTS.md");
    expect(html).not.toContain("Nothing else is attached");
  });

  it("also shows the recommendation when the file is long", () => {
    const long = "Project instructions are long (25,000 characters); keeping CLAUDE.md under 20,000 is recommended.";
    const html = render(`Chat update:\nProject instructions loaded: CLAUDE.md\n${long}`);
    expect(html).toContain("Project instructions loaded: CLAUDE.md");
    expect(html).toContain(long);
  });

  it("shows nothing when there is no file or no update", () => {
    expect(render("Chat update:\nNothing else is attached.")).toBe("");
    expect(render(undefined)).toBe("");
  });
});
