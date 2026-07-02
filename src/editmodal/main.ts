import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { deleteWorkItem, getSettings, getWorkItem, listMembers, updateWorkItemFields, type UpdateWorkItemFields } from "../shared/ipc";
import { buildIssueUrl } from "../sidebar/logic";
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from "../shared/datePresets";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import type { Member, WorkItemDetail } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const modalEl = document.querySelector(".editmodal") as HTMLElement;
const emBrowserBtn = document.getElementById("emBrowserBtn")!;
const emClose = document.getElementById("emClose")!;
const emLoading = document.getElementById("emLoading")!;
const emForm = document.getElementById("emForm")!;
const emTitleInput = document.getElementById("emTitleInput") as HTMLInputElement;
const emDescription = document.getElementById("emDescription") as HTMLTextAreaElement;
const emChipAssignee = document.getElementById("emChipAssignee")!;
const emChipStart = document.getElementById("emChipStart")!;
const emChipDue = document.getElementById("emChipDue")!;
const emChipState = document.getElementById("emChipState")!;
const emChipPriority = document.getElementById("emChipPriority")!;
const emChipDesc = document.getElementById("emChipDesc")!;
const emFieldPopover = document.getElementById("emFieldPopover")!;
const emError = document.getElementById("emError")!;
const emDelete = document.getElementById("emDelete")!;
const emDeleteConfirm = document.getElementById("emDeleteConfirm")!;
const emDeleteConfirmYes = document.getElementById("emDeleteConfirmYes")!;
const emDeleteConfirmNo = document.getElementById("emDeleteConfirmNo")!;
const emCancel = document.getElementById("emCancel")!;
const emSave = document.getElementById("emSave")!;

let baseUrl = "";
let workspace = "";
let projectId = "";
let itemId = "";
let original: WorkItemDetail | null = null;
let members: Member[] = [];
let membersLoadedForProject: string | null = null;

let loadRequestId = 0;

let assigneeIds: string[] = [];
type DateChoice = DatePresetKey | "custom";
let startChoice: DateChoice = "custom";
let startCustomDate = "";
let dueChoice: DateChoice = "custom";
let dueCustomDate = "";
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;
let openPopover: PopoverKind = null;

