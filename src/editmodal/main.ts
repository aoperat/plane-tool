import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  deleteWorkItem, getSettings, getWorkItem, listMembers, openIssuePopup,
  setQuickaddLayout, updateWorkItemFields, type UpdateWorkItemFields,
} from "../shared/ipc";
import { buildIssueUrl } from "../sidebar/logic";
import { applyTheme } from "../shared/theme";
import { bindTip } from "../shared/tooltip";
import type { Priority, StateGroup } from "../shared/planeIcons";
import type { WorkItem, WorkItemDetail } from "../shared/types";
import { resolveDateChoice } from "../shared/issueForm/state";
import { mountIssueCard, layoutKindOf } from "../shared/issueForm/card";
import "../shared/app.css";

const win = getCurrentWindow();

function cloneTemplate(id: string): HTMLElement {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
}

const browserBtn = cloneTemplate("emBrowser");
const footer = cloneTemplate("emFooter");
const loadingEl = cloneTemplate("emLoading");

const emDelete = footer.querySelector<HTMLElement>("#emDelete")!;
const emDeleteConfirm = footer.querySelector<HTMLElement>("#emDeleteConfirm")!;
const emDeleteConfirmYes = footer.querySelector<HTMLElement>("#emDeleteConfirmYes")!;
const emDeleteConfirmNo = footer.querySelector<HTMLElement>("#emDeleteConfirmNo")!;
const emSaveConfirm = footer.querySelector<HTMLElement>("#emSaveConfirm")!;
const emSaveConfirmYes = footer.querySelector<HTMLElement>("#emSaveConfirmYes")!;
const emSaveConfirmNo = footer.querySelector<HTMLElement>("#emSaveConfirmNo")!;
const emCancel = footer.querySelector<HTMLElement>("#emCancel")!;
const emSave = footer.querySelector<HTMLButtonElement>("#emSave")!;

let baseUrl = "";
let workspace = "";
let projectId = "";
let itemId = "";
let original: WorkItemDetail | null = null;
let snapshotOriginal: WorkItem | null = null;
let detailFetchPromise: Promise<WorkItemDetail> | null = null;

let loadRequestId = 0;

const card = mountIssueCard({
  root: document.getElementById("cardHost")!,
  title: "할 일 수정",
  titlePlaceholder: "제목",
  draggable: true,
  emptyAssignee: "none",
  headerExtra: [browserBtn],
  footer,
  loadMembers: async () => {
    // 빠른 추가와 같은 계약이다 — 어느 프로젝트에 대한 요청인지 await 전에 붙잡아
    // 두고, 돌아왔을 때 항목이 바뀌었으면 늦게 온 목록은 버린다.
    const id = card.state.selectedId;
    if (!id || card.state.membersLoadedForProject === id) return;
    try {
      const members = await listMembers(id);
      if (card.state.selectedId !== id) return;
      card.state.members = members;
      card.state.membersLoadedForProject = id;
    } catch (err) {
      if (card.state.selectedId !== id) return;
      card.state.members = [];
      console.error("listMembers failed:", err);
    }
  },
  onLayoutChange: (kind) => {
    // 빠른 추가와 같은 설정값을 쓴다 — 한쪽에서 바꾸면 양쪽이 바뀐다.
    setQuickaddLayout(kind).catch((err) => console.error("setQuickaddLayout failed:", err));
  },
  onResize: (width, height) => {
    win.setSize(new LogicalSize(width, height + 4)).catch((err) => {
      console.error("setSize failed:", err);
    });
  },
  onSubmit: () => { save(); },
  onClose: () => {
    // Esc는 떠 있는 확인 팝업부터 걷는다 — 셸은 필드 팝오버까지만 알고, 이 둘은
    // 이 창의 것이라 여기서 순서를 정한다.
    if (!emDeleteConfirm.hidden) {
      emDeleteConfirm.hidden = true;
      resizeWindow();
      return;
    }
    if (!emSaveConfirm.hidden) {
      closeSaveConflict();
      resizeWindow();
      return;
    }
    closeModal();
  },
});

// 로딩 문구는 카드 안, 헤더 바로 아래에 놓는다.
card.element.insertBefore(loadingEl, card.element.children[1]);

const layoutToggle = card.element.querySelector<HTMLElement>("[data-layout-toggle]")!;
bindTip(browserBtn, "브라우저에서 열기", "below");
bindTip(layoutToggle.querySelector('[data-layout="compact"]')!, "컴팩트 — 칩을 눌러 값 바꾸기", "below");
bindTip(layoutToggle.querySelector('[data-layout="expanded"]')!, "한눈에 보기 — 모든 항목 펼쳐 보기", "below");
bindTip(card.element.querySelector("[data-close]")!, "닫기 <kbd>Esc</kbd>", "below");
bindTip(emSave, "저장 <kbd>Ctrl+↵</kbd>", "above");

