// inspect_page: opens a URL in headless Chrome (the one already installed; no
// browser is downloaded) and returns text for the model: the title, the
// visible structure, and the result of a script it may give. This is how the
// model checks layout, as a person would, without a screenshot.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError, type ToolSpec, fn, requireApproval } from "./toolkit.ts";

const TIME_LIMIT_MS = 30_000;
export const MAX_CHARS = 12_000;

// Hosts that run without asking: this computer's own, where the user's dev
// server is. Anything else asks first (see requireApproval below).
export function isLocalHost(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

// Where Chrome usually is. LLAMA_MUI_CHROME wins. `exists` is a parameter so
// tests can pick the platform's answer.
export function chromeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const list: string[] = [];
  if (env.LLAMA_MUI_CHROME) list.push(env.LLAMA_MUI_CHROME);
  if (platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (!base) continue;
      list.push(
        path.win32.join(base, "Google", "Chrome", "Application", "chrome.exe"),
        path.win32.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
    );
  }
  return list;
}

export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  return chromeCandidates(env, platform).find(exists) ?? null;
}

export const NO_CHROME =
  "Chrome wasn't found on this computer, so the page can't be opened. Tell the user to install Google Chrome, " +
  "or to set the LLAMA_MUI_CHROME environment variable to the path of a Chrome or Chromium program and restart llama-mui. " +
  "fetch_url can still read the page's HTML as text.";

// Cuts text to `max` characters and says so.
export function capText(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters; ask for less, or narrow the script)`;
}

// The reply: header, the outline and the script's result, each capped so
// that the outline can't crowd out the result.
export function formatReport(r: { url: string; title: string; outline: string; scriptResult?: string }): string {
  const parts = [`${r.url}\nTitle: ${r.title || "(none)"}`];
  const outlineBudget = r.scriptResult === undefined ? MAX_CHARS : Math.floor(MAX_CHARS / 2);
  parts.push(`Page:\n${capText(r.outline || "(nothing visible)", outlineBudget)}`);
  if (r.scriptResult !== undefined) parts.push(`Script result:\n${capText(r.scriptResult, MAX_CHARS - outlineBudget)}`);
  return parts.join("\n\n");
}

// Runs in the page: the visible text and structure as short lines, one per
// element worth naming, indented by nesting. Written as a string because it
// is sent to the browser as-is.
const OUTLINE_SCRIPT = `(() => {
  const lines = [];
  const clean = (s) => (s || "").replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    return true;
  };
  const nameOf = (el) => {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
      if (t) return t;
    }
    return clean(el.getAttribute("aria-label")) || clean(el.labels?.[0]?.textContent) || clean(el.innerText || el.textContent) ||
      clean(el.getAttribute("alt")) || clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || clean(el.value);
  };
  const walk = (node, depth) => {
    if (node.nodeType === 3) {
      const t = clean(node.textContent);
      if (t) lines.push("  ".repeat(depth) + t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node, tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "svg", "head"].includes(tag)) return;
    if (!visible(el)) return;
    const pad = "  ".repeat(depth);
    if (/^h[1-6]$/.test(tag)) { lines.push(pad + "[" + tag + "] " + nameOf(el)); return; }
    if (tag === "button" || el.getAttribute("role") === "button") { lines.push(pad + "[button] " + nameOf(el) + (el.disabled ? " (disabled)" : "")); return; }
    if (tag === "a" && el.getAttribute("href") !== null) { lines.push(pad + "[link] " + nameOf(el) + " -> " + el.getAttribute("href")); return; }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = tag === "input" ? el.type : tag;
      const value = type === "password" ? "" : clean(el.value);
      lines.push(pad + "[" + type + "] " + nameOf(el) + (value ? ' = "' + value + '"' : "") + (el.disabled ? " (disabled)" : ""));
      return;
    }
    if (tag === "img") { lines.push(pad + "[img] " + nameOf(el)); return; }
    const landmark = ["nav", "main", "header", "footer", "aside", "form", "dialog", "table", "ul", "ol"].includes(tag);
    if (landmark) lines.push(pad + "<" + tag + ">");
    for (const c of el.childNodes) walk(c, landmark ? depth + 1 : depth);
    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c, depth + 1);
  };
  walk(document.body || document.documentElement, 0);
  return lines.join("\\n");
})()`;

// A script the model gave is either an expression ("document.title") or
// statements with a return; both work.
export function wrapScript(script: string): string {
  let isExpression = true;
  try {
    new Function(`return (${script});`);
  } catch {
    isExpression = false;
  }
  const body = isExpression ? `return (${script});` : script;
  return `(async () => { const r = await (async () => { ${body}\n})(); return r === undefined ? "undefined" : JSON.stringify(r); })()`;
}

async function inspect(url: URL, script: string | undefined, chrome: string): Promise<string> {
  const puppeteer = (await import("puppeteer-core")).default;
  const profile = await mkdtemp(path.join(os.tmpdir(), "llama-mui-chrome-"));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      userDataDir: profile,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const response = await page.goto(url.href, { waitUntil: "load", timeout: TIME_LIMIT_MS });
    // Give scripts that build the page after load a moment to finish.
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => {});
    const finalUrl = new URL(page.url());
    if (isLocalHost(url) && !isLocalHost(finalUrl) && finalUrl.protocol !== "about:") {
      throw new ToolError(
        `${url.href} redirected to ${finalUrl.href}, a host that needs the user's approval. Call inspect_page with that URL instead.`,
      );
    }
    const title = await page.title();
    const outline = String(await page.evaluate(OUTLINE_SCRIPT));
    let scriptResult: string | undefined;
    if (script !== undefined) {
      try {
        scriptResult = String(await page.evaluate(wrapScript(script)));
      } catch (e: any) {
        scriptResult = `Error: the script failed: ${e.message}. It runs in the page, so it can use document and window and must return something JSON can hold.`;
      }
    }
    const status = response ? ` (HTTP ${response.status()})` : "";
    return formatReport({ url: finalUrl.href + status, title, outline, scriptResult });
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolError(`the page didn't finish within ${TIME_LIMIT_MS / 1000} seconds. Try a simpler page, or check that the server is running.`)),
          TIME_LIMIT_MS,
        );
      }),
    ]);
  } catch (e: any) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      `couldn't open ${url.href} in Chrome: ${e.message}. Check the address and that the server is running, or use fetch_url to read the HTML.`,
    );
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

