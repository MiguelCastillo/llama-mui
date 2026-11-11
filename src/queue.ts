import { MAX_QUEUE, type ImageRef, type QueuedMessage } from "./api.ts";
import { readModelOptions } from "./connections/index.ts";

// What a saved queue is read as. A file written by hand, shared, or by another
// version may hold anything, so each item is checked and a bad one is dropped
// rather than failing the whole chat: it needs an id, some text (not only
// blanks) and the options a reply needs. At most MAX_QUEUE are kept, the
// first ones, so the order the user queued them in stays. Pure: the server and
// the page both read a queue through this.
export function readQueue(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const items: QueuedMessage[] = [];
  for (const raw of value) {
    const item = readQueued(raw);
    if (item) items.push(item);
    if (items.length >= MAX_QUEUE) break;
  }
  return items;
}

// The short reason shown while the queue is paused. The session says whether
// the last reply failed; a pause with no failure behind it is a Stop.
export function pausedReason(failed: unknown): string {
  return failed ? "Paused because the reply failed" : "Paused because you stopped the reply";
}

function readQueued(raw: any): QueuedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  const o = raw.options;
  if (!o || typeof o !== "object" || typeof o.model !== "string") return null;
  const images: ImageRef[] = Array.isArray(raw.images)
    ? raw.images.filter((i: any) => i && typeof i.id === "string" && typeof i.mediaType === "string").map((i: any) => ({ id: i.id, mediaType: i.mediaType }))
    : [];
  return {
    id: raw.id,
    text: raw.text,
    options: {
      ...(typeof o.connectorId === "string" && o.connectorId ? { connectorId: o.connectorId } : {}),
      model: o.model,
      toolsOn: o.toolsOn === true,
      // A queue saved before the settings were one object has thinkOn and
      // effort here instead; they are read as the object.
      modelOptions: readModelOptions(o),
      ...(typeof o.planning === "boolean" ? { planning: o.planning } : {}),
    },
    ...(images.length ? { images } : {}),
    ...(typeof raw.replyTo === "string" && raw.replyTo ? { replyTo: raw.replyTo } : {}),
    queuedAt: typeof raw.queuedAt === "number" && Number.isFinite(raw.queuedAt) ? raw.queuedAt : 0,
  };
}
