import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getVersion } from "@tauri-apps/api/app";
import { acknowledgeAssignment, checkUpdatesManual, createIssue, deleteWorkItem, fetchReleaseNotes, fetchSidebarData, getOfflineStatus, getPendingAssignments, getSettings, openBriefing, openEditModal, openSettings, saveSettings, showQuickaddForProject, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { notesToHtml } from "./releaseNotes";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon, CALENDAR_ICON, EXTERNAL_LINK_ICON } from "../shared/planeIcons";
import { buildIssueUrl, computeSidebarGeometry, filterHiddenCompleted, filterVisibleToday, formatDateRange, formatLocalTime, formatRelativeTime, groupItemsByProject, groupProgress, offlineStatusText, resolveStateId } from "./logic";
import { sortMonitorsByPosition, pickMonitor } from "../shared/monitors";
import { isWithinCooldown } from "../shared/cooldown";
import { applyTheme, toggledThemePref } from "../shared/theme";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
import type { SidebarData, Project, ReleaseNote, WorkItem, ProjectState, PendingAssignment } from "../shared/types";
import "../shared/app.css";

const PANEL_WIDTH = 320;
// Every window focus (including re-showing the sidebar on toggle) re-fetches the full sidebar
// data set, which itself is an N+1 request per project — a cooldown keeps rapid re-focusing
// (fast toggle spam, alt-tab cycling) from bursting past the Plane server's rate limit.
const REFRESH_COOLDOWN_MS = 3000;

const win = getCurrentWindow();
const tasksEl = document.getElementById("tasks")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
const pinEl = document.getElementById("pin")!;
const inboxEl = document.getElementById("inbox")!;
let baseUrl = "";
let workspace = "";
let states: ProjectState[] = [];
let openPopover: HTMLElement | null = null;
let pinned = false;
// 유휴 자동 열림 보호: true인 동안은 blur 자동 숨김을 무시한다. 사용자가
// 자리에 없을 때 열린 사이드바는 키보드/마우스 입력 없이는 닫히면 안 되고,
// 무인 상태에서는 화면 잠금·알림·다른 앱 활성화 등이 얼마든지 blur를
// 일으킬 수 있기 때문. 입력이 재개되면(백엔드 idle-ended, 또는 사이드바
// 직접 조작) 해제되어 평소 규칙으로 복귀한다.
let autoOpened = false;
let themePref = "auto";
let lastRefreshAt = 0;
const collapsedGroups = new Set<string>();
let lastItems: WorkItem[] = [];
let lastProjects: Project[] = [];
let pendingCount = 0;

// View preference, persisted in the webview's localStorage (no backend setting needed).
const HIDE_DONE_KEY = "hideCompleted";
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) === "1";
const hideDoneEl = document.getElementById("hideDone")!;

const EYE_ICON =
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`;
const EYE_OFF_ICON =
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/></svg>`;

// The button states its *current* mode (icon + label), not the action —
// an action-labeled toggle reads ambiguously in both directions.
function syncHideDoneButton() {
  hideDoneEl.classList.toggle("active", hideCompleted);
  hideDoneEl.innerHTML = hideCompleted ? `${EYE_OFF_ICON}<span>완료 숨김</span>` : `${EYE_ICON}<span>완료 표시</span>`;
  hideDoneEl.title = hideCompleted ? "클릭하면 완료된 항목을 다시 표시합니다" : "클릭하면 완료된 항목을 숨깁니다";
}
syncHideDoneButton();

hideDoneEl.onclick = () => {
  hideCompleted = !hideCompleted;
  localStorage.setItem(HIDE_DONE_KEY, hideCompleted ? "1" : "0");
  syncHideDoneButton();
  renderTasks(lastItems, lastProjects);
};

