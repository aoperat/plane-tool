import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings, setLastProject } from "../shared/ipc";
import type { Project } from "../shared/types";
import { resolveDateShortcut } from "../shared/dateShortcut";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import { createProjectPicker } from "./projectPicker";
import { createFormState, resolveDateChoice, shiftDateField, resetFormFields } from "./state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";
import { mountCompact } from "./layoutCompact";
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
const qaTip = document.getElementById("qaTip")!;

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
    if (!state.selectedId || state.membersLoadedForProject === state.selectedId) return;
    try {
      state.members = await listMembers(state.selectedId);
      state.membersLoadedForProject = state.selectedId;
    } catch (err) {
      state.members = [];
      console.error("listMembers failed:", err);
    }
  },
  focusTitle: () => titleEl.focus(),
};

let layout: LayoutHandle = mountCompact(hosts, ctx);

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
  projects = fetched;
  state.selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  projectPicker.render();
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

// Shortcut tooltip: one body-level pill moved under whichever trigger is hovered/focused.
function bindTip(el: HTMLElement, html: string, placement: "above" | "below") {
  const show = () => {
    qaTip.innerHTML = html;
    qaTip.hidden = false;
    const r = el.getBoundingClientRect();
    const left = Math.max(6, Math.min(r.left + r.width / 2 - qaTip.offsetWidth / 2,
      window.innerWidth - qaTip.offsetWidth - 6));
    qaTip.style.left = `${left}px`;
    // The window is sized to the popup exactly, so the close button (top edge) tips downward.
    qaTip.style.top = placement === "above" ? `${r.top - qaTip.offsetHeight - 6}px` : `${r.bottom + 6}px`;
  };
  const hide = () => { qaTip.hidden = true; };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  el.addEventListener("click", hide);
}
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
layout.render();
resizeToFit(); // 설명이 접혀 있는 첫 화면에서는 autoResizeDescription과 같은 일을 한다
load();
