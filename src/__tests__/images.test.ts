import { describe, expect, it, vi } from "vitest";
import { isImageFile, prepareImage, revokePreview } from "../images";

describe("isImageFile", () => {
  const file = (type: string): File => new File(["x"], "f", { type });

  it("accepts png, jpeg, gif, webp", () => {
    expect(isImageFile(file("image/png"))).toBe(true);
    expect(isImageFile(file("image/jpeg"))).toBe(true);
    expect(isImageFile(file("image/gif"))).toBe(true);
    expect(isImageFile(file("image/webp"))).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isImageFile(file("image/bmp"))).toBe(false);
    expect(isImageFile(file("image/svg+xml"))).toBe(false);
    expect(isImageFile(file("application/pdf"))).toBe(false);
  });
});

describe("prepareImage", () => {
  const pngFile = () => new File(["x"], "f.png", { type: "image/png" });
  const jpegFile = () => new File(["x"], "f.jpg", { type: "image/jpeg" });

  it("throws on unsupported types", async () => {
    const bmp = new File(["x"], "f.bmp", { type: "image/bmp" });
    await expect(prepareImage(bmp)).rejects.toThrow(/not supported/);
  });

  it("returns a blob and a preview URL for accepted types", async () => {
    const result = await prepareImage(pngFile());
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.preview).toMatch(/^blob:/);
  });

  it("returns a blob and a preview URL for JPEG", async () => {
    const result = await prepareImage(jpegFile());
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.preview).toMatch(/^blob:/);
  });

  it("returns the original blob when no DOM is available", async () => {
    // Mock away HTMLCanvasElement and document to simulate Node.
    const origCanvas = (globalThis as any).HTMLCanvasElement;
    const origDoc = (globalThis as any).document;
    (globalThis as any).HTMLCanvasElement = undefined;
    (globalThis as any).document = undefined;
    try {
      const result = await prepareImage(pngFile());
      expect(result.blob).toBeInstanceOf(Blob);
      // Without document.createElement, resize returns the original blob.
      expect(result.blob.size).toBe(1);
    } finally {
      if (origCanvas !== undefined) (globalThis as any).HTMLCanvasElement = origCanvas;
      if (origDoc !== undefined) (globalThis as any).document = origDoc;
    }
  });

  it("returns empty preview when URL.createObjectURL is missing", async () => {
    const origCreateObjectURL = (globalThis as any).URL?.createObjectURL;
    if ((globalThis as any).URL) {
      (globalThis as any).URL.createObjectURL = undefined;
    } else {
      (globalThis as any).URL = undefined;
    }
    try {
      const result = await prepareImage(pngFile());
      expect(result.preview).toBe("");
    } finally {
      if (origCreateObjectURL !== undefined) {
        (globalThis as any).URL = { createObjectURL: origCreateObjectURL };
      } else {
        delete (globalThis as any).URL;
      }
    }
  });
});

describe("revokePreview", () => {
  it("does nothing with an empty string", () => {
    expect(() => revokePreview("")).not.toThrow();
  });

  it("does nothing with a non-blob URL", () => {
    expect(() => revokePreview("https://example.com/img.png")).not.toThrow();
  });
});
