import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createIssue, deleteWorkItem, fetchSidebarData, getSettings, openEditModal, openSettings, showQuickaddForProject, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon, CALENDAR_ICON, EXTERNAL_LINK_ICON } from "../shared/planeIcons";
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatDateRange, formatLocalTime, groupItemsByProject, groupProgress, resolveStateId } from "./logic";
import { sortMonitorsByPosition, pickMonitor } from "../shared/monitors";
import { isWithinCooldown } from "../shared/cooldown";
import { applyTheme } from "../shared/theme";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
import type { SidebarData, Project, WorkItem, ProjectState } from "../shared/types";
import "../shared/app.css";

const PANEL_WIDTH = 320;
const SLIDE_MS = 180;
// Every window focus (including re-showing the sidebar on toggle) re-fetches the full sidebar
// data set, which itself is an N+1 request per project — a cooldown keeps rapid re-focusing
// (fast toggle spam, alt-tab cycling) from bursting past the Plane server's rate limit.
const REFRESH_COOLDOWN_MS = 3000;

const win = getCurrentWindow();
const tasksEl = document.getElementById("tasks")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
const pinEl = document.getElementById("pin")!;
let baseUrl = "";
let workspace = "";
let states: ProjectState[] = [];
let openPopover: HTMLElement | null = null;
let pinned = false;
let lastRefreshAt = 0;
const collapsedGroups = new Set<string>();

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
  pop.style.top = "26px";
  pop.style.left = "0px";
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
  anchor.appendChild(pop);
  openPopover = pop;
}

function openPriorityPopover(anchor: HTMLElement, item: WorkItem, onPicked: (priority: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.top = "26px";
  pop.style.left = "0px";
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
  anchor.appendChild(pop);
  openPopover = pop;
}

async function openInBrowser(it: WorkItem) {
  const url = buildIssueUrl(baseUrl, workspace, it.project_id, it.id);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the sidebar instead of behind it.
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    synced.textContent = "열기 실패: " + err;
    console.error("openUrl failed:", url, err);
  }
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
 * screen. The context menu and delete-confirm popovers are taller than a
 * single row, so nesting them inside a row (like the state/priority
 * popovers do) let them visually spill into sibling rows below — since
 * those siblings are later in the DOM, they'd win hover/click there instead
 * of the menu. Body-level fixed positioning sidesteps that entirely.
 */
function attachPopover(pop: HTMLElement, x: number, y: number) {
  document.body.appendChild(pop);
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width)) + "px";
  pop.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height)) + "px";
  openPopover = pop;
}

function openContextMenu(it: WorkItem, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";

  const addItem = (label: string, onClick: () => void) => {
    const opt = document.createElement("div");
    opt.className = "pop-item";
    opt.textContent = label;
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onClick();
    };
    pop.appendChild(opt);
  };

  addItem("복사본 만들기", () => duplicateWorkItem(it));
  addItem("새 탭에서 열기", () => openInBrowser(it));
  addItem("링크 복사", () => copyIssueLink(it));

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  addItem("삭제", () => openDeleteConfirm(it, x, y));

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
    for (const it of groupItems) {
      body.appendChild(renderTaskRow(it, items, projects));
    }
    tasksEl.appendChild(body);
  });
}

function animatePosition(fromX: number, toX: number, y: number, durationMs: number): Promise<void> {
  const start = performance.now();
  return new Promise((resolve) => {
    function step(now: number) {
      const t = (now - start) / durationMs;
      const eased = easeOutCubic(t);
      const x = Math.round(fromX + (toX - fromX) * eased);
      win.setPosition(new PhysicalPosition(x, y));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

// Serializes slide-in/slide-out calls so a hide requested mid-slide-in (e.g. a
// blur right after opening) runs after the in-flight animation instead of
// racing it or being dropped.
let slideQueue: Promise<void> = Promise.resolve();
function queueSlide(fn: () => Promise<void>): Promise<void> {
  slideQueue = slideQueue.then(fn, fn);
  return slideQueue;
}

async function getTargetMonitor() {
  const [s, monitors] = await Promise.all([getSettings(), availableMonitors()]);
  if (monitors.length === 0) return null;
  return pickMonitor(sortMonitorsByPosition(monitors), s.display_index) ?? null;
}

function slideIn(): Promise<void> {
  return queueSlide(async () => {
    const monitor = await getTargetMonitor();
    if (!monitor) {
      await win.show();
      await win.setFocus();
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
    await win.setPosition(new PhysicalPosition(geo.hiddenX, geo.y));
    await win.setAlwaysOnTop(true);
    await win.show();
    await win.setFocus();
    await animatePosition(geo.hiddenX, geo.visibleX, geo.y, SLIDE_MS);
  });
}

function slideOut(): Promise<void> {
  return queueSlide(async () => {
    if (!(await win.isVisible())) return;
    const monitor = await getTargetMonitor();
    if (!monitor) {
      await win.hide();
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
    await animatePosition(geo.visibleX, geo.hiddenX, geo.y, SLIDE_MS);
    await win.hide();
  });
}

async function toggleSidebar() {
  if (await win.isVisible()) await slideOut();
  else await slideIn();
}

async function refresh() {
  lastRefreshAt = Date.now();
  synced.textContent = "동기화 중…";
  try {
    const s = await getSettings();
    baseUrl = s.base_url;
    workspace = s.workspace;
    applyTheme(s.theme);
    const today = resolveDatePreset("today");
    const data: SidebarData = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    states = data.states;
    renderTasks(filterVisibleToday(data.assigned), data.projects);
    synced.textContent = "동기화 완료";
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
document.getElementById("openSettings")!.onclick = () => openSettings();
document.addEventListener("click", () => closePopover());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
    } else {
      slideOut();
    }
  }
});
win.listen("tauri://focus", refreshIfStale);
win.listen("refresh-sidebar", refresh);
win.listen("tauri://blur", () => {
  if (!pinned) slideOut();
});
win.listen("toggle-sidebar", () => {
  toggleSidebar();
});
refresh();