pinEl.onclick = () => {
  pinned = !pinned;
  pinEl.classList.toggle("active", pinned);
  pinEl.title = pinned
    ? "고정됨 — 클릭하면 다른 창 활성화 시 자동으로 닫힙니다"
    : "고정 — 다른 창이 활성화돼도 사이드바를 열어둡니다";
};

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const STATE_LABELS: Record<string, string> = {
  backlog: "백로그", unstarted: "시작 전", started: "진행 중", completed: "완료", cancelled: "취소",
};
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "없음",
};

const PLUS_ICON =
  `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`;

const RING_CIRCUMFERENCE = 2 * Math.PI * 6; // viewBox 16, r=6

function progressRingSvg(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0;
  const arc = frac > 0
    ? `<circle cx="8" cy="8" r="6" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-dasharray="${(frac * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 8 8)"/>`
    : "";
  return `<svg class="ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" stroke-width="2.4"/>${arc}</svg>`;
}

/** Optimistically applies a single date-field change and syncs it to the server.
 *  `value: null` clears the field (sent as "" — the backend maps it to JSON null). */
function applyDateChange(
  it: WorkItem,
  allItems: WorkItem[],
  projects: Project[],
  field: "start_date" | "target_date",
  value: string | null,
) {
  const prev = it[field];
  it[field] = value;
  renderTasks(allItems, projects);
  const payload = field === "start_date" ? { start_date: value ?? "" } : { target_date: value ?? "" };
  updateWorkItemFields(it.project_id, it.id, payload).catch((err) => {
    it[field] = prev;
    renderTasks(allItems, projects);
    synced.textContent = "기간 변경 실패: " + err;
    console.error("updateWorkItemFields failed:", err);
  });
}

function dateInputRow(label: string, value: string | null, onPick: (v: string | null) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "date-row";
  const lab = document.createElement("span");
  lab.className = "date-row-label";
  lab.textContent = label;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "date";
  input.className = "popover-date-input";
  input.value = value ?? "";
  input.onclick = (e) => e.stopPropagation();
  input.onchange = () => {
    if (input.value) onPick(input.value);
  };
  row.appendChild(input);
  const clear = document.createElement("span");
  clear.className = "date-row-clear";
  clear.textContent = "×";
  clear.title = "지우기";
  clear.onclick = (e) => {
    e.stopPropagation();
    onPick(null);
  };
  row.appendChild(clear);
  return row;
}

function openSidebarDatePopover(anchor: HTMLElement, it: WorkItem, allItems: WorkItem[], projects: Project[]) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = "200px";
  pop.onclick = (e) => e.stopPropagation();

  for (const preset of DATE_PRESETS) {
    const opt = document.createElement("div");
    opt.className = "pop-item";
    opt.textContent = "마감일: " + preset.label;
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      applyDateChange(it, allItems, projects, "target_date", resolveDatePreset(preset.key));
    };
    pop.appendChild(opt);
  }

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  pop.appendChild(dateInputRow("시작일", it.start_date, (v) => {
    closePopover();
    applyDateChange(it, allItems, projects, "start_date", v);
  }));
  pop.appendChild(dateInputRow("마감일", it.target_date, (v) => {
    closePopover();
    applyDateChange(it, allItems, projects, "target_date", v);
  }));

  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}

