import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReplyEndRow from "../ReplyEndRow";

const row = (props: Parameters<typeof ReplyEndRow>[0]) =>
  renderToStaticMarkup(<ReplyEndRow onResend={() => {}} onContinue={() => {}} {...props} />);

describe("the line and button under a reply that was cut short", () => {
  it("a stop says so and offers no button", () => {
    const out = row({ endedBy: "stopped" });
    expect(out).toContain("You stopped this reply.");
    expect(out).not.toContain("<button");
  });

  it("a restart says so and offers Continue", () => {
    const out = row({ endedBy: "restart", failed: "interrupted" });
    expect(out).toContain("The server restarted during this reply.");
    expect(out).toContain("Continue");
    expect(out).not.toContain("Resend");
  });

  it("a take-over says so and offers Continue", () => {
    const out = row({ endedBy: "taken-over" });
    expect(out).toContain("Another server took this over.");
    expect(out).toContain("Continue");
  });


  it("a provider error keeps its line and Resend", () => {
    const out = row({ failed: "Error: Stream error (x): Overloaded", connectorName: "Anthropic" });
    expect(out).toContain("Anthropic returned an error: Overloaded");
    expect(out).toContain("Resend");
  });

  it("shows nothing when the reply ended normally", () => {
    expect(row({})).toBe("");
  });
});
