import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { pairDevice } from "./api";

// What the phone opens from the QR code: trades the one-time code in the
// address for this device's sign-in (see server/phones.ts), then loads the app.
// React runs effects twice in development, and a code works once, so each code
// is sent once and both runs share the answer.
const started = new Map<string, Promise<{ ok: true; name: string }>>();

export default function Pair({ token }: { token: string }) {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    // The code is used up now; keep it out of the address and the history.
    history.replaceState(null, "", location.pathname);
    let request = started.get(token);
    if (!request) started.set(token, (request = pairDevice(token)));
    request
      .then((r) => {
        setMessage(r.name);
        setState("done");
        setTimeout(() => location.replace(location.pathname), 1200);
      })
      .catch((e) => {
        setMessage(e.message);
        setState("failed");
      });
  }, [token]);

  return (
    <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center", p: 3, mt: 8 }}>
      <Typography variant="h5">llama-mui</Typography>
      {state === "working" && <CircularProgress />}
      {state === "done" && <Typography>Paired. Opening llama-mui…</Typography>}
      {state === "failed" && (
        <Box sx={{ maxWidth: "24rem" }}>
          <Alert severity="error">{message}</Alert>
        </Box>
      )}
    </Stack>
  );
}
