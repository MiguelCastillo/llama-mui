import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The modules read the home folder when they load, so it's pointed at a temp
// one first: this test writes its own settings.json, never the real one.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  home.dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(actual.tmpdir(), "llama-mui-home-")));
  return { ...actual, homedir: () => home.dir, default: { ...actual, homedir: () => home.dir } };
});

const { load, save, SETTINGS_FILE } = await import("../store.ts");

describe("a settings file from before connections stopped having an active one", () => {
  it("loads, keeps its connectors, and doesn't write the old field back", async () => {
    await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    const old = { activeId: "c1", connectors: [{ id: "c1", name: "Studio", url: "http://127.0.0.1:1", kind: "llama" }] };
    await writeFile(SETTINGS_FILE, JSON.stringify(old));

    const store = await load();
    expect(store.connectors.map((c) => c.id)).toEqual(["c1"]);
    expect("activeId" in store).toBe(false);

    await save(store);
    expect(JSON.parse(await readFile(SETTINGS_FILE, "utf8"))).not.toHaveProperty("activeId");
  });
});
