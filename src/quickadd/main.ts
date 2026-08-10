import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings, setLastProject } from "../shared/ipc";
import type { Project } from "../shared/types";
import { resolveDateShortcut } from "../shared/dateShortcut";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import { bindTip } from "../shared/tooltip";
import { createProjectPicker } from "./projectPicker";
import { createFormState, resolveDateChoice, shiftDateField, resetFormFields } from "./state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";
import { mountCompact } from "./layoutCompact";
import { mountExpanded } from "./layoutExpanded";
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

let projects: Project[] = [];
const state = createFormState();

const popupEl = document.querySelector(".popup") as HTMLElement;

// Measures actual rendered content instead of guessing pixel constants —
// the popup's own box for the idle height, plus the open popover's or project
// dropdown's real bottom edge (which varies with content and can't be hardcoded).
function resizeToFit() {
  let height = Math.ceil(popupEl.getBoundingClientRect().height);
  height = Math.max(height, layout.overlayBottom(), projectPicker.bottom());
  height += 4; // small buffer so a border/shadow pixel never gets clipped
  win.setSize(new LogicalSize(layout.width, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

const projectPicker = createProjectPicker({
  button: projBtn,
  host: popupEl,
  getProjects: () => projects,
  getSelectedId: () => state.selectedId,
  onPick: (p) => {
    state.selectedId = p.id;
    state.members = [];
    state.membersLoadedForProject = null;
    state.assigneeIds = [];
    layout.render();
    titleEl.focus();
    // 즉시 저장 — 안 그러면 포커스로 다시 도는 load()가 last_project_id를
    // 이 창에서 바꾸기 전 값으로 되돌린다.
    setLastProject(p.id).catch((err) => console.error("setLastProject failed:", err));
  },
  onResize: () => resizeToFit(),
  onDismiss: () => titleEl.focus(),
});

const hosts: LayoutHosts = {
  titleTrailing: document.getElementById("titleTrailing")!,
  fields: document.getElementById("fieldsHost")!,
  description: descriptionEl,
};

const ctx: LayoutContext = {
  state,
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
  if (kind === layoutKind) return;
  layout.destroy();
  layoutKind = kind;
  layout = kind === "expanded" ? mountExpanded(hosts, ctx) : mountCompact(hosts, ctx);
  layout.render();
  resizeToFit();
}

function layoutKindOf(setting: string): LayoutKind {
  return setting === "expanded" ? "expanded" : "compact";
}

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
  projectPicker.close(); // a submit can land while the project dropdown is open
  layout.resetView();
  layout.render();
  clearError();
}

async function load() {
  lastLoadAt = Date.now();
  const [settings, fetched] = await Promise.all([getSettings(), listProjects().catch(() => [])]);
  applyTheme(settings.theme);
  applyLayout(layoutKindOf(settings.quickadd_layout));
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
    if (projectPicker.isOpen()) { projectPicker.close(); return; }
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
// while a popover or the project dropdown is open to stay out of their keyboard contracts.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    if (layout.hasOpenOverlay()) layout.closeOverlays();
    projectPicker.close();
    submitIssue();
    return;
  }
  const shortcut = resolveDateShortcut(e.key, e.ctrlKey);
  if (shortcut && !layout.hasOpenOverlay() && !projectPicker.isOpen()) {
    e.preventDefault();
    shiftDateField(state, shortcut.kind, shortcut.delta);
    layout.render();
  }
});

qaSubmit.addEventListener("click", () => { submitIssue(); });
qaClose.addEventListener("click", () => {
  if (layout.hasOpenOverlay()) layout.closeOverlays();
  projectPicker.close();
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
});

// Sidebar's per-project "+" button: pre-select that project. Any in-progress
// draft text survives the switch; only the project-scoped selections (assignees)
// reset. load() (if the focus event triggers it) re-reads last_project_id which
// the command already persisted to the same value.
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
layout.render();
resizeToFit(); // 설명이 접혀 있는 첫 화면에서는 autoResizeDescription과 같은 일을 한다
load();
