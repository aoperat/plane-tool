import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project, Member } from "../shared/types";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
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
const fieldPopover = document.getElementById("fieldPopover")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
const errorEl = document.getElementById("qaError")!;

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
// the popup's own box for the idle height, plus the open popover's real
// bottom edge (which varies with its content and can't be hardcoded).
function resizeToFit() {
  let height = Math.ceil(popupEl.getBoundingClientRect().height);
  if (openPopover && !fieldPopover.hidden) {
    const popoverBottom = Math.ceil(fieldPopover.getBoundingClientRect().bottom);
    height = Math.max(height, popoverBottom);
  }
  height += 4; // small buffer so a border/shadow pixel never gets clipped
  win.setSize(new LogicalSize(540, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

function dateChoiceLabel(choice: DateChoice, custom: string): string {
  if (choice === "custom") return custom || "날짜 선택";
  return DATE_PRESETS.find((d) => d.key === choice)!.label;
}

function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}

function shiftDateField(kind: "start" | "due", delta: number) {
  if (kind === "start") {
    const current = resolveDateChoice(startChoice, startCustomDate);
    startCustomDate = shiftIsoDate(current, delta);
    startChoice = "custom";
  } else {
    const current = resolveDateChoice(dueChoice, dueCustomDate);
    dueCustomDate = shiftIsoDate(current, delta);
    dueChoice = "custom";
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

async function submitIssue() {
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
      dropdown.hidden = true;
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
  descriptionEl.style.height = "auto";
  descriptionEl.style.height = `${descriptionEl.scrollHeight}px`;
  resizeToFit();
}

descriptionEl.addEventListener("input", autoResizeDescription);

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

function toggleAssignee(id: string | null) {
  if (id === null) {
    assigneeIds = [];
  } else if (assigneeIds.includes(id)) {
    assigneeIds = assigneeIds.filter((x) => x !== id);
  } else {
    assigneeIds = [...assigneeIds, id];
  }
  renderChips();
  renderAssigneePopoverItems();
}

function renderAssigneePopoverItems() {
  fieldPopover.innerHTML = "";
  const selfItem = document.createElement("div");
  selfItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  selfItem.textContent = "나 (기본값)";
  selfItem.onclick = () => toggleAssignee(null);
  fieldPopover.appendChild(selfItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
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

const fieldPopoverKeydown = handleDropdownKeydown(fieldPopover, () => openPopover !== null, () => {
  closePopover();
  titleEl.focus();
});
chipAssignee.addEventListener("keydown", fieldPopoverKeydown);
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);

// DOM order of the field chips, used for ArrowLeft/ArrowRight navigation between them.
const chips = [chipAssignee, chipStart, chipDue, chipState, chipPriority];

/** Moves focus to the previous/next chip in `chips` (no wrap). No-op while a dropdown is open,
 *  since ArrowUp/ArrowDown already own navigation there (see `handleDropdownKeydown`). */
function handleChipArrowNav(e: KeyboardEvent) {
  if (openPopover !== null) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const currentIndex = chips.indexOf(e.currentTarget as HTMLElement);
  const nextIndex = currentIndex + (e.key === "ArrowRight" ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= chips.length) return;
  e.preventDefault();
  chips[nextIndex].focus();
}
chips.forEach((chip) => chip.addEventListener("keydown", handleChipArrowNav));

function resetFields() {
  assigneeIds = [];
  startChoice = "today";
  startCustomDate = "";
  dueChoice = "today";
  dueCustomDate = "";
  priority = "none";
  stateGroup = "unstarted";
  descriptionEl.value = "";
  clearError();
  autoResizeDescription();
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
  dropdown.hidden = !dropdown.hidden;
  if (!dropdown.hidden) initKeyboardFocus(dropdown);
};
projBtn.addEventListener(
  "keydown",
  handleDropdownKeydown(dropdown, () => !dropdown.hidden, () => {
    dropdown.hidden = true;
    titleEl.focus();
  }),
);

titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key !== "Enter") clearError();
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    await win.hide();
    return;
  }
  if (!openPopover && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    const delta = e.key === "]" ? 1 : -1;
    shiftDateField(e.ctrlKey ? "due" : "start", delta);
    return;
  }
  if (e.key === "Enter") {
    if (openPopover) return;
    await submitIssue();
  }
});

descriptionEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    await submitIssue();
  }
});

win.listen("tauri://focus", () => {
  titleEl.focus();
  titleEl.value = "";
  resetFields();
  if (!isWithinCooldown(lastLoadAt, Date.now(), LOAD_COOLDOWN_MS)) load();
});
renderChips();
autoResizeDescription();
load();
