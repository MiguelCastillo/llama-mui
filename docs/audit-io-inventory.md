# Audit: raw input/output inventory

Layer 1 of the audit-wrapper work. This lists every place in `server/` (tests
excluded) that starts a process, makes a network request, or changes a file
without going through a wrapper. It is the checklist for moving each one onto
`server/io/exec.ts`, `server/io/fetch.ts` and `server/io/fs.ts`.

Found by searching `server/` for: `node:child_process`, global `fetch(`,
and the file-changing calls `writeFile`, `appendFile`, `rename`, `unlink`,
`mkdir`, `mkdtemp`, `rm`, `rmdir`, `copyFile`, `createWriteStream` and
`handle.writeFile` (plus sync versions). Line numbers are from the day this was
written and will drift.

Volume: **rare** (a user action or startup), **per request** (once per
chat turn, tool call or page load), **high frequency** (many times a minute
while a chat runs).

Status column: every row is `migrated`: it now goes through its wrapper and
leaves an audit line. The line numbers and the "Notes" below describe the code
as it was before the move, and are kept as the record. The one exception, the
Chrome launch in `inspect.ts`, is described in the notes.

## Counts

| Kind | Sites to migrate | Base layer (allowlisted) |
| --- | --- | --- |
| Starting a process | 7 (plus 1 library launch, see notes) | 0 |
| Network request (`fetch`) | 6 | 0 |
| File change | 52 | 10 |

## Starting a process

| File | Line | What it is for | Proposed `why` | Volume | Status |
| --- | --- | --- | --- | --- | --- |
| server/disk.ts | 428 | `osascript` file and folder picker | `picker.open` | rare | migrated |
| server/terminal.ts | 51 | login shell, read once to get the user's environment | `shell.login-env` | rare (once per server start) | migrated |
| server/terminal.ts | 123 | the shell that runs a chat command (`run_command`, `check-command`) | `shell.command` | per request | migrated |
| server/whisper.ts | 76 | speech-to-text, streaming the transcript | `whisper.stream` | rare | migrated |
| server/whisper.ts | 126 | speech-to-text, whole transcript | `whisper.run` | rare | migrated |
| server/worktree.ts | 27 | every `git` call for creating and removing worktrees | `git.worktree` | rare | migrated |
| server/worktreeStatus.ts | 30 | `git` status of a worktree | `git.status` | per request | migrated |

Not a raw use, listed so nobody looks for it: `server/tools.ts` line 647
(check-command) calls `exec` from `terminal.ts`, so it moves with line 123.
It keeps its `command.run` line.

Old hand-written `process.start` lines to delete when these move:
`disk.ts` 426, `terminal.ts` 50, `whisper.ts` 75 and 125.

## Network requests

| File | Line | What it is for | Proposed `why` | Volume | Status |
| --- | --- | --- | --- | --- | --- |
| server/connectors.ts | 75 | probe a model server's `/v1/models` (5 s timeout) | `connector.probe` | rare | migrated |
| server/connectors.ts | 109 | forward a chat request to the model server (streams) | `connector.proxy` | per request | migrated |
| server/fetch.ts | 88 | the `fetch_url` tool | `page.fetch` | per request | migrated |
| server/modelAdmin.ts | 39 | forward a model-admin call to the model server | `model.admin` | rare | migrated |
| server/modelAdmin.ts | 145 | look up a model on Hugging Face | `model.lookup` | rare | migrated |
| server/web.ts | 87 | the `web_search` tool (DuckDuckGo) | `web.search` | per request | migrated |

## File changes

Wrapper operations planned: write, append, rename, remove, mkdir.
`mkdtemp` and `rmdir` are not in that list; see notes.

