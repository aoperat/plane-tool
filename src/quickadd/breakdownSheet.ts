import type { BreakdownSuggestion } from "../shared/types";

export interface SheetChild {
  text: string;
  /** 사용자가 켜 둔 항목인가. 끈 것은 등록되지 않는다. */
  on: boolean;
}

export interface SheetState {
  title: string;
  titleChanged: boolean;
  reason: string;
  children: SheetChild[];
}

export function createSheetState(s: BreakdownSuggestion): SheetState {
  return {
    title: s.title,
    titleChanged: s.title_changed,
    reason: s.reason,
    children: s.children.map((text) => ({ text, on: true })),
  };
}

/** 체크를 뒤집는다. 상태를 갈아치우지 않고 새 객체를 돌려준다 — 렌더가
 *  이전 상태와 비교할 수 있어야 한다. */
export function toggleChild(state: SheetState, index: number): SheetState {
  const children = state.children.map((c, i) => (i === index ? { ...c, on: !c.on } : c));
  return { ...state, children };
}

export function editChild(state: SheetState, index: number, text: string): SheetState {
  const children = state.children.map((c, i) => (i === index ? { ...c, text } : c));
  return { ...state, children };
}

/** 실제로 만들 하위 작업 제목들. 꺼진 것과 빈 것은 빠진다. */
export function acceptedChildren(state: SheetState): string[] {
  return state.children.filter((c) => c.on && c.text.trim() !== "").map((c) => c.text.trim());
}

/** 적용 버튼을 눌러 바뀔 것이 하나라도 있는가. 제목도 그대로고 하위도 없으면
 *  시트는 "지금 이대로 충분합니다"만 보여주고 닫힌다. */
export function hasAnythingToApply(state: SheetState): boolean {
  return state.titleChanged || acceptedChildren(state).length > 0;
}
