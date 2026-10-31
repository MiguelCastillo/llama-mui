// Web tools. web_search asks DuckDuckGo, which has no official search API, so
// it reads the plain-HTML results page DuckDuckGo serves to browsers without
// JavaScript (html.duckduckgo.com). If that page's markup changes, parseResults
// is the one place to fix.

import { ToolError, type ToolSpec, fn } from "./toolkit.ts";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const TIMEOUT_MS = 10_000;

interface Result {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// Result links are sometimes direct and sometimes DuckDuckGo redirects
// ("//duckduckgo.com/l/?uddg=<encoded url>"); this returns the real target.
function resolveLink(href: string): string | null {
  try {
    const u = new URL(htmlToText(href), "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com")) return u.searchParams.get("uddg");
    return u.href;
  } catch {
    return null;
  }
}

function parseResults(html: string): Result[] {
  const results: Result[] = [];
  // Each result is a <div class="result ..."> block; ads carry "result--ad".
  for (const block of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = resolveLink(link[1]);
    if (!url) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: htmlToText(link[2]), url, snippet: snippet ? htmlToText(snippet[1]) : "" });
  }
  return results;
}

const webSearch: ToolSpec = {
  name: "web_search",
  group: "web",
  label: "Web search",
  summary: "Search the web with DuckDuckGo. Returns titles, links and short snippets, not whole pages.",
  definition: fn(
    "web_search",
    "Search the web with DuckDuckGo. Returns the top results as title, URL and a short snippet. Use it for current events, recent releases or facts you aren't sure of, and cite the URLs you rely on.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        max_results: { type: "integer", description: `How many results to return, 1-${MAX_RESULTS} (default ${DEFAULT_RESULTS}).` },
      },
      required: ["query"],
    },
  ),
  async run(_store, args) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new ToolError("query is required");
    const count = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(args.max_results) || DEFAULT_RESULTS)));

    let res: Response;
    try {
      res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // The HTML endpoint turns away requests that don't look like a browser.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        },
        body: new URLSearchParams({ q: query }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      throw new ToolError(
        e.name === "TimeoutError" ? "DuckDuckGo didn't answer in time" : `couldn't reach DuckDuckGo (${e.cause?.code ?? e.message})`,
      );
    }
    // DuckDuckGo answers 202 with a challenge page when it thinks it's being scraped.
    if (res.status === 202 || res.status === 429) {
      throw new ToolError("DuckDuckGo is limiting requests right now; wait a minute before searching again");
    }
    if (!res.ok) throw new ToolError(`DuckDuckGo answered ${res.status} ${res.statusText}`);

    const results = parseResults(await res.text()).slice(0, count);
    if (results.length === 0) return `No results for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
  },
};

export const WEB_TOOLS = [webSearch];
