import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon } from "../shared/planeIcons";
import { computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatLocalTime, groupItemsByProject, resolveStateId } from "./logic";
import { applyTheme } from "../shared/theme";
import { resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
import type { SidebarData, Project, WorkItem, ProjectState } from "../shared/types";
import "../shared/app.css";

const PANEL_WIDTH = 320;
const SLIDE_MS = 180;

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
  pop.style.top = "20px";
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

function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task" + (it.state_group === "completed" ? " completed" : "");

  const stateBtn = document.createElement("span");
  stateBtn.className = "icon-btn";
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
  el.appendChild(stateBtn);

  const body = document.createElement("div");
  body.className = "body";

  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = it.name;
  body.appendChild(nameEl);

  const meta = document.createElement("div");
  meta.className = "meta";

  const prioEl = document.createElement("span");
  prioEl.className = "prio";
  prioEl.style.color = priorityColor(it.priority as any);
  prioEl.innerHTML = priorityIcon(it.priority as any);
  const prioLabel = PRIORITY_LABELS[it.priority];
  if (it.priority !== "none" && prioLabel) {
    prioEl.appendChild(document.createTextNode(prioLabel));
  }
  prioEl.onclick = (e) => {
    e.stopPropagation();
    openPriorityPopover(prioEl, it, (priority) => {
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
  meta.appendChild(prioEl);

  if (it.state_group === "completed" && it.completed_at) {
    const doneEl = document.createElement("span");
    doneEl.className = "due";
    doneEl.textContent = "· 완료 " + formatLocalTime(it.completed_at);
    meta.appendChild(doneEl);
  } else if (it.target_date) {
    const dueEl = document.createElement("span");
    dueEl.className = "due";
    dueEl.textContent = "· " + it.target_date;
    meta.appendChild(dueEl);
  }

  body.appendChild(meta);
  el.appendChild(body);

  el.onclick = async () => {
    const url = `${baseUrl}/${workspace}/projects/${it.project_id}/issues/${it.id}`;
    try {
      // Drop always-on-top so the browser window we're about to open can
      // appear above the sidebar instead of behind it.
      await win.setAlwaysOnTop(false);
      await openUrl(url);
    } catch (err) {
      synced.textContent = "열기 실패: " + err;
      console.error("openUrl failed:", url, err);
    }
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

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(groupItems.length);
    grp.appendChild(n);

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

function slideIn(): Promise<void> {
  return queueSlide(async () => {
    const monitor = await currentMonitor();
    if (!monitor) {
      await win.show();
      await win.setFocus();
      return;
    }
    const geo = computeSidebarGeometry(monitor.size.width, monitor.size.height, monitor.scaleFactor, PANEL_WIDTH);
    await win.setSize(new PhysicalSize(geo.width, geo.height));
    await win.setPosition(new PhysicalPosition(geo.hiddenX, 0));
    await win.setAlwaysOnTop(true);
    await win.show();
    await win.setFocus();
    await animatePosition(geo.hiddenX, geo.visibleX, 0, SLIDE_MS);
  });
}

function slideOut(): Promise<void> {
  return queueSlide(async () => {
    if (!(await win.isVisible())) return;
    const monitor = await currentMonitor();
    if (!monitor) {
      await win.hide();
      return;
    }
    const geo = computeSidebarGeometry(monitor.size.width, monitor.size.height, monitor.scaleFactor, PANEL_WIDTH);
    await animatePosition(geo.visibleX, geo.hiddenX, 0, SLIDE_MS);
    await win.hide();
  });
}

async function toggleSidebar() {
  if (await win.isVisible()) await slideOut();
  else await slideIn();
}

async function refresh() {
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

document.getElementById("refresh")!.onclick = refresh;
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
win.listen("tauri://focus", refresh);
win.listen("tauri://blur", () => {
  if (!pinned) slideOut();
});
win.listen("toggle-sidebar", () => {
  toggleSidebar();
});
refresh();
