import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalPasteImage } from "@/lib/global-paste-image";

// The node test runner has no DOM. Browser regression also exercises the real
// coordinate input, native text insertion and the mounted voucher listener.
class PasteTarget {
  constructor(private editor: boolean) {}
  closest() { return this.editor ? this : null; }
}

const image = new File(["image"], "voucher.png", { type: "image/png" });

function paste({ text = "", editor = false, handled = false, images = true, target = true } = {}) {
  return {
    defaultPrevented: handled,
    target: target ? new PasteTarget(editor) : null,
    clipboardData: {
      getData: (type: string) => type === "text/plain" ? text : "",
      items: images ? [{ type: "image/png", getAsFile: () => image }] : [],
    },
  } as unknown as ClipboardEvent;
}

beforeEach(() => vi.stubGlobal("Element", PasteTarget));
afterEach(() => vi.unstubAllGlobals());

describe("global voucher paste respects text editors and local handlers", () => {
  it.each([
    "-12.04318, -77.02824",
    "-6.7648934, -79.8503941",
    "https://www.google.com/maps?q=-12.04318,-77.02824",
    "Av. Lima 123",
    "149.00",
  ])("leaves mixed text/image clipboard to the editor: %s", (text) => {
    expect(globalPasteImage(paste({ text, editor: true }))).toBeNull();
  });

  it("continues accepting an image-only voucher while a field is focused", () => {
    expect(globalPasteImage(paste({ editor: true }))).toBe(image);
  });

  it("accepts an image outside a text editor even if it also contains text", () => {
    expect(globalPasteImage(paste({ text: "voucher description" }))).toBe(image);
  });

  it("does not also attach an image already handled by the conversation composer", () => {
    expect(globalPasteImage(paste({ editor: true, handled: true }))).toBeNull();
  });

  it("respects a local image-only rejection, such as the coordinate field", () => {
    expect(globalPasteImage(paste({ handled: true }))).toBeNull();
  });

  it("leaves ordinary plain text alone", () => {
    expect(globalPasteImage(paste({ text: "-12.04, -77.02", editor: true, images: false }))).toBeNull();
  });

  it("accepts an image even when no element is the event target", () => {
    expect(globalPasteImage(paste({ target: false }))).toBe(image);
  });

  it("handles a clipboard without accessible data", () => {
    expect(globalPasteImage({ defaultPrevented: false, target: null, clipboardData: null } as ClipboardEvent)).toBeNull();
  });

  it("ignores clipboard image entries without a readable file", () => {
    const event = paste();
    Object.defineProperty(event, "clipboardData", { value: { items: [{ type: "image/png", getAsFile: () => null }] } });
    expect(globalPasteImage(event)).toBeNull();
  });
});