| File | Line | What it is for | Proposed `why` | Volume | Status |
| --- | --- | --- | --- | --- | --- |
| server/cert.ts | 34 | make the certificate folder (through a dynamic `import("node:fs")`) | `cert.save` | rare | migrated |
| server/cert.ts | 36 | write the certificate | `cert.save` | rare | migrated |
| server/cert.ts | 37 | write the private key | `cert.save` | rare | migrated |
| server/images.ts | 44 | make the chat's image folder | `image.save` | per request | migrated |
| server/images.ts | 45 | save a pasted or attached image | `image.save` | per request | migrated |
| server/images.ts | 91 | delete one image | `image.remove` | rare | migrated |
| server/images.ts | 104 | delete a chat's image folder | `image.remove-all` | rare | migrated |
| server/inspect.ts | 149 | temp folder for the headless Chrome profile (`mkdtemp`) | `inspect.profile` | per request | migrated |
| server/inspect.ts | 201 | delete that temp folder | `inspect.profile` | per request | migrated |
| server/phones.ts | 60 | make the phones folder | `phones.save` | rare | migrated |
| server/phones.ts | 62 | write the phone list (temp file) | `phones.save` | rare | migrated |
| server/phones.ts | 63 | rename temp file into place | `phones.save` | rare | migrated |
| server/recentFolders.ts | 33 | make the folder | `recent-folders.save` | rare | migrated |
| server/recentFolders.ts | 35 | write the list (temp file) | `recent-folders.save` | rare | migrated |
| server/recentFolders.ts | 36 | rename temp file into place | `recent-folders.save` | rare | migrated |
| server/rules.ts | 98 | make the folder (save all rules) | `rules.save` | rare | migrated |
| server/rules.ts | 99 | write the rules file (temp file) | `rules.save` | rare | migrated |
| server/rules.ts | 100 | rename into place | `rules.save` | rare | migrated |
| server/rules.ts | 124 | make the folder (add one rule) | `rules.add` | rare | migrated |
| server/rules.ts | 126 | write the rules file (temp file) | `rules.add` | rare | migrated |
| server/rules.ts | 127 | rename into place | `rules.add` | rare | migrated |
| server/rules.ts | 135 | delete the rules file | `rules.clear` | rare | migrated |
| server/rules.ts | 136 | delete the old-format rules file | `rules.clear` | rare | migrated |
| server/rules.ts | 197 | make the folder (edit rules) | `rules.edit` | rare | migrated |
| server/rules.ts | 199 | write the rules file (temp file) | `rules.edit` | rare | migrated |
| server/rules.ts | 200 | rename into place | `rules.edit` | rare | migrated |
| server/secrets.ts | 75 | make the config folder | `secrets.key` | rare | migrated |
| server/secrets.ts | 79 | create the encryption key (`wx`, fails if it exists) | `secrets.key` | rare | migrated |
| server/secrets.ts | 147 | make the folder | `secrets.save` | rare | migrated |
| server/secrets.ts | 149 | write the keys file (temp file) | `secrets.save` | rare | migrated |
| server/secrets.ts | 150 | rename into place | `secrets.save` | rare | migrated |
| server/sessionFile.ts | 69 | make the chat's folder | `session.save` | high frequency | migrated |
| server/sessionFile.ts | 70 | write the chat file (temp file) | `session.save` | high frequency | migrated |
| server/sessionFile.ts | 71 | rename into place | `session.save` | high frequency | migrated |
| server/sessionFile.ts | 85 | delete the chat file | `session.delete` | rare | migrated |
| server/sessionFile.ts | 88 | delete the chat's image folder | `session.delete` | rare | migrated |
| server/sessionFile.ts | 89 | remove the chat's folder if empty (`rmdir`) | `session.delete` | rare | migrated |
| server/sessions.ts | 39 | delete an old-location chat after it was copied | `session.migrate` | rare (once) | migrated |
| server/sessions.ts | 44 | remove the old chats folder if empty (`rmdir`) | `session.migrate` | rare (once) | migrated |
| server/store.ts | 91 | make the settings folder | `settings.migrate` | rare (once) | migrated |
| server/store.ts | 93 | move the old settings file | `settings.migrate` | rare (once) | migrated |
| server/store.ts | 132 | make the settings folder | `settings.save` | high frequency | migrated |
| server/store.ts | 136 | write settings (temp file) | `settings.save` | high frequency | migrated |
| server/store.ts | 137 | rename into place | `settings.save` | high frequency | migrated |
| server/usageLog.ts | 57 | make the usage folder | `usage.log` | high frequency | migrated |
| server/usageLog.ts | 58 | append a usage line | `usage.log` | high frequency | migrated |
| server/whisper.ts | 50 | temp folder for the recording (`mkdtemp`) | `whisper.upload` | rare | migrated |
| server/whisper.ts | 53 | write the recording | `whisper.upload` | rare | migrated |
| server/whisper.ts | 68 | delete the temp folder | `whisper.upload` | rare | migrated |
| server/worktree.ts | 147 | make the folder for a new worktree | `git.worktree` | rare | migrated |
| server/write.ts | 108 | make missing folders for an edit | `edit.write` | per request | migrated |
| server/write.ts | 109 | write the edited file (the edit tools) | `edit.write` | per request | migrated |

## Base layer: allowlisted, never audited

These write the logs themselves or hold the lock that guards other writes.
Auditing them would loop (a log line causing a log line) or deadlock. They stay
raw, and the guard test names each with its reason.

| File | Lines | What it does | Reason it is allowlisted |
| --- | --- | --- | --- |
| server/audit.ts | 33, 34, 54 | makes the audit folder, appends audit lines, deletes audit files older than 90 days | it is the audit log; an audited write would write another audit line, forever |
| server/log.ts | 40, 43, 68 | makes the log folder, appends server log lines, deletes old logs | it is the server log, which audit failures are reported to; same loop |
| server/fileLock.ts | 79, 89, 99, 114 | makes the locks folder, writes the lock file, removes it | the lock is taken around other audited writes; logging inside it would need the lock it is holding, and a lock is not user data |

## Notes for the later steps

- **Not covered by the plan's file list.** `sessions.ts` (2), `inspect.ts` (2)
  and `worktree.ts` (1, mkdir) change files but step 5 does not name them.
  `worktree.ts` moves with step 3 anyway. `sessions.ts` and `inspect.ts` need
  adding to step 5 (or being allowlisted with a reason), or the guard test in
  step 7 will fail on them.
- **Two operations outside the planned five.** `mkdtemp` (inspect.ts,
  whisper.ts) and `rmdir` (sessionFile.ts, sessions.ts). Either add a
  `mktemp` operation and fold `rmdir` into `remove`, or write the temp folder
  with `mkdir` and a generated name. Decide in step 5.
- **Still open: the Chrome launch is not wrapped.** As of the last check
  `inspect.ts` still calls `puppeteer.launch` with no `io.exec` line and the guard
  test has no rule for `puppeteer`. Its temp-folder changes do go through the
  file wrapper. Adding a line for the launch is a follow-up.
- **A process started by a library.** `inspect.ts` line 153 starts Chrome
  through `puppeteer-core`'s `launch`, not through `child_process`, so the
  guard test's import check will not see it. It needs its own `why`
  (`inspect.browser`), probably an `io.exec` line written by hand around the
  launch, and a guard-test rule for `puppeteer` imports.
- **Reads are out of scope.** `readFile`, `readdir`, `stat`, `realpath` are
  not logged.
- **Servers are not fetches.** `node:http`, `http2` and `net` appear only to
  serve requests or as types; nothing in `server/` opens outgoing sockets
  except the six `fetch` calls above.
- **The certificate folder** (cert.ts 34) is made by a dynamic import that
  does not wait for the result before the write on line 36. The wrapper move
  should make that a plain awaited call.
