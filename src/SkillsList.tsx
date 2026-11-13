import { Alert, Box, Stack, Typography } from "@mui/material";
import type { SkillList } from "./api";

// Settings → Agent: the skills the model can open, where they are kept, and any
// skill files that couldn't be used. Read-only: skills are folders edited by hand.
export default function SkillsList({ list }: { list: SkillList }) {
  return (
    <Stack spacing={1.5} data-testid="skills-list">
      <Box>
        <Typography variant="h6">Skills</Typography>
        <Typography color="text.secondary">
          A skill is a folder with a SKILL.md file in <code>{list.folder}</code>. The model sees each skill's name and
          description, and opens the full instructions when a task matches.
        </Typography>
      </Box>
      {list.skills.length === 0 ? (
        <Typography color="text.secondary" data-testid="skills-none">
          No skills yet.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {list.skills.map((s) => (
            <Typography key={s.name} variant="body2">
              <strong>{s.name}</strong> — {s.description}
            </Typography>
          ))}
        </Stack>
      )}
      {list.problems.length > 0 && (
        <Alert severity="warning" data-testid="skills-problems">
          Some skill files had problems:
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {list.problems.map((p) => (
              <li key={p.file}>{p.message}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Stack>
  );
}