// Same "measure the real box" approach as QuickAdd's resizeToFit — see
// src/quickadd/main.ts for why this beats guessing pixel constants.
function resizeToFit() {
  let height = Math.ceil(modalEl.getBoundingClientRect().height);
  if (openPopover && !emFieldPopover.hidden) {
    height = Math.max(height, Math.ceil(emFieldPopover.getBoundingClientRect().bottom));
  }
  height += 4;
  win.setSize(new LogicalSize(540, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

// Same hide-only semantics as QuickAdd's setDescVisible — the textarea's value
// survives toggling, so save() still sees (and diffs) the existing description.
let descVisible = false;
function setDescVisible(visible: boolean, focus = true) {
  descVisible = visible;
  emDescription.hidden = !visible;
  emChipDesc.classList.toggle("active", visible);
  emChipDesc.title = visible ? "설명 숨기기" : "설명 추가";
  resizeToFit();
  if (visible && focus) emDescription.focus();
}

function dateChoiceLabel(choice: DateChoice, custom: string): string {
  if (choice === "custom") return custom || "날짜 선택";
  return DATE_PRESETS.find((d) => d.key === choice)!.label;
}

function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}

function renderAssigneeChip() {
  emChipAssignee.textContent = "";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  let label: string;
  if (assigneeIds.length === 0) {
    // Unlike QuickAdd (where an empty selection defaults to "me" at creation
    // time), an edited item can genuinely have nobody assigned — say so.
    avatar.textContent = "-";
    label = "담당자 없음";
  } else if (assigneeIds.length === 1) {
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    avatar.textContent = name.slice(0, 1);
    label = name;
  } else {
    avatar.textContent = String(assigneeIds.length);
    label = `${assigneeIds.length}명`;
  }
  emChipAssignee.appendChild(avatar);
  emChipAssignee.appendChild(document.createTextNode(" " + label));
}

function renderChips() {
  renderAssigneeChip();
  emChipStart.innerHTML = `${CALENDAR_ICON} ${dateChoiceLabel(startChoice, startCustomDate)}`;
  emChipDue.innerHTML = `${FLAG_ICON} ${dateChoiceLabel(dueChoice, dueCustomDate)}`;
  emChipPriority.innerHTML =
    `${priorityIcon(priority)} <span class="${priority === "none" ? "muted" : ""}">${priorityLabel(priority)}</span>`;
  emChipState.innerHTML = `${stateIcon(stateGroup)} ${stateLabel(stateGroup)}`;
}

function closePopover() {
  openPopover = null;
  emFieldPopover.hidden = true;
  emFieldPopover.innerHTML = "";
  resizeToFit();
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
  emFieldPopover.innerHTML = "";
  const noneItem = document.createElement("div");
  noneItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  noneItem.textContent = "담당자 없음";
  noneItem.onclick = () => toggleAssignee(null);
  emFieldPopover.appendChild(noneItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
    emFieldPopover.appendChild(item);
  }
}

async function openAssigneePopover() {
  if (!projectId) return;
  if (membersLoadedForProject !== projectId) {
    try {
      members = await listMembers(projectId);
      membersLoadedForProject = projectId;
    } catch (err) {
      members = [];
      console.error("listMembers failed:", err);
    }
  }
  renderAssigneePopoverItems();
  emFieldPopover.hidden = false;
  openPopover = "assignee";
  resizeToFit();
}

function openDatePopover(kind: "start" | "due") {
  emFieldPopover.innerHTML = "";
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
    };
    emFieldPopover.appendChild(item);
  }
  const divider = document.createElement("div");
  divider.className = "popover-divider";
  emFieldPopover.appendChild(divider);
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
  };
  emFieldPopover.appendChild(dateInput);
  emFieldPopover.hidden = false;
  openPopover = kind;
  resizeToFit();
}

function openPriorityPopover() {
  emFieldPopover.innerHTML = "";
  for (const p of PRIORITY_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p === priority ? " sel" : "");
    item.innerHTML = `${priorityIcon(p)} ${priorityLabel(p)}`;
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
    };
    emFieldPopover.appendChild(item);
  }
  emFieldPopover.hidden = false;
  openPopover = "priority";
  resizeToFit();
}

function openStatePopover() {
  emFieldPopover.innerHTML = "";
  for (const g of STATE_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (g === stateGroup ? " sel" : "");
    item.innerHTML = `${stateIcon(g)} ${stateLabel(g)}`;
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
    };
    emFieldPopover.appendChild(item);
  }
  emFieldPopover.hidden = false;
  openPopover = "state";
  resizeToFit();
}

emChipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
emChipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
emChipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
emChipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
emChipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };
emChipDesc.innerHTML = `${DESCRIPTION_ICON} 설명`;
emChipDesc.onclick = () => {
  if (openPopover) closePopover();
  setDescVisible(!descVisible);
};