function openStatePopover(anchor: HTMLElement, item: WorkItem, onPicked: (group: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  // Body-level fixed positioning (see attachPopover) — nesting inside the
  // row breaks on completed rows: their opacity creates a stacking context,
  // so the popover renders semi-transparent and rows below it win hover/click.
  pop.style.position = "fixed";
  for (const group of STATE_GROUPS) {
    const opt = document.createElement("div");
    opt.className = "pop-item" + (group === item.state_group ? " sel" : "");
    opt.innerHTML = stateIcon(group);
    opt.appendChild(document.createTextNode(STATE_LABELS[group]));
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onPicked(group);
    };
    pop.appendChild(opt);
  }
  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

function openPriorityPopover(anchor: HTMLElement, item: WorkItem, onPicked: (priority: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  // Body-level fixed positioning (see attachPopover) — nesting inside the
  // anchor chip doesn't work here because .chip has overflow:hidden, which
  // clips the popover entirely.
  pop.style.position = "fixed";
  for (const p of PRIORITIES) {
    const opt = document.createElement("div");
    opt.className = "pop-item" + (p === item.priority ? " sel" : "");
    opt.style.color = priorityColor(p as any);
    opt.innerHTML = priorityIcon(p as any);
    opt.appendChild(document.createTextNode(PRIORITY_LABELS[p]));
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onPicked(p);
    };
    pop.appendChild(opt);
  }
  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

/** Opens `url` in the default browser, dropping always-on-top first so the
 *  browser window can appear above the sidebar instead of behind it. */
async function openExternal(url: string) {
  try {
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    synced.textContent = "열기 실패: " + err;
    console.error("openUrl failed:", url, err);
  }
}

async function openInBrowser(it: WorkItem) {
  await openExternal(buildIssueUrl(baseUrl, workspace, it.project_id, it.id));
}

async function duplicateWorkItem(it: WorkItem) {
  try {
    // No assignee_ids on the frontend WorkItem type — an empty list makes
    // create_issue default to the current user, which is correct here since
    // the sidebar only ever lists items already assigned to the current user.
    await createIssue(it.project_id, it.name, [], undefined, it.target_date ?? undefined, it.priority, it.state_group, "");
    await refresh();
  } catch (err) {
    synced.textContent = "복사본 생성 실패: " + err;
    console.error("createIssue (duplicate) failed:", err);
  }
}

async function deleteWorkItemAction(it: WorkItem) {
  try {
    await deleteWorkItem(it.project_id, it.id);
  } catch (err) {
    synced.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
  }
}

async function copyIssueLink(it: WorkItem) {
  const url = buildIssueUrl(baseUrl, workspace, it.project_id, it.id);
  try {
    await writeText(url);
    synced.textContent = "링크 복사됨";
  } catch (err) {
    synced.textContent = "링크 복사 실패: " + err;
    console.error("writeText failed:", err);
  }
}

const CONTEXT_MENU_WIDTH = 180;

/**
 * Attaches `pop` to `document.body` (not the row it was triggered from) with
 * fixed positioning at viewport coordinates (x, y), clamped to stay on
 * screen. Popovers are taller than a single row, so nesting them inside a
 * row let them visually spill into sibling rows below — since those siblings
 * are later in the DOM, they'd win hover/click there instead of the menu
 * (and a completed row's opacity makes the nested popover translucent too).
 * Body-level fixed positioning sidesteps that entirely.
 */
function attachPopover(pop: HTMLElement, x: number, y: number) {
  document.body.appendChild(pop);
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width)) + "px";
  pop.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height)) + "px";
  openPopover = pop;
}

/** Appends a standard clickable menu row to `pop`; clicking closes the popover, then runs `onClick`. */
function appendPopItem(pop: HTMLElement, label: string, onClick: () => void) {
  const opt = document.createElement("div");
  opt.className = "pop-item";
  opt.textContent = label;
  opt.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    onClick();
  };
  pop.appendChild(opt);
}

function openContextMenu(it: WorkItem, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";

  appendPopItem(pop, "복사본 만들기", () => duplicateWorkItem(it));
  appendPopItem(pop, "새 탭에서 열기", () => openInBrowser(it));
  appendPopItem(pop, "링크 복사", () => copyIssueLink(it));

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  appendPopItem(pop, "삭제", () => openDeleteConfirm(it, x, y));

  attachPopover(pop, x, y);
}

function openDeleteConfirm(it: WorkItem, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";

  const msg = document.createElement("div");
  msg.className = "pop-msg";
  msg.textContent = "정말 삭제하시겠습니까?";
  pop.appendChild(msg);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  const del = document.createElement("div");
  del.className = "pop-item";
  del.textContent = "삭제";
  del.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    deleteWorkItemAction(it);
  };
  pop.appendChild(del);

  const cancel = document.createElement("div");
  cancel.className = "pop-item";
  cancel.textContent = "취소";
  cancel.onclick = (e) => {
    e.stopPropagation();
    closePopover();
  };
  pop.appendChild(cancel);

  attachPopover(pop, x, y);
}

