import { Button, Paper } from "@mui/material";
import { threadLabel, type ThreadStatus } from "./planThread";

// The one-line note where a plan moved out to its own session (a thread):
// "Running in a thread: <summary>", or Done / Failed / Not finished once the
// thread's saved state is known. A click opens the thread.
export default function ThreadNote({
  summary,
  status,
  onOpen,
}: {
  summary: string;
  status: ThreadStatus | undefined;
  onOpen: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ my: 1, px: 1, py: 0.5 }}>
      <Button
        size="small"
        onClick={onOpen}
        disabled={status === "missing"}
        sx={{ textTransform: "none", justifyContent: "flex-start", textAlign: "left", width: "100%" }}
      >
        {threadLabel(status, summary)}
      </Button>
    </Paper>
  );
}
