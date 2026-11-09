import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { blue } from "@mui/material/colors";
import App from "./App";

// The app's one switch color, in both schemes: MUI's dark-mode primary.
const SWITCH_ON = blue[200];

// Light and dark schemes; MUI picks one from the OS setting.
const theme = createTheme({
  // The dark scheme's text is a soft off-white, not MUI's pure white: white on
  // near-black glares over a long read.
  colorSchemes: { light: true, dark: { palette: { text: { primary: "#e3e3e3" } } } },
  // One spacing unit is 0.5rem (8px at the default size), so every p, m, gap
  // and spacing in the app scales with the browser's font size.
  spacing: (factor: number) => `${0.5 * factor}rem`,
  // Body text (replies, ideas, your messages) is a step up from MUI's 1rem, so
  // long answers are easier to read. The reading width is in characters, so the
  // chat's width follows this size.
  typography: { body1: { fontSize: "1.0625rem" } },
  components: {
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          "&.Mui-checked:not(.Mui-disabled)": { color: SWITCH_ON },
          "&.Mui-checked:not(.Mui-disabled) + .MuiSwitch-track": { backgroundColor: SWITCH_ON },
        },
      },
    },
    // Plain surface bars, not primary-colored ones: on a colored bar, switches
    // and other accent-colored controls can't show their on state.
    MuiAppBar: {
      defaultProps: { color: "inherit", elevation: 0 },
      styleOverrides: {
        root: ({ theme }) => ({
          backgroundColor: theme.palette.background.paper,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }),
      },
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
