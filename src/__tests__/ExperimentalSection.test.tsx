import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EXPERIMENTS, ExperimentRows } from "../ExperimentalSection";

const render = (progressNotes: boolean) => renderToStaticMarkup(<ExperimentRows experiments={{ progressNotes }} onChange={() => {}} />);

describe("the Experimental section's rows", () => {
  it("shows the progress-notes switch with what it does and which models", () => {
    const html = render(false);
    expect(html).toContain("Show Claude&#x27;s progress notes");
    expect(html).toContain("Sonnet 5.5");
    expect(html).toContain("Still being built");
  });

  it("shows the switch off by default and on when the setting is on", () => {
    const off = render(false);
    const on = render(true);
    expect(off).toMatch(/<input[^>]*aria-label="Show Claude&#x27;s progress notes"[^>]*>/);
    expect(off).not.toMatch(/<input[^>]*checked[^>]*aria-label="Show Claude/);
    expect(on).toMatch(/<input[^>]*checked=""[^>]*>|<input[^>]*checked[^>]*>/);
  });

  it("has one row for each experiment in the list", () => {
    expect(EXPERIMENTS.map((x) => x.key)).toEqual(["progressNotes"]);
    expect(render(false).match(/<input/g)?.length).toBe(EXPERIMENTS.length);
  });
});

describe("the experiments hook's calls", () => {
  it("send only the changed key to the server", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([init.method, url, init.body]);
      return new Response(JSON.stringify({ progressNotes: true }), { headers: { "content-type": "application/json" } });
    });
    const { updateExperiments } = await import("../api");
    expect(await updateExperiments({ progressNotes: true })).toEqual({ progressNotes: true });
    expect(calls).toEqual([["PATCH", "/api/experiments", JSON.stringify({ progressNotes: true })]]);
    vi.unstubAllGlobals();
  });
});
