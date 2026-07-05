import { describe, it, expect } from "vitest";
import { captureFromKeyEvent, codeToKey, type KeyLike } from "./hotkey";

function ev(partial: Partial<KeyLike>): KeyLike {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  };
}

describe("captureFromKeyEvent", () => {
  it("commits a bare F-key", () => {
    expect(captureFromKeyEvent(ev({ key: "F1", code: "F1" }))).toEqual({
      kind: "commit",
      accelerator: "F1",
    });
  });

  it("commits modifier combos in canonical Ctrl+Alt+Shift+Super order", () => {
    expect(
      captureFromKeyEvent(ev({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "commit", accelerator: "Ctrl+Shift+A" });
    expect(
      captureFromKeyEvent(ev({ key: " ", code: "Space", altKey: true })),
    ).toEqual({ kind: "commit", accelerator: "Alt+Space" });
  });

  it("uses the physical key, not the produced character", () => {
    // 한글 입력 상태에서 Ctrl+ㅁ을 눌러도 KeyA가 잡혀야 한다.
    expect(
      captureFromKeyEvent(ev({ key: "ㅁ", code: "KeyA", ctrlKey: true })),
    ).toEqual({ kind: "commit", accelerator: "Ctrl+A" });
  });

  it("reports pending while only modifiers are held", () => {
    expect(
      captureFromKeyEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true })),
    ).toEqual({ kind: "pending", display: "Ctrl+…" });
  });

  it("rejects a bare letter or Shift-only combo", () => {
    expect(captureFromKeyEvent(ev({ key: "a", code: "KeyA" })).kind).toBe("invalid");
    expect(
      captureFromKeyEvent(ev({ key: "A", code: "KeyA", shiftKey: true })).kind,
    ).toBe("invalid");
  });

  it("allows Shift with an F-key", () => {
    expect(captureFromKeyEvent(ev({ key: "F2", code: "F2", shiftKey: true }))).toEqual({
      kind: "commit",
      accelerator: "Shift+F2",
    });
  });

  it("ignores unmapped keys like numpad", () => {
    expect(
      captureFromKeyEvent(ev({ key: "1", code: "Numpad1", ctrlKey: true })).kind,
    ).toBe("ignore");
  });
});

describe("codeToKey", () => {
  it("maps letters, digits, F-keys, and named keys", () => {
    expect(codeToKey("KeyQ")).toBe("Q");
    expect(codeToKey("Digit7")).toBe("7");
    expect(codeToKey("F12")).toBe("F12");
    expect(codeToKey("ArrowUp")).toBe("Up");
    expect(codeToKey("Comma")).toBe("Comma");
  });
  it("returns null for unsupported codes", () => {
    expect(codeToKey("NumpadAdd")).toBeNull();
    expect(codeToKey("MediaPlayPause")).toBeNull();
  });
});
