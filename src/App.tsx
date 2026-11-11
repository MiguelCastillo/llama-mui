import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import Chat from "./Chat";
import Settings from "./Settings";
import Welcome from "./Welcome";
import { ApiError, getConnectors } from "./api";
import Pair from "./Pair";
import { WELCOME_HASH, hasWelcomeMarker, settingsHash, welcomeHidden, welcomeRedirect } from "./welcomeState";
import { openChatHash, routeSession } from "./sessionRoute";

// Hash routes: "" and "#/session/<id>" are chat, "#/settings/<section>" is
// settings. Hash routing needs no server support and survives reloads. Chat
// itself follows session addresses after load (back and forward), so it is
// never remounted for them.
function useHash() {
  // Before anything reads the address, so a page opened on a session address
  // has Chat's first load find the chat it names.
  const [hash, setHash] = useState(() => {
    routeSession(location.hash, localStorage);
    return location.hash;
  });
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const settings = hash.match(/^#\/settings(?:\/([\w-]+))?/);
  // "?from=welcome" on the address: the user came from the getting-started checklist.
  const welcome = hasWelcomeMarker(hash);

  const onWelcome = /^#\/welcome/.test(hash);
  // "#/pair/<code>": a phone that scanned the QR code in Settings → Phone.
  const pairing = hash.match(/^#\/pair\/([\w-]+)/);

  // On load, a first-time user (no connectors, checklist not exited) goes to
  // the checklist; nothing shows until that's known. A page opened straight
  // on Settings is left alone, and later navigation never redirects.
  const [booted, setBooted] = useState(false);
  // The server turned this device away: it isn't this computer and isn't paired.
  const [unpaired, setUnpaired] = useState(false);
  useEffect(() => {
    getConnectors()
      .then((l) => welcomeRedirect({ connectorCount: l.connectors.length, hidden: welcomeHidden() }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setUnpaired(true);
        return "stay" as const;
      })
      .then((d) => {
        if (d === "redirect" && !/^#\/(settings|welcome)/.test(location.hash)) location.replace(WELCOME_HASH);
        setBooted(true);
      });
  }, []);
  if (pairing) return <Pair token={pairing[1]} />;
  if (unpaired) {
    return (
      <Stack sx={{ alignItems: "center", p: 3, mt: 8 }}>
        <Alert severity="info" sx={{ maxWidth: "26rem" }}>
          <Typography variant="body1">This device isn't paired.</Typography>
          On the computer running llama-mui, open Settings → Phone, show the QR code and scan it with this device.
        </Alert>
      </Stack>
    );
  }
  if (!booted) return <CircularProgress sx={{ display: "block", mx: "auto", mt: 12 }} />;

  return (
    <>
      {/* Chat stays mounted under Settings so an open conversation survives a visit there. */}
      <Box sx={{ display: settings || onWelcome ? "none" : "block" }}>
        <Chat visible={!settings && !onWelcome} onOpenSettings={() => (location.hash = settingsHash("connectors"))} />
      </Box>
      {onWelcome && <Welcome />}
      {settings && <Settings section={settings[1] ?? "connectors"} welcome={welcome} onClose={() => (location.hash = openChatHash())} />}
    </>
  );
}
