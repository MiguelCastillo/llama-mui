// The page's one connection to the server's app-wide event stream
// (GET /api/events). Both the run client (runs starting and ending) and the
// sessions list (saves, deletes, threads) listen to it, and they share this one
// connection instead of each opening its own: a browser keeps only about six
// connections open to one address, every open stream uses one for as long as
// the page is open, and a request that finds none free (a click on Run, a page
// load) waits until one is. The connection opens for the first user and closes
// when the last one lets go.

let shared: EventSource | null = null;
let users = 0;

// The shared stream, and what to call when you're done with it. Null where
// there is no EventSource (a test, an old browser).
export function openAppEvents(): { source: EventSource; release: () => void } | null {
  if (typeof EventSource === "undefined") return null;
  shared ??= new EventSource("/api/events");
  users++;
  const source = shared;
  let released = false;
  return {
    source,
    release() {
      if (released) return;
      released = true;
      // A stream that was dropped and replaced (see resetAppEvents) isn't this one.
      if (source !== shared || --users > 0) return;
      source.close();
      shared = null;
    },
  };
}

// For tests: closes the stream and forgets who was using it.
export function resetAppEvents() {
  shared?.close();
  shared = null;
  users = 0;
}
