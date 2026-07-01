import { getCurrentWindow } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project, Member } from "../shared/types";
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from "../shared/datePresets";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import "../shared/app.css";

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

let projects: Project[] = [];
let selectedId: string | null = null;
let members: Member[] = [];
let membersLoadedForProject: string | null = null;

let assigneeIds: string[] = []; // empty = server defaults to self
let startPreset: DatePresetKey = "today";
let duePreset: DatePresetKey = "today";
let priority: Priority = "none";
let stateGroup: StateGroup = "backlog";

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;
let openPopover: PopoverKind = null;

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

function assigneeChipHtml(): string {
  if (assigneeIds.length === 0) return `<span class="avatar">나</span> 나`;
  if (assigneeIds.length === 1) {
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    return `<span class="avatar">${name.slice(0, 1)}</span> ${name}`;
  }
  return `<span class="avatar">${assigneeIds.length}</span> ${assigneeIds.length}명`;
}

function renderChips() {
  chipAssignee.innerHTML = assigneeChipHtml();
  chipStart.innerHTML = `${CALENDAR_ICON} ${DATE_PRESETS.find((d) => d.key === startPreset)!.label}`;
  chipDue.innerHTML = `${FLAG_ICON} ${DATE_PRESETS.find((d) => d.key === duePreset)!.label}`;
  chipPriority.innerHTML =
    `${priorityIcon(priority)} <span class="${priority === "none" ? "muted" : ""}">${priorityLabel(priority)}</span>`;
  chipState.innerHTML = `${stateIcon(stateGroup)} ${stateLabel(stateGroup)}`;
}

function closePopover() {
  openPopover = null;
  fieldPopover.hidden = true;
  fieldPopover.innerHTML = "";
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
}

function openDatePopover(kind: "start" | "due") {
  fieldPopover.innerHTML = "";
  const current = kind === "start" ? startPreset : duePreset;
  for (const preset of DATE_PRESETS) {
    const item = document.createElement("div");
    item.className = "dd-item" + (preset.key === current ? " sel" : "");
    item.textContent = preset.label;
    item.onclick = () => {
      if (kind === "start") startPreset = preset.key;
      else duePreset = preset.key;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = kind;
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
  fieldPopover.hidden = false;
  openPopover = "priority";
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
  fieldPopover.hidden = false;
  openPopover = "state";
}

chipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
chipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
chipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
chipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
chipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };

function resetFields() {
  assigneeIds = [];
  startPreset = "today";
  duePreset = "today";
  priority = "none";
  stateGroup = "backlog";
  closePopover();
  renderChips();
}

async function load() {
  const [settings, fetched] = await Promise.all([getSettings(), listProjects().catch(() => [])]);
  projects = fetched;
  selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  renderSelected();
  renderDropdown();
}

projBtn.onclick = () => { dropdown.hidden = !dropdown.hidden; };

titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    await win.hide();
    return;
  }
  if (e.key === "Enter") {
    if (openPopover) return;
    const name = titleEl.value.trim();
    if (!name || !selectedId) return;
    try {
      await createIssue(
        selectedId,
        name,
        assigneeIds,
        resolveDatePreset(startPreset),
        resolveDatePreset(duePreset),
        priority,
        stateGroup,
      );
      titleEl.value = "";
      resetFields();
      await win.hide();
    } catch (err) {
      titleEl.classList.add("error");
      console.error(err);
    }
  }
});

win.listen("tauri://focus", () => {
  titleEl.focus();
  titleEl.value = "";
  resetFields();
  load();
});
renderChips();
load();
