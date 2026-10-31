import { useEffect, useState } from "react";
import { Box } from "@mui/material";
import Chat from "./Chat";
import Settings from "./Settings";

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
  const settings = useHash().match(/^#\/settings(?:\/([\w-]+))?/);

  return (
    <>
      {/* Chat stays mounted under Settings so an open conversation survives a visit there. */}
      <Box sx={{ display: settings ? "none" : "block" }}>
        <Chat visible={!settings} onOpenSettings={() => (location.hash = "#/settings/connectors")} />
      </Box>
      {settings && <Settings section={settings[1] ?? "connectors"} onClose={() => (location.hash = "")} />}
    </>
  );
}
