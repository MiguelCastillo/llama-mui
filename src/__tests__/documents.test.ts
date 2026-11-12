import { describe, expect, it, vi } from "vitest";
import { capText, formatDocument, isDocumentFile, MAX_DOCUMENT_CHARS, prepareDocument } from "../documents";

const file = (name: string, type: string, body = "hello"): File => new File([body], name, { type });

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));
const pdfPages = vi.hoisted(() => ({ pages: [] as string[] }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pdfPages.pages.length,
      getPage: async (n: number) => ({
        getTextContent: async () => ({ items: [{ str: pdfPages.pages[n - 1], hasEOL: false }] }),
      }),
    }),
    destroy: async () => {},
  }),
}));

describe("isDocumentFile", () => {
  it("accepts text types, PDFs and known extensions with no type", () => {
    expect(isDocumentFile(file("a.txt", "text/plain"))).toBe(true);
    expect(isDocumentFile(file("a.csv", "text/csv"))).toBe(true);
    expect(isDocumentFile(file("a.pdf", "application/pdf"))).toBe(true);
    expect(isDocumentFile(file("a.pdf", ""))).toBe(true);
    expect(isDocumentFile(file("notes.md", ""))).toBe(true);
    expect(isDocumentFile(file("data.json", "application/json"))).toBe(true);
    expect(isDocumentFile(file("run.log", "application/octet-stream"))).toBe(true);
  });

  it("rejects images and unknown binaries", () => {
    expect(isDocumentFile(file("a.png", "image/png"))).toBe(false);
    expect(isDocumentFile(file("a.zip", "application/zip"))).toBe(false);
    expect(isDocumentFile(file("a.bin", ""))).toBe(false);
  });
});

describe("capText", () => {
  it("keeps short text whole", () => {
    expect(capText("abc", 5)).toEqual({ text: "abc", truncated: false });
  });
  it("cuts long text and says so", () => {
    expect(capText("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });
});

describe("formatDocument", () => {
  it("labels the file and fences the text", () => {
    expect(formatDocument("a.txt", "hi", false)).toBe("File: a.txt\n```\nhi\n```");
  });
  it("notes a cut", () => {
    expect(formatDocument("a.txt", "hi", true)).toContain("cut");
  });
  it("uses a longer fence when the text contains one", () => {
    const out = formatDocument("a.md", "x\n```js\ny\n```", false);
    expect(out.startsWith("File: a.md\n````\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
  });
});

describe("prepareDocument", () => {
  it("reads a text file", async () => {
    expect(await prepareDocument(file("a.txt", "text/plain", "hello"))).toEqual({ name: "a.txt", text: "hello", truncated: false });
  });

  it("cuts a file over the cap", async () => {
    const r = await prepareDocument(file("big.txt", "text/plain", "a".repeat(MAX_DOCUMENT_CHARS + 10)));
    expect(r.text.length).toBe(MAX_DOCUMENT_CHARS);
    expect(r.truncated).toBe(true);
  });

  it("rejects unsupported, empty and binary files", async () => {
    await expect(prepareDocument(file("a.zip", "application/zip"))).rejects.toThrow("can't be attached");
    await expect(prepareDocument(file("a.txt", "text/plain", "  \n"))).rejects.toThrow("empty");
    await expect(prepareDocument(file("a.txt", "text/plain", "a\u0000b"))).rejects.toThrow("binary");
  });

  it("reads PDF text page by page", async () => {
    pdfPages.pages = ["one", "two"];
    const r = await prepareDocument(file("a.pdf", "application/pdf", "%PDF"));
    expect(r).toEqual({ name: "a.pdf", text: "one\n\ntwo", truncated: false });
  });

  it("explains a PDF with no text", async () => {
    pdfPages.pages = ["", " "];
    await expect(prepareDocument(file("scan.pdf", "application/pdf", "%PDF"))).rejects.toThrow("no text");
  });
});
