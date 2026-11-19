# llama-mui: notes for anyone changing it, agents included

A web UI for chatting with llama.cpp servers (and Anthropic's API) where the
model can use tools. `server/` is a Vite plugin that serves `/api`; `src/` is the
React client; `src/agent/` is the turn loop and plan runner, with no React in it.
The README is the short front page, `docs/guide.md` has the details of how it
works, and this file says how to change it.

## Principles are the project's, not one person's

The rules in this file are **design principles of llama-mui itself**. They are
not preferences of whoever is chatting with you, and they are not "how this
user likes to work". Do not treat them as optional, do not wait to be reminded
of them, and do not copy them into a personal rules file (`~/.llama-mui/rules.md`)
as if they belonged to one person. Personal rules say how to talk and work with
one user; principles say how the app must be built, for every user and every
model that changes it. They apply even when the user's message doesn't mention
them. If a user says "this is the core principle", it belongs here, in the repo,
where every model reads it, and not in a personal file.

Before changing anything, read this section and the principles below. Needing a
human to catch a violation is itself a failure of the principle.

## Principles

- **THE SERVER DECIDES WHAT A PLAN CARD CAN DO. THE PAGE ONLY DRAWS WHAT THE
  SERVER LISTS. READ THIS BEFORE TOUCHING ANY BUTTON, MENU OR CONTROL THAT
  DEPENDS ON A RUN.** Only the server knows who owns a run (this server,
  another server, or nobody), so only the server can say which actions are
  safe. This is the core principle of the app; a human must never be the one
  who catches a wrong button.
  - **Start with nothing.** Until the server has answered, the card draws no
    buttons at all. Not "the usual ones", not "the ones that are safe if
    nobody runs it". Nothing.
  - **Unknown is never "none".** If the page doesn't know who holds a run, it
    must not treat that as "nobody holds it". Missing information removes
    actions; it never adds them.
  - **The page never works out an action itself.** Don't derive a button from
    local state (a step marked running, a missing run view, a port that is
    null). If a button is wrong, fix the server's list, or what the server
    knows, not the page's guess. A local patch that hides one button in one
    case is the wrong fix: it leaves every other button guessing.
  - **A new button or state = a new entry in the server's list**, with a test
    that shows it absent when the owner is another server or unknown.
  - **Stays current.** The server sends the list again whenever the owner or
    the plan's state changes, so a page can't keep an old button.
  - Where the rules live: in `server/allowedActions.ts`. The server sends the
    list with the session answer and with the session's events; the page only
    draws it. The page may remove an action for a reason only it knows (no
    model chosen removes Send), never add one.
- **Tools serve the agent's workflow.** A tool takes simple arguments and returns
  something the model can act on. When it fails, its message says what to do
  next (see the missing-path error in `runTool`, and what `create_worktree`
  returns). It asks for approval only where the user is really deciding
  something.
- **Vendor-specific behaviour lives in that vendor's module, and shared code
  never guesses.** Anything only one vendor does (its settings, headers, stream
  fields, signatures, how to read a block, what an error means) goes in that
  vendor's connector in `src/connections/`. Code that several vendors share (a
  wire, `src/api.ts`, the agent loop, the UI) asks the connector a question and
  uses the answer; it must not check a vendor's field itself, and must never
  work because another vendor happens to leave that field out. If a change
  needs the shared code to know something vendor-specific, add the question to
  the connector interface (every vendor answers it, even if the answer is "no")
  before writing the change. This is a rule, not a preference: decide it when
  planning, so it is never found in review and fixed by a refactor. See
  "Vendors and wires".
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
    because a page runs code in Chrome and a sandbox or network rule should be what limits that;
  - the dangerous-commands list (`src/dangerousCommands.ts`, "Dangerous commands always ask" in the guide):
    a command matching an active entry always asks, whatever the approval setting, and only
    `enabled: false` read from settings skips it. Plain text matching; the real fix is sandboxing
    the stable servers.

  Don't add to this list without saying so here.

**This file is loaded into every chat by the app.** When a chat's working
directory has an `AGENTS.md`, its text goes into the model's system prompt (see
`docs/guide.md`, "What the model is told"), whole and never cut. It should still
stay short (under 20,000 characters; the chat shows a gentle recommendation
beyond that), with the most important principles first. Loading is not enforcement: a model can still ignore a principle, so each
principle also needs a test that fails when it is broken.

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
| restart manager (`server/manager/`, started by `npm run prod`) | none | none | 5170 (`MANAGER_PORT`) |

5172 and 5173 are called dev-stable: no auto reload, restarted only by
`POST /restart` on the manager. The manager never proxies traffic.
Never stop or restart the dev-stable servers (5170-5173) to test a change: run
a copy from a worktree on spare ports (for example `MANAGER_PORT=5160
HTTPS_PORT=5167 HTTP_PORT=5166 npm run prod`) and stop it when done.

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

