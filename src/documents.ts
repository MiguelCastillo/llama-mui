// Client-side reading of text files and PDFs for the attach button.
// Nothing is stored on the server: the text is read here and later inlined into
// the outgoing message as a labelled fenced block, so any model can use it.

// Most characters kept from one file.
export const MAX_DOCUMENT_CHARS = 50_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "c", "h", "cpp", "sh", "sql", "tex", "rtf",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || (file.type === "" && extensionOf(file.name) === "pdf");
}

// Whether the file is a text file or a PDF we can read.
export function isDocumentFile(file: File): boolean {
  if (isPdf(file)) return true;
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  // Drive and Files often hand over text files with no type at all.
  return (file.type === "" || file.type === "application/octet-stream") && TEXT_EXTENSIONS.has(extensionOf(file.name));
}

// Cut text to the cap. Returns the kept text and whether anything was dropped.
export function capText(text: string, max = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// The block inlined into the message the model receives.
export function formatDocument(name: string, text: string, truncated: boolean): string {
  // A fence longer than any run of backticks in the text, so the file can't close it early.
  let fence = "```";
  for (const run of text.match(/`{3,}/g) ?? []) {
    if (run.length >= fence.length) fence = "`".repeat(run.length + 1);
  }
  const note = truncated ? ` (cut: only the first ${text.length.toLocaleString("en-US")} characters are included)` : "";
  return `File: ${name}${note}\n${fence}\n${text}\n${fence}`;
}

// Most characters of attached files in one message, all files together.
export const MAX_TOTAL_DOCUMENT_CHARS = 120_000;

type Doc = { name: string; text: string; truncated: boolean };

// The text the model receives: the user's words, then one block per file, each
// cut to what is left of the total cap (and marked as cut in its own header).
export function composeMessage(words: string, documents: Doc[], maxTotal = MAX_TOTAL_DOCUMENT_CHARS): string {
  let left = maxTotal;
  const blocks = documents.map((d) => {
    const kept = capText(d.text, left);
    left -= kept.text.length;
    return formatDocument(d.name, kept.text, d.truncated || kept.truncated);
  });
  return [words, ...blocks].filter((p) => p !== "").join("\n\n");
}

const BLOCK = /File: ([^\n]*)\n(`{3,})\n([\s\S]*?)\n\2(?=\n\nFile: |$)/g;
const CUT_NOTE = /^(.*) \(cut: only the first [\d,]+ characters are included\)$/;

// The reverse of composeMessage, for showing a saved message: the user's words,
// and the files that were inlined after them. A message with no file blocks at
// its end comes back unchanged.
export function splitMessage(content: string): { words: string; files: Doc[] } {
  const found = [...content.matchAll(BLOCK)].map((m) => ({ start: m.index, end: m.index + m[0].length, m }));
  // Only blocks that run unbroken to the end of the message count.
  let first = found.length;
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    const closes = i === found.length - 1 ? f.end === content.length : f.end + 2 === found[i + 1].start;
    const opens = f.start === 0 || content.slice(f.start - 2, f.start) === "\n\n";
    if (!closes || !opens) break;
    first = i;
  }
  if (first === found.length) return { words: content, files: [] };
  const files = found.slice(first).map(({ m }) => {
    const cut = CUT_NOTE.exec(m[1]);
    return { name: cut ? cut[1] : m[1], text: m[3], truncated: !!cut };
  });
  return { words: content.slice(0, Math.max(0, found[first].start - 2)), files };
}

// Text of a PDF, page by page, read in the browser.
async function readPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      const page = lines.join("\n").trim();
      if (page) pages.push(page);
      length += page.length;
      if (length > MAX_DOCUMENT_CHARS) break; // enough; the rest would be cut anyway
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

// Read a file into text, cut to the per-file cap. Throws with a message the
// user can act on when the file can't be read or has no text.
export async function prepareDocument(file: File): Promise<{ name: string; text: string; truncated: boolean }> {
  if (!isDocumentFile(file)) {
    throw new Error(`"${file.name}" isn't a text file or PDF, so it can't be attached.`);
  }
  let raw: string;
  if (isPdf(file)) {
    try {
      raw = await readPdf(file);
    } catch {
      throw new Error(`"${file.name}" couldn't be read as a PDF. It may be damaged or password-protected.`);
    }
    if (!raw.trim()) {
      throw new Error(`"${file.name}" has no text to read. It looks like a scan or images only, and that isn't supported.`);
    }
  } else {
    try {
      raw = await file.text();
    } catch {
      throw new Error(`"${file.name}" couldn't be read. Try attaching it again.`);
    }
    if (raw.includes("\u0000")) {
      throw new Error(`"${file.name}" looks like a binary file, not text.`);
    }
    if (!raw.trim()) {
      throw new Error(`"${file.name}" is empty.`);
    }
  }
  return { name: file.name, ...capText(raw) };
}
