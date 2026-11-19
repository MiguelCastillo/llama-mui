// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlanView } from "../PlanView";
import type { PlanStep } from "../api";
import type { Action } from "../actions";

// The step rows use a browser-only hook; these tests are about the card's size.
vi.mock("../PlanStepRow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../PlanStepRow")>()),
  PlanStepRow: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A reply starting takes Clone away from a finished plan (the page only
// removes). The card must keep its button row's room, or every finished card
// above a sent message shrinks and the message jumps past the top bar.
const done: PlanStep[] = [{ id: "a", text: "Do it", status: "done" }];
const clone: ReadonlySet<Action> = new Set<Action>(["clone"]);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const draw = (onClone?: () => void) =>
  act(() =>
    root!.render(<PlanView steps={done} details={() => null} formatTime={String} allowed={clone} onClone={onClone} result="All done." />),
  );

describe("a finished plan card while a reply runs", () => {
  it("keeps its button row when Clone goes away, with no Clone in it", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    draw(() => {});
    expect(host.querySelector("[data-plan-actions]")).not.toBeNull();
    expect(host.textContent).toContain("Clone");
    draw(undefined);
    expect(host.querySelector("[data-plan-actions]")).not.toBeNull();
    expect(host.textContent).not.toContain("Clone");
    expect(host.textContent).toContain("All done.");
  });

  it("draws no row for a finished plan that never offered a button", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    draw(undefined);
    expect(host.querySelector("[data-plan-actions]")).toBeNull();
  });
});
