import { getCurrentWindow } from "@tauri-apps/api/window";
import { listProjects, getSettings, pickProject, closeProjectPicker } from "../shared/ipc";
import { filterProjects } from "../shared/projectSearch";
import { colorForId } from "../shared/color";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import type { Project } from "../shared/types";
import "../shared/app.css";

// 이 창을 한 번 여닫는 동안 빠른 추가 창도 포커스를 잃고 되찾으며 제 목록을 다시
// 읽는다(quickadd/main.ts의 focus 리스너). 같은 rate-limited 서버를 두고 요청이
// 겹치지 않게, 저쪽과 같은 빗장을 건다 — 프로젝트 목록이 몇 초 사이 바뀔 일은 없다.
const LOAD_COOLDOWN_MS = 3000;
let lastLoadAt = 0;

const win = getCurrentWindow();
const input = document.getElementById("ppInput") as HTMLInputElement;
const list = document.getElementById("ppList")!;
const countEl = document.getElementById("ppCount")!;

let projects: Project[] = [];
let hits: Project[] = [];
/** 고른 결과를 돌려줄 창의 label. `picker-open`이 올 때마다 갱신된다. */
let requester = "quickadd";
let selectedId: string | null = null;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** 맞은 구간만 <mark>로 감싼다 — 앞글자가 아니라 이름 어디에 걸렸는지 눈에 보이게. */
function markName(name: string, range: [number, number] | null): string {
  if (!range) return escapeHtml(name);
  const [a, b] = range;
  return escapeHtml(name.slice(0, a)) + "<mark>" + escapeHtml(name.slice(a, b)) + "</mark>" + escapeHtml(name.slice(b));
}

function renderList() {
  const query = input.value;
  const matches = filterProjects(projects, query);
  hits = matches.map((m) => m.project);
  countEl.textContent = query.trim() ? `${hits.length}/${projects.length}` : `${projects.length}개`;

  list.innerHTML = matches.length
    ? matches.map((m) =>
        `<div class="dd-item${m.project.id === selectedId ? " sel" : ""}">` +
        `<span class="dot" style="background:${colorForId(m.project.id)}"></span>` +
        `<span class="nm">${markName(m.project.name, m.range)}</span></div>`).join("")
    : `<div class="dd-empty">일치하는 프로젝트가 없습니다</div>`;

  // 키보드 커서는 현재 선택 위에, 걸러져 사라졌으면 첫 줄에 둔다.
  const items = [...list.querySelectorAll<HTMLElement>(".dd-item")];
  (items.find((el) => el.classList.contains("sel")) ?? items[0])?.classList.add("kbd-focus");
  items.forEach((el, i) => el.addEventListener("click", () => pick(hits[i])));
}

function pick(project: Project | undefined) {
  if (!project) return;
  // 창을 숨기고 결과를 넘기는 일은 Rust가 한 번에 한다 — 저장 순서(설정 저장이
  // 이벤트보다 먼저)가 거기서 지켜져야 요청자의 load()가 값을 되돌리지 않는다.
  pickProject(requester, project.id).catch((err) => console.error("pickProject failed:", err));
}

function move(delta: 1 | -1) {
  const items = [...list.querySelectorAll<HTMLElement>(".dd-item")];
  if (items.length === 0) return;
  const current = items.findIndex((el) => el.classList.contains("kbd-focus"));
  const next = (current + delta + items.length) % items.length;
  items.forEach((el) => el.classList.remove("kbd-focus"));
  items[next].classList.add("kbd-focus");
  items[next].scrollIntoView({ block: "nearest" });
}

function focusedIndex(): number {
  return [...list.querySelectorAll<HTMLElement>(".dd-item")]
    .findIndex((el) => el.classList.contains("kbd-focus"));
}

function dismiss(refocus: boolean) {
  closeProjectPicker(requester, refocus).catch((err) =>
    console.error("closeProjectPicker failed:", err));
}

input.addEventListener("input", renderList);

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    pick(hits[focusedIndex()]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismiss(true); // 요청자 창으로 포커스를 돌려준다
  }
});

/** 프로젝트 목록을 다시 읽는다. 창은 트레이에 살아 있어 다시 열릴 때마다 최신이어야
 *  한다. 테마는 로컬 파일이라 쿨다운과 무관하게 매번 맞춘다. */
async function load() {
  const settings = await getSettings();
  applyTheme(settings.theme);
  if (isWithinCooldown(lastLoadAt, Date.now(), LOAD_COOLDOWN_MS)) return;
  lastLoadAt = Date.now();
  projects = await listProjects().catch(() => []);
  renderList();
}

// 열릴 때마다 요청자와 현재 선택을 새로 받는다. 창은 숨었다 다시 뜨는 것이라
// 지난번 검색어가 남아 있으면 안 된다.
win.listen<{ requester: string; selectedId: string | null }>("picker-open", async (e) => {
  requester = e.payload.requester;
  selectedId = e.payload.selectedId;
  input.value = "";
  renderList(); // 목록을 받아오기 전에도 지난 내용이 남지 않게 먼저 그린다
  await load();
  input.focus();
});

// 다른 창을 클릭하면 물러난다(스포트라이트 관습). 사용자가 이미 그 창을 보고 있으므로
// 포커스는 뺏어오지 않는다.
win.listen("tauri://blur", () => dismiss(false));

// 설정 창이 테마를 바꾸면 이 창도 따라간다 — 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
});

load();
