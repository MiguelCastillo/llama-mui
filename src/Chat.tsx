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
  Fab,
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
  type TypographyProps,
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
import CompressOutlinedIcon from "@mui/icons-material/CompressOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
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
  type PlanStep,
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
import {
  PLANNING_NOTE,
  PLANNING_TOOLS,
  PlanView,
  type WholeFile,
  checkRoom,
  disputeHolds,
  disputeNote,
  disputePrompt,
  filesChanged,
  planFromCall,
  reviewStep,
  stepPrompt,
  uncheckedPrompt,
  weighDispute,
} from "./Plan";

// Per-browser choices kept in localStorage: whether the toolbar is expanded,
// and whether the Tools switch is on. Storage can be unavailable (private
// windows), so failures fall back to the default.
const TOOLBAR_KEY = "llama-mui:toolbarOpen";
// Off until the user turns it on: tools can read files, change them and run
// commands, so they're something to opt into.
const TOOLS_KEY = "llama-mui:toolsOn";
// On by default: with tools on, a task gets a plan that chat runs and checks.
const PLAN_KEY = "llama-mui:planOn";
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
  const [planWanted, setPlanWantedState] = useState(() => loadFlag(PLAN_KEY, true));
  const setPlanWanted = (on: boolean) => {
    setPlanWantedState(on);
    saveFlag(PLAN_KEY, on);
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
  // The task's steps (see Plan.tsx). The ref is the latest plan for the plan
  // runner, which reads it between awaits; change it only with changePlan.
  const [plan, setPlan] = useState<PlanStep[] | null>(null);
  const planRef = useRef<PlanStep[] | null>(null);
  const changePlan = (next: PlanStep[] | null) => {
    planRef.current = next;
    setPlan(next);
  };
  // A change the model suggested to a plan that's under way; see reply().
  const [planProposal, setPlanProposal] = useState<PlanStep[] | null>(null);
  const answerProposal = (accept: boolean) => {
    // Matched again by text: the user may have changed the plan since.
    const old = planRef.current ?? [];
    if (accept && planProposal) changePlan(planProposal.map((p) => old.find((o) => o.text === p.text) ?? p));
    setPlanProposal(null);
  };
  // The ref is for code that runs inside the plan runner's own awaits, where
  // the state would still be the value from before the run started.
  const [planRunning, setPlanRunning] = useState(false);
  const planRunningRef = useRef(false);
  // When the current task started, for the counter beside the waiting dots
  // (and on the plan card while a plan runs): from sending
  // (or Run) until nothing is left running, so a plan's steps and checks
  // count as one task even though each turn sets and clears `abort`.
  const [busySince, setBusySince] = useState<number | null>(null);
  // Pieces streamed in the current round and when the first one came, for
  // the live tokens per second beside the counter. llama.cpp streams about
  // one token per piece. A ref, since it changes on every piece.
  const streamRate = useRef<StreamRate>({ pieces: 0, first: 0 });
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the chat follows new output: while you're at the bottom. Scrolling
  // up stops it, so you can read back while a reply streams (it used to pull
  // you down on every token); scrolling back down, the arrow, or sending
  // starts it again. The ref is for the scroll effect, which runs per token.
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const setFollowing = (on: boolean) => {
    followingRef.current = on;
    setFollowingState(on);
  };
  const lastScrollTop = useRef(0);
  const fromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
  // Only a scroll up stops following. Output landing and the trackpad's bounce
  // at the end change the distance from the bottom too, and judging by that
  // alone flipped following off and on while you scrolled down.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollTop < lastScrollTop.current - 1;
    lastScrollTop.current = el.scrollTop;
    if (up && fromBottom(el) > 80) {
      if (followingRef.current) setFollowing(false);
    } else if (fromBottom(el) < 80 && !followingRef.current) setFollowing(true);
  };
  // Moves only the chat box (scrollIntoView moved the page too), and only when
  // it isn't at the bottom yet: reasoning tokens update the messages dozens of
  // times a second with nothing new on screen, and each scroll was a jitter.
  const stickToBottom = () => {
    const el = scrollRef.current;
    if (!el || fromBottom(el) <= 1) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  };
  const toBottom = () => {
    setFollowing(true);
    stickToBottom();
  };

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
  const keyOf = (s: Session) => JSON.stringify([s.title, s.model, s.messages, s.contextStart, s.attachments, s.usage, s.failed, s.plan, s.planProposal]);

  const applySession = (s: Session) => {
    savedKey.current = keyOf(s);
    setMessages(s.messages);
    setContextStart(s.contextStart);
    setAttachments(s.attachments);
    setUsage(s.usage);
    setFailed(s.failed ?? null);
    // A step that was running when the page went away didn't finish.
    changePlan(
      s.plan?.map((st) => ({
        ...st,
        id: st.id ?? crypto.randomUUID(),
        status: st.status === "running" ? "pending" : st.status,
      })) ?? null,
    );
    setPlanProposal(s.planProposal ?? null);
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
      plan,
      planProposal,
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
  }, [loaded, messages, contextStart, attachments, usage, model, abort, failed, plan, planProposal]);

  // Switches to another chat, saving this one first unless it was deleted.
  const openSession = (id: string, saveFirst = true) => {
    if (abort || planRunningRef.current) return;
    if (saveFirst) saveNow();
    setFollowing(true);
    setSessionId(id);
    saveSessionId(id);
    savedKey.current = "";
    setMessages([]);
    setUsage(null);
    setContextStart(0);
    setAttachments([]);
    setFailed(null);
    changePlan(null);
    setPlanProposal(null);
    setDrawerOpen(false);
    loadSession(id);
  };
  const newChat = () => openSession(crypto.randomUUID());
  // Deleting asks first, in a Dialog: window.confirm is answered "no" at once,
  // without being shown, in some browsers (the Claude app's browser pane).
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const removeSession = (id: string) => setConfirmDelete(id);
  const deleteConfirmed = () => {
    const id = confirmDelete;
    setConfirmDelete(null);
    if (!id) return;
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
  const busy = !!abort || planRunning;
  useEffect(() => {
    setBusySince((since) => (busy ? (since ?? Date.now()) : null));
  }, [busy]);

  const toolName = (d: unknown) => (d as { function: { name: string } }).function.name;
  const canPlan = toolsOn && toolContext.definitions.some((d) => toolName(d) === "update_plan");
  const planOn = canPlan && planWanted;
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

  // Not smooth: an animation per token never caught up, and fought the user.
  useEffect(() => {
    if (followingRef.current) stickToBottom();
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
    if (!text || !model || !connector || abort || planRunning) return;
    setInput("");
    toBottom();
    reply(text, messages, { planning: planOn });
  };

  // Streams a reply, building history from `before` instead of `messages`.
  // Called by `send()` for new messages, by `retry()` for failed ones, and by
  // `runPlan()` for each step. Returns the messages it ended with, and whether
  // the model finished (not stopped, failed or cut off by a limit).
  // `planning`: this turn only writes a plan (see PLANNING_NOTE). `planStep`:
  // the turn runs that plan step; its messages carry the step's id and show
  // under the step, and a failure stays with the step instead of offering Resend.
  const reply = async (
    text: string,
    before: ChatMessage[],
    { planning = false, planStep }: { planning?: boolean; planStep?: string } = {},
  ): Promise<{ ok: boolean; messages: ChatMessage[]; error?: string }> => {
    const tag = planStep ? { planStep } : {};
    let error: string | undefined;
    if (!connector) return { ok: false, messages: before };
    let ok = false;
    const connectorId = connector.id;
    // Fixed for this reply, even if the user changes attachments meanwhile;
    // only paths the user allows mid-reply are added.
    let attached = attachments.map((a) => a.path);
    const forgotten = before.slice(0, contextStart);
    let history: ChatMessage[] = [...before.slice(contextStart), { role: "user", content: text, ...tag }];
    setError(null);
    setFailed(null);

    const controller = new AbortController();
    setAbort(controller);
    const started = performance.now();
    // For took: pieces and streaming time over all rounds, and the server's
    // speed for the latest round.
    let pieces = 0;
    let streamedMs = 0;
    let serverTps: number | undefined;
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
      // A planning turn's job is done once a plan lands. Asked to go on, the
      // model rewrote it instead: 16 update_plan calls in one turn, each
      // reworded, so the repeat guard never fired.
      let planned = false;
      for (let round = 0; ; round++) {
        const lastTurn: boolean = stopReason !== null;
        const reply: ChatMessage = { role: "assistant", content: "", reasoning: "", ...tag };
        let thinkStart = 0;
        let thinkEnd = 0;
        let thinkPieces = 0;
        const show = () => setMessages([...forgotten, ...history, { ...reply }]);
        streamRate.current = { pieces: 0, first: 0 };
        // The empty reply goes on screen before the request is sent, so its
        // bubble shows the waiting dots from the start, not from the first
        // token (see `waiting` in MessageBubble).
        show();
        const { toolCalls: asked, usage: replyUsage } = await streamChat(
          {
            connectorId,
            model,
            messages:
              toolsOn && !lastTurn && toolContext.systemPrompt
                ? [
                    {
                      role: "system",
                      content: planning ? `${toolContext.systemPrompt}\n\n${PLANNING_NOTE}` : toolContext.systemPrompt,
                    },
                    ...history,
                  ]
                : history,
            think: thinkOn,
            tools:
              toolsOn && !lastTurn
                ? planning
                  ? toolContext.definitions.filter((d) => PLANNING_TOOLS.has(toolName(d)))
                  : toolContext.definitions
                : undefined,
          },
          (d) => {
            streamRate.current.first ||= performance.now();
            streamRate.current.pieces++;
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
        const r = streamRate.current;
        if (r.first) {
          pieces += r.pieces;
          streamedMs += performance.now() - r.first;
        }
        serverTps = replyUsage?.tokensPerSecond ?? serverTps;
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
          ok = !stopReason;
          break;
        }

        for (const call of toolCalls) {
          if (controller.signal.aborted) return { ok, messages: [...forgotten, ...history] };
          let started = performance.now();
          let result: string;
          let diff: string | undefined;
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
              if (controller.signal.aborted) return { ok, messages: [...forgotten, ...history] };
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
                if (approval.type === "change") diff = approval.diff;
                // The server asks again if, say, the file changed since the preview.
                outcome = await runTool(call, { chatId: sessionId, attachments: attached, approved: approval });
              }
            }
            result = outcome.result;
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
          if (CHANGES_DISK.has(call.name) && !result.startsWith("Error:")) ran.clear();
          if (call.name === "update_plan" && !result.startsWith("Error:")) {
            const old = planRef.current ?? [];
            const steps = planFromCall(call.arguments, old, planRunningRef.current);
            // A plan under way is the user's: outside a run, the model's change
            // waits for them. Asked about a failed step, the model once
            // "proposed" a fix by sending only that step, deleting the other 7.
            const underway = old.some((st) => st.status !== "pending") && old.some((st) => st.status !== "done");
            if (steps && underway && !planRunningRef.current) {
              setPlanProposal(steps);
              result =
                "Proposed, not made: the user sees your change next to the plan and decides. Tell them what you changed and why.";
            } else if (steps) changePlan(steps);
            if (steps && planning) planned = true;
          }
          lastToolResults.push(history.length);
          history = [
            ...history,
            {
              role: "tool",
              content: result,
              toolCallId: call.id,
              stats: { ms: performance.now() - started },
              ...(diff && !result.startsWith("Error:") && { diff }),
              ...tag,
            },
          ];
          setMessages([...forgotten, ...history]);
        }
        if (planned) {
          ok = true;
          break;
        }
        if (round === MAX_TOOL_ROUNDS - 1) stopReason ??= `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls.`;
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        error = String(e);
        if (!planStep) setFailed(error);
      }
    } finally {
      setAbort(null);
      // The server loads models on demand, so a reply can change their status.
      refreshModels(connectorId);
    }
    const lastReply = history.map((m) => m.role).lastIndexOf("assistant");
    if (lastReply >= 0) {
      history = history.map((m, i) =>
        i === lastReply
          ? {
              ...m,
              took: {
                ms: performance.now() - started,
                // Under half a second of streaming is too short to rate.
                clientTps: streamedMs >= 500 ? pieces / (streamedMs / 1000) : undefined,
                serverTps,
              },
            }
          : m,
      );
      setMessages([...forgotten, ...history]);
    }
    return { ok, messages: [...forgotten, ...history], error };
  };

  // Changes one step, keeping its text. The patch replaces the rest, so a
  // step that runs again loses its old note and "may need a rerun" mark.
  const setStep = (i: number, patch: Omit<PlanStep, "id" | "text">) => {
    const steps = planRef.current;
    if (steps?.[i]) changePlan(steps.map((st, j) => (j === i ? { id: st.id, text: st.text, ...patch } : st)));
  };

  // The files a step changed, as they are now, for its check. Read under a
  // chat id of its own, so the model's read-before-edit record
  // (server/reads.ts) only has what the model read itself.
  const readWhole = (paths: string[]): Promise<WholeFile[]> =>
    Promise.all(
      paths.map(async (path) => {
        const call = { id: "check", name: "read_file", arguments: JSON.stringify({ path, max_lines: Number.MAX_SAFE_INTEGER }) };
        try {
          const out = await runTool(call, { chatId: `${sessionId}:check`, attachments: attachments.map((a) => a.path) });
          if (!("result" in out)) return { path, error: "it isn't attached to this chat" };
          if (out.result.startsWith("Error:")) return { path, error: out.result.slice(7).trim() };
          // After read_file's "<path> (lines 1-N of N)" line.
          const text = out.result.slice(out.result.indexOf("\n") + 1);
          return { path, text, cut: /… \(output cut at \d+ characters\)$/.test(text) };
        } catch (e: any) {
          return { path, error: e.message };
        }
      }),
    );

  // Checks a step's turn with reviewStep. Null if it couldn't be checked
  // (stopped, or the server failed), which leaves the step open. The files
  // are the ones any step of the plan changed, in any run: a step whose work
  // is already done (by a rerun before, or by an earlier step) changes
  // nothing, and the check then saw no file at all.
  const checkStep = async (step: string, stepMessages: ChatMessage[], planMessages: ChatMessage[]) => {
    if (!connector) return null;
    const controller = new AbortController();
    setAbort(controller);
    try {
      const files = await readWhole(filesChanged(planMessages));
      const room = checkRoom(models.find((m) => m.id === model)?.contextSize);
      return await reviewStep(
        { connectorId: connector.id, model, think: thinkOn, room },
        step,
        stepMessages,
        files,
        controller.signal,
      );
    } catch (e: any) {
      if (!controller.signal.aborted) setError(`Couldn't check the step: ${e.message}`);
      return null;
    } finally {
      setAbort(null);
    }
  };

  // Runs the plan's open steps in order, one turn each, and checks every step
  // before ticking it off: the model saying it's done isn't enough. A step that
  // isn't done gets one retry with what's missing, then waits for the user.
  const runPlan = async () => {
    if (!connector || !model || abort || planRunningRef.current) return;
    planRunningRef.current = true;
    setPlanRunning(true);
    let msgs = messages;
    // A step the check couldn't judge; the model proposes a plan change after the run.
    let unchecked: { i: number; why: string } | null = null;
    try {
      for (;;) {
        const steps = planRef.current;
        // A disputed step waits for the user, and the steps after it with it.
        const i = steps?.findIndex((st) => st.status !== "done") ?? -1;
        if (!steps || i < 0 || steps[i].status === "disputed") break;
        const { id, text } = steps[i];
        setStep(i, { status: "running" });
        // `start` is the step's first message, for slicing out its turns;
        // `startedAt` is when it began, for its time.
        const start = msgs.length;
        const startedAt = performance.now();
        const took = () => performance.now() - startedAt;
        let r = await reply(stepPrompt(steps, i), msgs, { planStep: id });
        msgs = r.messages;
        let check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep)) : null;
        if (check && !check.done && !check.unchecked) {
          const missing = check.missing ?? "";
          const retryStart = msgs.length;
          r = await reply(disputePrompt(i, missing), msgs, { planStep: id });
          msgs = r.messages;
          // Said the check is wrong and changed nothing: checking again would
          // only repeat the check, so the step waits for the user. Shown
          // evidence makes it disputed; a bare claim leaves it failed.
          const d = r.ok ? weighDispute(msgs.slice(retryStart), msgs.slice(start)) : null;
          if (d?.verdict === "wrong" && !d.changed) {
            setStep(i, { status: disputeHolds(d) ? "disputed" : "failed", note: disputeNote(missing, d), ms: took() });
            break;
          }
          check = r.ok ? await checkStep(text, msgs.slice(start), msgs.filter((m) => m.planStep)) : null;
        }
        if (!check) {
          setStep(i, r.error ? { status: "pending", note: `The reply failed: ${failureLine(r.error)}` } : { status: "pending" });
          break;
        }
        if (check.unchecked) {
          setStep(i, { status: "failed", note: check.unchecked, ms: took() });
          unchecked = { i, why: check.unchecked };
          break;
        }
        setStep(i, check.done ? { status: "done", ms: took() } : { status: "failed", note: check.missing, ms: took() });
        if (!check.done) break;
      }
    } finally {
      planRunningRef.current = false;
      setPlanRunning(false);
    }
    // Outside the run, so its update_plan becomes a proposal (see reply()).
    if (unchecked) await reply(uncheckedPrompt(unchecked.i, unchecked.why), msgs, { planning: true });
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
  const lastUserTurn = turns.map((t) => t.parts[0].role).lastIndexOf("user");
  // One turn drawn as a bubble; `i` is its place among all turns.
  const bubble = (t: (typeof turns)[number], i: number) => (
    <MessageBubble
      key={t.start}
      parts={t.parts}
      streaming={!!abort && i === turns.length - 1}
      since={busySince}
      rate={streamRate}
      toolResults={toolResults}
      forgotten={t.start < contextStart}
      showSteps={prefs?.showSteps ?? true}
      renderMarkdown={prefs?.renderMarkdown ?? true}
      failed={i === lastFailedTurnIndex ? failed : undefined}
      onResend={i === lastFailedTurnIndex ? retry : undefined}
      resendDisabled={i === lastFailedTurnIndex ? !!abort : undefined}
    />
  );
  // A plan step's failure shows on the step, which offers Continue.
  const lastFailedTurnIndex = lastUserTurn >= 0 && !turns[lastUserTurn].parts[0].planStep ? lastUserTurn : -1;
  const hasContext = messages.length > contextStart;
  const showIndicator = hasContext && !!prefs?.showContextMeter;

  const clearContext = () => {
    setContextStart(messages.length);
    setUsage(null);
  };

  // Asks in a Dialog first, like deleting a chat: window.confirm is answered
  // "no" at once, without being shown, in some browsers.
  const [confirmCompact, setConfirmCompact] = useState(false);
  const compactSession = () => setConfirmCompact(true);
  const compactConfirmed = () => {
    setConfirmCompact(false);
    if (contextStart > 0) {
      // Remove forgotten messages from the array
      setMessages(messages.slice(contextStart));
      setContextStart(0);
      setUsage(null);
      // Also update savedKey so we don't save again
      savedKey.current = "";
    }
  };

  return (
    <Box sx={{ display: "flex", height: "100dvh" }}>
      <SessionsPanel
        sessions={sessions}
        currentId={sessionId}
        open={narrow ? drawerOpen : sessionsOpen}
        narrow={narrow}
        busy={!!abort || planRunning}
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
            <Tooltip
              title={
                canPlan
                  ? "For a task, the model first writes a plan; chat runs it one step at a time and checks each step."
                  : "Needs Tools, with Plan tasks on in Settings → Tools."
              }
            >
              <FormControlLabel
                label="Plan"
                control={<Switch checked={planOn} onChange={(e) => setPlanWanted(e.target.checked)} />}
                disabled={!!abort || !canPlan}
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

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs">
        <DialogTitle>Delete this chat?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            “{sessions.find((s) => s.id === confirmDelete)?.title ?? "This chat"}” and its messages will be deleted.
            This can't be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={deleteConfirmed}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmCompact} onClose={() => setConfirmCompact(false)} maxWidth="xs">
        <DialogTitle>Compact this session?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes the messages from before you last cleared the context. The model already doesn't see
            them. This can't be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCompact(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={compactConfirmed}>
            Compact
          </Button>
        </DialogActions>
      </Dialog>

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
      <Box ref={scrollRef} onScroll={onScroll} sx={{ flexGrow: 1, overflowY: "auto", pt: 9, pb: 3, position: "relative" }}>
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
                // Three quarters of the way down the chat area, near the message box:
                // placed against the scrolling box (position: relative), so it stays
                // in proportion at any window size.
                <Typography
                  variant="h3"
                  sx={{
                    position: "absolute",
                    top: "75%",
                    left: 0,
                    right: 0,
                    transform: "translateY(-50%)",
                    textAlign: "center",
                    fontWeight: 500,
                  }}
                >
                  How can I help you?
                </Typography>
              )
            )}
            {turns.map(
              (t, i) =>
                // A plan step's turns show under the step instead, waiting
                // dots included; the step's spinner shows progress here.
                !t.parts[0].planStep && (
                  <Fragment key={t.start}>
                    {t.start === contextStart && contextStart > 0 && <ContextDivider />}
                    {bubble(t, i)}
                  </Fragment>
                ),
            )}
            {/* Cleared after the last message: the divider goes at the end. */}
            {contextStart > 0 && contextStart === messages.length && <ContextDivider />}
            {plan && (
              <PlanView
                steps={plan}
                running={planRunning || !!abort}
                since={planRunning ? busySince : null}
                counter={(since) => <Elapsed since={since} rate={streamRate} variant="caption" color="text.secondary" />}
                onRun={runPlan}
                onChange={changePlan}
                proposal={planProposal}
                onProposal={answerProposal}
                details={(id) => {
                  const own = turns.flatMap((t, i) => (t.parts[0].planStep === id ? [bubble(t, i)] : []));
                  return own.length ? own : null;
                }}
                formatTime={formatSeconds}
              />
            )}
            {pending && <PendingPrompt ask={pending.ask} onDecide={pending.decide} />}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </Container>
        {/* Sticky with no height: it floats over the bottom of the chat
            without adding space under the last message. */}
        {!following && messages.length > 0 && (
          <Box sx={{ position: "sticky", bottom: 16, height: 0, display: "flex", justifyContent: "center" }}>
            <Tooltip title="Jump to the latest and keep following">
              <Fab size="small" color="primary" onClick={toBottom} sx={{ mt: -5 }} aria-label="Jump to the latest">
                <KeyboardArrowDownIcon />
              </Fab>
            </Tooltip>
          </Box>
        )}
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
                  onCompact={compactSession}
                  canCompact={contextStart > 0}
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
  since,
  rate,
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
  // While this reply streams: when the task started, for the counter beside
  // the waiting dots, and how fast the current round is streaming.
  since?: number | null;
  rate?: { current: StreamRate };
}) {
  // This message's own choice of formatted or raw text; null follows
  // Settings → Chat. Declared before the early return below, as hooks must be.
  const [override, setOverride] = useState<boolean | null>(null);
  const showMarkdown = override ?? renderMarkdown;
  // The finished reply's time and speed, kept on its last message.
  const took = [...parts].reverse().find((m) => m.took)?.took;
  const isUser = parts[0].role === "user";
  const last = parts[parts.length - 1];
  // The waiting dots: shown while the reply's newest turn has nothing yet,
  // which is from sending until the first text, thinking or tool call, and
  // again between rounds of tool calls (each round starts a new, empty turn).
  // Once thinking streams, the thinking panel shows instead, with the same
  // dots in its header until the thinking ends. A plan step's
  // turns render under the step, so during a run its dots are inside the
  // collapsed details and the step's own spinner is what shows.
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
                    {/* While it's thinking, the same dots as waiting for a reply. */}
                    {streaming && m === last && !m.content && !m.toolCalls ? (
                      <TypingDots label="Thinking" />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Thoughts
                      </Typography>
                    )}
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
          {streaming && since != null ? (
            // The counter sits beside the waiting dots, and stays on this
            // line once text streams in and the dots go.
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: "1.5em" }}>
              {waiting && <TypingDots />}
              <Elapsed since={since} rate={rate} variant="caption" color="text.secondary" />
            </Box>
          ) : (
            waiting && <TypingDots />
          )}
          {!streaming && parts.some((m) => m.content) && (
            <Box sx={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 1, mb: -1, mr: -1 }}>
              {took && (
                <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatSeconds(took.ms)}
                  {took.clientTps ? ` · ${Math.round(took.clientTps)} tps (client)` : ""}
                  {took.serverTps ? ` · ${Math.round(took.serverTps)} tps (server)` : ""}
                </Typography>
              )}
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

