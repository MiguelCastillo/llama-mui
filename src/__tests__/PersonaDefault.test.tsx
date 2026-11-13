import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PersonaDefault from "../PersonaDefault";

const personas = [
  { name: "Builder", description: "Finishes work and checks it" },
  { name: "Reviewer", description: "Reads and comments" },
];
const render = (problems: string[] = []) =>
  renderToStaticMarkup(
    <PersonaDefault personas={personas} chosen="Reviewer" problems={problems} onChoose={() => {}} />,
  );

describe("default persona setting", () => {
  it("shows the chosen default and the folder", () => {
    const html = render();
    expect(html).toContain("Default persona");
    expect(html).toContain("Reviewer");
    expect(html).toContain("personas folder");
  });

  it("shows the folder the server names", () => {
    const html = renderToStaticMarkup(
      <PersonaDefault personas={personas} chosen="Builder" problems={[]} folder="/app/personas" onChoose={() => {}} />,
    );
    expect(html).toContain("/app/personas");
  });

  it("lists no problems when there are none", () => {
    expect(render()).not.toContain("persona-problems");
  });

  it("lists each problem found in persona files", () => {
    const html = render(["a.md: no name", "b.md: duplicate name"]);
    expect(html).toContain("persona-problems");
    expect(html).toContain("a.md: no name");
    expect(html).toContain("b.md: duplicate name");
  });
});
