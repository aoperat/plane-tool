import { splitAssigneeSlots } from "./assigneeSlots";
import { resolveDateChoice, shiftDateField, toggleAssignee, setSingleAssignee } from "./state";
import type { LayoutHandle, LayoutContext, LayoutHosts } from "./layout";
import { DATE_PRESETS, type DatePresetKey } from "../datePresets";
import { attachWheelCycle } from "../wheelCycle";
import { colorForId } from "../color";
import { initKeyboardFocus, moveKeyboardFocus, selectKeyboardFocus } from "../dropdownKeyboard";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../planeIcons";
import type { Member } from "../types";

/** 담당자 인라인 칸 수("나" 포함). 660px 폭에 이름 칩 넷과 "+N"이 들어가는 수다. */
const ASSIGNEE_SLOTS = 4;

/** "+N" 팝오버(210px)가 카드 오른쪽 밖으로 삐져나가지 않게 잡아두는 한계선. */
const PEOPLE_POP_EDGE = 220;

const DOW = "일월화수목금토";

const FIELDS_HTML = `
  <div class="qa2-fields">
    <div class="qa2-row"><span class="qa2-label">담당자</span>
      <div class="qa2-people" data-people></div>
      <span class="qa2-hint" data-assignee-hint></span></div>
    <div class="qa2-row"><span class="qa2-label">상태</span>
      <div class="seg-track" data-state></div></div>
    <div class="qa2-row"><span class="qa2-label">우선순위</span>
      <div class="seg-track" data-priority></div></div>
    <div class="qa2-row" data-date="start"><span class="qa2-label">시작일</span>
      <div class="seg-track" data-presets></div>
      <div class="date-stepper">
        <button type="button" class="step" data-step="-1">‹</button>
        <span class="val" data-val></span>
        <button type="button" class="step" data-step="1">›</button>
      </div>
      <span class="qa2-hint">PgUp/Dn</span></div>
    <div class="qa2-row" data-date="due"><span class="qa2-label">마감일</span>
      <div class="seg-track" data-presets></div>
      <div class="date-stepper">
        <button type="button" class="step" data-step="-1">‹</button>
        <span class="val" data-val></span>
        <button type="button" class="step" data-step="1">›</button>
      </div>
      <span class="qa2-hint">Ctrl+PgUp/Dn</span></div>
  </div>
  <div class="people-pop" data-people-pop hidden></div>`;

/** 값마다 아이콘·라벨이 고정이므로 세그먼트는 마운트 때 한 번만 만든다 — 이후
 *  다시 그리기는 `.on`을 옮기는 일뿐이라 SVG를 매번 새로 파싱하지 않는다. */
function buildSegTrack<T extends string>(
  track: HTMLElement,
  values: readonly T[],
  icon: (v: T) => string,
  label: (v: T) => string,
): void {
  track.innerHTML = values
    .map((v) => `<button type="button" class="seg" data-value="${v}">${icon(v)}${label(v)}</button>`)
    .join("");
}

function markSegOn(track: HTMLElement, isOn: (seg: HTMLElement) => boolean): void {
  track.querySelectorAll<HTMLElement>(".seg").forEach((seg) => seg.classList.toggle("on", isOn(seg)));
}

/** 세그먼트 클릭을 트랙에서 위임으로 받는다 — 버튼이 아이콘 SVG를 품고 있어
 *  e.target이 버튼 자신이 아닐 수 있다. 마우스로 눌렀을 때만(`e.detail > 0`)
 *  제목으로 포커스를 되돌린다 — 컴팩트 레이아웃과 같은 계약이다. 키보드
 *  활성화(Enter/Space, detail === 0)는 그대로 두어 ←/→ 행 이동이 이어지게 한다. */