function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task" + (it.state_group === "completed" ? " completed" : "");

  const top = document.createElement("div");
  top.className = "task-top";

  const stateBtn = document.createElement("span");
  stateBtn.className = "task-state";
  stateBtn.title = "상태: " + STATE_LABELS[it.state_group];
  stateBtn.innerHTML = stateIcon(it.state_group as any);
  stateBtn.onclick = (e) => {
    e.stopPropagation();
    openStatePopover(stateBtn, it, (group) => {
      const stateId = resolveStateId(states, it.project_id, group);
      if (!stateId) {
        synced.textContent = "상태 변경 실패: 해당 그룹의 상태를 찾을 수 없음";
        return;
      }
      const prev = it.state_group;
      it.state_group = group;
      renderTasks(allItems, projects);
      updateWorkItemState(it.project_id, it.id, stateId).catch((err) => {
        it.state_group = prev;
        renderTasks(allItems, projects);
        synced.textContent = "상태 변경 실패: " + err;
        console.error("updateWorkItemState failed:", err);
      });
    });
  };
  top.appendChild(stateBtn);

  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = it.name;
  top.appendChild(nameEl);

  const browserBtn = document.createElement("span");
  browserBtn.className = "icon-btn row-browser-btn";
  browserBtn.title = "브라우저에서 열기";
  browserBtn.innerHTML = EXTERNAL_LINK_ICON;
  browserBtn.onclick = (e) => {
    e.stopPropagation();
    openInBrowser(it);
  };
  top.appendChild(browserBtn);
  el.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "task-chips";

  const prioChip = document.createElement("span");
  const noPriority = it.priority === "none";
  prioChip.className = "chip sm" + (noPriority ? " empty" : "");
  prioChip.title = "우선순위 변경";
  if (noPriority) {
    prioChip.innerHTML = `${PLUS_ICON} 우선순위`;
  } else {
    prioChip.style.color = priorityColor(it.priority as any);
    prioChip.innerHTML = `${priorityIcon(it.priority as any)} ${PRIORITY_LABELS[it.priority] ?? it.priority}`;
  }
  prioChip.onclick = (e) => {
    e.stopPropagation();
    openPriorityPopover(prioChip, it, (priority) => {
      const prev = it.priority;
      it.priority = priority;
      renderTasks(allItems, projects);
      updateWorkItemPriority(it.project_id, it.id, priority).catch((err) => {
        it.priority = prev;
        renderTasks(allItems, projects);
        synced.textContent = "우선순위 변경 실패: " + err;
        console.error("updateWorkItemPriority failed:", err);
      });
    });
  };
  chips.appendChild(prioChip);

  if (it.state_group === "completed" && it.completed_at) {
    const doneChip = document.createElement("span");
    doneChip.className = "chip sm info";
    doneChip.innerHTML = `${CALENDAR_ICON} 완료 ${formatLocalTime(it.completed_at)}`;
    chips.appendChild(doneChip);
  } else {
    const range = formatDateRange(it.start_date, it.target_date);
    const dateChip = document.createElement("span");
    dateChip.className = "chip sm" + (range ? "" : " empty");
    dateChip.title = "기간 변경";
    dateChip.innerHTML = range ? `${CALENDAR_ICON} ${range}` : `${PLUS_ICON} 마감일`;
    dateChip.onclick = (e) => {
      e.stopPropagation();
      openSidebarDatePopover(dateChip, it, allItems, projects);
    };
    chips.appendChild(dateChip);
  }
  el.appendChild(chips);

  el.onclick = () => openEditModal(it.project_id, it.id);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(it, e.clientX, e.clientY);
  };

  return el;
}

