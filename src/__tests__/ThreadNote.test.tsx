import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ThreadNote from "../ThreadNote";
import type { NoteView } from "../planThread";

const render = (view: NoteView) => renderToStaticMarkup(<ThreadNote summary="Fix it" view={view} onOpen={() => {}} />);

describe("thread note heading and icon", () => {
  it("done but not committed: its own heading, the amber warning icon, no error icon", () => {
    const html = render({ running: false, status: "uncommitted", report: "Trouble: 2 files not committed." });
    expect(html).toContain("Done in a thread, not committed");
    expect(html).toContain('aria-label="Done, not committed"');
    expect(html).toContain("MuiSvgIcon-colorWarning");
    expect(html).not.toContain("MuiSvgIcon-colorError");
    expect(html).not.toContain('aria-label="Failed"');
    expect(html).not.toContain("Failed in a thread");
    // The whole report shows, so the uncommitted-files line is seen.
    expect(html).toContain("2 files not committed");
  });

  it("failed keeps the red error icon and its heading", () => {
    const html = render({ running: false, status: "failed" });
    expect(html).toContain("Failed in a thread");
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain("MuiSvgIcon-colorError");
  });

  it("done keeps the green check", () => {
    const html = render({ running: false, status: "done" });
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain("MuiSvgIcon-colorSuccess");
  });
});
