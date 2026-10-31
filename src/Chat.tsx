import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Collapse,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Popover,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import AddCommentIcon from "@mui/icons-material/AddComment";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import LayersClearOutlinedIcon from "@mui/icons-material/LayersClearOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import { keyframes } from "@mui/material/styles";
import {
  type ChatMessage,
  type StepStats,
  type ToolCall,
  type ModelSettings,
  type Preferences,
  type Attachment,
  type AccessRequest,
  type AttachmentTarget,
  type Approval,
  type ToolContext,
  type Session,
  type SessionSummary,
  type Usage,
  type Connector,
  type Model,
  getConnectors,
  getModelSettings,
  updateModelSettings,
  getPreferences,
  getToolContext,
  listModels,
  pickAttachments,
  deleteSession,
  getSession,
  listSessions,
  runTool,
  saveSession,
  streamChat,
} from "./api";
import ChatSettings, { AttachmentIcon } from "./ChatSettings";
import SessionsPanel from "./SessionsPanel";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import MarkdownRenderer from "./MarkdownRenderer";

// Per-browser choices kept in localStorage: whether the toolbar is expanded,
// and whether the Tools switch is on. Storage can be unavailable (private
// windows), so failures fall back to the default.
const TOOLBAR_KEY = "llama-mui:toolbarOpen";
// Off until the user turns it on: tools can read files, change them and run
// commands, so they're something to opt into.
const TOOLS_KEY = "llama-mui:toolsOn";
// Saved as `failed` while a reply runs, so a chat reopened after the page
// went away mid-reply offers to resend.
const INTERRUPTED = "interrupted";
// Whether the chats panel is open (wide screens; on phones it's a drawer).
const SESSIONS_OPEN_KEY = "llama-mui:sessionsOpen";
// Which saved chat is open, so a reload reopens it.
const SESSION_KEY = "llama-mui:sessionId";
function loadSessionId(): string {
  try {
    const id = localStorage.getItem(SESSION_KEY);
    if (id) return id;
  } catch {
    // Falls through to a new chat.
  }
  return crypto.randomUUID();
}
function saveSessionId(id: string) {
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    // Not remembered; a reload starts a new chat.
  }
}

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}
function saveFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

// Splits the tokens a turn read fresh among the previous round's tool results,
// by length. The total is exact (it includes a little chat-template framing);
// the split is an estimate.
function shareTokens(history: ChatMessage[], indexes: number[], tokens: number): ChatMessage[] {
  const chars = indexes.reduce((n, i) => n + history[i].content.length, 0) || 1;
  const next = [...history];
  for (const i of indexes) {
    const m = next[i];
    next[i] = { ...m, stats: { ms: m.stats?.ms ?? 0, tokens: Math.round((tokens * m.content.length) / chars) } };
  }
  return next;
}

// What a tool call can wait on the user for, and their answer: allow or deny,
// or, for a path, the files or folders they picked in its place.
type Ask =
  | { needsAccess: AccessRequest }
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"] } }
  | { needsApproval: Approval };
type Answer = boolean | AttachmentTarget[];

// A model stuck in a loop repeats itself: the third identical call (same tool,
// same arguments) in one reply isn't run, and the model answers with what it
// has. MAX_TOOL_ROUNDS backs that up for loops whose arguments keep changing;
// small models make one call per round, so it's set well above real work.
const MAX_REPEATS = 2;
const CHANGES_DISK = new Set(["write_file", "edit_file", "run_command"]);
const MAX_TOOL_ROUNDS = 50;

// Same call, even if the model spaced its JSON differently.
function callKey(call: ToolCall): string {
  try {
    return `${call.name} ${JSON.stringify(JSON.parse(call.arguments))}`;
  } catch {
    return `${call.name} ${call.arguments}`;
  }
}

// What happened to a failed reply, in the user's terms. Our server answers 502
// when it can't reach the llama server; a TypeError means the request never
// got an answer at all.
function failureLine(failed: string): string {
  if (failed === INTERRUPTED) return "The reply was cut off.";
  if (failed.startsWith("TypeError") || failed.includes(": 502 ")) return "Couldn't reach the llama server.";
  return "The llama server returned an error.";
}

