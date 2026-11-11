// When the message box takes images, as the chosen model's capabilities say
// (src/connections). Only an explicit "can't read images" turns them off: a
// model whose server says nothing still gets them, as before. No React here,
// so the rule is tested on its own.

// The model's name, for the words below ("this model" when none is chosen).
const who = (model?: string) => model || "This model";

// The paperclip: whether it works, and what its tooltip says.
export function attachButton(opts: { images?: boolean; model?: string; planRunning: boolean }): { disabled: boolean; title: string } {
  if (opts.planRunning) return { disabled: true, title: "Images can't be attached while a plan is running" };
  if (opts.images === false) return { disabled: true, title: `${who(opts.model)} can't read images` };
  return { disabled: false, title: "Attach images" };
}

// What a paste or a drop says when it is refused.
export const refusedImages = (model?: string) => `${who(model)} can't read images, so the image wasn't added.`;

// What the box says about images that were added before the model changed.
export const unsentImages = (count: number, model?: string) =>
  `${count === 1 ? "This image" : `These ${count} images`} won't be sent: ${who(model).replace(/^This model$/, "this model")} can't read images.`;