function onSegClick(
  track: HTMLElement,
  key: "value" | "preset",
  focusTitle: () => void,
  handler: (v: string) => void,
): void {
  track.addEventListener("click", (e) => {
    const v = (e.target as Element).closest<HTMLElement>(".seg")?.dataset[key];
    if (!v) return;
    handler(v);
    if (e.detail > 0) focusTitle();
  });
}

/** 행마다 포커스 받는 요소를 하나로 줄인다 — 그래야 Tab이 칩 하나하나가 아니라
 *  행 단위로 움직인다. 활성 요소는 선택된 것, 없으면 첫 번째. `render()` 끝에서
 *  매번 다시 매긴다 — render()가 행 내용을 다시 그리기 때문이다. */
function applyRovingTabindex(row: HTMLElement): void {
  const items = [...row.querySelectorAll<HTMLElement>(".seg, .person")];
  if (items.length === 0) return;
  const active = items.find((el) => el.classList.contains("on")) ?? items[0];
  items.forEach((el) => { el.tabIndex = el === active ? 0 : -1; });
}

/** 행 컨테이너에 위임으로 건다 — ←/→로 세그먼트·담당자 칩을 옮긴다. 양 끝에서
 *  멈춘다(순환 없음): 순환하면 어디까지 왔는지 감이 안 온다. */
function handleRowKeydown(row: HTMLElement, e: KeyboardEvent): void {
  const items = [...row.querySelectorAll<HTMLElement>(".seg, .person")];
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current === -1) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, current + (e.key === "ArrowRight" ? 1 : -1)));
    items[next].tabIndex = 0;
    items[current].tabIndex = -1;
    items[next].focus();
  }
}

