import { Typography } from "@mui/material";
import { projectNoteLines } from "../server/projectNote";

// A small line under the first message of the chat's current context, always
// visible, saying which project file the model was given (and, for a long file,
// the gentle recommendation). Built from the session's saved project
// instructions, not from any message's update text. Nothing for a chat without a file.
export default function ProjectInstructionsLine({ project }: { project: { file: string; text: string } | null | undefined }) {
  const lines = projectNoteLines(project);
  if (!lines.length) return null;
  return (
    <Typography variant="caption" component="div" data-testid="project-instructions" sx={{ opacity: 0.7 }}>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </Typography>
  );
}
