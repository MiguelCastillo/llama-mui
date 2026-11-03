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
- **Work on a branch, not your checkout.** Ask for a git worktree and the model
  works on its own copy, so your repo stays as you left it.
- **Sessions that stay put.** Every session is saved, named for you, and
  reopens where you left off.

## Try it

```sh
npm install
npm run dev     # http://localhost:5173
```

Then open Settings (the gear icon) → Connectors and add your server.

## More

- [The full guide](docs/guide.md): every feature, how plans work, and what the
  model is told.
- Changing the code? Read [AGENTS.md](AGENTS.md) first.

MIT licensed.
