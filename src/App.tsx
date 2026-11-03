import { useEffect, useState } from "react";
import { Box, CircularProgress } from "@mui/material";
import Chat from "./Chat";
import Settings from "./Settings";
import Welcome from "./Welcome";
import { getConnectors } from "./api";
import { WELCOME_HASH, hasWelcomeMarker, settingsHash, welcomeHidden, welcomeRedirect } from "./welcomeState";

// Hash routes: "" is chat, "#/settings/<section>" is settings. Hash routing
// needs no server support and survives reloads.
function useHash() {
  const [hash, setHash] = useState(location.hash);
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

  // On load, a first-time user (no connectors, checklist not exited) goes to
  // the checklist; nothing shows until that's known. A page opened straight
  // on Settings is left alone, and later navigation never redirects.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    getConnectors()
      .then((l) => welcomeRedirect({ connectorCount: l.connectors.length, hidden: welcomeHidden() }))
      .catch(() => "stay" as const)
      .then((d) => {
        if (d === "redirect" && !/^#\/(settings|welcome)/.test(location.hash)) location.replace(WELCOME_HASH);
        setBooted(true);
      });
  }, []);
  if (!booted) return <CircularProgress sx={{ display: "block", mx: "auto", mt: 12 }} />;

  return (
    <>
      {/* Chat stays mounted under Settings so an open conversation survives a visit there. */}
      <Box sx={{ display: settings || onWelcome ? "none" : "block" }}>
        <Chat visible={!settings && !onWelcome} onOpenSettings={() => (location.hash = settingsHash("connectors"))} />
      </Box>
      {onWelcome && <Welcome />}
      {settings && <Settings section={settings[1] ?? "connectors"} welcome={welcome} onClose={() => (location.hash = "")} />}
    </>
  );
}
