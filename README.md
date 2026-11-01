# llama-mui

A small Material UI chat client for llama.cpp servers' OpenAI-compatible API.

## Setup

```sh
npm install
npm run dev                  # http://localhost:5173
```

Then add a server under **Settings → Connectors** (the gear icon).

## Settings

Settings are saved in `~/.llama-mui/settings.json`, outside the project and
readable only by you (older versions kept `settings.json` in the project
folder; it's moved on first start). They're
served by a Vite plugin (`server/plugin.ts`) that runs under both
`npm run dev` and `npm run preview`. It refuses requests from other websites
(by their `Origin` and `Sec-Fetch-Site` headers): any page open in your browser
can send requests to localhost, and without that check one could run the
model's tools, commands included, on its own.

**Connectors** are llama.cpp servers: a URL, an optional API key and a name.
Chat uses the selected one. The plugin proxies chat requests at
`/api/c/<id>/v1/...` to that server with its key, so keys never reach the
browser.

**Tools** are things the model can do while answering, grouped by what they
reach and switched on or off one by one (`server/tools.ts`). With the
**Tools** switch on in chat, the model gets every tool that's on and ready.
That switch starts off, and your browser remembers where you leave it. Tool
calls and their results show in the reply.

**Models** lets you manage the models on the selected llama server. It shows
the models in the server's cache with their status (loaded/unloaded), and you
can load, unload, or delete them. It also lets you search Hugging Face for GGUF
models and download them directly to the server.

The **Plan** group (`server/plan.ts`) has `update_plan`, which the model
uses to write down the steps of a task that changes files. Chat runs those
steps one at a time and checks each one; see [How plans work](#how-plans-work).

The **Disk** group (`server/disk.ts`) has read-only tools: `list_directory`,
`read_file`, `find_files` (names, with `*` wildcards) and `grep` (regular
expressions over file contents). They read only what's attached to the chat.
**Chat settings** (the sliders icon next to the message box) lists the chat's attachments, each
marked with whether you added it or the model asked for it, and a field to
attach more; a new chat starts with nothing attached. When the model asks for
a path that isn't attached, the reply pauses on an Allow / Deny prompt;
allowing attaches it for the rest of the chat, and denying tells the model no.
When nothing exists at the path (the model guessed), the prompt says so and
offers to choose the right file or folder in the system dialog instead:
whatever you pick is attached, and the model is told to use it.
When you name something without its path ("find llama mui"), the model calls
`locate_path` instead of guessing, and the reply pauses with the same Choose
file / Choose folder buttons.
The server re-checks the attachments on every call, and every path the model
sends is checked against them after resolving symlinks and `../`. Searches
skip symlinks, so they stay inside what's attached. `settings.json` itself
can't be attached, read or searched.

The **Write** group (`server/write.ts`) has `write_file` (create a file or
replace all of it) and `edit_file` (replace exact text in a file). They work
in what's attached, under the same rules as the disk tools, and nothing is
written until you approve it: the reply pauses on the change as a diff, with
Approve / Deny. The server writes only if the change is still exactly the
diff you approved; if the file changed in between, you're asked again. An
existing file can only be changed once the model has read it in this chat,
and only if it hasn't changed since, so the model can't overwrite changes it
never saw; it's told to read the file again. The server keeps track of these
reads in memory, so after a dev server restart the model reads files again
before changing them. Files can't be deleted, and `settings.json` can't be
written.

The **Terminal** group (`server/terminal.ts`) has `run_command`, which runs a
shell command the model suggests, in an attached folder (or one you allow).
The reply pauses on the command and folder with Run / Deny, and it runs only
if you approve exactly that. It runs as you, with your login shell's
environment (PATH and so on), network and credentials: the model can't reach GitHub, but a `git push`
it suggests can. Commands get no input (git won't prompt for a password) and
are stopped after 2 minutes; the output and exit code go back to the model.

The **Web** group (`server/web.ts`) has `web_search`, which sends the model's
query to DuckDuckGo and returns titles, links and snippets. DuckDuckGo has no
official API, so it reads the plain-HTML results page; if that page changes,
`parseResults` is the place to fix.

It also has `fetch_url` (`server/fetch.ts`), which opens a page and returns its
text, with HTML turned into plain text, 20,000 characters at a time. Pages are
fetched from this machine, so the model can reach anything it can, including
your local network.

Each group adds a few lines to the system prompt while its tools are on.

## How plans work

Small models often say they're done when they aren't. A plan makes the work
visible and checked: the model writes the steps, chat runs them one at a time,
and a step only gets its checkmark when a separate check agrees it's done. The
code is in `src/Plan.tsx`, `server/plan.ts` and `runPlan` in `src/Chat.tsx`.

### When a plan is made

- The **Plan** switch is next to **Tools** in chat. It's on by default, your
  browser remembers it, and it only works while **Tools** is on and
  **Plan tasks** is on in **Settings → Tools**.
- With it on, **every message you send** gets a planning turn first. Chat
  decides that, not the model: the model doesn't get to choose whether to
  have one.
- Your message gets a note, sent to the model after it but not shown: "Right
  now, only plan. Read what you need, then call update_plan with the steps
  for this request, and stop. Don't change any files yet… If the request
  doesn't change files, answer it directly instead." In that turn the model
  can only use `update_plan` and the read tools (`list_directory`,
  `read_file`, `find_files`, `grep`, `locate_path`): it's offered every tool,
  but the others are refused when called, so it can't change anything.
- Why it's done that way: llama.cpp reuses its cache for the part of a
  prompt that matches the last one from the start. Putting the note in the
  system prompt, or offering fewer tools, changed that start, and the server
  reprocessed the whole chat on every planning turn (measured: about a minute
  for a 40k-token chat, at ~700 tokens/s). The note is saved with your
  message, so later requests send the same text and keep matching.
- What happens next is the model's choice:
  - **It calls `update_plan`**: the steps show as a checklist with **Run**,
    and nothing has changed yet. A new plan replaces an unfinished one
    before it, except that a step with exactly the same text keeps its
    status; a finished one stays (see [Where plans show](#where-plans-show)). The
    turn ends as soon as the plan lands, with no reply after it: told to go
    on, a small model kept rewording its plan instead (16 `update_plan`
    calls in one turn, each slightly different, so the repeat guard never
    fired). A call the plan tool refuses (say, over 12 steps) doesn't end
    the turn, so the model can try again.
  - **It answers instead**, which is what it should do for a question: you
    get the answer and no plan. A small model may still plan something
    simple, or answer something it should have planned.
- Messages that don't get a planning turn: **Resend** of a failed message,
  and the "Do step" messages chat sends while running a plan. With **Plan**
  off, the system prompt still suggests a plan, but nothing makes the model
  write one, and small models usually don't.
- Known gap: the planning turn leaves out `web_search` and `fetch_url`, so
  with **Plan** on, a question that needs the web can't search. They should
  be allowed, since they don't change anything.

### How many steps

- **The model decides**, in the planning turn. Its only guidance is the
  tool's instructions: each step is "one change you can make in one turn,
  written so someone could check it from the diff alone".
- **Limits**: at most 12 steps, each at most 300 characters, and none empty.
  A plan over a limit is refused with an error such as "at most 12 steps;
  merge some", and the model has to try again.
- **You**: before or between runs, hover a step to edit its text or remove
  it. There's no way to add a step yet; ask the model for a new plan instead.
- Nothing checks the plan's size. A plan with one big step gets one check at
  the end, which loses most of the benefit.

### Running a plan

- **Run** (or **Continue**) runs the first step that's pending or not done,
  then the next, until every step is done or one stops. A disputed step (**?**)
  waits for you, so there's no **Continue** until you mark it done or rerun it.
- Each step is one turn: chat sends "Do step 2 of 4: …" with the plan so far,
  and the model works on that step only, with all its tools.
- Then chat **checks** the step: one more call to the model, with no tools,
  given the step, **every file any step of the plan wrote or edited, in any
  run, whole, as it is now**, the changes made during it (for each change you approved, the diff
  you saw; each change cut at 12,000 characters, all of them at 24,000), and
  the reply.
  - Whole files, because diffs alone misled the check: a hunk hid a
    function's first line, so its parameter looked undefined, and a rerun's
    changes were only its fixes, so a route the first attempt wrote looked
    missing. Code that's in the file counts, whoever wrote it. Other runs
    and steps count too: a step whose work was already done (by a rerun, or
    by an earlier step) changed nothing, and the check, seeing no file, said
    the file was never created.
  - The files get half the model's context (its context size from the
    server, or 32,000 tokens if it's unknown, at about 4 characters a
    token). Files that don't fit, or can't be read, aren't cut or swapped
    for the diffs: a check that can't see the code guesses. Instead the step
    gets ✗ with "Couldn't check this step: server/x.ts (~N tokens) is too big
    for the check…", the plan stops, and the model gets a planning turn to
    propose a plan change, such as splitting the step, which shows under the
    plan for you to accept or not.
  - chat reads the files with `read_file` under a chat id of its own
    (`<chat>:check`), so they don't count as read by the model for the
    read-before-edit rule. It answers
  `DONE` or `MISSING: …`. The check uses the chat's **Think** setting, and
  works much better with it on.
- **Not done**: the model gets one retry, which starts by asking whether the
  check is right. The check is a model too, and it gets things wrong: seeing
  only diff hunks, it once called a function parameter "undefined". A small
  model told it failed tends to agree and "fix" what isn't broken. So the
  retry asks it to read the files with `read_file`, quote the lines that
  settle it in a code block, and end with `STEP NOT DONE` (the check is
  right) or `STEP DONE` (the check is wrong) before changing anything
  (`disputePrompt` in `src/Plan.tsx`). The answer is about the step, since
  asked for "CHECK RIGHT" or "CHECK WRONG", the model showed the step was done
  and then wrote "CHECK RIGHT".
  - **Check right** (or no answer): it fixes the step, and the step is
    checked again. Still not done, and the step gets ✗ with "Not done: …"
    under it, and the plan stops.
  - **Check wrong**, with evidence: it read files during the step (in the
    step's turn or the retry), quoted lines,
    and every quoted line is in what it read (`weighDispute`; inline code
    under 12 characters doesn't count, since any name is found somewhere).
    The step gets **?** with both sides under it, and the plan stops for you:
    hover the step and mark it done, or rerun it.
  - **Check wrong**, without evidence (no read, no quotes, or quotes that
    aren't in the files): the step gets ✗, with a note saying what was
    missing. It's the model's word against the check's, so it doesn't count.
  - **Check wrong**, but it changed files anyway: the step is checked again,
    as if it had agreed.
- **Stopped or failed**: if you press **Stop**, or the reply fails, the step
  goes back to pending (with "The reply failed: …" if it did) and the plan
  stops. **Continue** picks it up again.
- While a plan runs, you can't send messages or switch chats.

### Who marks a step done

Only the check. The model writes only the steps' text: statuses it sends are
ignored. When it calls `update_plan` again, a step keeps its status (and its
note and history) only if it's the same step as before:

- **While the plan runs**, the step in the same position. The model may
  reword the step it's on, or add steps at the end.
- **Otherwise**, the step with exactly the same text. A reworded or new step
  starts pending.

A plan that's under way (some steps have run, some aren't done) isn't changed
by the model outside a run, in a planning turn or not. Its `update_plan`
becomes a suggestion under the plan, with new steps marked + and dropped
steps struck out, and **Use this plan** or **Keep the plan**; the model is
told it only proposed. This came from asking the model about a failed step:
it "proposed" a fix by sending only that step, which deleted the other 7.

### Where plans show

A plan card shows in the chat right after the turn that wrote it, and stays
there as you scroll; later messages go below it. A step's messages show under
the step, not in the chat.

- Once every step is done, the plan is finished and read-only: no step
  buttons (rerun, edit, remove) and no **Cancel plan**. Nothing in it runs
  again. To redo it, **Clone** starts a new plan with the same steps, all
  pending, at the end of the chat; the original stays as it ran. Clone shows
  only while no other plan is unfinished, since the clone would replace it,
  and not while anything runs. Or send a message and the model writes a new
  plan.
- When the model writes a new plan, a finished one stays where it is, and
  the new one shows after its own turn. Its steps all start pending, even
  ones with the same text as a done step.
- A plan under way keeps its place when it changes: a suggestion you accept,
  or a change the model makes during a run. A plan that hasn't started yet,
  rewritten by the model, moves to the turn that rewrote it.
- A plan in a chat saved before plans had a place is pinned after the last
  message when the chat opens, so new messages go below it. A plan whose
  turn is compacted away moves to the top, where that turn was.

### Cancelling a plan

**Cancel plan** on the card asks first, then removes the plan. If it's
running, it stops the step first. The steps' messages stay in the chat, and
what they changed stays changed; finished plans above it stay too. A
finished plan can't be cancelled.

### Step times

A finished step (done, not done or disputed) shows how long it took in small
print under it, and **Total** at the bottom of the plan card adds them up.

- A step's time runs from its "Do step" message until its check finishes: the
  reply, the check, and any retry and second check. It's wall-clock time, so
  waiting on an approval prompt counts too.
- Running or rerunning a step clears its time until it finishes again, and
  editing a step's text clears it.
- The times are saved with the plan, so they're there after a reload.
- They read like reply times: "2.8s" under 10 seconds, "42s" under a minute,
  then "1m 05s".

### Rerunning and editing

- **Rerun** a done or not-done step to run it again on the files as they are
  now. The done steps after it are marked "An earlier step changed; this may
  need a rerun", since they were built on the old version.
- **Editing** a step's text makes it pending again.
- The step's earlier messages stay with it, so its history shows every run.

### Where the step messages go

A step's messages (the "Do step" message, the reply, its tool calls and any
retry) carry the step's id and don't show in the chat. Click the arrow next to
a step to see them. They're still sent to the model, so later steps know what
earlier ones did. The plan, with each step's status, is saved with the chat; a
step that was running when the page closed comes back as pending.

## Features

- **Saved chats**: each chat is saved to `~/.llama-mui/chats/` a moment after
  it changes, so reloading the page reopens it. The **Chats** panel on the
  left lists them newest first; click one to switch, **+** starts a new chat,
  and the trash icon deletes one.
- **Resend**: when a reply fails, your message gets a red outline and a line
  saying what went wrong (the reply was cut off, the llama server couldn't be
  reached, or it returned an error), with a **Resend** button. Hover the line
  for the raw error. A reply cut off by a reload or closed tab can still be
  resent after the chat reopens.

- Model picker from the active server's `/v1/models`, laid out like the Models
  page: each model's status, context and source, with ▶ / ■ to load or unload
  it. **Manage models** at the bottom opens Settings → Models, where models
  are also deleted.
- Models load only when you ask. A llama server in router mode would load a
  model on its own when a request names it, so before every request (a
  message, a plan step, its check, Resend) llama-mui asks the server whether
  the model is loaded, and sends nothing if it isn't: your message stays in the
  box, with a note to load it from the model menu. Opening an old chat picks
  its model, but doesn't load it.
- Streaming replies with a Stop button. Each step of a reply (thinking, tool
  calls) shows how long it took; hover for token counts. Hide the steps in
  **Settings → Chat** to see just the answers.
- The chat follows new output while you're at the bottom. Scroll up to read
  back, even while a reply streams, and it stays put; a down arrow at the
  bottom jumps to the latest and follows again, as does scrolling back down or
  sending a message.
- While a reply runs, a counter next to the waiting dots shows how long it's
  taken, with the speed it's streaming at; during a plan run it's on the plan
  card. A finished reply keeps the total in small print, for example
  "2.8s · 52 tps (client) · 58 tps (server)": the client speed is what reached
  the browser, the server speed is llama.cpp's own figure for generating it. A
  big gap means the server was slow to deliver (say, while loading another
  model), not the model slow to generate.
- Messages render as Markdown, yours and the model's: bold, lists, tables,
  links (opened in a new tab) and code blocks with a Copy button. Text inside
  ``` blocks shows exactly as typed, and images show as links instead of
  loading. In your messages a single line break stays a line break. Turn it
  off in **Settings → Chat** to see the raw text, or switch one message with
  the **<>** button in its bottom-right corner.
- Context indicator under Send ("98% left"), orange then red as the window
  fills. Click it for tokens used of the model's window, generation speed and
  **Clear context**: the model forgets everything so far, but the transcript
  stays on screen, dimmed, under a divider. **New chat** clears both. Turn the
  indicator off in **Settings → Chat**.
- **Think before answering**, per model in **Settings → Models** (off by
  default): off sends `chat_template_kwargs: {enable_thinking: false}`; on
  shows the model's reasoning in a collapsible panel. Saved by model id, so it
  follows the model to any server, and it's what chat uses. With it off,
  small models like Qwen 9B rarely call tools, so switching **Tools** on with
  Think off asks whether to turn Think on, and **Settings → Tools** warns
  about models that have it off.
  With it on, chat decides per request: a reply's first request thinks (where
  the model decides what to do), later rounds after tool results don't, and
  planning turns don't. A plan step's check still thinks. Qwen3.6 spent
  minutes per planning turn thinking, nearly all of it between file reads,
  and switching thinking per request doesn't cost anything in the server's
  prompt cache.

## Models management

**Settings → Models** shows the models currently on the selected llama server.
Each model row displays:
- The model id and its status (loaded, loading, unloaded), and where it comes
  from: "preset" (the server's preset file) or "cache" (downloaded)
- The context it runs with, in tokens: what the server reports for a loaded
  model, or the `--ctx-size` it starts with. It's "n/a" when the server doesn't
  say: an unloaded model with no `ctx-size` in the server's presets starts with
  llama.cpp's default (4096), not the context the model was trained for.
- A trash icon to delete a model the server downloaded (with confirmation).
  Models defined in the server's preset file can't be deleted, and a loaded one
  has to be unloaded first.
- ▶ / ■ to load or unload it. The server does it in the background, so the
  page asks again each second until the status changes.
- A **Think** switch to enable reasoning mode for that model, explained right
  under the list

A model's context and other settings come from the server's preset file
(`--models-preset`); the load API takes only the model's name. For a context
on every model, set it in the file's `[*]` section, for example
`ctx-size = 131072`.

You can also **Search Hugging Face** for GGUF models:
1. Enter a model name (e.g., "llama-2", "mistral", "qwen") and press Enter or
   **Search**
2. The 20 most downloaded matching GGUF models show, each with its owner,
   downloads and likes
3. The download icon at the end of a result downloads it to the server
4. The downloaded model appears in the model list and can be loaded/unloaded

The search goes through our server to Hugging Face's API. Its results don't
include an author, so the owner comes from the model id ("owner/repo").
