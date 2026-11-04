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
  - the `settings.json` block (`isSettingsFile`);
  - the home-folder rule in `create_worktree`, and the approval `remove_worktree` asks for.

  Don't add to this list without saying so here.

## API keys

A saved key lives in `settings.json` and in the headers of requests to its own
server, and nowhere else: not in a response to the browser (it's only told
whether a connector has one, `hasKey`), not in a prompt or a tool result, not in
a log, and not in `session.json`. Keeping it out of `session.json` is what makes
a session exportable by copying that one file, so code that writes session data
must never be handed a key. The app doesn't scrub anything for you.

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
- Don't open `~/.llama-mui/settings.json`; it holds the API keys.
- Where data lives: `~/.llama-mui/settings.json`, and for each session
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
