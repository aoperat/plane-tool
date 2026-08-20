import { describe, it, expect } from "vitest";
import { defaultAiModes, toggleAiMode } from "./aiModes";

describe("AI 제안 유형 선택", () => {
  it("기본은 둘 다 켜져 있다 — 지금까지의 동작과 같다", () => {
    expect(defaultAiModes()).toEqual({ refine: true, split: true });
  });

  it("하나만 끌 수 있다", () => {
    const m = toggleAiMode(defaultAiModes(), "split");
    expect(m).toEqual({ refine: true, split: false });
  });

  it("마지막 하나는 끌 수 없다 — 둘 다 끄면 보낼 부탁이 없다", () => {
    const only = toggleAiMode(defaultAiModes(), "split");
    expect(toggleAiMode(only, "refine")).toEqual(only);
  });

  it("껐던 것을 다시 켤 수 있다", () => {
    let m = toggleAiMode(defaultAiModes(), "refine");
    m = toggleAiMode(m, "refine");
    expect(m).toEqual({ refine: true, split: true });
  });
});
