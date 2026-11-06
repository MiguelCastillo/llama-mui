import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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

const { save, read, removeFolder, validateRefs, imageRoutes } = await import("../images.ts");

const SESSION_ID = "abc12345-def0-1234-5678-abcdef123456";
const IMAGES_DIR = path.join(home.dir, ".llama-mui", "sessions", SESSION_ID, "images");

const invokeRoute = async (method: string, parts: string[], body?: Buffer) => {
  const req = Object.assign(Readable.from(body ?? []), {
    method,
    headers: body ? { "content-type": "image/png" } : {},
  }) as unknown as IncomingMessage;
  let text = "";
  let error: Error | undefined;
  const res = {
    statusCode: 200,
    setHeader() {},
    end: (t: Buffer | string) => void (text = t.toString()),
  } as unknown as ServerResponse;
  try {
    await imageRoutes({ req, res, parts, method, search: "" });
  } catch (e) {
    error = e as Error;
  }
  return { status: res.statusCode, body: text, error };
};

const ROUTE_SESSION_ID = "abc12345-def0-1234-5678-abcdef123456";

describe("save", () => {
  it("writes a PNG to images/<id>.png and returns { id, mediaType }", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // minimal PNG header
    const result = await save(SESSION_ID, png, "image/png");
    expect(result).toHaveProperty("id");
    expect(result.id).toMatch(/^[a-f0-9\-]{36}$/);
    expect(result.mediaType).toBe("image/png");
    const files = await readdir(IMAGES_DIR);
    expect(files).toContain(`${result.id}.png`);
  });

  it("accepts jpeg, gif, webp", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    let r = await save(SESSION_ID, buf, "image/jpeg");
    expect(r.mediaType).toBe("image/jpeg");
    expect((await readdir(IMAGES_DIR)).find((f) => f.startsWith(r.id + "."))).toMatch(/\.jpeg$/);

    r = await save(SESSION_ID, buf, "image/gif");
    expect(r.mediaType).toBe("image/gif");

    r = await save(SESSION_ID, buf, "image/webp");
    expect(r.mediaType).toBe("image/webp");
  });

  it("rejects unsupported types", async () => {
    await expect(save(SESSION_ID, Buffer.from("x"), "image/bmp")).rejects.toThrow(/not supported/);
    await expect(save(SESSION_ID, Buffer.from("x"), "application/octet-stream")).rejects.toThrow(/not supported/);
  });

  it("rejects images over 10 MB", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(save(SESSION_ID, big, "image/png")).rejects.toThrow(/10 MB limit/);
  });

  it("is case-insensitive for the media type", async () => {
    const buf = Buffer.from([0x89, 0x50]);
    const r = await save(SESSION_ID, buf, "IMAGE/PNG");
    expect(r.mediaType).toBe("image/png");
  });
});

describe("read", () => {
  it("reads back the bytes for a stored image", async () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const { id } = await save(SESSION_ID, original, "image/png");
    const data = await read(SESSION_ID, id);
    expect(data).toEqual(original);
  });

  it("rejects a bad image id (not UUID-like)", async () => {
    await expect(read(SESSION_ID, "not-a-id")).rejects.toThrow(/Bad image id/);
    await expect(read(SESSION_ID, "../../../etc/passwd")).rejects.toThrow(/Bad image id/);
  });

  it("rejects a non-existent image id", async () => {
    await expect(read(SESSION_ID, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/);
  });
});

