import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WorkMarker from "../WorkMarker";

describe("WorkMarker", () => {
  it("is hidden when nothing is in progress", () => {
    expect(renderToStaticMarkup(<WorkMarker count={0} onOpen={() => {}} />)).toBe("");
  });

  it("shows the number of entries", () => {
    expect(renderToStaticMarkup(<WorkMarker count={1} onOpen={() => {}} />)).toContain("1 WIP");
    expect(renderToStaticMarkup(<WorkMarker count={3} onOpen={() => {}} />)).toContain("3 WIP");
  });

  it("opens the pane when pressed", () => {
    const onOpen = vi.fn();
    const el = WorkMarker({ count: 2, onOpen });
    expect(el).not.toBeNull();
    (el!.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
