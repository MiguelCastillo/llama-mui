import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ChatUsageButton from "../ChatUsageButton";

// Static rendering runs no effects, so this is the button before any numbers
// have loaded: the state every chat starts in.
describe("chat usage button before its numbers load", () => {
  const html = renderToStaticMarkup(<ChatUsageButton sessionId="abc" />);

  it("is a button named for token usage", () => {
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Token usage"');
  });

  it("shows a placeholder instead of a wrong count", () => {
    expect(html).toContain("…");
    expect(html).not.toContain("tokens");
  });

  it("keeps the popover closed", () => {
    expect(html).not.toContain("This chat");
    expect(html).not.toContain("Open usage details");
  });
});
