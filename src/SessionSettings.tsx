import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import TuneIcon from "@mui/icons-material/Tune";
import { type Attachment, getRecentFolders, pickAttachments } from "./api";
import RecentFolders from "./RecentFolders";

const SOURCE_LABEL: Record<Attachment["source"], string> = {
  manual: "Added by you",
  request: "Model asked, you allowed",
};

export const AttachmentIcon = ({ kind }: { kind: Attachment["kind"] }) =>
  kind === "folder" ? <FolderOutlinedIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />;

type SectionId = "workingDir" | "attachments";

// Shown, and used as the error, when the working directory or attachments are changed while a plan or a reply runs.
export const ATTACHMENTS_LOCKED_NOTE = "Folders can't change while a plan or a reply is running. Pause the plan, stop the reply, or wait until it finishes.";

// Button next to the message box that opens this chat's settings: its working
// directory and what's attached. Laid out like Settings, but everything here
// belongs to this chat and New chat clears it.
export default function SessionSettings({
  attachments,
  workingDir,
  onAttach,
  onDetach,
  onSetWorkingDir,
  checkCommands,
  onSetCheckCommand,
  locked = false,
}: {
  // The extra files and folders the model may read (not the working directory).
  attachments: Attachment[];
  // The chat's working directory (Session.workingDir), which is not one of the attachments.
  workingDir: string | null;
  onAttach: (a: Attachment) => void;
  onDetach: (path: string) => void;
  // Replaces the working directory; null clears it.
  onSetWorkingDir: (path: string | null) => void;
  checkCommands: Record<string, string>;
  onSetCheckCommand: (folder: string, command: string) => void;
  // A plan or reply is running: its session belongs to the server until it
  // ends, so the working directory and attachments can't change. The check
  // commands can (they aren't the session's).
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SectionId>("workingDir");
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  const sections = [
    { id: "workingDir" as const, label: "Working directory", icon: <FolderOutlinedIcon />, count: workingDir ? 1 : 0 },
    { id: "attachments" as const, label: "Attachments", icon: <AttachFileIcon />, count: attachments.length },
  ];

  return (
    <>
      <Tooltip title="Session settings: working directory and attachments">
        <IconButton onClick={() => setOpen(true)}>
          <TuneIcon />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" fullScreen={narrow}>
        <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
          <Box sx={{ flexGrow: 1 }}>Session settings</Box>
          <IconButton onClick={() => setOpen(false)} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        {narrow && (
          <Tabs value={section} onChange={(_, v) => setSection(v)} variant="fullWidth" sx={{ px: 2 }}>
            {sections.map((s) => (
              <Tab key={s.id} value={s.id} label={s.label} />
            ))}
          </Tabs>
        )}
        <DialogContent sx={{ display: "flex", gap: 3, minHeight: "32rem", pt: narrow ? 2 : 0, ...(!narrow && { pl: 0 }) }}>
          {!narrow && (
            <List component="nav" sx={{ width: "15rem", flexShrink: 0, py: 0, alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: 0.5 }}>
              {sections.map((s) => (
                <ListItemButton
                  key={s.id}
                  selected={s.id === section}
                  onClick={() => setSection(s.id)}
                  sx={{ borderRadius: 1, px: 2, py: 0.75 }}
                >
                  <ListItemIcon sx={{ minWidth: "2.5rem" }}>{s.icon}</ListItemIcon>
                  <ListItemText primary={s.label} />
                  {s.count > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      {s.count}
                    </Typography>
                  )}
                </ListItemButton>
              ))}
            </List>
          )}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {section === "workingDir" && (
              <WorkingDirSection
                workingDir={workingDir}
                onSet={onSetWorkingDir}
                checkCommands={checkCommands}
                onSetCheckCommand={onSetCheckCommand}
                locked={locked}
              />
            )}
            {section === "attachments" && (
              <AttachmentsSection attachments={attachments} onAdd={onAttach} onRemove={onDetach} locked={locked} />
            )}
          </Box>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The chat's working directory: where relative paths and commands start, and
// whose check command runs after each plan step. One folder, picked in the
// system dialog or picked from the recent ones. Choosing another replaces it,
// and the old one is not kept as an attachment.
function WorkingDirSection({
  workingDir,
  onSet,
  checkCommands,
  onSetCheckCommand,
  locked,
}: {
  workingDir: string | null;
  onSet: (path: string | null) => void;
  checkCommands: Record<string, string>;
  onSetCheckCommand: (folder: string, command: string) => void;
  locked: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  // The folders chosen lately, newest first. Read again when the working
  // directory changes, since choosing one moves it to the top.
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    // A short delay lets the server note the folder just chosen.
    const t = setTimeout(() => {
      getRecentFolders()
        .then((r) => current && setRecent(r.folders))
        .catch(() => {});
    }, 200);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [workingDir]);
  const others = recent.filter((f) => f !== workingDir);
  // True while the system dialog is open.
  const [picking, setPicking] = useState(false);
  const pick = () => {
    setPicking(true);
    setError(null);
    pickAttachments("folder")
      .then((as) => as[0] && onSet(as[0].path))
      .catch((e) => setError(e.message))
      .finally(() => setPicking(false));
  };
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h6">Working directory</Typography>
        <Typography variant="body2" color="text.secondary">
          Relative paths and commands start here, and the model can read it with its subfolders. Choosing another
          folder replaces it. Without one, the model uses absolute paths.
        </Typography>
      </Box>
      {locked && <Alert severity="info">{ATTACHMENTS_LOCKED_NOTE}</Alert>}
      {workingDir ? (
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Box sx={{ display: "flex", color: "text.secondary" }}>
              <AttachmentIcon kind="folder" />
            </Box>
            <Typography variant="body1" sx={{ flexShrink: 0 }}>
              {workingDir.split("/").filter(Boolean).at(-1) ?? workingDir}
            </Typography>
            <Typography
              variant="body2"
              sx={{ flexGrow: 1, minWidth: 0, textAlign: "right", overflowWrap: "anywhere", color: "text.disabled" }}
            >
              ({workingDir})
            </Typography>
            <Tooltip title="Clear the working directory">
              <span>
                <Button size="small" disabled={locked} onClick={() => onSet(null)} sx={{ flexShrink: 0 }}>
                  Clear
                </Button>
              </span>
            </Tooltip>
          </Stack>
          <CheckCommandField
            // Starts over when the saved command arrives or changes.
            key={`${workingDir}\n${checkCommands[workingDir] ?? ""}`}
            command={checkCommands[workingDir] ?? ""}
            onSave={(c) => onSetCheckCommand(workingDir, c)}
          />
        </Box>
      ) : null}
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<FolderOutlinedIcon />}
          disabled={picking || locked}
          onClick={pick}
        >
          Choose folder…
        </Button>
        {picking && <CircularProgress size="1.125rem" sx={{ alignSelf: "center" }} />}
      </Stack>
      <RecentFolders folders={others} disabled={locked} onChoose={onSet} />
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

// This chat's extra files and folders, each marked with how it got there.
// More can be picked in the system dialog, or typed as a path, which the
// server checks first (it must exist; ~ works). The working directory is the
// chat's own field (Session.workingDir) and is not listed here.
function AttachmentsSection({
  attachments,
  onAdd,
  onRemove,
  locked,
}: {
  attachments: Attachment[];
  onAdd: (a: Attachment) => void;
  onRemove: (path: string) => void;
  locked: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  // True while the system dialog is open.
  const [picking, setPicking] = useState(false);
  const pick = (kind: Attachment["kind"]) => {
    setPicking(true);
    setError(null);
    pickAttachments(kind)
      .then((as) => as.forEach((a) => onAdd({ ...a, source: "manual" })))
      .catch((e) => setError(e.message))
      .finally(() => setPicking(false));
  };
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">Attachments</Typography>
        <Typography variant="body2" color="text.secondary">
          Extra files and folders the model can read, folders with their subfolders. It asks you before changing
          them or reading anything else.
        </Typography>
      </Box>
      {locked && <Alert severity="info">{ATTACHMENTS_LOCKED_NOTE}</Alert>}
      {attachments.length > 0 && (
        <Stack divider={<Divider flexItem />}>
          {attachments.map((a) => (
            <Stack key={a.path} direction="row" spacing={1.5} sx={{ alignItems: "center", py: 0.75 }}>
              <Box sx={{ display: "flex", color: "text.secondary" }}>
                <AttachmentIcon kind={a.kind} />
              </Box>
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography variant="body2" noWrap>
                  {a.path.split("/").pop() || a.path}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: "anywhere" }}>
                  {a.path}
                </Typography>
              </Box>
              <Chip
                size="small"
                variant="outlined"
                label={a.source === "manual" ? "You added" : "Model asked"}
                color={a.source === "manual" ? "default" : "warning"}
                title={SOURCE_LABEL[a.source]}
                sx={{ flexShrink: 0 }}
              />
              <Tooltip title="Remove from this session">
                <IconButton size="small" disabled={locked} onClick={() => onRemove(a.path)} aria-label={`Remove ${a.path}`}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<InsertDriveFileOutlinedIcon />}
          disabled={picking || locked}
          onClick={() => pick("file")}
        >
          Choose files…
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<FolderOutlinedIcon />}
          disabled={picking || locked}
          onClick={() => pick("folder")}
        >
          Choose folders…
        </Button>
        {picking && <CircularProgress size="1.125rem" sx={{ alignSelf: "center" }} />}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

// A folder's check command, saved on Enter or when the field loses focus.
// Kept for the folder, so every session that uses it as its working directory runs the same one.
function CheckCommandField({ command, onSave }: { command: string; onSave: (command: string) => void }) {
  const [text, setText] = useState(command);
  const save = () => text.trim() !== command && onSave(text.trim());
  return (
    <TextField
      size="small"
      variant="standard"
      fullWidth
      placeholder="Check command, run after each plan step (e.g. npx tsc --noEmit -p .)"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
      slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: "0.8125rem" } } }}
      sx={{ mt: 0.5 }}
    />
  );
}