function resizeWindow() {
  win.setSize(new LogicalSize(card.layoutWidth, card.contentHeight() + 4)).catch((err) => {
    console.error("setSize failed:", err);
  });
}

function setLoading(visible: boolean, message = "불러오는 중…") {
  loadingEl.hidden = !visible;
  loadingEl.textContent = message;
  card.setBodyVisible(!visible);
}

function snapshotToDetail(snapshot: WorkItem): WorkItemDetail {
  return {
    id: snapshot.id, name: snapshot.name, description: "",
    assignee_ids: snapshot.assignee_ids,
    start_date: snapshot.start_date, target_date: snapshot.target_date,
    priority: snapshot.priority, state_group: snapshot.state_group,
    project_id: snapshot.project_id,
  };
}

/** description을 제외한 필드만 폼에 채운다 — description은 호출부에서 별도로 다룬다. */
function applyFields(fields: WorkItem | WorkItemDetail) {
  card.setValues({
    name: fields.name,
    assigneeIds: fields.assignee_ids,
    startDate: fields.start_date,
    targetDate: fields.target_date,
    priority: fields.priority as Priority,
    stateGroup: fields.state_group as StateGroup,
  });
}

async function loadItem(pid: string, iid: string, snapshot?: WorkItem) {
  // Re-assert always-on-top every time an item is loaded, mirroring the
  // sidebar's showSidebar() — openInBrowser() drops it so the browser window can
  // surface above the modal, and nothing else restores it afterward.
  win.setAlwaysOnTop(true).catch((err) => {
    console.error("setAlwaysOnTop failed:", err);
  });
  card.closeOverlays();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
  // closeModal()은 창을 숨기기만 해서 같은 항목을 다시 열 때 원본 데이터가 메모리에
  // 그대로 남아있다 — 재요청 없이 그대로 보여준다.
  if (original && pid === projectId && iid === itemId) {
    card.titleElement.focus();
    resizeWindow();
    return;
  }
  const requestId = ++loadRequestId;
  projectId = pid;
  itemId = iid;
  original = null;
  snapshotOriginal = snapshot ?? null;
  detailFetchPromise = null;
  // 담당자 목록은 프로젝트에 딸린다 — 셸의 state.selectedId가 그 열쇠다.
  card.state.selectedId = pid;
  card.state.members = [];
  card.state.membersLoadedForProject = null;
  card.clearError();
  card.clearTitleError();

  if (snapshot) {
    // 이미 동기화로 받아둔 값이 있다 — 전체 스피너 없이 즉시 편집 가능한 폼을 보여준다.
    setLoading(false);
    applyFields(snapshot);
    card.descriptionValue = "";
    card.setDescriptionVisible(false, false);
    card.setDescriptionEnabled(false);
    resizeWindow();
    card.titleElement.focus();
  } else {
    setLoading(true);
    resizeWindow();
  }

  const fetchPromise = getWorkItem(pid, iid);
  if (snapshot) detailFetchPromise = fetchPromise;

  try {
    const detail = await fetchPromise;
    if (requestId !== loadRequestId) return;
    original = detail;
    if (!snapshot) {
      // 스냅샷이 있었다면 이미 채워둔 폼 값(사용자가 편집 중일 수 있음)은 덮어쓰지
      // 않는다 — description만 이 fetch로 채운다.
      setLoading(false);
      applyFields(detail);
    }
    card.descriptionValue = detail.description;
    card.setDescriptionEnabled(true);
    // Auto-show an existing description — hiding it would read as "deleted".
    card.setDescriptionVisible(detail.description !== "", false);
    resizeWindow();
    if (!snapshot) card.titleElement.focus();
  } catch (err) {
    if (requestId !== loadRequestId) return;
    if (snapshot) {
      // 오프라인 등으로 최신 데이터를 못 가져왔다 — 스냅샷을 기준값으로 확정하고
      // 계속 편집 가능하게 둔다(설명은 빈 값으로 취급).
      original = snapshotToDetail(snapshot);
      card.setDescriptionEnabled(true);
      console.error("getWorkItem background refresh failed:", err);
    } else {
      setLoading(true, "불러오기 실패: " + err);
      console.error("getWorkItem failed:", err);
      resizeWindow();
    }
  }
}

function closeModal() {
  card.closeOverlays();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
  win.hide();
}

async function openInBrowser() {
  if (!projectId || !itemId) return;
  const url = buildIssueUrl(baseUrl, workspace, projectId, itemId);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the modal instead of behind it — same fix as the
    // sidebar's openInBrowser.
    await win.setAlwaysOnTop(false);
    await openIssuePopup(url);
  } catch (err) {
    console.error("openIssuePopup failed:", url, err);
  }
}

