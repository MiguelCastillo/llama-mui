// fetch_url: opens a web page from this machine and returns its text for the
// model, with HTML turned into plain text.

import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PAGE_CHARS = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Readable text from HTML: drops scripts, styles and markup, keeps line
// breaks between blocks. Rough, but small models do fine with it.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(
      /<\/?(br|p|div|tr|h[1-6]|title|ul|ol|table|section|article|header|footer|nav|main|aside|blockquote|pre)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readCapped(res: Response): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > MAX_BYTES) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8"), cut };
}

const fetchUrl: ToolSpec = {
  name: "fetch_url",
  group: "web",
  label: "Open web pages",
  summary: "Read a web page as text.",
  definition: fn(
    "fetch_url",
    `Open a web page or file over http(s) and return its text (HTML is turned into plain text), ${PAGE_CHARS} ` +
      "characters at a time; use start to read further.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL, starting with http:// or https://." },
        start: { type: "integer", description: "Character to start from, for long pages. Default 0." },
      },
      required: ["url"],
    },
  ),
  async run(_ctx, args) {
    let url: URL;
    try {
      url = new URL(String(args.url ?? "").trim());
    } catch {
      throw new ToolError("url must be a full URL, like https://example.com/page");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("only http and https URLs");

    // Redirects are followed by hand, to cap them and report where they led.
    let res: Response;
    for (let hop = 0; ; hop++) {
      try {
        res = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "user-agent": "llama-mui/1.0", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
        });
      } catch (e: any) {
        throw new ToolError(`couldn't open ${url.href}: ${e.cause?.message ?? e.message}`);
      }
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) throw new ToolError(`too many redirects from ${args.url}`);
      url = new URL(location, url);
    }

    const type = res.headers.get("content-type") ?? "";
    const head = `${url.href} (HTTP ${res.status}${type ? `, ${type.split(";")[0]}` : ""})`;
    if (!/^(text\/|application\/(json|xml|xhtml|javascript|ld\+json|rss|atom))|\+xml|\+json/.test(type) && type) {
      await res.body?.cancel();
      return `${head}\nNot text, so it isn't shown.`;
    }
    const { text: raw, cut } = await readCapped(res);
    const text = /html/.test(type) || /^\s*<(!doctype html|html)/i.test(raw) ? htmlToText(raw) : raw;
    const start = Math.max(0, Math.floor(Number(args.start) || 0));
    if (start >= text.length && text.length) throw new ToolError(`the page has only ${text.length} characters`);
    const end = Math.min(text.length, start + PAGE_CHARS);
    const more =
      end < text.length
        ? `\n… (${text.length - end} more characters; continue with start=${end})`
        : cut
          ? `\n… (the page was cut at ${MAX_BYTES / 1024 / 1024} MB)`
          : "";
    return `${head}\n${text.slice(start, end) || "(empty)"}${more}`;
  },
};

export const FETCH_TOOLS = [fetchUrl];