async function loadItem(pid: string, iid: string) {
  // Re-assert always-on-top every time an item is loaded, mirroring the
  // sidebar's slideIn() — openInBrowser() drops it so the browser window can
  // surface above the modal, and nothing else restores it afterward.
  win.setAlwaysOnTop(true).catch((err) => {
    console.error("setAlwaysOnTop failed:", err);
  });
  const requestId = ++loadRequestId;
  projectId = pid;
  itemId = iid;
  original = null;
  members = [];
  membersLoadedForProject = null;
  closePopover();
  emDeleteConfirm.hidden = true;
  emError.hidden = true;
  emTitleInput.classList.remove("error");
  emForm.hidden = true;
  emLoading.hidden = false;
  emLoading.textContent = "불러오는 중…";
  resizeToFit();
  try {
    const detail = await getWorkItem(pid, iid);
    if (requestId !== loadRequestId) return;
    original = detail;
    emTitleInput.value = detail.name;
    emDescription.value = detail.description;
    // Auto-show an existing description — hiding it would read as "deleted".
    setDescVisible(detail.description !== "", false);
    assigneeIds = [...detail.assignee_ids];
    // Always initialize as "custom" showing the loaded date literally — the
    // preset chips (오늘/내일/다음 주) remain clickable if the user wants to
    // switch to a relative date, but there's no "existing value" concept for
    // presets, unlike QuickAdd's always-fresh "오늘" default.
    startChoice = "custom";
    startCustomDate = detail.start_date ?? "";
    dueChoice = "custom";
    dueCustomDate = detail.target_date ?? "";
    priority = detail.priority as Priority;
    stateGroup = detail.state_group as StateGroup;
    renderChips();
    emLoading.hidden = true;
    emForm.hidden = false;
    resizeToFit();
    emTitleInput.focus();
  } catch (err) {
    emLoading.textContent = "불러오기 실패: " + err;
    console.error("getWorkItem failed:", err);
    resizeToFit();
  }
}

function closeModal() {
  closePopover();
  emDeleteConfirm.hidden = true;
  win.hide();
}

async function openInBrowser() {
  if (!projectId || !itemId) return;
  const url = buildIssueUrl(baseUrl, workspace, projectId, itemId);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the modal instead of behind it — same fix as the
    // sidebar's openInBrowser.
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    console.error("openUrl failed:", url, err);
  }
}

async function save() {
  if (!original) return;
  const name = emTitleInput.value.trim();
  if (!name) {
    emTitleInput.classList.add("error");
    emTitleInput.focus();
    return;
  }
  const description = emDescription.value;
  const startDate = resolveDateChoice(startChoice, startCustomDate);
  const dueDate = resolveDateChoice(dueChoice, dueCustomDate);

  const fields: UpdateWorkItemFields = {};
  if (name !== original.name) fields.name = name;
  if (description !== original.description) fields.description = description;
  const sortedCurrent = [...assigneeIds].sort();
  const sortedOriginal = [...original.assignee_ids].sort();
  if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedOriginal)) fields.assignee_ids = assigneeIds;
  if (startDate && startDate !== (original.start_date ?? "")) fields.start_date = startDate;
  if (dueDate && dueDate !== (original.target_date ?? "")) fields.target_date = dueDate;
  if (priority !== original.priority) fields.priority = priority;
  if (stateGroup !== original.state_group) fields.state_group = stateGroup;

  if (Object.keys(fields).length === 0) {
    await win.hide();
    return;
  }

  emError.hidden = true;
  try {
    await updateWorkItemFields(projectId, itemId, fields);
    await win.hide();
  } catch (err) {
    emError.hidden = false;
    emError.textContent = "저장 실패: " + err;
    console.error("updateWorkItemFields failed:", err);
    resizeToFit();
  }
}

emClose.onclick = closeModal;
emCancel.onclick = closeModal;
emSave.onclick = save;
emBrowserBtn.onclick = openInBrowser;

emDelete.onclick = () => {
  emDeleteConfirm.hidden = false;
  resizeToFit();
};
emDeleteConfirmNo.onclick = () => {
  emDeleteConfirm.hidden = true;
  resizeToFit();
};
emDeleteConfirmYes.onclick = async () => {
  try {
    await deleteWorkItem(projectId, itemId);
    await win.hide();
  } catch (err) {
    emDeleteConfirm.hidden = true;
    emError.hidden = false;
    emError.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
    resizeToFit();
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
      return;
    }
    if (!emDeleteConfirm.hidden) {
      emDeleteConfirm.hidden = true;
      resizeToFit();
      return;
    }
    closeModal();
    return;
  }
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    save();
  }
});

win.listen<{ projectId: string; itemId: string }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId);
});

async function loadSettings() {
  const s = await getSettings();
  baseUrl = s.base_url;
  workspace = s.workspace;
  applyTheme(s.theme);
}

resizeToFit();
loadSettings();
