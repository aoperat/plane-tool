import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { deleteWorkItem, getSettings, getWorkItem, listMembers, updateWorkItemFields, type UpdateWorkItemFields } from "../shared/ipc";
import { buildIssueUrl } from "../sidebar/logic";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import { attachWheelCycle } from "../shared/wheelCycle";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import type { Member, WorkItem, WorkItemDetail } from "../shared/types";
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
const emChipDesc = document.getElementById("emChipDesc") as HTMLButtonElement;
const emFieldPopover = document.getElementById("emFieldPopover")!;
const emError = document.getElementById("emError")!;
const emDelete = document.getElementById("emDelete")!;
const emDeleteConfirm = document.getElementById("emDeleteConfirm")!;
const emDeleteConfirmYes = document.getElementById("emDeleteConfirmYes")!;
const emDeleteConfirmNo = document.getElementById("emDeleteConfirmNo")!;
const emSaveConfirm = document.getElementById("emSaveConfirm")!;
const emSaveConfirmYes = document.getElementById("emSaveConfirmYes")!;
const emSaveConfirmNo = document.getElementById("emSaveConfirmNo")!;
const emCancel = document.getElementById("emCancel")!;
const emSave = document.getElementById("emSave") as HTMLButtonElement;

let baseUrl = "";
let workspace = "";
let projectId = "";
let itemId = "";
let original: WorkItemDetail | null = null;
let snapshotOriginal: WorkItem | null = null;
let detailFetchPromise: Promise<WorkItemDetail> | null = null;
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

