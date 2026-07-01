import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon, stateColor } from "../shared/planeIcons";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { SidebarData, Project, WorkItem, ProjectState } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const projectsEl = document.getElementById("projects")!;
const tasksEl = document.getElementById("tasks")!;
const projCount = document.getElementById("projCount")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
let baseUrl = "";
let workspace = "";
let states: ProjectState[] = [];
let openPopover: HTMLElement | null = null;

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

function renderProjects(projects: Project[], counts: Record<string, number>) {
  projCount.textContent = String(projects.length);
  projectsEl.innerHTML = "";
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "proj-row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(p.id);
    row.appendChild(dot);
    row.appendChild(document.createTextNode(p.name));
    const count = counts[p.id] ?? 0;
    const badge = document.createElement("span");
    badge.className = "pcount" + (count === 0 ? " zero" : "");
    badge.textContent = String(count);
    row.appendChild(badge);
    projectsEl.appendChild(row);
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
  pop.style.top = "22px";
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

function renderTasks(items: WorkItem[]) {
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "task";

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
        renderTasks(items);
        updateWorkItemState(it.project_id, it.id, stateId).catch((err) => {
          it.state_group = prev;
          renderTasks(items);
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
        renderTasks(items);
        updateWorkItemPriority(it.project_id, it.id, priority).catch((err) => {
          it.priority = prev;
          renderTasks(items);
          synced.textContent = "우선순위 변경 실패: " + err;
          console.error("updateWorkItemPriority failed:", err);
        });
      });
    };
    meta.appendChild(prioEl);

    if (it.target_date) {
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
        await openUrl(url);
      } catch (err) {
        synced.textContent = "열기 실패: " + err;
        console.error("openUrl failed:", url, err);
      }
    };

    tasksEl.appendChild(el);
  }
}

async function refresh() {
  synced.textContent = "동기화 중…";
  try {
    const s = await getSettings();
    baseUrl = s.base_url;
    workspace = s.workspace;
    const data: SidebarData = await fetchSidebarData();
    states = data.states;
    renderProjects(data.projects, countAssignedByProject(data.assigned));
    renderTasks(data.assigned);
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
      win.hide();
    }
  }
});
win.listen("tauri://focus", refresh);
refresh();
