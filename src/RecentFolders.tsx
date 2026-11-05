import { Box, List, ListItemButton, ListItemIcon, ListItemText, Typography } from "@mui/material";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";

// The folders chosen lately, newest first, as a list to pick from: the folder's
// name at the left and its path, dimmed, at the right. Used wherever a folder is
// chosen (Session settings' working directory, and the prompt that asks you to
// find a folder), so both look the same. Nothing shows without folders.
export default function RecentFolders({
  folders,
  onChoose,
  disabled = false,
}: {
  folders: string[];
  onChoose: (folder: string) => void;
  disabled?: boolean;
}) {
  if (folders.length === 0) return null;
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Recent
      </Typography>
      <List dense disablePadding>
        {folders.map((f) => (
          <ListItemButton key={f} disabled={disabled} onClick={() => onChoose(f)} sx={{ borderRadius: 1, py: 0 }}>
            <ListItemIcon sx={{ minWidth: "2.25rem" }}>
              <FolderOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={f.split("/").filter(Boolean).at(-1) ?? f}
              slotProps={{ primary: { variant: "body1", noWrap: true } }}
              sx={{ flex: "0 0 auto", maxWidth: "50%" }}
            />
            <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, textAlign: "right", ml: 2, color: "text.disabled" }}>
              ({f})
            </Typography>
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