function renderTasks(items: WorkItem[], projects: Project[]) {
  lastItems = items;
  lastProjects = projects;
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";
  const groups = groupItemsByProject(items, projects);
  groups.forEach(({ project, items: groupItems }, i) => {
    const collapsed = collapsedGroups.has(project.id);

    const grp = document.createElement("div");
    grp.className = "grp" + (collapsed ? " collapsed" : "") + (i > 0 ? " with-divider" : "");

    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▾";
    grp.appendChild(chev);

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(project.id);
    grp.appendChild(dot);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = project.name;
    grp.appendChild(name);

    if (project.identifier) {
      const ident = document.createElement("span");
      ident.className = "ident";
      ident.textContent = project.identifier;
      grp.appendChild(ident);
    }

    const prog = groupProgress(groupItems);
    const progEl = document.createElement("span");
    progEl.className = "prog";
    progEl.innerHTML = progressRingSvg(prog.done, prog.total) + `<span class="txt">${prog.done}/${prog.total}</span>`;
    grp.appendChild(progEl);

    const addBtn = document.createElement("span");
    addBtn.className = "addbtn";
    addBtn.title = "이 프로젝트에 작업 추가";
    addBtn.innerHTML = PLUS_ICON;
    addBtn.onclick = (e) => {
      e.stopPropagation();
      showQuickaddForProject(project.id).catch((err) => {
        synced.textContent = "QuickAdd 열기 실패: " + err;
        console.error("showQuickaddForProject failed:", err);
      });
    };
    grp.appendChild(addBtn);

    grp.onclick = () => {
      if (collapsedGroups.has(project.id)) collapsedGroups.delete(project.id);
      else collapsedGroups.add(project.id);
      renderTasks(items, projects);
    };
    tasksEl.appendChild(grp);

    const body = document.createElement("div");
    body.className = "grp-body" + (collapsed ? " collapsed" : "");
    // Filter rows only — the group header (and its progress ring above) still
    // counts hidden completed items, so "3/3" stays visible when all are done.
    for (const it of filterHiddenCompleted(groupItems, hideCompleted)) {
      body.appendChild(renderTaskRow(it, items, projects));
    }
    tasksEl.appendChild(body);
  });
}

async function getTargetMonitor() {
  const [s, monitors] = await Promise.all([getSettings(), availableMonitors()]);
  if (monitors.length === 0) return null;
  return pickMonitor(sortMonitorsByPosition(monitors), s.display_index) ?? null;
}

async function showSidebar(takeFocus = true): Promise<void> {
  const monitor = await getTargetMonitor();
  if (!monitor) {
    await showWindow(takeFocus);
    return;
  }
  const geo = computeSidebarGeometry(
    monitor.size.width,
    monitor.size.height,
    monitor.scaleFactor,
    PANEL_WIDTH,
    monitor.position.x,
    monitor.position.y,
  );
  await win.setSize(new PhysicalSize(geo.width, geo.height));
  await win.setPosition(new PhysicalPosition(geo.visibleX, geo.y));
  await win.setAlwaysOnTop(true);
  await showWindow(takeFocus);
}

// takeFocus=false는 유휴 자동 열기 전용: 포커스를 가지면 사용자가 자리에
// 없는 동안 어떤 포커스 변화(화면 잠금, 알림, 다른 앱 활성화)든 blur 자동
// 숨김을 발동시켜 사이드바가 저절로 닫힌다. show() 자체가 Windows에서 창을
// 활성화하므로, 표시하는 동안만 focusable을 꺼서 활성화를 막는다.
async function showWindow(takeFocus: boolean): Promise<void> {
  if (takeFocus) {
    await win.show();
    await win.setFocus();
    return;
  }
  // show()가 실패해도 focusable은 반드시 복구 — 아니면 이후 수동 열기의
  // setFocus()가 활성화 불가 창에 막혀 사이드바가 앱 재시작 전까지
  // 포커스를 못 받는다.
  try {
    await win.setFocusable(false);
    await win.show();
  } finally {
    await win.setFocusable(true);
  }
}

async function hideSidebar(): Promise<void> {
  if (!(await win.isVisible())) return;
  await win.hide();
}

