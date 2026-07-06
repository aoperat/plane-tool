import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project, Member } from "../shared/types";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import { resolveDateShortcut } from "../shared/dateShortcut";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import "../shared/app.css";

// Every window focus reloads the project list from the Plane API; a cooldown keeps rapid
// re-focusing (alt-tab cycling) from adding to the sidebar's own request bursts against the
// same rate-limited server.
const LOAD_COOLDOWN_MS = 3000;
let lastLoadAt = 0;

const win = getCurrentWindow();
const titleEl = document.getElementById("title") as HTMLInputElement;
const projBtn = document.getElementById("projBtn")!;
const projName = document.getElementById("projName")!;
const projDot = document.getElementById("projDot")!;
const dropdown = document.getElementById("dropdown")!;
const chipAssignee = document.getElementById("chipAssignee")!;
const chipStart = document.getElementById("chipStart")!;
const chipDue = document.getElementById("chipDue")!;
const chipPriority = document.getElementById("chipPriority")!;
const chipState = document.getElementById("chipState")!;
const chipDesc = document.getElementById("chipDesc")!;
const fieldPopover = document.getElementById("fieldPopover")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
const errorEl = document.getElementById("qaError")!;
const qaClose = document.getElementById("qaClose")!;
const qaSubmit = document.getElementById("qaSubmit")!;
const qaTip = document.getElementById("qaTip")!;

let projects: Project[] = [];
let selectedId: string | null = null;
let members: Member[] = [];
let membersLoadedForProject: string | null = null;

let assigneeIds: string[] = []; // empty = server defaults to self
type DateChoice = DatePresetKey | "custom";
let startChoice: DateChoice = "today";
let startCustomDate = ""; // ISO yyyy-mm-dd, used when startChoice === "custom"
let dueChoice: DateChoice = "today";
let dueCustomDate = "";
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;
let openPopover: PopoverKind = null;

const popupEl = document.querySelector(".popup") as HTMLElement;

// Measures actual rendered content instead of guessing pixel constants —
// the popup's own box for the idle height, plus the open popover's or project
// dropdown's real bottom edge (which varies with content and can't be hardcoded).
function resizeToFit() {
  let height = Math.ceil(popupEl.getBoundingClientRect().height);
  if (openPopover && !fieldPopover.hidden) {
    const popoverBottom = Math.ceil(fieldPopover.getBoundingClientRect().bottom);
    height = Math.max(height, popoverBottom);
  }
  if (!dropdown.hidden) {
    height = Math.max(height, Math.ceil(dropdown.getBoundingClientRect().bottom));
  }
  height += 4; // small buffer so a border/shadow pixel never gets clipped
  win.setSize(new LogicalSize(540, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

// The dropdown hangs below the popup, so every open/close changes the window's
// required height — funnel all visibility flips through here to keep them in sync.
function setDropdownOpen(open: boolean) {
  dropdown.hidden = !open;
  if (open) initKeyboardFocus(dropdown);
  resizeToFit();
}

function dateChoiceLabel(choice: DateChoice, custom: string): string {
  if (choice === "custom") return custom || "날짜 선택";
  return DATE_PRESETS.find((d) => d.key === choice)!.label;
}

function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}

// ISO yyyy-mm-dd strings compare correctly with plain string ordering, so the
// clamps below don't need Date parsing.
function shiftDateField(kind: "start" | "due", delta: number) {
  if (kind === "start") {
    const current = resolveDateChoice(startChoice, startCustomDate);
    const next = shiftIsoDate(current, delta);
    startCustomDate = next;
    startChoice = "custom";
    // Pushing the start date past the due date would invert the range —
    // carry the due date along with it instead.
    const due = resolveDateChoice(dueChoice, dueCustomDate);
    if (next > due) {
      dueCustomDate = next;
      dueChoice = "custom";
    }
  } else {
    const current = resolveDateChoice(dueChoice, dueCustomDate);
    const next = shiftIsoDate(current, delta);
    dueCustomDate = next;
    dueChoice = "custom";
    // Same guard in reverse: pulling the due date before the start date
    // carries the start date back with it.
    const start = resolveDateChoice(startChoice, startCustomDate);
    if (start > next) {
      startCustomDate = next;
      startChoice = "custom";
    }
  }
  renderChips();
}

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  resizeToFit();
}

function clearError() {
  if (errorEl.hidden) return;
  errorEl.hidden = true;
  errorEl.textContent = "";
  resizeToFit();
}

// Ctrl+Enter and the submit button can fire while a create request is still in flight;
// without this guard each extra press files the same issue again.
let submitting = false;

async function submitIssue() {
  if (submitting) return;
  const name = titleEl.value.trim();
  if (!name) {
    titleEl.classList.add("error");
    showError("제목을 입력하세요");
    return;
  }
  if (!selectedId) {
    showError("프로젝트를 선택하세요");
    return;
  }
  submitting = true;
  try {
    await createIssue(
      selectedId,
      name,
      assigneeIds,
      resolveDateChoice(startChoice, startCustomDate),
      resolveDateChoice(dueChoice, dueCustomDate),
      priority,
      stateGroup,
      descriptionEl.value,
    );
    titleEl.value = "";
    resetFields();
    await win.hide();
  } catch (err) {
    titleEl.classList.add("error");
    showError("등록 실패: " + err);
    console.error(err);
  } finally {
    submitting = false;
  }
}

function renderSelected() {
  const p = projects.find((x) => x.id === selectedId);
  projName.textContent = p ? p.name : "프로젝트 선택";
  (projDot as HTMLElement).style.background = p ? colorForId(p.id) : "transparent";
}

function renderDropdown() {
  dropdown.innerHTML = "";
  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p.id === selectedId ? " sel" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(p.id);
    item.appendChild(dot);
    item.appendChild(document.createTextNode(p.name));
    item.onclick = () => {
      selectedId = p.id;
      members = [];
      membersLoadedForProject = null;
      assigneeIds = [];
      renderSelected();
      renderDropdown();
      renderChips();
      setDropdownOpen(false);
      titleEl.focus();
    };
    dropdown.appendChild(item);
  }
}

