import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PersonaPicker from "../PersonaPicker";

const personas = [
  { name: "Builder", description: "Finishes work and checks it" },
  { name: "Reviewer", description: "Reads and comments" },
];
const render = (over: Partial<Parameters<typeof PersonaPicker>[0]> = {}) =>
  renderToStaticMarkup(
    <PersonaPicker personas={personas} chosen="Builder" fixed={false} problems={[]} onChoose={() => {}} {...over} />,
  );

describe("persona picker on an empty chat", () => {
  it("shows a picker starting on the chosen persona", () => {
    const html = render();
    expect(html).toContain('data-testid="persona-picker"');
    expect(html).toContain("Persona: Builder");
    expect(html).not.toContain('data-testid="persona-label"');
  });

  it("still shows a chosen name that is no longer listed", () => {
    expect(render({ chosen: "Gone" })).toContain("Persona: Gone");
  });

  it("says nothing about problems when there are none", () => {
    expect(render()).not.toContain("persona-problems");
  });

  it("shows a brief message when some files had problems", () => {
    const html = render({ problems: ["x.md: no name"] });
    expect(html).toContain("Some persona files had problems");
  });
});

describe("persona picker after the first message", () => {
  it("is a read-only label naming the persona", () => {
    const html = render({ fixed: true, chosen: "Reviewer" });
    expect(html).toContain('data-testid="persona-label"');
    expect(html).toContain("Reviewer");
    expect(html).not.toContain('data-testid="persona-picker"');
    expect(html).not.toContain("<input");
  });

  it("hides the problems message", () => {
    expect(render({ fixed: true, problems: ["x"] })).not.toContain("persona-problems");
  });
});
