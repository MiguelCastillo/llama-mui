import type { Logger } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ calls: [] as [string, any][], fail: false }));
vi.mock("../log.ts", () => ({
  log: (event: string, fields: any) => {
    if (logged.fail) throw new Error("disk full");
    logged.calls.push([event, fields]);
  },
  logHint: () => "",
  logProcessEnd: () => {},
  pruneLogs: () => {},
}));

const { withLogFile } = await import("../lifecycle.ts");

const fake = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    warnOnce: vi.fn(),
    error: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: vi.fn(() => false),
    hasWarned: false,
  }) as unknown as Logger & Record<"warn" | "warnOnce" | "error", ReturnType<typeof vi.fn>>;

const colored = "\u001b[31mTransform failed\u001b[39m in a.ts\nline2\nline3\nline4\nline5\nline6 code frame\nline7";

beforeEach(() => {
  logged.calls = [];
  logged.fail = false;
});

describe("withLogFile", () => {
  it("passes warn and error to the original unchanged and logs them plain", () => {
    const inner = fake();
    const l = withLogFile(inner);
    const opts = { timestamp: true };
    l.warn(colored, opts);
    l.error(colored, opts);
    expect(inner.warn).toHaveBeenCalledWith(colored, opts);
    expect(inner.error).toHaveBeenCalledWith(colored, opts);
    expect(logged.calls.map(([e]) => e)).toEqual(["vite.warn", "vite.error"]);
    const msg = logged.calls[1][1].message as string;
    expect(msg).not.toContain("\u001b");
    expect(msg.startsWith("Transform failed in a.ts")).toBe(true);
    expect(msg.split("\n")).toHaveLength(5);
    expect(msg).not.toContain("line6");
  });

  it("caps the length", () => {
    const l = withLogFile(fake());
    l.error("x".repeat(5000));
    expect((logged.calls[0][1].message as string).length).toBeLessThanOrEqual(601);
  });

  it("does not break when writing the log throws", () => {
    const inner = fake();
    const l = withLogFile(inner);
    logged.fail = true;
    expect(() => l.warn("a")).not.toThrow();
    expect(() => l.error("b")).not.toThrow();
    expect(inner.warn).toHaveBeenCalledWith("a", undefined);
    expect(inner.error).toHaveBeenCalledWith("b", undefined);
  });
});
