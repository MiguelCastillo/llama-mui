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
} from "./api";
import ChatSettings, { AttachmentIcon } from "./ChatSettings";
import SessionsPanel from "./SessionsPanel";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import MarkdownRenderer from "./MarkdownRenderer";
import { commandSummary, INTERRUPTED, failureLine } from "./agent/helpers";
import { askForSessionName } from "./agent/sessionNaming";
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
import { runTurn, runPlan } from "./agent/agent";

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
  // The working directory: the first attached folder (Chat settings moves
  // another one first). Sent first, where the server looks for it.
  const workingDir = attachments.find((a) => a.kind === "folder")?.path ?? null;
  const attachedPaths = (as: Attachment[]) => {
    const dir = as.find((a) => a.kind === "folder")?.path;
    return [...(dir ? [dir] : []), ...as.map((a) => a.path).filter((p) => p !== dir)];
  };
  // The working directory the system prompt names. Fixed by the session's
  // first message: after that a change goes in a chat update, so the system
  // prompt stays the same. Until then (undefined) it follows workingDir.
  const [fixedPromptDir, setFixedPromptDir] = useState<string | null | undefined>(undefined);
  const promptDir = fixedPromptDir === undefined ? workingDir : fixedPromptDir;
  // What a reply is waiting on the user for: a path the model asked for that
  // isn't attached, or a change to approve. Cleared once they answer.
  const [pending, setPending] = useState<{
    ask: Ask;
    decide: (answer: Answer) => void;
  } | null>(null);
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
  // Where each plan shows: after the turn whose update_plan call wrote it, so
  // it stays in place in the history (see Session). A finished plan stays
  // there when a new one is written; the new one shows after its own turn.
  const [planAnchor, setPlanAnchor] = useState<string | null>(null);
  const [pastPlans, setPastPlans] = useState<PastPlan[]>([]);
  // A finished plan never runs again; Clone starts a new one with its steps,
  // all pending, at the end of the chat. Not while another plan is unfinished,
  // which the clone would replace (see canClone).
  const clonePlan = (steps: PlanStep[], context?: string | null) => {
    if (plan) setPastPlans((p) => [...p, { steps: plan, anchor: planAnchor, context: planContext }]);
    setPlanAnchor(`at:${messages.length}`);
    changePlan(steps.map((st) => ({ id: crypto.randomUUID(), text: st.text, status: "pending" })));
    setPlanContext(context ?? null);
    toBottom();
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
  // Not the title: it comes from the names and the first message, and a saved
  // one holds the user's name, which saves never send.
  const keyOf = (s: Session) => JSON.stringify([s.model, s.messages, s.contextStart, s.attachments, s.usage, s.failed, s.plan, s.planProposal, s.planContext, s.planAnchor, s.pastPlans, s.promptDir, s.modelName]);

  const applySession = (s: Session) => {
    // Saved before plans had a place: pinned after the chat's last message as
    // it opens, where they showed, so later messages go below them. Counted
    // as saved, so opening the chat doesn't save it (see savedKey).
    const end = `at:${s.messages.length}`;
    const planAnchor = s.plan ? (s.planAnchor ?? end) : null;
    const pastPlans = (s.pastPlans ?? []).map((p) => ({ ...p, anchor: p.anchor ?? end }));
    savedKey.current = keyOf({ ...s, planAnchor, pastPlans });
    setMessages(s.messages);
    setContextStart(s.contextStart);
    setAttachments(s.attachments);
    setFixedPromptDir(s.promptDir);
    setUsage(s.usage);
    setFailed(s.failed ?? null);
    setModelName(s.modelName ?? null);
    // A step that was running when the page went away didn't finish.
    changePlan(
      s.plan?.map((st) => ({
        ...st,
        id: st.id ?? crypto.randomUUID(),
        status: st.status === "running" ? "pending" : st.status,
      })) ?? null,
    );
    setPlanProposal(s.planProposal ?? null);
    setPlanContext(s.planContext ?? null);
    setPlanAnchor(planAnchor);
    setPastPlans(pastPlans);
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
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "New session";
    // The server puts the user's name, when there is one, ahead of this.
    const session: Session = {
      id: sessionId,
      title: modelName ?? firstUser.slice(0, 80),
      model,
      messages,
      contextStart,
      attachments,
      usage,
      failed: abort ? INTERRUPTED : failed,
      plan,
      planProposal,
      planContext,
      planAnchor,
      pastPlans,
      promptDir: fixedPromptDir,
      modelName,
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
  // modelName too: the model often names a session before its first save, when
  // the rename (PATCH) has no file to change yet, so the next save carries it.
  }, [loaded, messages, contextStart, attachments, usage, model, abort, failed, plan, planProposal, planContext, planAnchor, pastPlans, fixedPromptDir, modelName]);

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
    setFixedPromptDir(undefined);
    setFailed(null);
    setModelName(null);
    changePlan(null);
    setPlanProposal(null);
    setPlanContext(null);
    setPlanAnchor(null);
    setPastPlans([]);
    setDrawerOpen(false);
    loadSession(id);
  };
  const newChat = () => openSession(crypto.randomUUID());
  // Cancelling a plan asks first, then stops a run (the step's request, or its
  // check) and removes the plan. The steps' messages stay in the chat, and
  // what they changed stays changed. The runner, still unwinding from the
  // stop, finds no plan and leaves it alone (setStep needs a step to change).
  const [confirmCancelPlan, setConfirmCancelPlan] = useState(false);
  const cancelPlanConfirmed = () => {
    setConfirmCancelPlan(false);
    abort?.abort();
    changePlan(null);
    setPlanProposal(null);
    setPlanContext(null);
    setPlanAnchor(null);
  };
  // Deleting asks first, in a Dialog: window.confirm is answered "no" at once,
  // without being shown, in some browsers (the Claude app's browser pane).
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const removeSession = (id: string) => setConfirmDelete(id);
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
    deleteSession(id)
      .then(() => {
        setSessions((ss) => ss.filter((x) => x.id !== id));
        if (id === sessionId) openSession(crypto.randomUUID(), false);
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

  // Bumped to fetch the tool context again, after a check command changes.
  const [contextVersion, setContextVersion] = useState(0);
  // Settings → Tools or the attachments may have changed what's available.
  useEffect(() => {
    if (!visible) return;
    getToolContext(attachedPaths(attachments), promptDir)
      .then(setToolContext)
      .catch((e) => setError(e.message));
  }, [visible, attachments, promptDir, contextVersion]);

  // On only when the user wants tools and some are ready in this chat.
  const toolsOn = toolsWanted && toolContext.offered.length > 0;
  const busy = !!abort || planRunning;
  useEffect(() => {
    setBusySince((since) => (busy ? (since ?? Date.now()) : null));
  }, [busy]);

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
  const promptInPlan = !!pending && planRunning && !!plan;
  // Not smooth: an animation per token never caught up, and fought the user.
  // A prompt in the plan card scrolls itself into view instead.
  useEffect(() => {
    if (followingRef.current && !promptInPlan) stickToBottom();
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

  // Sends what the user typed. Returns whether it went, so the message box
  // clears only then: it waits there while the model is checked.
  const send = async (text: string) => {
    if (!model || !connector || abort || planRunning) return false;
    if (!(await modelLoaded())) return false;
    toBottom();
    reply(text, messages, { planning: planOn });
    return true;
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
    { planning = false, planStep, from }: { planning?: boolean; planStep?: string; from?: number } = {},
  ): Promise<{ ok: boolean; messages: ChatMessage[]; error?: string }> => {
    // Where the model's history starts: the session's (after a clear), or for
    // a plan step, the step's own first message (see runPlan).
    const start = Math.max(from ?? contextStart, contextStart);
    if (!connector) return { ok: false, messages: before };
    // Every request checks, not just send(): a plan's steps and Resend come
    // here too, and the model may have been unloaded since.
    if (!(await modelLoaded())) return { ok: false, messages: before };
    const connectorId = connector.id;
    // Fixed for this reply, even if the user changes attachments meanwhile;
    // only paths the user allows mid-reply are added.
    if (fixedPromptDir === undefined) setFixedPromptDir(workingDir);
    const forgotten = before.slice(0, start);
    // Attachments and tools that are off go the same way, as `update`, and
    // only when they changed since the last one the model saw.
    const seen = [...before.slice(start)].reverse().find((m) => m.update)?.update;
    const controller = new AbortController();
    const started = performance.now();

    const result = await runTurn(
      {
        connectorId,
        api: connector.api,
        model,
        toolsOn,
        thinkOn,
        planning,
        planStep,
        systemPrompt: toolContext.systemPrompt,
        toolDefinitions: toolContext.definitions,
        toolContextUpdate: toolContext.update,
        seenUpdate: seen ?? "",
        history: before.slice(start),
        forgotten,
        attached: attachedPaths(attachments),
        chatId: sessionId,
        controller,
        started,
        text,
      },
      {
        setMessages,
        setError,
        setFailed,
        setUsage: (u) => { if (u) setUsage(u); },
        setAbort,
        refreshModels,
        askUser,
        attach,
        setPlanProposal,
        setPastPlans,
        setPlanAnchor,
        setPlanContext,
        changePlan,
        planRef,
        planRunningRef,
        planAnchor,
        planContext,
      },
    );

    // Update streamRate for the UI (tokens per second display).
    streamRate.current = { pieces: result.messages.length, first: started };

    // After a successful reply, ask the model to name the session if it has
    // no name yet (modelName is null).
    if (result.ok && !modelName) {
      const name = await askForSessionName(result.messages, connectorId, model, controller.signal, connector.api);
      if (name) {
        setModelName(name);
        renameSession(sessionId, { title: name, modelName: name });
      }
    }

    return { ok: result.ok, messages: result.messages, error: result.error };
  };

  // Changes one step, keeping its text. The patch replaces the rest, so a
  // step that runs again loses its old note and "may need a rerun" mark. By
  // id: a step that rewrites the plan moves steps, and its id goes with it.
  const setStep = (id: string, patch: Omit<PlanStep, "id" | "text">) => {
    const steps = planRef.current;
    if (steps?.some((st) => st.id === id)) changePlan(steps.map((st) => (st.id === id ? { id: st.id, text: st.text, ...patch } : st)));
  };

  // Runs the plan's open steps in order, one turn each, and checks every step
  // before ticking it off: the model saying it's done isn't enough. First the
  // folders' check commands, then the model check. A step that isn't done gets
  // one retry (to fix what a command reported, or to answer the check), then
  // waits for the user.
  // The message that asked for the plan: the last one you sent (not a step's)
  // before the update_plan call that wrote it, or before "at:N" for a clone.
  const planRequest = () => {
    const call = messages.findIndex((m) => m.toolCalls?.some((c) => c.id === planAnchor));
    const end = call >= 0 ? call : planAnchor?.startsWith("at:") ? Number(planAnchor.slice(3)) : messages.length;
    return [...messages.slice(0, end)].reverse().find((m) => m.role === "user" && !m.planStep)?.content;
  };
  const runPlanWrapper = () => runPlan({
    request: planRequest(),
    context: planContext,
    freshSteps: prefs?.freshPlanSteps,
    connector: connector ?? null,
    model,
    abort,
    planRunningRef,
    setPlanRunning,
    messages,
    planRef,
    setStep,
    reply,
    setError,
    setAbort,
    modelLoaded,
    models,
    attachments,
    checkCommands: toolContext.checkCommands,
    attachedPaths,
    sessionId,
    thinkOn,
    toolDefinitions: toolContext.definitions,
  });

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
  const canClone = (!plan || plan.every((st) => st.status === "done")) && !abort && !planRunning;
  const planCards = [
    ...pastPlans.map((p, i) => ({
      anchor: p.anchor,
      card: (
        <PlanView
          key={`past-${i}`}
          steps={p.steps}
          context={p.context}
          details={stepTurns}
          formatTime={formatSeconds}
          onClone={canClone ? () => clonePlan(p.steps, p.context) : undefined}
        />
      ),
    })),
    ...(plan
      ? [
          {
            anchor: planAnchor,
            card: (
              <PlanView
                key="plan"
                steps={plan}
                context={planContext}
                running={planRunning || !!abort}
                since={planRunning ? busySince : null}
                counter={(since) => <Elapsed since={since} rate={streamRate} variant="caption" color="text.secondary" />}
                onRun={runPlanWrapper}
                onChange={changePlan}
                proposal={planProposal}
                onProposal={answerProposal}
                details={stepTurns}
                formatTime={formatSeconds}
                onCancel={() => setConfirmCancelPlan(true)}
                onClone={canClone ? () => clonePlan(plan, planContext) : undefined}
                prompt={promptInPlan && pending ? <PendingPrompt ask={pending.ask} onDecide={pending.decide} /> : undefined}
              />
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
              disabled={!!abort}
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
        {/* New chat lives in the Sessions panel; here only while that's hidden.
            It comes first so the Sessions toggle and Settings never move. */}
        {!(narrow ? drawerOpen : sessionsOpen) && (
          <Tooltip title="New session">
            <span>
              <IconButton onClick={newChat} disabled={!!abort}>
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
        <DialogTitle>Cancel this plan?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {planRunning ? "This stops the step that's running and removes" : "This removes"} the plan and its
            checklist. The steps' messages stay in the chat, and anything they already changed stays changed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCancelPlan(false)}>Keep it</Button>
          <Button color="error" variant="contained" onClick={cancelPlanConfirmed}>
            Cancel plan
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} maxWidth="xs">
        <DialogTitle>Delete this session?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            “{sessions.find((s) => s.id === confirmDelete)?.title ?? "This session"}” and its messages will be deleted.
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
            {pending && !promptInPlan && <PendingPrompt ask={pending.ask} onDecide={pending.decide} />}
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
              onMakeWorkingDir={(p) =>
                setAttachments((as) => [...as.filter((x) => x.path === p), ...as.filter((x) => x.path !== p)])
              }
              checkCommands={toolContext.checkCommands}
              onSetCheckCommand={(folder, command) =>
                setCheckCommand(folder, command)
                  .then(() => setContextVersion((v) => v + 1))
                  .catch((e) => setError(e.message))
              }
            />
            <Composer
              placeholder={narrow ? "Message" : "Message (Enter to send, Shift+Enter for a new line)"}
              onSend={send}
              onStop={abort ? () => abort.abort() : undefined}
              disabled={!model}
              below={
                showIndicator && (
                  <ContextIndicator
                    usage={usage}
                    contextSize={models.find((m) => m.id === model)?.contextSize}
                    onClear={clearContext}
                    onCompact={compactSession}
                    canCompact={contextStart > 0}
                    disabled={!!abort}
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
}: {
  placeholder: string;
  // Resolves to whether the message went; the box clears only then.
  onSend: (text: string) => Promise<boolean>;
  onStop?: () => void;
  disabled: boolean;
  // Under Send: the context indicator.
  below: ReactNode;
}) {
  const [text, setText] = useState("");
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
      <Stack spacing={1.25} sx={{ flexShrink: 0, alignItems: "flex-end" }}>
        {onStop ? (
          <Button variant="outlined" color="error" startIcon={<StopIcon />} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button variant="contained" endIcon={<SendIcon />} onClick={send} disabled={!text.trim() || disabled}>
            Send
          </Button>
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
  const [showHidden, setShowHidden] = useState(false);
  const showMarkdown = override ?? renderMarkdown;
  // The finished reply's time and speed, kept on its last message.
  const took = [...parts].reverse().find((m) => m.took)?.took;
  const isUser = parts[0].role === "user";
  // What was sent after this message without being shown: its chat update
  // and note (see README, "What the model is told"). Opened on request.
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
      icon={isCommand ? <TerminalOutlinedIcon fontSize="small" /> : <EditOutlinedIcon fontSize="small" />}
      sx={{ "& .MuiAlert-message": { minWidth: 0, flexGrow: 1 } }}
    >
      {isCommand ? (
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