// ISO yyyy-mm-dd strings compare correctly with plain string ordering, so the
// clamps below don't need Date parsing.
function shiftDateField(kind: "start" | "due", delta: number) {
  if (kind === "start") {
    const current = resolveDateChoice(startChoice, startCustomDate);
    const next = shiftIsoDate(current, delta);
    startCustomDate = next;
    startChoice = "custom";
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
    const start = resolveDateChoice(startChoice, startCustomDate);
    if (start > next) {
      startCustomDate = next;
      startChoice = "custom";
    }
  }
  renderChips();
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

attachWheelCycle(emChipPriority, () => PRIORITY_ORDER.length, (delta) => {
  const i = PRIORITY_ORDER.indexOf(priority);
  priority = PRIORITY_ORDER[(i + delta + PRIORITY_ORDER.length) % PRIORITY_ORDER.length];
  renderChips();
  if (openPopover === "priority") openPriorityPopover();
});

attachWheelCycle(emChipState, () => STATE_ORDER.length, (delta) => {
  const i = STATE_ORDER.indexOf(stateGroup);
  stateGroup = STATE_ORDER[(i + delta + STATE_ORDER.length) % STATE_ORDER.length];
  renderChips();
  if (openPopover === "state") openStatePopover();
});

attachWheelCycle(emChipStart, () => 2, (delta) => {
  shiftDateField("start", delta);
  if (openPopover === "start") openDatePopover("start");
});
attachWheelCycle(emChipDue, () => 2, (delta) => {
  shiftDateField("due", delta);
  if (openPopover === "due") openDatePopover("due");
});

// EditModal's assignee popover is toggle-based multi-select (every click adds/removes a
// member — there's no "single pick" click like QuickAdd's). Wheel-cycling would silently
// collapse a real multi-assignee issue down to one person, so it's only active while 0 or
// 1 assignees are currently set. Cycle order is [null ("담당자 없음"), ...members], matching
// renderAssigneePopoverItems (src/editmodal/main.ts:144-158).
attachWheelCycle(
  emChipAssignee,
  () => (assigneeIds.length <= 1 ? members.length + 1 : 0),
  (delta) => {
    const options: (string | null)[] = [null, ...members.map((m) => m.id)];
    const i = options.indexOf(assigneeIds[0] ?? null);
    const nextValue = options[(i + delta + options.length) % options.length];
    assigneeIds = nextValue === null ? [] : [nextValue];
    renderChips();
    if (openPopover === "assignee") openAssigneePopover();
  },
);

emChipDesc.innerHTML = `${DESCRIPTION_ICON} 설명`;
emChipDesc.onclick = () => {
  if (openPopover) closePopover();
  setDescVisible(!descVisible);
};

function snapshotToDetail(snapshot: WorkItem): WorkItemDetail {
  return {
    id: snapshot.id, name: snapshot.name, description: "",
    assignee_ids: snapshot.assignee_ids,
    start_date: snapshot.start_date, target_date: snapshot.target_date,
    priority: snapshot.priority, state_group: snapshot.state_group,
    project_id: snapshot.project_id,
  };
}

// description을 제외한 필드만 폼에 채운다 — description은 호출부에서 별도로 다룬다.
function applyFieldsToForm(fields: Pick<WorkItemDetail,
  "name" | "assignee_ids" | "start_date" | "target_date" | "priority" | "state_group">) {
  emTitleInput.value = fields.name;
  assigneeIds = [...fields.assignee_ids];
  startChoice = "custom";
  startCustomDate = fields.start_date ?? "";
  dueChoice = "custom";
  dueCustomDate = fields.target_date ?? "";
  priority = fields.priority as Priority;
  stateGroup = fields.state_group as StateGroup;
  renderChips();
}

function setDescriptionLoading(loading: boolean) {
  emChipDesc.disabled = loading;
  if (loading) emChipDesc.title = "설명 불러오는 중…";
}

async function loadItem(pid: string, iid: string, snapshot?: WorkItem) {
  // Re-assert always-on-top every time an item is loaded, mirroring the
  // sidebar's showSidebar() — openInBrowser() drops it so the browser window can
  // surface above the modal, and nothing else restores it afterward.
  win.setAlwaysOnTop(true).catch((err) => {
    console.error("setAlwaysOnTop failed:", err);
  });
  closePopover();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
  // closeModal()은 창을 숨기기만 해서 같은 항목을 다시 열 때 원본 데이터가 메모리에
  // 그대로 남아있다 — 재요청 없이 그대로 보여준다.
  if (original && pid === projectId && iid === itemId) {
    emTitleInput.focus();
    resizeToFit();
    return;
  }
  const requestId = ++loadRequestId;
  projectId = pid;
  itemId = iid;
  original = null;
  snapshotOriginal = snapshot ?? null;
  detailFetchPromise = null;
  members = [];
  membersLoadedForProject = null;
  emError.hidden = true;
  emTitleInput.classList.remove("error");

  if (snapshot) {
    // 이미 동기화로 받아둔 값이 있다 — 전체 스피너 없이 즉시 편집 가능한 폼을 보여준다.
    applyFieldsToForm(snapshot);
    emDescription.value = "";
    setDescVisible(false, false);
    setDescriptionLoading(true);
    emForm.hidden = false;
    emLoading.hidden = true;
    resizeToFit();
    emTitleInput.focus();
  } else {
    emForm.hidden = true;
    emLoading.hidden = false;
    emLoading.textContent = "불러오는 중…";
    resizeToFit();
  }

  const fetchPromise = getWorkItem(pid, iid);
  if (snapshot) detailFetchPromise = fetchPromise;

  try {
    const detail = await fetchPromise;
    if (requestId !== loadRequestId) return;
    original = detail;
    if (!snapshot) {
      // 스냅샷이 있었다면 이미 채워둔 폼 값(사용자가 편집 중일 수 있음)은 덮어쓰지
      // 않는다 — description만 이 fetch로 채운다.
      applyFieldsToForm(detail);
    }
    emDescription.value = detail.description;
    setDescriptionLoading(false);
    // Auto-show an existing description — hiding it would read as "deleted".
    setDescVisible(detail.description !== "", false);
    emLoading.hidden = true;
    emForm.hidden = false;
    resizeToFit();
    if (!snapshot) emTitleInput.focus();
  } catch (err) {
    if (requestId !== loadRequestId) return;
    if (snapshot) {
      // 오프라인 등으로 최신 데이터를 못 가져왔다 — 스냅샷을 기준값으로 확정하고
      // 계속 편집 가능하게 둔다(설명은 빈 값으로 취급).
      original = snapshotToDetail(snapshot);
      setDescriptionLoading(false);
      console.error("getWorkItem background refresh failed:", err);
    } else {
      emLoading.textContent = "불러오기 실패: " + err;
      console.error("getWorkItem failed:", err);
      resizeToFit();
    }
  }
}

function closeModal() {
  closePopover();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
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

function hasConflictWithSnapshot(fetched: WorkItemDetail, snapshot: WorkItem): boolean {
  if (fetched.name !== snapshot.name) return true;
  if ((fetched.start_date ?? "") !== (snapshot.start_date ?? "")) return true;
  if ((fetched.target_date ?? "") !== (snapshot.target_date ?? "")) return true;
  if (fetched.priority !== snapshot.priority) return true;
  if (fetched.state_group !== snapshot.state_group) return true;
  const fetchedAssignees = [...fetched.assignee_ids].sort();
  const snapshotAssignees = [...snapshot.assignee_ids].sort();
  return JSON.stringify(fetchedAssignees) !== JSON.stringify(snapshotAssignees);
}

// Set while a confirmSaveConflict() promise is pending, so a force-close (modal close,
// loadItem for a different item, or Escape) can still resolve it instead of leaking a
// forever-pending save() call — see closeSaveConflict().
let pendingSaveConflictResolve: ((proceed: boolean) => void) | null = null;

function confirmSaveConflict(): Promise<boolean> {
  return new Promise((resolve) => {
    emSaveConfirm.hidden = false;
    resizeToFit();
    pendingSaveConflictResolve = resolve;
    emSaveConfirmYes.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeToFit();
      resolve(true);
    };
    emSaveConfirmNo.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeToFit();
      resolve(false);
    };
  });
}

// Force-closes the save-conflict popup from anywhere other than its own Yes/No
// buttons (closeModal, loadItem, Escape) — treats an abandoned popup as "cancel"
// so any pending confirmSaveConflict() promise still resolves.
function closeSaveConflict() {
  if (pendingSaveConflictResolve) {
    const resolve = pendingSaveConflictResolve;
    pendingSaveConflictResolve = null;
    resolve(false);
  }
  emSaveConfirm.hidden = true;
}

async function save() {
  if (detailFetchPromise && !original) {
    emSave.disabled = true;
    try {
      await detailFetchPromise;
    } catch {
      // 실패 시 loadItem의 catch가 이미 original을 스냅샷 기준으로 채워둔다.
    } finally {
      emSave.disabled = false;
    }
  }
  if (!original) return;

  if (snapshotOriginal && hasConflictWithSnapshot(original, snapshotOriginal)) {
    const proceed = await confirmSaveConflict();
    if (!proceed) return;
  }

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
    if (!emSaveConfirm.hidden) {
      closeSaveConflict();
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

win.listen<{ projectId: string; itemId: string; snapshot?: WorkItem }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId, event.payload.snapshot);
});

async function loadSettings() {
  const s = await getSettings();
  baseUrl = s.base_url;
  workspace = s.workspace;
  applyTheme(s.theme);
}

resizeToFit();
loadSettings();
