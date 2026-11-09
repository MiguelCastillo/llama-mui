import { type ReactNode, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Box, IconButton, Link, Typography } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import { copyText } from "./clipboard";
import { PanelButton, PanelToolbar, revealToolbarSx } from "./Panel";

// On the user's primary-colored bubble the theme's greys disappear, so code
// is tinted darker there.

// The system's own code font where there is one (SF Mono on a Mac), which reads
// better at a small size than the browser's default monospace.
const CODE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const codeInlineStyle = {
  fontFamily: CODE_FONT,
  fontSize: "0.85em",
  bgcolor: "action.hover",
  px: 0.5,
  borderRadius: 0.5,
};

function CodeBlock({ children, tint }: { children?: ReactNode; tint: string }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <Box sx={{ position: "relative", my: 2 }}>
      <Box component="pre" ref={ref} sx={{ m: 0, p: 1.5, pr: 5, overflowX: "auto", bgcolor: tint, borderRadius: 1, fontFamily: CODE_FONT, fontSize: "0.85em", "& code": { bgcolor: "transparent", p: 0, fontSize: "inherit" } }}>{children}</Box>
      <IconButton size="small" aria-label="Copy code" onClick={() => void copyText(ref.current?.innerText ?? "")} sx={{ position: "absolute", top: 4, right: 4 }}>
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

// A table is as wide as its columns need, not stretched to the chat's width, so
// a short row isn't spread far apart. Its hover toolbar, the same one the panels
// have, stretches it to the chat's width and back. A table wider than the chat
// scrolls sideways either way. A tinted header row and a faint stripe on every
// other row help the eye follow a row across.
function Table({ children }: { children?: ReactNode }) {
  const [full, setFull] = useState(false);
  return (
    <Box sx={{ position: "relative", width: full ? "100%" : "fit-content", maxWidth: "100%", my: 2, ...revealToolbarSx }}>
      <Box sx={{ overflowX: "auto" }}>
        <Box
          component="table"
          sx={{
            borderCollapse: "collapse",
            width: full ? "100%" : undefined,
            "& tbody tr:nth-of-type(even)": { bgcolor: "action.hover" },
          }}
        >
          {children}
        </Box>
      </Box>
      <PanelToolbar>
        <PanelButton
          label={full ? "Fit table to its columns" : "Stretch table to chat width"}
          icon={full ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
          pressed={full}
          onClick={() => setFull((f) => !f)}
        />
      </PanelToolbar>
    </Box>
  );
}

// What every heading level shares: a tight line height (the default is made for
// body-size text, and a big heading would float in it).
const headingSx = { lineHeight: 1.3 } as const;

// breaks: a single line break stays a line break, as in what the user typed.
// The text fills whatever width it is given: how long a line gets is decided by
// the width of the chat's container (CHAT_MAX_WIDTH in Chat.tsx), not here.
export default function MarkdownRenderer({
  content,
  breaks = false,
}: {
  content: string;
  breaks?: boolean;
}) {
  const tint = "action.hover";

  return (
    <Box
      component="div"
      sx={{
        "& > :first-child": { mt: 0 },
        "& > :last-child": { mb: 0 },
        // What follows a heading hugs it. Margins between neighbours collapse
        // to the larger one, so without this the paragraph's own top margin
        // would win and a heading would float as far from its text as from the
        // section above it.
        "& > :is(h1, h2, h3, h4, h5, h6) + *": { mt: 0 },
        overflowWrap: "break-word",
      }}
    >
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={{
          code: ({ children }) => <Box component="code" sx={{ ...codeInlineStyle, bgcolor: tint }}>{children}</Box>,
          pre: ({ children }) => <CodeBlock tint={tint}>{children}</CodeBlock>,
          p: ({ children }) => (
            <Typography variant="body1" sx={{ my: 2, maxWidth: "100%", lineHeight: 1.65 }}>
              {children}
            </Typography>
          ),
          ul: ({ children }) => <Box component="ul" sx={{ my: 2, pl: 3 }}>{children}</Box>,
          ol: ({ children }) => <Box component="ol" sx={{ my: 2, pl: 3 }}>{children}</Box>,
          // Room between items, so wrapped ones don't blur together; a list
          // inside an item sits close to it, not a paragraph's distance away.
          li: ({ children }) => (
            <Box component="li" sx={{ my: 0.75, lineHeight: 1.65, "& > ul, & > ol": { my: 0.5 } }}>
              {children}
            </Box>
          ),
          a: ({ href, children }) => <Link href={href} target="_blank" rel="noopener noreferrer">{children}</Link>,
          img: ({ src, alt }) => <Link href={src} target="_blank" rel="noopener noreferrer">{alt || src}</Link>,
          // A hierarchy: each level is a step smaller than the one above, none
          // smaller than the body text, with much more room above than below.
          h1: ({ children }) => (
            <Typography variant="subtitle1" component="h1" sx={{ ...headingSx, fontSize: "1.6rem", fontWeight: 700, mt: 4, mb: 1.25 }}>
              {children}
            </Typography>
          ),
          h2: ({ children }) => (
            <Typography variant="subtitle1" component="h2" sx={{ ...headingSx, fontSize: "1.4rem", fontWeight: 700, mt: 3.5, mb: 1 }}>
              {children}
            </Typography>
          ),
          h3: ({ children }) => (
            <Typography variant="subtitle1" component="h3" sx={{ ...headingSx, fontSize: "1.2rem", fontWeight: 700, mt: 3, mb: 0.75 }}>
              {children}
            </Typography>
          ),
          h4: ({ children }) => (
            <Typography variant="subtitle1" component="h4" sx={{ ...headingSx, fontSize: "1.0625rem", fontWeight: 700, mt: 3, mb: 0.5 }}>
              {children}
            </Typography>
          ),
          h5: ({ children }) => (
            <Typography variant="subtitle1" component="h5" sx={{ ...headingSx, fontSize: "1.0625rem", fontWeight: 600, mt: 2.5, mb: 0.5 }}>
              {children}
            </Typography>
          ),
          h6: ({ children }) => (
            <Typography variant="subtitle1" component="h6" sx={{ ...headingSx, fontSize: "1rem", fontWeight: 600, color: "text.secondary", mt: 2.5, mb: 0.5 }}>
              {children}
            </Typography>
          ),
          // Passed as is, not wrapped in an arrow, so the same component is used on
          // every render and the width a table was given survives a re-render.
          table: Table,
          th: ({ children }) => (
            <Box component="th" sx={{ textAlign: "left", fontWeight: 700, px: 1.25, py: 0.75, bgcolor: "action.selected", borderBottom: 2, borderColor: "divider" }}>{children}</Box>
          ),
          td: ({ children }) => (
            <Box component="td" sx={{ px: 1.25, py: 0.75, borderBottom: 1, borderColor: "divider" }}>{children}</Box>
          ),
          // A bar and a tint, so a quote stands apart from the paragraphs around it.
          blockquote: ({ children }) => (
            <Box
              component="blockquote"
              sx={{ borderLeft: 4, borderColor: "divider", bgcolor: "action.hover", borderRadius: 1, pl: 2, pr: 2, mx: 0, my: 2, color: "text.secondary", "& > p": { my: 1 } }}
            >
              {children}
            </Box>
          ),
          hr: () => <Box component="hr" sx={{ my: 2, border: 0, borderTop: 1, borderColor: "divider" }} />,
          strong: ({ children }) => <strong>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}