describe("removeFolder", () => {
  it("removes the images folder", async () => {
    await save(SESSION_ID, Buffer.from("x"), "image/png");
    await removeFolder(SESSION_ID);
    await expect(readdir(IMAGES_DIR)).rejects.toThrow(/ENOENT/);
  });

  it("succeeds when the folder does not exist", async () => {
    await expect(removeFolder("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });
});

describe("validateRefs", () => {
  it("validates a list of { id, mediaType } whose files exist", async () => {
    const r1 = await save(SESSION_ID, Buffer.from([0x89, 0x50]), "image/png");
    const r2 = await save(SESSION_ID, Buffer.from([0xff, 0xd8]), "image/jpeg");
    const refs = await validateRefs(SESSION_ID, [
      { id: r1.id, mediaType: r1.mediaType },
      { id: r2.id, mediaType: r2.mediaType },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0].id).toBe(r1.id);
    expect(refs[1].id).toBe(r2.id);
  });

  it("rejects an empty list", async () => {
    await expect(validateRefs(SESSION_ID, [])).rejects.toThrow(/non-empty/);
  });

  it("rejects an item without id or mediaType", async () => {
    await expect(validateRefs(SESSION_ID, [{ id: "x" }])).rejects.toThrow(/id and mediaType/);
    await expect(validateRefs(SESSION_ID, [{ mediaType: "image/png" }])).rejects.toThrow(/id and mediaType/);
  });

  it("rejects a ref whose file does not exist", async () => {
    await expect(validateRefs(SESSION_ID, [{ id: "nonexistent-id", mediaType: "image/png" }])).rejects.toThrow(/not found/);
  });

  it("rejects an unsupported mediaType", async () => {
    await expect(validateRefs(SESSION_ID, [{ id: "x", mediaType: "image/bmp" }])).rejects.toThrow(/Unsupported/);
  });
});

describe("imageRoutes", () => {
  it("POST /sessions/<id>/images saves and returns { id, mediaType }", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { body } = await invokeRoute("POST", ["sessions", ROUTE_SESSION_ID, "images"], png);
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty("id");
    expect(parsed.mediaType).toBe("image/png");
  });

  it("GET /sessions/<id>/images/<imgId> returns the image bytes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { body: saveBody } = await invokeRoute("POST", ["sessions", ROUTE_SESSION_ID, "images"], png);
    const saved = JSON.parse(saveBody);
    // The route matches parts[3] as the image id, which includes the extension.
    const { status } = await invokeRoute("GET", ["sessions", ROUTE_SESSION_ID, "images", `${saved.id}.png`]);
    expect(status).toBe(200);
  });

  it("GET returns the right Content-Type", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const { body: saveBody } = await invokeRoute("POST", ["sessions", ROUTE_SESSION_ID, "images"], jpeg);
    const saved = JSON.parse(saveBody);
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      headers,
      setHeader(k: string, v: string) { headers[k] = v; },
      end() {},
    } as unknown as ServerResponse;
    await imageRoutes({
      req: Readable.from([]) as unknown as IncomingMessage,
      res,
      parts: ["sessions", ROUTE_SESSION_ID, "images", `${saved.id}.jpeg`],
      method: "GET",
      search: "",
    });
    expect(headers["Content-Type"]).toBe("image/jpeg");
  });

  it("GET rejects a missing image id", async () => {
    const { status, error } = await invokeRoute("GET", ["sessions", ROUTE_SESSION_ID, "images", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png"]);
    expect(error).toBeDefined();
    expect((error as Error).message).toBe("Image not found");
  });

  it("returns false for non-image paths", async () => {
    const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse;
    const result = await imageRoutes({
      req: Readable.from([]) as unknown as IncomingMessage,
      res,
      parts: ["sessions", ROUTE_SESSION_ID, "other"],
      method: "GET",
      search: "",
    });
    expect(result).toBe(false);
  });

  it("rejects unsupported media types on POST", async () => {
    const req = Object.assign(Readable.from(Buffer.from("x")), {
      method: "POST",
      headers: { "content-type": "image/bmp" },
    }) as unknown as IncomingMessage;
    let text = "";
    let error: Error | undefined;
    const res = {
      statusCode: 200,
      setHeader() {},
      end: (t: Buffer | string) => void (text = t.toString()),
    } as unknown as ServerResponse;
    try {
      await imageRoutes({ req, res, parts: ["sessions", ROUTE_SESSION_ID, "images"], method: "POST", search: "" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toBe('Image type "image/bmp" is not supported. Use PNG, JPEG, GIF, or WebP.');
  });
});
