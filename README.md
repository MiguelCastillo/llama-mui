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

- Model picker from the active server's `/v1/models`, showing which models are
  loaded. The server loads others on the first message.
- Streaming replies with a Stop button. Each step of a reply (thinking, tool
  calls) shows how long it took; hover for token counts. Hide the steps in
  **Settings → Chat** to see just the answers.
- Messages render as Markdown, yours and the model's: bold, lists, tables,
  links (opened in a new tab) and code blocks with a Copy button. Text inside
  ``` blocks shows exactly as typed, and images show as links instead of
  loading. In your messages a single line break stays a line break. Turn it
  off in **Settings → Chat** to see the raw text.
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
