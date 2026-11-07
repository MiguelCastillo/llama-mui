# llama-mui: the full guide

How llama-mui works, in detail. The [README](../README.md) is the short version,
and [AGENTS.md](../AGENTS.md) is for changing the code.

## Settings

Settings are saved in `~/.llama-mui/settings.json`, outside the project and
readable only by you (older versions kept `settings.json` in the project
folder; it's moved on first start). The servers' API keys are not in that file:
they are encrypted (AES-256-GCM) in `~/.llama-mui/.keys`, and the random key
that unlocks them is in `~/.config/llama-mui/secret.key` (under
`AppData\Roaming\llama-mui` on Windows), outside `~/.llama-mui`, so copying or
backing up `~/.llama-mui` doesn't copy usable keys. On a server or in a
container, set `LLAMA_MUI_SECRET_KEY` (32 random bytes, base64) instead of the
file. Like `ssh` with a private key, llama-mui refuses a `secret.key` that other
users can read and tells you the `chmod 600` to run. If the unlocking key is
lost, Settings asks for the keys again; keys from an older `settings.json` are
moved into `.keys` and checked on the first start. This doesn't stop a program
running as you that can read both places.

The `/api` is served by `server/plugin.ts`, a Vite plugin that runs under
`npm run dev` (Vite, port 5174), and by `server/main.ts`, a plain Node server
that serves the built `dist/` and mounts the same handler. `npm run prod` and
`npm run prod:lan` build the client and start it on port 5173; an edit to the
source never restarts it, which is why day-to-day use is there and dev is on
its own port. Set `PORT` or `HOST` to change where it listens. Ctrl+C stops
accepting requests, gives open ones 5 seconds, then exits (a second Ctrl+C
exits at once). Both servers use the same `~/.llama-mui`, but a run lives in the
memory of the process that started it, so don't open and run the same chat in
both at once. A run records which process owns it, and a server starting up
leaves the runs of another live process alone instead of marking them
interrupted. The handler refuses requests from other websites
(by their `Origin` and `Sec-Fetch-Site` headers): any page open in your browser
can send requests to localhost, and without that check one could run the
model's tools, commands included, on its own.

**Using it from your phone.** By default the server only listens on this
computer. Start it with `npm run prod:lan` (it serves the built app on every interface; `npm run dev:lan` does the same for Vite) and it
listens on your network too. Nothing else on the network is let in until it is
paired: in **Settings → Phone**, **Show QR code** makes a code for one phone,
good once, for five minutes. Scan it with the phone's camera; the phone opens
llama-mui and is signed in with a cookie that lasts a year. Requests from this
computer itself need nothing, as before; any other device's `/api` request is
refused (401) without that cookie, and only this computer can make codes or
manage devices (a paired phone can't pair more phones). Paired devices are
listed in the same place with a button to sign each one out. Only a hash of
each device's cookie is saved, in `~/.llama-mui/devices.json`; the code itself
is kept in memory and goes after the `#` of the address, so it isn't sent to
the server in a request line or logged. Things to know:

- **It's plain `http`.** Someone on the same network could see the cookie, so
  use it on a network you trust (your home one), not a shared Wi-Fi. For
  anywhere else, put it behind HTTPS (Tailscale's `serve`, say): requests that
  arrive through a proxy on this computer say who they were forwarded for and
  are treated as another device, not as this computer, so they need pairing
  too.
- **Same network.** The QR code holds this computer's address on the network
  (Settings asks which one if there are several). If the router gives it a new
  address, make a new code; a phone paired under the old address pairs again.
  Guest networks that stop devices reaching each other won't work.
- **The page works over `http`.** Browsers hide `crypto.randomUUID` and the
  clipboard from pages that aren't `https` or `localhost`, so ids come from
  `src/uuid.ts` and Copy from `src/clipboard.ts`, which have fallbacks.
- Choosing a folder opens the system dialog on the computer, not the phone.

**Connectors** are the model servers chat talks to. Each has a **provider**,
chosen when it's added, which decides its client, how its key is sent, and
what else it offers:

- **llama.cpp server**: a URL, an optional API key, a name, and the **Chat
  API** chat speaks to it. It also has llama.cpp's own API beyond chat: the
  **Models** page manages its models (`server/modelAdmin.ts`). llama.cpp
  serves two chat APIs:
  - **Anthropic Messages** (`/v1/messages`), the default, through Anthropic's
    SDK (`@anthropic-ai/sdk`).
  - **OpenAI Chat Completions** (`/v1/chat/completions`), through OpenAI's
    SDK (`openai`). It also shows llama.cpp's own generation speed (from its
    `timings`), which the Messages API doesn't report.

  The key is the llama server's own (`--api-key`), sent as a bearer token with
  either API. Either way thinking is turned off with `chat_template_kwargs`:
  llama.cpp ignores the Messages API's `thinking: {type: "disabled"}`. And
  notes and chat updates go as text in the user's message: llama.cpp ignores
  `system` messages in the middle of the conversation.
- **Anthropic API** (`https://api.anthropic.com`): a key (required) and a
  name. Its models are the Claude models the key can use, listed on the
  **Models** page and picked in chat; there's nothing to download or load. The
  key goes as `x-api-key`. With **Think** on, Claude thinks adaptively and
  shows a summary; off, it isn't asked to (Opus 5.5 may still think briefly,
  unseen). Each request asks for prompt caching, since a tool loop resends the
  whole conversation every round. A reply Claude declines (`refusal`) ends with
  a message saying so. It costs money per token, and the chat goes to Anthropic.

A reply with signed thinking (only Claude signs it) keeps its content blocks
exactly as returned and is sent back as they were: Claude takes back its
thinking only unchanged. Other replies are rebuilt from their text and tool
calls, without thinking (llama.cpp's signatures are empty, and Qwen's chat
template drops earlier thinking anyway).

`streamChat` in `src/api.ts` picks the API by the connector, and the options
by its provider; `toMessages` and `toWire` turn the chat into each API's
shape, so everything that calls `streamChat` (`src/agent/agent.ts`,
`src/agent/plan.ts`, `src/agent/sessionNaming.ts`) works the same with any.

Chat uses the selected connector. The plugin proxies chat requests at
`/api/c/<id>/v1/...` to that server with its key, so keys never reach the
browser (the SDK in the browser has a placeholder the proxy replaces).

**Tools** are things the model can do while answering, grouped by what they
reach and switched on or off one by one (`server/tools.ts`), in **Settings →
Tools**. The model can use every tool that's on. **Use tools** at the top of
that page turns the whole set off or on: off, chat runs without tools and the
page dims the list, but each tool's own choice is kept for when it goes back on
(saved as `toolsEnabled` in `settings.json`). There is no switch for this in
chat. Tool calls and their
results show in the reply.

**Models** lets you manage the models on the selected llama server. It shows
the models in the server's cache with their status (loaded/unloaded), and you
can load, unload, or delete them. It also lets you search Hugging Face for GGUF
models and download them directly to the server.

The **Plan** group (`server/plan.ts`) has `update_plan`, which the model
uses to write down the steps of a task that changes files. Chat runs those
steps one at a time and checks each one; see [How plans work](#how-plans-work).

The **Todos** group (`server/todos.ts`) is for things you want to come back
to ("I'm thinking about changing X, can we add a todo for it?"), which are not
plans: no order, no run. `add_todo` saves a one-line summary the model writes,
a description in your words, and the model's own notes on the conversation so
far (`context`, written in the same call, so a thread started later has it), `list_todos` answers "what's on my list?", and
`complete_todo` marks one done. Todos are saved in the session's `session.json`
(`todos`), so copying that file carries them; chat applies each call to the
session, as it does for `update_plan`, since the server never writes that file.

A plan's last step is told to say in a sentence or two whether it all worked
(paths, branches or commands only if you need them next), and to add a
"Follow-up:" line only when something must happen after (restart the server,
commit, answer a question). Once every step is done the plan card shows that
reply under the checkmarks as **Result**, open, as text you can select and
copy. It is the last step's reply, not the chat's last message. A plan that
worked doesn't list its results; one that didn't says what went wrong and
what to do next. When the session worked in a
git worktree, a line under the Result says where that work lives (see
Worktrees, below: "In worktree ui-updates (llama/ui-updates): 5 files
uncommitted, 2 commits not on main", or "all committed and on main").

Threads run a plan apart from the chat, in parallel, so the chat stays on the
main train of thought with you and keeps the thread's details out. It pulls
only what it needs, in tiers that each cost more than the one before:

1. **Always there, free:** the note's report and the "Chat update" with each
   ended thread's outcome. The report is written from the plan's real result
   (the overview below), not from the last thing said in the thread, which can
   be a check's "STEP NOT DONE" line.
2. **`read_thread`, no request to a model:** an overview of the thread, in this
   order: `Thread:` (its summary); `Outcome:` SUCCESS, FAILED or NOT FINISHED;
   one line per step with its state, how long it took and its note; `Result:`
   (the plan's result when every step is done, otherwise the last words of the
   first step that isn't); `Next:` for a thread that failed, was disputed, is
   waiting for an answer or didn't finish (open the thread, and Continue after
   fixing or answering); `Files changed:` (or "none"); and the worktree lines.
   A git read that fails leaves the worktree lines out. Verdict lines ("STEP
   DONE", "STEP NOT DONE") are dropped from the result.
3. **`read_thread` with `step` (the step's number, from 1):** that one step in
   detail instead of the overview: its text and state, its replies, and what
   its commands and reads printed. A number out of range or missing answers
   with the valid numbers.
4. **`summarize_thread`, costs money:** the whole thread goes to a model that
   writes a digest; `focus` says what the chat needs from it.

Every answer is size-capped, so details can't flood the chat. The overview is
at most 4000 characters: the outcome, the result (its last 1500 characters),
the `Next:` line and the note of the step that went wrong (800) come first,
then the other steps (notes cut to 200), then the files and worktrees. When
something is left out, the last line says how to get more: `step` for one
step, or `summarize_thread` with a `focus`. A step's detail is at most 6000
characters; when it is longer the start is cut, since what the step said and
ran last explains how it ended, and the answer says it was cut. The limits are
named constants in `server/threads.ts`.

The chat's model doesn't wait to be asked: when a thread ended failed or not
finished, or its report hints at trouble (a step not done, a check failed or
disputed, something unconfirmed, nothing committed), it reads the thread on its
own, then states the outcome and what to do next (a plan, if files must
change). It calls `read_thread` with `step` only to see why one step went
wrong, and `summarize_thread` only when it needs a digest. It never says it
doesn't know what a thread did without reading it. Both tools are read-only,
so side questions can use them too.

`summarize_thread`: the thread's own model is given the whole record of the thread (what was said,
every tool call and its result) in one request with no tools, and asked to
write what the chat needs: what was done and found, decided, the paths and
branches, and what is left, ending with a "Follow-up:" line for what still has
to happen (restart or refresh the server, run a command, commit, answer a
question) or "Follow-up: none". The model can say in `focus` what it most needs
("the branch name and what failed"). So the chat gets a summary as long as it
needs to be, never the thread's raw messages and never a cut of them, and
nothing is written to the thread. It works only on threads this chat started
(found from the chat's saved session, not from anything the model passes); with
several it asks which, and a running thread answers that it is still running.
If the request fails (the model is unloaded, or it takes over three minutes),
the answer gives the steps and the short report and says the summary couldn't
be written. The thread's model is the thread's own, asked through the chat's
server. This is how the model gets more than the short report in the note and
the "Chat update".

The **Disk** group (`server/disk.ts`) has read-only tools: `list_directory`,
`read_file`, `find_files` (names, with `*` wildcards) and `grep` (regular
expressions over file contents). They read only the chat's working directory
and what's attached to it.

**Session settings** (the sliders icon next to the message box) has three
sections: Working directory, Attachments and Approvals. A new chat starts with
none of them set.

- **Working directory** is the folder relative paths and `run_command` start
  in, and the system prompt names it. It's a setting of the chat, separate
  from the attachments. The model never picks it, and attaching a folder
  doesn't make it the working directory; the one way a folder becomes it
  without you opening these settings is a choice you make in the model's
  "find this folder" prompt (see below). Choose it here with **Choose folder…**
  (one folder; files aren't offered) or pick one from **Recent**. Choosing
  another folder replaces it, and the old one isn't kept as
  an attachment. **Clear** removes it. Under **Recent** are the last five
  folders you chose, each with its path on the right (newest first; kept on the
  server in `~/.llama-mui/recent-folders.json`, so every browser sees the same
  list; one that no longer
  exists is left out), and clicking one sets it. The folder's **check command** (see
  [How plans work](#how-plans-work)) is set here too. With no working
  directory, relative paths fail with "Use an absolute path", and the model
  is told "There's no working directory: use absolute paths." even if a
  folder is attached.
- **Attachments** are the extra files and folders the model may read, each
  marked with whether you added it or the model asked for it, and buttons to
  choose more files or folders. The model can read the working directory and the attachments;
  only the working directory is where relative paths start.
- **Approvals** has a switch for approving all file changes and one for approving
  all commands, for this session only (see "Approving for a session" below):
  a prompt's "Approve all ... in this session" button turns them on, and they
  can be turned off or on here, also while a plan or reply is running.

Chats saved before the working directory was a setting are converted when
they're read: their first attached folder becomes the working directory and
leaves the attachments, and the next save writes it that way. Nothing else
about them changes.

When the model asks for a path that isn't the working directory or attached,
the reply pauses on an Allow / Deny prompt; allowing attaches it for the rest
of the chat (never as the working directory: nothing the model asks for
changes it), and denying tells the model no.
When the path doesn't exist but its own folder does (a file the model is about
to create, say), it is the same Allow / Deny prompt, for that folder: the file
not being there yet is expected, and what is missing is access.
When nothing exists at the path or in its folder (the model guessed), the
prompt says "File not found" or "Directory not found" and offers to choose the
right file or folder in the system dialog instead: whatever you pick is
attached, and the model is told to use it.
When you name something without its path ("find llama mui"), the model calls
`locate_path` instead of guessing, and the reply pauses with the same Choose
file / Choose folder buttons, and, for a folder, the Recent list.
When the chat has no working directory, a folder asked for this way comes
with a checkbox, "Make it the working directory", ticked: choosing a folder
(Choose folder… or one under Recent) then makes it the working directory
instead of attaching it, so `run_command` and relative paths start there for
the rest of that reply and every one after it, and the model is told so (the
next message carries "The working directory is now …"; the system prompt, fixed
at the first reply, is not rewritten). Untick it and the folder is attached as
usual. With a working directory already set there is no checkbox and the
folder is attached; a file is always attached. This is the user's choice only:
the model's own requests never change the working directory.
The server re-checks the attachments on every call, and every path the model
sends is checked against them after resolving symlinks and `../`. Searches
skip symlinks, so they stay inside what's attached. `settings.json` itself
can't be attached, read or searched, nor can `.keys` or `secret.key`.

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
before changing them. Files can't be deleted, and `settings.json`, `.keys` and `secret.key` can't be
written.

The **Worktrees** group (`server/worktree.ts`) has `create_worktree` and
`remove_worktree`. A worktree is a copy of a git repo's tracked files on a new
branch (`llama/<name>`), made in the session's own folder,
`~/.llama-mui/sessions/<id>/worktrees/<name>`. The repo has to be inside your
home folder and not inside `~/.llama-mui`. Turning the group on lets the model
create worktrees in that folder without asking, which also adds a branch to the
repo's own `.git`; it can only ever make them inside the open session's folder,
and with no open session it fails instead. You approve a worktree being removed,
not made. The model reads, writes and runs commands (pass the worktree as
`cwd`) in it with no prompts. That `worktrees/` folder is the only place the model may change
files unasked: the rest of a session's folder, `session.json` included, asks
like any other path. A worktree holds only what git tracks, so `node_modules`
and ignored files aren't there, and a committed secret is. Removing one is
refused if it has uncommitted changes, and keeps the branch and its commits;
deleting a session never removes its worktrees.

Where a session's work lives is read from git, by the server, and never written
by a model: `GET /api/sessions/<id>/worktrees` (`server/worktreeStatus.ts`)
answers, for each worktree the session created (found in its own `create_worktree`
calls that succeeded, so a worktree it didn't make, or a failed call, shows
nothing), its branch, how many files
are uncommitted (untracked ones too) and how many commits are not on the branch
checked out in the repo's own checkout. It is computed each time it's asked and
stored nowhere. The thread's note in the chat that started it shows it as a line
under the report, asked when the note shows and again when the thread's status
changes; the thread's own Result shows it once the plan has stopped. Nothing
shows when the session has no worktree, or its worktree was removed. A branch
that was squash-merged still counts its commits as not on main.

**Why you're asked.** Every approval prompt (a file change, a command, a
worktree removal, a page outside localhost) starts with a line, "Why: ...", with
the model's one-sentence reason in terms of what you asked for. The model fills
it in on the tool call and is told to always do so; it is cut at 200
characters. If the model gave none, the line reads "No reason given" in muted
text. The reason is the model's own account, not something the server checks, so
the command, diff, path or URL under it is still what you approve.

**Approving for a session.** An approval prompt has a button under Approve and
Deny that approves the same kind of thing for the rest of that session, so a
plan that makes ten edits or runs a dozen commands doesn't stop ten or twelve
times: **Approve all changes in this session** (every file change the tools
would ask about) and **Approve all commands in this session** (every command,
git or not; it runs as you, with your network access and credentials). There is
no special handling of git: a command is approved or it isn't. Removing a
worktree is always asked. The choice is saved in the session (`autoApprove` in
`session.json`), so a reload keeps it, and a new session starts without it; it
is not inherited by a thread. **Session settings → Approvals** shows what is
on, and its switches turn each off (or on, before any prompt). Only the question is skipped: the paths a chat
may reach and the files that are off limits (`settings.json`, the keys) are
checked as before, and an approved change still shows its diff in the chat.

The **Terminal** group (`server/terminal.ts`) has `run_command`, which runs a
shell command the model suggests, in the working directory, an attached folder
(or one you allow). With no working directory the model has to name the `cwd`.
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

The third Web tool is `inspect_page` (`server/inspect.ts`), for checking how a
page looks, as a person would. It opens a URL in a headless Chrome and returns
text: the page's title, its visible text and structure (headings, buttons,
inputs and links, with their names) and, if the model gave a `script`, the
JSON result of running that JavaScript in the page (say, the size of each
button). There is no screenshot, and nothing is clicked or typed. It uses the
Chrome already installed (found through `LLAMA_MUI_CHROME`, then the usual
places on macOS, Linux and Windows); llama-mui downloads no browser, and if
none is found the tool says to install Chrome or set that variable. Pages on
`localhost`, `127.0.0.1` and `[::1]` open without asking; any other site asks
you first, because a page can run code. Each call uses a new empty browser
profile that is deleted afterwards, the browser is closed even on an error,
and a call stops after 30 seconds. The reply is cut at 12,000 characters,
and says so.

### What the model is told

Besides your messages and its own replies, the model is told things in three
layers. Each has one rule, and new things go in whichever fits. The rules come
from llama.cpp's prompt cache: a request whose start matches what the server
already processed only processes the rest, so a change near the start makes it
reprocess everything after it (measured: about a minute for a 40k-token chat).

| Layer | What it holds | When it's sent | How long it holds |
|---|---|---|---|
| **System prompt** | What holds for the whole session: how to use each tool group, the plan rules, your home folder, the working directory | First in every request, and never changed in a session, except when you clear the context | The whole session |
| **Chat update** | Facts about the session that changed since: other attachments, a new working directory, tools turned off | After your next message, only when the facts changed | Until the next chat update replaces it |
| **Note** | An instruction for one turn: the planning note (see [How plans work](#how-plans-work)) | After the message it's for | That turn only |

- **The system prompt** (`toolsSystemPrompt` in `server/tools.ts`) is the
  same in every session except its last line, the working directory, so a new
  session reuses another's cached start; that line has to stay last. The tool
  list, which comes before it, lists every tool, even ones that are off, and a
  call to one that's off fails with "turned off in Settings". The line before
  the working directory names your home folder, which is the same in every
  session; without it a model with nothing attached guessed paths like
  `/home/user`. The working directory is fixed by the session's first message:
  if you pick another one later, a chat update says so. Clearing the context
  makes the model reprocess its history anyway, so that is when the prompt is
  brought up to date: it names the working directory as it is then.
- **Your instructions** are a plain file, `~/.llama-mui/instructions.md`,
  edited in Settings → Agent. Its text goes in the system prompt after the tool
  instructions and before the home folder. Without the file the default
  applies: after a commit the agent runs `git --no-pager show --stat --oneline
  HEAD` and tells you which files went in. An empty file means no extra
  instructions, and "Reset to default" deletes the file. Unlike the working
  directory it isn't fixed per session, so a change applies from the next
  message and makes the model reprocess the start of that chat once.
- A path the model made up, where neither it nor its folder exists, is answered with an error
  that tells it to use `locate_path` or ask you, for its first two such guesses
  in a session; only a model that keeps guessing is brought to you with the
  prompt for pointing it to the right file. Any call that works starts that
  count over (`runTool` in `server/tools.ts`).
- **Chat updates** (`chatUpdate` in `server/tools.ts`) and **notes**
  (`PLANNING_NOTE` in `src/agent/plan.ts`) both go after your message's text and
  aren't shown, and both are saved with the message, so later requests send
  the same text and keep matching the cache. They differ in meaning: a chat
  update is a fact the next one replaces ("Also attached: a, b", later "Also
  attached: a, b, c"), while a note applies only to its own turn.
- Attaching a folder mid-chat used to rewrite the system prompt and reprocess
  the whole chat. As a chat update it costs only the new message: measured,
  144 tokens processed.
- To see what was sent with one of your messages, click the note icon under
  it.

## How plans work

Small models often say they're done when they aren't. A plan makes the work
visible and checked: the model writes the steps, chat runs them one at a time,
and a step only gets its checkmark when a separate check agrees it's done. The
code is in `src/agent/` (`plan.ts` for the prompts and the check, `agent.ts`
for `runPlan` and the turn loop), the plan card in `src/PlanView.tsx`, and
`server/plan.ts`. The logic in `src/agent/` has no React and is tested with
vitest (`npm test`).

### When a plan is made

- Planning is on whenever the **Plan tasks** tool is on in **Settings →
  Tools** (it is by default); there is no switch for it in chat.
- With it on, nothing forces a planning turn and no reply is limited to
  reading. **The model decides by size**: simple work that can be done in one
  go (one small change, or a command or two) is done right in the chat, and
  you approve each change or command; work that needs several steps, touches
  several files or needs checking along the way becomes a plan. If the model
  starts and finds the work bigger than it looked, it stops and makes a plan.
  Questions need no plan. A main-chat reply still skips thinking, as before.
- Your message gets a note, sent to the model after it but not shown. It
  starts: "If this message is a question or otherwise doesn't change files,
  just answer it, and don't mention plans." Then comes the rule text from
  `workPolicy` (`src/agent/workPolicy.ts`): decide by size, do simple work in
  the chat, make a plan for work that needs several steps. The question case
  comes first: led by "only plan", the model began its answers with "This is
  a question, not a file change request", replying to a note you never see.
  The rule's wording lives in that one file, so it can later be made
  configurable; nothing reads a custom value yet.
- The model is offered every tool in the main chat, and none is refused for
  being a write. Commands and file changes reach the normal approval prompt,
  so nothing runs or changes without you. A **side question** asked while a plan runs
  is different: it can't ask for approval, so it only gets the read-only
  tools (`ASIDE_TOOLS` in `src/agent/plan.ts`: the read tools, the web tools
  and the thread tools) and never `run_command`.
- **Command prompts in the main chat** are labelled. `run_command` has an
  optional `read_only` argument the model sets to true only when the command
  just looks and changes nothing (`git log`, `git status`, `git diff`, `ls`,
  `grep`, `cat`). The prompt shows it next to the "Why" line as **Looks
  only**, **Changes things**, or **Not stated by the model**. The label is the
  model's claim, not a check: the prompt still appears either way, and
  nothing is blocked by it.
- Command and file-change prompts offer **Allow**, **Deny** and **Make
  plan**. Make plan runs and writes nothing: the model's tool result says the
  user wants this as a plan, so it calls `update_plan` with the steps, this
  command or change included, and stops. It is how you turn simple work into
  a plan when the model chose to do it in the chat. The button shows only for
  a command or file-change approval while the open run is a chat turn
  (`canMakePlan` in `src/approvalWhy.ts`). Approvals of a plan's own run, and
  the ones in a thread's notes, have only Allow and Deny.
- Why it's done that way: llama.cpp reuses its cache for the part of a
  prompt that matches the last one from the start. Putting the note in the
  system prompt, or offering fewer tools, changed that start, and the server
  reprocessed the whole chat on every message (measured: about a minute
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
  - **The model explains the plan in plain words first.** The tool's
    instructions (`planInstructions` in `server/plan.ts`) tell it to write two
    or three plain sentences before calling `update_plan`, as if to someone who
    hasn't read the code: what is wrong or missing as you see it, what will
    look or work differently afterwards, and what stays the same, with no file
    or internal names unless you used them. That text is the chat message above
    the plan card. The plan's one-sentence summary says the same effect, and
    step summaries use everyday words. The instructions and the tool's
    "Plan saved" result also ask for a plain wrap-up after saving, pointing at
    the plan; but because the turn ends as soon as the plan lands (above), the
    model gets no round to write it, so the explanation before the call is the
    one you can count on.
  - **It does the work in the chat**: it calls the tool, you get the
    approval prompt, and nothing happens until you allow it.
  - **It answers instead**, which is what it should do for a question: you
    get the answer and no plan. A small model may still plan something
    simple, or do in the chat something it should have planned; **Make plan**
    and **Deny** are there for that.
- Messages that don't get the note: **Resend** of a failed message, and the
  "Do step" messages chat sends while running a plan. With **Plan** off, the
  system prompt still suggests a plan, but the note isn't sent, and small
  models usually don't write one.

### How many steps

- **The model decides**, when it writes the plan. Its only guidance is the
  tool's instructions: each step is "one change you can make in one turn,
  written so someone could check it from the diff alone".
- **Limits**: at most 12 steps, each at most 600 characters, and none empty.
  A plan over a limit is refused with an error such as "at most 12 steps;
  merge some", and the model has to try again.
- **Summaries**: every step also has a short `summary`, a to-do line of about
  8 words (at most 80 characters) such as "Make a stuck step retry twice", in
  everyday words, and the plan can have a one-sentence summary of its own that
  says what will be different for you. The card shows the
  summary as the step's main line, with the full instruction at the top of the
  step's chevron (the same one that shows what happened); the model still gets
  the instruction when the step runs. Plans saved before summaries show the
  whole instruction instead, and the chevron has nothing extra to show for it. A step with no summary, or one over 80
  characters, is refused like any other limit.
- **You**: before or between runs, hover a step to edit its text or remove
  it. There's no way to add a step yet; ask the model for a new plan instead.
- Nothing checks the plan's size. A plan with one big step gets one check at
  the end, which loses most of the benefit.

### Running a plan

- **Run** on a plan that hasn't started (no step has run yet) doesn't run it
  in this chat. It moves it into a new nested session and runs it there (a
  thread); you stay in the chat, and the note appears where the plan was. Click
  the note to watch the thread. The thread gets the request that led to the plan
  (the last message you sent before it, as its first message), the plan
  context and the plan, but not the rest of the chat. It has the same working
  folder and model, and is titled from the plan summary until the model names
  it. The chat you left keeps a note where the plan was (see
  [Where plans show](#where-plans-show)). A plan started inside a nested
  session makes its thread under that same session.
- **Continue**, **Restart** and **Answer and continue** on a
  plan that has started run it where it is. Only a first **Run** moves to a
  thread.
- A plan keeps running when you leave its session, and when you close or
  reload the page. Switch to the parent or any other session and chat there;
  the plan runs on in the server (see
  [Running in the background](#running-in-the-background)).
- **Run** (or **Continue**) runs the first step that's pending or not done,
  then the next, until every step is done or one stops. A disputed step (**?**)
  waits for you, so there's no **Continue** until you mark it done or rerun it.
  A step that asked you something (**waiting**, shown with a help icon) also
  stops the plan, but it counts as unfinished: answer it (below) or press
  **Continue**, which reruns it without an answer.
- Each step is one turn: chat sends "Do step 2 of 4: …" with the plan so far,
  and the model works on that step only, with all its tools.
- Each step starts with a **fresh context**: the model gets the step, the
  plan, the message that asked for it, the files earlier steps changed (to
  read what it builds on), and the step's own turns, retries included, but
  not earlier steps' turns or the planning discussion. With all of it, long
  plans filled the 64k context every step or two. Nothing is cleared: after
  the plan, your next message sends the session as usual. **Fresh context for
  each plan step** in Settings → Tools (under the Plan tool) turns it off, for comparing; it's meant
  to go away once it's proven.
- The plan may also include a `context` field: a brief description of the
  decisions, constraints, and other details from the conversation that each
  step needs (since each step starts without the chat). It shows collapsed
  in the plan card.
- Then chat runs the **check command** of the working directory, if it has
  one, once the plan has changed files. It's set per folder in **Chat
  settings**, in the Working directory section (for this repo,
  `npx tsc --noEmit -p .`), and kept for that folder in every session.
  Attached folders' check commands don't run. It runs without asking, unlike
  `run_command`: you typed it, and the model can't change it. It comes
  first because a failing typecheck or test is a fact, where the check
  below is a model's opinion, and its output says exactly what to fix:
  - **Fails**: the model gets the output ("After step 2, the check command
    `npx tsc --noEmit -p .` failed: … Fix what it reports") and one turn to
    fix it, and the command runs again. Still failing, the step gets ✗ with
    the first lines of the output, and the plan stops. In the first test,
    after a step that changed a tooltip, a planted type error elsewhere
    failed the command; the model fixed it from the output, and the step
    passed in 33 seconds.
  - **Passes**, or no folder has one: on to the check below. The command
    runs again after the check's retry, if there is one, since that may
    change files too.
  - A command that can't be run at all (the server failed) shows as an
    error and doesn't stop the step: it isn't the model's to fix.
- Then chat **checks** the step: a separate conversation with the model,
  with only the read-only disk tools (`read_file`, `grep`, `find_files`,
  `list_directory`), given the step, the changes made during it (for each
  change you approved, the diff you saw; each change cut at 12,000
  characters, all of them at 24,000), the reply, and **every file any step of
  the plan wrote or edited, in any run, as it is now**.
  - Files go in its first message whole while they fit in a quarter of the
    model's context (its context size from the server, or 32,000 tokens if
    it's unknown, at about 4 characters a token), the step's own first, then
    other steps'. The rest are listed, and it reads what it needs. It gets up
    to 8 rounds of reads, then answers without tools.
  - Whole files and reads, because diffs alone misled the check: a hunk hid a
    function's first line, so its parameter looked undefined, and a rerun's
    changes were only its fixes, so a route the first attempt wrote looked
    missing. Code that's there counts, whoever wrote it. Other runs and steps
    count too: a step whose work was already done (by a rerun, or by an
    earlier step) changed nothing, and the check, seeing no file, said the
    file was never created.
  - What the step's commands and reads printed, clipped to the end like the
    recovery prompt's (about 3,000 characters; left out when the step ran
    nothing). Command output counts as evidence: a test run, a git listing or
    a page measurement. Without it, a step whose proof was a command's output
    (a measured 16px, a commit listing) had no evidence the check could see
    and was marked failed although the work was done and committed.
  - Tools, because a check that only gets what fits couldn't judge big
    files: every step of a refactor touching `Chat.tsx` (~25,000 tokens) was
    "too big for the check", even one that only changed imports, and the plan
    stopped there. Nothing in it knows about languages; the check decides
    what to read, the way a stronger model would.
  - Its reads go through the same rules as the model's (attachments only,
    never the settings file), under a chat id of its own (`<chat>:check`), so
    they don't count as read by the model for the read-before-edit rule. It
    answers
  `DONE` or `MISSING: …`. The check uses the chat's **Think** setting, and
  works much better with it on.
- **Not done**: the model gets one retry, which starts by asking whether the
  check is right. The check is a model too, and it gets things wrong: seeing
  only diff hunks, it once called a function parameter "undefined". A small
  model told it failed tends to agree and "fix" what isn't broken. So the
  retry asks it to read the files with `read_file`, quote the lines that
  settle it in a code block, and end with `STEP NOT DONE` (the check is
  right) or `STEP DONE` (the check is wrong) before changing anything
  (`disputePrompt` in `src/agent/plan.ts`). The answer is about the step, since
  asked for "CHECK RIGHT" or "CHECK WRONG", the model showed the step was done
  and then wrote "CHECK RIGHT".
  - **Check right** (or no answer): it fixes the step, and the step is
    checked again. Still not done, and the step gets up to **2 recovery
    rounds** (below) instead of stopping the plan.
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
- **Recovery rounds**: a step that's still not done after the retry may be
  blocked by something outside it (a merge stopped by an uncommitted edit, a
  wrong branch), so the model gets up to 2 more turns (`MAX_RECOVERY_ROUNDS`;
  `recoveryPrompt` in `src/agent/plan.ts`). The prompt says what the check
  found missing and gives the last ~3,000 characters of what the step's
  commands printed, and asks it to work out why from that and fix it with safe,
  reversible actions (stash, switch branch, rerun). After each round the
  check command and the check run again. Not after a disputed step (**?**),
  which still waits for you as above.
  - **Fixed**: the step is done and the plan goes on.
  - **A question**: if the fix would discard someone's work or needs a choice,
    the model must not act and ends its reply with a line `QUESTION: …`
    (`parseQuestion`). The step becomes **waiting**, with the question as its
    note, and the plan stops. Type an answer under the step and press
    **Answer and continue**: the step reruns, and its prompt says "You asked: …
    The user answered your question: …", since a step doesn't see its earlier
    turns.
  - **Rounds used up**: the step gets ✗ with the check's own note,
    in its own words and never cut, and the plan stops.
  - **You can overrule a ✗ too**: the check is a model, so hover a failed
    step, as a disputed one, and press **The check is wrong: mark it done**
    when the work is there. The plan can then go on.
  - No round starts if the reply failed or the run was stopped.
- **Paused or failed**: if you press **Pause** on the card, or the reply
  fails, the step
  goes back to pending (with "The reply failed: …" if it did) and the plan
  stops. **Continue** picks it up again. A step's answer is kept.
- While a plan runs you can still send messages in its session: the message
  goes to the run, and a step sees it (see
  [Messages to a running plan](#messages-to-a-running-plan)). You can also
  switch to any other session and chat there. Switching is blocked only
  while a model turn you started in the open session is streaming.
- What a step asks you while it runs (approve a change or a command, allow a
  folder) shows in the plan card, under that step, and scrolls into view.
  At the bottom of the chat, it meant scrolling between it and the plan.
  If the plan's session isn't open, the plan waits instead: nothing pops up
  elsewhere, and its row in the sessions panel gets a small dot ("Needs
  you"). Open that session and the question shows as above.

### Running in the background

A plan runs in the server, not in the page (`server/runners.ts`, no React),
one run per session. Closing the tab, reloading it, or switching to another
session doesn't stop it: open the session again and it shows the run as it is.
The run uses the same code the page used to (`runPlan` and the reply in
`src/agent/` and `src/runnerReply.ts`), and holds the session as plain saved
data. It saves it (debounced, through the server's owner of the session: see
[Saved sessions](#features)) as it goes, and while it runs the page doesn't
save that session at all. The server stopping or restarting (`npm run dev`
restarting when a server file changes, or stopping it) ends every run, and
nothing starts again by itself: see
[After a restart](#after-a-restart).

- **Run** saves the session first, then sends a `run` command with what the
  page has chosen: the server (connector), the model, and whether Think
  is on. The server looks up the connector, its models and the tools
  itself. The API key never goes to the page and never into the run: the run
  talks to the server's own `/api`, whose proxy adds the key to the request.
- The page is a view. It listens to the server's events (`src/runClient.ts`)
  and shows the session as the run changes it: the saved copy first, then the
  run's own as soon as the event stream sends it. What you press goes back as
  an ordinary request (a command): `stop` (the card's **Pause**), `approve` (allow
  or deny) and `answer` (the files or folders you picked). Each is a `POST` to
  `/api/sessions/<id>/commands/<name>`, and answers `ok` or a 409 with a plain
  reason.
- **Two windows can't both run one plan.** The second **Run** is refused
  with "This plan is already running." The second window shows the same run,
  and **Pause** works from either.
- A question a step asks (approve a change or a command, allow a folder, find
  a file) is stored in the run as plain data: what is asked and a number for
  that question. The prompt in the plan card answers it by that number, so
  the first answer wins: an answer to a question that was answered already (in
  another window) is ignored. A question waits for as long as it takes, also
  while the page is closed; open the session and it is there, and the
  sessions panel's dot ("Needs you") shows while another session is open.
- Two plans, or a plan and a chat turn in another session, can run at the
  same time: nothing in chat holds a lock or a limit across sessions, only a
  second run of the same session is refused. Whether the requests then run
  side by side is up to the model server. A local one often handles one
  request at a time, so a second session's reply, or a side question, can wait
  in its queue until the request before it is done; it starts as soon as the
  server is free.
- **Pause** on the plan card shows only while the plan runs, in place of
  **Run** or **Continue**. It ends the run at once: it aborts the request, the
  step goes back to pending with the note "Paused", and the plan stays. The run
  is over, so a paused plan survives a server restart, and **Continue** picks
  it up again from that step (the step starts over; earlier steps' answers are
  kept). While a plan runs, the message box keeps **Send** (a message to the
  run) and has no Stop; it shows **Stop** instead of Send only while a chat
  reply streams (on a wide screen there is no button: press **Esc**).
- When the run ends (every step done, stopped, or failed), the page reads the
  session once more from the server. That is the session it shows and the one
  its next save is based on.
- While a plan runs the folders can't change: **Session settings** shows "Folders
  can't change while a plan runs. Pause the plan, stop the reply, or wait until it finishes." and
  turns off choosing and clearing the working directory, and adding and
  removing attachments. The run
  works in the folders it started with, and the server owns the session
  until it ends. A folder the model asks to use, and you allow, is still
  attached, by the run.
- **Discard plan** is on the card only while nothing runs. It asks first, then
  removes the plan; the removal is an ordinary save. If a run has started since
  the question was asked, it is stopped first and the page waits until it is over.
- Deleting a session that is running stops the run first, and so does a run in any session nested under it: the delete takes the whole family or none of it.

### Messages to a running plan

Type in the message box while a plan runs and the message goes to the run
(a `message` command), not to the model at once. A step starts with a fresh
context, so the run folds your message in at the next step boundary: after
the step in flight and its check are done and before the next step starts, it
joins the chat and is put in that step's prompt, and in every step after it.

- The answer comes straight away and says which step will see it. The box
  clears, and the chat shows the message with "Seen by step 3" under it once
  that step starts. Several messages before the same step all go in together.
- Nothing is queued silently. If no step is left to see it (the last step is
  already running, or **Pause** was pressed) the message is refused with a plain
  reason, and your text stays in the box: send it when the plan has finished,
  as an ordinary message.
- A message that was accepted but whose plan ended (stopped, failed) before
  another step started goes into the chat anyway, marked "No step saw this:
  the plan ended first", so the text is never lost.
- Your messages are part of the run's record (`notes`) while they wait, so a
  window opened meanwhile shows them. They hold only what you typed.
- A message to a thread is the same: open the thread and type there. Only the
  thread's run sees it; the chat that started the thread gets just the outcome
  and the report when the run ends.

### Side questions while a plan runs

A running plan doesn't block the chat. While a plan runs, the message box has
a small switch, **Ask** (the default) and **Tell the plan**.

- **Ask** sends a *side question* (an `ask` command): one reply, in the same
  session, answered while the plan keeps going. It sees the conversation so
  far, the plan and where it is, and is told that a plan is running. The
  question and the answer show in the chat under a "Side question" label, in a
  muted style.
- **Tell the plan** is the message to the run described above: it joins the
  chat at the next step boundary and the steps see it.
- The plan never sees a side question or its answer: they are left out of
  every step's prompt and history, so asking something can't change what the
  plan does. Once the plan has ended, later chat turns do see them, as part
  of the conversation.
- A side question can only read: it may list and read files, search, use the
  web and read threads, but it can't change files, run commands or edit the
  plan. If you want something done, say so in a message to the plan, or wait
  and ask in an ordinary message.
- One at a time per session. While one is being answered, a second is refused
  with a plain reason and your text stays in the box. The box stays usable
  while the answer streams; **Esc** or **Stop** ends only the side question and
  keeps what it had said. The plan carries on.
- With no plan running, **Ask** doesn't apply: the box sends an ordinary
  message. A local model server that handles one request at a time may make
  the answer wait behind the run's request (see above).

### When a reply is stopped for being stuck

A model that is stuck keeps calling tools without getting anywhere, which costs
time on your llama server (or money on a paid one). A count of rounds can't tell
that from a long job that is getting somewhere, so a reply is stopped for what
its calls did (`src/agent/progress.ts`), in plain words in the error:

- **The same output again and again.** Commands gave the same output 4 times in
  a row, whatever the commands were and whatever the model edited in between
  ("the last 4 commands all gave the same output (the last: `npx vitest run …`)").
  Colours and timings don't count as a difference, but a count does: 3 failed,
  then 2 failed, then 1 failed is progress.
- **Rounds with nothing new.** 6 rounds in a row where every call was a repeat,
  a read of a file that hasn't been changed since it was last read, or an error
  it had already got. A successful write or edit, a read after an edit, and
  anything it hasn't seen before count as news.
- **The same call three times.** The model asking for the exact same call (same
  tool, same arguments) a third time is refused, until something succeeds in
  changing a file or running a command, which starts the count again.

The reply then gets one last request with no tools, to say what it has; in a
plan the step goes back to pending and **Continue** runs it again. A plain
count of 200 rounds in one reply stays as a last backstop. It looks only at the
calls and results, and nothing about a language or a tool's output format.

### Chat replies run on the server too

A message to a session with no plan running is one chat reply, and it runs on
the server as well, as a run one reply long (`startTurn` in
`server/runners.ts`). So every session has one owner, whether you are chatting
in it or it is running a plan.

- **Send** (Enter on a wide screen, which has no button and uses Shift+Enter for a new line; on a phone the Send button, and Enter starts a new line) saves the session first, with the messages before this one, then
  sends a `message` command with the text and whether planning is on. A session
  the server already holds exactly as it is (it was just opened, or arrived from
  the server, and nothing changed) isn't saved again: a long chat is megabytes,
  and on a phone that was seconds with nothing on screen. From the tap until the
  message has gone, the box is read-only (and on a phone the button shows a spinner), and
  another tap or Enter does nothing; if the message is refused the text stays
  and the error shows. Nothing is checked on the page first: the server looks
  whether the model is loaded as it starts the reply, so a message is one
  request from the tap, and if the model isn't loaded, or is still loading, the
  reply says so ("isn't loaded, so nothing was sent" or "is still loading").
  What you have typed and not sent is kept in this browser, per chat (the
  newest 30), so a refresh brings it back; it goes when the message does. The reply
  streams back as events and shows the way a plan's steps do: the messages as
  they grow, the usage, the session's name when the model has written it, any
  question for you (a command to approve, a folder to allow) in the chat, and
  an error if the reply failed. Reloading or closing the page doesn't cut it
  off; open the session and it is still streaming.
- **Resend** on a failed reply cuts the failed reply off, saves the shorter
  chat, then sends the message again. A reply being written takes no second
  message: it is refused with "A reply is still streaming…" and the text stays
  in the box. **Stop** works as before; a chat reply has no **Pause**, only Stop.
- The reply is made by the same code as before (`runTurn`, the naming, the
  usage and the planning turns work as they did); only where it runs changed.

### After a restart

A run lives in the server's memory, so when the server stops, so does the run.
When it starts again it looks at every saved session whose file still says a run
was going (the `run` record in `session.json`), and settles each one, once:

- A step that was running goes back to **pending** with the note
  "Interrupted by a restart". An answer you had given it is kept.
- A question the run was waiting on is gone: nothing is left that could take
  the answer. **Continue** asks again if the step still needs it.
- A tool call that never got its result is closed with a result saying it was
  cut off, so the next request to the model isn't refused for it.
- A message of yours that no step had seen goes into the chat, marked as not
  seen.
- The chat shows the last reply as cut off (the same as a reload in the middle
  of a reply), and a chat reply that was streaming shows as failed, with
  **Resend**.
- The run's record is removed and the revision goes up by one. If the session
  was a thread, the note in the chat that started it says **Not finished in a
  thread**, with "The server restarted while this was running, so it stopped
  after 1 of 3 steps. Open the thread and press Continue to go on." No model
  is asked for that report.

Nothing starts again by itself: a plan someone wanted to keep running could
change files or spend a lot of time, so you decide. The plan card shows
**Continue** (it also does after a **Pause**, since a step was paused), and
Continue runs the plan where it is. A server that isn't restarted but is closed
while the same program goes on (`npm run dev` after a change to its config)
stops its runs first, as **Pause** does, so they end properly and are not left
running with no server.

### Who marks a step done

Only the check. The model writes only the steps' text: statuses it sends are
ignored. When it calls `update_plan` again, a step keeps its status (and its
note and history) only if it's the same step as before: the step with
exactly the same text. A reworded or new step starts pending, except that
while the plan runs, the step it's on may be reworded: it stays the step it
was, as the first new step whose text matches none of the old ones. Matching
by position once let a plan that dropped its finished steps hand their "done"
to the steps that took their places, which then never ran.

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
  buttons (rerun, edit, remove) and no **Discard plan**. Nothing in it runs
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
- When a plan runs in a thread (see [Running a plan](#running-a-plan)), a
  note takes its place in the chat, one note for each thread. While the
  thread's run is going it shows a spinner and **Running in a thread**, then
  the plan summary. When the run ends, the spinner goes away and the note
  says how it ended: **Done in a thread** (every step done), **Failed in a
  thread** (a step failed, or one didn't pass its check) or **Not finished in
  a thread** (stopped, or waiting for you). Under it is a short report of
  what happened: a sentence or two when it worked, with a **Follow-up:** line
  only if something is still to do (restart the server, commit); when it
  didn't, what went wrong and a **Next:** line with the move to make. Click the note to open the thread, with
  the chat scrolled to the plan.
- Pressing Run does not open the thread: you stay in the chat. When the thread
  needs you, its note shows the question with the same buttons the thread shows:
  approve or deny a command or a file change (with the command or diff), or
  allow a folder. The answer goes to the thread's session, the first answer wins,
  and the prompt goes away when it is answered in another window. A question
  the note can't show well (finding a file or folder) makes it say **Needs you**,
  with a button that opens the thread. Open the thread and its prompt works as
  it always did.
- The thread reports back by itself, even if you aren't looking at the chat or
  the page was closed when the run ended; the note is up to date when you
  open it. Only the outcome and the report are sent to the chat that started
  the thread; the thread's messages stay in the thread.
- The report is plain text under the note: select it and copy it as you would
  any text (the line above it is the button that opens the thread).
- The chat's model is told how each ended thread went: its next message carries
  a "Chat update" with the outcome and report of every thread that has one, so
  you can say "go on from what the thread found" and it knows. Each report is
  clipped to 400 characters there (ending "… (read_thread for the rest)"), so
  older long reports don't fill the chat, and the model is told to say a done
  thread is done in one line, without recapping it. (Like the other
  parts of the update, it is only sent when tools are on, and only when it
  changed since the model last saw it.)
- The report is written by the model that ran the plan, in one more request
  with no tools, once the run has ended. It is shown the thread's last message
  whole. If every step is done it says so in a sentence or two, with no list of
  results, and adds a follow-up line only if you must do something after. If
  not, it says what went wrong and ends with a "Next:" line (at most 600
  characters; a longer answer is cut there). If that request fails, or you
  stopped the run yourself, the report is a plain sentence made from the
  steps instead (for example "Step 2 failed. Open the thread to see what
  happened."). The note shows the outcome as soon as the run ends, and the
  report a moment later. Running the plan again (Continue or
  Restart) puts the spinner back and hides the old report until the new run
  ends.
- If the server restarts while the thread runs, the note says **Not finished
  in a thread** and that it was interrupted (see
  [After a restart](#after-a-restart)); open the thread and press
  **Continue**.
- The note is not kept up to date if you change the thread yourself later
  (say you mark a failed step done): it shows how the last run ended. A note
  made before notes had a report shows the thread's saved state, with no
  report. If the thread was deleted, the note says so.
- A plan in a chat saved before plans had a place is pinned after the last
  message when the chat opens, so new messages go below it. A plan whose
  turn is compacted away moves to the top, where that turn was.

### Pausing and discarding a plan

**Pause** on the card ends a running plan at once and keeps it: the step in
flight goes back to pending and **Continue** picks it up. A paused plan can wait
as long as you like.

**Discard plan** is for a plan that isn't running: it asks first, then removes
the plan. The steps' messages stay in the chat, and what they changed stays
changed; finished plans above it stay too. A finished plan can't be discarded.

### Step times

A finished step (done, not done or disputed) shows how long it took in small
print after its title, and the plan card's header adds them up ("Plan · 5 of 5
done · 13m 21s") once two or more steps have a time.

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

- **Saved sessions**: each session is saved to `~/.llama-mui/sessions/<id>/session.json`
  a moment after it changes, so reloading the page reopens it. Sessions with
  images also store them in `~/.llama-mui/sessions/<id>/images/`. Sessions saved in
  `~/.llama-mui/chats/` by earlier versions move there the first time the app
  asks for the list. The **Sessions** panel on the
  left lists them newest first; click one to switch, **+** starts a new session,
  and the trash icon deletes one.
  - **Two windows and the revision**: every time the server writes a session
    it counts up a `revision` number in `session.json` (a session saved before
    this has none, which counts as 0). A page remembers the revision it loaded
    or last saved and sends it with each save. If the session has changed since
    (another window saved it, or something else did), the server refuses the
    save with a 409 and writes nothing, so a window that is behind can't
    overwrite newer work. The page then loads the session again and says so:
    "This session was changed in another window, so it was loaded again.
    Changes made here since the last save were not kept." If a reply is still
    streaming in that window, it loads again when the reply ends. A save with
    no revision (an older client, or a new session's first save) is still
    taken. A session with a plan running on the server is closed to saves from
    the page: the server refuses every one with "A plan is running in this
    session", and the page shows the run instead (see
    [Running in the background](#running-in-the-background)).
  - **Two servers on one folder**: the dev server and the prod server both use
    `~/.llama-mui`, and neither knows what the other is writing. While a
    server reads and writes a session it holds a lock file,
    `~/.llama-mui/locks/session-<id>.lock` (`server/fileLock.ts`), and lets go
    when the write is done, so the revision check and the write after it can't
    be split by the other server. A save that finds the lock held waits up to
    3 seconds, then is refused with "Another llama-mui process is updating
    this session right now. Try again in a moment." A lock a crashed server
    left behind clears itself: it is taken over when the process that made it
    is gone, or when it is more than 30 seconds old. What the lock does not
    do: a server that starts up still settles every `run` record it finds as
    interrupted, including a run the other server has going, so start one
    server at a time when a plan is running.
  - **Live updates**: the server also streams what happens to its sessions as
    server-sent events (an ordinary request that stays open; the browser
    reconnects by itself). `GET /api/events` is for the list: it starts with
    the runs live now, then sends a `saved` event (the list row and the new
    revision) for each save or rename, `removed` for a delete, `status`
    when a run starts, asks something or ends, and `thread` when a
    thread's run ends and its note in the chat that started it changes (see
    [Where plans show](#where-plans-show)). The Sessions panel
    follows it, so a session saved or deleted in another window changes its
    row without reloading, and the list is read again after a dropped
    connection. `GET /api/sessions/<id>/events` is for the open session: it
    starts with the session, its revision and its run, then sends `status`,
    `step`, `ask`, `session` (only what changed: the changed fields and the
    messages from the first one that differs, at most about ten a second),
    `ack` (the step that will see a message you sent to the run),
    `thread`, `saved` and `removed`. A quiet connection gets a comment line every 15
    seconds. The events hold no API keys: keys stay encrypted in `.keys`, and the
    server never hands one to a run.
  - **Nested sessions**: the button beside the trash icon on each row makes a
    new, empty session under that one. It keeps the same working directory,
    attachments and model, but none of the messages. Nested sessions show
    indented under their parent, and only one level is shown: a nested session
    made inside another nested one appears under the same top-level parent. A
    small arrow on a parent hides or shows its nested sessions. Deleting a parent
    asks first and says how many nested sessions it holds; they are deleted with
    it, at any depth. While a plan is running in a session, the delete buttons
    of its whole family (the top-level session and everything nested under it)
    are off until it ends; the server refuses such a delete too, deleting
    nothing. A worktree in a deleted session's folder is kept. The link to the
    parent is saved as `parentId` in
    `session.json` and in the sessions list. Tools on/off is one setting for the
    whole app, so a nested session follows it. A plan that hasn't started
    also makes one: **Run** opens it in a nested session (see
    [Running a plan](#running-a-plan)).
- **Long messages fold**: a message of yours taller than about five lines shows
  its first lines in a box that scrolls, so you can read it all without
  unfolding; **Show all** (then **Show less**) sits under it, beside the
  formatted/raw toggle. Replies never fold, and a short message has no button. It isn't saved, so a
  reload folds them again.
- **Search and groups**: the box at the top of the Sessions panel filters the
  list by title as you type (**Escape** or the ✕ clears it). A session that
  matches keeps everything nested under it; one that only has a nested match
  stays, showing just those. On a top-level row, the folder icon moves the
  session into a group you name (**New group…**), into one that exists, or back
  out (**Remove from group**). Groups list first, A to Z, each with a count and
  an arrow that hides or shows it; sessions in none sit under **Ungrouped**
  (the header shows only once a group exists). A nested session follows its
  parent. A group is just a name on its sessions, saved as `group` in
  `session.json` and the sessions list, so it exists while a session is in it
  and is gone when the last one leaves. Searching opens every group.
- **Session naming**: after the first reply, the model is asked to name the
  session in 3–6 words. The name shows as the session title unless you give it
  one yourself. Hover the session and click the **✎** icon to rename it: a text
  field appears, press **Enter** to save, **Escape** to cancel, or leave it
  blank to fall back to the model's name.
- **Resend**: when a reply fails, your message gets a red outline and a line
  saying what went wrong (the reply was cut off, the llama server couldn't be
  reached, or it returned an error), with a **Resend** button. Hover the line
  for the raw error. A reply cut off by a reload or closed tab can still be
  resent after the chat reopens. A tool call that never finished (the page
  reloaded or the server restarted while it waited) gets a result saying it
  didn't run, when the session loads and before each request, so Resend works.

- Model picker from the active server's `/v1/models`, laid out like the Models
  page: each model's status, context and source, with ▶ / ■ to load or unload
  it. **Manage models** at the bottom opens Settings → Models, where models
  are also deleted.
  The picker is in the toolbar at the top right, which starts expanded on a
  wide screen and folded on a phone, so the chat is what you see first; the
  arrow on it folds or unfolds it, and the browser remembers what you chose.
- Models load only when you ask. A llama server in router mode would load a
  model on its own when a request names it, so before every request (a
  message, a plan step, its check, Resend) llama-mui asks the server whether
  the model is loaded, and sends nothing if it isn't: your message stays in the
  box, with a note to load it from the model menu. Opening an old chat picks
  its model, but doesn't load it.
- Streaming replies with a Stop button (on a phone) or Esc (wide screens). Each step of a reply (thinking, tool
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
- Context indicator (under Send on a phone; the share of the window used, "2%"), orange then
  red as the window fills. Click it for tokens used of the model's window, generation speed and
  **Clear context**: the model forgets everything so far, but the transcript
  stays on screen, dimmed, under a divider. **New chat** clears both. Turn the
  indicator off in **Settings → Chat**.
- **Think before answering**, per model in **Settings → Models** (off by
  default): off sends `chat_template_kwargs: {enable_thinking: false}`; on
  shows the model's reasoning in a collapsible panel. Saved by model id, so it
  follows the model to any server, and it's what chat uses. With it off,
  small models like Qwen 9B rarely call tools, so the note under the models in
  **Settings → Models** says so.
  With it on, chat decides per request: a reply's first request thinks (where
  the model decides what to do), later rounds after tool results don't, and
  main-chat replies with Plan on don't. A plan step's check still thinks.
  Qwen3.6 spent minutes per such reply thinking, nearly all of it between file reads,
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
  under the list (for the local models and for Claude, each in its own words)

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

## The server's log

llama-mui's server (the one `npm run prod` or `npm run dev` starts, not the page)
writes a log to `~/.llama-mui/logs/server-<day>.log`, one JSON object per line,
and keeps two weeks of it. It is for finding out afterwards why a reply was cut
off or a step "couldn't be checked". The server prints where today's log is, and
the `tail -f` command that follows it, when it starts. Each line has `t` (time), `pid` and `event`:

- `server.start`, `server.listening`, `server.shutdown`, `server.force-close`,
  `server.close`, `server.error`, `process.crash`, `process.exit`: the server's own
  comings and goings. A restart that cut replies shows up as a `server.close` or
  `server.shutdown` listing the requests to model servers still open (`upstream`).
  Vite restarting its dev server writes `server.close` and a new `server.start`
  with the same `pid`.
- `upstream.start` (only for requests that aren't GETs) and `upstream.end`: every
  request llama-mui forwards to a model server. `upstream.end` says how it ended in
  `outcome`: `done`; `client-closed` (whoever asked hung up: Stop, a closed tab, a
  stopped run, a shutdown); `upstream-error` (the model server's connection broke
  mid-reply: `error` and `cause` say how, and `idleMs` is how long it had been
  silent); `connect-failed` (never reached it). It also has `ms`, `headersMs`,
  `firstByteMs`, `bytes`, and `via` (`browser`, or `server` for calls llama-mui
  makes itself, which is what plan runs and chat replies are). A GET that went
  fine and fast isn't logged.
- `llama.watch`, `llama.down`, `llama.up`, `llama.model`: every 15 seconds the
  server asks each llama server for its models and writes a line only when
  something changed: it stopped answering, answered again (`downForMs` is how
  long it was gone), or a model's state changed (say `loaded` to `unloaded`, in
  router mode that's a model's process having stopped).

Read the log next to the llama server's own: an `upstream-error` at 21:23:10 and a
`llama.model` going `loaded` to `unloaded` at 21:23:09 say the model stopped; an
`upstream-error` with the model still `loaded` says the connection broke on its own.

Nothing secret goes in a line: no API key, header, prompt or reply, and a path is
logged without its query. `jq` reads it well:

    jq -c 'select(.event=="upstream.end" and .outcome!="done")' ~/.llama-mui/logs/server-*.log
