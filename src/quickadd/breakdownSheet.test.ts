import { describe, it, expect } from "vitest";
import { createSheetState, toggleChild, editChild, acceptedChildren, hasAnythingToApply } from "./breakdownSheet";
import type { BreakdownSuggestion } from "../shared/types";

function suggestion(over: Partial<BreakdownSuggestion> = {}): BreakdownSuggestion {
  return { title: "홍익대 취약점 대응", title_changed: true, children: ["문서 확인", "메일 전달"], reason: "완료 시점이 다르다", ...over };
}

describe("breakdownSheet 상태", () => {
  it("처음에는 모든 하위가 켜져 있다", () => {
    const s = createSheetState(suggestion());
    expect(acceptedChildren(s)).toEqual(["문서 확인", "메일 전달"]);
  });

  it("끈 하위는 결과에서 빠진다", () => {
    const s = toggleChild(createSheetState(suggestion()), 1);
    expect(acceptedChildren(s)).toEqual(["문서 확인"]);
  });

  it("껐다 다시 켜면 원래 자리로 돌아온다", () => {
    let s = toggleChild(createSheetState(suggestion()), 0);
    s = toggleChild(s, 0);
    expect(acceptedChildren(s)).toEqual(["문서 확인", "메일 전달"]);
  });

  it("고친 제목이 결과에 반영된다", () => {
    const s = editChild(createSheetState(suggestion()), 0, "취약점 문서 확인");
    expect(acceptedChildren(s)).toEqual(["취약점 문서 확인", "메일 전달"]);
  });

  it("빈 제목으로 고치면 그 하위는 빠진다", () => {
    const s = editChild(createSheetState(suggestion()), 0, "   ");
    expect(acceptedChildren(s)).toEqual(["메일 전달"]);
  });

  it("제목 변경도 하위도 없으면 적용할 것이 없다", () => {
    const s = createSheetState(suggestion({ title_changed: false, children: [] }));
    expect(hasAnythingToApply(s)).toBe(false);
  });

  it("하위를 전부 꺼도 제목 변경이 남아 있으면 적용할 것이 있다", () => {
    let s = createSheetState(suggestion());
    s = toggleChild(s, 0);
    s = toggleChild(s, 1);
    expect(acceptedChildren(s)).toEqual([]);
    expect(hasAnythingToApply(s)).toBe(true);
  });

  it("제목이 그대로여도 하위를 전부 끄면 적용할 수 있다 — 그것도 하나의 결정이다", () => {
    // 켜진 수로 재면 여기서 [적용]이 죽고, 폼에 붙은 하위를 걷어낼 길이
    // 사라진다. "제안을 받아 적용했는데 마음이 바뀌었다"에서 빠져나오는 문.
    let s = createSheetState(suggestion({ title_changed: false }));
    s = toggleChild(s, 0);
    s = toggleChild(s, 1);
    expect(acceptedChildren(s)).toEqual([]);
    expect(hasAnythingToApply(s)).toBe(true);
  });

  it("하위 제목을 전부 비워도 마찬가지다", () => {
    let s = createSheetState(suggestion({ title_changed: false }));
    s = editChild(s, 0, "");
    s = editChild(s, 1, "  ");
    expect(acceptedChildren(s)).toEqual([]);
    expect(hasAnythingToApply(s)).toBe(true);
  });

  it("제안된 하위가 애초에 없고 제목도 그대로면 적용할 것이 없다", () => {
    const s = createSheetState(suggestion({ title_changed: false, children: [] }));
    expect(hasAnythingToApply(s)).toBe(false);
  });
});