export default function Chat({ visible, onOpenSettings }: { visible: boolean; onOpenSettings: () => void }) {
  // undefined until the first load, null when no server is configured.
  const [connector, setConnector] = useState<Connector | null | undefined>(undefined);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  // Per-model options from Settings → Models, plus the server's defaults for
  // models nobody changed.
  const [modelSettings, setModelSettings] = useState<{
    defaults: ModelSettings;
    models: Record<string, ModelSettings>;
  } | null>(null);
  const [toolsWanted, setToolsWantedState] = useState(() => loadFlag(TOOLS_KEY, false));
  const setToolsWanted = (on: boolean) => {
    setToolsWantedState(on);
    saveFlag(TOOLS_KEY, on);
  };
  // Files and folders this chat's disk tools may read; New chat clears them.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // What a reply is waiting on the user for: a path the model asked for that
  // isn't attached, or a change to approve. Cleared once they answer.
  const [pending, setPending] = useState<{
    ask: Ask;
    decide: (answer: Answer) => void;
  } | null>(null);
  // What to offer the model given those attachments and Settings → Tools.
  const [toolContext, setToolContext] = useState<ToolContext>({ definitions: [], systemPrompt: null });
  const [error, setError] = useState<string | null>(null);
  // Failure of the last reply only; see retry().
  const [failed, setFailed] = useState<string | null>(null);
  // Token count after the latest reply; it covers the whole conversation.
  const [usage, setUsage] = useState<Usage | null>(null);
  // Index of the first message the model still sees. Clear context moves it
  // to the end: earlier messages stay on screen but aren't sent any more.
  const [contextStart, setContextStart] = useState(0);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [toolbarOpen, setToolbarOpenState] = useState(() => loadFlag(TOOLBAR_KEY, true));
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  const setToolbarOpen = (open: boolean) => {
    setToolbarOpenState(open);
    saveFlag(TOOLBAR_KEY, open);
  };
  const [abort, setAbort] = useState<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // The saved chat this is, and the list for the chats panel. Nothing is
  // saved until the open session has loaded, so an empty screen can't
  // overwrite it.
  const [sessionId, setSessionId] = useState(loadSessionId);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sessionsOpen, setSessionsOpenState] = useState(() => loadFlag(SESSIONS_OPEN_KEY, true));
  const setSessionsOpen = (open: boolean) => {
    setSessionsOpenState(open);
    saveFlag(SESSIONS_OPEN_KEY, open);
  };
  // On phones the panel is a drawer that starts closed every time.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // What was last saved or loaded, so opening a chat doesn't save it again
  // (which would move it to the top of the list).
  const savedKey = useRef("");
  const keyOf = (s: Session) => JSON.stringify([s.title, s.model, s.messages, s.contextStart, s.attachments, s.usage, s.failed]);

  const applySession = (s: Session) => {
    savedKey.current = keyOf(s);
    setMessages(s.messages);
    setContextStart(s.contextStart);
    setAttachments(s.attachments);
    setUsage(s.usage);
    setFailed(s.failed ?? null);
    if (s.model) setModel(s.model);
  };

  // A session that was never saved (or was deleted) opens as a new chat.
  const loadSession = (id: string) => {
    setLoaded(false);
    getSession(id)
      .then(applySession)
      .catch(() => {})
      .finally(() => setLoaded(true));
  };

  useEffect(() => {
    saveSessionId(sessionId);
    loadSession(sessionId);
    listSessions()
      .then(setSessions)
      .catch((e) => setError(e.message));
  }, []);

  const saveNow = () => {
    if (!loaded || messages.length === 0) return;
    const session: Session = {
      id: sessionId,
      title: (messages.find((m) => m.role === "user")?.content ?? "New chat").slice(0, 80),
      model,
      messages,
      contextStart,
      attachments,
      usage,
      failed: abort ? INTERRUPTED : failed,
    };
    const key = keyOf(session);
    if (key === savedKey.current) return;
    savedKey.current = key;
    saveSession(session)
      .then((summary) => setSessions((ss) => [summary, ...ss.filter((x) => x.id !== summary.id)]))
      .catch((e) => setError(e.message));
  };

  // Saves a moment after the chat stops changing, so a streaming reply is
  // saved when it pauses rather than on every token.
  useEffect(() => {
    const timer = setTimeout(saveNow, 800);
    return () => clearTimeout(timer);
  }, [loaded, messages, contextStart, attachments, usage, model, abort, failed]);

  // Switches to another chat, saving this one first unless it was deleted.
  const openSession = (id: string, saveFirst = true) => {
    if (abort) return;
    if (saveFirst) saveNow();
    setSessionId(id);
    saveSessionId(id);
    savedKey.current = "";
    setMessages([]);
    setUsage(null);
    setContextStart(0);
    setAttachments([]);
    setFailed(null);
    setDrawerOpen(false);
    loadSession(id);
  };
  const newChat = () => openSession(crypto.randomUUID());
  const removeSession = (id: string) => {
    if (!window.confirm("Delete this chat? This can't be undone.")) return;
    deleteSession(id)
      .then(() => {
        setSessions((ss) => ss.filter((x) => x.id !== id));
        if (id === sessionId) openSession(crypto.randomUUID(), false);
      })
      .catch((e) => setError(e.message));
  };

  const refreshModels = (connectorId: string) =>
    listModels(connectorId)
      .then((ms) => {
        setModels(ms);
        // Keep the current pick if this server has it; otherwise prefer a model
        // that's already in memory so the first reply is fast.
        setModel((cur) =>
          ms.some((m) => m.id === cur) ? cur : ((ms.find((m) => m.status === "loaded") ?? ms[0])?.id ?? ""),
        );
      })
      .catch((e) => {
        // Don't offer models from a server we can't reach.
        setModels([]);
        setError(e.message);
      });

  // Reload everything each time chat shows: Settings may have changed the
  // server, its key or the folders, and a server that was down may be back.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    getConnectors()
      .then((l) => {
        const active = l.connectors.find((c) => c.id === l.activeId) ?? null;
        setConnector(active);
        if (active) refreshModels(active.id);
        else setModels([]);
      })
      .catch((e) => setError(e.message));
    getPreferences()
      .then(setPrefs)
      .catch((e) => setError(e.message));
    getModelSettings()
      .then(setModelSettings)
      .catch((e) => setError(e.message));
  }, [visible]);

  // Settings → Tools or the attachments may have changed what's available.
  useEffect(() => {
    if (!visible) return;
    getToolContext(attachments.map((a) => a.path))
      .then(setToolContext)
      .catch((e) => setError(e.message));
  }, [visible, attachments]);

  // On only when the user wants tools and some are ready in this chat.
  const toolsOn = toolsWanted && toolContext.definitions.length > 0;
  const thinkOn = !!(modelSettings?.models[model] ?? modelSettings?.defaults)?.think;
  // Switching Tools on with Think off asks whether to turn Think on: without
  // it, small models (Qwen 9B) mostly answer from memory instead of calling
  // tools. The answer goes to Settings → Models, so the switch there is what
  // chat actually uses.
  const [offerThink, setOfferThink] = useState(false);
  const turnThinkOn = () =>
    updateModelSettings(model, { think: true })
      .then((saved) => setModelSettings((s) => s && { ...s, models: { ...s.models, [model]: saved } }))
      .catch((e) => setError(e.message))
      .finally(() => setOfferThink(false));
  const toolCount = toolContext.definitions.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  const attach = (a: Attachment) => setAttachments((as) => (as.some((x) => x.path === a.path) ? as : [...as, a]));

  // Shows the prompt and resolves with the user's answer; stopping the reply
  // counts as deny.
  const askUser = (ask: Ask, signal: AbortSignal) =>
    new Promise<Answer>((resolve) => {
      const decide = (answer: Answer) => {
        signal.removeEventListener("abort", onAbort);
        setPending(null);
        resolve(answer);
      };
      const onAbort = () => decide(false);
      signal.addEventListener("abort", onAbort);
      setPending({ ask, decide });
    });

  // Sends a reply after the user types it.
  const send = async () => {
    const text = input.trim();
    if (!text || !model || !connector || abort) return;
    setInput("");
    reply(text, messages);
  };

  // Streams a reply, building history from `before` instead of `messages`.
  // Called by `send()` for new messages, and by `retry()` for failed ones.
  const reply = async (text: string, before: ChatMessage[]) => {
    if (!connector) return;
    const connectorId = connector.id;
    // Fixed for this reply, even if the user changes attachments meanwhile;
    // only paths the user allows mid-reply are added.
    let attached = attachments.map((a) => a.path);
    const forgotten = before.slice(0, contextStart);
    let history: ChatMessage[] = [...before.slice(contextStart), { role: "user", content: text }];
    setError(null);
    setFailed(null);

    const controller = new AbortController();
    setAbort(controller);
    try {
      // Each round streams one assistant turn. If it asks for tools, run them,
      // add the results, and let the model continue from there.
      // Indexes (in history) of the last round's tool results, which get their
      // token counts once the next turn reports what it had to read.
      let lastToolResults: number[] = [];
      // How often each call ran in this reply, by callKey, since the last
      // change to disk: after one, the same read or search can find something
      // new, so repeating it isn't a loop.
      const ran = new Map<string, number>();
      // Set once the model has to stop using tools; it gets one more turn,
      // without them, to answer from what it has.
      let stopReason: string | null = null;
      for (let round = 0; ; round++) {
        const lastTurn: boolean = stopReason !== null;
        const reply: ChatMessage = { role: "assistant", content: "", reasoning: "" };
        let thinkStart = 0;
        let thinkEnd = 0;
        let thinkPieces = 0;
        const show = () => setMessages([...forgotten, ...history, { ...reply }]);
        show();
        const { toolCalls: asked, usage: replyUsage } = await streamChat(
          {
            connectorId,
            model,
            messages:
              toolsOn && !lastTurn && toolContext.systemPrompt
                ? [{ role: "system", content: toolContext.systemPrompt }, ...history]
                : history,
            think: thinkOn,
            tools: toolsOn && !lastTurn ? toolContext.definitions : undefined,
          },
          (d) => {
            if (d.reasoning) {
              thinkStart ||= performance.now();
              thinkPieces++;
            }
            if (d.content && thinkStart) thinkEnd ||= performance.now();
            reply.content += d.content ?? "";
            reply.reasoning += d.reasoning ?? "";
            show();
          },
          controller.signal,
        );
        // Calls the model writes anyway on its last turn have nothing to run them.
        const toolCalls: ToolCall[] = lastTurn ? [] : asked;
        if (replyUsage) setUsage(replyUsage);
        if (thinkStart) reply.stats = { ms: (thinkEnd || performance.now()) - thinkStart, tokens: thinkPieces };
        if (replyUsage?.promptTokens && lastToolResults.length) {
          history = shareTokens(history, lastToolResults, replyUsage.promptTokens);
        }
        lastToolResults = [];
        // After a tool result, small models (Qwen 9B) sometimes write the whole
        // answer inside their thinking and end with no text. Promote it, or
        // the reply is blank (with steps hidden) and the next turn lacks it.
        if (!toolCalls.length && !reply.content.trim() && reply.reasoning?.trim()) {
          reply.content = reply.reasoning.trim();
          reply.reasoning = "";
        }
        if (toolCalls.length) reply.toolCalls = toolCalls;
        history = [...history, reply];
        setMessages([...forgotten, ...history]);
        if (!toolCalls.length) {
          if (stopReason) setError(stopReason);
          break;
        }

        for (const call of toolCalls) {
          if (controller.signal.aborted) return;
          let started = performance.now();
          let result: string;
          const key = callKey(call);
          const times = ran.get(key) ?? 0;
          ran.set(key, times + 1);
          try {
            if (times >= MAX_REPEATS) {
              stopReason = `Stopped: the model kept repeating ${call.name} with the same arguments.`;
              throw new Error(
                `this exact call already ran ${times} times in this reply; answer with what you have`,
              );
            }
            // A call can need the user more than once: access to a folder,
            // then approval of the change it makes there.
            let outcome = await runTool(call, { chatId: sessionId, attachments: attached });
            while (!("result" in outcome)) {
              const answer = await askUser(outcome, controller.signal);
              if (controller.signal.aborted) return;
              // Time spent waiting on the user isn't the tool's.
              started = performance.now();
              if (Array.isArray(answer)) {
                // The user pointed to the right place; the model continues
                // with it, which beats it guessing paths.
                attached = [...attached, ...answer.map((a) => a.path)];
                answer.forEach((a) => attach({ ...a, source: "request" }));
                const picked = answer.map((a) => `${a.path} (${a.kind})`).join(", ");
                outcome = {
                  result:
                    "needsAccess" in outcome
                      ? `Instead of ${outcome.needsAccess.path}, the user attached ${picked}. Use that path; call the tool again with it.`
                      : `The user picked ${picked}; it's attached to this chat. Use that path.`,
                };
                break;
              }
              if ("needsLocation" in outcome) {
                outcome = { result: `Error: the user didn't pick ${outcome.needsLocation.description}` };
                break;
              }
              if ("needsAccess" in outcome) {
                const target = outcome.needsAccess;
                if (!target.kind) {
                  outcome = {
                    result: `Error: nothing exists at ${target.path}, and the user didn't point to where it is`,
                  };
                  break;
                }
                if (!answer) {
                  outcome = { result: `Error: the user didn't allow access to ${target.path}` };
                  break;
                }
                attached = [...attached, target.path];
                attach({ path: target.path, kind: target.kind, source: "request" });
                outcome = await runTool(call, { chatId: sessionId, attachments: attached });
              } else {
                const approval = outcome.needsApproval;
                if (!answer) {
                  outcome = {
                    result:
                      approval.type === "change"
                        ? `Error: the user didn't approve this change to ${approval.path}; nothing was written`
                        : "Error: the user didn't approve running this command; it didn't run",
                  };
                  break;
                }
                // The server asks again if, say, the file changed since the preview.
                outcome = await runTool(call, { chatId: sessionId, attachments: attached, approved: approval });
              }
            }
            result = outcome.result;
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
          if (CHANGES_DISK.has(call.name) && !result.startsWith("Error:")) ran.clear();
          lastToolResults.push(history.length);
          history = [
            ...history,
            { role: "tool", content: result, toolCallId: call.id, stats: { ms: performance.now() - started } },
          ];
          setMessages([...forgotten, ...history]);
        }
        if (round === MAX_TOOL_ROUNDS - 1) stopReason ??= `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls.`;
      }
    } catch (e) {
      if (!controller.signal.aborted) setFailed(String(e));
    } finally {
      setAbort(null);
      // The server loads models on demand, so a reply can change their status.
      refreshModels(connectorId);
    }
  };

  // Retries the last user message, dropping the failed reply.
  const retry = () => {
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!userMsg || !!abort) return;
    const index = messages.indexOf(userMsg);
    reply(userMsg.content, messages.slice(0, index));
  };

  // Tool results show inside the call that asked for them, and the assistant
  // steps of one reply share a bubble.
  const toolResults = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId!, m]));
  // `start` is each turn's first message index, to place the divider.
  const turns: { parts: ChatMessage[]; start: number }[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") return;
    const prev = turns[turns.length - 1];
    if (m.role === "assistant" && prev?.parts[0].role === "assistant" && i !== contextStart) prev.parts.push(m);
    else turns.push({ parts: [m], start: i });
  });
  // The last turn that's a user message; only its reply can fail.
  const lastFailedTurnIndex = turns.map((t) => t.parts[0].role).lastIndexOf("user");
  const hasContext = messages.length > contextStart;
  const showIndicator = hasContext && !!prefs?.showContextMeter;

  const clearContext = () => {
    setContextStart(messages.length);
    setUsage(null);
  };

  return (
    <Box sx={{ display: "flex", height: "100dvh" }}>
      <SessionsPanel
        sessions={sessions}
        currentId={sessionId}
        open={narrow ? drawerOpen : sessionsOpen}
        narrow={narrow}
        busy={!!abort}
        onSelect={(id) => id !== sessionId && openSession(id)}
        onNew={newChat}
        onDelete={removeSession}
        onClose={() => setDrawerOpen(false)}
      />
      <Box sx={{ flexGrow: 1, minWidth: 0, height: "100dvh", display: "flex", flexDirection: "column", position: "relative" }}>
      {/* Floating toolbar in the top-right corner. Collapsing slides the
          controls away to the right (up, on phones); the expand, New chat
          and Settings buttons always stay. */}
      <Paper
        variant="outlined"
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: "appBar",
          maxWidth: "calc(100% - 16px)",
          display: "flex",
          alignItems: "center",
          borderRadius: 2,
          p: 0.5,
          overflow: "hidden",
          // Phones have no room beside the buttons, so the controls open
          // as a panel underneath them instead.
          ...(narrow && { flexWrap: "wrap", justifyContent: "flex-end" }),
          ...(narrow && toolbarOpen && { left: 8 }),
        }}
      >
        <Collapse
          // Remount on orientation change: MUI leaves the old direction's
          // inline size (e.g. height: 0) behind, which clips the controls.
          key={narrow ? "vertical" : "horizontal"}
          in={toolbarOpen}
          orientation={narrow ? "vertical" : "horizontal"}
          // Full width only while open, so the closed toolbar shrinks to its buttons.
          sx={narrow ? { order: 1, width: toolbarOpen ? "100%" : 0 } : undefined}
        >
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{
              alignItems: "center",
              whiteSpace: "nowrap",
              flexWrap: narrow ? "wrap" : "nowrap",
              ...(narrow ? { p: 1, pt: 1.5 } : { pl: 1.5, pr: 1 }),
            }}
          >
            <Box sx={{ minWidth: 0, maxWidth: 160, display: narrow ? "none" : "block" }}>
              <Typography variant="h6" sx={{ lineHeight: 1.2 }} noWrap>
                Llama MUI
              </Typography>
              {connector && (
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {connector.name}
                </Typography>
              )}
            </Box>
            <TextField
              select
              size="small"
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!!abort}
              sx={{ width: narrow ? "100%" : 240 }}
              // The status chips are for the open menu; closed, just the name fits.
              slotProps={{ select: { renderValue: (v) => String(v) } }}
            >
              {models.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: "100%" }}>
                    <span style={{ flexGrow: 1 }}>{m.id}</span>
                    <Chip
                      size="small"
                      label={m.status}
                      color={m.status === "loaded" ? "success" : "default"}
                      variant="outlined"
                    />
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
            <Tooltip
              title={
                toolCount
                  ? `Let the model use ${toolCount} tool${toolCount === 1 ? "" : "s"}. Choose which in Settings → Tools.`
                  : "No tools are ready. Set them up in Settings → Tools."
              }
            >
              <FormControlLabel
                label="Tools"
                control={
                  <Switch
                    checked={toolsOn}
                    onChange={(e) => {
                      setToolsWanted(e.target.checked);
                      if (e.target.checked && !thinkOn) setOfferThink(true);
                    }}
                  />
                }
                disabled={!!abort || toolCount === 0}
              />
            </Tooltip>
          </Stack>
        </Collapse>
        <Tooltip title={toolbarOpen ? "Hide toolbar" : `Show toolbar${model ? ` (${model})` : ""}`}>
          <IconButton onClick={() => setToolbarOpen(!toolbarOpen)}>
            {narrow ? (
              toolbarOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />
            ) : toolbarOpen ? (
              <ChevronRightIcon />
            ) : (
              <ChevronLeftIcon />
            )}
          </IconButton>
        </Tooltip>
        {/* New chat lives in the Chats panel; here only while that's hidden.
            It comes first so the Chats toggle and Settings never move. */}
        {!(narrow ? drawerOpen : sessionsOpen) && (
          <Tooltip title="New chat">
            <span>
              <IconButton onClick={newChat} disabled={!!abort}>
                <AddCommentIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title={(narrow ? drawerOpen : sessionsOpen) ? "Hide chats" : "Show chats"}>
          <IconButton onClick={() => (narrow ? setDrawerOpen(!drawerOpen) : setSessionsOpen(!sessionsOpen))}>
            <ViewSidebarOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton onClick={onOpenSettings}>
            <SettingsOutlinedIcon />
          </IconButton>
        </Tooltip>
      </Paper>

      <Dialog open={offerThink} onClose={() => setOfferThink(false)} maxWidth="xs">
        <DialogTitle>Turn on Think?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Think is off for {model}. Without it, small models usually skip the tools: instead of reading your files
            or searching the web, they answer from what they already know. You can change this later in Settings →
            Models.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOfferThink(false)}>Keep it off</Button>
          <Button variant="contained" onClick={turnThinkOn}>
            Turn on Think
          </Button>
        </DialogActions>
      </Dialog>

      {/* Top padding keeps the first messages clear of the toolbar. */}
      <Box sx={{ flexGrow: 1, overflowY: "auto", pt: 9, pb: 3 }}>
        <Container maxWidth={false}>
          <Stack spacing={2}>
            {connector === null ? (
              <Stack spacing={2} sx={{ alignItems: "center", mt: 8 }}>
                <Typography color="text.secondary">No llama server is set up yet.</Typography>
                <Button variant="contained" onClick={onOpenSettings}>
                  Add one in Settings
                </Button>
              </Stack>
            ) : (
              messages.length === 0 && (
                <Typography color="text.secondary" sx={{ textAlign: "center", mt: 8 }}>
                  Pick a model and say something. Unloaded models load on the first message, which takes a moment.
                </Typography>
              )
            )}
            {turns.map((t, i) => (
              <Fragment key={t.start}>
                {t.start === contextStart && contextStart > 0 && <ContextDivider />}
                <MessageBubble
                  parts={t.parts}
                  streaming={!!abort && i === turns.length - 1}
                  toolResults={toolResults}
                  forgotten={t.start < contextStart}
                  showSteps={prefs?.showSteps ?? true}
                  renderMarkdown={prefs?.renderMarkdown ?? true}
                  failed={i === lastFailedTurnIndex ? failed : undefined}
                  onResend={i === lastFailedTurnIndex ? retry : undefined}
                  resendDisabled={i === lastFailedTurnIndex ? !!abort : undefined}
                />
              </Fragment>
            ))}
            {/* Cleared after the last message: the divider goes at the end. */}
            {contextStart > 0 && contextStart === messages.length && <ContextDivider />}
            {pending && <PendingPrompt ask={pending.ask} onDecide={pending.decide} />}
            {error && <Alert severity="error">{error}</Alert>}
            <div ref={bottomRef} />
          </Stack>
        </Container>
      </Box>

      <Paper square elevation={3} sx={{ py: 2 }}>
        <Container maxWidth={false}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <ChatSettings
              attachments={attachments}
              onAttach={attach}
              onDetach={(p) => setAttachments((as) => as.filter((x) => x.path !== p))}
            />
            <TextField
              fullWidth
              multiline
              maxRows={8}
              placeholder={narrow ? "Message" : "Message (Enter to send, Shift+Enter for a new line)"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {/* Send lines up with the input's top edge; the context
                indicator sits just below it. */}
            <Stack spacing={1.25} sx={{ flexShrink: 0, alignItems: "flex-end" }}>
              {abort ? (
                <Button variant="outlined" color="error" startIcon={<StopIcon />} onClick={() => abort.abort()}>
                  Stop
                </Button>
              ) : (
                <Button variant="contained" endIcon={<SendIcon />} onClick={send} disabled={!input.trim() || !model}>
                  Send
                </Button>
              )}
              {showIndicator && (
                <ContextIndicator
                  usage={usage}
                  contextSize={models.find((m) => m.id === model)?.contextSize}
                  onClear={clearContext}
                  disabled={!!abort}
                />
              )}
            </Stack>
          </Stack>
        </Container>
      </Paper>
      </Box>
    </Box>
  );
}

