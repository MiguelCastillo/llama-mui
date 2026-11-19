// The list of dangerous command kinds. A command that matches an active entry
// is never covered by "approve all commands": it always asks.
//
// This is a STAND-IN, not a sandbox. It matches plain text, so a determined
// or lucky command can get past it (a script that kills things, a variable
// that holds the command name). The real protection is the environment.
// See AGENTS.md, "Safety belongs to the environment".
//
// Pure: no React, no I/O. The server decides with it; the page only draws
// what the server sends (and uses it for the Settings test box).

export type DangerousEntry = {
  id: string
  label: string
  /** Plain words: what it is and why it always asks. */
  description: string
  /** A regular expression, as text. */
  pattern: string
  /** 'segment': tested on each simple command (after ; && || | newlines,
   *  $(), backticks and sh -c strings are split out, and wrappers such as
   *  env, xargs, nohup removed). 'whole': tested on each whole text, so it can
   *  see across a pipe. */
  scope: 'segment' | 'whole'
  /** True for an entry the user added in Settings. */
  custom?: boolean
}

export type CustomEntry = { id: string; label: string; pattern: string }

/** The setting as saved: every field optional, unknown fields ignored. */
export type DangerousCommandsSetting = {
  enabled?: boolean
  off?: string[]
  custom?: CustomEntry[]
}

const sh = String.raw`(?:ba|z|da|k)?sh`
// git, then any global options (-C path, -c k=v, --no-pager), then a space.
const git = String.raw`^git(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+`

export const BUILT_IN_ENTRIES: DangerousEntry[] = [
  {
    id: 'stop-processes',
    label: 'Stopping processes',
    description:
      'Stops programs that are running (kill, pkill, killall, launchctl or service stop, killing by port). It can take down the servers the app itself runs on.',
    scope: 'segment',
    pattern: [
      String.raw`^(?:kill|pkill|killall|killall5|skill|slay|kill-port|taskkill)(?:\s|$)`,
      String.raw`^npx\s+(?:-\S+\s+)*kill-port\b`,
      String.raw`^launchctl\s+(?:stop|kill|unload|remove|bootout|disable)\b`,
      String.raw`^systemctl\s+(?:stop|kill|restart|disable|mask)\b`,
      String.raw`^service\s+\S+\s+(?:stop|restart)\b`,
      String.raw`^fuser\s+(?:.*\s)?-[a-zA-Z]*k`,
    ].join('|'),
  },
  {
    id: 'forced-delete',
    label: 'Recursive or forced deletes',
    description:
      'Deletes files in bulk or without asking (rm -r, rm -f, find -delete, shred). Deleted files do not go to the bin.',
    scope: 'segment',
    pattern: [
      String.raw`^rm\s+(?:.*\s)?(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(?:\s|$)`,
      String.raw`^find\s.*(?:\s-delete\b|\s-exec\s+(?:\S*/)?rm\b)`,
      String.raw`^shred\b`,
    ].join('|'),
  },
  {
    id: 'destructive-git',
    label: 'Destructive git',
    description:
      'Git commands that throw work away or rewrite shared history (push --force, reset --hard, clean -f, branch -D, worktree remove --force).',
    scope: 'segment',
    pattern: [
      git + String.raw`push\b.*(?:\s--force\b|\s--mirror\b|\s--delete\b|\s-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)|\s\+\S)`,
      git + String.raw`reset\b.*\s--hard\b`,
      git + String.raw`clean\b.*\s(?:-[a-zA-Z]*f|--force)`,
      git + String.raw`branch\b.*\s(?:-[a-zA-Z]*D[a-zA-Z]*(?:\s|$)|--delete\s+--force|-d\s+(?:-f|--force)|-df|-fd)`,
      git + String.raw`worktree\s+remove\b.*\s(?:-f|--force)`,
    ].join('|'),
  },
  {
    id: 'elevated',
    label: 'Running as administrator',
    description: 'sudo, su and similar run a command with full rights over the whole computer.',
    scope: 'segment',
    pattern: String.raw`^(?:sudo|su|doas|pkexec)(?:\s|$)`,
  },
  {
    id: 'disk-tools',
    label: 'Disk and format tools',
    description:
      'Writes straight to a disk or wipes one (dd, mkfs, fdisk, diskutil erase). A wrong target destroys everything on it.',
    scope: 'segment',
    pattern:
      String.raw`^(?:dd|mkfs(?:\.\w+)?|mke2fs|newfs\S*|fdisk|sfdisk|gdisk|parted|wipefs|diskutil\s+(?:erase\w*|reformat|partitionDisk|zeroDisk|secureErase|apfs\s+(?:delete\w*|erase\w*)))(?:\s|$)`,
  },
  {
    id: 'app-settings',
    label: "The app's settings and key files",
    description:
      "A shell command that mentions the app's settings file, its saved keys or its secret key file. Changing those could switch this list off or leak a key.",
    scope: 'whole',
    pattern: String.raw`\.llama-mui/(?:settings\.json|\.keys)|\.config/llama-mui|secret\.key|LLAMA_MUI_SECRET_KEY|/api/dangerous-commands`,
  },
  {
    id: 'pipe-to-shell',
    label: 'Running a download as a program',
    description:
      'Pipes something downloaded (curl, wget) straight into a shell or interpreter, so code nobody has read gets run.',
    scope: 'whole',
    pattern: [
      String.raw`\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*/)?(?:${sh}|python3?|node|perl|ruby)(?:\s|$)`,
      String.raw`(?:^|[\s;&|])(?:source|eval|${sh})\s+(?:-\S+\s+)*["']?(?:<\(|\$\()\s*(?:curl|wget)\b`,
    ].join('|'),
  },
  {
    id: 'recursive-permissions',
    label: 'Changing permissions or owners everywhere',
    description: 'chmod, chown or chgrp with -R changes a whole folder tree, which can lock you out of it.',
    scope: 'segment',
    pattern: String.raw`^(?:chmod|chown|chgrp)\s+(?:.*\s)?(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)(?:\s|$)`,
  },
]