// F2 연타(또는 OS 키 반복)로 toggle-sidebar가 겹쳐 들어오면 win.isVisible()의
// IPC 왕복 도중 여러 호출이 같은 옛 가시성 상태를 읽고 같은 동작을 중복
// 실행할 수 있다(TOCTOU) — 프라미스 체인으로 직렬화해 항상 이전 토글이 끝난
// 뒤의 상태를 보게 한다. .catch로 앞선 실패가 뒤 토글까지 막지 않게 한다.
let toggleInFlight: Promise<void> = Promise.resolve();
function toggleSidebar(): Promise<void> {
  toggleInFlight = toggleInFlight.catch(() => {}).then(async () => {
    if (await win.isVisible()) await hideSidebar();
    else await showSidebar();
  });
  return toggleInFlight;
}

function renderInbox(pending: PendingAssignment[]) {
  inboxEl.hidden = pending.length === 0;
  inboxEl.innerHTML = "";
  if (pending.length === 0) return;

  const head = document.createElement("div");
  head.className = "inbox-h";
  head.innerHTML = `<span><span class="inbox-dot"></span>새로 할당됨</span><span>${pending.length}</span>`;
  inboxEl.appendChild(head);

  for (const p of pending) {
    const card = document.createElement("div");
    card.className = "new-task";

    const who = document.createElement("div");
    who.className = "assigner";
    who.innerHTML = `<b></b>님이 할당 <span class="when">${formatRelativeTime(p.detected_at_ms, Date.now())}</span>`;
    who.querySelector("b")!.textContent = p.assigner_name;
    card.appendChild(who);

    const name = document.createElement("div");
    name.className = "nt-name";
    name.textContent = p.name;
    card.appendChild(name);

    const chips = document.createElement("div");
    chips.className = "nt-chips";
    if (p.priority !== "none") {
      const prio = document.createElement("span");
      prio.className = "chip sm";
      prio.style.color = priorityColor(p.priority as any);
      prio.innerHTML = `${priorityIcon(p.priority as any)} ${PRIORITY_LABELS[p.priority] ?? p.priority}`;
      chips.appendChild(prio);
    }
    if (p.target_date) {
      const due = document.createElement("span");
      due.className = "chip sm";
      due.innerHTML = `${CALENDAR_ICON} ~ ${p.target_date}`;
      chips.appendChild(due);
    }
    if (chips.childElementCount > 0) card.appendChild(chips);

    const row = document.createElement("div");
    row.className = "ack-row";
    const ack = document.createElement("button");
    ack.className = "ack-btn";
    ack.textContent = "✓ 확인했습니다";
    ack.onclick = async () => {
      ack.disabled = true;
      try {
        await acknowledgeAssignment(p.project_id, p.item_id);
        // 목록 갱신은 백엔드가 emit하는 assignments-updated가 처리한다.
      } catch (err) {
        ack.disabled = false;
        synced.textContent = "확인 처리 실패: " + err;
        console.error("acknowledgeAssignment failed:", err);
      }
    };
    row.appendChild(ack);
    const open = document.createElement("button");
    open.className = "ack-ghost";
    open.textContent = "열기";
    open.onclick = () => openEditModal(p.project_id, p.item_id);
    row.appendChild(open);
    card.appendChild(row);

    inboxEl.appendChild(card);
  }
}

async function refreshInbox() {
  try {
    renderInbox(await getPendingAssignments());
  } catch (err) {
    console.error("getPendingAssignments failed:", err);
  }
}

// 새로고침 버튼과 백엔드의 refresh-sidebar 이벤트는 refreshIfStale()의
// 쿨다운을 거치지 않고 refresh()를 직접 부른다. 연속 편집/삭제나 버튼 연타로
// 여러 호출이 겹치면 프로젝트당 N+1 요청 묶음이 동시에 나가고, 응답 순서가
// 뒤바뀌면 최신 렌더가 옛 데이터로 되돌아갈 수 있다 — 진행 중인 요청이 있으면
// 새로 fetch하지 않고 완료 후 한 번만 더 돌게 합쳐(coalesce) 항상 순차 실행되게 한다.
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

