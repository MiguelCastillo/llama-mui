import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import SmartphoneOutlinedIcon from "@mui/icons-material/SmartphoneOutlined";
import { type PhoneInfo, createPairing, getPhone, removeDevice } from "./api";
import QrCode from "./QrCode";

const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const minutes = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// Settings → Phone: a QR code that signs a phone in (see server/phones.ts), and
// the phones that are signed in.
export default function PhoneSection() {
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState<{ token: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  // How many devices there were when the code was made: one more means it was used.
  const before = useRef(0);

  const refresh = () =>
    getPhone()
      .then((i) => {
        setInfo(i);
        setAddress((a) => (i.addresses.some((x) => x.address === a) ? a : (i.addresses[0]?.address ?? "")));
        return i;
      })
      .catch((e) => {
        setError(e.message);
        return null;
      });

  useEffect(() => void refresh(), []);

  // While a code is showing: count down, and watch for the phone using it.
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      refresh().then((i) => {
        if (i && i.devices.length > before.current) {
          setPaired(i.devices.at(-1)!.name);
          setCode(null);
        }
      });
    }, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code]);

  const show = () => {
    setError(null);
    setPaired(null);
    before.current = info?.devices.length ?? 0;
    createPairing()
      .then((c) => {
        setNow(Date.now());
        setCode(c);
      })
      .catch((e) => setError(e.message));
  };

  const remove = (id: string) =>
    removeDevice(id)
      .then(refresh)
      .catch((e) => setError(e.message));

  const left = code ? code.expiresAt - now : 0;
  const url = code && info ? `http://${address}:${info.port}/#/pair/${code.token}` : "";

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Phone</Typography>
        <Typography color="text.secondary">
          Open llama-mui on your phone by scanning a code. The phone must be on the same network as this computer. The code
          works once, for five minutes.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {paired && (
        <Alert severity="success" onClose={() => setPaired(null)}>
          Paired {paired}.
        </Alert>
      )}

      {!info ? (
        <CircularProgress sx={{ alignSelf: "center" }} />
      ) : !info.reachable ? (
        <Alert severity="info">
          llama-mui is only listening on this computer, so a phone can't reach it. Stop it and start it with{" "}
          <code>npm run prod:lan</code>, then come back here.
        </Alert>
      ) : info.addresses.length === 0 ? (
        <Alert severity="warning">This computer has no network address to reach it by. Connect it to a network first.</Alert>
      ) : (
        <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
          {info.addresses.length > 1 && (
            <TextField select size="small" label="Network" value={address} onChange={(e) => setAddress(e.target.value)} sx={{ minWidth: "16rem" }}>
              {info.addresses.map((a) => (
                <MenuItem key={a.address} value={a.address}>
                  {a.address} ({a.name})
                </MenuItem>
              ))}
            </TextField>
          )}
          {code && left > 0 ? (
            <>
              <QrCode text={url} label="QR code that pairs a phone with llama-mui" />
              <Typography variant="body2" color="text.secondary">
                Scan it with your phone's camera. Expires in {minutes(left)}.
              </Typography>
              <Button size="small" onClick={show}>
                New code
              </Button>
            </>
          ) : (
            <>
              {code && <Alert severity="warning">That code expired.</Alert>}
              <Button variant="contained" startIcon={<SmartphoneOutlinedIcon />} onClick={show}>
                Show QR code
              </Button>
            </>
          )}
        </Stack>
      )}

      {info && info.devices.length > 0 && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Paired devices
          </Typography>
          <Stack spacing={1}>
            {info.devices.map((d) => (
              <Paper key={d.id} variant="outlined" sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1 }}>
                <SmartphoneOutlinedIcon color="action" />
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body1">{d.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Paired {when(d.pairedAt)} · last used {when(d.lastSeen)}
                  </Typography>
                </Box>
                <Tooltip title="Sign this device out">
                  <IconButton size="small" onClick={() => remove(d.id)} aria-label={`Remove ${d.name}`}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
