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
  - the home-folder rule in `create_worktree`, and the approval `remove_worktree` asks for.

  Don't add to this list without saying so here.

## API keys

A saved key lives encrypted in `~/.llama-mui/.keys` (AES-256-GCM, `server/secrets.ts`)
and in the headers of requests to its own server, and nowhere else: not in
`settings.json` (older versions kept it there; `load()` moves it out and checks
it first), not in a response to the browser (it's only told whether a connector
has one, `hasKey`), not in a prompt or a tool result, not in a log, and not in
`session.json`. The key that unlocks `.keys` is random and lives outside
`~/.llama-mui`, in `~/.config/llama-mui/secret.key` (or `LLAMA_MUI_SECRET_KEY`),
so copying `~/.llama-mui` copies nothing usable. Keeping a key out of
`session.json` is what makes a session exportable by copying that one file, so
code that writes session data must never be handed a key. The app doesn't scrub
anything for you.

## Other devices

The server has no login, and its tools run commands, so a device that isn't this
computer must be paired first (`server/phones.ts`). The one gate is in
`server/plugin.ts`: every request under `/api` is let in only from this
computer (loopback, no proxy header) or with a paired device's cookie, and only
`POST /api/pair` is open. A new route is behind it automatically; keep routes
under `/api`, and don't add one that skips `isAllowed`. Page code must run over
plain `http` at a network address (a phone's case), so don't use features that
need a secure context without a fallback: `crypto.randomUUID` (use `newId` in
`src/uuid.ts`) and `navigator.clipboard` (use `copyText` in `src/clipboard.ts`).

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

## Working here

- Check with `npx tsc --noEmit -p . && npx vitest run`.
- Tests never touch the real `~/.llama-mui`: they point `os.homedir` at a temp
  folder before importing anything (see `server/__tests__/worktree.test.ts`).
- Don't open `~/.llama-mui/.keys` or `~/.config/llama-mui/secret.key`; they hold the API keys.
  Leave `settings.json` alone too: older versions kept the keys in it.
- Where data lives: `~/.llama-mui/settings.json` (and `.keys`), and for each session
  `~/.llama-mui/sessions/<id>/session.json` with its `worktrees/` beside it.
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