const inspectPage: ToolSpec = {
  name: "inspect_page",
  group: "web",
  label: "Inspect pages in a browser",
  summary: "Open a page in Chrome and read its title, visible structure and a script's result.",
  definition: fn(
    "inspect_page",
    "Open a web page in a real headless Chrome and return text: its title, and its visible text and structure " +
      "(headings, buttons, inputs and links with their names). With script, also run that JavaScript in the page " +
      "and return its JSON result, for example " +
      "[...document.querySelectorAll('button')].map(b => b.getBoundingClientRect()) to check layout. " +
      "No screenshot, and no clicking or typing. localhost pages open at once; other sites ask the user first.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL, like http://localhost:5173/ or https://example.com." },
        script: {
          type: "string",
          description:
            "Optional JavaScript to run in the page: an expression, or statements ending in return. The result must be JSON-serializable.",
        },
      },
      required: ["url"],
    },
  ),
  async run(ctx, args) {
    let url: URL;
    try {
      url = new URL(String(args.url ?? "").trim());
    } catch {
      throw new ToolError("url must be a full URL, like http://localhost:5173/");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("only http and https URLs");
    if (args.script !== undefined && typeof args.script !== "string") throw new ToolError("script must be a string of JavaScript");
    const chrome = findChrome();
    if (!chrome) throw new ToolError(NO_CHROME);
    if (!isLocalHost(url)) requireApproval(ctx, { type: "page", url: url.href, host: url.host });
    return inspect(url, args.script, chrome);
  },
};

export const INSPECT_TOOLS = [inspectPage];
