import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HeldElsewhereLine, { takeOver } from "../HeldElsewhereLine";
import { getView, resetRunClient, subscribe } from "../runClient";
import { PlanView } from "../PlanView";
import { drawnActions, pastPlanActions } from "../actions";

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
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5175} sessionId="a" canTakeOver />)).toContain("Take over");
    expect(renderToStaticMarkup(<HeldElsewhereLine port={null} sessionId="a" canTakeOver />)).toBe("");
    expect(renderToStaticMarkup(<HeldElsewhereLine port={undefined} sessionId="a" canTakeOver />)).toBe("");
  });

  it("is not drawn unless the server lists it, even with a port", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5175} sessionId="a" />)).not.toContain("Take over");
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5175} sessionId="a" canTakeOver={false} />)).not.toContain("Take over");
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
      allowed: new Set(["takeOver"]), // what the server lists for another server's run
      footer: <HeldElsewhereLine port={5173} sessionId="a" inPlan canTakeOver />,
    });
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("Pause");
    expect(html).toContain("Take over");
  });

  it("outside a card the line still floats at the top", () => {
    expect(renderToStaticMarkup(<HeldElsewhereLine port={5173} sessionId="a" />)).toContain("position:sticky");
  });
});

// What Chat draws is drawnActions(...) handed to the card, the send box and the
// Take over line. Chat is too large to render here, so these tests run that
// same path: the list the server sent -> the set -> the markup.
describe("the page draws only what the server's list says", () => {
  const steps = [{ id: "s1", text: "Step 1", status: "pending" as const }];
  const handlers = { onRun: () => {}, onPause: () => {}, onCancel: () => {}, onClone: () => {} };
  const names = (html: string) => ["Run", "Continue", "Pause", "Discard", "Clone", "Take over"].filter((n) => html.includes(`>${n}<`) || (n === "Take over" && html.includes("Take over")));
  // The plan card with its Take over line, as Chat builds them.
  const screen = (loaded: boolean, list: string[], hasModel = true, runActive = false) => {
    const allowed = drawnActions(loaded, list, hasModel, runActive);
    return {
      allowed,
      html: renderToStaticMarkup(
        <PlanView
          steps={steps}
          details={() => null}
          formatTime={() => ""}
          onChange={() => {}}
          {...handlers}
          allowed={allowed}
          footer={<HeldElsewhereLine port={5175} sessionId="a" inPlan canTakeOver={allowed.has("takeOver")} />}
        />,
      ),
    };
  };

  it("before the server answers: no card button, no send, no Take over", () => {
    const { html, allowed } = screen(false, ["run", "discard", "send", "takeOver"]);
    expect(allowed.size).toBe(0);
    expect(names(html)).toEqual([]);
    const loadedButEmpty = screen(true, []);
    expect(loadedButEmpty.allowed.size).toBe(0);
    expect(names(loadedButEmpty.html)).toEqual([]);
  });

  it("an answer of only takeOver draws only Take over", () => {
    const { html, allowed } = screen(true, ["takeOver"]);
    expect([...allowed]).toEqual(["takeOver"]);
    expect(names(html)).toEqual(["Take over"]);
  });

  it("send follows the list; no model only removes it, and never adds it", () => {
    expect(drawnActions(true, ["send"], true, false).has("send")).toBe(true);
    expect(drawnActions(true, ["send"], false, false).has("send")).toBe(false);
    expect(drawnActions(true, ["send"], false, true).has("send")).toBe(true);
    expect(drawnActions(true, [], true, true).has("send")).toBe(false);
  });

  it("a past plan keeps only Clone, and only if listed", () => {
    expect([...pastPlanActions(drawnActions(true, ["run", "clone", "discard"], true, false))]).toEqual(["clone"]);
    expect(pastPlanActions(drawnActions(true, ["run"], true, false)).size).toBe(0);
    expect(pastPlanActions(drawnActions(false, ["clone"], true, false)).size).toBe(0);
  });

  it("a later list replaces the earlier one and removes a button", () => {
    expect(names(screen(true, ["run", "discard"]).html)).toEqual(["Run", "Discard"]);
    expect(names(screen(true, ["run"]).html)).toEqual(["Run"]);
    expect(names(screen(true, ["takeOver"]).html)).toEqual(["Take over"]);
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

  it("carries the server's list from the snapshot, and a later event replaces it", () => {
    subscribe("a", () => {});
    events().emit("snapshot", { runs: [] });
    events().emit("status", { id: "a", run, holder: { port: 5175, mine: false }, actions: ["takeOver"] });
    expect(getView("a")?.actions).toEqual(["takeOver"]);
    events().emit("status", { id: "a", run, actions: ["pause"] });
    expect(getView("a")?.actions).toEqual(["pause"]);
  });

  it("an answer for one chat does not reach another", () => {
    subscribe("a", () => {});
    subscribe("b", () => {});
    events().emit("status", { id: "a", run, holder: { port: 5175, mine: false }, actions: ["takeOver"] });
    expect(getView("a")?.actions).toEqual(["takeOver"]);
    expect(getView("b")?.actions ?? []).toEqual([]);
    events().emit("status", { id: "b", run, actions: ["pause"] });
    expect(getView("a")?.actions).toEqual(["takeOver"]);
    expect(getView("b")?.actions).toEqual(["pause"]);
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
