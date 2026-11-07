import { mkdirSync, realpathSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: these tests must never touch the real ~/.llama-mui.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { TERMINAL_TOOLS } = await import("../terminal.ts");
const { WRITE_TOOLS } = await import("../write.ts");
const { INSPECT_TOOLS, findChrome } = await import("../inspect.ts");
const { ApprovalNeeded } = await import("../toolkit.ts");
import type { ToolContext, ToolSpec } from "../toolkit.ts";

const dir = realpathSync(mkdtempSync(path.join(home.dir, "work-")));
mkdirSync(dir, { recursive: true });

const ctx = (approved: string | null = null) =>
  ({ chatId: "reason-chat", workingDir: dir, attachments: [], approved }) as unknown as ToolContext;

const tool = (tools: ToolSpec[], name: string) => tools.find((t) => t.name === name)!;

// The approval a call asks for, as the user would be shown it.
async function asked(spec: ToolSpec, args: object) {
  const err = await spec.run(ctx(), args).catch((e) => e);
  expect(err).toBeInstanceOf(ApprovalNeeded);
  return (err as InstanceType<typeof ApprovalNeeded>).approval;
}

describe("the reason in an approval", () => {
  it("is in the schema of every tool that asks, and not required", () => {
    const specs = [
      tool(TERMINAL_TOOLS, "run_command"),
      tool(WRITE_TOOLS, "write_file"),
      tool(WRITE_TOOLS, "edit_file"),
      tool(INSPECT_TOOLS, "inspect_page"),
    ];
    for (const spec of specs) {
      const params = spec.definition.function.parameters as { properties: Record<string, any>; required: string[] };
      expect(params.properties.reason?.type, spec.name).toBe("string");
      expect(params.required, spec.name).not.toContain("reason");
    }
  });

  describe("run_command", () => {
    const run = tool(TERMINAL_TOOLS, "run_command");

    it("includes the reason, trimmed, when given", async () => {
      const approval = await asked(run, { command: "git log -1", reason: "  Checking which commit that is  " });
      expect(approval).toEqual({ type: "command", command: "git log -1", cwd: dir, reason: "Checking which commit that is" });
    });

    it("leaves the key out when there is none or it is blank", async () => {
      for (const args of [{ command: "ls" }, { command: "ls", reason: "   " }, { command: "ls", reason: 7 }]) {
        const approval = await asked(run, args);
        expect(approval).toEqual({ type: "command", command: "ls", cwd: dir });
        expect("reason" in approval).toBe(false);
      }
    });

    it("has an optional boolean read_only in the schema", () => {
      const params = run.definition.function.parameters as { properties: Record<string, any>; required: string[] };
      expect(params.properties.read_only?.type).toBe("boolean");
      expect(params.required).not.toContain("read_only");
    });

    it("carries read_only as readOnly, for true and false", async () => {
      expect(await asked(run, { command: "ls", read_only: true })).toEqual({ type: "command", command: "ls", cwd: dir, readOnly: true });
      expect(await asked(run, { command: "rm a", read_only: false, reason: "Cleaning up" })).toEqual({
        type: "command",
        command: "rm a",
        cwd: dir,
        reason: "Cleaning up",
        readOnly: false,
      });
    });

    it("leaves readOnly out when not given or not a boolean", async () => {
      for (const args of [{ command: "ls" }, { command: "ls", read_only: "true" }, { command: "ls", read_only: null }]) {
        const approval = await asked(run, args);
        expect("readOnly" in approval).toBe(false);
      }
    });

    it("asks again if read_only differs from what was approved", async () => {
      const args = { command: "true", read_only: true };
      const approval = await asked(run, args);
      await expect(run.run(ctx(JSON.stringify(approval)), args)).resolves.toContain("exit code 0");
      await expect(run.run(ctx(JSON.stringify(approval)), { command: "true", read_only: false })).rejects.toBeInstanceOf(ApprovalNeeded);
    });

    it("runs when the same call comes back with the approval it showed, and asks again if the reason differs", async () => {
      const args = { command: "true", reason: "Testing" };
      const approval = await asked(run, args);
      await expect(run.run(ctx(JSON.stringify(approval)), args)).resolves.toContain("exit code 0");
      await expect(run.run(ctx(JSON.stringify(approval)), { ...args, reason: "Something else" })).rejects.toBeInstanceOf(ApprovalNeeded);
    });
  });

  describe("write_file and edit_file", () => {
    const write = tool(WRITE_TOOLS, "write_file");

    it("includes the reason when given", async () => {
      const approval = await asked(write, { path: "a.txt", content: "hi\n", reason: "Saving the notes you asked for" });
      expect(approval).toMatchObject({ type: "change", action: "create", path: path.join(dir, "a.txt") });
      expect((approval as { reason?: string }).reason).toBe("Saving the notes you asked for");
    });

    it("leaves the key out otherwise", async () => {
      const approval = await asked(write, { path: "b.txt", content: "hi\n" });
      expect("reason" in approval).toBe(false);
    });

    it("writes when re-run with the same args and the approval it showed", async () => {
      const args = { path: "c.txt", content: "hi\n", reason: "Saving the notes you asked for" };
      const approval = await asked(write, args);
      await expect(write.run(ctx(JSON.stringify(approval)), args)).resolves.toContain("Created");
    });

    it("edit_file carries the reason too, and still matches when re-run", async () => {
      const edit = tool(WRITE_TOOLS, "edit_file");
      const read = await import("../reads.ts");
      const file = path.join(dir, "d.txt");
      await write.run(ctx(JSON.stringify(await asked(write, { path: file, content: "one\n" }))), { path: file, content: "one\n" });
      read.markRead("reason-chat", file, "one\n");

      const args = { path: file, old_text: "one", new_text: "two", reason: "Fixing the number" };
      const approval = await asked(edit, args);
      expect((approval as { reason?: string }).reason).toBe("Fixing the number");
      await expect(edit.run(ctx(JSON.stringify(approval)), args)).resolves.toContain("Edited");

      read.markRead("reason-chat", file, "two\n");
      const plain = await asked(edit, { path: file, old_text: "two", new_text: "three" });
      expect("reason" in plain).toBe(false);
    });
  });

  describe.skipIf(!findChrome())("inspect_page", () => {
    const inspect = tool(INSPECT_TOOLS, "inspect_page");

    it("includes the reason for another host, and leaves the key out otherwise", async () => {
      const withReason = await asked(inspect, { url: "https://example.com/a", reason: "Reading the docs page you linked" });
      expect(withReason).toEqual({
        type: "page",
        url: "https://example.com/a",
        host: "example.com",
        reason: "Reading the docs page you linked",
      });
      const without = await asked(inspect, { url: "https://example.com/a" });
      expect(without).toEqual({ type: "page", url: "https://example.com/a", host: "example.com" });
    });

    it("is satisfied by the approval it showed, when re-run with the same args", async () => {
      const args = { url: "https://example.com/a", reason: "Reading the docs page you linked" };
      const approval = await asked(inspect, args);
      // Past the approval check the tool would open Chrome; only the check itself is looked at here.
      const err = await inspect.run(ctx(JSON.stringify(approval)), { ...args, reason: "Different" }).catch((e) => e);
      expect(err).toBeInstanceOf(ApprovalNeeded);
    });
  });
});