function TypingDots({ label = "Waiting for a reply" }: { label?: string }) {
  return (
    <Box
      role="status"
      aria-label={label}
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

interface StreamRate {
  pieces: number;
  // performance.now() of the round's first piece; 0 until it arrives.
  first: number;
}

// Time since `since`, in whole seconds ("42s", "1m 05s"), updated every second,
// and with `rate`, the current round's tokens per second once it has streamed
// for a second (so the wait before the first token doesn't count). Other
// props go to the Typography.
function Elapsed({ since, rate, ...rest }: { since: number; rate?: { current: StreamRate } } & TypographyProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  const r = rate?.current;
  const streamedFor = r?.first ? (performance.now() - r.first) / 1000 : 0;
  const speed = r && streamedFor >= 1 ? ` · ${Math.round(r.pieces / streamedFor)} tps (client)` : "";
  return (
    <Typography component="span" variant="inherit" {...rest} sx={{ fontVariantNumeric: "tabular-nums", ...rest.sx }}>
      {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`}
      {speed}
    </Typography>
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
  onCompact,
  canCompact,
  disabled,
}: {
  usage: Usage | null;
  contextSize?: number;
  onClear: () => void;
  onCompact: () => void;
  // Only once something has been cleared: that's what compacting removes.
  canCompact: boolean;
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
          <Typography variant="caption" color="text.secondary">
            Compacting permanently deletes the messages you cleared, which the model no longer sees.
          </Typography>
          {/* One line per label: the popover is too narrow for both with icons otherwise. */}
          <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", "& .MuiButton-root": { whiteSpace: "nowrap" } }}>
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
            <Button
              size="small"
              variant="outlined"
              startIcon={<CompressOutlinedIcon />}
              disabled={disabled || !canCompact}
              onClick={() => {
                onCompact();
                setAnchor(null);
              }}
            >
              Compact session
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
