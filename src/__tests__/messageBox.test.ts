import { describe, expect, it, vi } from "vitest";
import { createMessageBox, type PendingImage } from "../messageBox";

// Drafts kept in a plain object instead of the browser's storage.
function memoryDrafts(initial: Record<string, string> = {}) {
  const saved = { ...initial };
  return { saved, load: (id: string) => saved[id] ?? "", save: (id: string, text: string) => void (saved[id] = text) };
}

const image = (name: string): PendingImage => ({ blob: new Blob(), preview: `blob:${name}`, name });

describe("createMessageBox", () => {
  it("starts with the chat's saved draft and no images", () => {
    const box = createMessageBox("a", memoryDrafts({ a: "half typed" }));
    expect(box.get()).toEqual({ text: "half typed", images: [], documents: [] });
    expect(box.isEmpty()).toBe(false);
  });

  it("is not empty with only a document", () => {
    const box = createMessageBox("a", memoryDrafts());
    box.setDocuments([{ name: "a.txt", text: "hi", truncated: false }]);
    expect(box.isEmpty()).toBe(false);
  });

  it("is empty with only spaces and no images, and not with an image", () => {
    const box = createMessageBox("a", memoryDrafts());
    box.setText("   ");
    expect(box.isEmpty()).toBe(true);
    box.setImages([image("one")]);
    expect(box.isEmpty()).toBe(false);
  });

  it("keeps every change of the text as the chat's draft", () => {
    const drafts = memoryDrafts();
    const box = createMessageBox("a", drafts);
    box.setText("hello");
    expect(drafts.saved.a).toBe("hello");
    box.fill("from Edit");
    expect(drafts.saved.a).toBe("from Edit");
  });

  it("shows another chat's draft when that chat is opened", () => {
    const box = createMessageBox("a", memoryDrafts({ b: "for b" }));
    box.setText("for a");
    box.show("b");
    expect(box.sessionId()).toBe("b");
    expect(box.get().text).toBe("for b");
  });

  it("only changes the draft of a chat that is no longer shown", () => {
    const drafts = memoryDrafts();
    const box = createMessageBox("a", drafts);
    box.show("b");
    box.setText("typed in b");
    box.setTextFor("a", "");
    expect(drafts.saved.a).toBe("");
    expect(box.get().text).toBe("typed in b");
  });

  it("fill adds its images to the ones there and asks the box to focus", () => {
    const box = createMessageBox("a", memoryDrafts());
    const focus = vi.fn();
    box.onFill(focus);
    box.setImages([image("one")]);
    box.fill("text", [image("two")]);
    expect(box.get().images.map((i) => i.name)).toEqual(["one", "two"]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the same content object until something changes", () => {
    const box = createMessageBox("a", memoryDrafts());
    const before = box.get();
    box.setText("");
    expect(box.get()).toBe(before);
    box.setText("x");
    expect(box.get()).not.toBe(before);
  });

  it("calls listeners on a change and stops once unsubscribed", () => {
    const box = createMessageBox("a", memoryDrafts());
    const listener = vi.fn();
    const stop = box.subscribe(listener);
    box.setText("x");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    box.setText("xy");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