// One bubble per turn: a user message, or every assistant step of one reply
// (thinking, tool calls, text) in the order they happened.
function MessageBubble({
  parts,
  streaming,
  toolResults,
  forgotten,
  showSteps,
  renderMarkdown,
  failed,
  onResend,
  resendDisabled,
}: {
  parts: ChatMessage[];
  streaming: boolean;
  toolResults: Map<string, ChatMessage>;
  // Above a Clear context divider: shown dimmed since the model can't see it.
  forgotten: boolean;
  // Off: only the answer text shows, no thinking or tool calls (Settings → Chat).
  showSteps: boolean;
  // Off: messages show as typed, Markdown symbols and all (Settings → Chat).
  renderMarkdown: boolean;
  // Error message for the last user message in this turn.
  failed?: string | null;
  // Callback for resending the last user message.
  onResend?: () => void;
  // Disabled state for the resend button.
  resendDisabled?: boolean;
}) {
  // This message's own choice of formatted or raw text; null follows
  // Settings → Chat. Declared before the early return below, as hooks must be.
  const [override, setOverride] = useState<boolean | null>(null);
  const showMarkdown = override ?? renderMarkdown;
  const isUser = parts[0].role === "user";
  const last = parts[parts.length - 1];
  const waiting = showSteps
    ? streaming && !last.content && !last.reasoning && !last.toolCalls?.length
    : streaming && !last.content;
  // With steps hidden, a finished reply that was all steps (e.g. stopped
  // mid-tool) would be an empty box.
  if (!isUser && !showSteps && !waiting && !parts.some((m) => m.content)) return null;
  const hasError = !!failed;
  const errorLine = failed && (
    <Stack spacing={0.5} sx={{ alignItems: isUser ? "flex-end" : "flex-start", mt: 0.5, flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <ErrorOutlineIcon fontSize="small" color="error" />
        {/* The raw error is for debugging, so it waits on hover. */}
        <Tooltip title={failed === INTERRUPTED ? "" : failed}>
          <Typography variant="caption" color="error.main">
            {failureLine(failed)}
          </Typography>
        </Tooltip>
        <Button
          size="small"
          color="error"
          onClick={onResend}
          disabled={resendDisabled}
        >
          Resend
        </Button>
      </Stack>
    </Stack>
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 1, opacity: forgotten ? 0.5 : 1 }}>
      <Paper
        variant={isUser ? "elevation" : "outlined"}
        sx={{
          px: 2,
          py: 1.5,
          // Messages and replies both span the chat.
          width: "100%",
          maxWidth: "100%",
          bgcolor: isUser ? "primary.main" : "background.paper",
          color: isUser ? "primary.contrastText" : "text.primary",
          // Only when failed: replies are outlined, and border: 0 would drop it.
          ...(hasError && { border: 1, borderColor: "error.main" }),
        }}
      >
        <Stack spacing={1}>
          {parts.map((m, i) => (
            <Fragment key={i}>
              {showSteps && m.reasoning && (
                <Accordion disableGutters elevation={0} sx={{ bgcolor: "action.hover", "&:before": { display: "none" } }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant="body2" color="text.secondary">
                      {streaming && m === last && !m.content && !m.toolCalls ? "Thinking…" : "Thoughts"}
                    </Typography>
                    <StepTime
                      stats={m.stats}
                      detail={(s) => `Thought for ${formatSeconds(s.ms)}${s.tokens ? `, ≈${s.tokens.toLocaleString()} tokens` : ""}`}
                    />
                  </AccordionSummary>
                  <AccordionDetails>
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>
                      {m.reasoning}
                    </Typography>
                  </AccordionDetails>
                </Accordion>
              )}
              {m.content &&
                (!showMarkdown ? (
                  <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</Typography>
                ) : m.role === "assistant" ? (
                  <MarkdownRenderer content={m.content} />
                ) : (
                  <MarkdownRenderer content={m.content} breaks onPrimary />
                ))}
              {showSteps &&
                m.toolCalls?.map((c) => (
                  <ToolCallView key={c.id} call={c} result={toolResults.get(c.id)} stopped={!streaming} />
                ))}
            </Fragment>
          ))}
          {waiting && <TypingDots />}
          {!streaming && parts.some((m) => m.content) && (
            <Box sx={{ display: "flex", justifyContent: "flex-end", mb: -1, mr: -1 }}>
              <Tooltip title={showMarkdown ? "Show raw text" : "Show formatted"}>
                <IconButton
                  size="small"
                  onClick={() => setOverride(!showMarkdown)}
                  aria-pressed={!showMarkdown}
                  // The theme's grey would vanish on your blue messages.
                  sx={{ color: isUser ? "inherit" : "text.secondary" }}
                >
                  <CodeOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Stack>
      </Paper>
      {errorLine}
    </Box>
  );
}

// One tool call: what was asked for, and the result once it's back.
// `stopped`: the reply isn't running any more, so a call with no result
// won't get one (it was stopped, or the page reloaded mid-call).
function ToolCallView({
  call,
  result: resultMessage,
  stopped,
}: {
  call: ToolCall;
  result?: ChatMessage;
  stopped: boolean;
}) {
  const result = resultMessage?.content;
  let args: any = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    // Shown raw below; the server reports the bad JSON to the model.
  }
  // find_files and grep take a pattern, web_search a query; show it along with
  // where they looked. run_command shows its command, fetch_url its URL,
  // locate_path what it's looking for.
  const term = args.pattern ?? args.query;
  const target =
    args.command !== undefined || args.url !== undefined || args.description !== undefined
      ? String(args.command ?? args.url ?? args.description)
      : term !== undefined
        ? `"${term}"${args.path ? ` in ${args.path}` : ""}`
        : (args.path ?? "");
  const title = `${call.name}${target ? ` ${target}` : ""}`;
  const failed = result?.startsWith("Error:");
  const [open, setOpen] = useState(false);
  return (
    <Accordion
      disableGutters
      expanded={open}
      onChange={(_, o) => setOpen(o)}
      elevation={0}
      sx={{ mt: 1, bgcolor: "action.hover", "&:before": { display: "none" } }}
    >
      {/* minWidth 0 down the flex chain lets a long title shrink instead of
          widening the reply. */}
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ "& .MuiAccordionSummary-content": { minWidth: 0 } }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          {result === undefined && !stopped ? (
            <CircularProgress size={14} sx={{ flexShrink: 0 }} />
          ) : (
            <BuildOutlinedIcon fontSize="small" color={failed ? "error" : "action"} sx={{ flexShrink: 0 }} />
          )}
          {/* Cut with "…" while collapsed; expanded, the whole command wraps. */}
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", ...(open && { overflowWrap: "anywhere" }) }}
            noWrap={!open}
            title={open ? undefined : title}
          >
            {title}
          </Typography>
        </Stack>
        <StepTime
          stats={resultMessage?.stats}
          detail={(s) =>
            `Ran in ${formatSeconds(s.ms)}` +
            (s.tokens !== undefined ? `; the result added ≈${s.tokens.toLocaleString()} tokens to the context` : "")
          }
        />
      </AccordionSummary>
      <AccordionDetails>
        <Typography
          variant="body2"
          component="pre"
          sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 300, overflowY: "auto" }}
        >
          {result ??
            (stopped
              ? `Didn't finish: the reply stopped before this call returned. It was called with ${call.arguments || "{}"}.`
              : `Running with ${call.arguments || "{}"}…`)}
        </Typography>
      </AccordionDetails>
    </Accordion>
  );
}

