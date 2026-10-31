# llama-mui

A small Material UI chat client for llama.cpp servers' OpenAI-compatible API.

## Setup

```sh
npm install
npm run dev                  # http://localhost:5173
```

Then add a server under **Settings → Connectors** (the gear icon).

## Settings

Settings are saved in `settings.json` (git ignored, readable only by you) and
served by a Vite plugin (`server/plugin.ts`) that runs under both
`npm run dev` and `npm run preview`.

**Connectors** are llama.cpp servers: a URL, an optional API key and a name.
Chat uses the selected one. The plugin proxies chat requests at
`/api/c/<id>/v1/...` to that server with its key, so keys never reach the
browser.

**Tools** are things the model can do while answering, grouped by what they
reach and switched on or off one by one (`server/tools.ts`). With the
**Tools** switch on in chat, the model gets every tool that's on and ready.
Tool calls and their results show in the reply.

The **Disk** group (`server/disk.ts`) has read-only tools limited to the folders
you add there: `list_directory`, `read_file`, `find_files` (names, with `*`
wildcards) and `grep` (regular expressions over file contents). Every path is
checked against the allowed folders before and after resolving symlinks, so
`../` and symlinks can't reach outside them, and `settings.json` itself is
never readable or searchable.

The **Web** group (`server/web.ts`) has `web_search`, which sends the model's
query to DuckDuckGo and returns titles, links and snippets. DuckDuckGo has no
official API, so it reads the plain-HTML results page; if that page changes,
`parseResults` is the place to fix. Each group adds a few lines to the system
prompt while its tools are on.

## Features

- Model picker from the active server's `/v1/models`, showing which models are
  loaded. The server loads others on the first message.
- Streaming replies with a Stop button. Each step of a reply (thinking, tool
  calls) shows how long it took; hover for token counts. Hide the steps in
  **Settings → Chat** to see just the answers.
- Context indicator under Send ("98% left"), orange then red as the window
  fills. Click it for tokens used of the model's window, generation speed and
  **Clear context**: the model forgets everything so far, but the transcript
  stays on screen, dimmed, under a divider. **New chat** clears both. Turn the
  indicator off in **Settings → Chat**.
- **Think before answering**, per model in **Settings → Models** (off by
  default): off sends `chat_template_kwargs: {enable_thinking: false}`; on
  shows the model's reasoning in a collapsible panel. Saved by model id, so it
  follows the model to any server. While the **Tools** switch is on, thinking
  is always on: with it off, small models like Qwen 9B rarely call tools.