export const MAX_PATTERN_LENGTH = 300
export const MAX_CUSTOM_ENTRIES = 50

/** A plain message saying why a custom entry can't be saved, or undefined if it is fine. */
export function customEntryProblem(c: unknown): string | undefined {
  if (!c || typeof c !== 'object') return 'A custom entry must have an id, a label and a pattern.'
  const { id, label, pattern } = c as Record<string, unknown>
  if (typeof id !== 'string' || !id.trim()) return 'A custom entry needs an id.'
  if (BUILT_IN_ENTRIES.some((e) => e.id === id)) return `"${id}" is the id of a built-in entry; choose another.`
  if (label !== undefined && typeof label !== 'string') return `The label of "${id}" must be text.`
  if (typeof pattern !== 'string' || !pattern.trim()) return `The pattern of "${id}" is empty.`
  if (pattern.length > MAX_PATTERN_LENGTH) return `The pattern of "${id}" is longer than ${MAX_PATTERN_LENGTH} characters.`
  try {
    new RegExp(pattern, 's')
  } catch (e) {
    return `The pattern of "${id}" isn't a valid regular expression (${e instanceof Error ? e.message : 'unknown error'}).`
  }
  return undefined
}

/** True ONLY when the setting is an object whose `enabled` is exactly false.
 *  Missing, wrong type, null, "false", 0: all mean the check is on. */
export function dangerousCheckOff(setting: unknown): boolean {
  return (
    typeof setting === 'object' &&
    setting !== null &&
    !Array.isArray(setting) &&
    (setting as { enabled?: unknown }).enabled === false
  )
}

// ---- splitting a command into the pieces to test ----

const MAX_DEPTH = 6
const MAX_LENGTH = 20000

// Splits on ; & | and newlines that are outside quotes.
function splitSimple(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
      else if (c === quote) quote = ''
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      cur += c + text[++i]
    } else if (c === "'" || c === '"') {
      quote = c
      cur += c
    } else if (c === ';' || c === '&' || c === '|' || c === '\n') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

// The text inside $(...) and `...`, anywhere except inside single quotes.
function substitutions(text: string): string[] {
  const out: string[] = []
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      continue
    }
    if (c === '\\') {
      i++
    } else if (c === "'" || c === '"') {
      quote = quote === c ? '' : quote || c
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')') depth--
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j))
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1)
      out.push(text.slice(i + 1, end < 0 ? text.length : end))
      if (end < 0) break
      i = end
    }
  }
  return out
}

