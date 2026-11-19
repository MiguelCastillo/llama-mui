// !! PRINCIPLE (see AGENTS.md, "THE SERVER DECIDES WHAT A PLAN CARD CAN DO") !!
// The server decides which actions a chat offers (server/allowedActions.ts) and
// sends the list with the session; the page only draws what is listed, and
// draws nothing until the list has arrived. The page may remove an action for a
// reason only it knows (no model chosen removes "send"), never add one. Do not
// put rules for which action is allowed in the page.
//
// The names the server may list, and the one place the page turns the server's
// list into what it draws.

export type Action =
  | "run" // start the plan that hasn't started
  | "continue" // go on with a plan that has
  | "pause"
  | "discard"
  | "clone"
  | "edit" // change the plan's steps
  | "resend" // send the failed message again
  | "send" // type and send a message
  | "changeEnvironment" // change the model, connection, folders or approvals
  | "takeOver";

// What the page draws: nothing until the chat has loaded and the server has
// answered; then exactly the server's list, minus "send" when no model is
// chosen and no run is going. It never adds an action.
export function drawnActions(
  loaded: boolean,
  serverList: readonly string[],
  hasModel: boolean,
  runActive: boolean,
): ReadonlySet<Action> {
  if (!loaded) return new Set();
  return new Set((serverList as readonly Action[]).filter((a) => a !== "send" || hasModel || runActive));
}

// A past plan is finished: the one thing it offers is Clone, only if listed.
export function pastPlanActions(allowed: ReadonlySet<Action>): ReadonlySet<Action> {
  return new Set<Action>(allowed.has("clone") ? ["clone"] : []);
}