function refresh(): Promise<void> {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = runRefresh().finally(() => {
    refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  });
  return refreshInFlight;
}

async function runRefresh() {
  lastRefreshAt = Date.now();
  synced.textContent = "동기화 중…";
  try {
    const s = await getSettings();
    baseUrl = s.base_url;
    workspace = s.workspace;
    themePref = s.theme;
    applyTheme(s.theme);
    const today = resolveDatePreset("today");
    const data: SidebarData = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    states = data.states;
    renderTasks(filterVisibleToday(data.assigned), data.projects);
    synced.textContent = offlineStatusText(data.is_cached, data.cached_at_ms, pendingCount, Date.now());
    refreshInbox();
  } catch (e) {
    const msg = typeof e === "string" ? e : ((e as any)?.message ?? JSON.stringify(e));
    synced.textContent = "동기화 실패: " + msg;
    synced.title = msg;
    console.error(e);
  }
}

function refreshIfStale() {
  if (!isWithinCooldown(lastRefreshAt, Date.now(), REFRESH_COOLDOWN_MS)) refresh();
}

document.getElementById("refresh")!.onclick = refresh;

document.getElementById("briefingBtn")!.onclick = () => {
  openBriefing().catch((e) => console.error("openBriefing failed:", e));
};

document.getElementById("openPlane")!.onclick = () => {
  if (!baseUrl) {
    synced.textContent = "설정에서 Base URL을 먼저 입력하세요";
    return;
  }
  openExternal(baseUrl);
};

// Manual update check: the result lands in the footer. When an update exists
// the backend opens its own confirm dialog instead of returning a message.
let updateCheckInFlight = false;
async function runUpdateCheck() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  synced.textContent = "업데이트 확인 중…";
  try {
    const msg = await checkUpdatesManual();
    synced.textContent = msg ?? "새 버전 안내를 확인하세요";
  } catch (err) {
    synced.textContent = "업데이트 확인 실패: " + err;
  } finally {
    updateCheckInFlight = false;
  }
}

// Persists the flipped theme as an explicit preference. Settings are re-read
// first so a toggle before the initial refresh cannot save an empty base_url
// over the stored one.
async function toggleTheme() {
  const next = toggledThemePref(themePref, window.matchMedia("(prefers-color-scheme: light)").matches);
  themePref = next;
  applyTheme(next);
  try {
    const s = await getSettings();
    await saveSettings(s.base_url, s.workspace, undefined, undefined, undefined, next, undefined);
  } catch (err) {
    synced.textContent = "테마 저장 실패: " + err;
  }
}

// Release notes panel: an overlay covering the whole sidebar, fed from this
// app's GitHub releases. Cached for the session — the list only changes when
// a release ships, and unauthenticated GitHub API calls are rate limited.
const notesPanel = document.getElementById("notesPanel")!;
const notesBody = document.getElementById("notesBody")!;
let cachedReleaseNotes: ReleaseNote[] | null = null;

function closeReleaseNotes() {
  notesPanel.hidden = true;
}

function notesStatus(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "notes-status";
  el.textContent = text;
  return el;
}

async function renderReleaseNotes(notes: ReleaseNote[]) {
  notesBody.innerHTML = "";
  if (notes.length === 0) {
    notesBody.appendChild(notesStatus("표시할 릴리즈가 없습니다"));
    return;
  }
  const current = await getVersion();
  for (const n of notes) {
    const item = document.createElement("div");
    item.className = "rn-item";

    const head = document.createElement("div");
    head.className = "rn-head";
    const ver = document.createElement("span");
    ver.className = "rn-ver";
    ver.textContent = "v" + n.version;
    head.appendChild(ver);
    const date = document.createElement("span");
    date.className = "rn-date";
    date.textContent = n.date;
    head.appendChild(date);
    if (n.version === current) {
      const badge = document.createElement("span");
      badge.className = "rn-badge";
      badge.textContent = "현재 버전";
      head.appendChild(badge);
    }
    item.appendChild(head);

    const body = document.createElement("div");
    body.innerHTML = n.notes ? notesToHtml(n.notes) : `<p class="rn-empty">(변경 내역 없음)</p>`;
    item.appendChild(body);

    notesBody.appendChild(item);
  }
}

