import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectInstructionsLine from "../ProjectInstructionsLine";
import { projectLineTurnStart } from "../projectLineTurn";

const project = { file: "AGENTS.md", text: "short" };
type T = { start: number; parts: { role: string; aside?: boolean; planStep?: unknown }[] };
const user = (start: number, extra: object = {}): T => ({ start, parts: [{ role: "user", ...extra }] });
const model = (start: number): T => ({ start, parts: [{ role: "assistant" }] });

// Draws the page's turns the way the chat does: the line only under the chosen turn.
function drawn(turns: T[], contextStart: number): number {
  const at = projectLineTurnStart(turns, contextStart);
  const html = turns.map((t) => renderToStaticMarkup(<ProjectInstructionsLine project={t.start === at ? project : undefined} />)).join("");
  return html.split("Project instructions loaded").length - 1;
}

describe("the project line is drawn once per context, whatever the updates say", () => {
  it("draws once when later messages carry changed updates (thread outcomes, attachments)", () => {
    const turns = [user(0), model(1), user(2, { update: "Thread outcomes: x" }), model(3), user(4, { update: "Attached: a.png" }), model(5)];
    expect(drawn(turns, 0)).toBe(1);
    expect(projectLineTurnStart(turns, 0)).toBe(0);
  });

  it("draws once more at a context start in the middle, and not at the old start", () => {
    const turns = [user(0), model(1), user(2), model(3), user(4), model(5)];
    expect(projectLineTurnStart(turns, 4)).toBe(4);
    expect(drawn(turns, 4)).toBe(1);
  });

  it("skips side questions and plan steps", () => {
    const turns = [user(0, { aside: true }), user(1, { planStep: { n: 1 } }), user(2), user(3, { planStep: { n: 2 } })];
    expect(projectLineTurnStart(turns, 0)).toBe(2);
    expect(drawn(turns, 0)).toBe(1);
    expect(projectLineTurnStart([user(0, { planStep: { n: 1 } }), user(1, { planStep: { n: 2 } })], 0)).toBeUndefined();
  });
});
