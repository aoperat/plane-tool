import { DATE_PRESETS } from "../datePresets";
import { attachWheelCycle } from "../wheelCycle";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON,
} from "../planeIcons";
import { bindTip } from "../tooltip";
import {
  initKeyboardFocus, moveKeyboardFocus, keyboardFocusIndex, setKeyboardFocusIndex,
  handleDropdownKeydown,
} from "../dropdownKeyboard";
import type { Member } from "../types";
import { dateChoiceLabel, shiftDateField, toggleAssignee, setSingleAssignee } from "./state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";

const CHIP_ROW_HTML = `
  <div class="chip-row" id="chipRow">
    <button type="button" class="chip" id="chipAssignee"></button>
    <button type="button" class="chip" id="chipStart"></button>
    <button type="button" class="chip" id="chipDue"></button>
    <button type="button" class="chip" id="chipState"></button>
    <button type="button" class="chip" id="chipPriority"></button>
    <button type="button" class="chip chip-desc-toggle" id="chipDesc" title="설명 추가"></button>
    <div id="fieldPopover" class="field-popover" hidden></div>
  </div>`;

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;

/** 칩 한 줄 + 그 아래 뜨는 팝오버 하나로 된 기본(컴팩트) 레이아웃. */
export function mountCompact(hosts: LayoutHosts, ctx: LayoutContext): LayoutHandle {
  hosts.fields.innerHTML = CHIP_ROW_HTML;
  hosts.titleTrailing.innerHTML = ""; // 컴팩트는 제목 줄에 아무것도 두지 않는다

  const state = ctx.state;
  const descriptionEl = hosts.description;
  const chipAssignee = hosts.fields.querySelector("#chipAssignee") as HTMLElement;
  const chipStart = hosts.fields.querySelector("#chipStart") as HTMLElement;
  const chipDue = hosts.fields.querySelector("#chipDue") as HTMLElement;
  const chipPriority = hosts.fields.querySelector("#chipPriority") as HTMLElement;
  const chipState = hosts.fields.querySelector("#chipState") as HTMLElement;
  const chipDesc = hosts.fields.querySelector("#chipDesc") as HTMLElement;
  const fieldPopover = hosts.fields.querySelector("#fieldPopover") as HTMLElement;

  let openPopover: PopoverKind = null;

  function renderAssigneeChip() {
    chipAssignee.textContent = "";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    let label: string;
    if (state.assigneeIds.length === 0) {
      avatar.textContent = "나";
      label = "나";
    } else if (state.assigneeIds.length === 1) {
      const m = state.members.find((x) => x.id === state.assigneeIds[0]);
      const name = m ? m.display_name : "1명";
      avatar.textContent = name.slice(0, 1);
      label = name;
    } else {
      avatar.textContent = String(state.assigneeIds.length);
      label = `${state.assigneeIds.length}명`;
    }
    chipAssignee.appendChild(avatar);
    chipAssignee.appendChild(document.createTextNode(" " + label));
  }

  function renderChips() {
    renderAssigneeChip();
    chipStart.innerHTML = `${CALENDAR_ICON} ${dateChoiceLabel(state.startChoice, state.startCustomDate)}`;
    chipDue.innerHTML = `${FLAG_ICON} ${dateChoiceLabel(state.dueChoice, state.dueCustomDate)}`;
    chipPriority.innerHTML =
      `${priorityIcon(state.priority)} <span class="${state.priority === "none" ? "muted" : ""}">${priorityLabel(state.priority)}</span>`;
    chipState.innerHTML = `${stateIcon(state.stateGroup)} ${stateLabel(state.stateGroup)}`;
  }

  function autoResizeDescription() {
    if (!descriptionEl.hidden) {
      descriptionEl.style.height = "auto";
      descriptionEl.style.height = `${descriptionEl.scrollHeight}px`;
    }
    ctx.onResize();
  }

  descriptionEl.addEventListener("input", autoResizeDescription);

  // Hiding only hides — typed text stays in the textarea and is still submitted,
  // so toggling off and back on never loses a draft.
  let descVisible = false;
  function setDescVisible(visible: boolean) {
    descVisible = visible;
    descriptionEl.hidden = !visible;
    chipDesc.classList.toggle("active", visible);
    chipDesc.title = visible ? "설명 숨기기" : "설명 추가";
    autoResizeDescription();
    if (visible) descriptionEl.focus();
  }

  function closePopover() {
    openPopover = null;
    fieldPopover.hidden = true;
    fieldPopover.innerHTML = "";
    ctx.onResize();
  }

  // Mouse click picks a single assignee and closes the popover; Ctrl+click toggles the
  // entry within the multi-select and leaves the popover open (mirrors the Space/Enter
  // keyboard contract below). Picking the "me" member resets to the empty-array default
  // (server assigns to the caller) rather than pinning an explicit id, so it still reads
  // as "no explicit choice" if the member list is ever re-fetched.
  function handleAssigneeItemClick(e: MouseEvent, m: Member) {
    if (e.ctrlKey) {
      toggleAssignee(state, m.id);
      renderChips();
      renderAssigneePopoverItems();
      return;
    }
    setSingleAssignee(state, m);
    renderChips();
    closePopover();
    ctx.focusTitle();
  }

  // The project member list already includes the current user, so there's no separate
  // "나 (기본값)" placeholder row — the matching member is labeled "(나)" and shows as
  // selected whenever assigneeIds is empty (the default-to-self state).
  function renderAssigneePopoverItems() {
    fieldPopover.innerHTML = "";
    for (const m of state.members) {
      const item = document.createElement("div");
      const selected = state.assigneeIds.includes(m.id) || (m.is_me && state.assigneeIds.length === 0);
      item.className = "dd-item" + (selected ? " sel" : "");
      item.textContent = m.is_me ? `${m.display_name} (나)` : m.display_name;
      item.dataset.id = m.id;
      if (m.is_me) item.dataset.self = "1";
      item.onclick = (e) => handleAssigneeItemClick(e, m);
      fieldPopover.appendChild(item);
    }
    initKeyboardFocus(fieldPopover);
  }

  async function openAssigneePopover() {
    if (!state.selectedId) return;
    await ctx.loadMembers();
    renderAssigneePopoverItems();
    fieldPopover.hidden = false;
    openPopover = "assignee";
    ctx.onResize();
  }

  function openDatePopover(kind: "start" | "due") {
    fieldPopover.innerHTML = "";
    const current = kind === "start" ? state.startChoice : state.dueChoice;
    for (const preset of DATE_PRESETS) {
      const item = document.createElement("div");
      item.className = "dd-item" + (preset.key === current ? " sel" : "");
      item.textContent = preset.label;
      item.onclick = () => {
        if (kind === "start") state.startChoice = preset.key;
        else state.dueChoice = preset.key;
        renderChips();
        closePopover();
        ctx.focusTitle();
      };
      fieldPopover.appendChild(item);
    }
    const divider = document.createElement("div");
    divider.className = "popover-divider";
    fieldPopover.appendChild(divider);
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "popover-date-input";
    if (current === "custom") {
      dateInput.value = kind === "start" ? state.startCustomDate : state.dueCustomDate;
    }
    dateInput.onchange = () => {
      if (!dateInput.value) return;
      if (kind === "start") {
        state.startChoice = "custom";
        state.startCustomDate = dateInput.value;
      } else {
        state.dueChoice = "custom";
        state.dueCustomDate = dateInput.value;
      }
      renderChips();
      closePopover();
      ctx.focusTitle();
    };
    fieldPopover.appendChild(dateInput);
    initKeyboardFocus(fieldPopover);
    fieldPopover.hidden = false;
    openPopover = kind;
    ctx.onResize();
  }

  function openPriorityPopover() {
    fieldPopover.innerHTML = "";
    for (const p of PRIORITY_ORDER) {
      const item = document.createElement("div");
      item.className = "dd-item" + (p === state.priority ? " sel" : "");
      item.innerHTML = `${priorityIcon(p)} ${priorityLabel(p)}`;
      item.onclick = () => {
        state.priority = p;
        renderChips();
        closePopover();
        ctx.focusTitle();
      };
      fieldPopover.appendChild(item);
    }
    initKeyboardFocus(fieldPopover);
    fieldPopover.hidden = false;
    openPopover = "priority";
    ctx.onResize();
  }

  function openStatePopover() {
    fieldPopover.innerHTML = "";
    for (const g of STATE_ORDER) {
      const item = document.createElement("div");
      item.className = "dd-item" + (g === state.stateGroup ? " sel" : "");
      item.innerHTML = `${stateIcon(g)} ${stateLabel(g)}`;
      item.onclick = () => {
        state.stateGroup = g;
        renderChips();
        closePopover();
        ctx.focusTitle();
      };
      fieldPopover.appendChild(item);
    }
    initKeyboardFocus(fieldPopover);
    fieldPopover.hidden = false;
    openPopover = "state";
    ctx.onResize();
  }

  chipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
  chipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
  chipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
  chipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
  chipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };
  chipDesc.innerHTML = `${DESCRIPTION_ICON} 설명`;
  chipDesc.onclick = () => {
    if (openPopover) closePopover();
    setDescVisible(!descVisible);
  };

  const fieldPopoverKeydown = handleDropdownKeydown(fieldPopover, () => openPopover !== null, () => {
    closePopover();
    ctx.focusTitle();
  });
  // The assignee popover is multi-select, so it gets its own keyboard contract instead of
  // handleDropdownKeydown's single-select one: Space toggles the focused member in and out
  // (popover stays open), Enter replaces the whole selection with just the focused entry
  // and closes. dataset.id carries the member id; dataset.self marks the current-user row,
  // which resets to the empty-array default instead of pinning its explicit id.
  chipAssignee.addEventListener("keydown", (e) => {
    if (openPopover !== "assignee") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveKeyboardFocus(fieldPopover, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === " ") {
      e.preventDefault();
      const index = keyboardFocusIndex(fieldPopover);
      const focused = fieldPopover.querySelector<HTMLElement>(".dd-item.kbd-focus");
      if (!focused?.dataset.id) return;
      toggleAssignee(state, focused.dataset.id);
      renderChips();
      renderAssigneePopoverItems(); // re-renders the list, so restore the cursor
      setKeyboardFocusIndex(fieldPopover, index);
    } else if (e.key === "Enter" && !e.ctrlKey) {
      // Ctrl+Enter(제출)는 여기서 가로채지 않는다 — document의 전역 핸들러가
      // 잡아야 하므로, 일반 Enter만 받는다.
      e.preventDefault();
      const focused = fieldPopover.querySelector<HTMLElement>(".dd-item.kbd-focus");
      if (focused?.dataset.id) {
        state.assigneeIds = focused.dataset.self ? [] : [focused.dataset.id];
        renderChips();
      }
      closePopover();
      chipAssignee.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
      ctx.focusTitle();
    }
  });
  chipStart.addEventListener("keydown", fieldPopoverKeydown);
  chipDue.addEventListener("keydown", fieldPopoverKeydown);
  chipPriority.addEventListener("keydown", fieldPopoverKeydown);
  chipState.addEventListener("keydown", fieldPopoverKeydown);

  // Clamped, not wrapped: priority/state are ordered scales (없음..긴급, 백로그..취소), not
  // cyclic lists, so wheel-up stops at the last entry instead of rolling back to the first.
  attachWheelCycle(chipPriority, () => PRIORITY_ORDER.length, (delta) => {
    const i = PRIORITY_ORDER.indexOf(state.priority);
    state.priority = PRIORITY_ORDER[Math.max(0, Math.min(PRIORITY_ORDER.length - 1, i + delta))];
    renderChips();
    if (openPopover === "priority") openPriorityPopover();
  });

  attachWheelCycle(chipState, () => STATE_ORDER.length, (delta) => {
    const i = STATE_ORDER.indexOf(state.stateGroup);
    state.stateGroup = STATE_ORDER[Math.max(0, Math.min(STATE_ORDER.length - 1, i + delta))];
    renderChips();
    if (openPopover === "state") openStatePopover();
  });

  attachWheelCycle(chipStart, () => 2, (delta) => {
    shiftDateField(state, "start", delta);
    renderChips();
    if (openPopover === "start") openDatePopover("start");
  });
  attachWheelCycle(chipDue, () => 2, (delta) => {
    shiftDateField(state, "due", delta);
    renderChips();
    if (openPopover === "due") openDatePopover("due");
  });

  // Single-select cycle — matches a plain (non-Ctrl) click. Empty assigneeIds means
  // "defaults to me", so start the cycle from the "me" row when nothing is picked yet.
  attachWheelCycle(chipAssignee, () => state.members.length, (delta) => {
    const meIndex = state.members.findIndex((m) => m.is_me);
    const currentId = state.assigneeIds[0] ?? state.members[meIndex]?.id;
    const i = state.members.findIndex((m) => m.id === currentId);
    const next = state.members[((i === -1 ? meIndex : i) + delta + state.members.length) % state.members.length];
    setSingleAssignee(state, next);
    renderChips();
    if (openPopover === "assignee") openAssigneePopover();
  });

  // DOM order of the field chips, used for ArrowLeft/ArrowRight navigation between them.
  const chips = [chipAssignee, chipStart, chipDue, chipState, chipPriority, chipDesc];

  /** Moves focus to the previous/next chip in `chips` (no wrap). An open dropdown is closed
   *  first — the assignee popover is multi-select and stays open across selections, so gating
   *  on it (as this used to) left ArrowLeft/ArrowRight permanently dead on that chip. */
  function handleChipArrowNav(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const currentIndex = chips.indexOf(e.currentTarget as HTMLElement);
    const nextIndex = currentIndex + (e.key === "ArrowRight" ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= chips.length) return;
    e.preventDefault();
    if (openPopover !== null) closePopover();
    chips[nextIndex].focus();
  }
  chips.forEach((chip) => chip.addEventListener("keydown", handleChipArrowNav));

  bindTip(chipStart, "<kbd>PgUp/Dn</kbd> 시작일 ±1일", "above");
  bindTip(chipDue, "<kbd>Ctrl+PgUp/Dn</kbd> 마감일 ±1일", "above");

  return {
    render: renderChips,
    closeOverlays: () => { closePopover(); },
    resetView: () => { closePopover(); setDescVisible(false); },
    hasOpenOverlay: () => openPopover !== null,
    width: 540,
    overlayBottom: () => (openPopover && !fieldPopover.hidden
      ? Math.ceil(fieldPopover.getBoundingClientRect().bottom)
      : 0),
    destroy: () => {
      // 설명 입력은 hosts에 있어 이 레이아웃보다 오래 산다 — 리스너를 직접 뗀다.
      descriptionEl.removeEventListener("input", autoResizeDescription);
      hosts.fields.innerHTML = "";
      hosts.titleTrailing.innerHTML = "";
      // 설명 표시 여부는 레이아웃마다 따로 들고 있다 — 펼친 채로 넘기면 새 레이아웃의
      // 토글은 꺼져 있는데 입력칸만 남아 어긋난다. 입력한 값은 그대로 둔다.
      hosts.description.hidden = true;
    },
  };
}