const WRAPPERS = [
  /^(?:\(|\{|!)\s*/,
  /^(?:then|do|else|time|command|builtin|exec|nohup|nice|sudo\s+-\S+\s+-\S+)\s+(?:-\S+\s+)*/,
  /^env\s+(?:-\S+\s+)*/,
  /^xargs\s+(?:-\S+\s+)*/,
  /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/,
]

// Removes wrappers and a leading path, so "env X=1 /bin/kill 9" tests as "kill 9".
function normalize(segment: string): string {
  let s = segment.trim()
  for (let again = true; again; ) {
    again = false
    for (const w of WRAPPERS) {
      const next = s.replace(w, '')
      if (next !== s) {
        s = next
        again = true
      }
    }
  }
  const m = /^\S*\/([^\s/]+)(.*)$/s.exec(s)
  return m ? m[1] + m[2] : s
}

const SHELL_C = new RegExp(
  String.raw`^${sh}\s+(?:-\S+\s+)*?-[a-zA-Z]*c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))`,
  's',
)

// The command string inside sh -c '...' or eval '...', if there is one.
function shellInner(segment: string): string | undefined {
  const m = SHELL_C.exec(segment)
  if (m) return m[1] ?? m[2] ?? m[3]
  const e = /^eval\s+(.*)$/s.exec(segment)
  if (e) return e[1].replace(/^(["'])([\s\S]*)\1$/, '$2')
  return undefined
}

type Pieces = { whole: string[]; segments: string[] }

function pieces(text: string, depth: number, into: Pieces): void {
  if (depth > MAX_DEPTH) return
  into.whole.push(text)
  const segs = splitSimple(text)
    .map(normalize)
    .filter((s) => s)
  for (const seg of segs) {
    into.segments.push(seg)
    const inner = shellInner(seg)
    if (inner !== undefined) pieces(inner, depth + 1, into)
  }
  for (const sub of substitutions(text)) pieces(sub, depth + 1, into)
}

// ---- matching ----

const compiled = new Map<string, RegExp | null>()
function regexFor(pattern: string): RegExp | null {
  let re = compiled.get(pattern)
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 's')
    } catch {
      re = null
    }
    compiled.set(pattern, re)
  }
  return re
}

/** The entries in effect: the built-in ones not switched off, then the custom
 *  ones. Empty when the check is explicitly off. Reads the setting defensively:
 *  anything unusable is ignored, never treated as "off". */
export function activeEntries(setting?: unknown): DangerousEntry[] {
  if (dangerousCheckOff(setting)) return []
  const s = (typeof setting === 'object' && setting !== null ? setting : {}) as Record<string, unknown>
  const off = new Set(Array.isArray(s.off) ? s.off.filter((x): x is string => typeof x === 'string') : [])
  const entries = BUILT_IN_ENTRIES.filter((e) => !off.has(e.id))
  if (Array.isArray(s.custom)) {
    for (const c of s.custom) {
      if (!c || typeof c !== 'object') continue
      const { id, label, pattern } = c as Record<string, unknown>
      if (typeof id !== 'string' || typeof pattern !== 'string' || !pattern) continue
      entries.push({
        id,
        label: typeof label === 'string' && label ? label : id,
        description: 'An entry you added in Settings.',
        pattern,
        scope: 'segment',
        custom: true,
      })
    }
  }
  return entries
}

/** The entries a command matches (none when the check is explicitly off).
 *  `setting` is the saved dangerousCommands value; pass it as read, whatever it is. */
export function matchDangerous(command: string, setting?: unknown): DangerousEntry[] {
  const entries = activeEntries(setting)
  if (!entries.length || typeof command !== 'string') return []
  const p: Pieces = { whole: [], segments: [] }
  pieces(command.slice(0, MAX_LENGTH), 0, p)
  return entries.filter((e) => {
    const re = regexFor(e.pattern)
    if (!re) return false
    // A custom entry is tested on both, so it can see across a pipe too.
    const texts = e.scope === 'whole' ? p.whole : e.custom ? [...p.segments, ...p.whole] : p.segments
    return texts.some((t) => re.test(t))
  })
}
