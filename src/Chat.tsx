import { Fragment, useCallback, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import { isImageFile, prepareImage, revokePreview } from "./images";
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
  Checkbox,
  FormControlLabel,
  Divider,
  Fab,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Popover,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
  type TypographyProps,
  useMediaQuery,
  useTheme,
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
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import TerminalOutlinedIcon from "@mui/icons-material/TerminalOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import StickyNote2OutlinedIcon from "@mui/icons-material/StickyNote2Outlined";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import DnsOutlinedIcon from "@mui/icons-material/DnsOutlined";
import CloseIcon from "@mui/icons-material/Close";
import ReplyOutlinedIcon from "@mui/icons-material/ReplyOutlined";
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
  type Picked,
  type Approval,
  type ToolContext,
  type PlanStep,
  type AutoKind,
  type Todo,
  type ImageRef,
  rememberFolder,
  setCheckCommand,
  type Session,
  type SessionSummary,
  type Usage,
  type Connector,
  type Model,
  getConnectors,
  getModelSettings,
  getPreferences,
  getToolContext,
  listModels,
  loadModel,
  unloadModel,
  pickAttachments,
  getRecentFolders,
  deleteSession,
  deleteImage,
  getSession,
  getWorktreeStatuses,
  listSessions,
  renameSession,
  runTool,
  saveSession,
  noteRevision,
  ApiError,
  MAX_REPLY_QUOTE,
} from "./api";
import { removeRow, upsertRow, watchSessionList } from "./sessionRows";
import { connectionForChat, pickModel } from "./modelChoice";
import { getSavedModelsConnectorId, pickModelsConnector, setSavedModelsConnectorId } from "./modelsConnector";
import { autoApproves } from "./autoApprove";
import { copyText } from "./clipboard";
import { approvalWhy, canMakePlan, readOnlyLabel } from "./approvalWhy";
import { createMessageBox, type MessageBox, type PendingImage } from "./messageBox";
import { submitDraft } from "./submitDraft";
import { optimisticSend } from "./optimisticSend";
import { lastEditable } from "./editLast";
import { newId } from "./uuid";
import SessionSettings, { ATTACHMENTS_LOCKED_NOTE, AttachmentIcon } from "./SessionSettings";
import SessionsPanel from "./SessionsPanel";
import Panel, { PanelAction, PanelButton } from "./Panel";
import EmptyChatCreature from "./EmptyChatCreature";
import EmptyChatSuggestions from "./EmptyChatSuggestions";
import { settleStart, startAction, type Start, type StartAction } from "./todos";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import MarkdownRenderer from "./MarkdownRenderer";
import RecentFolders from "./RecentFolders";
import { commandSummary, INTERRUPTED, failureLine } from "./agent/helpers";
import {
  DO_IT_MESSAGE,
  doItDisabled,
 doItPress,
  hasDoIt,
  hasDone,
  ideaTodo,
  noteBoxes,
  noteLabel,
  offersOf,
  planMessage,
  setNoteDone,
  shownCalls,
  todoAdded,
  type NoteBox,
} from "./agent/replyNotes";
import type { NoteKindId } from "./replyNoteKinds";
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
import { applyThreadEvent, noteAskKind, noteView, planResult, threadStatus, worktreeLines, type ThreadStatus } from "./planThread";
import {
  allViews,
  askAside,
  dismiss,
  getView,
  isLive,
  needsYou,
  sendChat,
  sendMessage as sendToRun,
  setAutoApprove as sendAutoApprove,
  startRun as startRemoteRun,
  stop as stopRunner,
  stopAside,
  subscribe,
  subscribeAll,
  type RunOptions,
  type RunnerView,
  uploadImage,
} from "./runClient";
import ThreadNote from "./ThreadNote";
import { StatusIcon } from "./StatusMark";
import {
  clearOnShow,
  clearSendRefusal,
  dropSession,
  emptyChatErrors,
  leaveSession,
  mirrorRun,
  setGlobal,
  setSession as setSessionError,
  visibleError,
  type ChatErrors,
} from "./chatErrors";
import { withSessionDefaults } from "./sessionDefaults";
import { emptySessionState, fromSession, stateKey, toSession, type SessionState } from "./sessionState";
import { SESSION_KEY } from "./sessionRoute";
import { descendantIds, nestedHeldBy, nestedSessionFrom } from "./sessionTree";

