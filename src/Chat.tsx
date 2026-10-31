import { Fragment, useEffect, useRef, useState } from "react";
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
import {
  type ChatMessage,
  type StepStats,
  type ToolCall,
  type ModelSettings,
  type Preferences,
  type ToolsState,
  type Usage,
  type Connector,
  type Model,
  getConnectors,
  getModelSettings,
  getPreferences,
  getTools,
  listModels,
  runTool,
  streamChat,
} from "./api";

// Whether the toolbar is expanded is a per-browser convenience, so it lives
// in localStorage. Storage can be unavailable (private windows), so failures
// just fall back to expanded.
const TOOLBAR_KEY = "llama-mui:toolbarOpen";
function loadToolbarOpen(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_KEY) !== "false";
  } catch {
    return true;
  }
}
function saveToolbarOpen(open: boolean) {
  try {
    localStorage.setItem(TOOLBAR_KEY, String(open));
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

// Caps one reply's tool use, so a model stuck calling tools can't loop forever.
const MAX_TOOL_ROUNDS = 10;

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
  const [toolsWanted, setToolsWanted] = useState(true);
  const [tools, setTools] = useState<ToolsState>({
    groups: [],
    directories: [],
    definitions: [],
    systemPrompt: null,
  });
  const [error, setError] = useState<string | null>(null);
  // Token count after the latest reply; it covers the whole conversation.
  const [usage, setUsage] = useState<Usage | null>(null);
  // Index of the first message the model still sees. Clear context moves it
  // to the end: earlier messages stay on screen but aren't sent any more.
  const [contextStart, setContextStart] = useState(0);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [toolbarOpen, setToolbarOpenState] = useState(loadToolbarOpen);
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  const setToolbarOpen = (open: boolean) => {
    setToolbarOpenState(open);
    saveToolbarOpen(open);
  };
  const [abort, setAbort] = useState<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    getTools()
      .then(setTools)
      .catch((e) => setError(e.message));
    getPreferences()
      .then(setPrefs)
      .catch((e) => setError(e.message));
    getModelSettings()
      .then(setModelSettings)
      .catch((e) => setError(e.message));
  }, [visible]);

  // On only when the user wants tools and Settings leaves some ready to use.
  const toolsOn = toolsWanted && tools.definitions.length > 0;
  const toolCount = tools.definitions.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || !model || !connector || abort) return;
    const connectorId = connector.id;
    const forgotten = messages.slice(0, contextStart);
    let history: ChatMessage[] = [...messages.slice(contextStart), { role: "user", content: text }];
    setInput("");
    setError(null);

    const controller = new AbortController();
    setAbort(controller);
    try {
      // Each round streams one assistant turn. If it asks for tools, run them,
      // add the results, and let the model continue from there.
      // Indexes (in history) of the last round's tool results, which get their
      // token counts once the next turn reports what it had to read.
      let lastToolResults: number[] = [];
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const reply: ChatMessage = { role: "assistant", content: "", reasoning: "" };
        let thinkStart = 0;
        let thinkEnd = 0;
        let thinkPieces = 0;
        const show = () => setMessages([...forgotten, ...history, { ...reply }]);
        show();
        const { toolCalls, usage: replyUsage } = await streamChat(
          {
            connectorId,
            model,
            messages:
              toolsOn && tools.systemPrompt ? [{ role: "system", content: tools.systemPrompt }, ...history] : history,
            // Thinking is forced on while tools are offered: without it, small
            // models (Qwen 9B) mostly answer from memory instead of calling them.
            think: toolsOn || !!(modelSettings?.models[model] ?? modelSettings?.defaults)?.think,
            tools: toolsOn ? tools.definitions : undefined,
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
        if (replyUsage) setUsage(replyUsage);
        if (thinkStart) reply.stats = { ms: (thinkEnd || performance.now()) - thinkStart, tokens: thinkPieces };
        if (replyUsage?.promptTokens && lastToolResults.length) {
          history = shareTokens(history, lastToolResults, replyUsage.promptTokens);
        }
        lastToolResults = [];
        if (toolCalls.length) reply.toolCalls = toolCalls;
        history = [...history, reply];
        setMessages([...forgotten, ...history]);
        if (!toolCalls.length) break;

        for (const call of toolCalls) {
          if (controller.signal.aborted) return;
          const started = performance.now();
          const result = await runTool(call).catch((e) => `Error: ${e.message}`);
          lastToolResults.push(history.length);
          history = [
            ...history,
            { role: "tool", content: result, toolCallId: call.id, stats: { ms: performance.now() - started } },
          ];
          setMessages([...forgotten, ...history]);
        }
        if (round === MAX_TOOL_ROUNDS - 1) setError(`Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls.`);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
    } finally {
      setAbort(null);
      // The server loads models on demand, so a reply can change their status.
      refreshModels(connectorId);
    }
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
  const hasContext = messages.length > contextStart;
  const showIndicator = hasContext && !!prefs?.showContextMeter;

  const clearContext = () => {
    setContextStart(messages.length);
    setUsage(null);
  };

  return (
    <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column", position: "relative" }}>
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
                  <Switch checked={toolsOn} onChange={(e) => setToolsWanted(e.target.checked)} />
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
        <Tooltip title="New chat">
          <span>
            <IconButton
              onClick={() => {
                setMessages([]);
                setUsage(null);
                setContextStart(0);
              }}
              disabled={!!abort}
            >
              <AddCommentIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton onClick={onOpenSettings}>
            <SettingsOutlinedIcon />
          </IconButton>
        </Tooltip>
      </Paper>

      {/* Top padding keeps the first messages clear of the toolbar. */}
      <Box sx={{ flexGrow: 1, overflowY: "auto", pt: 9, pb: 3 }}>
        <Container maxWidth="md">
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
                />
              </Fragment>
            ))}
            {/* Cleared after the last message: the divider goes at the end. */}
            {contextStart > 0 && contextStart === messages.length && <ContextDivider />}
            {error && <Alert severity="error">{error}</Alert>}
            <div ref={bottomRef} />
          </Stack>
        </Container>
      </Box>

      <Paper square elevation={3} sx={{ py: 2 }}>
        <Container maxWidth="md">
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
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
}: {
  parts: ChatMessage[];
  streaming: boolean;
  toolResults: Map<string, ChatMessage>;
  // Above a Clear context divider: shown dimmed since the model can't see it.
  forgotten: boolean;
  // Off: only the answer text shows, no thinking or tool calls (Settings → Chat).
  showSteps: boolean;
}) {
  const isUser = parts[0].role === "user";
  const last = parts[parts.length - 1];
  const waiting = showSteps
    ? streaming && !last.content && !last.reasoning && !last.toolCalls?.length
    : streaming && !last.content;
  // With steps hidden, a finished reply that was all steps (e.g. stopped
  // mid-tool) would be an empty box.
  if (!isUser && !showSteps && !waiting && !parts.some((m) => m.content)) return null;
  return (
    <Box sx={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", opacity: forgotten ? 0.5 : 1 }}>
      <Paper
        variant={isUser ? "elevation" : "outlined"}
        sx={{
          px: 2,
          py: 1.5,
          maxWidth: "85%",
          bgcolor: isUser ? "primary.main" : "background.paper",
          color: isUser ? "primary.contrastText" : "text.primary",
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
              {m.content && (
                <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</Typography>
              )}
              {showSteps &&
                m.toolCalls?.map((c) => <ToolCallView key={c.id} call={c} result={toolResults.get(c.id)} />)}
            </Fragment>
          ))}
          {waiting && <Typography>…</Typography>}
        </Stack>
      </Paper>
    </Box>
  );
}

// One tool call: what was asked for, and the result once it's back.
function ToolCallView({ call, result: resultMessage }: { call: ToolCall; result?: ChatMessage }) {
  const result = resultMessage?.content;
  let args: any = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    // Shown raw below; the server reports the bad JSON to the model.
  }
  // find_files and grep take a pattern, web_search a query; show it along with
  // where they looked.
  const term = args.pattern ?? args.query;
  const target = term !== undefined ? `"${term}"${args.path ? ` in ${args.path}` : ""}` : (args.path ?? "");
  const failed = result?.startsWith("Error:");
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{ mt: 1, bgcolor: "action.hover", "&:before": { display: "none" } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          {result === undefined ? (
            <CircularProgress size={14} />
          ) : (
            <BuildOutlinedIcon fontSize="small" color={failed ? "error" : "action"} />
          )}
          <Typography variant="body2" sx={{ fontFamily: "monospace" }} noWrap>
            {call.name}
            {target && ` ${target}`}
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
          {result ?? `Running with ${call.arguments || "{}"}…`}
        </Typography>
      </AccordionDetails>
    </Accordion>
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
