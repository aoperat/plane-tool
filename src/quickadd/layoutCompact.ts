import { DATE_PRESETS } from "../shared/datePresets";
import { attachWheelCycle } from "../shared/wheelCycle";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON,
} from "../shared/planeIcons";
import type { Member } from "../shared/types";
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
  const qaTip = document.getElementById("qaTip")!;

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

  /** Puts the keyboard cursor on `container`'s current `.sel` item, or its first item if none is selected. */
  function initKeyboardFocus(container: HTMLElement) {
    const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
    items.forEach((el) => el.classList.remove("kbd-focus"));
    const current = items.find((el) => el.classList.contains("sel")) ?? items[0];
    current?.classList.add("kbd-focus");
  }

  /** Moves the keyboard cursor to the next/previous `.dd-item` in `container`, wrapping at either end. */
  function moveKeyboardFocus(container: HTMLElement, delta: 1 | -1) {
    const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
    if (items.length === 0) return;
    const currentIndex = items.findIndex((el) => el.classList.contains("kbd-focus"));
    const nextIndex =
      currentIndex === -1 ? (delta > 0 ? 0 : items.length - 1) : (currentIndex + delta + items.length) % items.length;
    items.forEach((el) => el.classList.remove("kbd-focus"));
    items[nextIndex].classList.add("kbd-focus");
    items[nextIndex].scrollIntoView({ block: "nearest" });
  }

  /** Clicks `container`'s current keyboard-cursor item, reusing its existing onclick handler. */
  function selectKeyboardFocus(container: HTMLElement) {
    const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
    items.find((el) => el.classList.contains("kbd-focus"))?.click();
  }

  function keyboardFocusIndex(container: HTMLElement): number {
    const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
    return items.findIndex((el) => el.classList.contains("kbd-focus"));
  }

  /** Puts the keyboard cursor on the `index`-th `.dd-item` (clamped to the last item), bypassing
   *  `initKeyboardFocus`'s jump-to-selection default — keeps the cursor in place across a re-render. */
  function setKeyboardFocusIndex(container: HTMLElement, index: number) {
    const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
    if (items.length === 0 || index < 0) return;
    items.forEach((el) => el.classList.remove("kbd-focus"));
    items[Math.min(index, items.length - 1)].classList.add("kbd-focus");
  }

  /** Builds a keydown handler for a dropdown trigger button: arrow keys move, Enter selects, Escape closes.
   *  Does nothing (and doesn't call preventDefault) while `isOpen()` is false, so the trigger button's own
   *  native Enter-activates-click behavior still opens the dropdown as before. */
  function handleDropdownKeydown(container: HTMLElement, isOpen: () => boolean, onClose: () => void) {
    return (e: KeyboardEvent) => {
      if (!isOpen()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveKeyboardFocus(container, e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const trigger = e.currentTarget as HTMLElement;
        selectKeyboardFocus(container);
        // The selected item's own onclick moves focus to titleEl (matching mouse-click
        // behavior) — pull it back to the trigger chip so ArrowLeft/ArrowRight chip
        // navigation can continue right after a keyboard selection.
        trigger.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
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
    } else if (e.key === "Enter") {
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

  // Shortcut tooltip: one body-level pill moved under whichever trigger is hovered/focused.
  // It can't live inside the chips — they clip their content (overflow: hidden) so long
  // member names shrink instead of wrapping, and a nested tooltip would be cut off too.
  function bindTip(el: HTMLElement, html: string, placement: "above" | "below") {
    const show = () => {
      qaTip.innerHTML = html;
      qaTip.hidden = false;
      const r = el.getBoundingClientRect();
      const left = Math.max(6, Math.min(r.left + r.width / 2 - qaTip.offsetWidth / 2,
        window.innerWidth - qaTip.offsetWidth - 6));
      qaTip.style.left = `${left}px`;
      // The window is sized to the popup exactly, so the close button (top edge) tips downward.
      qaTip.style.top = placement === "above" ? `${r.top - qaTip.offsetHeight - 6}px` : `${r.bottom + 6}px`;
    };
    const hide = () => { qaTip.hidden = true; };
    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", show);
    el.addEventListener("blur", hide);
    el.addEventListener("click", hide);
  }
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
    },
  };
}
