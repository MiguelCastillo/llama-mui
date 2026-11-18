import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SectionHeader, { ARROW_SLOT, SECTION_HEADER_HEIGHT, SECTION_HEADER_SX } from "../SectionHeader";

const noop = () => {};

const render = (props: {
  title?: string;
  open?: boolean;
  count?: number;
  action?: React.ReactNode;
}) =>
  renderToStaticMarkup(
    <SectionHeader
      title={props.title ?? "A section"}
      open={props.open ?? false}
      onToggle={noop}
      count={props.count}
      action={props.action}
    />,
  );

describe("SectionHeader", () => {
  it("shows the title and marks the button as collapsed when closed", () => {
    const html = render({ open: false });
    expect(html).toContain("A section");
    expect(html).toContain('aria-expanded="false"');
    // The closed arrow is a chevron, not the open one.
    expect(html).toContain("ChevronRight");
    expect(html).not.toContain("ExpandMore");
  });

  it("marks the button as expanded and swaps the arrow when open", () => {
    const html = render({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("ExpandMore");
    expect(html).not.toContain("ChevronRight");
  });

  it("shows the count as a caption after the title", () => {
    const html = render({ count: 3 });
    expect(html).toMatch(/A section[\s\S]*?MuiTypography-caption[^>]*>3<\/span>/);
  });

  it("shows no count caption when count is not given", () => {
    const html = render({});
    expect(html).not.toContain("MuiTypography-caption");
  });

  it("draws the action before the count, when both are given", () => {
    const html = render({
      count: 2,
      action: <button type="button">New</button>,
    });
    // The button sits between the title and the count.
    expect(html).toMatch(/A section[\s\S]*?<button type="button">New<\/button>[\s\S]*?MuiTypography-caption[^>]*>2<\/span>/);
  });

  it("draws no action slot when none is given", () => {
    const html = render({ count: 1 });
    expect(html).not.toContain("<button");
  });

  it("keeps the arrow slot and the band's look in exported constants", () => {
    expect(ARROW_SLOT).toBe("1.5rem");
    // Every header is exactly this tall, so a band with a button and one
    // without draw the same height.
    expect(SECTION_HEADER_HEIGHT).toBe("2.25rem");
    // The band is the tinted, rounded, hover-able header look.
    const sx = SECTION_HEADER_SX as Record<string, unknown>;
    expect(sx.borderRadius).toBe(1);
    expect(sx.height).toBe(SECTION_HEADER_HEIGHT);
  });
});