function renderAssigneeChip() {
  chipAssignee.textContent = "";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  let label: string;
  if (assigneeIds.length === 0) {
    avatar.textContent = "나";
    label = "나";
  } else if (assigneeIds.length === 1) {
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    avatar.textContent = name.slice(0, 1);
    label = name;
  } else {
    avatar.textContent = String(assigneeIds.length);
    label = `${assigneeIds.length}명`;
  }
  chipAssignee.appendChild(avatar);
  chipAssignee.appendChild(document.createTextNode(" " + label));
}

function renderChips() {
  renderAssigneeChip();
  chipStart.innerHTML = `${CALENDAR_ICON} ${dateChoiceLabel(startChoice, startCustomDate)}`;
  chipDue.innerHTML = `${FLAG_ICON} ${dateChoiceLabel(dueChoice, dueCustomDate)}`;
  chipPriority.innerHTML =
    `${priorityIcon(priority)} <span class="${priority === "none" ? "muted" : ""}">${priorityLabel(priority)}</span>`;
  chipState.innerHTML = `${stateIcon(stateGroup)} ${stateLabel(stateGroup)}`;
}

function autoResizeDescription() {
  if (!descriptionEl.hidden) {
    descriptionEl.style.height = "auto";
    descriptionEl.style.height = `${descriptionEl.scrollHeight}px`;
  }
  resizeToFit();
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
  resizeToFit();
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

function toggleAssignee(id: string) {
  if (assigneeIds.includes(id)) {
    assigneeIds = assigneeIds.filter((x) => x !== id);
  } else {
    assigneeIds = [...assigneeIds, id];
  }
  renderChips();
  renderAssigneePopoverItems();
}

// Mouse click picks a single assignee and closes the popover; Ctrl+click toggles the
// entry within the multi-select and leaves the popover open (mirrors the Space/Enter
// keyboard contract below). Picking the "me" member resets to the empty-array default
// (server assigns to the caller) rather than pinning an explicit id, so it still reads
// as "no explicit choice" if the member list is ever re-fetched.
function handleAssigneeItemClick(e: MouseEvent, m: Member) {
  if (e.ctrlKey) {
    toggleAssignee(m.id);
    return;
  }
  assigneeIds = m.is_me ? [] : [m.id];
  renderChips();
  closePopover();
  titleEl.focus();
}

// The project member list already includes the current user, so there's no separate
// "나 (기본값)" placeholder row — the matching member is labeled "(나)" and shows as
// selected whenever assigneeIds is empty (the default-to-self state).
function renderAssigneePopoverItems() {
  fieldPopover.innerHTML = "";
  for (const m of members) {
    const item = document.createElement("div");
    const selected = assigneeIds.includes(m.id) || (m.is_me && assigneeIds.length === 0);
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
  if (!selectedId) return;
  if (membersLoadedForProject !== selectedId) {
    try {
      members = await listMembers(selectedId);
      membersLoadedForProject = selectedId;
    } catch (err) {
      members = [];
      console.error("listMembers failed:", err);
    }
  }
  renderAssigneePopoverItems();
  fieldPopover.hidden = false;
  openPopover = "assignee";
  resizeToFit();
}

function openDatePopover(kind: "start" | "due") {
  fieldPopover.innerHTML = "";
  const current = kind === "start" ? startChoice : dueChoice;
  for (const preset of DATE_PRESETS) {
    const item = document.createElement("div");
    item.className = "dd-item" + (preset.key === current ? " sel" : "");
    item.textContent = preset.label;
    item.onclick = () => {
      if (kind === "start") startChoice = preset.key;
      else dueChoice = preset.key;
      renderChips();
      closePopover();
      titleEl.focus();
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
    dateInput.value = kind === "start" ? startCustomDate : dueCustomDate;
  }
  dateInput.onchange = () => {
    if (!dateInput.value) return;
    if (kind === "start") {
      startChoice = "custom";
      startCustomDate = dateInput.value;
    } else {
      dueChoice = "custom";
      dueCustomDate = dateInput.value;
    }
    renderChips();
    closePopover();
    titleEl.focus();
  };
  fieldPopover.appendChild(dateInput);
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = kind;
  resizeToFit();
}

function openPriorityPopover() {
  fieldPopover.innerHTML = "";
  for (const p of PRIORITY_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p === priority ? " sel" : "");
    item.innerHTML = `${priorityIcon(p)} ${priorityLabel(p)}`;
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = "priority";
  resizeToFit();
}

function openStatePopover() {
  fieldPopover.innerHTML = "";
  for (const g of STATE_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (g === stateGroup ? " sel" : "");
    item.innerHTML = `${stateIcon(g)} ${stateLabel(g)}`;
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = "state";
  resizeToFit();
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
  titleEl.focus();
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
    toggleAssignee(focused.dataset.id); // re-renders the list, so restore the cursor
    setKeyboardFocusIndex(fieldPopover, index);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const focused = fieldPopover.querySelector<HTMLElement>(".dd-item.kbd-focus");
    if (focused?.dataset.id) {
      assigneeIds = focused.dataset.self ? [] : [focused.dataset.id];
      renderChips();
    }
    closePopover();
    chipAssignee.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePopover();
    titleEl.focus();
  }
});
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);

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

function resetFields() {
  assigneeIds = [];
  setDropdownOpen(false); // a submit can land while the project dropdown is open
  startChoice = "today";
  startCustomDate = "";
  dueChoice = "today";
  dueCustomDate = "";
  priority = "none";
  stateGroup = "unstarted";
  descriptionEl.value = "";
  setDescVisible(false);
  clearError();
  closePopover();
  renderChips();
}

async function load() {
  lastLoadAt = Date.now();
  const [settings, fetched] = await Promise.all([getSettings(), listProjects().catch(() => [])]);
  applyTheme(settings.theme);
  projects = fetched;
  selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  renderSelected();
  renderDropdown();
}

projBtn.onclick = () => {
  setDropdownOpen(dropdown.hidden);
};
projBtn.addEventListener(
  "keydown",
  handleDropdownKeydown(dropdown, () => !dropdown.hidden, () => {
    setDropdownOpen(false);
    titleEl.focus();
  }),
);

/** Flashes the submit button — plain Enter no longer submits, so this teaches Ctrl+Enter. */
function pulseSubmit() {
  qaSubmit.classList.remove("pulse");
  void (qaSubmit as HTMLElement).offsetWidth; // restart the animation on rapid presses
  qaSubmit.classList.add("pulse");
}

titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key !== "Enter") clearError();
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { setDropdownOpen(false); return; }
    await win.hide();
    return;
  }
  if (e.key === "Enter" && !e.ctrlKey) {
    e.preventDefault();
    pulseSubmit();
  }
});

