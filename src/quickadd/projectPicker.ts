import { filterProjects } from "../shared/projectSearch";
import { colorForId } from "../shared/color";
import type { Project } from "../shared/types";

const SEARCH_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

export interface ProjectPickerHandle {
  /** 버튼 라벨을 현재 선택으로 다시 그린다. */
  render(): void;
  /** 열려 있으면 닫는다. */
  close(): void;
  isOpen(): boolean;
  /** 드롭다운의 아래 끝(px). 닫혀 있으면 0 — 창 높이 계산에 쓴다. */
  bottom(): number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** 맞은 구간만 <mark>로 감싼다 — 앞글자가 아니라 이름 어디에 걸렸는지 눈에 보이게. */
function markName(name: string, range: [number, number] | null): string {
  if (!range) return escapeHtml(name);
  const [a, b] = range;
  return escapeHtml(name.slice(0, a)) + "<mark>" + escapeHtml(name.slice(a, b)) + "</mark>" + escapeHtml(name.slice(b));
}

export function createProjectPicker(opts: {
  button: HTMLElement;
  /** 드롭다운을 붙일 컨테이너. `position: relative`인 팝업 카드를 넘긴다. */
  host: HTMLElement;
  getProjects: () => Project[];
  getSelectedId: () => string | null;
  onPick: (project: Project) => void;
  /** 드롭다운이 열리고 닫힐 때마다 창 높이를 다시 재게 한다. */
  onResize: () => void;
  /** Esc로 닫을 때 포커스를 돌려받을 곳 — 목록 안(input)에 있던 포커스가
   *  버튼으로 가면 다시 Esc를 눌러도 닫을 게 없고, 곧바로 타이핑해도 갈 곳이
   *  없다. 피커는 titleEl을 몰라야 하므로 호출부가 이 콜백으로 넘긴다. */
  onDismiss: () => void;
}): ProjectPickerHandle {
  const { button, host, getProjects, getSelectedId, onPick, onResize, onDismiss } = opts;

  const dd = document.createElement("div");
  dd.className = "dropdown";
  dd.hidden = true;
  dd.innerHTML =
    `<div class="dd-search"><span class="sicon">${SEARCH_ICON}</span>` +
    `<input placeholder="프로젝트 검색…" /><span class="cnt"></span></div>` +
    `<div class="dd-list"></div>` +
    `<div class="dd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 이동</span>` +
    `<span><kbd>↵</kbd> 선택</span><span><kbd>Esc</kbd> 닫기</span></div>`;
  host.appendChild(dd);

  const input = dd.querySelector("input") as HTMLInputElement;
  const list = dd.querySelector(".dd-list") as HTMLElement;
  const cnt = dd.querySelector(".cnt") as HTMLElement;
  let hits: Project[] = [];

  function renderList() {
    const query = input.value;
    const matches = filterProjects(getProjects(), query);
    hits = matches.map((m) => m.project);
    const total = getProjects().length;
    cnt.textContent = query.trim() ? `${hits.length}/${total}` : `${total}개`;

    const selectedId = getSelectedId();
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
    onPick(project);
    render();
    close();
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

  function open() {
    dd.hidden = false;
    input.value = ""; // 열 때마다 검색어는 비운다
    renderList();
    input.focus();
    onResize();
  }

  function close() {
    if (dd.hidden) return;
    dd.hidden = true;
    onResize();
  }

  function render() {
    const p = getProjects().find((x) => x.id === getSelectedId());
    const name = button.querySelector("[data-proj-name]") as HTMLElement;
    const dot = button.querySelector(".dot") as HTMLElement;
    name.textContent = p ? p.name : "프로젝트 선택";
    dot.style.background = p ? colorForId(p.id) : "transparent";
  }

  button.addEventListener("click", () => { dd.hidden ? open() : close(); });
  input.addEventListener("input", renderList);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      // Ctrl+Enter는 제출이므로 여기서 가로채지 않는다(document 핸들러로 넘긴다).
      if (e.ctrlKey) return;
      e.preventDefault();
      pick(hits[focusedIndex()]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      // close()는 dd를 hidden 처리한다 — input이 그 안에 있어 포커스가 그대로면
      // 브라우저가 document.body로 떨어뜨려 이후 키 입력이 아무 데도 안 먹는다.
      // 버튼이 아니라 제목으로 돌려보낸다 — 이 앱의 주 경로(F1 → 입력 →
      // Ctrl+Enter)가 곧바로 타이핑을 이어가고, 버튼에 남으면 Esc를 한 번 더
      // 눌러도 닫을 팝오버가 없어 창이 닫히지 않는다.
      onDismiss();
    }
  });

  return {
    render,
    close,
    isOpen: () => !dd.hidden,
    bottom: () => (dd.hidden ? 0 : Math.ceil(dd.getBoundingClientRect().bottom)),
  };
}
