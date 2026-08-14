import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings, setQuickaddLayout } from "../shared/ipc";
import type { Project } from "../shared/types";
import { resolveDateShortcut } from "../shared/dateShortcut";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import { bindTip } from "../shared/tooltip";
import { createProjectPicker } from "./projectPicker";
import { createFormState, resolveDateChoice, shiftDateField, resetFormFields } from "../shared/issueForm/state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "../shared/issueForm/layout";
import { mountCompact } from "../shared/issueForm/layoutCompact";
import { mountExpanded } from "../shared/issueForm/layoutExpanded";
import "../shared/app.css";

// Every window focus reloads the project list from the Plane API; a cooldown keeps rapid
// re-focusing (alt-tab cycling) from adding to the sidebar's own request bursts against the
// same rate-limited server.
const LOAD_COOLDOWN_MS = 3000;
let lastLoadAt = 0;

const win = getCurrentWindow();
const titleEl = document.getElementById("title") as HTMLInputElement;
const projBtn = document.getElementById("projBtn")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
const errorEl = document.getElementById("qaError")!;
const qaClose = document.getElementById("qaClose")!;
const qaSubmit = document.getElementById("qaSubmit")!;
const layoutToggle = document.getElementById("qaLayoutToggle")!;
const coachEl = document.getElementById("qaCoach")!;
const coachOk = document.getElementById("qaCoachOk")!;

let projects: Project[] = [];
const state = createFormState();

const popupEl = document.querySelector(".popup") as HTMLElement;

// Measures actual rendered content instead of guessing pixel constants —
// the popup's own box for the idle height, plus the open popover's real bottom
// edge (which varies with content and can't be hardcoded). The project list is
// no longer part of this — it lives in its own window (see projectPicker.ts).
function resizeToFit() {
  let height = Math.ceil(popupEl.getBoundingClientRect().height);
  height = Math.max(height, layout.overlayBottom(), coachBottom());
  height += 4; // small buffer so a border/shadow pixel never gets clipped
  win.setSize(new LogicalSize(layout.width, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

// 누르면 프로젝트 검색 창이 열린다. 고른 결과는 아래 `select-project` 리스너로 온다.
const projectPicker = createProjectPicker({
  button: projBtn,
  getProjects: () => projects,
  getSelectedId: () => state.selectedId,
});

const hosts: LayoutHosts = {
  titleTrailing: document.getElementById("titleTrailing")!,
  fields: document.getElementById("fieldsHost")!,
  description: descriptionEl,
};

const ctx: LayoutContext = {
  state,
  emptyAssignee: "me",
  onResize: () => resizeToFit(),
  loadMembers: async () => {
    // 어느 프로젝트에 대한 요청인지 await 전에 붙잡아 둔다. 응답이 오는 사이 사용자가
    // 프로젝트를 바꿨다면 늦게 온 목록은 버린다 — 그대로 넣으면 A의 담당자가 B의
    // 목록으로 둔갑하고, membersLoadedForProject까지 B로 찍혀 되돌릴 길이 없어진다.
    const id = state.selectedId;
    if (!id || state.membersLoadedForProject === id) return;
    try {
      const members = await listMembers(id);
      if (state.selectedId !== id) return;
      state.members = members;
      state.membersLoadedForProject = id;
    } catch (err) {
      if (state.selectedId !== id) return;
      state.members = [];
      console.error("listMembers failed:", err);
    }
  },
  focusTitle: () => titleEl.focus(),
};

type LayoutKind = "compact" | "expanded";
let layoutKind: LayoutKind = "compact";
let layout: LayoutHandle = mountCompact(hosts, ctx);

/** 설정이 가리키는 레이아웃으로 갈아끼운다. 폼 상태는 state.ts에 있고 제목·설명은
 *  index.html의 입력칸에 있으므로, 작성 중이던 초안은 그대로 살아남는다. */
function applyLayout(kind: LayoutKind) {
  renderLayoutToggle(kind); // 갈아끼우지 않는 경우에도 토글 표시는 맞춰둔다
  if (kind === layoutKind) return;
  layout.destroy();
  layoutKind = kind;
  layout = kind === "expanded" ? mountExpanded(hosts, ctx) : mountCompact(hosts, ctx);
  layout.render();
  // 레이아웃이 바뀌면 창 폭이 540↔660으로 달라져 토글도 옮겨간다 — 안내가 떠 있으면
  // 화살표가 엉뚱한 곳을 가리키지 않게 다시 맞춘다.
  if (!coachEl.hidden) positionCoach();
  resizeToFit();
}

function layoutKindOf(setting: string): LayoutKind {
  return setting === "expanded" ? "expanded" : "compact";
}

function renderLayoutToggle(kind: LayoutKind) {
  layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
    const on = btn.dataset.layout === kind;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = layoutKindOf(btn.dataset.layout ?? "");
    dismissCoach(true); // 토글을 직접 만졌으면 안내는 제 역할을 다한 것이다
    if (kind === layoutKind) return;
    applyLayout(kind);
    // 설정 화면의 "빠른 추가 화면"과 같은 값이다 — 저장해 두지 않으면 다음에 열 때
    // 설정값으로 되돌아간다.
    setQuickaddLayout(kind).catch((err) => console.error("setQuickaddLayout failed:", err));
    titleEl.focus();
  });
});
// 아이콘만으로는 무엇인지 모르므로 버튼마다 이름을 붙인다.
bindTip(layoutToggle.querySelector('[data-layout="compact"]')!, "컴팩트 — 칩을 눌러 값 바꾸기", "below");
bindTip(layoutToggle.querySelector('[data-layout="expanded"]')!, "한눈에 보기 — 모든 항목 펼쳐 보기", "below");