// The prompt for whatever a reply is waiting on.
function PendingPrompt({ ask, onDecide }: { ask: Ask; onDecide: (answer: Answer) => void }) {
  if ("needsApproval" in ask) return <ApprovalPrompt approval={ask.needsApproval} onDecide={onDecide} />;
  if ("needsLocation" in ask) {
    const { description, kind } = ask.needsLocation;
    return (
      <FindPrompt
        heading={`The model needs you to find this ${kind}:`}
        subject={description}
        isPath={false}
        icon={<TravelExploreIcon fontSize="small" />}
        kinds={kind === "file" ? ["file", "folder"] : ["folder", "file"]}
        onDecide={onDecide}
      />
    );
  }
  const { path, kind } = ask.needsAccess;
  if (kind) return <AccessPrompt target={{ path, kind }} onDecide={onDecide} />;
  return (
    <FindPrompt
      heading="The model is looking for this, but nothing is there:"
      subject={path}
      isPath
      icon={<SearchOffIcon fontSize="small" />}
      // A name with an extension is probably a file.
      kinds={/\.[^/]+$/.test(path) ? ["file", "folder"] : ["folder", "file"]}
      onDecide={onDecide}
    />
  );
}

// Shown while a reply waits: the model asked for a path that exists but
// isn't attached. Allowing attaches it for the rest of the chat.
function AccessPrompt({ target, onDecide }: { target: AttachmentTarget; onDecide: (allow: boolean) => void }) {
  return (
    <Alert severity="warning" icon={<AttachmentIcon kind={target.kind} />}>
      <Typography variant="body2">
        The model wants access to this {target.kind}, which isn't attached to this chat:
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere", my: 0.5 }}>
        {target.path}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div">
        Allowing attaches it to this chat{target.kind === "folder" ? ", subfolders included" : ""}. Changes to it
        still need your approval.
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
        <Button size="small" variant="contained" color="warning" onClick={() => onDecide(true)}>
          Allow
        </Button>
        <Button size="small" variant="outlined" color="inherit" onClick={() => onDecide(false)}>
          Deny
        </Button>
      </Stack>
    </Alert>
  );
}

