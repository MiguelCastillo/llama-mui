// Plans: the steps of a task, from the model's update_plan calls. Small models
// say they're done when they aren't, so chat runs a plan one step per turn and
// checks each step with reviewStep before ticking it off.
//
// Plan logic (planFromCall, stepPrompt, filesChanged, weighDispute, etc.) has
// been moved to src/agent/plan.ts. This file re-exports those and keeps the
// React UI components (PlanView, ProposalView).

export {
  PLANNING_NOTE,
  planFromCall,
  stepPrompt,
  filesChanged,
  CHECK_TOOLS,
  checkRoom,
  reviewStep,
  commandFailedPrompt,
  disputePrompt,
  disputeHolds,
  disputeNote,
} from "./agent/plan";
export type { WholeFile, Dispute } from "./agent/plan";

export { PlanView } from "./PlanView";
