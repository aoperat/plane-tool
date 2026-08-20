import { describe, it, expect } from "vitest";
import { defaultAiModes, toggleAiMode, stripProjectName } from "./aiModes";

describe("AI 제안 유형 선택", () => {
  it("기본은 전부 켜져 있다 — 프로젝트명 제거 포함", () => {
    expect(defaultAiModes()).toEqual({ refine: true, split: true, stripProject: true });
  });

  it("하나만 끌 수 있다", () => {
    const m = toggleAiMode(defaultAiModes(), "split");
    expect(m.split).toBe(false);
    expect(m.refine).toBe(true);
  });

  it("다듬기·분해의 마지막 하나는 끌 수 없다 — 둘 다 끄면 보낼 부탁이 없다", () => {
    const only = toggleAiMode(defaultAiModes(), "split");
    expect(toggleAiMode(only, "refine")).toEqual(only);
  });

  it("껐던 것을 다시 켤 수 있다", () => {
    let m = toggleAiMode(defaultAiModes(), "refine");
    m = toggleAiMode(m, "refine");
    expect(m.refine).toBe(true);
  });

  it("프로젝트명 제거는 자유롭게 끄고 켠다 — 마지막-하나 제한과 무관하다", () => {
    let m = toggleAiMode(defaultAiModes(), "split");
    m = toggleAiMode(m, "stripProject");
    expect(m.stripProject).toBe(false);
    m = toggleAiMode(m, "stripProject");
    expect(m.stripProject).toBe(true);
  });

  it("제목 다듬기를 끄면 프로젝트명 제거도 함께 죽는다 — 제목 편집이기 때문", () => {
    const m = toggleAiMode(defaultAiModes(), "refine");
    expect(m.stripProject).toBe(true); // 선택은 기억하되
    expect(stripProjectName(m)).toBe(false); // 이번 요청에는 동작하지 않는다
    expect(stripProjectName(defaultAiModes())).toBe(true);
  });
});