// Three dots that grow and shrink in turn while a reply hasn't started.
const typingDot = keyframes({
  "0%, 80%, 100%": { transform: "scale(0.4)", opacity: 0.4 },
  "40%": { transform: "scale(1)", opacity: 1 },
});

function TypingDots() {
  return (
    <Box
      role="status"
      aria-label="Waiting for a reply"
      // A line of text tall, so the bubble doesn't jump when words arrive.
      sx={{ display: "flex", alignItems: "center", gap: 0.5, height: "1.5em" }}
    >
      {[0, 0.2, 0.4].map((delay) => (
        <Box
          key={delay}
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            bgcolor: "text.secondary",
            animation: `${typingDot} 1.4s ease-in-out ${delay}s infinite`,
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }}
        />
      ))}
    </Box>
  );
}

// Shown while a reply waits for the user to find something: a file or folder
// the model knows only by name (locate_path), or a path it guessed where
// nothing exists. What they pick in the system dialog is attached and given
// to the model.
function FindPrompt({
  heading,
  subject,
  isPath,
  icon,
  kinds,
  onDecide,
}: {
  heading: string;
  subject: string;
  // The subject is a path (monospace) rather than a description.
  isPath: boolean;
  icon: ReactNode;
  // Which pick buttons to offer, the likelier first.
  kinds: AttachmentTarget["kind"][];
  onDecide: (answer: Answer) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancelling the dialog leaves the prompt up.
  const pick = (kind: AttachmentTarget["kind"]) => {
    setPicking(true);
    setError(null);
    pickAttachments(kind)
      .then((picked) => picked.length && onDecide(picked))
      .catch((e) => setError(e.message))
      .finally(() => setPicking(false));
  };
  return (
    <Alert severity="warning" icon={icon}>
      <Typography variant="body2">{heading}</Typography>
      <Typography
        variant="body2"
        sx={{ fontFamily: isPath ? "monospace" : undefined, fontWeight: isPath ? undefined : 500, overflowWrap: "anywhere", my: 0.5 }}
      >
        {subject}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div">
        Choose it and it's attached to this chat; the model then uses that path.
      </Typography>
      {error && (
        <Typography variant="caption" color="error" component="div">
          {error}
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: "wrap", alignItems: "center" }}>
        {kinds.map((k, i) => (
          <Button
            key={k}
            size="small"
            variant={i === 0 ? "contained" : "outlined"}
            color="warning"
            startIcon={<AttachmentIcon kind={k} />}
            onClick={() => pick(k)}
            disabled={picking}
          >
            Choose {k}…
          </Button>
        ))}
        <Button size="small" variant="outlined" color="inherit" onClick={() => onDecide(false)} disabled={picking}>
          Deny
        </Button>
        {picking && <CircularProgress size={18} />}
      </Stack>
    </Alert>
  );
}

type ChangeApproval = Extract<Approval, { type: "change" }>;

const CHANGE_VERB: Record<ChangeApproval["action"], string> = {
  create: "create",
  overwrite: "replace everything in",
  edit: "change",
};

// Shown while a reply waits on the user: a file change as a diff, or a
// command and where it runs, with Approve (Run) / Deny. Nothing happens until
// the user approves.
function ApprovalPrompt({ approval, onDecide }: { approval: Approval; onDecide: (allow: boolean) => void }) {
  const isCommand = approval.type === "command";
  return (
    <Alert
      severity={isCommand ? "warning" : "info"}
      icon={isCommand ? <TerminalOutlinedIcon fontSize="small" /> : <EditOutlinedIcon fontSize="small" />}
      sx={{ "& .MuiAlert-message": { minWidth: 0, flexGrow: 1 } }}
    >
      {isCommand ? (
        <>
          <Typography variant="body2">The model wants to run this command:</Typography>
          <Box
            component="pre"
            sx={{ m: 0, my: 1, p: 1, borderRadius: 1, bgcolor: "background.default", fontFamily: "monospace", fontSize: "0.85rem", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            $ {approval.command}
          </Box>
          <Typography variant="caption" color="text.secondary" component="div">
            In {approval.cwd}. It runs as you, with your network access and credentials.
          </Typography>
        </>
      ) : (
        <>
          <Typography variant="body2">The model wants to {CHANGE_VERB[approval.action]} this file:</Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere", my: 0.5 }}>
            {approval.path}
          </Typography>
          <DiffView diff={approval.diff} />
        </>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
        <Button size="small" variant="contained" color={isCommand ? "warning" : "primary"} onClick={() => onDecide(true)}>
          {isCommand ? "Run" : "Approve"}
        </Button>
        <Button size="small" variant="outlined" color="inherit" onClick={() => onDecide(false)}>
          Deny
        </Button>
      </Stack>
    </Alert>
  );
}

// Unified diff with added lines green and removed lines red.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        maxHeight: 320,
        overflow: "auto",
        borderRadius: 1,
        bgcolor: "background.default",
        fontFamily: "monospace",
        fontSize: "0.8rem",
      }}
    >
      {lines.map((l, i) => (
        <Box
          key={i}
          component="div"
          sx={{
            whiteSpace: "pre",
            color: l.startsWith("+") ? "success.main" : l.startsWith("-") ? "error.main" : l.startsWith("@@") ? "info.main" : "text.secondary",
          }}
        >
          {l || " "}
        </Box>
      ))}
    </Box>
  );
}

const formatSeconds = (ms: number) => {
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
};

// A step's duration, right-aligned next to its expander arrow; hovering it
// shows the details (token counts).
function StepTime({ stats, detail }: { stats?: StepStats; detail: (s: StepStats) => string }) {
  if (!stats) return null;
  return (
    <Tooltip title={detail(stats)}>
      <Typography variant="caption" color="text.secondary" sx={{ ml: "auto", pl: 2, flexShrink: 0, alignSelf: "center" }}>
        {formatSeconds(stats.ms)}
      </Typography>
    </Tooltip>
  );
}

// Share of the context window above which the meter warns.
const CONTEXT_WARN_AT = 0.8;
const CONTEXT_FULL_AT = 0.95;

// How much of the model's context the conversation fills. Past the limit
// llama.cpp drops the oldest tokens, so the model starts forgetting the
// beginning of the chat.
const contextShare = (usage: Usage | null, contextSize?: number) =>
  usage && contextSize ? usage.contextTokens / contextSize : 0;
const contextColor = (share: number) =>
  share >= CONTEXT_FULL_AT ? "error" : share >= CONTEXT_WARN_AT ? "warning" : "primary";

// Small "% left" ring under Send. Clicking it opens the full meter with the
// Clear context button. It takes the warning colors so a filling context is
// noticeable without opening it.
function ContextIndicator({
  usage,
  contextSize,
  onClear,
  disabled,
}: {
  usage: Usage | null;
  contextSize?: number;
  onClear: () => void;
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const share = contextShare(usage, contextSize);
  const color = contextColor(share);
  const left = Math.max(0, 100 - share * 100);
  const label = usage && contextSize ? `${left >= 10 ? left.toFixed(0) : left.toFixed(1)}% left` : "Context";

  return (
    <Box sx={{ display: "flex" }}>
      <Tooltip title="Context left. Click for details and to clear it.">
        <ButtonBase
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ borderRadius: 1, px: 0.5, gap: 0.75, color: color === "primary" ? "text.secondary" : `${color}.main` }}
        >
          {/* A faint full circle behind the used share, so the ring reads as a
              gauge even when almost empty. */}
          <Box sx={{ position: "relative", display: "flex" }}>
            <CircularProgress
              variant="determinate"
              value={100}
              size={12}
              thickness={6}
              sx={{ color: "action.disabled" }}
            />
            <CircularProgress
              variant="determinate"
              value={Math.max(share * 100, 2)}
              size={12}
              thickness={6}
              color={color}
              sx={{ position: "absolute", left: 0 }}
            />
          </Box>
          <Typography variant="caption" sx={{ lineHeight: 1 }}>
            {label}
          </Typography>
        </ButtonBase>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { p: 2, width: 360, maxWidth: "calc(100vw - 32px)" } } }}
      >
        <Stack spacing={1.5}>
          {usage ? (
            <ContextMeter usage={usage} contextSize={contextSize} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              No token count yet; it updates after the next reply.
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            Clearing keeps the messages on screen, but the model stops seeing them.
          </Typography>
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<LayersClearOutlinedIcon />}
              disabled={disabled}
              onClick={() => {
                onClear();
                setAnchor(null);
              }}
            >
              Clear context
            </Button>
          </Box>
        </Stack>
      </Popover>
    </Box>
  );
}

