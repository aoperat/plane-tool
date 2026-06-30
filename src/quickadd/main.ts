import { getCurrentWindow } from "@tauri-apps/api/window";
import { createIssue, fetchSidebarData, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const titleEl = document.getElementById("title") as HTMLInputElement;
const projBtn = document.getElementById("projBtn")!;
const projName = document.getElementById("projName")!;
const projDot = document.getElementById("projDot")!;
const dropdown = document.getElementById("dropdown")!;

let projects: Project[] = [];
let selectedId: string | null = null;

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
    item.innerHTML = `<span class="dot" style="background:${colorForId(p.id)}"></span>${p.name}`;
    item.onclick = () => { selectedId = p.id; renderSelected(); dropdown.hidden = true; titleEl.focus(); };
    dropdown.appendChild(item);
  }
}

async function load() {
  const [settings, data] = await Promise.all([getSettings(), fetchSidebarData().catch(() => null)]);
  projects = data?.projects ?? [];
  selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  renderSelected();
  renderDropdown();
}

projBtn.onclick = () => { dropdown.hidden = !dropdown.hidden; };

titleEl.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { await win.hide(); }
  if (e.key === "Enter") {
    const name = titleEl.value.trim();
    if (!name || !selectedId) return;
    try {
      await createIssue(selectedId, name);
      titleEl.value = "";
      await win.hide();
    } catch (err) {
      titleEl.classList.add("error");
      console.error(err);
    }
  }
});

win.listen("tauri://focus", () => { titleEl.focus(); load(); });
load();