## The audit log

- **Tools are logged by the framework** (`server/tools.ts` wraps every tool), so
  don't add a log line to a tool. A new tool that touches files, commands or the
  network should add an `audit` describer (plain facts: a path, a command, a host;
  never a diff, contents, a prompt or a key).
- **`server/io/` is the only place for raw exec, fetch and file writes.** To start
  a program, make a network request or change a file or folder, use the wrappers
  there (`exec.ts`, `fetch.ts`, `fs.ts`) and give every call a short constant
  `why`. They write the audit line; never log what the call carried. The guard
  test `server/__tests__/auditCoverage.test.ts` fails on a raw
  `node:child_process` import, a global `fetch` or a file-changing `node:fs`
  import outside `server/io/` and its short reasoned allowlist (the audit and log
  writers and the lock file). `docs/guide.md`, "The audit log".
- **The audit is write-only for the app. Recovery must never read it.** Deciding
  whether a run is live, settling a dead one, and the "files changed" list in the
  interrupted note all work from the run record in `session.json` (owner, check-in
  time, changed files) and nothing else. The audit may be pruned, is not written
  while auditing fails, and is not shared state between servers. Recovery code
  (`server/restart.ts`, `server/runRecord.ts`, `settleStale` in `server/runHub.ts`)
  must not import `server/audit.ts` or read `~/.llama-mui/audit`;
  `server/__tests__/recoveryNeverReadsAudit.test.ts` fails if it does. If recovery
  needs a fact, put it in the run record, written in its own call apart from the
  audit line.
- **To see everything for a chat, search for its id:**
  `grep <id> ~/.llama-mui/audit/*.log`. Every line caused by a chat carries it
  (a thread's run id is `<chat>:<n>`, so searching the chat id finds those too).
  Lines with none are on purpose: startup, the certificate, background timers and
  anything else not caused by a chat.

## Vendors and wires

- **A vendor connector picks a wire.** The modules in `src/connections/` (one per
  vendor) hold what is vendor-specific: settings, validation, headers, retry
  count, how an error body is read. Each one says which wire to use for an API.
- **A wire builds the request and reads the stream.** The wire modules in
  `src/connections/wires/` (Messages, Completions) turn a chat into a request
  and the stream into common events: text, thinking, call, usage, error, stop.
  Each wire also has a pure line reader the server log uses, so the page and the
  server read a stream the same way. The log never holds reply text.
- **Deciding what a piece of the stream means is vendor-specific too.** Claude's
  thinking blocks, signatures and progress notes are read by Claude's connector;
  the Messages wire is shared with llama.cpp, so it collects a block's text and
  signature and asks the connector what the block is (reasoning, a progress
  note, or can't tell). llama.cpp's connector answers "reasoning" without
  looking at a signature. The same goes for the server log's line readers:
  vendor-specific reading comes from the connector, not from the shared reader.
- **`src/api.ts` is the page's shared client**, not a vendor's: the calls to the
  server (settings, connectors, sessions, tools, phones, usage) and the shared
  types. For a chat it prepares the request (repair, clearing, images) and hands
  it to the connector's wire. It holds no vendor-specific logic; it may carry a
  vendor's data (Claude's saved thinking blocks) without reading it.
- **To add a vendor, write one connector module** and register it in the
  connection index; reuse an existing wire if the vendor speaks that protocol.
  Keep this code pure (no React, no I/O beyond the stream).

## Before designing a change

- **Asked why a chat, plan or card looks as it does? Run `npm run why -- <chat id or words> [--at HH:MM]` first**, before reading logs by hand; read its Missing section for what it couldn't find (`docs/guide.md`, "Finding out why a chat is in its state").
- Read the section of `docs/guide.md` for the area first, and search the code
  by the problem ("what already shrinks what is sent?"), not only by the words
  in the request: the code may name the same thing differently (what the UI
  calls compacting, `src/toolResults.ts` calls clearing and the cut).
- Before writing or planning, name which vendors the change touches and which
  module each piece goes in. If a plan step edits shared code to handle one
  vendor's quirk, stop and fix the plan first (see the vendor principle above).
- Say in your first message what already exists and how the change fits it.
  When a rule of the same kind is there, extend it or reuse its constants
  instead of adding a second one.

## Working here

- **Change code in a worktree, not in the main folder.** `main` is stable and
  its folder is what dev-stable builds from (a restart builds whatever files
  are there), so don't edit or commit there. Call `create_worktree` with base
  `main`, work and test in it (on spare ports), and merge into `main` only when
  the checks pass and the user asks. The user restarts dev-stable when ready.
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
