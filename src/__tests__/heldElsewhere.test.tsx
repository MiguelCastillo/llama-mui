import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HeldElsewhereLine, { takeOver } from "../HeldElsewhereLine";
import { getView, resetRunClient, subscribe } from "../runClient";
import { PlanView } from "../PlanView";
import { allowedActions, planState } from "../allowedActions";

// The step rows use a browser-only hook; these tests are about the card's buttons.
vi.mock("../PlanStepRow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../PlanStepRow")>()),
  PlanStepRow: () => null,
}));

// The line the page shows when another server holds the floor, and the run
// view that drives it. The server works out "mine"; the page only reads it.

describe("the held-elsewhere line", () => {
  it("names the port when another server holds the floor", () => {
    const html = renderToStaticMarkup(<HeldElsewhereLine port={5175} />);
    expect(html).toContain("Running on port 5175");
  });

  it("shows nothing when no one holds the floor", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={null} />)).toBe("");
  });

  it("shows nothing when this server holds it (the view carries no port)", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={undefined} />)).toBe("");
  });
});

describe("the Take over button", () => {
  it("shows only for another server's run", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5175} sessionId="a" />)).toContain("Take over");
    expect(renderToStaticMarkup(<HeldElsewhereLine port={null} sessionId="a" />)).toBe("");
    expect(renderToStaticMarkup(<HeldElsewhereLine port={undefined} sessionId="a" />)).toBe("");
  });

  it("asks first and sends the takeover command only when confirmed", async () => {
    const send = vi.fn(async () => ({}));
    const ask = vi.fn(() => true);
    expect(await takeOver("a", 5175, ask, send)).toBeNull();
    expect(ask).toHaveBeenCalledWith("End the run on port 5175 and continue here? The reply or step in progress there is stopped.");
    expect(send).toHaveBeenCalledWith("a", "takeover");
    send.mockClear();
    expect(await takeOver("a", 5175, () => false, send)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the plain message when refused", async () => {
    const send = vi.fn(async () => {
      throw new Error("No run is live.");
    });
    expect(await takeOver("a", 5175, () => true, send)).toBe("No run is live.");
  });
});

describe("the plan card draws only the allowed actions", () => {
  const steps = [{ id: "s1", text: "Step 1", status: "pending" as const }];
  const card = (props: object) =>
    renderToStaticMarkup(<PlanView steps={steps} details={() => null} formatTime={() => ""} {...props} />);
  const handlers = { onRun: () => {}, onPause: () => {}, onCancel: () => {}, onClone: () => {} };
  const names = (html: string) => ["Run", "Continue", "Pause", "Discard", "Clone"].filter((n) => html.includes(`>${n}<`));

  it("with no list, no button is drawn, whatever handlers it has", () => {
    expect(names(card({ ...handlers }))).toEqual([]);
  });

  it("draws exactly the listed buttons", () => {
    expect(names(card({ ...handlers, allowed: new Set(["run", "discard"]) }))).toEqual(["Run", "Discard"]);
    expect(names(card({ ...handlers, allowed: new Set(["continue", "pause"]) }))).toEqual(["Continue", "Pause"]);
  });

  it("a listed action with no handler is not drawn", () => {
    expect(names(card({ allowed: new Set(["run", "discard", "pause", "clone"]) }))).toEqual([]);
  });

  it("keeps the room for the buttons whether or not there are any, while the plan can run", () => {
    expect(card({})).toContain("min-height:1.9375rem");
    expect(card({ ...handlers, allowed: new Set(["run"]) })).toContain("min-height:1.9375rem");
  });

  it("a finished plan keeps no room and draws no empty row", () => {
    const done = renderToStaticMarkup(
      <PlanView steps={[{ id: "s1", text: "Step 1", status: "done" as const }]} details={() => null} formatTime={() => ""} />,
    );
    expect(done).not.toContain("min-height:1.9375rem");
  });
});

describe("the line inside the plan card", () => {
  const steps = [{ id: "s1", text: "Step 1", status: "pending" as const }];
  const card = (props: object) =>
    renderToStaticMarkup(<PlanView steps={steps} details={() => null} formatTime={() => ""} onChange={() => {}} {...props} />);

  it("shows at the bottom of the card, after the buttons", () => {
    const html = card({
      onCancel: () => {},
      allowed: new Set(["discard"]),
      footer: <HeldElsewhereLine port={5173} sessionId="a" inPlan />,
    });
    expect(html).toContain("Running on port 5173");
    expect(html.indexOf("Discard")).toBeGreaterThan(-1);
    expect(html.indexOf("Running on port 5173")).toBeGreaterThan(html.indexOf("Discard"));
    // Inside the card, it doesn't float: no sticky position.
    expect(html).not.toContain("position:sticky");
  });

  it("another server's run: only Take over, no Discard or Pause", () => {
    const html = card({
      running: true,
      onCancel: () => {},
      onPause: () => {},
      allowed: allowedActions({ loaded: true, holder: "elsewhere", plan: planState([steps[0]], true), canClone: true, hasModel: true }),
      footer: <HeldElsewhereLine port={5173} sessionId="a" inPlan />,
    });
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("Pause");
    expect(html).toContain("Take over");
  });

  it("outside a card the line still floats at the top", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5173} sessionId="a" />)).toContain("position:sticky");
  });
});

class FakeSource {
  static all: FakeSource[] = [];
  private handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

describe("the run view's held-elsewhere field", () => {
  beforeEach(() => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "a", messages: [] }), { status: 200 })));
  });
  afterEach(() => {
    resetRunClient();
    vi.unstubAllGlobals();
  });

  const run = { status: "running", startedAt: 1 };
  const events = () => FakeSource.all.find((s) => s.url === "/api/events")!;

  it("is set for another server's run, and clears when that run ends", async () => {
    const seen: (number | null)[] = [];
    subscribe("a", (v) => seen.push(v.status === "stopped" ? null : (v.heldElsewhere?.port ?? null)));
    events().emit("snapshot", { runs: [] });
    events().emit("status", { id: "a", run, holder: { port: 5175, mine: false } });
    expect(getView("a")?.heldElsewhere).toEqual({ port: 5175 });
    events().emit("status", { id: "a", run: null });
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
    expect(getView("a")?.heldElsewhere ?? null).toBeNull();
  });

  it("is empty when this server holds the floor", () => {
    subscribe("a", () => {});
    events().emit("status", { id: "a", run, holder: { port: 5173, mine: true } });
    expect(getView("a")?.heldElsewhere).toBeNull();
  });

  it("is empty when the event names no holder", () => {
    subscribe("a", () => {});
    events().emit("status", { id: "a", run });
    expect(getView("a")?.heldElsewhere).toBeNull();
  });
});
