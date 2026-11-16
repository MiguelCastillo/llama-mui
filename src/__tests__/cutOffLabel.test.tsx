import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CutOffNote from "../CutOffNote";

describe("the label under a reply the app stopped in the middle of", () => {
  it("shows the label under a reply marked cut off", () => {
    const out = renderToStaticMarkup(<CutOffNote parts={[{ role: "assistant", content: "Let me start by loo", cutOff: true }]} />);
    expect(out).toContain("Cut off when the app stopped");
  });

  it("shows it when the mark is on the last of several parts of one turn", () => {
    const out = renderToStaticMarkup(
      <CutOffNote parts={[{ role: "assistant", content: "First." }, { role: "assistant", content: "Then I wi", cutOff: true }]} />,
    );
    expect(out).toContain("Cut off when the app stopped");
  });

  it("shows nothing under a complete answer", () => {
    expect(renderToStaticMarkup(<CutOffNote parts={[{ role: "assistant", content: "All done." }]} />)).toBe("");
  });
});