/** 다섯 항목을 라벨 붙은 다섯 줄로 펼쳐두는 "한눈에 보기" 레이아웃. */
export function mountExpanded(hosts: LayoutHosts, ctx: LayoutContext): LayoutHandle {
  hosts.fields.innerHTML = FIELDS_HTML;
  hosts.titleTrailing.innerHTML =
    `<button type="button" class="desc-toggle" data-desc-toggle>${DESCRIPTION_ICON} 설명</button>`;

  const state = ctx.state;
  const descriptionEl = hosts.description;
  const peopleEl = hosts.fields.querySelector<HTMLElement>("[data-people]")!;
  const assigneeHint = hosts.fields.querySelector<HTMLElement>("[data-assignee-hint]")!;
  const stateTrack = hosts.fields.querySelector<HTMLElement>("[data-state]")!;
  const priorityTrack = hosts.fields.querySelector<HTMLElement>("[data-priority]")!;
  const peoplePop = hosts.fields.querySelector<HTMLElement>("[data-people-pop]")!;
  const peopleRow = peopleEl.closest<HTMLElement>(".qa2-row")!;
  const descToggle = hosts.titleTrailing.querySelector<HTMLElement>("[data-desc-toggle]")!;
  // 팝오버는 카드(.popup) 기준으로 절대 배치한다 — 담당자 행이 아니라 카드가
  // 위치 기준 조상이라, 목업의 place()와 같은 좌표 계산을 그대로 쓴다.
  const cardEl = hosts.fields.closest<HTMLElement>(".popup")!;

  // ===== 담당자 =====

  /** 비어 있는 assigneeIds는 "나"를 뜻한다(서버가 호출자에게 할당) — v1과 같은 판정이다. */
  function isAssigned(m: Member): boolean {
    return state.assigneeIds.includes(m.id) || (m.is_me && state.assigneeIds.length === 0);
  }

  function avatarOf(m: Member): HTMLElement {
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = colorForId(m.id);
    avatar.textContent = m.display_name.slice(0, 1);
    return avatar;
  }

  // 클릭은 그 사람만 지정하고, Ctrl+클릭은 여러 명 선택 안에서 토글한다(v1과 같은 계약).
  // "나"를 고르면 명시적 id 대신 빈 배열로 돌아간다 — setSingleAssignee가 처리한다.
  function handlePersonClick(e: MouseEvent, m: Member) {
    if (e.ctrlKey) {
      toggleAssignee(state, m.id);
      render();
      return;
    }
    setSingleAssignee(state, m);
    closePeoplePop();
    render();
    ctx.focusTitle();
  }

  function placePeoplePop(anchor: HTMLElement) {
    const b = anchor.getBoundingClientRect();
    const p = cardEl.getBoundingClientRect();
    peoplePop.style.left = `${Math.min(b.left - p.left, p.width - PEOPLE_POP_EDGE)}px`;
    peoplePop.style.top = `${b.bottom - p.top + 6}px`;
  }

  // 접힌 사람들만 담기므로 여기 뜨는 항목은 언제나 미지정 상태다(지정된 사람은
  // splitAssigneeSlots가 인라인으로 올린다) — 그래서 선택 표시를 그리지 않는다.
  function fillPeoplePop(anchor: HTMLElement, overflow: Member[]) {
    peoplePop.innerHTML = `<div class="pp-head">나머지 멤버</div>`;
    for (const m of overflow) {
      const item = document.createElement("div");
      item.className = "dd-item";
      item.appendChild(avatarOf(m));
      item.appendChild(document.createTextNode(m.display_name));
      item.addEventListener("click", (e) => handlePersonClick(e, m));
      peoplePop.appendChild(item);
    }
    placePeoplePop(anchor);
  }

  function closePeoplePop() {
    if (peoplePop.hidden) return;
    peoplePop.hidden = true;
    ctx.onResize();
  }

  // 담당자 행이 늘 보이므로 v1처럼 팝오버를 열 때까지 기다리지 않고 바로 받아온다.
  // 마운트 시점에는 아직 프로젝트가 정해지지 않았을 수 있어(main.ts의 load()가 비동기다)
  // 그릴 때마다 확인한다. 기준은 "청한 적 있는가"가 아니라 **"지금 든 목록이 이 프로젝트
  // 것인가"**다 — main.ts는 이미 고른 프로젝트를 다시 골라도 members를 비우고
  // membersLoadedForProject를 null로 되돌리므로, 청한 이력만 보면 그 뒤로 담당자 행이
  // 영영 빈 채로 남는다. inFlight는 응답을 기다리는 사이의 중복 요청을, failedFor는
  // 실패한 프로젝트를 렌더마다 다시 두드리는 것을 막는다. 둘 다 **어느 프로젝트에 대한
  // 것인지**를 함께 들고 있어야 한다 — 단순 불리언으로 두면 A의 응답을 기다리는 사이
  // B로 갈아탔을 때 B의 요청이 아예 나가지 않는다.
  let inFlightFor: string | null = null;
  let failedFor: string | null = null;
  function requestMembers() {
    const id = state.selectedId;
    if (!id) return;
    // 다른 프로젝트를 거쳐 돌아오면 실패 기록은 잊는다 — 한 번의 네트워크 실패가
    // 영구히 빈 담당자 행으로 굳으면 안 된다.
    if (failedFor !== null && failedFor !== id) failedFor = null;
    if (inFlightFor === id || failedFor === id || state.membersLoadedForProject === id) return;
    inFlightFor = id;
    ctx.loadMembers().then(() => {
      if (inFlightFor === id) inFlightFor = null;
      // ctx.loadMembers는 에러를 삼키고 언제나 resolve 하므로 성패는 이 값으로 읽는다.
      // 기다리는 사이 프로젝트가 바뀌었다면 이 결과로 실패를 기록하지 않는다.
      if (state.selectedId === id) failedFor = state.membersLoadedForProject === id ? null : id;
      render();
    });
  }

  function renderPeople() {
    requestMembers();
    const { inline, overflow } = splitAssigneeSlots(state.members, state.assigneeIds, ASSIGNEE_SLOTS);
    peopleEl.innerHTML = "";
    for (const m of inline) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "person" + (isAssigned(m) ? " on" : "");
      chip.dataset.memberId = m.id;
      chip.appendChild(avatarOf(m));
      // 목업대로 본인은 "나"로 줄여 적는다 — 기본 담당자라 이름을 다 쓸 이유가 없다.
      chip.appendChild(document.createTextNode(" " + (m.is_me ? "나" : m.display_name)));
      chip.addEventListener("click", (e) => handlePersonClick(e, m));
      peopleEl.appendChild(chip);
    }

    let moreBtn: HTMLElement | null = null;
    if (overflow.length > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "person more";
      more.innerHTML = `<span class="cnt">+${overflow.length}</span>`;
      more.addEventListener("click", () => {
        if (peoplePop.hidden) {
          fillPeoplePop(more, overflow);
          initKeyboardFocus(peoplePop);
          peoplePop.hidden = false;
          ctx.onResize();
        } else {
          closePeoplePop();
        }
      });
      // "+N" 버튼에 포커스가 있는 동안만 반응한다 — dd-item은 실제 DOM 포커스를
      // 받지 않고 .kbd-focus 표시만 옮겨 다니므로(컴팩트 레이아웃의 담당자
      // 팝오버와 같은 방식), 키 이벤트는 이 버튼에서만 잡힌다.
      more.addEventListener("keydown", (e) => {
        if (peoplePop.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveKeyboardFocus(peoplePop, e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter" && !e.ctrlKey) {
          // Ctrl+Enter(제출)는 여기서 가로채지 않는다 — document의 전역 핸들러가
          // 잡아야 하므로, 일반 Enter만 받는다.
          e.preventDefault();
          // 항목의 onclick(handlePersonClick)을 그대로 재사용한다 — 단독 지정,
          // 팝오버 닫기, 제목으로 포커스 이동까지 그 안에서 다 처리된다.
          selectKeyboardFocus(peoplePop);
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePeoplePop();
          more.focus();
        }
      });
      peopleEl.appendChild(more);
      moreBtn = more;
    }

    // 팝오버를 열어둔 채 고르면 "+N" 버튼이 새로 만들어지므로 목록과 위치를 다시
    // 잡는다. 접힐 사람이 남지 않았으면 띄워둘 것도 없다.
    if (!peoplePop.hidden) {
      if (moreBtn) fillPeoplePop(moreBtn, overflow);
      else peoplePop.hidden = true;
      ctx.onResize();
    }

    assigneeHint.textContent =
      state.assigneeIds.length >= 2 ? `${state.assigneeIds.length}명 지정됨` : "Ctrl+클릭 다중";
  }

  // 담당자 칩은 <button>이라 Enter는 기본 click(=단독 지정)으로 충분하다. Space만은
  // 토글이어야 하므로 여기서 가로챈다 — 기본 click이 나면 단독 지정이 되어버린다.
  peopleRow.addEventListener("keydown", (e) => {
    const el = document.activeElement as HTMLElement;
    const id = el?.dataset.memberId;
    if (!id || e.key !== " ") return;
    e.preventDefault();
    toggleAssignee(state, id);
    render();
    // render()가 담당자 행 DOM을 통째로 다시 만들므로 같은 사람의 칩으로 포커스를
    // 되돌린다. roving tabindex도 그 칩에 맞춰 다시 잡는다 — applyRovingTabindex는
    // 다중 지정 중 첫 "on" 칩을 고르므로 방금 토글한 칩과 다를 수 있다.
    const chip = peopleRow.querySelector<HTMLElement>(`[data-member-id="${id}"]`);
    if (chip) {
      peopleRow.querySelectorAll<HTMLElement>(".person").forEach((c) => { c.tabIndex = c === chip ? 0 : -1; });
      chip.focus();
    }
  });

  // ===== 상태 / 우선순위 =====

  buildSegTrack(stateTrack, STATE_ORDER, stateIcon, stateLabel);
  buildSegTrack(priorityTrack, PRIORITY_ORDER, priorityIcon, priorityLabel);

  onSegClick(stateTrack, "value", ctx.focusTitle, (v) => { state.stateGroup = v as StateGroup; render(); });
  onSegClick(priorityTrack, "value", ctx.focusTitle, (v) => { state.priority = v as Priority; render(); });

  // 순환이 아니라 양 끝에서 멈춘다 — 상태·우선순위는 순서 있는 척도(백로그..취소,
  // 없음..긴급)라 위로 굴리다 처음으로 되감기면 값이 튄 것처럼 보인다. 휠은 세그먼트가
  // 아니라 트랙에 건다(세그먼트 사이 여백 위에서도 먹어야 한다).
  attachWheelCycle(stateTrack, () => STATE_ORDER.length, (delta) => {
    const i = STATE_ORDER.indexOf(state.stateGroup);
    state.stateGroup = STATE_ORDER[Math.max(0, Math.min(STATE_ORDER.length - 1, i + delta))];
    render();
  });
  attachWheelCycle(priorityTrack, () => PRIORITY_ORDER.length, (delta) => {
    const i = PRIORITY_ORDER.indexOf(state.priority);
    state.priority = PRIORITY_ORDER[Math.max(0, Math.min(PRIORITY_ORDER.length - 1, i + delta))];
    render();
  });

  // ===== 시작일 / 마감일 =====

  /** 날짜 행 하나를 배선하고, 그 행을 다시 그리는 함수를 돌려준다. */
  function setupDateRow(kind: "start" | "due"): () => void {
    const row = hosts.fields.querySelector<HTMLElement>(`[data-date="${kind}"]`)!;
    const presets = row.querySelector<HTMLElement>("[data-presets]")!;
    const stepper = row.querySelector<HTMLElement>(".date-stepper")!;
    const valEl = row.querySelector<HTMLElement>("[data-val]")!;
    const choice = () => (kind === "start" ? state.startChoice : state.dueChoice);
    const custom = () => (kind === "start" ? state.startCustomDate : state.dueCustomDate);

    presets.innerHTML = DATE_PRESETS
      .map((p) => `<button type="button" class="seg" data-preset="${p.key}">${p.label}</button>`)
      .join("");

    onSegClick(presets, "preset", ctx.focusTitle, (key) => {
      if (kind === "start") state.startChoice = key as DatePresetKey;
      else state.dueChoice = key as DatePresetKey;
      render();
    });

    row.querySelectorAll<HTMLElement>("[data-step]").forEach((btn) => {
      // Tab 흐름에서 뺀다 — 버튼은 기본 tabIndex가 0이라 두면 행마다 하나여야 할
      // Tab 정지점이 늘어난다. PgUp/Dn이 이미 같은 일을 하므로 마우스로만 쓴다.
      btn.tabIndex = -1;
      // 이 버튼은 Tab 흐름 밖이라(tabIndex=-1) 키보드로는 절대 활성화되지 않는다
      // — 그래도 e.detail(마우스 클릭 수)로 구분해 다른 세그먼트들과 같은 규칙을
      // 따르게 한다. 스크린리더 등 detail이 0으로 오는 비마우스 활성화 경로가
      // 있어도 제목 포커스를 건너뛸 뿐 값 변경 자체는 그대로 적용된다.
      btn.addEventListener("click", (e) => {
        shiftDateField(state, kind, Number(btn.dataset.step));
        render();
        if (e.detail > 0) ctx.focusTitle();
      });
    });
    attachWheelCycle(stepper, () => 2, (delta) => { shiftDateField(state, kind, delta); render(); });

    // 날짜 글자를 누르면 OS 달력을 연다. 보이지 않는 <input type="date">를 대신 띄운다 —
    // 스테퍼 자리에 진짜 입력칸을 두면 로캘마다 폭이 달라 행 정렬이 무너진다.
    const picker = document.createElement("input");
    picker.type = "date";
    picker.style.cssText = "position:absolute;opacity:0;pointer-events:none";
    // 안 보이는 입력칸이 Tab에 걸리면 키보드 사용자가 어디로 갔는지 알 수 없다 —
    // 클릭으로만 연다.
    picker.tabIndex = -1;
    row.appendChild(picker);
    valEl.addEventListener("click", () => {
      picker.value = resolveDateChoice(choice(), custom());
      picker.showPicker();
    });
    picker.addEventListener("change", () => {
      if (!picker.value) return;
      if (kind === "start") { state.startChoice = "custom"; state.startCustomDate = picker.value; }
      else { state.dueChoice = "custom"; state.dueCustomDate = picker.value; }
      render();
    });

    return () => {
      // 스테퍼에는 프리셋 이름이 아니라 **해석된 실제 날짜**를 적는다. 프리셋 밖 날짜면
      // 세 버튼이 모두 꺼지므로, 무엇이 등록될지 말해주는 건 이 값뿐이다.
      const iso = resolveDateChoice(choice(), custom());
      const dow = DOW[new Date(iso + "T00:00").getDay()];
      valEl.innerHTML = `${iso}<span class="dow">(${dow})</span>`;
      markSegOn(presets, (seg) => seg.dataset.preset === choice());
    };
  }

  const renderStartRow = setupDateRow("start");
  const renderDueRow = setupDateRow("due");

  // ===== 행 사이 키보드 이동 =====

  // `.qa2-row`는 마운트 때 한 번 만들어지고 다시 만들어지지 않는다(행 안 내용만
  // render()가 새로 그린다) — 그래서 위임 리스너를 여기서 한 번만 건다.
  const rows = [...hosts.fields.querySelectorAll<HTMLElement>(".qa2-row")];
  rows.forEach((row) => row.addEventListener("keydown", (e) => handleRowKeydown(row, e)));

  // ===== 설명 토글 =====

  function autoResizeDescription() {
    if (!descriptionEl.hidden) {
      descriptionEl.style.height = "auto";
      descriptionEl.style.height = `${descriptionEl.scrollHeight}px`;
    }
    ctx.onResize();
  }
  descriptionEl.addEventListener("input", autoResizeDescription);

  // 숨기기는 숨기기일 뿐이다 — 입력한 글은 textarea에 남아 그대로 등록된다.
  let descVisible = false;
  function setDescVisible(visible: boolean) {
    descVisible = visible;
    descriptionEl.hidden = !visible;
    descToggle.classList.toggle("on", visible);
    autoResizeDescription();
    if (visible) descriptionEl.focus();
  }
  descToggle.addEventListener("click", () => setDescVisible(!descVisible));

  function render() {
    renderPeople();
    markSegOn(stateTrack, (seg) => seg.dataset.value === state.stateGroup);
    markSegOn(priorityTrack, (seg) => seg.dataset.value === state.priority);
    renderStartRow();
    renderDueRow();
    // `.on` 표시가 다 끝난 뒤에 매긴다 — roving tabindex의 "활성 요소"가 그걸 본다.
    rows.forEach(applyRovingTabindex);
  }

  render();

  return {
    render,
    closeOverlays: () => { closePeoplePop(); },
    resetView: () => { closePeoplePop(); setDescVisible(false); },
    hasOpenOverlay: () => !peoplePop.hidden,
    width: 660,
    overlayBottom: () => (peoplePop.hidden ? 0 : Math.ceil(peoplePop.getBoundingClientRect().bottom)),
    destroy: () => {
      // 설명 입력은 hosts에 있어 이 레이아웃보다 오래 산다 — 리스너를 직접 뗀다.
      descriptionEl.removeEventListener("input", autoResizeDescription);
      hosts.fields.innerHTML = "";
      hosts.titleTrailing.innerHTML = "";
      hosts.description.hidden = true;
    },
  };
}
