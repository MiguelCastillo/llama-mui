import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DangerousCommandsSection, { DangerousCommandsView, testResult } from "../DangerousCommandsSection";
import DangerousNote, { offersSessionWide } from "../DangerousNote";
import { BUILT_IN_ENTRIES } from "../dangerousCommands";
import type { Approval, DangerousSetting } from "../api";

const on: DangerousSetting = { enabled: true, off: [], custom: [] };
const render = (setting: DangerousSetting) => renderToStaticMarkup(<DangerousCommandsView setting={setting} onChange={() => {}} />);

describe("the dangerous commands section", () => {
  it("shows the main switch on by default, with its plain label", () => {
    const html = render(on);
    expect(html).toContain("Always ask before dangerous commands");
    expect(html).toMatch(/<input[^>]*aria-label="Always ask before dangerous commands"[^>]*checked/);
  });

  it("shows the main switch off only when the setting says false", () => {
    const html = render({ ...on, enabled: false });
    expect(html).not.toMatch(/<input[^>]*checked[^>]*aria-label="Always ask before dangerous commands"/);
    expect(html).not.toMatch(/<input[^>]*aria-label="Always ask before dangerous commands"[^>]*checked/);
  });

  it("lists every built-in entry with its description and its own switch", () => {
    const html = render(on);
    const esc = (s: string) => s.replace(/'/g, "&#x27;");
    for (const e of BUILT_IN_ENTRIES) {
      expect(html).toContain(`aria-label="Ask before: ${esc(e.label)}"`);
      expect(html).toContain(esc(e.description.slice(0, 20)));
    }
    expect(html.match(/aria-label="Ask before: /g)?.length).toBe(BUILT_IN_ENTRIES.length);
  });

  it("shows an entry that is switched off as off, and the rest on", () => {
    const first = BUILT_IN_ENTRIES[0];
    const html = render({ ...on, off: [first.id] });
    const input = (label: string) => html.match(new RegExp(`<input[^>]*aria-label="Ask before: ${label}"[^>]*>`))![0];
    expect(input(first.label)).not.toContain("checked");
    expect(input(BUILT_IN_ENTRIES[1].label)).toContain("checked");
  });

  it("says plainly that it is a safety net and not a sandbox", () => {
    expect(render(on)).toContain("not a sandbox");
  });

  it("lists the user's own entries with Edit and Remove", () => {
    const html = render({ ...on, custom: [{ id: "c1", label: "Terraform destroy", pattern: "^terraform\\s+destroy" }] });
    expect(html).toContain("Terraform destroy");
    expect(html).toContain('aria-label="Edit Terraform destroy"');
    expect(html).toContain('aria-label="Remove Terraform destroy"');
    expect(html).toContain("Add an entry");
  });

  it("has a test box", () => {
    expect(render(on)).toContain('aria-label="Sample command"');
  });
});

describe("the test box", () => {
  it("says a dangerous command always asks, and which entry", () => {
    const r = testResult("pkill -f node", on);
    expect(r.matched).toBe(true);
    expect(r.text).toContain("Stopping processes");
  });

  it("sees a command inside bash -c", () => {
    expect(testResult(`bash -c "rm -rf build"`, on).matched).toBe(true);
  });

  it("says a harmless command is not in the list", () => {
    const r = testResult("git status", on);
    expect(r.matched).toBe(false);
    expect(r.text).toContain("No match");
  });

  it("uses the user's own entries", () => {
    const s = { ...on, custom: [{ id: "c1", label: "Terraform destroy", pattern: "^terraform\\s+destroy" }] };
    expect(testResult("terraform destroy -auto-approve", s).matched).toBe(true);
    expect(testResult("terraform plan", s).matched).toBe(false);
  });

  it("does not use an entry that is switched off", () => {
    expect(testResult("pkill -f node", { ...on, off: ["stop-processes"] }).matched).toBe(false);
  });

  it("says the list is off when the switch is off", () => {
    const r = testResult("pkill -f node", { ...on, enabled: false });
    expect(r.matched).toBe(false);
    expect(r.text).toContain("switched off");
  });

  it("asks for a command when the box is empty", () => {
    expect(testResult("  ", on).text).toContain("Type a command");
  });
});

describe("before the server has answered", () => {
  it("draws no switch and no list", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const html = renderToStaticMarkup(<DangerousCommandsSection />);
    vi.unstubAllGlobals();
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Always ask before dangerous commands");
  });
});

describe("the approval prompt for a command", () => {
  const plain: Approval = { type: "command", command: "ls", cwd: "/x" };
  const listed: Approval = {
    type: "command",
    command: "pkill -f node",
    cwd: "/x",
    dangerous: [{ id: "stop-processes", label: "Stopping processes", description: "Stops programs that are running." }],
  };

  it("offers the session-wide option for an ordinary command", () => {
    expect(offersSessionWide(plain)).toBe(true);
  });

  it("does not offer it when the server says the command is in the list", () => {
    expect(offersSessionWide(listed)).toBe(false);
  });

  it("does not decide from the command's text: a command that looks dangerous but has no server list still follows the server", () => {
    expect(offersSessionWide({ ...plain, command: "rm -rf /" })).toBe(true);
  });

  it("an empty list from the server is not a match", () => {
    expect(offersSessionWide({ ...plain, dangerous: [] })).toBe(true);
  });

  it("shows the server's plain reason", () => {
    const html = renderToStaticMarkup(<DangerousNote approval={listed} />);
    expect(html).toContain("Stopping processes");
    expect(html).toContain("Stops programs that are running.");
    expect(html).toContain("every time");
  });

  it("draws nothing for an ordinary command or another kind of approval", () => {
    expect(renderToStaticMarkup(<DangerousNote approval={plain} />)).toBe("");
    expect(renderToStaticMarkup(<DangerousNote approval={{ type: "page", url: "https://a", host: "a" }} />)).toBe("");
  });
});