/* ---- 업데이트 후 첫 안내 ----
   헤더 토글이 새로 생겼다는 것을 알린다. 앱 실행당 최대 한 번, 통틀어 2번까지만 뜬다 —
   무시하고 지나간 사람에게 한 번 더 기회를 주되 계속 따라다니지는 않는다.
   본 횟수는 화면 취향이라 백엔드 설정이 아니라 이 창의 localStorage에 둔다
   (사이드바가 접힘 상태를 두는 방식과 같다). */
const COACH_KEY = "qa-layout-coach-shown";
const COACH_MAX = 2;
// 창은 트레이에 살아 있어 포커스가 여러 번 오간다 — 실행당 한 번만 세게 하는 빗장.
let coachShownThisRun = false;

function coachSeenCount(): number {
  return Number(localStorage.getItem(COACH_KEY)) || 0;
}

/** `done`이면 다시 뜨지 않게 잠근다(알겠어요·토글 조작). 창을 닫을 때처럼 그냥
 *  치우는 경우에는 false — 남은 횟수를 까먹지 않는다. */
function dismissCoach(done: boolean) {
  if (done) localStorage.setItem(COACH_KEY, String(COACH_MAX));
  if (coachEl.hidden) return;
  coachEl.hidden = true;
  layoutToggle.classList.remove("spotlight");
  resizeToFit();
}

function maybeShowCoach() {
  if (coachShownThisRun || coachSeenCount() >= COACH_MAX) return;
  coachShownThisRun = true;
  localStorage.setItem(COACH_KEY, String(coachSeenCount() + 1));
  coachEl.hidden = false;
  layoutToggle.classList.add("spotlight");
  positionCoach();
  resizeToFit();
}

/** 화살표가 토글 한가운데를 가리키게 맞춘다. 팝업 폭이 레이아웃에 따라 달라지므로
 *  띄울 때마다 다시 잰다. 좌우로는 팝업 안에 머물게 물린다. */
function positionCoach() {
  const t = layoutToggle.getBoundingClientRect();
  const p = popupEl.getBoundingClientRect();
  const centre = t.left - p.left + t.width / 2;
  const left = Math.max(8, Math.min(centre - coachEl.offsetWidth / 2, p.width - coachEl.offsetWidth - 8));
  coachEl.style.left = `${left}px`;
  coachEl.style.top = `${t.bottom - p.top + 10}px`;
  coachEl.style.setProperty("--arrow", `${centre - left - 6}px`);
}

function coachBottom(): number {
  return coachEl.hidden ? 0 : Math.ceil(coachEl.getBoundingClientRect().bottom);
}

coachOk.addEventListener("click", () => {
  dismissCoach(true);
  titleEl.focus();
});

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  resizeToFit();
}

function clearError() {
  if (errorEl.hidden) return;
  errorEl.hidden = true;
  errorEl.textContent = "";
  resizeToFit();
}

// Ctrl+Enter and the submit button can fire while a create request is still in flight;
// without this guard each extra press files the same issue again.
let submitting = false;

async function submitIssue() {
  if (submitting) return;
  const name = titleEl.value.trim();
  if (!name) {
    titleEl.classList.add("error");
    showError("제목을 입력하세요");
    return;
  }
  if (!state.selectedId) {
    showError("프로젝트를 선택하세요");
    return;
  }
  submitting = true;
  try {
    await createIssue(
      state.selectedId,
      name,
      state.assigneeIds,
      resolveDateChoice(state.startChoice, state.startCustomDate),
      resolveDateChoice(state.dueChoice, state.dueCustomDate),
      state.priority,
      state.stateGroup,
      descriptionEl.value,
    );
    titleEl.value = "";
    resetFields();
    await win.hide();
  } catch (err) {
    titleEl.classList.add("error");
    showError("등록 실패: " + err);
    console.error(err);
  } finally {
    submitting = false;
  }
}

