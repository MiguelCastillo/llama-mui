// The rule the model gets about how big a piece of work is and where it is
// done: in the main chat, or as a plan. The wording lives here, in one place,
// so it can later be made configurable.

export const DEFAULT_WORK_POLICY =
  "Decide by size. If the work is simple and can be done in one go (one small change, or a command or two), " +
  "do it here in the chat: the user is asked to approve each change or command. " +
  "If it needs several steps, touches several files, or needs checking along the way, write a plan with update_plan and stop. " +
  "If you start and find it is bigger than it looked, stop and make a plan. " +
  "Questions need no plan.";

// The custom text when it has any content, else the default.
export function workPolicy(custom?: string): string {
  const text = custom?.trim();
  return text ? text : DEFAULT_WORK_POLICY;
}
