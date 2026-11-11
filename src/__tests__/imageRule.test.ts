import { describe, expect, it } from "vitest";
import { attachButton, refusedImages, unsentImages } from "../imageRule";
import { badgesOf, lifecycleNote } from "../modelBadges";
import { readCapabilities } from "../connections/index";
import { MODELS } from "./capabilityFixtures";

// The paperclip is off only for a model that says it can't read images; a
// model that says nothing keeps it, as before.
describe("the paperclip", () => {
  it("works for a model that reads images and for one that says nothing", () => {
    expect(attachButton({ images: true, model: "m", planRunning: false })).toEqual({ disabled: false, title: "Attach images" });
    expect(attachButton({ images: undefined, model: "m", planRunning: false })).toEqual({ disabled: false, title: "Attach images" });
  });
  it("is off for a model that can't read images, and says so", () => {
    expect(attachButton({ images: false, model: "claude-opus-5-5", planRunning: false })).toEqual({
      disabled: true,
      title: "claude-opus-5-5 can't read images",
    });
    expect(attachButton({ images: false, planRunning: false }).title).toBe("This model can't read images");
  });
  it("stays off while a plan runs, whatever the model", () => {
    expect(attachButton({ images: true, model: "m", planRunning: true })).toMatchObject({ disabled: true, title: expect.stringContaining("plan") });
  });
  it("words what happens to images already in the box, and to a refused paste", () => {
    expect(unsentImages(1, "m")).toBe("This image won't be sent: m can't read images.");
    expect(unsentImages(3, "m")).toBe("These 3 images won't be sent: m can't read images.");
    expect(refusedImages("m")).toContain("m can't read images");
  });
});

describe("the picker's badges", () => {
  it("show only what the server says the model can do", () => {
    expect(badgesOf(readCapabilities(MODELS["claude-sonnet-5-5"]))).toEqual(["images", "pdf", "thinking"]);
    expect(badgesOf(readCapabilities(MODELS["claude-opus-5-5"]))).toEqual(["thinking"]);
    expect(badgesOf(undefined)).toEqual([]);
    expect(badgesOf({ adaptiveThinking: false, efforts: [] })).toEqual([]);
  });
  it("note a deprecated model with its retirement date", () => {
    expect(lifecycleNote(readCapabilities(MODELS["claude-haiku-4-5-20251001"]))).toBe("Deprecated, retires 2027-02-01");
    expect(lifecycleNote(readCapabilities(MODELS["claude-sonnet-5-5"]))).toBeUndefined();
    expect(lifecycleNote({ adaptiveThinking: false, efforts: [], deprecated: true })).toBe("Deprecated");
  });
});
