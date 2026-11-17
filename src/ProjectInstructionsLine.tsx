import { Typography } from "@mui/material";

// The lines of a chat update that tell about the project's instructions
// ("Project instructions loaded: AGENTS.md", and for a long file, "Project instructions are long (…); keeping AGENTS.md under 20,000 is recommended.").
// Empty when the update has none, so nothing is shown for a chat without a file.
export const projectInstructionLines = (update: string | undefined): string[] =>
  (update ?? "").split("\n").filter((l) => l.startsWith("Project instructions "));

// A small line under a chat's first message, always visible, saying which
// project file the model was given.
export default function ProjectInstructionsLine({ update }: { update: string | undefined }) {
  const lines = projectInstructionLines(update);
  if (!lines.length) return null;
  return (
    <Typography variant="caption" component="div" data-testid="project-instructions" sx={{ opacity: 0.7 }}>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </Typography>
  );
}
