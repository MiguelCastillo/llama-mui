# llama-mui: notes for anyone changing it, agents included

A web UI for chatting with llama.cpp servers (and Anthropic's API) where the
model can use tools. `server/` is a Vite plugin that serves `/api`; `src/` is the
React client; `src/agent/` is the turn loop and plan runner, with no React in it.
The README is the short front page, `docs/guide.md` has the details of how it
works, and this file says how to change it.

## Principles

- **Tools serve the agent's workflow.** A tool takes simple arguments and returns
  something the model can act on. When it fails, its message says what to do
  next (see the missing-path error in `runTool`, and what `create_worktree`
  returns). It asks for approval only where the user is really deciding
  something.
- **Safety belongs to the environment, not the tools.** A sandbox, network rules
  and where secrets live stop damage whatever a tool does. A check inside a tool
  is a stand-in until the environment does the job; when one takes over, the
  check goes. Today's stand-ins:
  - the path checks and access prompts in `server/disk.ts` and `server/write.ts`,
    including the `sessions/<id>/worktrees` exception;
  - the block on `settings.json`, `.keys` and the key file (`isSettingsFile`);
  - the home-folder rule in `create_worktree`, and the approval `remove_worktree` asks for;
  - the connection check in `server/lan.ts`: the servers listen on every interface and
    close a connection from any device but this computer unless Settings → Phone allows
    it, because binding only to the loopback would mean rebinding a server that runs hold open;
  - the host check in `inspect_page` (`server/inspect.ts`): localhost opens freely, any other host asks first,
    because a page runs code in Chrome and a sandbox or network rule should be what limits that.

  Don't add to this list without saying so here.

## What's on screen stays

While a reply runs, nothing the page has drawn is hidden, moved or folded away
afterward. The only thing that hides information is the **Show steps** toggle
(Settings → Chat). Miguel set this rule; don't change it unless he is
discussing it with you. In the guide's words (`docs/guide.md`, "Words used
here"):

- Each round's text before its tool calls streams into the chat and stays
  where it streamed.
- With Show steps on, a round's steps line appears under its text once its
  tool calls arrive (they arrive only when the round's stream ends), and stays.
  The final round's steps line appears above the answer when the reply ends.
  With Show steps off, no steps lines are drawn.
- The **live line** is a status line at the bottom: spinner, what the model is
  doing now, the time. It says "Running" and the call's title while a tool
  call runs (with Show steps off, "Working…", since a call is a step), "Writing…"
  while text streams, "Thinking…" otherwise. It never repeats text already in
  the chat. It holds nothing and doesn't open, shows with Show steps on or off,
  and goes away when the reply ends. Never draw the history inside it.
- Don't guess what a streaming text is (the answer, or text before tool calls)
  by drawing something and then taking it back. If the page can't know yet,
  draw nothing new for it until it can.

## API keys

A saved key lives encrypted in `~/.llama-mui/.keys` (AES-256-GCM, `server/secrets.ts`)
and in the headers of requests to its own server, and nowhere else: not in
`settings.json` (older versions kept it there; `load()` moves it out and checks
it first), not in a response to the browser (it's only told whether a connector
has one, `hasKey`), not in a prompt or a tool result, not in a log, and not in
`session.json`. The key that unlocks `.keys` is random and lives outside
`~/.llama-mui`, in `~/.config/llama-mui/secret.key` (or `LLAMA_MUI_SECRET_KEY`),
so copying `~/.llama-mui` copies nothing usable. Keeping a key out of
`session.json` is what makes a session exportable by copying that one file,
except sessions with images live in `sessions/<id>/` with an `images/` subfolder,
so exporting requires copying the whole folder. Code that writes session data
must never be handed a key. The app doesn't scrub
anything for you.

## Session files

Two servers (dev and prod) can share `~/.llama-mui`. Every write of a session goes
through `lockSession` in `server/sessionFile.ts`, which holds
`~/.llama-mui/locks/session-<id>.lock` while it reads and writes
`session.json`. Don't write session files any other way. If you find a lock file
there, another process is updating that session: don't edit its `session.json`
by hand or with a script; wait a few seconds and look again. A lock clears
itself when its process is gone or after 30 seconds, so one still there after
a minute is a stuck process: tell Miguel, and don't delete it yourself.

## Other devices

The server has no login, and its tools run commands, so a device that isn't this
computer must be paired first (`server/phones.ts`). The first gate is
`server/lan.ts`, which closes connections from other devices while they aren't allowed
(Settings → Phone). The second is in
`server/plugin.ts`: every request under `/api` is let in only from this
computer (loopback, no proxy header) or with a paired device's cookie, and only
`POST /api/pair` is open. A new route is behind it automatically; keep routes
under `/api`, and don't add one that skips `isAllowed`. Page code must run over
plain `http` at a network address (a phone's case), so don't use features that
need a secure context without a fallback: `crypto.randomUUID` (use `newId` in
`src/uuid.ts`) and `navigator.clipboard` (use `copyText` in `src/clipboard.ts`).

## Servers, ports and protocols

There are two ways to run the app, and each listens twice: https on every
interface, and plain http on this computer only.

| Run with | Server | https (all interfaces) | plain http (this computer only) |
|---|---|---|---|
| `npm run dev` | Vite (`vite.config.ts`, `/api` comes from `server/plugin.ts`) | 5175 (`HTTPS_PORT`) | 5174 (`HTTP_PORT`) |
| `npm run prod` | Node (`server/main.ts`, serves `dist`) | 5173 (`HTTPS_PORT`) | 5172 (`HTTP_PORT`) |

- **https is HTTP/2, with HTTP/1.1 as the fallback.** Vite's https server speaks
  HTTP/2 on its own. `server/main.ts` uses `node:http2` `createSecureServer`
  with `allowHTTP1: true`, so a client that can't do HTTP/2 (older browsers, a
  `curl --http1.1`) still gets served. The plain http servers are HTTP/1.1 only.
- **Why both https and http.** Only https gives a page a secure context (the
  microphone needs one, and so do phones at a network address). Plain http on
  the loopback exists so `inspect_page` opens the app without a certificate
  warning. The certificate is self-signed and made at startup (`server/cert.ts`).
- **Don't assume HTTP/1.1 in server code.** An HTTP/2 request has no `Host`
  header: the address arrives as `:authority`. The cross-site check in
  `server/plugin.ts` (`isCrossSite`) reads `host`, then `:authority`; without
  that fallback it refused the app's own requests over Vite's https with
  "Cross-site requests aren't allowed". HTTP/2 also forbids a `Connection`
  header, so the event stream in `server/events.ts` leaves it out when
  `req.httpVersion` is `2.0`.
- **Per-connection code has to cover HTTP/2 sessions.** `guardNetwork` in
  `server/lan.ts` also watches the server's `session` event and closes the
  session, since an HTTP/2 connection's socket can be read but not closed
  directly. The timeouts in `limits()` and the shutdown in `trackConnections`
  (`server/main.ts`) exist for the same reason: an HTTP/2 server has neither
  `closeAllConnections` nor its own timeout settings.
- **Ports are strict in dev.** Vite uses `strictPort`, so a busy 5175 is an
  error, not a quiet move to another port. A stuck old Vite on 5175 can accept
  connections and never answer; find it with `lsof -nP -iTCP:5175 -sTCP:LISTEN`.
- **A refused cross-site request is logged** as `api.cross-site-refused` in the
  server log (method, path, host, origin, `Sec-Fetch-Site`, referer; nothing
  else), so a false refusal can be traced.
- **Vite's warnings and errors are logged too**, as `vite.warn` and
  `vite.error` in the server log (colors stripped, first lines only, length
  capped), next to Node's `process.warning`. The terminal output is unchanged.
- **Check both protocols after a server change:**
  `curl -sk --http2 https://localhost:<port>/` and `--http1.1`, and plain
  `curl http://127.0.0.1:<port>/`, each should answer 200.

## Styling

- **Container and text sizes are rem, or relative.** Text, icons, spinners,
  widths, heights and spacing alike, so the whole UI scales with the browser's
  font size. Use MUI's text styles (`body1`, `body2`, `caption`) and the
  theme's spacing units (one unit is 0.5rem), or `rem` / `em` / `%` where a
  value has to be written out. The page's text is `body1`; don't set a
  different size for text that sits in the chat or the plan.
- **Borders are px.** Border widths and radii stay in px so a hairline stays
  crisp and corners keep their shape at any font size. No need to ask.
- **Any other px: stop and ask Miguel first.** Say what it is and why rem
  won't do (an SVG attribute, a library prop that takes only a number); don't
  add it quietly.
- **Approved exceptions, already in the code:** the coordinates inside the
  empty-chat drawings (`transformOrigin` in px, the few-pixel wobble offsets,
  text sized inside a viewBox), which are the drawing's own units and scale
  with it; and MUI's breakpoints, which the library takes in px. A new
  drawing follows the same pattern; anything else is new, so ask.

## Layout and the phone keyboard

- **A screen with a message box uses the shared chat layout component**
  (`ChatLayout`), not its own boxes.
- **Size from the visible height it gives you** (`useVisibleHeight`), never
  from the full screen: no `vh`, `dvh` or media queries on screen height. The
  full screen doesn't shrink when the phone keyboard opens.
- **Never position anything by a fraction of the chat area's height.** Place
  it from the message box, using the layout's slots.
- **The layout's shared values live in one place**, in the layout component.
  Change them there; don't copy them elsewhere.

## Before designing a change

- Read the section of `docs/guide.md` for the area first, and search the code
  by the problem ("what already shrinks what is sent?"), not only by the words
  in the request: the code may name the same thing differently (what the UI
  calls compacting, `src/toolResults.ts` calls clearing and the cut).
- Say in your first message what already exists and how the change fits it.
  When a rule of the same kind is there, extend it or reuse its constants
  instead of adding a second one.

## Working here

- Check with `npx tsc --noEmit -p . && npx vitest run`.
- Tests never touch the real `~/.llama-mui`: they point `os.homedir` at a temp
  folder before importing anything (see `server/__tests__/worktree.test.ts`).
- Don't open `~/.llama-mui/.keys` or `~/.config/llama-mui/secret.key`; they hold the API keys.
  Leave `settings.json` alone too: older versions kept the keys in it.
- Where data lives: `~/.llama-mui/settings.json` (and `.keys`), and for each session
  `~/.llama-mui/sessions/<id>/session.json` with its `worktrees/` beside it. The server's log is `~/.llama-mui/logs/server-<day>.log`
  (`server/log.ts`; `docs/guide.md`, "The server's log"): never put a key, header, prompt
  or reply in a line.
- Git commands that write (`commit`, `branch`, `reset`) are the user's to run in
  some setups; give the command as one line and let them run it.
- A command you hand the user for their terminal must never wait for input,
  since a tab stuck waiting leaves its Run button disabled. Put `--no-pager`
  right after `git` for `show`, `log` and `diff` (the pager holds the tab open
  at `(END)` when the output is taller than the panel), use `-m` on every commit
  (no editor opens), and avoid interactive flags (`-i`, `add -p`). Put it in the
  command itself: don't ask the user to change their git config, which should
  keep behaving as usual when they run git themselves. Commands run through a
  tool, or through llama-mui's `run_command`, have no terminal and never page.
