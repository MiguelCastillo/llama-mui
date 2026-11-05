import qrcode from "qrcode-generator";
import { Box } from "@mui/material";

// A QR code for `text`, drawn as one SVG path. Always black on white, whatever
// the theme, since a scanner needs the contrast and the quiet border. The
// numbers in the drawing are its own units (one module is 1); the size on the
// page is in rem.
export default function QrCode({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // modules of white around it, the minimum the standard asks for
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      sx={{ width: "100%", maxWidth: "18rem", height: "auto", display: "block", borderRadius: "4px" }}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </Box>
  );
}