// The submit key is Ctrl+Enter everywhere — regardless of focus or open popovers — so
// adding an issue never depends on where the cursor is. Plain Enter keeps each control's
// native role (popover select, button press, textarea newline). The date shortcuts pause
// while a popover or the project dropdown is open to stay out of their keyboard contracts.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    if (openPopover) closePopover();
    setDropdownOpen(false);
    submitIssue();
    return;
  }
  const shortcut = resolveDateShortcut(e.key, e.ctrlKey);
  if (shortcut && !openPopover && dropdown.hidden) {
    e.preventDefault();
    shiftDateField(shortcut.kind, shortcut.delta);
  }
});

qaSubmit.addEventListener("click", () => { submitIssue(); });
qaClose.addEventListener("click", () => {
  if (openPopover) closePopover();
  setDropdownOpen(false);
  win.hide();
});

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
bindTip(qaClose, "닫기 <kbd>Esc</kbd>", "below");

// Focus fires both when the window is summoned and when the user merely clicks
// back into the still-open window, so it must never touch the draft — a draft
// is cleared only by a successful submit (see submitIssue). Focus just parks
// the cursor and refreshes the project list (cooldown-gated).
win.listen("tauri://focus", () => {
  titleEl.focus();
  if (!isWithinCooldown(lastLoadAt, Date.now(), LOAD_COOLDOWN_MS)) load();
});

// Sidebar's per-project "+" button: pre-select that project. Any in-progress
// draft text survives the switch; only the project-scoped selections (assignees)
// reset. load() (if the focus event triggers it) re-reads last_project_id which
// the command already persisted to the same value.
win.listen<string>("select-project", (e) => {
  selectedId = e.payload;
  members = [];
  membersLoadedForProject = null;
  assigneeIds = [];
  renderSelected();
  renderDropdown();
  renderChips();
});
renderChips();
autoResizeDescription();
load();
