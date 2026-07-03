import { describe, it, expect } from "vitest";
import { resolveDateShortcut } from "./dateShortcut";

describe("resolveDateShortcut", () => {
  it("PageDown postpones the due date", () => {
    expect(resolveDateShortcut("PageDown", false)).toEqual({ kind: "due", delta: 1 });
  });
  it("PageUp pulls the due date earlier", () => {
    expect(resolveDateShortcut("PageUp", false)).toEqual({ kind: "due", delta: -1 });
  });
  it("Ctrl+PageDown postpones the start date", () => {
    expect(resolveDateShortcut("PageDown", true)).toEqual({ kind: "start", delta: 1 });
  });
  it("Ctrl+PageUp pulls the start date earlier", () => {
    expect(resolveDateShortcut("PageUp", true)).toEqual({ kind: "start", delta: -1 });
  });
  it("ignores other keys with or without Ctrl", () => {
    expect(resolveDateShortcut("Enter", false)).toBeNull();
    expect(resolveDateShortcut("[", false)).toBeNull();
    expect(resolveDateShortcut("ArrowUp", true)).toBeNull();
  });
});
