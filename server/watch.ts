// Does each llama server answer, and what state are its models in? Asks every
// WATCH_MS and writes a line to the log (log.ts) only when something changed:
// a server stopped answering (`llama.down`, with why), answered again
// (`llama.up`, with how long it was gone), or a model changed state (`llama.model`,
// say "loaded" to "unloaded": in router mode that is a model's process having
// stopped, which is what "Failed to read connection" on the server's side
// usually comes down to). Put next to the server's own log, the times tell
// whether llama-mui lost a server or the server lost a model.
//
// Anthropic's API isn't watched: there is nothing to learn from it.

import { errorFields, log } from "./log.ts";
import { type Connector, load } from "./store.ts";

export const WATCH_MS = 15_000;

interface Seen {
  upSince?: number;
  downSince?: number;
  known: boolean;
  models: Map<string, string>;
}

const seen = new Map<string, Seen>();

// A model's state from a /v1/models entry: llama.cpp's router mode gives
// `status: { value: "loaded" | "unloaded" | "loading", ... }`; a server that
// doesn't has no status and so is never reported as changing.
function stateOf(m: any): { state: string; detail: Record<string, unknown> } | null {
  const st = m?.status;
  if (!st) return null;
  if (typeof st === "string") return { state: st, detail: {} };
  if (typeof st.value !== "string") return null;
  return { state: st.value, detail: { ...(st.failed !== undefined ? { failed: st.failed } : {}), ...(st.exit_code !== undefined ? { exitCode: st.exit_code } : {}) } };
}

export async function checkOnce(connectors: Connector[], fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<void> {
  const ids = new Set(connectors.map((c) => c.id));
  for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);

  await Promise.all(
    connectors
      .filter((c) => (c.kind ?? "llama") === "llama")
      .map(async (c) => {
        const s: Seen = seen.get(c.id) ?? { known: false, models: new Map() };
        seen.set(c.id, s);
        const started = now();
        let models: any[] | null = null;
        let problem: Record<string, unknown> | null = null;
        try {
          const res = await fetcher(`${c.url}/v1/models`, {
            headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const body: any = await res.json();
            models = Array.isArray(body?.data) ? body.data : [];
          } else problem = { status: res.status };
        } catch (e: any) {
          problem = e?.name === "TimeoutError" ? { error: "no answer within 5 seconds" } : errorFields(e);
        }
        const t = now();

        if (problem) {
          if (!s.downSince) {
            s.downSince = t;
            log("llama.down", { connector: c.name, wasUpForMs: s.upSince ? t - s.upSince : undefined, ...problem });
          }
          return;
        }

        if (s.downSince) log("llama.up", { connector: c.name, downForMs: t - s.downSince, answerMs: t - started });
        else if (!s.known) log("llama.watch", { connector: c.name, models: models!.length, answerMs: t - started });
        s.downSince = undefined;
        s.upSince ??= t;
        s.known = true;

        for (const m of models!) {
          const st = stateOf(m);
          if (!st || typeof m.id !== "string") continue;
          const before = s.models.get(m.id);
          s.models.set(m.id, st.state);
          // The first sighting is the starting point, not a change.
          if (before !== undefined && before !== st.state) log("llama.model", { connector: c.name, model: m.id, from: before, to: st.state, ...st.detail });
        }
      }),
  );
}

let timer: NodeJS.Timeout | undefined;

// Starts watching, once per process (Vite restarts its server in the same one).
export function startWatching(): void {
  if (timer) return;
  const tick = () => load().then((store) => checkOnce(store.connectors)).catch((e) => log("watch.error", errorFields(e)));
  void tick();
  timer = setInterval(() => void tick(), WATCH_MS);
  timer.unref();
}

// For tests.
export function resetWatch(): void {
  seen.clear();
  if (timer) clearInterval(timer);
  timer = undefined;
}
