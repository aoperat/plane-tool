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

/** 적용 버튼을 눌러 결정할 것이 하나라도 있는가.
 *
 *  켜 둔 하위의 수가 아니라 **제안된 하위가 있었는지**로 판정한다. 전부 꺼 두는
 *  것도 "하위 없이 간다"는 하나의 결정이고, 폼에 이미 붙어 있던 하위를 걷어내는
 *  유일한 길이기 때문이다 — 켜진 수로 재면 그 길이 막힌 버튼 뒤로 사라진다.
 *
 *  제목도 그대로고 제안된 하위도 애초에 없을 때만 false다. 그때 시트는
 *  "지금 이대로 충분합니다"만 보여주고 닫힌다. */
export function hasAnythingToApply(state: SheetState): boolean {
  return state.titleChanged || state.children.length > 0;
}

export interface SheetHandle {
  close: () => void;
}

/** 카드 위에 겹치는 제안 시트를 연다. 적용을 누르면 onApply가 최종 상태를 받는다.
 *  Esc/취소는 아무것도 바꾸지 않고 닫는다. */
export function openBreakdownSheet(opts: {
  host: HTMLElement;
  suggestion: BreakdownSuggestion;
  originalTitle: string;
  onApply: (title: string, children: string[]) => void;
}): SheetHandle {
  let state = createSheetState(opts.suggestion);

  const overlay = document.createElement("div");
  overlay.className = "bd-overlay";
  const sheet = document.createElement("div");
  sheet.className = "bd-sheet";
  overlay.appendChild(sheet);

  const close = () => {
    // 여러 번 불려도 안전해야 한다 — 취소·Esc·적용으로 이미 닫힌 뒤에도
    // 폼 리셋이 한 번 더 부른다.
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // 사이드바·창 닫기까지 번지지 않게 여기서 멈춘다
      close();
      return;
    }
    // 시트는 카드 위에 겹치는 모달이다. 뒤쪽 폼의 제출키(card.ts가 document에
    // 걸어 둔 Ctrl+Enter)가 살아 있으면, 제안을 검토하던 중에 원본 제목 그대로
    // 등록되고 창이 닫혀 시트만 허공에 남는다. 여기서 멈춘다 — 등록하려면
    // 먼저 적용하거나 취소해야 한다.
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", onKey, true);

  function render() {
    sheet.innerHTML = "";

    const head = document.createElement("div");
    head.className = "bd-head";
    head.appendChild(document.createTextNode("✨ AI 제안"));
    const esc = document.createElement("span");
    esc.className = "esc";
    esc.textContent = "Esc 닫기";
    head.appendChild(esc);
    sheet.appendChild(head);

    if (!hasAnythingToApply(state)) {
      const empty = document.createElement("div");
      empty.className = "bd-empty";
      empty.textContent = "지금 이대로 충분합니다 — 쪼갤 만한 단계가 보이지 않습니다.";
      sheet.appendChild(empty);
    }

    if (state.titleChanged) {
      const t = document.createElement("div");
      t.className = "bd-title";
      const old = document.createElement("span");
      old.className = "old";
      old.textContent = opts.originalTitle;
      t.appendChild(old);
      t.appendChild(document.createElement("br"));
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "↳ ";
      t.appendChild(arrow);
      t.appendChild(document.createTextNode(state.title));
      sheet.appendChild(t);
    }

    state.children.forEach((child, i) => {
      const row = document.createElement("div");
      row.className = "bd-child" + (child.on ? "" : " off");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = child.on;
      box.onchange = () => {
        state = toggleChild(state, i);
        render();
      };
      row.appendChild(box);
      const text = document.createElement("input");
      text.type = "text";
      text.value = child.text;
      text.oninput = () => {
        state = editChild(state, i, text.value);
      };
      row.appendChild(text);
      sheet.appendChild(row);
    });

    if (state.reason) {
      const r = document.createElement("div");
      r.className = "bd-reason";
      r.textContent = state.reason;
      sheet.appendChild(r);
    }

    const foot = document.createElement("div");
    foot.className = "bd-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "bd-cancel";
    cancel.textContent = "취소";
    cancel.onclick = close;
    foot.appendChild(cancel);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "qa-submit";
    apply.textContent = "적용";
    apply.disabled = !hasAnythingToApply(state);
    apply.onclick = () => {
      opts.onApply(state.title, acceptedChildren(state));
      close();
    };
    foot.appendChild(apply);
    sheet.appendChild(foot);
  }

  render();
  opts.host.appendChild(overlay);
  return { close };
}
