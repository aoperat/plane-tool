import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { SidebarData, Project, WorkItem } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const projectsEl = document.getElementById("projects")!;
const tasksEl = document.getElementById("tasks")!;
const projCount = document.getElementById("projCount")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
let baseUrl = "";
let workspace = "";

function dotClass(group: string): string {
  if (group === "completed") return "state-done";
  if (group === "started") return "state-prog";
  return "state-todo";
}

function prioLabel(p: string): string {
  return p === "urgent" || p === "high" ? "높음" : p === "medium" ? "보통" : "";
}

function renderProjects(projects: Project[]) {
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
    projectsEl.appendChild(row);
  }
}

function renderTasks(items: WorkItem[]) {
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "task";

    // state dot — static structure, no API data
    const stateDot = document.createElement("span");
    stateDot.className = "state-dot " + dotClass(it.state_group);
    el.appendChild(stateDot);

    // body container
    const body = document.createElement("div");
    body.className = "body";

    // task name — textContent only
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = it.name;
    body.appendChild(nameEl);

    // meta row
    const meta = document.createElement("div");
    meta.className = "meta";

    const prio = prioLabel(it.priority);
    if (prio) {
      const prioEl = document.createElement("span");
      prioEl.className = "prio";
      prioEl.textContent = prio;
      meta.appendChild(prioEl);
    }

    if (it.target_date) {
      const dueEl = document.createElement("span");
      dueEl.className = "due";
      dueEl.textContent = "· " + it.target_date;
      meta.appendChild(dueEl);
    }

    body.appendChild(meta);
    el.appendChild(body);

    // open issue in browser — /issues/ web route
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
    renderProjects(data.projects);
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});
win.listen("tauri://focus", refresh);
refresh();
