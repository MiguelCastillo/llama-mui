# llama-mui

A chat app for your own llama.cpp server that does the legwork on code changes.
Describe what you want; llama-mui reads your code, writes the plan, and works
through it step by step, so you review instead of doing it yourself.

## What you get

- **Chat with your models.** Replies stream in and you can stop them. Markdown
  and code blocks render properly, and a context meter shows how much room is
  left. It works with llama.cpp servers and with Anthropic's API.
- **Manage models from the page.** Load and unload them, delete the ones you
  don't use, and search Hugging Face for GGUF files to download to your server.
- **Give the model hands.** It can browse and search your files, edit them (you
  approve each change as a diff), run commands (you approve each one), and
  look things up on the web.
- **Plan first.** llama-mui reads your code and writes the plan
  before it touches anything. You review it, adjust any step, and set it
  running. It works through the steps one at a time and checks each, so you step
  in to review and redirect, not to do the work. Rerun any step.
- **Skills.** Drop a folder with a `SKILL.md` into `~/.llama-mui/skills` and the model
  opens it when a task matches.
- **Work on a branch, not your checkout.** Ask for a git worktree and the model
  works on its own copy, so your repo stays as you left it.
- **Sessions that stay put.** Every session is saved, named for you, and
  reopens where you left off.

## Try it

```sh
npm install
npm run prod    # builds the app and serves it: http://localhost:5173
```

For the phone, `npm run prod:lan` does the same on every network interface.
Changing the code? `npm run dev` runs Vite on http://localhost:5174 (`dev:lan`
for the network). There are two because Vite restarts the API whenever a server
file changes, which cuts off replies that are streaming; the built app on 5173
isn't touched by edits to the source.

Then open Settings (the gear icon) → Connectors and add your server.

## Token usage

Every finished chat turn adds one line (time, chat, provider, model, input,
output and cache tokens) to `~/.llama-mui/usage.jsonl`. The usage view shows
totals for the chat, today, each provider and each day. Each open chat also
has a usage button showing its token count; click it for details.

### Where the numbers come from

The counts are the ones the model server itself reports at the end of each
reply. Nothing is estimated or counted by the app.

- **llama.cpp servers:** the timing block on the last chunk of the stream.
  Fresh prompt tokens are input, generated tokens are output, and tokens the
  server reused from its cache are cache reads.
- **OpenAI-style servers:** the usage block of the reply. Cached prompt tokens
  are taken out of input and counted as cache reads, so input always means
  fresh tokens.
- **Anthropic-style servers:** the usage fields of the streamed reply: input,
  output, cache read and cache write.

A reply that calls tools makes several requests; their counts are added up into
one line for the turn, and a stopped or failed reply still logs what it used.
The provider is the name of the connector the chat used. A server that reports
no counts adds no line, so its use shows as zero.

A line also says what leaving old tool results out did (see "Old tool
results" in the guide): `clearedResults` and `clearedTokens`, summed over the
turn's requests, and `rereads`, the tool calls that asked again for a result
that had been left out. On Anthropic the cleared counts are its own; on
llama.cpp `clearedTokens` is estimated from the results' length, the one
number here the app works out itself. The context percentage under
the message box is separate: it shows the size of the latest request, not a
running total.

To get a warning, set a daily token limit (0 or unset means off). There is no
settings field for it yet; send it to the running server:

```
curl -X PUT localhost:5173/api/usage/limit \
  -H 'content-type: application/json' -d '{"dailyTokenLimit": 500000}'
```

A warning shows at 80% of the limit and a stronger notice at 100%. Sending is
never blocked.

## More

- [The full guide](docs/guide.md): every feature, how plans work, and what the
  model is told.
- Changing the code? Read [AGENTS.md](AGENTS.md) first.

MIT licensed.