async function openReleaseNotes() {
  notesPanel.hidden = false;
  if (cachedReleaseNotes) return;
  notesBody.innerHTML = "";
  notesBody.appendChild(notesStatus("릴리즈 노트 불러오는 중…"));
  try {
    const notes = await fetchReleaseNotes();
    cachedReleaseNotes = notes;
    await renderReleaseNotes(notes);
  } catch (err) {
    notesBody.innerHTML = "";
    notesBody.appendChild(notesStatus("릴리즈 노트를 불러오지 못했습니다: " + err));
    const retry = document.createElement("button");
    retry.className = "rn-retry";
    retry.textContent = "다시 시도";
    retry.onclick = () => openReleaseNotes();
    notesBody.appendChild(retry);
    console.error("fetchReleaseNotes failed:", err);
  }
}

document.getElementById("notesClose")!.onclick = closeReleaseNotes;

const MORE_MENU_WIDTH = 170;
const moreBtn = document.getElementById("moreMenu")!;

function openMoreMenu() {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = MORE_MENU_WIDTH + "px";

  appendPopItem(pop, "업데이트 확인", () => runUpdateCheck());
  appendPopItem(pop, "릴리즈 노트", () => openReleaseNotes());
  appendPopItem(pop, "설정", () => openSettings());
  appendPopItem(pop, "다크/라이트 전환", () => toggleTheme());

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  const ver = document.createElement("div");
  ver.className = "pop-version";
  getVersion().then((v) => {
    ver.textContent = `Plane Quick Dock v${v}`;
  });
  pop.appendChild(ver);

  const rect = moreBtn.getBoundingClientRect();
  attachPopover(pop, rect.right - MORE_MENU_WIDTH, rect.bottom + 6);
}

moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (openPopover) {
    closePopover();
    return;
  }
  openMoreMenu();
});
document.addEventListener("click", () => closePopover());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
    } else if (!notesPanel.hidden) {
      closeReleaseNotes();
    } else {
      hideSidebar();
    }
  }
});
win.listen("tauri://focus", refreshIfStale);
win.listen("refresh-sidebar", refresh);
win.listen("assignments-updated", refreshInbox);
win.listen("offline-queue-changed", (e) => {
  pendingCount = (e.payload as { pending: number }).pending;
  synced.textContent = offlineStatusText(false, null, pendingCount, Date.now());
});
win.listen("tauri://blur", () => {
  if (!pinned && !autoOpened) hideSidebar();
});
win.listen("toggle-sidebar", () => {
  toggleSidebar();
});
// 백엔드 유휴 워처(spawn_idle_watcher)가 보내는 열기 전용 이벤트.
// toggle과 달리 이미 열려 있으면 아무것도 하지 않는다 — 폴링이 토글로
// 이어지면 열려 있던 사이드바를 닫아 버릴 수 있어서 이벤트를 분리했다.
win.listen("open-sidebar", async () => {
  if (await win.isVisible()) return;
  autoOpened = true;
  await showSidebar(false);
  // 포커스 없이 열었으니 tauri://focus 기반 갱신이 안 돈다 — 직접 갱신.
  refreshIfStale();
});
// 입력 재개(폴링 5초 이내 감지) — 자동 열림 보호 해제.
win.listen("idle-ended", () => {
  autoOpened = false;
});
// 사이드바를 직접 조작하기 시작하면 idle-ended 폴링을 기다리지 않고 즉시 해제.
document.addEventListener("pointerdown", () => {
  autoOpened = false;
}, true);
getOfflineStatus().then((s) => { pendingCount = s.pending; }).catch(() => {});
refresh();
refreshInbox();
