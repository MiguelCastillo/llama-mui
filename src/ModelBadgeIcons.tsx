import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
import { Tooltip } from "@mui/material";
import type { Capabilities } from "./api";
import { BADGE_TITLES, badgesOf } from "./modelBadges";

// The small quiet icons for what a model can do (see modelBadges.ts), shared
// by the model picker and the Models pages. Inline, so they sit after the
// text they follow; nothing is drawn for a model that says nothing.
const ICONS = { images: ImageOutlinedIcon, pdf: PictureAsPdfOutlinedIcon, thinking: PsychologyOutlinedIcon };

export default function ModelBadgeIcons({ capabilities }: { capabilities?: Capabilities }) {
  return (
    <>
      {badgesOf(capabilities).map((b) => {
        const Icon = ICONS[b];
        return (
          <Tooltip key={b} title={BADGE_TITLES[b]}>
            <Icon aria-label={BADGE_TITLES[b]} sx={{ fontSize: "1rem", ml: 0.75, verticalAlign: "text-bottom" }} />
          </Tooltip>
        );
      })}
    </>
  );
}
