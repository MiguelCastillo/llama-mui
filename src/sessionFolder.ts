// Small rules of the message box's folder chip, apart from the component so
// they can be tested.

// Shown, and used as the error, when the working directory or the allowed
// folders are changed while a plan or a reply runs.
export const ATTACHMENTS_LOCKED_NOTE =
  "Folders can't change while a plan or a reply is running. Pause the plan, stop the reply, or wait until it finishes.";

// The last part of a path, which is what the chip shows ("/a/b/app" -> "app").
export const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

// The chip is a picker until the chat's first reply fixes the folder the system
// prompt names (Session.promptDir; see makeReply), and again after Clear context
// puts it back to undefined. In between the working directory can't change
// without the prompt going stale, so the chip is only a label.
export const folderIsFrozen = (promptDir: string | null | undefined) => promptDir !== undefined;

// A new chat starts in the folder of the chat that was open (a stopgap until
// sidebar groups can carry a folder). One place, so it is easy to replace:
// return null here to start new chats without one.
export const folderForNewChat = (openChatsFolder: string | null): string | null => openChatsFolder;