function ContextMeter({ usage, contextSize }: { usage: Usage; contextSize?: number }) {
  const share = contextShare(usage, contextSize);
  const color = contextColor(share);
  const speed = usage.tokensPerSecond ? ` · ${Math.round(usage.tokensPerSecond)} tok/s` : "";
  return (
    <Box>
      <Stack direction="row" sx={{ justifyContent: "space-between", mb: 0.5, gap: 2 }}>
        <Typography variant="caption" color={color === "primary" ? "text.secondary" : `${color}.main`}>
          {share >= CONTEXT_FULL_AT
            ? "Context almost full: the model will start forgetting the start of this chat. Start a new chat."
            : share >= CONTEXT_WARN_AT
              ? "Context getting full."
              : "Context"}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
          {usage.contextTokens.toLocaleString()}
          {contextSize ? ` / ${contextSize.toLocaleString()} tokens (${Math.max(share * 100, 0.1).toFixed(1)}%)` : " tokens"}
          {speed}
        </Typography>
      </Stack>
      {contextSize && (
        <LinearProgress
          variant="determinate"
          value={Math.min(share * 100, 100)}
          color={color}
          sx={{ height: 4, borderRadius: 2 }}
        />
      )}
    </Box>
  );
}

// Marks where Clear context cut the conversation.
function ContextDivider() {
  return (
    <Divider>
      <Chip size="small" variant="outlined" label="Context cleared · the model doesn't see messages above" />
    </Divider>
  );
}
