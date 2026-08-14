import { resolveDateShortcut } from "../dateShortcut";
import type { Priority, StateGroup } from "../planeIcons";
import { createFormState, shiftDateField, type FormState } from "./state";
import type { EmptyAssignee } from "./assigneeDisplay";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";
import { mountCompact } from "./layoutCompact";
import { mountExpanded } from "./layoutExpanded";

export type LayoutKind = "compact" | "expanded";

/** 설정 문자열을 레이아웃 이름으로 좁힌다. 모르는 값은 컴팩트다. */
export function layoutKindOf(setting: string): LayoutKind {
  return setting === "expanded" ? "expanded" : "compact";
}

/** 폼에 한꺼번에 채워 넣을 값. 할 일 수정이 스냅샷·상세로 두 번 부른다. */
export interface IssueFormFields {
  name: string;
  assigneeIds: string[];
  /** ISO yyyy-mm-dd. 없으면 빈 값으로 둔다. */
  startDate: string | null;
  targetDate: string | null;
  priority: Priority;
  stateGroup: StateGroup;
}

export interface IssueCardOptions {
  /** 카드를 넣을 자리. */
  root: HTMLElement;
  /** 헤더 제목. */
  title: string;
  titlePlaceholder: string;
  /** 헤더를 Tauri 드래그 영역으로 쓸 것인가. */
  draggable: boolean;
  /** 담당자가 비었을 때의 뜻 — assigneeDisplay.ts 참고. */
  emptyAssignee: EmptyAssignee;
  /** 한눈에 보기에서 설명칸을 처음부터 펼쳐 둘 것인가. 넓은 화면에서는 접어둘
   *  이유가 없다. 컴팩트는 좁으므로 이 옵션과 무관하게 접힌 채 시작한다. */
  expandedDescriptionOpen?: boolean;
  /** 레이아웃 토글과 닫기 버튼 사이에 꽂을 버튼들. */
  headerExtra?: HTMLElement[];
  /** 창별 푸터. 셸은 자리만 내주고 내용은 만들지 않는다. */
  footer: HTMLElement;
  /** 담당자 목록을 받아 state.members를 채운다. 실패해도 resolve해야 한다. */
  loadMembers: () => Promise<void>;
  /** 사용자가 헤더 토글로 레이아웃을 바꿨다 — 설정에 저장할 기회.
   *  setLayout()으로 바꿀 때는 부르지 않는다(설정에서 온 값을 되쓰지 않기 위해서다). */
  onLayoutChange: (kind: LayoutKind) => void;
  /** 내용 크기가 바뀌었다. 창 크기는 창이 정한다 — 셸은 창을 모른다. */
  onResize: (width: number, height: number) => void;
  /** Ctrl+Enter. 빠른 추가는 등록, 할 일 수정은 저장. */
  onSubmit: () => void;
  /** 닫기 버튼, 또는 열린 팝오버가 없을 때의 Esc. */
  onClose: () => void;
}

export interface IssueCardHandle {
  /** 카드 요소(.popup). 창이 코치마크 같은 것을 얹을 때 쓴다. */
  readonly element: HTMLElement;
  /** 제목 입력. 창이 자기만의 키 처리를 붙일 때 쓴다. */
  readonly titleElement: HTMLInputElement;
  readonly state: FormState;
  readonly layoutKind: LayoutKind;
  readonly layoutWidth: number;

  render(): void;
  /** 레이아웃을 갈아끼운다. onLayoutChange는 부르지 않는다. */
  setLayout(kind: LayoutKind): void;

  titleValue: string;
  descriptionValue: string;
  /** 제목·담당자·날짜·상태·우선순위를 한꺼번에 채운다. 설명은 건드리지 않는다. */
  setValues(fields: IssueFormFields): void;
  setDescriptionVisible(visible: boolean, focus?: boolean): void;
  setDescriptionEnabled(enabled: boolean): void;
  /** 폼 본문(제목·설명·필드·에러)을 통째로 감춘다. 로딩 중에 쓴다. */
  setBodyVisible(visible: boolean): void;

  markTitleError(): void;
  clearTitleError(): void;
  showError(message: string): void;
  clearError(): void;

  closeOverlays(): void;
  hasOpenOverlay(): boolean;
  /** 등록 성공 후 화면만 되돌린다(설명 접기, 팝오버 닫기). 값은 state가 따로 되돌린다. */
  resetView(): void;
  /** 카드 밖으로 떠 있는 것까지 포함한 내용 높이. */
  contentHeight(): number;
}