// Per-browser choices kept in localStorage: whether the toolbar is expanded,
// and whether the sessions panel is open. Storage can be unavailable (private
// windows), so failures fall back to the default.
const TOOLBAR_KEY = "llama-mui:toolbarOpen";
// Whether the chats panel is open (wide screens; on phones and small windows it's a drawer).
const SESSIONS_OPEN_KEY = "llama-mui:sessionsOpen";
function loadSessionId(): string {
  try {
    const id = localStorage.getItem(SESSION_KEY);
    if (id) return id;
  } catch {
    // Falls through to a new chat.
  }
  return newId();
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
  | { needsLocation: { description: string; kind: AttachmentTarget["kind"]; canSetWorkingDir?: boolean } }
  | { needsApproval: Approval };
type Answer = boolean | "plan" | Picked[];

// A model stuck in a loop repeats itself: the third identical call (same tool,
// same arguments) in one reply isn't run, and the model answers with what it
// has. ProgressWatch (agent/progress.ts) catches the loops whose arguments
// keep changing: commands giving the same output again and again, or rounds
// that bring nothing new. MAX_TOOL_ROUNDS is only the last backstop.

// The model menu's "Manage models" item: its value opens Settings → Models
// instead of picking a model.
const MANAGE_MODELS = "__manage_models__";
// The same for the connection menu's "Manage connections" item.
const MANAGE_CONNECTIONS = "__manage_connections__";

// How the connection and model menus open: a long list scrolls inside the menu
// instead of running down the window. No padding under the list: the last item's
// hover highlight then runs to the menu's edge, and its text is centered in all
// the space below its line (the padding read as part of it, so the text looked high).
const MENU_PROPS = { slotProps: { paper: { sx: { maxHeight: "min(26rem, 60vh)" } }, list: { sx: { pb: 0 } } } };

// The last item of each menu ("Manage models", "Manage connections"). It stays
// at the bottom while the list scrolls, under a thin line with a small gap above.
// The line is a border, not a Divider: Select makes every child an option. The gap
// is margin, outside the hover highlight, and the padding is even, so the text
// stays centered. Anything scrolling under it must not show through: the item,
// the gap (the ::before) and its hover and focus colours are all opaque, painted
// over the menu's own background (and its dark-mode lightening).
const manageItemSx: SxProps<Theme> = (t) => {
  const p = (t.vars ?? t).palette;
  const opaque = { backgroundColor: p.background.paper, backgroundImage: "var(--Paper-overlay)" };
  const over = (c: string) => ({
    backgroundColor: p.background.paper,
    backgroundImage: `linear-gradient(${c}, ${c}), var(--Paper-overlay)`,
  });
  return {
    position: "sticky",
    bottom: 0,
    zIndex: 1,
    borderTop: 1,
    borderColor: "divider",
    mt: 1,
    py: 1.25,
    ...opaque,
    // Positioned from the padding edge, which is under the 1px line: the strip
    // ends at the line's top edge so it doesn't paint over the line.
    "&::before": { content: '""', position: "absolute", left: 0, right: 0, top: "calc(-0.5rem - 1px)", height: "0.5rem", ...opaque },
    "&:hover": over(p.action.hover),
    "&.Mui-focusVisible": over(p.action.focus),
  };
};

// What happened to a failed reply, in the user's terms. Our server answers 502
// when it can't reach the llama server; a TypeError means the request never
// got an answer at all.
export default function Chat({ visible, onOpenSettings }: { visible: boolean; onOpenSettings: () => void }) {
  // Every connection set up in Settings (undefined until the first load), and
  // the one this chat saved (null: none yet, so it follows the last used one
  // until its first run). `connector` is the chat's own connection: undefined
  // until the list has loaded, null when there is none or the one this chat
  // saved has been deleted.
  const [connectors, setConnectors] = useState<Connector[] | undefined>(undefined);
  const [connectorId, setConnectorId] = useState<string | null>(null);
  const connector =
    connectors === undefined ? undefined : connectionForChat(connectors, connectorId, getSavedModelsConnectorId());
  // Bumped each time the list is read again, so the models are too.
  const [connectorsRead, setConnectorsRead] = useState(0);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  // Everything about the open chat that is saved with it, in one object (see
  // sessionState.ts for what each field is). `sessionRef` is always the latest
  // one, so a change made right after another, before a render, starts from the
  // first, and the plan runner and tool calls can read the plan and the todos
  // between awaits through planRef and todosRef.
  const [session, setSession] = useState<SessionState>(emptySessionState);
  const sessionRef = useRef(session);
  const planRef = useRef<PlanStep[] | null>(null);
  const todosRef = useRef<Todo[]>([]);
  // The one way to change it: a partial change, or a function from the current
  // state to one. A change that alters nothing is dropped, so setting a field
  // to what it already is renders nothing and doesn't restart the save timer.
  const updateSession = (change: Partial<SessionState> | ((current: SessionState) => Partial<SessionState>)) => {
    const current = sessionRef.current;
    const part = typeof change === "function" ? change(current) : change;
    const keys = Object.keys(part) as (keyof SessionState)[];
    if (keys.every((k) => Object.is(current[k], part[k]))) return;
    const next = { ...current, ...part };
    sessionRef.current = next;
    planRef.current = next.plan;
    todosRef.current = next.todos;
    setSession(next);
  };
  // The fields by name, so reads stay as they were.
  const {
    messages,
    contextStart,
    attachments,
    workingDir,
    promptDir: fixedPromptDir,
    usage,
    failed,
    modelName,
    plan,
    planProposal,
    planContext,
    planSummary,
    planId,
    planAnchor,
    pastPlans,
    todos,
    parentId,
    threads,
    autoApprove,
    titleHint,
    planMovedIn,
  } = session;
  // Per-model options from Settings → Models, plus the server's defaults for
  // models nobody changed.
  const [modelSettings, setModelSettings] = useState<{
    defaults: ModelSettings;
    models: Record<string, ModelSettings>;
  } | null>(null);
  // Attachments are extra files and folders this chat's disk tools may read,
  // besides the working directory; New chat clears them. The working directory
  // is where relative paths and commands start; it is chosen in Session
  // settings, not one of the attachments, and New chat clears it.
  const attachedPaths = (as: Attachment[]) => as.map((a) => a.path);
  // The working directory the system prompt names. Fixed by the session's
  // first message: after that a change goes in a chat update, so the system
  // prompt stays the same. Until then (undefined) it follows workingDir.
  const promptDir = fixedPromptDir === undefined ? workingDir : fixedPromptDir;
  // What to offer the model given those attachments and Settings → Tools.
  const [toolContext, setToolContext] = useState<ToolContext>({
    definitions: [],
    systemPrompt: null,
    offered: [],
    update: "",
    checkCommands: {},
  });
  // Error banners: global ones show in every session, the others only in the
  // session they belong to (see src/chatErrors.ts). The owner of a message is
  // kept in the same state as the message, so the banner follows the open session.
  const [errors, setErrors] = useState<ChatErrors>(emptyChatErrors);
  const showGlobalError = (message: string | null) => setErrors((s) => setGlobal(s, message));
  // Always pass the id of the session the action started in, so a failure that
  // comes late lands in its own session.
  const showSessionError = (id: string, message: string | null) => setErrors((s) => setSessionError(s, id, message));
  // The plan's context (requirements, notes the model wrote alongside it) is
  // cleared when the plan is cancelled, moved into pastPlans when a plan is
  // archived, and kept when a plan is cloned; the plan's one-sentence summary
  // (update_plan's top-level summary) goes where it goes. The plan's id is set
  // when it moved into this thread (see Session.planId); Chat only keeps it, so
  // a save doesn't lose it, and the agent archives it with the plan. A plan
  // shows after the turn whose update_plan call wrote it (planAnchor), so it
  // stays in place in the history; a finished plan stays there when a new one
  // is written, and the new one shows after its own turn.
  // A finished plan never runs again; Clone starts a new one with its steps,
  // all pending, at the end of the chat. Not while another plan is unfinished,
  // which the clone would replace (see canClone).
  const clonePlan = (steps: PlanStep[], context?: string | null, summary?: string | null) => {
    updateSession((s) => ({
      pastPlans: s.plan
        ? [...s.pastPlans, { steps: s.plan, anchor: s.planAnchor, context: s.planContext, summary: s.planSummary, ...(s.planId ? { planId: s.planId } : {}) }]
        : s.pastPlans,
      planId: null,
      planAnchor: `at:${s.messages.length}`,
      plan: steps.map((st) => ({
        id: newId(),
        text: st.text,
        ...(st.summary ? { summary: st.summary } : {}),
        status: "pending" as const,
      })),
      planContext: context ?? null,
      planSummary: summary ?? null,
    }));
    toBottom();
  };
  // A change the model suggested to a plan that's under way; see makeReply in src/runnerReply.ts.
  const answerProposal = (accept: boolean) => {
    // Matched again by text: the user may have changed the plan since. A step
    // kept from an older plan, with no summary, takes the proposal's. The plan's
    // own summary stays: a proposal changes steps, not what the plan is for.
    const old = planRef.current ?? [];
    const keep = (p: PlanStep) => {
      const o = old.find((x) => x.text === p.text);
      return o ? (o.summary || !p.summary ? o : { ...o, summary: p.summary }) : p;
    };
    updateSession({ planProposal: null, ...(accept && planProposal ? { plan: planProposal.map(keep) } : {}) });
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
  // While a plan runs, the message box either asks a side question (the
  // default: answered beside the plan, which never sees it) or tells the plan
  // (a note the next step sees). `asideRunning`: one is being answered.
  const [tellPlan, setTellPlan] = useState(false);
  const asideRunning = planRunning && !!runnerView?.aside;
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
  // Clear context moves contextStart to the end: earlier messages stay on
  // screen but aren't sent any more.
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  // Expanded on a wide screen the first time; on a phone it starts folded, so
  // the chat is what you see (the model was most likely chosen already). What
  // you choose after that is kept (see setToolbarOpen). Read from the window
  // here, not from useMediaQuery, which answers "no" on the first render.
  const theme = useTheme();
  const [toolbarOpen, setToolbarOpenState] = useState(() =>
    loadFlag(TOOLBAR_KEY, !window.matchMedia(theme.breakpoints.down("sm").replace(/^@media\s*/, "")).matches),
  );
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  // The sessions panel is a drawer below this width: beside the panel (and its
  // drag handle) the chat gets too narrow for its toolbar and message box.
  const drawerMode = useMediaQuery((t) => t.breakpoints.down("md"));
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
  // The banner under the chat: the open session's own message, else a global one.
  const error = visibleError(errors, sessionId);
  // What is in the message box (text and images), kept outside React state so
  // typing doesn't redraw the chat: only the box and the Edit buttons read it
  // (see messageBox.ts). The chat puts text in the box with box.fill.
  const [box] = useState(() => createMessageBox(sessionId));
  // The position of the user message being edited: sending then replaces it and
  // everything after it. Null when the box is for a new message.
  const [editing, setEditing] = useState<number | null>(null);
  // The response the next message replies to (Reply under a response): kept per
  // chat, cleared when the message is sent or the card is closed.
  const [replyTarget, setReplyTarget] = useState<{ id: string; text: string; n: number } | null>(null);
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

  // `live`: the session is a run's, as it is now (see mirrorView). A step that
  // is running there really is, so it isn't reset to pending, and the model
  // picker is left alone. `running`: that run has not ended, so the
  // "interrupted" mark it keeps while a request is in flight is not shown as
  // a failure (see shownFailure).
  const applySession = (s: Session, live = false, running = live) => {
    // fromSession fills the gaps of shared or older sessions, and pins a plan
    // saved before plans had a place after the chat's last message, where it
    // showed, so later messages go below it. That is counted as saved, so
    // opening the chat doesn't save it (see savedKey).
    const state = fromSession(s, { live, running });
    s = withSessionDefaults(s);
    savedKey.current = stateKey({ ...s, planAnchor: state.planAnchor, pastPlans: state.pastPlans });
    updateSession(state);
    if (s.model && !live) setModel(s.model);
    // A chat saved without a connection (older than this) has none yet and
    // follows the last used one; a run's own copy that lacks it leaves it be.
    if (!live || s.connectorId) setConnectorId(s.connectorId ?? null);
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
    // The run's error shows in its session, and clears only a run error, so
    // a message of Chat's own (a refusal, a server that can't be reached) isn't
    // wiped by every streamed piece.
    setErrors((s) => mirrorRun(s, v.sessionId, v.error));
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
          updateSession((s) => ({ threads: applyThreadEvent(s.threads, e) }));
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
      .catch((e) => showGlobalError(e.message));
  }, []);

  // The session as it is now, built from the current state.
  // The chat's connection is saved with it once it has one of its own: a chat
  // still following the last used connection is saved without, so opening an
  // old chat doesn't count as a change. A run adopts the connection it runs on
  // (`adopt`).
  const snapshot = (adopt?: string): Session => {
    return toSession(session, { id: sessionId, model, connectorId: connectorId ?? adopt });
  };

  // The server refused a save because the session is no longer what this page
  // loaded (another window saved it, or a plan or reply is running in it). The
  // server's copy is the one to show, so it is read again; what was changed
  // here since the last save is dropped, and the message says so.
  const reloadFromServer = (message: string) => {
    savedKey.current = "";
    showSessionError(sessionId, message);
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
    const key = stateKey(session);
    if (key === savedKey.current) return;
    savedKey.current = key;
    const savedId = sessionId;
    saveSession(session)
      .then((summary) => setSessions((ss) => upsertRow(ss, summary)))
      .catch((e) => {
        // A refusal about a session that has since been closed is not this screen's to show.
        if (e instanceof ApiError && e.status === 409 && openId.current === savedId) reloadRef.current(conflictMessage(e));
        else showSessionError(savedId, e.message);
      });
  };

  // Saves a moment after the chat stops changing, so a streaming reply is
  // saved when it pauses rather than on every token.
  useEffect(() => {
    const timer = setTimeout(saveNow, 800);
    return () => clearTimeout(timer);
  // modelName too: the model often names a session before its first save, when
  // the rename (PATCH) has no file to change yet, so the next save carries it.
  }, [loaded, session, model, connectorId]);

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
    // The session being left keeps only its run error.
    setErrors((s) => leaveSession(s, sessionId));
    scrollToPlan.current = toPlan === null ? null : { sessionId: id, planId: toPlan };
    setFollowing(toPlan === null);
    setSessionId(id);
    // The box shows the opened chat's draft, before anything is put in it.
    box.show(id);
    openId.current = id;
    saveSessionId(id);
    savedKey.current = "";
    setRunnerView(null);
    updateSession(emptySessionState());
    // The session's own connection comes with it (applySession); a session that
    // can't be read opens as a new chat, on the last used connection.
    setConnectorId(null);
    setDrawerOpen(false);
    loadSession(id);
  };
  // An empty session under `parentId`, with the same working directory, attachments and model
  // but none of its messages. It is saved right away (saveNow skips empty
  // sessions) so it shows in the list under its parent, then opened.
  const newNested = async (parentId: string) => {
    // The session open when this was asked: a failure that arrives later belongs to it.
    const from = sessionId;
    try {
      const parent =
        parentId === sessionId
          ? { id: sessionId, model, connectorId: connectorId ?? connector?.id, attachments, workingDir }
          : withSessionDefaults(await getSession(parentId));
      const child = nestedSessionFrom(parent, newId());
      const summary = await saveSession(child);
      setSessions((ss) => [summary, ...ss.filter((x) => x.id !== summary.id)]);
      openSession(child.id);
    } catch (e) {
      showSessionError(from, e instanceof Error ? e.message : String(e));
    }
  };
  // A new session starts on the last used connection and that connection's
  // default model (see pickModel), not on whatever this chat last used; opening
  // a saved one keeps its own.
  const newChat = () => {
    openSession(newId());
    const next = connectors ? pickModelsConnector(connectors, getSavedModelsConnectorId()) : null;
    setConnectorId(next?.id ?? null);
    if (next && next.id === connector?.id) {
      // Its models are the ones listed already.
      const start = pickModel({ current: "", defaultModel: next.defaultModel, models });
      if (start) setModel(start);
    } else {
      // Another connection's models load next, and the model is picked from them.
      setModel("");
    }
  };
  // Discarding a plan (the card offers it only while nothing runs) asks first,
  // and removes the plan. If a run started meanwhile, it is stopped first. The steps' messages stay in the chat, and
  // what they changed stays changed. A run owns its session, so the page waits
  // until the run is over, takes the session as the run left it, and only then
  // removes the plan; that is saved like any other change.
  const [confirmCancelPlan, setConfirmCancelPlan] = useState(false);
  const clearPlan = () => {
    updateSession({ plan: null, planProposal: null, planContext: null, planSummary: null, planId: null, planAnchor: null });
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
        if (openId.current === id) showSessionError(id, e instanceof Error ? e.message : String(e));
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
      .catch((e) => showGlobalError(e.message));
  };
  // Puts a top-level session in a group (null: none). The server keeps it.
  const groupSessionLocal = (id: string, group: string | null) => {
    renameSession(id, { group })
      .then((summary) => setSessions((ss) => ss.map((x) => (x.id === id ? { ...x, group: summary.group ?? null } : x))))
      .catch((e) => showGlobalError(e.message));
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
        setErrors((s) => [...gone].reduce(dropSession, s));
        // The open session is one of them: start a new one.
        if (gone.has(sessionId)) openSession(newId(), false);
      })
      .catch((e) => showGlobalError(e.message));
  };

  // A llama server in router mode loads a model on demand when a request names
  // it: opening an old chat and sending once loaded the 27B next to the 9B, and
  // both slowed to 5 tok/s. So nothing is sent to a model that isn't loaded;
  // loading is an explicit action, in the model menu or on the Models page.
  // The server checks as it starts each reply (see modelLoaded in
  // runnerReply.ts) and says so in the reply; the check here is for starting a
  // plan from its card. `notLoaded` is the model the note under the chat is about.
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
      showGlobalError(`${id} still wasn't ${want} after two minutes; check the Models page.`);
    } catch (e: any) {
      showGlobalError(`Couldn't ${load ? "load" : "unload"} ${id}: ${e.message}`);
    } finally {
      setModelBusy(null);
    }
  };
  // Picking another model answers the note.
  useEffect(() => setNotLoaded(null), [model]);

  // The chat's connection as of the latest render: a model list that arrives
  // after the chat moved to another connection is not for it, and is dropped.
  const connectorNow = useRef<string | null>(null);
  connectorNow.current = connector?.id ?? null;
  // Loads the connection's models and picks the one to use (see pickModel for
  // the order, with the connection's own default model).
  const refreshModels = (c: Connector) =>
    listModels(c.id)
      .then((ms) => {
        if (connectorNow.current !== c.id) return;
        setModels(ms);
        setModel((cur) => pickModel({ current: cur, defaultModel: c.defaultModel, models: ms }));
      })
      .catch((e) => {
        if (connectorNow.current !== c.id) return;
        // Don't offer models from a server we can't reach.
        setModels([]);
        showGlobalError(e.message);
      });

  refreshModelsAfterTurn.current = () => {
    if (connector) refreshModels(connector);
  };

  // The models follow the chat's connection: loaded when it is first known and
  // whenever the chat moves to another one, and again each time the list of
  // connections is read (below). A chat with no connection has no models.
  useEffect(() => {
    if (connector === undefined) return;
    if (connector) refreshModels(connector);
    else setModels([]);
  }, [connector?.id, connectorsRead]);

  // Reload everything each time chat shows: Settings may have changed the
  // connections, their keys or the folders, and a server that was down may be back.
  useEffect(() => {
    if (!visible) return;
    setErrors((s) => clearOnShow(s, openId.current));
    getConnectors()
      .then((l) => {
        setConnectors(l.connectors);
        setConnectorsRead((n) => n + 1);
      })
      .catch((e) => showGlobalError(e.message));
    getPreferences()
      .then(setPrefs)
      .catch((e) => showGlobalError(e.message));
    getModelSettings()
      .then(setModelSettings)
      .catch((e) => showGlobalError(e.message));
  }, [visible]);

  // Bumped to fetch the tool context again, after a check command changes.
  const [contextVersion, setContextVersion] = useState(0);
  // Settings → Tools or the attachments may have changed what's available.
  useEffect(() => {
    if (!visible) return;
    // The session this was asked for: a failure that arrives later belongs to it.
    const askedFor = sessionId;
    getToolContext(workingDir, attachedPaths(attachments), promptDir)
      .then(setToolContext)
      .catch((e) => showSessionError(askedFor, e.message));
  }, [visible, attachments, workingDir, promptDir, contextVersion]);

  // On only when the user wants tools and some are ready in this chat.
  const toolsOn = toolContext.offered.length > 0;
  useEffect(() => {
    setBusySince((since) => (runActive ? (since ?? Date.now()) : null));
  }, [runActive]);
  // The counter's start: the run's own (it may have started in another
  // session's view, or before this one was opened).
  const taskSince = runActive && runnerView ? runnerView.startedAt : busySince;

  const canPlan = toolsOn && toolContext.offered.includes("update_plan");
  const planOn = canPlan;
  const thinkOn = !!(modelSettings?.models[model] ?? modelSettings?.defaults)?.think;

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
    if (runnerActive(sessionId)) showSessionError(sessionId, ATTACHMENTS_LOCKED_NOTE);
    else updateSession((s) => ({ attachments: fn(s.attachments) }));
  };
  // Replaces the working directory (null clears it). The old one is not kept
  // as an attachment.
  const changeWorkingDir = (dir: string | null) => {
    if (runnerActive(sessionId)) showSessionError(sessionId, ATTACHMENTS_LOCKED_NOTE);
    else {
      updateSession({ workingDir: dir });
      // Remembered for the picker; if that fails the folder is still set.
      if (dir) rememberFolder(dir).catch(() => {});
    }
  };
  const attach = (a: Attachment) => changeAttachments((as) => (as.some((x) => x.path === a.path) ? as : [...as, a]));

  // The message being edited, while it is still the last one the user sent and
  // nothing runs. Anything else ends the edit: another chat, a reply or plan
  // starting, a newer message.
  const editTarget = editing !== null ? lastEditable(messages, planRunning, turnRunning) : null;
  const stillEditing = editTarget !== null && editTarget.index === editing;
  useEffect(() => {
    if (editing !== null && !stillEditing) setEditing(null);
  }, [editing, stillEditing]);
  useEffect(() => {
    setEditing(null);
  }, [sessionId]);
  // The up arrow in an empty box: takes the last message you sent back into
  // the box to change it. Returns whether there was one (none while a plan runs
  // or a reply streams).
  const editLast = (): boolean => {
    const target = lastEditable(messages, planRunning, turnRunning);
    if (!target) return false;
    setEditing(target.index);
    box.fill(target.text);
    return true;
  };
  // The Edit button on a message you sent, at `index` in the messages. The
  // last one is replaced when sent, like the up arrow; an older one only has
  // its text copied into the box, to be sent as a new message (nothing is cut).
  const editMessage = (index: number) => {
    if (!box.isEmpty()) return;
    const last = lastEditable(messages, planRunning, turnRunning);
    if (last && last.index === index) {
      editLast();
      return;
    }
    box.fill(messages[index].content);
  };

  // Sends what the user typed. Returns whether it went. `accepted` is called
  // once the send is certain to start (not refused above), so the message box
  // can clear at once instead of waiting while the session is saved and the
  // server is told; if the send then fails, it returns false and the box
  // gets its text back.
  // The response being replied to in this chat. Not while a plan runs: a
  // message then is a side question or goes to the plan, and carries no quote.
  const pendingReply = !planRunning && replyTarget?.id === sessionId ? replyTarget : null;
  // `base`: the messages to build the turn on instead of the ones shown (Do it
  // has marked its box done there, and that must be saved with the message).
  const send = async (text: string, images: PendingImage[] | undefined, accepted: () => void, base?: ChatMessage[]) => {
    const history = base ?? messages;
    // While a plan runs, a message is a side question (Ask) or goes to the run
    // (Tell the plan): the server folds that in before the next step and says
    // which one (see the notes under the chat). Either way a refusal shows as
    // the error, and the text is back in the box.
    if (planRunning) {
      // A message to a running plan is text only (the server refuses images too):
      // say so and keep the images where they are.
      if (images?.length) {
        showSessionError(sessionId, "Images can't be attached while a plan is running. Remove them to send the text, or wait for the plan to finish.");
        return false;
      }
      try {
        if (!tellPlan) {
          // A side question: answered beside the plan, which never sees it. The
          // box empties once it is certain to go, and gets the text back if the
          // server refuses (no plan any more, one being answered already).
          const options = runOptions();
          if (!options) {
            showSessionError(sessionId, "Choose a server and a model to ask a side question, or switch to Tell the plan.");
            return false;
          }
          accepted();
          await askAside(sessionId, text, options);
        } else {
          await sendToRun(sessionId, text);
        }
        // A refusal shown earlier is out of date now; the run's own error stays.
        setErrors((s) => clearSendRefusal(s, sessionId));
        toBottom();
        return true;
      } catch (e) {
        showSessionError(sessionId, e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    // A reply is streaming: another message waits for its end (the server
    // refuses it too, see sendNote).
    if (turnRunning) {
      showSessionError(sessionId, "A reply is still streaming. Wait for it to finish, or stop it, then send your message.");
      return false;
    }
    // The one before this is still being saved and sent.
    if (!model || !connector || starting.current) return false;
    // No check of the model here: the server looks, as it starts the reply, and
    // says in the reply if the model isn't loaded or is still loading. That is
    // one request from the tap instead of two.
    toBottom();
    // The quote goes with the message and the card closes once it is accepted;
    // a send that then fails brings the card back, as the box gets its text back.
    const quoted = pendingReply;
    accepted();
    if (quoted) setReplyTarget(null);
    // Editing the last message: it and what followed are replaced, like Resend,
    // and the images it was sent with stay (new ones are added to them). Its
    // own quote stays too, unless a new response is being replied to.
    if (editTarget && stillEditing) {
      const id = sessionId;
      const index = editTarget.index;
      setEditing(null);
      const went = await chatTurn(
        text,
        history.slice(0, index),
        false,
        images,
        editTarget.images.length ? editTarget.images : undefined,
        quoted?.text ?? messages[index]?.replyTo?.text,
      );
      // Refused: the text is back in the box, so it is still an edit.
      if (!went && openId.current === id) setEditing(index);
      if (!went && quoted) setReplyTarget((now) => now ?? quoted);
      return went;
    }
    const went = await chatTurn(text, history, planOn, images, undefined, quoted?.text);
    if (!went && quoted) setReplyTarget((now) => now ?? quoted);
    return went;
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
  // `replyTo`: the text of the response this message replies to (shown with the
  // message; the model never gets it).
  const chatTurn = (text: string, before: ChatMessage[], planning: boolean, pendingImages?: PendingImage[], existingRefs?: ImageRef[], replyTo?: string): Promise<boolean> => {
    if (!runOptions()) return Promise.resolve(false);
    const id = sessionId;
    // Show the message at once; the saves and the server's answer follow. Its
    // images have no refs until they're uploaded, so they appear later. If it
    // doesn't go, what was shown before comes back (unless the server's copy of
    // the session has arrived and replaced it already).
    return optimisticSend({
      before,
      message: { role: "user", content: text, replyTo: replyTo ? { text: replyTo.slice(0, MAX_REPLY_QUOTE) } : undefined },
      prior: messages,
      setMessages: (shown) => updateSession({ messages: shown }),
      canShow: () => openId.current === id,
      canRestore: () => openId.current === id && !getView(id)?.session,
      work: () => runTurn(text, before, planning, pendingImages, existingRefs, replyTo),
    });
  };
  const runTurn = async (text: string, before: ChatMessage[], planning: boolean, pendingImages?: PendingImage[], existingRefs?: ImageRef[], replyTo?: string): Promise<boolean> => {
    const options = runOptions();
    if (!options) return false;
    const id = sessionId;
    // The chat is on the connection it runs on from now on.
    setConnectorId(options.connectorId);
    const toSend = { ...snapshot(options.connectorId), messages: before };
    const key = stateKey(toSend);
    // A first message saves the session just so the server has it to read; if
    // the message doesn't go, that empty session is removed again.
    const listed = sessions.some((x) => x.id === id);
    // The server already holds exactly this session (it was opened or arrived
    // from the server and nothing changed since), so it isn't sent again: a long
    // chat is megabytes, and from a phone that was seconds with nothing to show.
    const inSync = listed && savedKey.current === key;
    starting.current = id;
    try {
      savedKey.current = key;
      if (!inSync) {
        const summary = await saveSession(toSend);
        setSessions((ss) => upsertRow(ss, summary));
      }
      // Upload pending images before sending the chat turn, or use refs already
      // uploaded (e.g. from a Resend retry).
      // Both can be given when a message is edited: its own images stay and
      // the ones added in the box follow them.
      let uploaded: ImageRef[] = [];
      if (pendingImages?.length) {
        try {
          const uploads = pendingImages.map((img) => uploadImage(id, img.blob));
          uploaded = await Promise.all(uploads);
        } catch (e) {
          // Upload failed: delete any images that did upload, and clean up the
          // empty session if one was created. The previews stay alive because
          // submitDraft restores these images to the box.
          const name = pendingImages[0]?.name ?? "Image";
          showSessionError(id, `${name}: upload failed — ${e instanceof Error ? e.message : String(e)}`);
          // Delete any images that uploaded before the failure.
          await Promise.all(uploaded.map((ref) => deleteImage(id, ref.id).catch(() => {})));
          // If this was a brand-new chat, remove the empty session.
          if (!listed && before.length === 0) {
            deleteSession(id).catch(() => {});
          }
          return false;
        }
      }
      const refs = [...(existingRefs ?? []), ...uploaded];
      await sendChat(id, text, { ...options, planning, images: refs.length ? refs : undefined, replyTo });
      // Until the server's copy of the session arrives (mirrorView), show the
      // message as sent, and a failure of the reply that came before it as gone.
      if (openId.current === id && !getView(id)?.session) {
        updateSession({
          messages: [...before, { role: "user", content: text, images: refs.length ? refs : undefined, replyTo: replyTo ? { text: replyTo.slice(0, MAX_REPLY_QUOTE) } : undefined }],
          failed: null,
        });
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
      runRefused(e, id);
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
    // The chat is on the connection it runs on from now on.
    setConnectorId(options.connectorId);
    const toRun = { ...snapshot(options.connectorId), plan: planRef.current };
    const key = stateKey(toRun);
    // Not sent again if the server already holds exactly this (see chatTurn).
    const inSync = sessions.some((x) => x.id === id) && savedKey.current === key;
    starting.current = id;
    try {
      savedKey.current = key;
      if (!inSync) {
        const summary = await saveSession(toRun);
        setSessions((ss) => upsertRow(ss, summary));
      }
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
  // The failure belongs to the session open when the command was sent.
  const showFailure = (command: Promise<unknown>) => {
    const id = sessionId;
    void command.catch((e) => showSessionError(id, e instanceof Error ? e.message : String(e)));
  };
  // Turns an approval for the rest of this session on or off (Session settings,
  // Approvals). The page's copy changes at once; the server's, by a command, so
  // a run that is going sees it too.
  const changeAutoApprove = (kind: AutoKind, on: boolean) => {
    updateSession((s) => {
      const { [kind]: _old, ...rest } = s.autoApprove;
      return { autoApprove: on ? { ...rest, [kind]: true } : rest };
    });
    showFailure(sendAutoApprove(sessionId, kind, on));
  };
  // Escape stops a streaming reply (a phone has the Stop button instead). It
  // leaves alone an Escape that closes a dialog or menu, or that another
  // handler already used.
  useEffect(() => {
    if (!turnRunning || !visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      showFailure(stopRunner(sessionId));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Escape ends the side question being answered, and only it: the plan goes
  // on (Pause is on its card). Same exceptions as above.
  useEffect(() => {
    if (!asideRunning || !visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      showFailure(stopAside(sessionId));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Each chat starts with Ask again.
  useEffect(() => setTellPlan(false), [sessionId]);
  // Says why a refused Run or a refused save didn't happen. A save refused
  // because the session changed (or runs) elsewhere shows the server's copy.
  // `id` is the session the action was for. If another one is open by now, it is
  // not reloaded: the message waits in its own session.
  const runRefused = (e: unknown, id: string) => {
    if (e instanceof ApiError && (e.data.reason === "run active" || e.data.reason === "stale revision")) {
      if (openId.current === id) reloadRef.current(conflictMessage(e));
      else showSessionError(id, conflictMessage(e));
    } else showSessionError(id, e instanceof Error ? e.message : String(e));
  };

  // The plan card's Run. This session is saved and the server is told to run
  // it. A plan that hasn't started moves into its own nested session (a
  // thread) on the server, which runs it there; this session stays open and
  // is read again to show the note where the plan was. The note spins, and
  // carries the thread's questions (see threadAsks). A plan that already started (Continue, Resume, Restart), or one that
  // was just moved in, runs where it is.
  const runFromCard = async () => {
    if (!connector || !model || runnerActive(sessionId)) return;
    const id = sessionId;
    try {
      if (!planMovedIn && !(await modelLoaded())) return;
      const ranIn = await startRun();
      // The server has saved this session without the plan, and with the note
      // for the thread: the page's copy is stale, so it is read again rather
      // than saved over it.
      if (ranIn && ranIn !== sessionId) {
        savedKey.current = "";
        loadSession(sessionId);
      }
    } catch (e) {
      runRefused(e, id);
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
  // The question each thread is waiting on, with the way to answer it (the
  // same as the thread's own view has, a command to the thread's session).
  const [threadAsks, setThreadAsks] = useState<Record<string, NonNullable<RunnerView["ask"]>>>({});
  useEffect(() => {
    setThreadStatuses({});
    setThreadAsks({});
    if (!loaded || !loadedOk.current) return;
    let current = true;
    const fromView = (id: string, v: RunnerView) => {
      setThreadAsks((m) => {
        const { [id]: old, ...rest } = m;
        if (old === v.ask) return m;
        return v.ask ? { ...rest, [id]: v.ask } : rest;
      });
      setThreadStatuses((m) => {
        const { [id]: _old, ...rest } = m;
        if (v.status !== "stopped") return { ...rest, [id]: "running" };
        return v.session ? { ...rest, [id]: threadStatus(withSessionDefaults(v.session)) } : rest;
      });
    };
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
      if (!current || !ids.has(e.id)) return;
      if (e.view) fromView(e.id, e.view);
      else setThreadAsks(({ [e.id]: _gone, ...rest }) => rest);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [loaded, sessionId]);

  // Where each thread's work lives (its worktrees' branch and what isn't on
  // main), asked of the server, which reads git. Asked when the notes first
  // show and again whenever a thread's status changes (it started, ended),
  // never on a timer.
  const [threadWhere, setThreadWhere] = useState<Record<string, string[]>>({});
  const whereKey = threads
    .map((t) => {
      const v = noteView(t, threadStatuses[t.sessionId]);
      return `${t.sessionId}:${v.running ? "running" : (v.status ?? "")}`;
    })
    .join("|");
  useEffect(() => {
    if (!loaded || !loadedOk.current || threads.length === 0) return;
    let current = true;
    for (const t of threads) {
      getWorktreeStatuses(t.sessionId)
        .then((rows) => current && setThreadWhere((m) => ({ ...m, [t.sessionId]: worktreeLines(rows) })))
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [loaded, sessionId, whereKey]);
  useEffect(() => setThreadWhere({}), [sessionId]);
  // The same for this session's own result, when it is a thread whose plan worked in a worktree: asked once the plan has stopped running.
  const [ownWhere, setOwnWhere] = useState<string[]>([]);
  useEffect(() => {
    setOwnWhere([]);
    if (!loaded || !loadedOk.current || runActive) return;
    let current = true;
    getWorktreeStatuses(sessionId)
      .then((rows) => current && setOwnWhere(worktreeLines(rows)))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [loaded, sessionId, runActive]);

  // Retries the last user message, dropping the failed reply (Resend). The
  // session is saved with the messages before that message, then the server is
  // told to send it again (see chatTurn). Like a first try it isn't a planning
  // turn, as before. Its images are sent again as the refs it already has.
  const retry = async () => {
    const userMsg = [...messages].reverse().find((m) => m.role === "user" && !m.aside);
    if (!userMsg || runActive || starting.current) return;
    if (!model || !connector) return;
    const index = messages.indexOf(userMsg);
    toBottom();
    // The images are already on the server: send the same refs again.
    const refs = userMsg.images?.length ? userMsg.images : undefined;
    await chatTurn(userMsg.content, messages.slice(0, index), false, undefined, refs, userMsg.replyTo?.text);
  };

  // Tool results show inside the call that asked for them, and the assistant
  // steps of one reply share a bubble.
  const toolResults = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId!, m]));
  // `start` is each turn's first message index, to place the divider.
  const turns: { parts: ChatMessage[]; start: number }[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") return;
    const prev = turns[turns.length - 1];
    // A side question's answer is a bubble of its own, never part of the plan's reply.
    if (m.role === "assistant" && prev?.parts[0].role === "assistant" && !prev.parts[0].aside === !m.aside && i !== contextStart) prev.parts.push(m);
    else turns.push({ parts: [m], start: i });
  });
  // The last turn that's a user message (not a side question: it has no Resend);
  // only its reply can fail.
  const lastUserTurn = turns.map((t) => t.parts[0].role === "user" && !t.parts[0].aside).lastIndexOf(true);
  // The turns that are streaming: the plan's reply is the last turn that isn't
  // a side question; a side question's, the last one that is (while one runs).
  const lastPlainTurn = turns.map((t) => !t.parts[0].aside).lastIndexOf(true);
  const lastAsideTurn = turns.map((t) => !!t.parts[0].aside).lastIndexOf(true);
  // One turn drawn as a bubble; `i` is its place among all turns.
  const bubble = (t: (typeof turns)[number], i: number) => (
    <MessageBubble
      key={t.start}
      parts={t.parts}
      streaming={t.parts[0].aside ? asideRunning && i === lastAsideTurn : !!runnerView?.streaming && i === lastPlainTurn}
      since={t.parts[0].aside ? null : taskSince}
      rate={streamRate}
      toolResults={toolResults}
      forgotten={t.start < contextStart}
      showSteps={prefs?.showSteps ?? true}
      renderMarkdown={prefs?.renderMarkdown ?? true}
      showModelName={prefs?.showModelName ?? false}
      failed={i === lastFailedTurnIndex ? failed : undefined}
      connectorName={connector ? connector.name || connector.kind : undefined}
      onResend={i === lastFailedTurnIndex ? retry : undefined}
      resendDisabled={i === lastFailedTurnIndex ? runActive : undefined}
      onEdit={t.parts[0].role === "user" && !t.parts[0].aside && !t.parts[0].planStep ? () => editMessage(t.start) : undefined}
      box={box}
      sessionId={sessionId}
      replyRunning={runActive || turnRunning}
      // Do it marks its box done at once and the mark is saved with the message;
      // if the message is refused the box goes back to open. Pressed again, the
      // box is done and nothing is sent. The message is found by identity in the
      // latest list (see onNoteDone).
      onDoIt={(box) => {
        const id = sessionId;
        const now = sessionRef.current.messages;
        const at = now.indexOf(t.parts[box.part]);
        const press = doItPress(now, at, box.note);
        if (!press.send) return;
        updateSession({ messages: press.messages });
        void send(DO_IT_MESSAGE, undefined, () => {}, press.messages).then((went) => {
          if (!went && openId.current === id) updateSession((s) => ({ messages: setNoteDone(s.messages, at, box.note, false) }));
        });
      }}
      // The box knows its message only as a place among the turn's assistant
      // messages (tool results sit between them in the session), so the
      // message is found by identity in the current list.
      onNoteDone={(box, done) =>
        updateSession((s) => {
          const at = s.messages.indexOf(t.parts[box.part]);
          return { messages: setNoteDone(s.messages, at, box.note, done) };
        })
      }
      todos={todos}
      onAddTodo={(text) => updateSession((s) => ({ todos: [...s.todos, ideaTodo(text, newId().slice(0, 8), Date.now())] }))}
      onMakePlan={(text) => send(planMessage(text), undefined, () => {})}
      onReply={planRunning ? undefined : (text) => setReplyTarget({ id: sessionId, text, n: Date.now() })}
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
          prompt={
            threadAsks[t.sessionId] && noteAskKind(threadAsks[t.sessionId].ask) === "answer" ? (
              <PendingPrompt ask={threadAsks[t.sessionId].ask} onDecide={threadAsks[t.sessionId].decide} onAlways={threadAsks[t.sessionId].always} />
            ) : undefined
          }
          needsYou={!!threadAsks[t.sessionId] && noteAskKind(threadAsks[t.sessionId].ask) === "open"}
          where={threadWhere[t.sessionId]}
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
                  result={runActive ? null : planResult(plan, messages)}
                  where={ownWhere}
                  running={runActive}
                  since={planRunning ? taskSince : null}
                  onPause={planRunning ? () => showFailure(stopRunner(sessionId)) : undefined}
                  counter={(since) => <Elapsed since={since} rate={streamRate} variant="caption" color="text.secondary" />}
                  onRun={runFromCard}
                  onChange={(steps) => updateSession({ plan: steps })}
                  proposal={planProposal}
                  onProposal={answerProposal}
                  details={stepTurns}
                  formatTime={formatSeconds}
                  onCancel={() => setConfirmCancelPlan(true)}
                  onClone={canClone ? () => clonePlan(plan, planContext, planSummary) : undefined}
                  prompt={
                    promptInPlan && shownPending ? (
                      <PendingPrompt ask={shownPending.ask} onDecide={shownPending.decide} onAlways={(k) => { shownPending.always(k); updateSession((s) => ({ autoApprove: { ...s.autoApprove, [k]: true } })); }} />
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
    updateSession((s) => ({ contextStart: s.messages.length, usage: null }));
    // The model reprocesses its history from here anyway, so this is the cheap
    // moment to bring the system prompt up to date: it names the working
    // directory as it is now, and the next reply's update lists the attachments.
    updateSession({ promptDir: undefined });
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
    if (action.kind === "fill") box.fill(action.text);
    else setPendingStart(action);
  };
  useEffect(() => {
    if (!pendingStart || !loaded || (pendingStart.sessionId && pendingStart.sessionId !== sessionId)) return;
    const action = settleStart(pendingStart, loadedOk.current, todosRef.current);
    if (action.kind === "fill") {
      setPendingStart(null);
      box.fill(action.text);
    } else if (action.boundary) {
      clearContext();
      setPendingStart({ ...action, boundary: false });
    } else {
      setPendingStart(null);
      send(action.text, undefined, () => {}).then((sent) => {
        if (!sent) box.fill(action.text);
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
      updateSession((s) => ({ messages: s.messages.slice(s.contextStart), contextStart: 0, usage: null }));
      // A cloned plan's place counts messages, so it moves with them. A plan
      // whose turn is removed goes to the top ("at:0"), where that turn was.
      const removed = new Set(messages.slice(0, contextStart).flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      const shift = (a: string | null) => {
        if (!a) return a;
        if (!a.startsWith("at:")) return removed.has(a) ? "at:0" : a;
        return `at:${Math.max(0, Number(a.slice(3)) - contextStart)}`;
      };
      updateSession((s) => ({
        planAnchor: shift(s.planAnchor),
        pastPlans: s.pastPlans.map((p) => ({ ...p, anchor: shift(p.anchor) })),
        threads: s.threads.map((t) => ({ ...t, anchor: shift(t.anchor) })),
      }));
      // Also update savedKey so we don't save again
      savedKey.current = "";
    }
  };

  return (
    <Box sx={{ display: "flex", height: "100dvh" }}>
      <SessionsPanel
        sessions={sessions}
        currentId={sessionId}
        open={drawerMode ? drawerOpen : sessionsOpen}
        narrow={drawerMode}
        busy={false}
        attention={attention}
        inProgress={inProgress}
        onSelect={(id) => id !== sessionId && openSession(id)}
        onNew={newChat}
        onNewNested={newNested}
        onDelete={removeSession}
        onRename={renameSessionLocal}
        onGroup={groupSessionLocal}
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
          maxWidth: "calc(100% - 1rem)",
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
            <Box sx={{ minWidth: 0, maxWidth: "10rem", display: narrow ? "none" : "block" }}>
              <Typography variant="h6" sx={{ lineHeight: 1.2 }} noWrap>
                Llama MUI
              </Typography>
            </Box>
            <TextField
              select
              size="small"
              // No visible label: the value says what it is. The name is for screen readers and hover.
              // Empty until the connections load, and when this chat's connection
              // was deleted: the user picks another, nothing is switched for them.
              value={connector?.id ?? ""}
              onChange={(e) => {
                if (e.target.value === MANAGE_CONNECTIONS) {
                  location.hash = "#/settings/connectors";
                  return;
                }
                if (e.target.value === connector?.id) return;
                // Kept as the last used one, so a new chat starts on it, and saved
                // with this chat. The models of the new connection are loaded by
                // the effect that follows the chat's connection, which picks the
                // model again (see pickModel).
                setSavedModelsConnectorId(e.target.value);
                setModels([]);
                setConnectorId(e.target.value);
              }}
              disabled={runActive}
              sx={{ width: narrow ? "100%" : 200 }}
              slotProps={{
                select: {
                  displayEmpty: true,
                  renderValue: () =>
                    connector ? (
                      connector.name || connector.kind
                    ) : (
                      <Typography component="span" color="text.secondary">
                        Choose a connection
                      </Typography>
                    ),
                  SelectDisplayProps: { "aria-label": "Connection", title: "Connection" },
                  MenuProps: MENU_PROPS,
                },
              }}
            >
              {(connectors ?? []).map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name || c.kind}
                </MenuItem>
              ))}
              {/* Its own value, since a Select item picks one (see onChange). */}
              <MenuItem value={MANAGE_CONNECTIONS} sx={manageItemSx}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }}>
                  <DnsOutlinedIcon fontSize="small" />
                  <span>Manage connections</span>
                </Stack>
              </MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              // No visible label: the value says what it is. The name is for screen readers and hover.
              // While the list is still loading, or the server can't be reached, the
              // chosen model isn't among the options: the menu then has no value (MUI
              // warns about one that isn't an option) and still shows the name.
              value={models.some((m) => m.id === model) ? model : ""}
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
                select: {
                  displayEmpty: true,
                  renderValue: () =>
                    model || (
                      <Typography component="span" color="text.secondary">
                        Choose a model
                      </Typography>
                    ),
                  SelectDisplayProps: { "aria-label": "Model", title: "Model" },
                  MenuProps: MENU_PROPS,
                },
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
                          <Box sx={{ width: "2.125rem", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <CircularProgress size="1rem" />
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
                          <Box sx={{ width: "2.125rem" }} />
                        )}
                      </Box>
                    )}
                  </Stack>
                </MenuItem>
              ))}
              {/* A Select item picks a value, so this one has its own (see onChange).
                  The icon is the Models page's, from Settings. */}
              <MenuItem value={MANAGE_MODELS} sx={manageItemSx}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "text.secondary" }}>
                  <ViewInArOutlinedIcon fontSize="small" />
                  <span>Manage models</span>
                </Stack>
              </MenuItem>
            </TextField>
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
        {!(drawerMode ? drawerOpen : sessionsOpen) && (
          <Tooltip title="New session">
            <span>
              <IconButton onClick={newChat}>
                <AddCommentIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title={(drawerMode ? drawerOpen : sessionsOpen) ? "Hide sessions" : "Show sessions"}>
          <IconButton onClick={() => (drawerMode ? setDrawerOpen(!drawerOpen) : setSessionsOpen(!sessionsOpen))}>
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


      {/* Top padding keeps the first messages clear of the toolbar. */}
      <Box ref={scrollRef} onScroll={onScroll} sx={{ flexGrow: 1, overflowY: "auto", pt: 9, pb: 3, position: "relative" }}>
        <Container maxWidth={false} ref={contentRef} sx={{ maxWidth: CHAT_MAX_WIDTH }}>
          <Stack spacing={2}>
            {connector === null ? (
              <Stack spacing={2} sx={{ alignItems: "center", mt: 8 }}>
                {(connectors ?? []).length === 0 ? (
                  <>
                    <Typography color="text.secondary">No llama server is set up yet.</Typography>
                    <Button variant="contained" onClick={onOpenSettings}>
                      Add one in Settings
                    </Button>
                  </>
                ) : (
                  // This chat's saved connection was deleted: nothing is switched
                  // for the user; they pick another in the Connection menu.
                  <Typography color="text.secondary" sx={{ textAlign: "center" }}>
                    This chat's connection no longer exists. Pick another one in the Connection menu.
                  </Typography>
                )}
              </Stack>
            ) : (
              // The session is still being read until `loaded`, so without it the
              // empty-chat screen would flash before the real messages.
              loaded && messages.length === 0 && (
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
              <PendingPrompt ask={shownPending.ask} onDecide={shownPending.decide} runKind={runnerView?.kind} onAlways={(k) => { shownPending.always(k); updateSession((s) => ({ autoApprove: { ...s.autoApprove, [k]: true } })); }} />
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
          <Box sx={{ position: "sticky", bottom: "1rem", height: 0, display: "flex", justifyContent: "center" }}>
            <Tooltip title="Jump to the latest and keep following">
              <Fab size="small" color="primary" onClick={toBottom} sx={{ mt: -5 }} aria-label="Jump to the latest">
                <KeyboardArrowDownIcon />
              </Fab>
            </Tooltip>
          </Box>
        )}
      </Box>

      <Paper square elevation={0} sx={{ py: 2, bgcolor: "transparent" }}>
        <Container maxWidth={false} sx={{ maxWidth: CHAT_MAX_WIDTH }}>
          {/* On a wide screen Enter sends and there is no Send button: the settings button
              and the box are centered beside the context meter. On a phone Send has the
              meter under it, the box is as tall as both, and the settings button is centered. */}
          <Stack direction="row" spacing={1} sx={{ alignItems: narrow ? "stretch" : "center" }}>
            <Box sx={{ height: "4.5rem", display: "flex", alignItems: "center", alignSelf: "flex-end" }}>
            <SessionSettings
              attachments={attachments}
              workingDir={workingDir}
              locked={attachmentsLocked}
              onAttach={attach}
              onDetach={(p) => changeAttachments((as) => as.filter((x) => x.path !== p))}
              onSetWorkingDir={changeWorkingDir}
              checkCommands={toolContext.checkCommands}
              autoApprove={autoApprove}
              onAutoApprove={changeAutoApprove}
              onSetCheckCommand={(folder, command) =>
                setCheckCommand(folder, command)
                  .then(() => setContextVersion((v) => v + 1))
                  .catch((e) => showGlobalError(e.message))
              }
            />
            </Box>
            <Composer
              tall={narrow}
              sendButton={narrow}
              box={box}
              placeholder={
                planRunning
                  ? tellPlan
                    ? narrow
                      ? "Message the plan"
                      : "Message the running plan: the next step will see it (Enter to send)"
                    : narrow
                      ? "Ask a side question"
                      : "Ask a side question: the plan goes on and won't see it (Enter to send)"
                  : turnRunning && !narrow
                    ? "Replying… press Esc to stop"
                    : narrow
                    ? "Message"
                    : "Message (Enter to send, Shift+Enter for a new line)"
              }
              onSend={send}
              onEditLast={editLast}
              editing={stillEditing}
              onCancelEdit={() => setEditing(null)}
              reply={pendingReply}
              onCancelReply={() => setReplyTarget(null)}
              // Stop here is for a reply that is streaming, on a phone (Escape does it
              // elsewhere). A plan run is paused from its card, and the box keeps Send
              // for messages to it.
              onStop={
                turnRunning && narrow ? () => showFailure(stopRunner(sessionId)) : undefined
              }
              disabled={!model && !planRunning}
              planRunning={planRunning}
              tellPlan={tellPlan}
              onTellPlan={setTellPlan}
              // Stops only the side question being answered; the plan goes on.
              onStopAside={asideRunning ? () => showFailure(stopAside(sessionId)) : undefined}
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

// The message box and Send (Stop while a reply runs). What's typed lives in
// the chat's message box store (messageBox.ts), which only this and the Edit
// buttons read: kept in Chat's state, every keystroke redrew the whole chat,
// about 100 ms each in a 300-message one.
function Composer({
  box,
  placeholder,
  onSend,
  onEditLast,
  editing,
  onCancelEdit,
  onStop,
  disabled,
  below,
  tall = false,
  sendButton = true,
  planRunning,
  tellPlan,
  onTellPlan,
  onStopAside,
  reply,
  onCancelReply,
}: {
  // The response the message replies to: a card above the box shows its first
  // lines, and a new `n` focuses the box. Closing the card calls onCancelReply.
  reply?: { text: string; n: number } | null;
  onCancelReply?: () => void;
  // The box is as tall as the Send column beside it (Send with the meter under it).
  tall?: boolean;
  // Whether to show the Send button. Enter sends either way; on a wide screen the box goes without it.
  sendButton?: boolean;
  // What is in the box, and the chat whose draft it is (see messageBox.ts).
  // The chat puts text in it with box.fill, and the box then takes focus.
  box: MessageBox;
  placeholder: string;
  // Resolves to whether the message went. `accepted` is called as soon as the
  // send is certain to start (never for a refused one), so the box can clear
  // before the server has answered; a false result then means it failed.
  onSend: (text: string, images: PendingImage[] | undefined, accepted: () => void) => Promise<boolean>;
  // The up arrow in an empty box: puts the last message you sent in the box to
  // edit. Returns whether there was one to take.
  onEditLast: () => boolean;
  // Whether the box holds your last message to replace, and how to give that
  // up (the box is emptied here, Chat forgets the edit).
  editing: boolean;
  onCancelEdit: () => void;
  onStop?: () => void;
  disabled: boolean;
  // Whether a plan is running (attach button disabled with explanation).
  planRunning: boolean;
  // While a plan runs: whether a message goes to the plan (Tell the plan) or is
  // a side question (Ask, the default), and the switch between them.
  tellPlan: boolean;
  onTellPlan: (tell: boolean) => void;
  // While a side question is being answered: ends it, and only it. The box
  // stays usable meanwhile.
  onStopAside?: () => void;
  // Under Send: the context indicator.
  below: ReactNode;
}) {
  // The box's text and images. Opening another chat shows its draft (the chat
  // tells the store), and every change of the text is kept as that chat's
  // draft, so a refresh brings it back.
  const { text, images: pendingImages } = useSyncExternalStore(box.subscribe, box.get);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Visual cue when a file is being dragged over the composer.
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Text the chat puts in the box (Edit, the up arrow, a suggestion) is for
  // changing, so the cursor goes there.
  useEffect(() => box.onFill(() => inputRef.current?.focus()), [box]);
  // Replying to a response puts the cursor in the box.
  useEffect(() => {
    if (reply) inputRef.current?.focus();
  }, [reply?.n]);
  // From the tap until the message has gone (or been refused): the button shows
  // it, and a second tap or Enter doesn't send the text again. The box clears
  // as soon as the send is accepted, and gets the text back if it fails.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // Drop/paste helpers: validate, resize, store; revoke on remove.
  const addImages = useCallback(async (files: FileList) => {
    const images: PendingImage[] = [];
    for (const file of Array.from(files)) {
      if (!isImageFile(file)) continue;
      try {
        const { blob, preview } = await prepareImage(file);
        images.push({ blob, preview, name: file.name });
      } catch {
        // unsupported type – silently skip
      }
    }
    if (images.length) box.setImages([...box.get().images, ...images]);
  }, [box]);
  const removeImage = useCallback((index: number) => {
    const next = [...box.get().images];
    revokePreview(next[index].preview);
    next.splice(index, 1);
    box.setImages(next);
  }, [box]);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
    },
    [addImages],
  );
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.clipboardData.files.length) addImages(e.clipboardData.files);
    },
    [addImages],
  );
  const send = async () => {
    const t = text.trim();
    if (!t && !pendingImages.length) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const sentFrom = box.sessionId();
    const sentImages = pendingImages;
    try {
      // The box empties as soon as the send is accepted, without waiting for
      // the server. Previews stay alive until the outcome is known, so a
      // refused send can put them back (see submitDraft).
      await submitDraft({
        text: t,
        images: sentImages,
        stillShown: () => box.sessionId() === sentFrom,
        send: (accepted) => onSend(t, sentImages.length ? sentImages : undefined, accepted),
        // setTextFor changes only the draft when another chat was opened
        // meanwhile, so that chat's box is left alone.
        clear: () => {
          box.setTextFor(sentFrom, "");
          box.setImages([]);
        },
        restore: () => {
          box.setTextFor(sentFrom, text);
          box.setImages(sentImages);
        },
        // It went: that chat's draft is gone, the previews are revoked, and the
        // box is cleared unless another chat was opened meanwhile.
        done: () => {
          sentImages.forEach((img) => revokePreview(img.preview));
          box.setImages([]);
          box.setTextFor(sentFrom, "");
        },
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  // Gives up editing the last message: the box is emptied, nothing is sent.
  const cancelEdit = () => {
    onCancelEdit();
    box.setText("");
    pendingImages.forEach((img) => revokePreview(img.preview));
    box.setImages([]);
  };
  return (
    <Stack
      direction="column"
      // No spacing: Stack puts it above every child after the first, the hidden file input included, which pushed the row down.
      sx={{
        flexGrow: 1,
        alignItems: "stretch",
        // An outline takes no room, so the box keeps its size and place when a file is dragged over it.
        outline: dragOver ? "2px dashed" : "none",
        outlineColor: (t) => t.palette.primary.main,
        outlineOffset: "-2px",
        borderRadius: 1,
      }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onPaste={onPaste}
    >
      {/* While your last message is in the box to replace: says so, with a way out. */}
      {editing && (
        <Stack direction="row" sx={{ alignItems: "center", alignSelf: "flex-start", mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Editing your last message
          </Typography>
          <IconButton
            size="small"
            aria-label="Cancel editing"
            title="Cancel editing (Esc)"
            onClick={cancelEdit}
            disabled={sending}
            sx={{ ml: 0.5, p: 0.25, color: "text.secondary" }}
          >
            <CloseIcon fontSize="inherit" />
          </IconButton>
        </Stack>
      )}
      {/* The response being replied to: its first lines, with a close button. */}
      {reply && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ alignItems: "flex-start", mb: 0.5, pl: 1, borderLeft: "3px solid", borderColor: "primary.main", color: "text.secondary" }}
        >
          <ReplyOutlinedIcon fontSize="small" sx={{ mt: 0.25, flexShrink: 0 }} />
          <Typography
            variant="body2"
            title="The response you are replying to"
            sx={{
              flexGrow: 1,
              minWidth: 0,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
              overflow: "hidden",
              maxHeight: "4.5rem",
            }}
          >
            {reply.text}
          </Typography>
          <IconButton aria-label="Cancel reply" size="small" onClick={onCancelReply} sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      )}
      {/* Image preview row: hidden when there are no pending images. */}
      {pendingImages.length > 0 && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            flexWrap: "wrap",
            gap: 0.5,
            mb: 0.5,
          }}
        >
          {pendingImages.map((img, i) => (
            <Box
              key={img.preview}
              sx={{
                position: "relative",
                width: "5rem",
                height: "5rem",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 0.5,
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <img
                src={img.preview}
                alt={img.name}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <IconButton
                size="small"
                onClick={() => removeImage(i)}
                sx={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  bgcolor: "background.paper",
                  "&:hover": { bgcolor: "background.paper" },
                  p: 0,
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </Stack>
      )}
      {/* Hidden file picker, triggered by the attach button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) addImages(e.target.files);
          e.target.value = "";
        }}
      />
      {/* While a plan runs: where the message goes. */}
      {planRunning && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={tellPlan ? "tell" : "ask"}
          onChange={(_, v: "ask" | "tell" | null) => v && onTellPlan(v === "tell")}
          aria-label="Where the message goes"
          sx={{ alignSelf: "flex-start", mb: 0.5, "& .MuiToggleButton-root": { py: 0, px: 1, textTransform: "none", fontSize: "0.75rem" } }}
        >
          <ToggleButton value="ask" title="A side question: answered now, beside the plan, which never sees it. It can only read.">
            Ask
          </ToggleButton>
          <ToggleButton value="tell" title="A message to the plan: the next step sees it.">
            Tell the plan
          </ToggleButton>
        </ToggleButtonGroup>
      )}
      {/* Main row: TextField + icons column. */}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          flexGrow: 1,
          alignItems: "flex-end",
        }}
      >
        <TextField
          fullWidth
          multiline
          size="small"
          maxRows={8}
          sx={tall ? { alignSelf: "stretch", "& .MuiInputBase-root": { flexGrow: 1, alignItems: "flex-start" } } : undefined}
          placeholder={placeholder}
          inputRef={inputRef}
          value={text}
          slotProps={{ htmlInput: { readOnly: sending } }}
          onChange={(e) => box.setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends where there is no Send button (a wide screen). With the button
            // (a phone, whose keyboard has no Shift) Enter starts a new line.
            if (e.key === "Enter" && !e.shiftKey && !sendButton) {
              e.preventDefault();
              send();
            }
            // Esc while editing the last message gives the edit up. Used here, so
            // the window-level Esc handlers (stop a reply) see it as handled; when
            // not editing it is left alone and still stops a running reply.
            if (e.key === "Escape" && editing && !sending && !e.nativeEvent.isComposing) {
              e.preventDefault();
              cancelEdit();
              return;
            }
            // Up arrow in an empty box takes the last message back to edit. With
            // anything in the box, or a modifier held, it moves the caret as usual.
            if (
              e.key === "ArrowUp" &&
              !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
              !e.nativeEvent.isComposing &&
              text === "" && !pendingImages.length && !sending
            ) {
              if (onEditLast()) e.preventDefault();
            }
          }}
        />
        {/* Send lines up with the input's top edge; the context
            indicator sits just below it. */}
        <Stack spacing={0.5} sx={{ flexShrink: 0, alignItems: "center" }}>
          {/* Attach images. Not while a plan runs: a message to it is text only. */}
          <Tooltip title={planRunning ? "Images can't be attached while a plan is running" : "Attach images"}>
            <span>
              <IconButton
                aria-label="Attach images"
                onClick={() => fileInputRef.current?.click()}
                disabled={planRunning || disabled || sending}
                sx={{ color: "text.secondary" }}
              >
                <AttachFileIcon />
              </IconButton>
            </span>
          </Tooltip>
          {/* Icons, with the words as tooltip and accessible label. */}
          {!onStop && sendButton && (
            <Tooltip title="Send">
              <span>
                <IconButton
                  aria-label={sending ? "Sending" : "Send"}
                  aria-busy={sending}
                  onClick={send}
                  disabled={(!text.trim() && !pendingImages.length) || disabled || sending}
                  sx={{
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    "&:hover": { bgcolor: "primary.dark" },
                    // Busy keeps the button's colour, so it reads as working, not as unavailable.
                    "&.Mui-disabled": sending
                      ? { bgcolor: "primary.main", color: "primary.contrastText" }
                      : { bgcolor: "action.disabledBackground", color: "action.disabled" },
                  }}
                >
                  {sending ? <CircularProgress size="1.5rem" color="inherit" /> : <SendIcon />}
                </IconButton>
              </span>
            </Tooltip>
          )}
          {onStopAside && (
            <Tooltip title="Stop the side question (the plan goes on)">
              <IconButton
                aria-label="Stop the side question"
                onClick={onStopAside}
                sx={{ border: 1, borderColor: "error.main", color: "error.main", "&:hover": { bgcolor: "action.hover" } }}
              >
                <StopIcon />
              </IconButton>
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
      </Stack>
    </Stack>
  );
}

// How each kind of note under a reply looks. Keyed by the kind's id, so a kind
// added to the table (replyNoteKinds.ts) does not compile until it has a style.
// Which boxes show, their labels and the Do it button come from the helper in
// agent/replyNotes.ts.
const NOTE_STYLES: Record<NoteKindId, { icon?: ReactNode; label: SxProps<Theme>; text: SxProps<Theme> }> = {
  // A lightbulb in the info colour and text at full strength. The box itself
  // is drawn by the Panel (Panel.tsx).
  idea: {
    icon: <LightbulbOutlinedIcon sx={{ mt: 0.125, flexShrink: 0, color: "info.main" }} />,
    label: { fontWeight: 700, color: "info.main" },
    text: {},
  },
  // Loud: warning-coloured bold label; the text under it is regular weight.
  action: {
    label: { fontWeight: 700, color: "warning.main" },
    text: {},
  },
};

// A box the user marked done looks the same whatever its kind: the shared done
// mark (StatusMark.tsx, the one "done" look in the UI), a bold label in the normal
// text colour, and muted text. The box itself stays the quiet grey of the Panel.
const DONE_STYLE: { icon: ReactNode; label: SxProps<Theme>; text: SxProps<Theme> } = {
  icon: <StatusIcon kind="done" fontSize="small" sx={{ flexShrink: 0 }} />,
  label: { fontWeight: 700 },
  text: { color: "text.secondary" },
};

// The Edit button on a message you sent. It follows only whether the message
// box is empty, by itself, so typing updates these buttons only when the box
// goes from empty to typed or back, and not every message in the chat.
function EditButton({ onEdit, box }: { onEdit: () => void; box: MessageBox }) {
  const empty = useSyncExternalStore(box.subscribe, box.isEmpty);
  return (
    <PanelButton
      label={empty ? "Edit" : "Edit: the message box must be empty"}
      icon={<EditOutlinedIcon />}
      onClick={onEdit}
      disabled={!empty}
    />
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
  showModelName,
  failed,
  connectorName,
  onResend,
  resendDisabled,
  onEdit,
  box,
  since,
  rate,
  sessionId,
  replyRunning,
  onDoIt,
  onNoteDone,
  todos,
  onAddTodo,
  onMakePlan,
  onReply,
}: {
  // Reply to this response: its text becomes the quote above the next message.
  onReply?: (text: string) => void;
  parts: ChatMessage[];
  streaming: boolean;
  toolResults: Map<string, ChatMessage>;
  // Above a Clear context divider: shown dimmed since the model can't see it.
  forgotten: boolean;
  // Off: only the answer text shows, no thinking or tool calls (Settings → Chat).
  showSteps: boolean;
  // Off: messages show as typed, Markdown symbols and all (Settings → Chat).
  renderMarkdown: boolean;
  // Off: the line under a reply leaves out the model's name (Settings → Chat).
  showModelName: boolean;
  // Error message for the last user message in this turn.
  failed?: string | null;
  // Who answered the failed request, named in its error line.
  connectorName?: string;
  // Callback for resending the last user message.
  onResend?: () => void;
  // Disabled state for the resend button.
  resendDisabled?: boolean;
  // Edit button on a message you sent (not a side question): takes its text
  // back into the message box. Disabled while the box has something in it.
  onEdit?: () => void;
  box: MessageBox;
  // While this reply streams: when the task started, for the counter beside
  // the waiting dots, and how fast the current round is streaming.
  since?: number | null;
  rate?: { current: StreamRate };
  // Session id, for building image URLs.
  sessionId?: string;
  // Whether any reply is streaming (the Do it button waits), and what the
  // button does: send "yes, go ahead" as the next message.
  replyRunning?: boolean;
  onDoIt?: (box: NoteBox) => void;
  // Mark a box done, or open again (Mark done / Reopen). Waits while a reply
  // runs, like the buttons above.
  onNoteDone?: (box: NoteBox, done: boolean) => void;
  // The session's todos (an idea already added shows "Added"), and what the
  // idea buttons do: add the idea as a todo, or send "Make a plan for this: …".
  // Both wait while a reply runs, since the server owns the session then and
  // would replace a todo added meanwhile.
  todos?: Todo[];
  onAddTodo?: (text: string) => void;
  onMakePlan?: (text: string) => void;
}) {
  // This message's own choice of formatted or raw text; null follows
  // Settings → Chat. Declared before the early return below, as hooks must be.
  const [override, setOverride] = useState<boolean | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // A long message of yours: whether it is unfolded, and whether it is tall
  // enough to fold at all (see FoldedMessage). The button for it sits in the
  // row under the message, with the formatted/raw toggle.
  const [unfolded, setUnfolded] = useState(false);
  const [tooTall, setTooTall] = useState(false);
  const showMarkdown = override ?? renderMarkdown;
  // Image preview dialog for user message thumbnails.
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  // The finished reply's time and speed, kept on its last message.
  const took = [...parts].reverse().find((m) => m.took)?.took;
  // The model that wrote the reply (its last turn, if it changed midway).
  const modelName = showModelName
    ? [...parts].reverse().find((m) => m.role === "assistant" && m.model)?.model
    : undefined;
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

  // Ideas and action items under a finished reply (never while it streams).
  const notes = !isUser && !streaming ? noteBoxes(parts) : [];
  if (!isUser && !showSteps && !waiting && !parts.some((m) => m.content) && !notes.length) return null;
  const hasError = !!failed;
  const errorLine = failed && (
    <Stack spacing={0.5} sx={{ alignItems: isUser ? "flex-end" : "flex-start", mt: 0.5, flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <StatusIcon kind="failed" fontSize="small" />
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
  // A side question or its answer (asked while a plan ran; the plan never saw
  // it): labelled, and quieter than the chat's own messages.
  const isAside = !!parts[0].aside;
  // The small buttons on the top edge of a message you sent (shown on hover):
  // what was sent unseen, and formatted/raw. None while it streams or is empty.
  const userActions =
    isUser && !streaming && parts.some((m) => m.content) ? (
      <>
        <PanelButton
          label="Copy"
          icon={<ContentCopyOutlinedIcon />}
          onClick={() =>
            void copyText(
              parts
                .map((m) => m.content)
                .filter(Boolean)
                .join("\n\n"),
            )
          }
        />
        {onEdit && !isAside && <EditButton onEdit={onEdit} box={box} />}
        {hidden && (
          <PanelButton
            label={showHidden ? "Hide what was sent with this message" : "Show what was sent with this message, unseen"}
            icon={<StickyNote2OutlinedIcon />}
            onClick={() => setShowHidden(!showHidden)}
            pressed={showHidden}
          />
        )}
        <PanelButton
          label={showMarkdown ? "Show raw text" : "Show formatted"}
          icon={<CodeOutlinedIcon />}
          onClick={() => setOverride(!showMarkdown)}
          pressed={!showMarkdown}
        />
      </>
    ) : undefined;
  // The small buttons on the top edge of the model's reply (shown on hover):
  // Copy for now. None while it streams or when it has no text.
  const replyText = parts
    .map((m) => m.content)
    .filter(Boolean)
    .join("\n\n");
  const replyTools =
    !isUser && !streaming && parts.some((m) => m.content) ? (
      <>
        <PanelButton label="Copy" icon={<ContentCopyOutlinedIcon />} onClick={() => void copyText(replyText)} />
        {/* Reply: the whole response becomes the quote of the next message. Not for a side question's answer. */}
        {onReply && !isAside && <PanelButton label="Reply" icon={<ReplyOutlinedIcon />} onClick={() => onReply(replyText)} />}
      </>
    ) : undefined;
  // What goes inside the card, for a message you sent and for a reply alike.
  const content = (
    <Stack
      spacing={isUser ? 1 : 0}
      sx={
        isUser
          ? undefined
          : {
              // Everything that isn't a step row is text (the reply, the dots,
              // the buttons under it): no side padding, a little above and below.
              "& > :not(.MuiAccordion-root)": { px: 0, py: 0.5 },
              // Text right under a step row gets more room above it.
              // A line above it closes the list, so a reply with no text ends
              // with its last row and nothing under it.
              "& > .MuiAccordion-root + :not(.MuiAccordion-root)": { pt: 2, borderTop: 1, borderColor: "divider" },
              "& > :not(.MuiAccordion-root):first-child": { pt: 0 },
              "& > :not(.MuiAccordion-root):last-child": { pb: 0 },
            }
      }
    >
      {/* The response this message replies to: a quiet quote above your text, kept for the history. Never part of raw/formatted or Copy. */}
      {isUser && parts[0].replyTo?.text && (
        <Typography
          variant="body2"
          title="The response this message replies to"
          sx={{
            pl: 1,
            borderLeft: "3px solid",
            borderColor: "currentColor",
            opacity: 0.75,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 4,
            overflow: "hidden",
            maxHeight: "6rem",
          }}
        >
          {parts[0].replyTo.text}
        </Typography>
      )}
      {parts.map((m, i) => (
        <Fragment key={i}>
          {showSteps && m.reasoning && (
            <Accordion disableGutters elevation={0} sx={flatAccordionSx}>
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
            (() => {
              const body = !showMarkdown ? (
                <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</Typography>
              ) : m.role === "assistant" ? (
                <MarkdownRenderer content={m.content} />
              ) : (
                <MarkdownRenderer content={m.content} breaks />
              );
              // Replies always show in full; a long message of yours folds.
              return isUser ? (
                <FoldedMessage open={unfolded} onTooTall={setTooTall}>
                  {body}
                </FoldedMessage>
              ) : (
                body
              );
            })()}
          {/* Image thumbnails for user messages: outside FoldedMessage, below text. */}
          {isUser && parts[0].images && parts[0].images.length > 0 && sessionId && (
            <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
              {parts[0].images.map((img) => (
                <Box
                  component="img"
                  key={img.id}
                  src={`/api/sessions/${sessionId}/images/${img.id}`}
                  alt={img.mediaType}
                  onClick={() => setSelectedImage(`/api/sessions/${sessionId}/images/${img.id}`)}
                  sx={{
                    width: "6rem",
                    height: "6rem",
                    objectFit: "cover",
                    borderRadius: 0.5,
                    cursor: "pointer",
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                />
              ))}
            </Stack>
          )}
          {showSteps &&
            shownCalls(m.toolCalls).map((c) => (
              <ToolCallView key={c.id} call={c} result={toolResults.get(c.id)} stopped={!streaming} />
            ))}
        </Fragment>
      ))}
      {notes.map((box, i) => (
        // The Panel is spaced by the reply card's rule for non-step
        // children; its look comes from the Panel's table of styles. The
        // small icon buttons sit in its top right corner, shown on hover
        // or focus (always where there is no hover).
        <Panel
          key={`note-${i}`}
          variant={box.done && box.kind === "action" ? "actionDone" : box.kind}
          tools={<PanelButton label="Copy" icon={<ContentCopyOutlinedIcon />} onClick={() => void copyText(box.text)} />}
          actions={
            box.done ? (
              // Done: only a way back; Do it and the idea buttons are gone.
              <PanelAction
                label="Reopen"
                variant="outlined"
                color="inherit"
                onClick={() => onNoteDone?.(box, false)}
                disabled={doItDisabled(!!replyRunning)}
              />
            ) : offersOf(box).length > 0 || hasDoIt(box) || hasDone(box.kind) ? (
              <>
                {offersOf(box).includes("todo") &&
                  (() => {
                    const added = todoAdded(todos ?? [], box.text);
                    return (
                      <PanelAction
                        label={added ? "Added" : "Add to todos"}
                        variant="contained"
                        color="primary"
                        onClick={() => onAddTodo?.(box.text)}
                        disabled={added || doItDisabled(!!replyRunning)}
                      />
                    );
                  })()}
                {offersOf(box).includes("plan") && (
                  <PanelAction
                    label="Make plan"
                    variant="outlined"
                    onClick={() => onMakePlan?.(box.text)}
                    disabled={doItDisabled(!!replyRunning)}
                  />
                )}
                {hasDoIt(box) && (
                  <PanelAction
                    label="Do it"
                    variant="contained"
                    color="warning"
                    onClick={() => onDoIt?.(box)}
                    disabled={doItDisabled(!!replyRunning)}
                  />
                )}
                {hasDone(box.kind) && (
                  <PanelAction
                    label="Mark done"
                    variant="outlined"
                    color="inherit"
                    onClick={() => onNoteDone?.(box, true)}
                    disabled={doItDisabled(!!replyRunning)}
                  />
                )}
              </>
            ) : undefined
          }
        >
          {/* The title on one line with its icon, the text under it. The panel's
              own gap is a little big between the two, so the header pulls up. */}
          <Box sx={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 0.75, mb: -0.5 }}>
            {(box.done ? DONE_STYLE : NOTE_STYLES[box.kind]).icon}
            <Typography variant="body1" sx={(box.done ? DONE_STYLE : NOTE_STYLES[box.kind]).label}>
              {box.done ? `${noteLabel(box)} · done` : noteLabel(box)}
            </Typography>
          </Box>
          <Box sx={{ flexBasis: "100%", minWidth: 0 }}>
            <Typography variant="body1" sx={{ overflowWrap: "anywhere", ...(box.done ? DONE_STYLE : NOTE_STYLES[box.kind]).text }}>
              {box.text}
            </Typography>
          </Box>
        </Panel>
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
      {!streaming && parts.some((m) => m.content) && (!isUser || tooTall) && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 1, ...(isUser && { mb: -1, mr: -1 }) }}>
          {isUser && tooTall && (
            <Button size="small" onClick={() => setUnfolded(!unfolded)} aria-expanded={unfolded} sx={{ mr: "auto", ml: -1 }}>
              {unfolded ? "Show less" : "Show all"}
            </Button>
          )}
          {!isUser && hidden && (
            <Tooltip title={showHidden ? "Hide what was sent with this message" : "Show what was sent with this message, unseen"}>
              <IconButton
                size="small"
                onClick={() => setShowHidden(!showHidden)}
                aria-pressed={showHidden}
                sx={{ color: "text.secondary" }}
              >
                <StickyNote2OutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {(took || modelName) && (
            <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {modelName}
              {modelName && took ? " · " : ""}
              {took ? formatSeconds(took.ms) : ""}
              {took?.clientTps ? ` · ${Math.round(took.clientTps)} tps (client)` : ""}
              {took?.serverTps ? ` · ${Math.round(took.serverTps)} tps (server)` : ""}
            </Typography>
          )}
          {!isUser && (
            <Tooltip title={showMarkdown ? "Show raw text" : "Show formatted"}>
              <IconButton
                size="small"
                onClick={() => setOverride(!showMarkdown)}
                aria-pressed={!showMarkdown}
                sx={{ color: "text.secondary" }}
              >
                <CodeOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}
    </Stack>
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 1, opacity: forgotten ? 0.5 : isAside ? 0.85 : 1 }}>
      {isAside && (
        <Typography variant="caption" color="text.secondary" sx={{ mb: -0.5 }}>
          Side question
        </Typography>
      )}
      {isUser ? (
        // What you typed: drawn by the Panel, which owns its look and its
        // hover toolbar (Panel.tsx).
        <Panel variant={isAside ? "messageAside" : "message"} error={hasError} tools={userActions}>
          {content}
        </Panel>
      ) : (
        // The model's reply: drawn by the Panel too, with its own look from the
        // table and a hover toolbar (Copy for now; more tools will join it).
        <Panel variant={isAside ? "replyAside" : "reply"} error={hasError} tools={replyTools}>
          {content}
        </Panel>
      )}
      {/* A message sent to a running plan: which step saw it. */}
      {isUser && (parts[0].seenByStep || parts[0].notSeen) && (
        <Typography variant="caption" color="text.secondary">
          {parts[0].seenByStep ? `Seen by step ${parts[0].seenByStep}` : "No step saw this: the plan ended first"}
        </Typography>
      )}
      {errorLine}
      {/* Full-size image preview dialog. */}
      <Dialog open={!!selectedImage} onClose={() => setSelectedImage(null)} maxWidth={false}>
        <DialogContent sx={{ p: 0 }}>
          {selectedImage && (
            <img
              src={selectedImage}
              alt="Full size"
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}

// The one control for how wide the chat reads: the widest the messages and the
// input box get; on a wider screen they stay centered at this width. Text,
// code and tables all fill it, so this decides how long a line gets. Long lines
// are hard to follow, as the eye loses its place jumping to the next line. It
// is 90ch plus the container's side padding (1.5rem each side). A "ch" is the
// width of a "0" and follows the font size; prose letters are narrower, so
// 90ch holds about 98 characters of ordinary text.
const CHAT_MAX_WIDTH = "calc(90ch + 3rem)";

// Flat, compact look shared by the tool-call and reasoning accordions: no
// fill, a hairline between rows, a short summary row.
const flatAccordionSx = {
  bgcolor: "transparent",
  borderTop: 1,
  borderColor: "divider",
  // The reply's Stack puts a top margin on each sibling; the doubled selector
  // wins over it so the rows sit flush, divided only by the hairline.
  "&&": { mt: 0 },
  "&:before": { display: "none" },
  // The first row sits against the card's top, and needs no hairline above it:
  // the card's own border is there.
  "&:first-of-type": { borderTop: 0 },
  "& .MuiAccordionSummary-root": { minHeight: "1.75rem", px: 1, py: 0 },
  "& .MuiAccordionSummary-root.Mui-expanded": { minHeight: "1.75rem" },
  "& .MuiAccordionSummary-content": { my: 0.25 },
  "& .MuiAccordionSummary-content.Mui-expanded": { my: 0.25 },
  "& .MuiAccordionSummary-expandIconWrapper .MuiSvgIcon-root": { fontSize: "1.25rem" },
  "& .MuiAccordionDetails-root": { px: 1, pt: 0.5, pb: 1 },
} as const;

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
      sx={flatAccordionSx}
    >
      {/* minWidth 0 down the flex chain lets a long title shrink instead of
          widening the reply. */}
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ "& .MuiAccordionSummary-content": { minWidth: 0 } }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          {result === undefined && !stopped ? (
            <CircularProgress size="0.875rem" sx={{ flexShrink: 0 }} />
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
          sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "18.75rem", overflowY: "auto" }}
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
function PendingPrompt({ ask, onDecide, onAlways, runKind }: { ask: Ask; onDecide: (answer: Answer) => void; onAlways?: (kind: AutoKind) => void; runKind?: string | null }) {
  if ("needsApproval" in ask) {
    return <ApprovalPrompt approval={ask.needsApproval} onDecide={onDecide} onAlways={onAlways} canMakePlan={canMakePlan(ask.needsApproval.type, runKind)} />;
  }
  if ("needsLocation" in ask) {
    const { description, kind, canSetWorkingDir } = ask.needsLocation;
    return (
      <FindPrompt
        heading={`The model needs you to find this ${kind}:`}
        subject={description}
        isPath={false}
        icon={<TravelExploreIcon fontSize="small" />}
        kinds={kind === "file" ? ["file", "folder"] : ["folder", "file"]}
        canSetWorkingDir={canSetWorkingDir}
        onDecide={onDecide}
        canMakePlan={canMakePlan("location", runKind)}
      />
    );
  }
  const { path, kind } = ask.needsAccess;
  if (kind) return <AccessPrompt target={{ path, kind }} onDecide={onDecide} canMakePlan={canMakePlan("access", runKind)} />;
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
      canMakePlan={canMakePlan("access", runKind)}
    />
  );
}

// Shown while a reply waits: the model asked for a path that exists but
// isn't attached. Allowing attaches it for the rest of the chat.
function AccessPrompt({ target, onDecide, canMakePlan: offerPlan }: { target: AttachmentTarget; onDecide: (answer: Answer) => void; canMakePlan?: boolean }) {
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
        {offerPlan && <MakePlanButton title="Don't give access now; the model turns it into a plan to review and run" onClick={() => onDecide("plan")} />}
      </Stack>
    </Alert>
  );
}

// "Make plan", the third answer to a prompt in a chat reply: do nothing now,
// and the model turns the work into a plan.
function MakePlanButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <Tooltip title={title}>
      <Button size="small" variant="outlined" onClick={onClick}>
        Make plan
      </Button>
    </Tooltip>
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
  canSetWorkingDir = false,
  onDecide,
  canMakePlan: offerPlan = false,
}: {
  heading: string;
  subject: string;
  // The subject is a path (monospace) rather than a description.
  isPath: boolean;
  icon: ReactNode;
  // Which pick buttons to offer, the likelier first.
  kinds: AttachmentTarget["kind"][];
  // The chat has no working directory, so a folder chosen here can become it.
  canSetWorkingDir?: boolean;
  onDecide: (answer: Answer) => void;
  // Offers Make plan (a chat reply only; see canMakePlan in approvalWhy.ts).
  canMakePlan?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [asWorkingDir, setAsWorkingDir] = useState(true);
  // What the checkbox says goes with a chosen folder; a file is just attached.
  const decide = (picked: AttachmentTarget[]) =>
    onDecide(canSetWorkingDir && asWorkingDir ? picked.map((p) => (p.kind === "folder" ? { ...p, asWorkingDir: true } : p)) : picked);
  const [error, setError] = useState<string | null>(null);
  // The folders chosen lately, the same list Session settings offers, when a
  // folder is what's wanted. Choosing one answers the prompt.
  const [recent, setRecent] = useState<string[]>([]);
  const wantsFolder = kinds[0] === "folder";
  useEffect(() => {
    if (!wantsFolder) return;
    let current = true;
    getRecentFolders()
      .then((r) => current && setRecent(r.folders))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [wantsFolder]);
  // Cancelling the dialog leaves the prompt up.
  const pick = (kind: AttachmentTarget["kind"]) => {
    setPicking(true);
    setError(null);
    pickAttachments(kind)
      .then((picked) => picked.length && decide(picked))
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
        {canSetWorkingDir && asWorkingDir
          ? "Choose a folder and it becomes this session's working directory; the model then uses that path."
          : "Choose it and it's attached to this session; the model then uses that path."}
      </Typography>
      {canSetWorkingDir && (
        <FormControlLabel
          sx={{ display: "flex", mt: 0.5 }}
          control={<Checkbox size="small" checked={asWorkingDir} onChange={(e) => setAsWorkingDir(e.target.checked)} />}
          label={<Typography variant="body2">Make it the working directory</Typography>}
        />
      )}
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
        {offerPlan && <MakePlanButton title="Don't pick it now; the model turns it into a plan to review and run" onClick={() => onDecide("plan")} />}
        {picking && <CircularProgress size="1.125rem" />}
      </Stack>
      {wantsFolder && recent.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <RecentFolders folders={recent} disabled={picking} onChoose={(path) => decide([{ path, kind: "folder" }])} />
        </Box>
      )}
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
function ApprovalPrompt({ approval, onDecide, onAlways, canMakePlan: offerPlan }: { approval: Approval; onDecide: (answer: Answer) => void; onAlways?: (kind: AutoKind) => void; canMakePlan?: boolean }) {
  const isCommand = approval.type === "command";
  const why = approvalWhy(approval.reason);
  return (
    <Alert
      severity={isCommand ? "warning" : "info"}
      icon={
        isCommand ? (
          <TerminalOutlinedIcon fontSize="small" />
        ) : approval.type === "worktree" ? (
          <AccountTreeOutlinedIcon fontSize="small" />
        ) : approval.type === "page" ? (
          <PublicOutlinedIcon fontSize="small" />
        ) : (
          <EditOutlinedIcon fontSize="small" />
        )
      }
      sx={{ "& .MuiAlert-message": { minWidth: 0, flexGrow: 1 } }}
    >
      <Typography variant="body2" color={why.missing ? "text.secondary" : "text.primary"} sx={{ mb: 0.5, overflowWrap: "anywhere" }}>
        {why.text}
      </Typography>
      {approval.type === "command" ? (
        <>
          {(() => {
            const label = readOnlyLabel(approval.readOnly);
            return (
              <Typography variant="caption" color={label.missing || approval.readOnly ? "text.secondary" : "warning.main"} component="div" sx={{ mb: 0.5 }}>
                {label.text}
              </Typography>
            );
          })()}
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
                onClick={() => void copyText(approval.command)}
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
      ) : approval.type === "page" ? (
        <>
          <Typography variant="body2">The model wants to open this page in Chrome:</Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", overflowWrap: "anywhere", my: 0.5 }}>
            {approval.url}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            A page can run code. It opens in a fresh, empty browser profile that is deleted afterwards, and the
            model reads its text; nothing is saved.
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
        {offerPlan && (
          <Tooltip
            title={
              isCommand
                ? "Don't run it now; the model turns it into a plan to review and run"
                : approval.type === "worktree"
                  ? "Don't remove it now; the model turns it into a plan to review and run"
                  : approval.type === "page"
                    ? "Don't open it now; the model turns it into a plan to review and run"
                    : "Don't make this change now; the model turns it into a plan to review and run"
            }
          >
            <Button size="small" variant="outlined" onClick={() => onDecide("plan")}>
              Make plan
            </Button>
          </Tooltip>
        )}
      </Stack>
      {/* Approves this and the same kind of thing for the rest of this session;
          Session settings, Approvals, turns it off. */}
      {onAlways && approval.type === "change" && autoApproves({ changes: true }, approval) && (
        <Button size="small" onClick={() => onAlways("changes")} sx={{ mt: 0.5, ml: "-5px" }}>
          Approve all changes in this session
        </Button>
      )}
      {onAlways && approval.type === "command" && (
        <Tooltip title="Every command, git or not, runs as you with your network access and credentials">
          <Button size="small" color="warning" onClick={() => onAlways("commands")} sx={{ mt: 0.5, ml: "-5px" }}>
            Approve all commands in this session
          </Button>
        </Tooltip>
      )}
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
        maxHeight: "20rem",
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

// How tall your message may be before it folds: about five lines of the page's
// text (body1 is 1.5rem a line).
const FOLD_AT = "7.5rem";

// Your own long messages (a pasted brief, say) fold to a box about five lines
// tall that scrolls, so the reply below isn't pushed off the screen. Replies never fold. This folds the text and
// tells the message when it is tall enough to need the Show all button, which
// sits in the row under the message. Not saved: a reload folds them again.
function FoldedMessage({
  open,
  onTooTall,
  children,
}: {
  open: boolean;
  onTooTall: (tooTall: boolean) => void;
  children: ReactNode;
}) {
  const [tooTall, setTooTall] = useState(false);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const tall = el.offsetHeight > rem * parseFloat(FOLD_AT) + 1;
      setTooTall(tall);
      onTooTall(tall);
    };
    measure();
    // The text rewraps when the window or the panels resize.
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [onTooTall]);
  const folded = tooTall && !open;
  return (
    <Box
      sx={{
        maxHeight: folded ? FOLD_AT : "none",
        // Folded, it scrolls inside its own box, so the whole message can be read
        // without unfolding. At either end, scrolling carries on in the chat.
        overflowY: folded ? "auto" : "visible",
      }}
    >
      <div ref={inner}>{children}</div>
    </Box>
  );
}

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
  // The share used, to match the ring, which fills as the window does.
  const used = Math.min(100, share * 100);
  const percent = `${used >= 10 ? used.toFixed(0) : used.toFixed(1)}%`;
  const label = usage && contextSize ? percent : "Context";

  return (
    <Box sx={{ display: "flex" }}>
      <Tooltip title="Context used. Click for details and to clear it.">
        <ButtonBase
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ borderRadius: 1, px: 0.25, gap: 0.75, color: color === "primary" ? "text.secondary" : `${color}.main` }}
        >
          {/* A faint full circle behind the used share, so the ring reads as a
              gauge even when almost empty. */}
          <Box sx={{ position: "relative", display: "flex" }}>
            <CircularProgress
              variant="determinate"
              value={100}
              size="0.75rem"
              thickness={6}
              sx={{ color: "action.disabled" }}
            />
            <CircularProgress
              variant="determinate"
              value={Math.max(share * 100, 2)}
              size="0.75rem"
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
        slotProps={{ paper: { sx: { p: 2, width: "22.5rem", maxWidth: "calc(100vw - 2rem)" } } }}
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
