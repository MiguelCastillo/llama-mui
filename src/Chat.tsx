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
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import LayersClearOutlinedIcon from "@mui/icons-material/LayersClearOutlined";
import CompressOutlinedIcon from "@mui/icons-material/CompressOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import StickyNote2OutlinedIcon from "@mui/icons-material/StickyNote2Outlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
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
  type PastPlan,
  type PlanStep,
  type PlanThread,
  type Todo,
  setCheckCommand,
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
  loadModel,
  unloadModel,
  pickAttachments,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  runTool,
  saveSession,
  noteRevision,
  ApiError,
} from "./api";
import { removeRow, upsertRow, watchSessionList } from "./sessionRows";
import { pickModel } from "./modelChoice";
import SessionSettings, { ATTACHMENTS_LOCKED_NOTE, AttachmentIcon } from "./SessionSettings";
import SessionsPanel from "./SessionsPanel";
import EmptyChatCreature from "./EmptyChatCreature";
import EmptyChatSuggestions from "./EmptyChatSuggestions";
import { settleStart, startAction, type Start, type StartAction } from "./todos";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import MarkdownRenderer from "./MarkdownRenderer";
import { commandSummary, INTERRUPTED, failureLine, shownFailure } from "./agent/helpers";
import {
  PlanView,
  checkRoom,
  commandFailedPrompt,
  disputeHolds,
  disputeNote,
  disputePrompt,
  reviewStep,
} from "./Plan";
import {
  filesChanged,
  planFromCall,
  stepPrompt,
  weighDispute,
} from "./agent/plan";
import { applyThreadEvent, noteView, threadStatus, type ThreadStatus } from "./planThread";
import {
  allViews,
  dismiss,
  getView,
  isLive,
  needsYou,
  sendChat,
  sendMessage as sendToRun,
  startRun as startRemoteRun,
  stop as stopRunner,
  subscribe,
  subscribeAll,
  type RunOptions,
  type RunnerView,
} from "./runClient";
import ThreadNote from "./ThreadNote";
import { withSessionDefaults } from "./sessionDefaults";
import { descendantIds, nestedHeldBy, nestedSessionFrom } from "./sessionTree";

// Per-browser choices kept in localStorage: whether the toolbar is expanded,
// and whether the Tools switch is on. Storage can be unavailable (private
// windows), so failures fall back to the default.
const TOOLBAR_KEY = "llama-mui:toolbarOpen";
// Off until the user turns it on: tools can read files, change them and run
// commands, so they're something to opt into.
const TOOLS_KEY = "llama-mui:toolsOn";
// On by default: with tools on, a task gets a plan that chat runs and checks.
const PLAN_KEY = "llama-mui:planOn";
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

// The model menu's "Manage models" item: its value opens Settings → Models
// instead of picking a model.
const MANAGE_MODELS = "__manage_models__";