function hasConflictWithSnapshot(fetched: WorkItemDetail, snapshot: WorkItem): boolean {
  if (fetched.name !== snapshot.name) return true;
  if ((fetched.start_date ?? "") !== (snapshot.start_date ?? "")) return true;
  if ((fetched.target_date ?? "") !== (snapshot.target_date ?? "")) return true;
  if (fetched.priority !== snapshot.priority) return true;
  if (fetched.state_group !== snapshot.state_group) return true;
  const fetchedAssignees = [...fetched.assignee_ids].sort();
  const snapshotAssignees = [...snapshot.assignee_ids].sort();
  return JSON.stringify(fetchedAssignees) !== JSON.stringify(snapshotAssignees);
}

// Set while a confirmSaveConflict() promise is pending, so a force-close (modal close,
// loadItem for a different item, or Escape) can still resolve it instead of leaking a
// forever-pending save() call — see closeSaveConflict().
let pendingSaveConflictResolve: ((proceed: boolean) => void) | null = null;

function confirmSaveConflict(): Promise<boolean> {
  return new Promise((resolve) => {
    emSaveConfirm.hidden = false;
    resizeWindow();
    pendingSaveConflictResolve = resolve;
    emSaveConfirmYes.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeWindow();
      resolve(true);
    };
    emSaveConfirmNo.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeWindow();
      resolve(false);
    };
  });
}

// Force-closes the save-conflict popup from anywhere other than its own Yes/No
// buttons (closeModal, loadItem, Escape) — treats an abandoned popup as "cancel"
// so any pending confirmSaveConflict() promise still resolves.
function closeSaveConflict() {
  if (pendingSaveConflictResolve) {
    const resolve = pendingSaveConflictResolve;
    pendingSaveConflictResolve = null;
    resolve(false);
  }
  emSaveConfirm.hidden = true;
}

async function save() {
  if (detailFetchPromise && !original) {
    emSave.disabled = true;
    try {
      await detailFetchPromise;
    } catch {
      // 실패 시 loadItem의 catch가 이미 original을 스냅샷 기준으로 채워둔다.
    } finally {
      emSave.disabled = false;
    }
  }
  if (!original) return;

  if (snapshotOriginal && hasConflictWithSnapshot(original, snapshotOriginal)) {
    const proceed = await confirmSaveConflict();
    if (!proceed) return;
  }

  const name = card.titleValue.trim();
  if (!name) {
    card.markTitleError();
    card.titleElement.focus();
    return;
  }
  const description = card.descriptionValue;
  const s = card.state;
  const startDate = resolveDateChoice(s.startChoice, s.startCustomDate);
  const dueDate = resolveDateChoice(s.dueChoice, s.dueCustomDate);

  const fields: UpdateWorkItemFields = {};
  if (name !== original.name) fields.name = name;
  if (description !== original.description) fields.description = description;
  const sortedCurrent = [...s.assigneeIds].sort();
  const sortedOriginal = [...original.assignee_ids].sort();
  if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedOriginal)) fields.assignee_ids = s.assigneeIds;
  if (startDate && startDate !== (original.start_date ?? "")) fields.start_date = startDate;
  if (dueDate && dueDate !== (original.target_date ?? "")) fields.target_date = dueDate;
  if (s.priority !== original.priority) fields.priority = s.priority;
  if (s.stateGroup !== original.state_group) fields.state_group = s.stateGroup;

  if (Object.keys(fields).length === 0) {
    await win.hide();
    return;
  }

  card.clearError();
  try {
    await updateWorkItemFields(projectId, itemId, fields);
    await win.hide();
  } catch (err) {
    card.showError("저장 실패: " + err);
    console.error("updateWorkItemFields failed:", err);
  }
}

emCancel.onclick = closeModal;
emSave.onclick = () => { save(); };
browserBtn.onclick = openInBrowser;

emDelete.onclick = () => {
  emDeleteConfirm.hidden = false;
  resizeWindow();
};
emDeleteConfirmNo.onclick = () => {
  emDeleteConfirm.hidden = true;
  resizeWindow();
};
emDeleteConfirmYes.onclick = async () => {
  try {
    await deleteWorkItem(projectId, itemId);
    await win.hide();
  } catch (err) {
    emDeleteConfirm.hidden = true;
    card.showError("삭제 실패: " + err);
    console.error("deleteWorkItem failed:", err);
  }
};

win.listen<{ projectId: string; itemId: string; snapshot?: WorkItem }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId, event.payload.snapshot);
});

// 설정 창이 저장하면 즉시 반영한다 — 이 창도 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
});

async function loadSettings() {
  const s = await getSettings();
  baseUrl = s.base_url;
  workspace = s.workspace;
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
}

setLoading(true);
resizeWindow();
loadSettings();
