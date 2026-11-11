import { useSyncExternalStore } from "react";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type { MessageBox } from "./messageBox";
import { PanelButton } from "./Panel";

// The Edit button on a message you sent, or on one waiting in the queue: it
// needs an empty message box to put the message in. It lives in a hover
// toolbar, which draws it only while it shows, so it reads the store when it
// is drawn and listens to it only while it is on screen (for typing while a
// message is hovered). Buttons that aren't drawn aren't told anything, so
// typing in a long chat updates at most the one or two that are showing, and
// only when the box goes from empty to typed or back.
export default function EditButton({ onEdit, box }: { onEdit: () => void; box: MessageBox }) {
  // Only whether the box is empty: typing more redraws nothing here.
  const empty = useSyncExternalStore(box.subscribe, box.isEmpty);
  return (
    <PanelButton
      label={empty ? "Edit" : "Edit: the message box must be empty"}
      icon={<EditOutlinedIcon />}
      onClick={onEdit}
      disabled={!empty}
    />
  );
}