function resetFields() {
  resetFormFields(state);
  hosts.description.value = "";
  dismissCoach(false); // 등록하고 창이 숨으므로 안내도 함께 치운다
  layout.resetView();
  layout.render();
  clearError();
}

async function load() {
  lastLoadAt = Date.now();
  // 설정은 로컬 파일이라 바로 온다. 프로젝트 목록(Plane API)과 한데 묶어 기다리면
  // 네트워크가 느릴 때 큰 창으로 쓰던 사용자에게 작은 창이 먼저 뜨고 뒤늦게 넓어진다
  // — 모양은 기다릴 이유가 없으므로 먼저 적용한다.
  const settings = await getSettings();
  applyTheme(settings.theme);
  applyLayout(layoutKindOf(settings.quickadd_layout));

  const fetched = await listProjects().catch(() => []);
  projects = fetched;
  state.selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  projectPicker.render();
  // 프로젝트가 방금 정해졌다 — 한눈에 보기의 담당자 행은 이 값에 딸려 있으므로
  // 여기서 한 번 더 그려야 목록을 받아온다.
  layout.render();
}

/** Flashes the submit button — plain Enter no longer submits, so this teaches Ctrl+Enter. */
function pulseSubmit() {
  qaSubmit.classList.remove("pulse");
  void (qaSubmit as HTMLElement).offsetWidth; // restart the animation on rapid presses
  qaSubmit.classList.add("pulse");
}

titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key !== "Enter") clearError();
  if (e.key === "Escape") {
    if (layout.hasOpenOverlay()) { layout.closeOverlays(); return; }
    dismissCoach(false);
    await win.hide();
    return;
  }
  if (e.key === "Enter" && !e.ctrlKey) {
    e.preventDefault();
    pulseSubmit();
  }
});

// The submit key is Ctrl+Enter everywhere — regardless of focus or open popovers — so
// adding an issue never depends on where the cursor is. Plain Enter keeps each control's
// native role (popover select, button press, textarea newline). The date shortcuts pause
// while a popover is open to stay out of its keyboard contract. The project picker needs
// no guard here: it is a separate window, so this one never sees its keystrokes.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    if (layout.hasOpenOverlay()) layout.closeOverlays();
    submitIssue();
    return;
  }
  const shortcut = resolveDateShortcut(e.key, e.ctrlKey);
  if (shortcut && !layout.hasOpenOverlay()) {
    e.preventDefault();
    shiftDateField(state, shortcut.kind, shortcut.delta);
    layout.render();
  }
});

qaSubmit.addEventListener("click", () => { submitIssue(); });
qaClose.addEventListener("click", () => {
  if (layout.hasOpenOverlay()) layout.closeOverlays();
  dismissCoach(false);
  win.hide();
});

bindTip(qaClose, "닫기 <kbd>Esc</kbd>", "below");

// Focus fires both when the window is summoned and when the user merely clicks
// back into the still-open window, so it must never touch the draft — a draft
// is cleared only by a successful submit (see submitIssue). Focus just parks
// the cursor and refreshes the project list (cooldown-gated).
win.listen("tauri://focus", () => {
  titleEl.focus();
  if (!isWithinCooldown(lastLoadAt, Date.now(), LOAD_COOLDOWN_MS)) load();
  // 안내는 여기서만 띄운다 — 부팅 때 도는 load()는 창이 아직 숨어 있어서, 거기서
  // 띄우면 사용자가 못 본 채 남은 횟수만 깎인다.
  maybeShowCoach();
});

// 프로젝트가 이 창 밖에서 정해지는 두 경로가 같은 이벤트로 들어온다 — 사이드바의
// 프로젝트별 "+" 버튼(show_quickadd_for_project)과 프로젝트 검색 창(pick_project).
// 작성 중이던 초안은 그대로 살아남고, 프로젝트에 딸린 선택(담당자)만 리셋한다.
// 포커스 이벤트가 load()를 돌리더라도 last_project_id를 다시 읽을 뿐이다 — 두 명령
// 모두 이벤트를 보내기 전에 같은 값으로 저장해 둔다.
win.listen<string>("select-project", (e) => {
  state.selectedId = e.payload;
  state.members = [];
  state.membersLoadedForProject = null;
  state.assigneeIds = [];
  projectPicker.render();
  layout.render();
});

// 설정 창이 저장하면 즉시 반영한다 — 이 창은 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  applyLayout(layoutKindOf(s.quickadd_layout));
});
renderLayoutToggle(layoutKind); // load()가 설정을 읽어오기 전에도 켜진 쪽은 표시해 둔다
layout.render();
resizeToFit(); // 설명이 접혀 있는 첫 화면에서는 autoResizeDescription과 같은 일을 한다
load();
