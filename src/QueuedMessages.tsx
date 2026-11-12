import { Box, Button, Stack, Typography } from "@mui/material";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import type { QueuedMessage } from "./api";
import { splitMessage } from "./documents";
import type { MessageBox } from "./messageBox";
import EditButton from "./EditButton";
import Panel, { PanelButton } from "./Panel";

// The messages sent while a reply was running, waiting to go in order. They sit
// under the running reply in the lighter "queued" look, each with Edit (takes it
// back into the message box) and Remove in the panel's hover toolbar. While the
// queue is paused (the reply was stopped or failed) one quiet line says why and
// offers Send next and Clear queue. The queue is the session's, so every window
// that has the chat open shows the same list.

function QueuedItem({
  item,
  sessionId,
  box,
  onEdit,
  onRemove,
}: {
  item: QueuedMessage;
  sessionId: string;
  box: MessageBox;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // Files inlined in the message show by name, not as their text.
  const { words, files } = splitMessage(item.text);
  return (
    <Box sx={{ alignSelf: "flex-end", width: "100%", display: "flex", justifyContent: "flex-end" }} data-queued={item.id}>
      <Panel
        variant="queued"
        tools={
          <>
            <EditButton onEdit={onEdit} box={box} />
            <PanelButton label="Remove" icon={<DeleteOutlinedIcon />} onClick={onRemove} />
          </>
        }
      >
        {item.replyTo && (
          <Typography
            variant="caption"
            component="div"
            sx={{ mb: 0.5, pl: 1, borderLeft: 2, borderColor: "divider", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {item.replyTo}
          </Typography>
        )}
        <Typography
          sx={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 6,
            overflow: "hidden",
          }}
        >
          {words}
        </Typography>
        {files.length > 0 && (
          <Typography variant="caption" component="div" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {files.map((f) => (f.truncated ? `${f.name} (cut)` : f.name)).join(", ")}
          </Typography>
        )}
        {item.images && item.images.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
            {item.images.map((img) => (
              <Box
                component="img"
                key={img.id}
                src={`/api/sessions/${sessionId}/images/${img.id}`}
                alt={img.mediaType}
                sx={{ width: "3rem", height: "3rem", objectFit: "cover", borderRadius: 0.5, border: "1px solid", borderColor: "divider" }}
              />
            ))}
          </Stack>
        )}
      </Panel>
    </Box>
  );
}

export default function QueuedMessages({
  items,
  paused,
  reason,
  sessionId,
  box,
  replyRunning,
  onEdit,
  onRemove,
  onSendNext,
  onClear,
}: {
  items: QueuedMessage[];
  paused: boolean;
  // Why it is paused, in a few words (see pausedReason).
  reason: string;
  sessionId: string;
  box: MessageBox;
  // A reply is running: Send next waits for it.
  replyRunning: boolean;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  onSendNext: () => void;
  onClear: () => void;
}) {
  if (!items.length) return null;
  return (
    <Stack spacing={1} data-queue sx={{ alignItems: "stretch" }}>
      {items.map((item) => (
        <QueuedItem key={item.id} item={item} sessionId={sessionId} box={box} onEdit={() => onEdit(item)} onRemove={() => onRemove(item)} />
      ))}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", rowGap: 0.5 }}>
        {paused ? (
          <>
            <Typography variant="caption" color="text.secondary">
              {reason}. Nothing is sent until you choose.
            </Typography>
            <Button size="small" onClick={onSendNext} disabled={replyRunning}>
              Send next
            </Button>
            <Button size="small" color="inherit" onClick={onClear}>
              Clear queue
            </Button>
          </>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {items.length === 1 ? "1 message waiting" : `${items.length} messages waiting`}, sent in order when the reply ends
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
