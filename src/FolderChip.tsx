import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { type Attachment, getRecentFolders, pickAttachments } from "./api";
import RecentFolders from "./RecentFolders";
import { ATTACHMENTS_LOCKED_NOTE, folderName } from "./sessionFolder";

export const AttachmentIcon = ({ kind }: { kind: Attachment["kind"] }) =>
  kind === "folder" ? <FolderOutlinedIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />;

// The chat's folder, as a chip in the message box's bottom row. Before the
// chat's first reply it is a picker: recent folders, Pick a folder…, Clear.
// After that (`frozen`) it is a label for the folder the model was told about,
// and its menu only has the extra folders the model may read ("Also allowed")
// and the one way to add one by hand. Otherwise the model asks when it needs
// access, and you answer in the chat.
export default function FolderChip({
  workingDir,
  frozen,
  attachments,
  locked,
  onSetWorkingDir,
  onAttach,
  onDetach,
  checkCommand,
  onSetCheckCommand,
}: {
  workingDir: string | null;
  frozen: boolean;
  // The extra allowed files and folders (not the working directory).
  attachments: Attachment[];
  // A plan or reply is running: the folders can't change (see ATTACHMENTS_LOCKED_NOTE).
  locked: boolean;
  onSetWorkingDir: (path: string | null) => void;
  onAttach: (a: Attachment) => void;
  onDetach: (path: string) => void;
  // The working directory's check command, run after each plan step. Not part
  // of the session, so it can change while a run goes.
  checkCommand: string;
  onSetCheckCommand: (folder: string, command: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True while the system dialog is open.
  const [picking, setPicking] = useState(false);
  // The folders chosen lately, newest first; read when the menu opens.
  const [recent, setRecent] = useState<string[]>([]);
  const open = !!anchor;
  useEffect(() => {
    if (!open || frozen) return;
    let current = true;
    getRecentFolders()
      .then((r) => current && setRecent(r.folders))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [open, frozen, workingDir]);

  const close = () => {
    setAnchor(null);
    setError(null);
  };
  const pick = (kind: "workingDir" | "allow") => {
    setPicking(true);
    setError(null);
    pickAttachments("folder")
      .then((as) => {
        if (!as[0]) return;
        if (kind === "workingDir") onSetWorkingDir(as[0].path);
        else onAttach({ ...as[0], source: "manual" });
      })
      .catch((e) => setError(e.message))
      .finally(() => setPicking(false));
  };
  const busy = picking || locked;

  return (
    <>
      <Tooltip
        title={
          workingDir
            ? `${workingDir}${frozen ? " (fixed for this chat; Clear context lets you change it)" : ""}`
            : "No working directory: the model uses absolute paths"
        }
      >
        <Button
          size="small"
          color="inherit"
          onClick={(e) => setAnchor(e.currentTarget)}
          startIcon={<FolderOutlinedIcon fontSize="small" />}
          endIcon={<ExpandMoreIcon fontSize="small" />}
          aria-label={workingDir ? `Folder: ${folderName(workingDir)}` : "Choose a folder"}
          sx={{
            minWidth: 0,
            maxWidth: "100%",
            textTransform: "none",
            color: "text.secondary",
            px: 1,
            pl: 0.5,
            "& .MuiButton-startIcon": { mr: 0.5 },
            "& .MuiButton-endIcon": { ml: 0.25 },
          }}
        >
          <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {workingDir ? folderName(workingDir) : "Folder"}
          </Box>
        </Button>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 2, width: "26rem", maxWidth: "calc(100vw - 2rem)" } } }}
      >
        <Stack spacing={1.5}>
          {locked && <Alert severity="info">{ATTACHMENTS_LOCKED_NOTE}</Alert>}
          {frozen ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Working directory
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                {workingDir ?? "None: the model uses absolute paths."}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Fixed once the chat has started. Clear context lets you choose another.
              </Typography>
            </Box>
          ) : (
            <>
              <RecentFolders folders={recent.filter((f) => f !== workingDir)} disabled={busy} onChoose={onSetWorkingDir} />
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Button size="small" variant="outlined" startIcon={<FolderOutlinedIcon />} disabled={busy} onClick={() => pick("workingDir")}>
                  Pick a folder…
                </Button>
                {workingDir && (
                  <Button size="small" disabled={busy} onClick={() => onSetWorkingDir(null)}>
                    Clear
                  </Button>
                )}
                {picking && <CircularProgress size="1.125rem" />}
              </Stack>
            </>
          )}
          {workingDir && (
            <CheckCommandField
              // Starts over when the saved command arrives or changes.
              key={`${workingDir}\n${checkCommand}`}
              command={checkCommand}
              onSave={(c) => onSetCheckCommand(workingDir, c)}
            />
          )}
          {attachments.length > 0 && (
            <>
              <Divider />
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Also allowed
                </Typography>
                {attachments.map((a) => (
                  <Stack key={a.path} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Box sx={{ display: "flex", color: "text.secondary" }}>
                      <AttachmentIcon kind={a.kind} />
                    </Box>
                    <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                      <Typography variant="body2" noWrap title={a.path}>
                        {folderName(a.path)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" component="div" noWrap>
                        {a.source === "manual" ? "You added" : "Model asked"} · {a.path}
                      </Typography>
                    </Box>
                    <Tooltip title="Remove from this session">
                      <span>
                        <IconButton size="small" disabled={locked} onClick={() => onDetach(a.path)} aria-label={`Remove ${a.path}`}>
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                ))}
              </Box>
            </>
          )}
          <Box>
            <Button size="small" startIcon={<FolderOutlinedIcon />} disabled={busy} onClick={() => pick("allow")}>
              Allow another folder…
            </Button>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </Popover>
    </>
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
    />
  );
}
