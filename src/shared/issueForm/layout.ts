import type { FormState } from "./state";
import type { EmptyAssignee } from "./assigneeDisplay";

/** 레이아웃이 채울 자리들. 팝업 카드의 나머지(헤더·제목 입력·에러 줄·푸터)는
 *  레이아웃과 무관하게 index.html에 그대로 있다. */
export interface LayoutHosts {
  /** 제목 줄 오른쪽 끝. 컴팩트는 비워두고, 한눈에 보기는 설명 토글을 넣는다. */
  titleTrailing: HTMLElement;
  /** 필드 영역 — 칩 행 또는 필드 격자가 들어간다. */
  fields: HTMLElement;
  /** 설명 입력. 값은 두 레이아웃이 공유하고 보이기/숨기기만 레이아웃이 정한다. */
  description: HTMLTextAreaElement;
}

/** 레이아웃이 바깥(main.ts)에 요청할 수 있는 것들. */
export interface LayoutContext {
  state: FormState;
  /** 담당자가 비었을 때의 뜻. 창마다 다르다 — assigneeDisplay.ts 참고. */
  emptyAssignee: EmptyAssignee;
  /** 그린 내용의 크기가 바뀌었으니 창 크기를 다시 재라. */
  onResize: () => void;
  /** 담당자 목록을 (필요하면) 받아 `state.members`를 채운다. */
  loadMembers: () => Promise<void>;
  /** 제목 입력으로 포커스를 되돌린다. */
  focusTitle: () => void;
}

export interface LayoutHandle {
  /** 상태가 바뀌었으니 다시 그린다. */
  render(): void;
  /** 열려 있는 팝오버를 모두 닫는다(제출·창 닫기 직전). */
  closeOverlays(): void;
  /** 등록 성공 후 이 레이아웃의 화면 상태를 되돌린다(설명 접기, 팝오버 닫기).
   *  폼 값은 state.ts의 resetFormFields가 따로 되돌린다 — 여기는 화면만이다. */
  resetView(): void;
  /** 팝오버가 열려 있는가. main.ts의 날짜 단축키가 이걸 보고 비켜선다 —
   *  팝오버의 키보드 계약을 밟지 않기 위해서다. */
  hasOpenOverlay(): boolean;
  /** 이 레이아웃이 요구하는 창 폭(px). */
  readonly width: number;
  /** 카드 밖으로 떠 있는 요소의 아래 끝(px). 없으면 0. */
  overlayBottom(): number;
  /** 설명 입력을 펼치거나 접는다. 접어도 값은 남는다 — 셸이 기존 설명을 채운 뒤
   *  펼칠 때 쓴다. `focus`가 false면 커서를 옮기지 않는다(값만 채우는 경우). */
  setDescriptionVisible(visible: boolean, focus?: boolean): void;
  /** 설명 토글 버튼을 켜고 끈다. 상세를 받아오기 전까지 잠가둘 때 쓴다. */
  setDescriptionEnabled(enabled: boolean): void;
  /** 이벤트를 떼고 DOM을 비운다(레이아웃 전환 시). */
  destroy(): void;
}