const GRIP_SVG =
  `<svg class="qa-grip" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>` +
  `<circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>` +
  `<circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>`;

const COMPACT_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<rect x="1.5" y="9.5" width="8" height="5" rx="2"/><rect x="11" y="9.5" width="6" height="5" rx="2"/>` +
  `<rect x="18.5" y="9.5" width="4" height="5" rx="2"/></svg>`;

const EXPANDED_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<rect x="2" y="4" width="5" height="3.4" rx="1.2"/><rect x="9" y="4" width="13" height="3.4" rx="1.2"/>` +
  `<rect x="2" y="10.3" width="5" height="3.4" rx="1.2"/><rect x="9" y="10.3" width="13" height="3.4" rx="1.2"/>` +
  `<rect x="2" y="16.6" width="5" height="3.4" rx="1.2"/><rect x="9" y="16.6" width="13" height="3.4" rx="1.2"/></svg>`;

const CLOSE_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">` +
  `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;

/** 두 창이 함께 쓰는 카드. 헤더 액션과 푸터만 바깥에서 꽂는다. */
export function mountIssueCard(options: IssueCardOptions): IssueCardHandle {
  const drag = options.draggable ? " data-tauri-drag-region" : "";
  options.root.innerHTML =
    `<div class="popup">
      <div class="qa-header"${drag}>
        ${GRIP_SVG}
        <span class="qa-header-title">${options.title}</span>
        <div class="qa-layout-toggle" data-layout-toggle role="group" aria-label="화면 모양">
          <button type="button" data-layout="compact" aria-label="컴팩트">${COMPACT_ICON}</button>
          <button type="button" data-layout="expanded" aria-label="한눈에 보기">${EXPANDED_ICON}</button>
        </div>
        <span data-header-extra></span>
        <button type="button" class="qa-close" data-close aria-label="닫기 (Esc)">${CLOSE_SVG}</button>
      </div>
      <div data-body>
        <div class="popup-top"${drag}>
          <div class="accent-bar"${drag}></div>
          <input class="title-input" data-title />
          <span data-title-trailing></span>
        </div>
        <textarea class="description-input" data-description placeholder="설명을 입력하세요…" rows="1" hidden></textarea>
        <div data-fields></div>
        <p class="form-error" data-error hidden></p>
      </div>
    </div>`;

  const card = options.root.querySelector<HTMLElement>(".popup")!;
  const layoutToggle = card.querySelector<HTMLElement>("[data-layout-toggle]")!;
  const headerExtra = card.querySelector<HTMLElement>("[data-header-extra]")!;
  const closeBtn = card.querySelector<HTMLElement>("[data-close]")!;
  const bodyEl = card.querySelector<HTMLElement>("[data-body]")!;
  const titleEl = card.querySelector<HTMLInputElement>("[data-title]")!;
  const descriptionEl = card.querySelector<HTMLTextAreaElement>("[data-description]")!;
  const errorEl = card.querySelector<HTMLElement>("[data-error]")!;

  titleEl.placeholder = options.titlePlaceholder;
  for (const el of options.headerExtra ?? []) headerExtra.appendChild(el);
  // 헤더의 버튼들은 드래그 영역 위에 있다 — data-tauri-drag-region이 없는 자식은
  // 클릭이 그대로 먹으므로 따로 손댈 것이 없다(.qa-header CSS 주석 참고).
  card.appendChild(options.footer);

  const state = createFormState();

  const hosts: LayoutHosts = {
    titleTrailing: card.querySelector<HTMLElement>("[data-title-trailing]")!,
    fields: card.querySelector<HTMLElement>("[data-fields]")!,
    description: descriptionEl,
  };

  const ctx: LayoutContext = {
    state,
    emptyAssignee: options.emptyAssignee,
    onResize: () => emitResize(),
    loadMembers: options.loadMembers,
    focusTitle: () => titleEl.focus(),
  };

  let layoutKind: LayoutKind = "compact";
  let layout: LayoutHandle = mountCompact(hosts, ctx);

  function contentHeight(): number {
    return Math.max(Math.ceil(card.getBoundingClientRect().height), layout.overlayBottom());
  }

  function emitResize() {
    options.onResize(layout.width, contentHeight());
  }

  function renderToggle() {
    layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
      const on = btn.dataset.layout === layoutKind;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  /** 레이아웃마다 설명을 접은 채 시작하므로(레이아웃 전환이 그렇게 만든다), 펼쳐
   *  두기로 한 창은 갈아끼운 뒤와 초기화 뒤에 다시 펼쳐줘야 한다. 커서는 옮기지
   *  않는다 — 제목부터 쓰는 흐름을 방해하지 않기 위해서다. */
  function applyDefaultDescription() {
    if (options.expandedDescriptionOpen && layoutKind === "expanded") {
      layout.setDescriptionVisible(true, false);
    }
  }

  /** 폼 상태는 state에 있고 제목·설명은 입력칸에 있으므로, 갈아끼워도 작성 중이던
   *  내용은 그대로 살아남는다. */
  function setLayout(kind: LayoutKind) {
    if (kind === layoutKind) {
      renderToggle();
      return;
    }
    layout.destroy();
    layoutKind = kind;
    layout = kind === "expanded" ? mountExpanded(hosts, ctx) : mountCompact(hosts, ctx);
    layout.render();
    applyDefaultDescription();
    renderToggle();
    emitResize();
  }

  layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = layoutKindOf(btn.dataset.layout ?? "");
      if (kind === layoutKind) return;
      setLayout(kind);
      options.onLayoutChange(kind);
      titleEl.focus();
    });
  });

  closeBtn.addEventListener("click", () => {
    if (layout.hasOpenOverlay()) layout.closeOverlays();
    options.onClose();
  });

  // 제출키는 어디에 커서가 있든 Ctrl+Enter다 — 항목을 넣거나 고치는 일이 포커스
  // 위치에 딸리지 않는다. 그냥 Enter는 각 컨트롤의 본래 역할(팝오버 선택, 버튼
  // 누르기, 줄바꿈)로 남는다. 날짜 단축키는 팝오버가 열려 있으면 비켜선다 —
  // 팝오버의 키보드 계약을 밟지 않기 위해서다.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      if (layout.hasOpenOverlay()) layout.closeOverlays();
      options.onSubmit();
      return;
    }
    if (e.key === "Escape") {
      if (layout.hasOpenOverlay()) {
        layout.closeOverlays();
        return;
      }
      options.onClose();
      return;
    }
    const shortcut = resolveDateShortcut(e.key, e.ctrlKey);
    if (shortcut && !layout.hasOpenOverlay()) {
      e.preventDefault();
      shiftDateField(state, shortcut.kind, shortcut.delta);
      layout.render();
    }
  });

  renderToggle();
  layout.render();

  return {
    element: card,
    titleElement: titleEl,
    state,
    get layoutKind() { return layoutKind; },
    get layoutWidth() { return layout.width; },

    render: () => layout.render(),
    setLayout,

    get titleValue() { return titleEl.value; },
    set titleValue(v: string) { titleEl.value = v; },
    get descriptionValue() { return descriptionEl.value; },
    set descriptionValue(v: string) { descriptionEl.value = v; },

    setValues: (fields: IssueFormFields) => {
      titleEl.value = fields.name;
      state.assigneeIds = [...fields.assigneeIds];
      // 고칠 때는 저장된 날짜를 그대로 보여야 한다 — 프리셋 이름("오늘")으로 바꾸면
      // 같은 날이라도 저장 시점의 값이 아니라 여는 시점의 값이 된다.
      state.startChoice = "custom";
      state.startCustomDate = fields.startDate ?? "";
      state.dueChoice = "custom";
      state.dueCustomDate = fields.targetDate ?? "";
      state.priority = fields.priority;
      state.stateGroup = fields.stateGroup;
      layout.render();
    },
    setDescriptionVisible: (visible, focus) => layout.setDescriptionVisible(visible, focus),
    setDescriptionEnabled: (enabled) => layout.setDescriptionEnabled(enabled),
    setBodyVisible: (visible: boolean) => {
      bodyEl.hidden = !visible;
      emitResize();
    },

    markTitleError: () => titleEl.classList.add("error"),
    clearTitleError: () => titleEl.classList.remove("error"),
    showError: (message: string) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
      emitResize();
    },
    clearError: () => {
      if (errorEl.hidden) return;
      errorEl.hidden = true;
      errorEl.textContent = "";
      emitResize();
    },

    closeOverlays: () => layout.closeOverlays(),
    hasOpenOverlay: () => layout.hasOpenOverlay(),
    resetView: () => {
      layout.resetView();
      applyDefaultDescription();
    },
    contentHeight,
  };
}
