import { useState } from "react";
import {
  Alert,
  Badge,
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
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import { type Attachment, checkAttachment, pickAttachments } from "./api";

const SOURCE_LABEL: Record<Attachment["source"], string> = {
  manual: "Added by you",
  request: "Model asked, you allowed",
};

export const AttachmentIcon = ({ kind }: { kind: Attachment["kind"] }) =>
  kind === "folder" ? <FolderOutlinedIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />;

type SectionId = "attachments";

// Shown, and used as the error, when attachments are changed while a plan or a reply runs.
export const ATTACHMENTS_LOCKED_NOTE = "Folders can't change while a plan or a reply is running. Stop it or wait until it finishes.";

// Button next to the message box that opens this chat's settings (for now,
// what's attached). Laid out like Settings, but everything here belongs to
// this chat and New chat clears it.
export default function ChatSettings({
  attachments,
  workingDir,
  onAttach,
  onDetach,
  onMakeWorkingDir,
  checkCommands,
  onSetCheckCommand,
  locked = false,
}: {
  attachments: Attachment[];
  // The chat's working directory, which is not one of the attachments.
  workingDir: string | null;
  onAttach: (a: Attachment) => void;
  onDetach: (path: string) => void;
  onMakeWorkingDir: (path: string) => void;
  checkCommands: Record<string, string>;
  onSetCheckCommand: (folder: string, command: string) => void;
  // A plan is running: its session belongs to the server until it ends, so
  // what is attached can't change. The check commands can (they aren't the session's).
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SectionId>("attachments");
  const narrow = useMediaQuery((t) => t.breakpoints.down("sm"));
  const sections = [
    { id: "attachments" as const, label: "Attachments", icon: <AttachFileIcon />, count: attachments.length },
  ];

  return (
    <>
      <Tooltip title="Chat settings: attachments">
        {/* mt centers it on a one-line input (56px). */}
        <IconButton onClick={() => setOpen(true)} sx={{ mt: 1 }}>
          <Badge badgeContent={attachments.length} color="primary">
            <TuneIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" fullScreen={narrow}>
        <DialogTitle sx={{ display: "flex", alignItems: "center", pr: 1 }}>
          <Box sx={{ flexGrow: 1 }}>Chat settings</Box>
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
        <DialogContent sx={{ display: "flex", gap: 3, minHeight: 360, pt: narrow ? 2 : 0 }}>
          {!narrow && (
            <List component="nav" sx={{ width: 180, flexShrink: 0, py: 0 }}>
              {sections.map((s) => (
                <ListItemButton
                  key={s.id}
                  selected={s.id === section}
                  onClick={() => setSection(s.id)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemIcon>{s.icon}</ListItemIcon>
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
            {section === "attachments" && (
              <AttachmentsSection
                attachments={attachments}
                workingDir={workingDir}
                onAdd={onAttach}
                onRemove={onDetach}
                onMakeWorkingDir={onMakeWorkingDir}
                checkCommands={checkCommands}
                onSetCheckCommand={onSetCheckCommand}
                locked={locked}
              />
            )}
          </Box>
        </DialogContent>
      </Dialog>
    </>
  );
}

// This chat's files and folders, each marked with how it got there. More can
// be picked in the system dialog, or typed as a path, which the server checks
// first (it must exist; ~ works). The working directory is the chat's own
// field (Session.workingDir); making an attached folder it moves it out of
// the attachments and replaces the old one.
function AttachmentsSection({
  attachments,
  workingDir,
  onAdd,
  onRemove,
  onMakeWorkingDir,
  checkCommands,
  onSetCheckCommand,
  locked,
}: {
  attachments: Attachment[];
  workingDir: string | null;
  onAdd: (a: Attachment) => void;
  onRemove: (path: string) => void;
  onMakeWorkingDir: (path: string) => void;
  checkCommands: Record<string, string>;
  onSetCheckCommand: (folder: string, command: string) => void;
  locked: boolean;
}) {
  const [path, setPath] = useState("");
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
  const add = () =>
    checkAttachment(path)
      .then((a) => {
        onAdd({ ...a, source: "manual" });
        setPath("");
      })
      .catch((e) => setError(e.message));

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">Attachments</Typography>
        <Typography variant="body2" color="text.secondary">
          The model can read these, folders with their subfolders, and asks you before changing them or reading
          anything else. The working directory is where relative paths and commands start; the home button
          makes an attached folder it.
        </Typography>
      </Box>
      {locked && <Alert severity="info">{ATTACHMENTS_LOCKED_NOTE}</Alert>}
      {workingDir && (
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Box sx={{ display: "flex", color: "text.secondary" }}>
              <AttachmentIcon kind="folder" />
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              {workingDir}
            </Typography>
            <Chip size="small" color="primary" label="Working directory" sx={{ flexShrink: 0 }} />
          </Stack>
          <CheckCommandField
            // Starts over when the saved command arrives or changes.
            key={checkCommands[workingDir] ?? ""}
            command={checkCommands[workingDir] ?? ""}
            onSave={(c) => onSetCheckCommand(workingDir, c)}
          />
        </Box>
      )}
      {attachments.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing yet.
        </Typography>
      ) : (
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
              {a.kind === "folder" && (
                <Tooltip title="Make this the working directory (replaces the current one)">
                  <IconButton size="small" disabled={locked} onClick={() => onMakeWorkingDir(a.path)} aria-label={`Make ${a.path} the working directory`}>
                    <HomeOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
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
        {picking && <CircularProgress size={18} sx={{ alignSelf: "center" }} />}
      </Stack>
      <Stack
        component="form"
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start" }}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <TextField
          fullWidth
          size="small"
          label="Or type a path"
          placeholder="~/Projects/notes"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          error={!!error}
          helperText={error}
          disabled={locked}
        />
        <Button type="submit" variant="contained" disabled={!path.trim() || locked} sx={{ flexShrink: 0, mt: 0.25 }}>
          Attach
        </Button>
      </Stack>
    </Stack>
  );
}

// A folder's check command, saved on Enter or when the field loses focus.
// Kept for the folder, so every session that attaches it runs the same one.
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
      slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
      sx={{ mt: 0.5 }}
    />
  );
}