// What happened to a failed reply, in the user's terms. Our server answers 502
// when it can't reach the llama server; a TypeError means the request never
// got an answer at all.
export default function Chat({ visible, onOpenSettings }: { visible: boolean; onOpenSettings: () => void }) {
  // undefined until the first load, null when no server is configured.
  const [connector, setConnector] = useState<Connector | null | undefined>(undefined);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The model's name for this session, carried by saves in case it came before
  // the first one. The user's name is only ever written by a rename (PATCH),
  // so renaming doesn't save the session and move it to the top.
  const [modelName, setModelName] = useState<string | null>(null);
  // Per-model options from Settings → Models, plus the server's defaults for
  // models nobody changed.
  const [modelSettings, setModelSettings] = useState<{
    defaults: ModelSettings;
    models: Record<string, ModelSettings>;
  } | null>(null);
  const [toolsWanted, setToolsWantedState] = useState(() => loadFlag(TOOLS_KEY, true));
  const setToolsWanted = (on: boolean) => {
    setToolsWantedState(on);
    saveFlag(TOOLS_KEY, on);
  };
  const [planWanted, setPlanWantedState] = useState(() => loadFlag(PLAN_KEY, true));
  const setPlanWanted = (on: boolean) => {
    setPlanWantedState(on);
    saveFlag(PLAN_KEY, on);
  };
  // Extra files and folders this chat's disk tools may read, besides the
  // working directory; New chat clears them.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // The working directory: where relative paths and commands start. Chosen in
  // Session settings, not one of the attachments; New chat clears it.
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const attachedPaths = (as: Attachment[]) => as.map((a) => a.path);
  // The working directory the system prompt names. Fixed by the session's
  // first message: after that a change goes in a chat update, so the system
  // prompt stays the same. Until then (undefined) it follows workingDir.
  const [fixedPromptDir, setFixedPromptDir] = useState<string | null | undefined>(undefined);
  const promptDir = fixedPromptDir === undefined ? workingDir : fixedPromptDir;
  // What to offer the model given those attachments and Settings → Tools.
  const [toolContext, setToolContext] = useState<ToolContext>({
    definitions: [],
    systemPrompt: null,
    offered: [],
    update: "",
    checkCommands: {},
  });
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
  // Context the model wrote alongside the plan (requirements, notes); saved
  // with the session, cleared when the plan is cancelled, moved into pastPlans
  // when a plan is archived, and kept when a plan is cloned.
  const [planContext, setPlanContext] = useState<string | null>(null);
  // The plan's one-sentence summary (update_plan's top-level summary); it
  // goes where planContext goes: saved, archived with the plan, cloned.
  const [planSummary, setPlanSummary] = useState<string | null>(null);
  // The plan's id, set when it moved into this thread (see Session.planId).
  // Chat only keeps it, so a save doesn't lose it; the agent archives it with
  // the plan.
  const [planId, setPlanId] = useState<string | null>(null);
  // Things to come back to (add_todo; see src/agent/todos.ts), saved with the
  // session. The ref is the latest, for tool calls within one reply.
  const [todos, setTodos] = useState<Todo[]>([]);
  const todosRef = useRef<Todo[]>([]);
  const changeTodos = (next: Todo[]) => {
    todosRef.current = next;
    setTodos(next);
  };
  // Where each plan shows: after the turn whose update_plan call wrote it, so
  // it stays in place in the history (see Session). A finished plan stays
  // there when a new one is written; the new one shows after its own turn.
  const [planAnchor, setPlanAnchor] = useState<string | null>(null);
  const [pastPlans, setPastPlans] = useState<PastPlan[]>([]);
  // A finished plan never runs again; Clone starts a new one with its steps,
  // all pending, at the end of the chat. Not while another plan is unfinished,
  // which the clone would replace (see canClone).
  const clonePlan = (steps: PlanStep[], context?: string | null, summary?: string | null) => {
    if (plan) setPastPlans((p) => [...p, { steps: plan, anchor: planAnchor, context: planContext, summary: planSummary, ...(planId ? { planId } : {}) }]);
    setPlanId(null);
    setPlanAnchor(`at:${messages.length}`);
    changePlan(
      steps.map((st) => ({
        id: crypto.randomUUID(),
        text: st.text,
        ...(st.summary ? { summary: st.summary } : {}),
        status: "pending" as const,
      })),
    );
    setPlanContext(context ?? null);
    setPlanSummary(summary ?? null);
    toBottom();
  };
  // A change the model suggested to a plan that's under way; see makeReply in src/runnerReply.ts.
  const [planProposal, setPlanProposal] = useState<PlanStep[] | null>(null);
  const answerProposal = (accept: boolean) => {
    // Matched again by text: the user may have changed the plan since. A step
    // kept from an older plan, with no summary, takes the proposal's. The plan's
    // own summary stays: a proposal changes steps, not what the plan is for.
    const old = planRef.current ?? [];
    const keep = (p: PlanStep) => {
      const o = old.find((x) => x.text === p.text);
      return o ? (o.summary || !p.summary ? o : { ...o, summary: p.summary }) : p;
    };
    if (accept && planProposal) changePlan(planProposal.map(keep));
    setPlanProposal(null);
  };
  // Plans and chat replies run on the server, not here (see src/runClient.ts):
  // every session has one owner. `runnerView` is what this open session's run
  // last reported (null when it has none). A run is a plan's, or one reply's
  // (`turnRunning`: a message was sent and the server is streaming the answer).
  // It is running until the run ends.
  const [runnerView, setRunnerView] = useState<RunnerView | null>(null);
  const runActive = !!runnerView && runnerView.status !== "stopped";
  const turnRunning = runActive && runnerView?.kind === "turn";
  const planRunning = runActive && !turnRunning;
  // The last runner error put in `error` (see mirrorView).
  const mirroredError = useRef<string | null>(null);
  // What the run of the open session is waiting on the user for, if
  // anything: a path the model asked for that isn't attached, or a change to
  // approve. It shows here, and the answer is a command to the server.
  const runnerAsk = runnerView?.ask ?? null;
  // Whether the open session has a run that hasn't ended, read from the
  // client, so a guard in a handler sees a run that started a moment ago.
  const runnerActive = (id: string) => {
    const v = getView(id);
    return !!v && v.status !== "stopped";
  };
  // When the current task started, for the counter beside the waiting dots
  // (and on the plan card while a plan runs): the run's own start while one
  // runs, so a plan's steps and checks count as one task.
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the chat follows new output: while you're at the bottom. Scrolling
  // up stops it, so you can read back while a reply streams (it used to pull
  // you down on every token); scrolling back down, the arrow, or sending
  // starts it again. Only a ref: it is read by the scroll effect, which runs
  // per token, and nothing on screen depends on it.
  const followingRef = useRef(true);
  const setFollowing = (on: boolean) => {
    followingRef.current = on;
  };
  // Whether there is more below what is in view, which is all the arrow means.
  // It is read from the box itself, never from what the chat was doing (see
  // measure), so it shows as soon as there is something below, not only after
  // scrolling up from the bottom, and it can't go stale.
  const [moreBelow, setMoreBelow] = useState(false);
  const lastScrollTop = useRef(0);
  const fromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
  // Called on every scroll and every change in the size of the box or what is
  // in it, which is every way the answer can change.
  const measure = () => {
    const el = scrollRef.current;
    if (el) setMoreBelow(fromBottom(el) > 80);
  };
  // Only a scroll up stops following. Output landing and the trackpad's bounce
  // at the end change the distance from the bottom too, and judging by that
  // alone flipped following off and on while you scrolled down.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
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
  // The content's size changing (a step folded, a message arriving) moves what
  // is below the view without any scroll event, so it is measured the same way
  // a scroll is. A chat that now fits follows new output again.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scrollRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const recheck = () => {
      measure();
      if (!followingRef.current && fromBottom(box) < 80) setFollowing(true);
    };
    const observer = new ResizeObserver(recheck);
    observer.observe(content);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // The saved chat this is, and the list for the chats panel. Nothing is
  // saved until the open session has loaded, so an empty screen can't
  // overwrite it.
  const [sessionId, setSessionId] = useState(loadSessionId);
  // A suggestion clicked on the empty screen, for the message box to take.
  const [fill, setFill] = useState<{ text: string; n: number } | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Whether the last loadSession read its session (false: it opened as a new chat).
  const loadedOk = useRef(false);
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
  // Not the title: it comes from the names and the first message, and a saved
  // one holds the user's name, which saves never send.
  const keyOf = (s: Session) => JSON.stringify([s.model, s.messages, s.contextStart, s.attachments, s.workingDir ?? null, s.usage, s.failed, s.plan, s.planProposal, s.planContext, s.planSummary ?? null, s.planId ?? null, s.planAnchor, s.pastPlans, s.promptDir, s.modelName, s.todos, s.parentId ?? null, s.threads ?? [], s.titleHint ?? null, s.planMovedIn ?? false]);

  // The session this one is nested under (its direct parent), if any.
  const [parentId, setParentId] = useState<string | null>(null);
  // Plans that moved out to their own sessions (see src/planThread.ts), the
  // name this session has until the model names it, and whether the plan was
  // moved in here from the parent and has not run yet.
  const [threads, setThreads] = useState<PlanThread[]>([]);
  const [titleHint, setTitleHint] = useState<string | null>(null);
  const [planMovedIn, setPlanMovedIn] = useState(false);

  // `live`: the session is a run's, as it is now (see mirrorView). A step that
  // is running there really is, so it isn't reset to pending, and the model
  // picker is left alone. `running`: that run has not ended, so the
  // "interrupted" mark it keeps while a request is in flight is not shown as
  // a failure (see shownFailure).
  const applySession = (s: Session, live = false, running = live) => {
    // Saved before plans had a place: pinned after the chat's last message as
    // it opens, where they showed, so later messages go below them. Counted
    // as saved, so opening the chat doesn't save it (see savedKey).
    // Shared or older sessions may lack fields; each gets a default.
    s = withSessionDefaults(s);
    const end = `at:${s.messages.length}`;
    const planAnchor = s.plan ? (s.planAnchor ?? end) : null;
    const pastPlans = (s.pastPlans ?? []).map((p) => ({ ...p, anchor: p.anchor ?? end }));
    savedKey.current = keyOf({ ...s, planAnchor, pastPlans });
    setMessages(s.messages);
    setContextStart(s.contextStart);
    setAttachments(s.attachments);
    setWorkingDir(s.workingDir ?? null);
    setFixedPromptDir(s.promptDir);
    setUsage(s.usage);
    setFailed(shownFailure(s.failed, running));
    setModelName(s.modelName ?? null);
    // A step that was running when the page went away didn't finish.
    changePlan(
      s.plan?.map((st) => ({
        ...st,
        id: st.id ?? crypto.randomUUID(),
        status: st.status === "running" && !live ? "pending" : st.status,
      })) ?? null,
    );
    setPlanProposal(s.planProposal ?? null);
    setPlanContext(s.planContext ?? null);
    setPlanSummary(s.planSummary ?? null);
    setPlanId(s.planId ?? null);
    setPlanAnchor(planAnchor);
    setPastPlans(pastPlans);
    changeTodos(s.todos ?? []);
    setParentId(s.parentId ?? null);
    setThreads(s.threads ?? []);
    setTitleHint(s.titleHint ?? null);
    setPlanMovedIn(s.planMovedIn ?? false);
    if (s.model && !live) setModel(s.model);
  };

  // Set below, once refreshModels exists; the latest one, for the listener.
  const refreshModelsAfterTurn = useRef<() => void>(() => {});

  // Shows the server's view of the open session's run: its live session goes
  // into the state the way a loaded one does (applySession), and the view
  // itself is kept for the status. A view without its session yet (the run
  // has just started) only sets the status. A run that has ended hands the
  // session back: Chat takes its final state (counted as saved, since the
  // server saved it, and its revision is the one the next save sends) and the
  // open session is Chat's again.
  const mirrorView = (v: RunnerView) => {
    if (v.session) applySession(v.session, true, v.status !== "stopped");
    // The run's error shows as Chat's own, but only when it changes, so
    // an error of Chat's (a server that can't be reached) isn't wiped by
    // every streamed piece.
    if (v.error !== mirroredError.current) {
      mirroredError.current = v.error;
      setError(v.error);
    }
    if (v.status !== "stopped") {
      setRunnerView(v);
      return;
    }
    setRunnerView(null);
    dismiss(v.sessionId);
    // After a reply the model list is read again (a model may have been loaded
    // or unloaded meanwhile), as the page did itself when it ran the reply.
    if (v.kind === "turn") refreshModelsAfterTurn.current();
  };
  // The id of the session on screen, for the listener below: a view of any
  // other session is not shown.
  const openId = useRef(sessionId);
  openId.current = sessionId;
  // Follows the open session's run for as long as the session is open.
  useEffect(() => {
    const unsubscribe = subscribe(sessionId, (v) => {
      if (openId.current === v.sessionId) mirrorView(v);
    });
    return unsubscribe;
  }, [sessionId]);

  // A session that was never saved (or was deleted) opens as a new chat. One
  // with a run opens as the run has it, which is newer than the saved one: the
  // saved copy is shown first, and the run's own session replaces it as soon as
  // the server's event stream has sent it (see mirrorView).
  const loadSession = (id: string) => {
    setLoaded(false);
    loadedOk.current = false;
    dismiss(id);
    getSession(id)
      .then((s) => {
        applySession(s, !!s.run);
        loadedOk.current = true;
        // The run's view may have come while the session was read.
        const view = getView(id);
        if (view && view.status !== "stopped" && openId.current === id) mirrorView(view);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  };

  // The list follows the server: a session saved, renamed or deleted from
  // another window, or by a run, changes its row here without a reload. After
  // a dropped connection the list is read again, since events were missed.
  useEffect(
    () =>
      watchSessionList({
        saved: (row) => setSessions((ss) => upsertRow(ss, row)),
        removed: (id) => setSessions((ss) => removeRow(ss, id)),
        // A thread's run ended: the note for it in the open session changes.
        // The server wrote that session (its revision went up by one), so the
        // next save carries the new one instead of being refused.
        thread: (e) => {
          if (e.id !== openId.current) return;
          noteRevision(e.id, e.revision);
          setThreads((ts) => applyThreadEvent(ts, e));
        },
        reconnected: () => void listSessions().then(setSessions).catch(() => {}),
      }),
    [],
  );

  // The sessions whose run needs the user (an ask pending, or ended with a
  // question waiting), for the dot in the sessions panel. Read again on every
  // status, ask and dismissed event, never per streamed piece; the set is only
  // replaced when it changed.
  // The sessions with a run in progress are read the same way: their delete
  // buttons, and those of the sessions in their family, are off (see
  // deleteLockedIds).
  const idsWhere = (pred: (v: RunnerView) => boolean) => new Set(allViews().filter(pred).map((v) => v.sessionId));
  const [attention, setAttention] = useState<ReadonlySet<string>>(() => idsWhere(needsYou));
  const [inProgress, setInProgress] = useState<ReadonlySet<string>>(() => idsWhere(isLive));
  useEffect(() => {
    const keepIfSame = (prev: ReadonlySet<string>, next: Set<string>) =>
      next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    const refresh = () => {
      setAttention((prev) => keepIfSame(prev, idsWhere(needsYou)));
      setInProgress((prev) => keepIfSame(prev, idsWhere(isLive)));
    };
    refresh();
    return subscribeAll(refresh);
  }, []);

  useEffect(() => {
    saveSessionId(sessionId);
    loadSession(sessionId);
    listSessions()
      .then(setSessions)
      .catch((e) => setError(e.message));
  }, []);

  // The session as it is now, built from the current state.
  const snapshot = (): Session => {
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "New session";
    // The server puts the user's name, when there is one, ahead of this.
    return {
      id: sessionId,
      title: modelName ?? titleHint ?? firstUser.slice(0, 80),
      model,
      messages,
      contextStart,
      attachments,
      workingDir,
      usage,
      failed,
      plan,
      planProposal,
      planContext,
      planSummary,
      planId,
      planAnchor,
      pastPlans,
      promptDir: fixedPromptDir,
      modelName,
      todos,
      parentId,
      threads,
      titleHint,
      planMovedIn,
    };
  };

  // The server refused a save because the session is no longer what this page
  // loaded (another window saved it, or a plan or reply is running in it). The
  // server's copy is the one to show, so it is read again; what was changed
  // here since the last save is dropped, and the message says so.
  const reloadFromServer = (message: string) => {
    savedKey.current = "";
    setError(message);
    loadSession(sessionId);
  };
  // The answer arrives after this render is over, so it calls the latest one.
  const reloadRef = useRef(reloadFromServer);
  reloadRef.current = reloadFromServer;
  const conflictMessage = (e: unknown) =>
    e instanceof ApiError && e.data.reason === "run active"
      ? "A plan is running in this session, so it is shown as it runs. Changes made here since the last save were not kept."
      : "This session was changed in another window, so it was loaded again. Changes made here since the last save were not kept.";

  // The session a Run is being sent for: its save and the command go one after
  // the other, so no other save of it goes in between.
  const starting = useRef<string | null>(null);
  const saveNow = () => {
    // A session with a run is saved by the run, which holds the newer copy; the
    // server would refuse this page's save anyway. Nothing is saved either
    // while Run is being sent (see startRun).
    if (!loaded || messages.length === 0 || runnerActive(sessionId) || starting.current === sessionId) return;
    const session = snapshot();
    const key = keyOf(session);
    if (key === savedKey.current) return;
    savedKey.current = key;
    const savedId = sessionId;
    saveSession(session)
      .then((summary) => setSessions((ss) => upsertRow(ss, summary)))
      .catch((e) => {
        // A refusal about a session that has since been closed is not this screen's to show.
        if (e instanceof ApiError && e.status === 409 && openId.current === savedId) reloadRef.current(conflictMessage(e));
        else setError(e.message);
      });
  };

  // Saves a moment after the chat stops changing, so a streaming reply is
  // saved when it pauses rather than on every token.
  useEffect(() => {
    const timer = setTimeout(saveNow, 800);
    return () => clearTimeout(timer);
  // modelName too: the model often names a session before its first save, when
  // the rename (PATCH) has no file to change yet, so the next save carries it.
  }, [loaded, messages, contextStart, attachments, workingDir, usage, model, failed, plan, planProposal, planContext, planSummary, planId, planAnchor, pastPlans, fixedPromptDir, modelName, todos, parentId, threads, titleHint, planMovedIn]);

  // Set by openSession: once that session has loaded, the chat box scrolls to
  // its plan card instead of the end.
  const scrollToPlan = useRef<{ sessionId: string; planId: string } | null>(null);
  useEffect(() => {
    const want = scrollToPlan.current;
    if (!want || !loaded || want.sessionId !== sessionId) return;
    scrollToPlan.current = null;
    const box = scrollRef.current;
    if (!box) return;
    // The plan with that id, else the session's plan, else the last card.
    const cards = [...box.querySelectorAll<HTMLElement>("[data-plan-card]")];
    const card = cards.find((c) => want.planId && c.dataset.planId === want.planId) ?? cards.find((c) => c.dataset.current) ?? cards[cards.length - 1];
    if (!card) return;
    // Moves only the chat box, like stickToBottom.
    box.scrollTop += card.getBoundingClientRect().top - box.getBoundingClientRect().top - 72;
    lastScrollTop.current = box.scrollTop;
  }, [loaded, sessionId]);

  // Switches to another chat, saving this one first unless it was deleted.
  // Nothing blocks it: a plan or a reply keeps running on the server while
  // another session is open.
  // `toPlan`: show the plan card when it is open, not the end of the chat: "" for
  // the session's plan, or a planId to find its card (a thread's note
  // has one). The cards are marked with data-plan-card where they are drawn.
  const openSession = (id: string, saveFirst = true, toPlan: string | null = null) => {
    if (saveFirst) saveNow();
    scrollToPlan.current = toPlan === null ? null : { sessionId: id, planId: toPlan };
    setFollowing(toPlan === null);
    setSessionId(id);
    openId.current = id;
    saveSessionId(id);
    savedKey.current = "";
    setRunnerView(null);
    mirroredError.current = null;
    setMessages([]);
    setUsage(null);
    setContextStart(0);
    setAttachments([]);
    setWorkingDir(null);
    setFixedPromptDir(undefined);
    setFailed(null);
    setModelName(null);
    changePlan(null);
    setPlanProposal(null);
    setPlanContext(null);
    setPlanSummary(null);
    setPlanId(null);
    setPlanAnchor(null);
    setPastPlans([]);
    changeTodos([]);
    setParentId(null);
    setThreads([]);
    setTitleHint(null);
    setPlanMovedIn(false);
    setDrawerOpen(false);
    loadSession(id);
  };
  // An empty session under `parentId`, with the same working directory, attachments and model
  // but none of its messages. It is saved right away (saveNow skips empty
  // sessions) so it shows in the list under its parent, then opened.
  const newNested = async (parentId: string) => {
    try {
      const parent =
        parentId === sessionId
          ? { id: sessionId, model, attachments, workingDir }
          : withSessionDefaults(await getSession(parentId));
      const child = nestedSessionFrom(parent, crypto.randomUUID());
      const summary = await saveSession(child);
      setSessions((ss) => [summary, ...ss.filter((x) => x.id !== summary.id)]);
      openSession(child.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // A new session starts on the connector's default model (see pickModel),
  // not on whatever this tab last used; opening a saved one keeps its own.
  const newChat = () => {
    openSession(crypto.randomUUID());
    const start = pickModel({ current: "", defaultModel: connector?.defaultModel, models });
    if (start) setModel(start);
  };
  // Discarding a plan (the card offers it only while nothing runs) asks first,
  // and removes the plan. If a run started meanwhile, it is stopped first. The steps' messages stay in the chat, and
  // what they changed stays changed. A run owns its session, so the page waits
  // until the run is over, takes the session as the run left it, and only then
  // removes the plan; that is saved like any other change.
  const [confirmCancelPlan, setConfirmCancelPlan] = useState(false);
  const clearPlan = () => {
    changePlan(null);
    setPlanProposal(null);
    setPlanContext(null);
    setPlanSummary(null);
    setPlanId(null);
    setPlanAnchor(null);
  };
  const cancelPlanConfirmed = async () => {
    setConfirmCancelPlan(false);
    if (runnerActive(sessionId)) {
      const id = sessionId;
      try {
        await stopRunner(id);
        // The run is over. The final session has been mirrored (see mirrorView)
        // unless the connection was lost; read it again in any case, which also
        // brings the revision up to date for the save that follows.
        const final = await getSession(id);
        if (openId.current !== id) return;
        applySession(final, true);
        setRunnerView(null);
      } catch (e) {
        if (openId.current === id) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      clearPlan();
      return;
    }
    clearPlan();
  };
  // Deleting asks first, in a Dialog: window.confirm is answered "no" at once,
  // without being shown, in some browsers (the Claude app's browser pane).
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const removeSession = (id: string) => setConfirmDelete(id);
  // Deleting cascades: the session goes with every session nested under it, at
  // any depth, and the Dialog says how many.
  const heldNested = confirmDelete ? nestedHeldBy(sessions, confirmDelete) : 0;
  // The user's name for a session is userName; an empty one clears it, and the
  // title falls back to the model's name, then the first message.
  const renameSessionLocal = (id: string, name: string) => {
    const s = sessions.find((x) => x.id === id);
    const userNameVal = name || null;
    const title = userNameVal ?? s?.modelName ?? s?.title ?? "New session";
    renameSession(id, { title, userName: userNameVal })
      .then((summary) => {
        setSessions((ss) => ss.map((x) => (x.id === id ? { ...x, ...summary, userName: userNameVal } : x)));
      })
      .catch((e) => setError(e.message));
  };
  const deleteConfirmed = () => {
    const id = confirmDelete;
    setConfirmDelete(null);
    if (!id) return;
    // A run in this session, or in any session nested under it, ends first (the
    // server won't delete a family while one runs); stopping answers once it is over.
    const family = [id, ...descendantIds(sessions, id)];
    Promise.all(family.filter((s) => runnerActive(s)).map((s) => stopRunner(s).catch(() => {})))
      .then(() => deleteSession(id))
      .then((r) => {
        const gone = new Set([id, ...(r.deleted ?? [])]);
        setSessions((ss) => ss.filter((x) => !gone.has(x.id)));
        // The open session is one of them: start a new one.
        if (gone.has(sessionId)) openSession(crypto.randomUUID(), false);
      })
      .catch((e) => setError(e.message));
  };

  // A llama server in router mode loads a model on demand when a request names
  // it: opening an old chat and sending once loaded the 27B next to the 9B, and
  // both slowed to 5 tok/s. So nothing is sent to a model that isn't loaded;
  // loading is an explicit action, in the model menu or on the Models page.
  // `notLoaded` is the model the note under the chat is about.
  const [notLoaded, setNotLoaded] = useState<string | null>(null);
  // Asks the server, fresh, whether the model is loaded. A server that doesn't
  // report status (no router mode) has nothing to load, and one that can't be
  // asked is left to fail the request with its own error.
  const modelLoaded = async (): Promise<boolean> => {
    if (!connector || !model) return false;
    let status: string | undefined;
    try {
      const ms = await listModels(connector.id);
      setModels(ms);
      status = ms.find((m) => m.id === model)?.status;
    } catch {
      return true;
    }
    if (!status || status === "unknown" || status === "loaded") return true;
    setNotLoaded(model);
    return false;
  };
  // The model menu's load and unload, like the Models page's (deleting is only
  // there). `modelBusy` is the model being loaded or unloaded, for its spinner.
  const [modelBusy, setModelBusy] = useState<string | null>(null);
  // The server loads and unloads in the background, so this asks again each
  // second until the status is the one asked for (a big model takes a while).
  const setModelLoaded = async (id: string, load: boolean) => {
    if (!connector) return;
    setModelBusy(id);
    const want = load ? "loaded" : "unloaded";
    try {
      await (load ? loadModel : unloadModel)(connector.id, id);
      for (let i = 0; i < 120; i++) {
        const ms = await listModels(connector.id);
        setModels(ms);
        if (ms.find((m) => m.id === id)?.status === want) {
          if (load && id === notLoaded) setNotLoaded(null);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      setError(`${id} still wasn't ${want} after two minutes; check the Models page.`);
    } catch (e: any) {
      setError(`Couldn't ${load ? "load" : "unload"} ${id}: ${e.message}`);
    } finally {
      setModelBusy(null);
    }
  };
  // Picking another model answers the note.
  useEffect(() => setNotLoaded(null), [model]);

  // The active connector's default model, for refreshModels.
  const defaultModelRef = useRef<string | undefined>(undefined);
  const refreshModels = (connectorId: string) =>
    listModels(connectorId)
      .then((ms) => {
        setModels(ms);
        // See pickModel for the order.
        setModel((cur) => pickModel({ current: cur, defaultModel: defaultModelRef.current, models: ms }));
      })
      .catch((e) => {
        // Don't offer models from a server we can't reach.
        setModels([]);
        setError(e.message);
      });

  refreshModelsAfterTurn.current = () => {
    if (connector) refreshModels(connector.id);
  };

  // Reload everything each time chat shows: Settings may have changed the
  // server, its key or the folders, and a server that was down may be back.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    getConnectors()
      .then((l) => {
        const active = l.connectors.find((c) => c.id === l.activeId) ?? null;
        setConnector(active);
        defaultModelRef.current = active?.defaultModel;
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

  // Bumped to fetch the tool context again, after a check command changes.
  const [contextVersion, setContextVersion] = useState(0);
  // Settings → Tools or the attachments may have changed what's available.
  useEffect(() => {
    if (!visible) return;
    getToolContext(workingDir, attachedPaths(attachments), promptDir)
      .then(setToolContext)
      .catch((e) => setError(e.message));
  }, [visible, attachments, workingDir, promptDir, contextVersion]);

  // On only when the user wants tools and some are ready in this chat.
  const toolsOn = toolsWanted && toolContext.offered.length > 0;
  useEffect(() => {
    setBusySince((since) => (runActive ? (since ?? Date.now()) : null));
  }, [runActive]);
  // The counter's start: the run's own (it may have started in another
  // session's view, or before this one was opened).
  const taskSince = runActive && runnerView ? runnerView.startedAt : busySince;

  const canPlan = toolsOn && toolContext.offered.includes("update_plan");
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
  const toolCount = toolContext.offered.length;

  // A prompt from a plan step shows in the plan card, under the step (see
  // PlanView); others show at the bottom of the chat.
  // The prompt on screen: the open session's run's ask (a plan or a reply runs
  // there). A run of another session has no prompt here; it waits (see
  // server/runners.ts).
  const shownPending = runnerAsk;
  const promptInPlan = !!shownPending && planRunning && !!plan;
  // Not smooth: an animation per token never caught up, and fought the user.
  // A prompt in the plan card scrolls itself into view instead.
  useEffect(() => {
    if (followingRef.current && !promptInPlan) stickToBottom();
  }, [messages, shownPending]);

  // Changes the open session's attachments or working directory. The folders
  // a run works in are fixed when it starts and the server owns the session
  // until it ends, so they can't change meanwhile (Session settings says so, too).
  const attachmentsLocked = runActive;
  const changeAttachments = (fn: (as: Attachment[]) => Attachment[]) => {
    if (runnerActive(sessionId)) setError(ATTACHMENTS_LOCKED_NOTE);
    else setAttachments(fn);
  };
  // Replaces the working directory (null clears it). The old one is not kept
  // as an attachment.
  const changeWorkingDir = (dir: string | null) => {
    if (runnerActive(sessionId)) setError(ATTACHMENTS_LOCKED_NOTE);
    else setWorkingDir(dir);
  };
  const attach = (a: Attachment) => changeAttachments((as) => (as.some((x) => x.path === a.path) ? as : [...as, a]));

  // Sends what the user typed. Returns whether it went, so the message box
  // clears only then: it waits there while the session is saved and the server
  // is told.
  const send = async (text: string) => {
    // While a plan runs, a message goes to the run: the server folds it in
    // before the next step and says which one (see the notes under the chat),
    // or refuses, and then the text stays in the box.
    if (planRunning) {
      try {
        await sendToRun(sessionId, text);
        // A refusal shown earlier is out of date now; the run's own error stays.
        if (error !== mirroredError.current) setError(null);
        toBottom();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    // A reply is streaming: another message waits for its end (the server
    // refuses it too, see sendNote).
    if (turnRunning) {
      setError("A reply is still streaming. Wait for it to finish, or stop it, then send your message.");
      return false;
    }
    // The one before this is still being saved and sent.
    if (!model || !connector || starting.current) return false;
    if (!(await modelLoaded())) return false;
    toBottom();
    return chatTurn(text, messages, planOn);
  };

  // What the server needs from here to run a plan or a reply: which connector
  // and model, and whether tools and Think are on. The server looks up the
  // connector (and its key, which the page never has), the models and the tools
  // itself, and runs what is saved, so a session never carries anything secret.
  const runOptions = (): RunOptions | null =>
    connector && model
      ? { connectorId: connector.id, model, toolsOn, thinkOn, freshSteps: prefs?.freshPlanSteps }
      : null;

  // Sends one message as a chat turn, which the server runs (see
  // server/runners.ts, startTurn): this session is saved first, with only the
  // messages before this one (Resend has cut the failed reply off), then the
  // server is told. It streams the reply as events, which show here the way a
  // plan's do (mirrorView): the messages, the usage, the session's name, any
  // question for the user, an error. `planning`: the reply only writes a plan
  // (see PLANNING_NOTE). Returns whether it went; a refusal shows as the error,
  // in the server's own words, and the text stays where it was typed.
  const chatTurn = async (text: string, before: ChatMessage[], planning: boolean): Promise<boolean> => {
    const options = runOptions();
    if (!options) return false;
    const id = sessionId;
    const toSend = { ...snapshot(), messages: before };
    const key = keyOf(toSend);
    // A first message saves the session just so the server has it to read; if
    // the message doesn't go, that empty session is removed again.
    const listed = sessions.some((x) => x.id === id);
    starting.current = id;
    try {
      savedKey.current = key;
      const summary = await saveSession(toSend);
      setSessions((ss) => upsertRow(ss, summary));
      await sendChat(id, text, { ...options, planning });
      // Until the server's copy of the session arrives (mirrorView), show the
      // message as sent, and a failure of the reply that came before it as gone.
      if (openId.current === id && !getView(id)?.session) {
        setMessages([...before, { role: "user", content: text }]);
        setFailed(null);
      }
      return true;
    } catch (e) {
      // Not saved after all, or not started: the next save must try again.
      if (savedKey.current === key) savedKey.current = "";
      if (!listed && before.length === 0) {
        deleteSession(id)
          .then(() => setSessions((ss) => ss.filter((x) => x.id !== id)))
          .catch(() => {});
      }
      runRefused(e);
      return false;
    } finally {
      starting.current = null;
    }
  };
  // Saves `session`, then asks the server to run its plan: from the first step
  // that's pending, in order, one turn each, checking every step before ticking
  // it off (see runPlan in src/agent/agent.ts). From then on the server owns the
  // session; Chat shows what it reports (mirrorView). The plan and todos come
  // from their refs: a change made a moment ago (an answer to a waiting step,
  // see PlanView) is in the refs before the state has caught up with it.
  // Throws what the server refuses with, in its own plain words. Answers with
  // the session the plan runs in: this one, or the new thread the server moved
  // a plan that hadn't started into (it decides, see server/runStart.ts). It is
  // saved as it is, `planMovedIn` included, since that is how the server tells
  // a plan that was moved in here from one that still has to move.
  const startRun = async (): Promise<string | undefined> => {
    const options = runOptions();
    if (!options) return;
    const id = sessionId;
    const toRun = { ...snapshot(), plan: planRef.current };
    const key = keyOf(toRun);
    starting.current = id;
    try {
      savedKey.current = key;
      const summary = await saveSession(toRun);
      setSessions((ss) => upsertRow(ss, summary));
      return await startRemoteRun(id, options);
    } catch (e) {
      // Not saved after all: the next save must try again.
      if (savedKey.current === key) savedKey.current = "";
      throw e;
    } finally {
      starting.current = null;
    }
  };
  // A command the server couldn't do shows as the error, in its own words.
  const showFailure = (command: Promise<unknown>) =>
    void command.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  // Says why a refused Run or a refused save didn't happen. A save refused
  // because the session changed (or runs) elsewhere shows the server's copy.
  const runRefused = (e: unknown) => {
    if (e instanceof ApiError && (e.data.reason === "run active" || e.data.reason === "stale revision")) reloadRef.current(conflictMessage(e));
    else setError(e instanceof Error ? e.message : String(e));
  };

  // The plan card's Run. This session is saved and the server is told to run
  // it. A plan that hasn't started moves into its own nested session (a
  // thread) on the server, which runs it there, and the thread is opened (as
  // the run has it, see loadSession); this session keeps a note where the plan
  // was. A plan that already started (Continue, Resume, Restart), or one that
  // was just moved in, runs where it is.
  const runFromCard = async () => {
    if (!connector || !model || runnerActive(sessionId)) return;
    try {
      if (!planMovedIn && !(await modelLoaded())) return;
      const ranIn = await startRun();
      // The server has saved this session and the thread: the rows follow its
      // events, and this session isn't saved again (it is left as it is).
      if (ranIn && ranIn !== sessionId) openSession(ranIn, false);
    } catch (e) {
      runRefused(e);
    }
  };

  // What this page has found out about each thread this session started: that
  // it has a run ("running": the note spins), or its saved state. A child with
  // a run is read from it; otherwise from the child's saved state once this
  // session has loaded; a child that can't be read counts as deleted. Until
  // then a note shows what it has itself (see noteView: the status and report
  // the server wrote when the run ended). An answer for a session that has
  // since been closed is ignored. Run events (a child starting or ending)
  // update it.
  const [threadStatuses, setThreadStatuses] = useState<Record<string, ThreadStatus | "running">>({});
  useEffect(() => {
    setThreadStatuses({});
    if (!loaded || !loadedOk.current) return;
    let current = true;
    const fromView = (id: string, v: RunnerView) =>
      setThreadStatuses((m) => {
        const { [id]: _old, ...rest } = m;
        if (v.status !== "stopped") return { ...rest, [id]: "running" };
        return v.session ? { ...rest, [id]: threadStatus(withSessionDefaults(v.session)) } : rest;
      });
    for (const t of threads) {
      const v = getView(t.sessionId);
      if (v) {
        fromView(t.sessionId, v);
        continue;
      }
      getSession(t.sessionId)
        // A child the server says is running spins; its end will bring the outcome.
        .then((c): ThreadStatus | "running" => (c.run ? "running" : threadStatus(withSessionDefaults(c))))
        .catch((): ThreadStatus => "missing")
        .then((status) => {
          // A run may have started for it while this was read.
          if (current && !getView(t.sessionId)) setThreadStatuses((m) => ({ ...m, [t.sessionId]: status }));
        });
    }
    const ids = new Set(threads.map((t) => t.sessionId));
    const unsubscribe = subscribeAll((e) => {
      if (current && e.view && ids.has(e.id)) fromView(e.id, e.view);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [loaded, sessionId]);

  // Retries the last user message, dropping the failed reply (Resend). The
  // session is saved with the messages before that message, then the server is
  // told to send it again (see chatTurn). Like a first try it isn't a planning
  // turn, as before.
  const retry = async () => {
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!userMsg || runActive || starting.current) return;
    if (!model || !connector || !(await modelLoaded())) return;
    const index = messages.indexOf(userMsg);
    toBottom();
    await chatTurn(userMsg.content, messages.slice(0, index), false);
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
      streaming={!!runnerView?.streaming && i === turns.length - 1}
      since={taskSince}
      rate={streamRate}
      toolResults={toolResults}
      forgotten={t.start < contextStart}
      showSteps={prefs?.showSteps ?? true}
      renderMarkdown={prefs?.renderMarkdown ?? true}
      failed={i === lastFailedTurnIndex ? failed : undefined}
      connectorName={connector ? connector.name || connector.kind : undefined}
      onResend={i === lastFailedTurnIndex ? retry : undefined}
      resendDisabled={i === lastFailedTurnIndex ? runActive : undefined}
    />
  );
  // Each update_plan call's turn, to show the plan it wrote after that turn.
  const callTurn = new Map(turns.flatMap((t) => t.parts.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, t.start] as const))));
  // Where a plan shows. A call's plan: after that call's turn. "at:N": before
  // the first turn shown from message N on, or after the last turn if none;
  // made after a clear (N at or past contextStart), it's below the divider.
  // Neither (its turn is gone, as when Resend replaced it): at the end.
  const shown = turns.filter((t) => !t.parts[0].planStep);
  const slot = (anchor: string | null) => {
    if (!anchor?.startsWith("at:")) {
      const after = anchor ? callTurn.get(anchor) : undefined;
      return after === undefined ? { lost: true } : { after };
    }
    const n = Number(anchor.slice(3));
    if (n > messages.length) return { lost: true };
    return { before: shown.find((t) => t.start >= n)?.start ?? "end", cleared: contextStart > 0 && n >= contextStart };
  };
  const cardsBefore = (start: number | "end", cleared: boolean) =>
    planCards.filter((c) => {
      const s = slot(c.anchor);
      return s.before === start && !!s.cleared === cleared;
    }).map((c) => c.card);
  const stepTurns = (id: string) => {
    const own = turns.flatMap((t, i) => (t.parts[0].planStep === id ? [bubble(t, i)] : []));
    return own.length ? own : null;
  };
  const canClone = (!plan || plan.every((st) => st.status === "done")) && !runActive;
  const planCards = [
    ...threads.map((t) => ({
      anchor: t.anchor,
      card: (
        <ThreadNote
          key={`thread-${t.sessionId}`}
          summary={t.summary}
          view={noteView(t, threadStatuses[t.sessionId])}
          onOpen={() => openSession(t.sessionId, true, t.planId ?? "")}
        />
      ),
    })),
    ...pastPlans.map((p, i) => ({
      anchor: p.anchor,
      card: (
        <Box key={`past-${i}`} data-plan-card data-plan-id={p.planId ?? ""}>
          <PlanView
            steps={p.steps}
            summary={p.summary}
            context={p.context}
            details={stepTurns}
            formatTime={formatSeconds}
            onClone={canClone ? () => clonePlan(p.steps, p.context, p.summary) : undefined}
          />
        </Box>
      ),
    })),
    ...(plan
      ? [
          {
            anchor: planAnchor,
            card: (
              <Box key="plan" data-plan-card data-current="true" data-plan-id={planId ?? ""}>
                <PlanView
                  steps={plan}
                  summary={planSummary}
                  context={planContext}
                  running={runActive}
                  since={planRunning ? taskSince : null}
                  onPause={planRunning ? () => showFailure(stopRunner(sessionId)) : undefined}
                  counter={(since) => <Elapsed since={since} rate={streamRate} variant="caption" color="text.secondary" />}
                  onRun={runFromCard}
                  onChange={changePlan}
                  proposal={planProposal}
                  onProposal={answerProposal}
                  details={stepTurns}
                  formatTime={formatSeconds}
                  onCancel={() => setConfirmCancelPlan(true)}
                  onClone={canClone ? () => clonePlan(plan, planContext, planSummary) : undefined}
                  prompt={
                    promptInPlan && shownPending ? (
                      <PendingPrompt ask={shownPending.ask} onDecide={shownPending.decide} />
                    ) : undefined
                  }
                />
              </Box>
            ),
          },
        ]
      : []),
  ];
  // A plan step's failure shows on the step, which offers Continue.
  const lastFailedTurnIndex = lastUserTurn >= 0 && !turns[lastUserTurn].parts[0].planStep ? lastUserTurn : -1;
  const hasContext = messages.length > contextStart;
  const showIndicator = hasContext && !!prefs?.showContextMeter;

  const clearContext = () => {
    setContextStart(messages.length);
    setUsage(null);
    // The model reprocesses its history from here anyway, so this is the cheap
    // moment to bring the system prompt up to date: it names the working
    // directory as it is now, and the next reply's update lists the attachments.
    setFixedPromptDir(undefined);
  };

  // A click on the empty chat's suggestions: a starter is sent as the first
  // message; a todo opens its session, starts a new thread there (the same
  // context boundary as Clear) and sends "Let's work on this todo: <summary>"
  // plus its description once the session has loaded. The session opens
  // asynchronously, so the start waits as `pendingStart` and the effect below
  // runs it once the right session has loaded: boundary first, then (in the
  // next render, which has the new contextStart) the send. When it can't go
  // (no model, busy, session didn't load), the text is put in the message box.
  const [pendingStart, setPendingStart] = useState<StartAction | null>(null);
  const startFromEmpty = (start: Start) => {
    const action = startAction(start, { model: !!model && !!connector, busy: runActive });
    if (action.sessionId && action.sessionId !== sessionId) openSession(action.sessionId);
    if (action.kind === "fill") setFill({ text: action.text, n: Date.now() });
    else setPendingStart(action);
  };
  useEffect(() => {
    if (!pendingStart || !loaded || (pendingStart.sessionId && pendingStart.sessionId !== sessionId)) return;
    const action = settleStart(pendingStart, loadedOk.current, todosRef.current);
    if (action.kind === "fill") {
      setPendingStart(null);
      setFill({ text: action.text, n: Date.now() });
    } else if (action.boundary) {
      clearContext();
      setPendingStart({ ...action, boundary: false });
    } else {
      setPendingStart(null);
      send(action.text).then((sent) => {
        if (!sent) setFill({ text: action.text, n: Date.now() });
      });
    }
  }, [pendingStart, loaded, sessionId]);

  // Asks in a Dialog first, like deleting a chat: window.confirm is answered
  // "no" at once, without being shown, in some browsers.
  const [confirmCompact, setConfirmCompact] = useState(false);
  const compactSession = () => setConfirmCompact(true);
  const compactConfirmed = () => {
    setConfirmCompact(false);
    if (contextStart > 0) {
      // Remove forgotten messages from the array
      setMessages(messages.slice(contextStart));
      // A cloned plan's place counts messages, so it moves with them. A plan
      // whose turn is removed goes to the top ("at:0"), where that turn was.
      const removed = new Set(messages.slice(0, contextStart).flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      const shift = (a: string | null) => {
        if (!a) return a;
        if (!a.startsWith("at:")) return removed.has(a) ? "at:0" : a;
        return `at:${Math.max(0, Number(a.slice(3)) - contextStart)}`;
      };
      setPlanAnchor(shift(planAnchor));
      setPastPlans(pastPlans.map((p) => ({ ...p, anchor: shift(p.anchor) })));
      setThreads(threads.map((t) => ({ ...t, anchor: shift(t.anchor) })));
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
        busy={false}
        attention={attention}
        inProgress={inProgress}
        onSelect={(id) => id !== sessionId && openSession(id)}
        onNew={newChat}
        onNewNested={newNested}
        onDelete={removeSession}
        onRename={renameSessionLocal}
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
              onChange={(e) =>
                e.target.value === MANAGE_MODELS ? (location.hash = "#/settings/models") : setModel(e.target.value)
              }
              disabled={runActive}
              sx={{ width: narrow ? "100%" : 240 }}
              // The status chips are for the open menu; closed, just the name fits.
              // No padding under the list: Manage models' hover highlight then runs
              // to the menu's edge, and its text is centered in all the space below
              // its line (the padding read as part of it, so the text looked high).
              slotProps={{
                select: { renderValue: (v) => String(v), MenuProps: { slotProps: { list: { sx: { pb: 0 } } } } },
              }}
            >
              {models.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {/* Laid out like a row on the Models page. */}
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center", width: "100%" }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <Typography sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{m.id}</Typography>
                        {m.status !== "unknown" && (
                          <Chip
                            size="small"
                            label={m.status}
                            color={m.status === "loaded" ? "success" : "default"}
                            variant="outlined"
                          />
                        )}
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        {m.contextSize ? `${m.contextSize.toLocaleString()}-token context` : "Context n/a"}
                        {m.source ? ` · ${m.source}` : ""}
                      </Typography>
                    </Box>
                    {/* Load / Unload, like the Models page (deleting is only there).
                        Clicking it doesn't pick the model, and an empty space keeps
                        the icons lined up. */}
                    {m.status !== "unknown" && (
                      <Box onClick={(e) => e.stopPropagation()} sx={{ flexShrink: 0 }}>
                        {modelBusy === m.id ? (
                          <Box sx={{ width: 34, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <CircularProgress size={16} />
                          </Box>
                        ) : m.status === "loaded" || m.status === "unloaded" ? (
                          <Tooltip title={m.status === "loaded" ? "Unload model" : "Load model"}>
                            <IconButton
                              size="small"
                              disabled={modelBusy !== null}
                              onClick={() => setModelLoaded(m.id, m.status !== "loaded")}
                              aria-label={`${m.status === "loaded" ? "Unload" : "Load"} ${m.id}`}
                            >
                              {m.status === "loaded" ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <Box sx={{ width: 34 }} />
                        )}
                      </Box>
                    )}
                  </Stack>
                </MenuItem>
              ))}
              {/* A Select item picks a value, so this one has its own (see onChange).
                  The icon is the Models page's, from Settings. */}
              {/* A border, not a Divider: Select makes every child an option. */}
              {/* The space above the line is margin, outside the hover highlight;
                  the padding is even, so the text stays centered in it. */}
              <MenuItem value={MANAGE_MODELS} sx={{ borderTop: 1, borderColor: "divider", mt: 1, py: 1.25 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }}>
                  <ViewInArOutlinedIcon fontSize="small" />
                  <span>Manage models</span>
                </Stack>
              </MenuItem>
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
                disabled={runActive || toolCount === 0}
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
                disabled={runActive || !canPlan}
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
        {/* New chat lives in the Sessions panel; here only while that's hidden.
            It comes first so the Sessions toggle and Settings never move. */}
        {!(narrow ? drawerOpen : sessionsOpen) && (
          <Tooltip title="New session">
            <span>
              <IconButton onClick={newChat}>
                <AddCommentIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title={(narrow ? drawerOpen : sessionsOpen) ? "Hide sessions" : "Show sessions"}>
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

      <Dialog open={confirmCancelPlan} onClose={() => setConfirmCancelPlan(false)} maxWidth="xs">
        <DialogTitle>Discard this plan?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {planRunning ? "This stops the step that's running and removes" : "This removes"} the plan and its
            checklist. The steps' messages stay in the chat, and anything they already changed stays changed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCancelPlan(false)}>Keep it</Button>
          <Button color="error" variant="contained" onClick={cancelPlanConfirmed}>
            Discard plan
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs">
        <DialogTitle>Delete this session?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            “{sessions.find((s) => s.id === confirmDelete)?.title ?? "This session"}” and its messages will be deleted.
            This can't be undone.
            {heldNested > 0 &&
              (heldNested === 1
                ? " Its 1 nested session will be deleted too."
                : ` Its ${heldNested} nested sessions will be deleted too.`)}
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
        <Container maxWidth={false} ref={contentRef}>
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
                <>
                  {/* Three quarters of the way down the chat area, near the message box:
                      placed against the scrolling box (position: relative), so it stays
                      in proportion at any window size. The creature and the suggestions
                      hang off the heading, so a heading that wraps can't run into them. */}
                  <Box
                    sx={{
                      position: "absolute",
                      top: "75%",
                      left: 0,
                      right: 0,
                      transform: "translateY(-50%)",
                    }}
                  >
                    <Typography
                      variant="h3"
                      sx={{
                        textAlign: "center",
                        fontWeight: 500,
                        fontSize: { xs: "2.25rem", sm: "3rem" },
                      }}
                    >
                      How can I help you?
                    </Typography>
                    <EmptyChatCreature />
                    <EmptyChatSuggestions onStart={startFromEmpty} onOpenSession={openSession} />
                  </Box>
                </>
              )
            )}
            {turns.map(
              (t, i) =>
                // A plan step's turns show under the step instead, waiting
                // dots included; the step's spinner shows progress here.
                !t.parts[0].planStep && (
                  <Fragment key={t.start}>
                    {cardsBefore(t.start, false)}
                    {t.start === contextStart && contextStart > 0 && <ContextDivider />}
                    {cardsBefore(t.start, true)}
                    {bubble(t, i)}
                    {planCards.filter((c) => slot(c.anchor).after === t.start).map((c) => c.card)}
                  </Fragment>
                ),
            )}
            {cardsBefore("end", false)}
            {/* Cleared after the last message: the divider goes at the end. */}
            {contextStart > 0 && contextStart === messages.length && <ContextDivider />}
            {cardsBefore("end", true)}
            {planCards.filter((c) => slot(c.anchor).lost).map((c) => c.card)}
            {/* Messages sent to the running plan that no step has seen yet:
                they join the chat when their step starts. */}
            {runnerView?.notes.map((n) => (
              <Box key={n.id} sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5 }}>
                <Paper sx={{ px: 2, py: 1.5, maxWidth: "100%", bgcolor: "primary.main", color: "primary.contrastText", opacity: 0.6 }}>
                  <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{n.text}</Typography>
                </Paper>
                <Typography variant="caption" color="text.secondary">
                  Step {n.step} will see this when it starts
                </Typography>
              </Box>
            ))}
            {shownPending && !promptInPlan && (
              <PendingPrompt ask={shownPending.ask} onDecide={shownPending.decide} />
            )}
            {notLoaded && (
              <Alert severity="info">
                {notLoaded} isn't loaded, so nothing was sent. Load it with ▶ in the model menu (it takes a moment and
                uses the server's memory), or pick a model that's loaded.
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </Container>
        {/* Sticky with no height: it floats over the bottom of the chat
            without adding space under the last message. */}
        {moreBelow && messages.length > 0 && (
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
            <SessionSettings
              attachments={attachments}
              workingDir={workingDir}
              locked={attachmentsLocked}
              onAttach={attach}
              onDetach={(p) => changeAttachments((as) => as.filter((x) => x.path !== p))}
              onSetWorkingDir={changeWorkingDir}
              checkCommands={toolContext.checkCommands}
              onSetCheckCommand={(folder, command) =>
                setCheckCommand(folder, command)
                  .then(() => setContextVersion((v) => v + 1))
                  .catch((e) => setError(e.message))
              }
            />
            <Composer
              placeholder={
                planRunning
                  ? narrow
                    ? "Message the plan"
                    : "Message the running plan: the next step will see it (Enter to send)"
                  : narrow
                    ? "Message"
                    : "Message (Enter to send, Shift+Enter for a new line)"
              }
              onSend={send}
              fill={fill}
              // Stop here is for a reply that is streaming. A plan run is
              // paused from its card, and the box keeps Send for messages to it.
              onStop={
                turnRunning ? () => showFailure(stopRunner(sessionId)) : undefined
              }
              disabled={!model && !planRunning}
              below={
                showIndicator && (
                  <ContextIndicator
                    usage={usage}
                    contextSize={models.find((m) => m.id === model)?.contextSize}
                    onClear={clearContext}
                    onCompact={compactSession}
                    canCompact={contextStart > 0}
                    disabled={runActive}
                  />
                )
              }
            />
          </Stack>
        </Container>
      </Paper>
      </Box>
    </Box>
  );
}

// The message box and Send (Stop while a reply runs). It keeps what's typed
// itself: kept in Chat, every keystroke redrew the whole chat, about 100 ms
// each in a 300-message one.
function Composer({
  placeholder,
  onSend,
  onStop,
  disabled,
  below,
  fill,
}: {
  placeholder: string;
  // Text to put in the box and focus it (not sent); a new `n` is a new request.
  fill?: { text: string; n: number } | null;
  // Resolves to whether the message went; the box clears only then.
  onSend: (text: string) => Promise<boolean>;
  onStop?: () => void;
  disabled: boolean;
  // Under Send: the context indicator.
  below: ReactNode;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    inputRef.current?.focus();
  }, [fill]);
  const send = async () => {
    const t = text.trim();
    if (t && (await onSend(t))) setText("");
  };
  return (
    <>
      <TextField
        fullWidth
        multiline
        maxRows={8}
        placeholder={placeholder}
        inputRef={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {/* Send lines up with the input's top edge; the context
          indicator sits just below it. */}
      <Stack spacing={1.25} sx={{ flexShrink: 0, alignItems: "center" }}>
        {/* Icons, with the words as tooltip and accessible label. */}
        {!onStop && (
          <Tooltip title="Send">
            <span>
              <IconButton
                aria-label="Send"
                onClick={send}
                disabled={!text.trim() || disabled}
                sx={{
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                  "&:hover": { bgcolor: "primary.dark" },
                  "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" },
                }}
              >
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {onStop && (
          <Tooltip title="Stop the reply">
            <IconButton
              aria-label="Stop"
              onClick={onStop}
              sx={{ border: 1, borderColor: "error.main", color: "error.main", "&:hover": { bgcolor: "action.hover" } }}
            >
              <StopIcon />
            </IconButton>
          </Tooltip>
        )}
        {below}
      </Stack>
    </>
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
  connectorName,
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
  // Who answered the failed request, named in its error line.
  connectorName?: string;
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
  const [showHidden, setShowHidden] = useState(false);
  const showMarkdown = override ?? renderMarkdown;
  // The finished reply's time and speed, kept on its last message.
  const took = [...parts].reverse().find((m) => m.took)?.took;
  const isUser = parts[0].role === "user";
  // What was sent after this message without being shown: its chat update
  // and note (see docs/guide.md, "What the model is told"). Opened on request.
  const hidden = isUser ? [parts[0].update, parts[0].note].filter(Boolean).join("\n\n") : "";
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
            {failureLine(failed, connectorName)}
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
          {hidden && showHidden && (
            <Typography
              variant="body2"
              component="div"
              sx={{ whiteSpace: "pre-wrap", opacity: 0.8, borderTop: 1, borderColor: "currentColor", pt: 1 }}
            >
              {hidden}
            </Typography>
          )}
          {!streaming && parts.some((m) => m.content) && (
            <Box sx={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 1, mb: -1, mr: -1 }}>
              {hidden && (
                <Tooltip title={showHidden ? "Hide what was sent with this message" : "Show what was sent with this message, unseen"}>
                  <IconButton
                    size="small"
                    onClick={() => setShowHidden(!showHidden)}
                    aria-pressed={showHidden}
                    sx={{ color: "inherit" }}
                  >
                    <StickyNote2OutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
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
      {/* A message sent to a running plan: which step saw it. */}
      {isUser && (parts[0].seenByStep || parts[0].notSeen) && (
        <Typography variant="caption" color="text.secondary">
          {parts[0].seenByStep ? `Seen by step ${parts[0].seenByStep}` : "No step saw this: the plan ended first"}
        </Typography>
      )}
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
  // A name with an extension is probably a file.
  const likelyFile = /\.[^/]+$/.test(path);
  return (
    <FindPrompt
      heading={likelyFile ? "File not found:" : "Directory not found:"}
      subject={path}
      isPath
      icon={<SearchOffIcon fontSize="small" />}
      kinds={likelyFile ? ["file", "folder"] : ["folder", "file"]}
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
        The model wants access to this {target.kind}, which isn't attached to this session:
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere", my: 0.5 }}>
        {target.path}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div">
        Allowing attaches it to this session{target.kind === "folder" ? ", subfolders included" : ""}. Changes to it
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
        Choose it and it's attached to this session; the model then uses that path.
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
      icon={
        isCommand ? (
          <TerminalOutlinedIcon fontSize="small" />
        ) : approval.type === "worktree" ? (
          <AccountTreeOutlinedIcon fontSize="small" />
        ) : (
          <EditOutlinedIcon fontSize="small" />
        )
      }
      sx={{ "& .MuiAlert-message": { minWidth: 0, flexGrow: 1 } }}
    >
      {approval.type === "command" ? (
        <>
          <Typography variant="body2">The model wants to run this command:</Typography>
          <Box sx={{ position: "relative", my: 1 }}>
            <Box
              component="pre"
              sx={{ m: 0, p: 1, pr: 5, borderRadius: 1, bgcolor: "background.default", fontFamily: "monospace", fontSize: "0.85rem", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              $ {approval.command}
            </Box>
            {/* The command alone, without the "$ ", to run it yourself. */}
            <Tooltip title="Copy command">
              <IconButton
                size="small"
                aria-label="Copy command"
                onClick={() => navigator.clipboard.writeText(approval.command).catch(() => {})}
                sx={{ position: "absolute", top: 4, right: 4 }}
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Typography variant="caption" color="text.secondary" component="div">
            In {approval.cwd}. It runs as you, with your network access and credentials.
          </Typography>
        </>
      ) : approval.type === "worktree" ? (
        <>
          <Typography variant="body2">The model wants to remove a git worktree:</Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere", my: 0.5 }}>
            {approval.path}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            Of {approval.repo}. The branch {approval.branch} stays, with its commits.
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
            ? "Context almost full: the model will start forgetting the start of this session. Start a new session."
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
