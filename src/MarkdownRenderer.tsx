import { type ReactNode, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box, IconButton, Link, Typography, type SxProps, type Theme } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

const codeInlineStyle: SxProps<Theme> = {
  fontFamily: "monospace",
  fontSize: "0.85em",
  bgcolor: "action.hover",
  px: 0.5,
  borderRadius: 0.5,
};

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <Box sx={{ position: "relative", my: 1.5 }}>
      <Box component="pre" ref={ref} sx={{ m: 0, p: 1.5, pr: 5, overflowX: "auto", bgcolor: "action.hover", borderRadius: 1, fontFamily: "monospace", fontSize: "0.85em", "& code": { bgcolor: "transparent", p: 0, fontSize: "inherit" } }}>{children}</Box>
      <IconButton size="small" aria-label="Copy code" onClick={() => navigator.clipboard.writeText(ref.current?.innerText ?? "").catch(() => {})} sx={{ position: "absolute", top: 4, right: 4 }}>
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <Box
      component="div"
      sx={{
        "& > :first-child": { mt: 0 },
        "& > :last-child": { mb: 0 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ children }) => <Box component="code" sx={codeInlineStyle}>{children}</Box>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          p: ({ children }) => (
            <Typography variant="body1" sx={{ my: 1, maxWidth: "100%" }}>
              {children}
            </Typography>
          ),
          ul: ({ children }) => <Box component="ul" sx={{ my: 1, pl: 3 }}>{children}</Box>,
          ol: ({ children }) => <Box component="ol" sx={{ my: 1, pl: 3 }}>{children}</Box>,
          li: ({ children }) => <Box component="li" sx={{ my: 0.25 }}>{children}</Box>,
          a: ({ href, children }) => <Link href={href} target="_blank" rel="noopener noreferrer">{children}</Link>,
          img: ({ src, alt }) => <Link href={src} target="_blank" rel="noopener noreferrer">{alt || src}</Link>,
          h1: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
              {children}
            </Typography>
          ),
          h2: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
              {children}
            </Typography>
          ),
          h3: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1.5, mb: 0.75 }}>
              {children}
            </Typography>
          ),
          h4: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1.5, mb: 0.75 }}>
              {children}
            </Typography>
          ),
          h5: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1.25, mb: 0.75 }}>
              {children}
            </Typography>
          ),
          h6: ({ children }) => (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1.25, mb: 0.75 }}>
              {children}
            </Typography>
          ),
          table: ({ children }) => (
            <Box sx={{ overflowX: "auto", my: 1.5 }}>
              <Box component="table" sx={{ borderCollapse: "collapse", minWidth: "100%" }}>{children}</Box>
            </Box>
          ),
          th: ({ children }) => (
            <Box component="th" sx={{ textAlign: "left", fontWeight: 600, p: 0.75, borderBottom: 1, borderColor: "divider" }}>{children}</Box>
          ),
          td: ({ children }) => (
            <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: "divider" }}>{children}</Box>
          ),
          blockquote: ({ children }) => (
            <Box component="blockquote" sx={{ borderLeft: 3, borderColor: "divider", pl: 2, mx: 0, my: 1.5, color: "text.secondary" }}>{children}</Box>
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
