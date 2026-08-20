import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  createIssue,
  listProjects,
  listMembers,
  getSettings,
  setQuickaddLayout,
  suggestBreakdown,
  createIssueTree,
} from "../shared/ipc";
import type { Project } from "../shared/types";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import { bindTip } from "../shared/tooltip";
import { createProjectPicker } from "./projectPicker";
import { openBreakdownSheet, type SheetHandle } from "./breakdownSheet";
import { defaultAiModes, toggleAiMode, stripProjectName } from "./aiModes";
import { resolveSubmitRoute, activeChildren } from "./submitRoute";
import type { PendingTree, PendingChildren } from "./submitRoute";
import { resolveDateChoice, resetFormFields } from "../shared/issueForm/state";
import { mountIssueCard, layoutKindOf } from "../shared/issueForm/card";
import "../shared/app.css";

// Every window focus reloads the project list from the Plane API; a cooldown keeps rapid
// re-focusing (alt-tab cycling) from adding to the sidebar's own request bursts against the
// same rate-limited server.
const LOAD_COOLDOWN_MS = 3000;
let lastLoadAt = 0;

const win = getCurrentWindow();

function cloneTemplate(id: string): HTMLElement {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
}

const footer = cloneTemplate("qaFooter");
const coachEl = cloneTemplate("qaCoach");
const projBtn = footer.querySelector<HTMLElement>("#projBtn")!;
const qaSubmit = footer.querySelector<HTMLElement>("#qaSubmit")!;
const aiBtn = footer.querySelector<HTMLButtonElement>("#qaAiBtn")!;
const aiModeBtn = footer.querySelector<HTMLButtonElement>("#qaAiMode")!;
const aiMenu = footer.querySelector<HTMLElement>("#qaAiMenu")!;
const aiRefineBox = footer.querySelector<HTMLInputElement>("#qaAiRefine")!;
const aiStripBox = footer.querySelector<HTMLInputElement>("#qaAiStrip")!;
const aiSplitBox = footer.querySelector<HTMLInputElement>("#qaAiSplit")!;
const aiClearBtn = footer.querySelector<HTMLButtonElement>("#qaAiClear")!;
const coachOk = coachEl.querySelector<HTMLElement>("#qaCoachOk")!;

let projects: Project[] = [];

// AI가 제안한 하위 작업. 적용하면 채워지고, 등록하거나 폼을 비우면 사라진다.
// 어느 제목에 붙은 것인지 함께 들고 있어서, 제목이 달라지면 딸려가지 않는다 —
// 판정은 submitRoute.ts의 activeChildren이 한다.
let pendingChildren: PendingChildren | null = null;
// 트리를 만들다 하위 일부가 실패했을 때만 채워진다. 재시도가 상위를 또 만들지
// 않도록 붙잡아 두는 기록이다 — 판정은 submitRoute.ts가 한다.
let pendingTree: PendingTree | null = null;
// 열려 있는 AI 제안 시트. 폼을 비울 때 함께 치우지 않으면 창을 다시 열었을 때
// 지난 제안이 떠 있는 채로 남는다.
let sheetHandle: SheetHandle | null = null;

const card = mountIssueCard({
  root: document.getElementById("cardHost")!,
  title: "빠른 추가",
  titlePlaceholder: "진행 중인 작업을 입력하고 Ctrl+Enter…",
  draggable: true,
  emptyAssignee: "me",
  // 한눈에 보기는 모든 항목을 펼쳐 보는 모양이다 — 설명만 접어둘 이유가 없다.
  expandedDescriptionOpen: true,
  footer,
  loadMembers: async () => {
    // 어느 프로젝트에 대한 요청인지 await 전에 붙잡아 둔다. 응답이 오는 사이 사용자가
    // 프로젝트를 바꿨다면 늦게 온 목록은 버린다 — 그대로 넣으면 A의 담당자가 B의
    // 목록으로 둔갑하고, membersLoadedForProject까지 B로 찍혀 되돌릴 길이 없어진다.
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
    dismissCoach(true); // 토글을 직접 만졌으면 안내는 제 역할을 다한 것이다
    // 설정 화면의 "빠른 추가 화면"과 같은 값이다 — 저장해 두지 않으면 다음에 열 때
    // 설정값으로 되돌아간다.
    setQuickaddLayout(kind).catch((err) => console.error("setQuickaddLayout failed:", err));
  },
  onResize: (width, height) => {
    const h = Math.max(height, coachBottom()) + 4; // 테두리 한 픽셀이 잘리지 않게 여유
    win.setSize(new LogicalSize(width, h)).catch((err) => {
      console.error("setSize failed:", err);
    });
  },
  onSubmit: () => { submitIssue(); },
  onClose: () => {
    dismissCoach(false);
    // 시트를 열어 둔 채 창을 닫으면 다음에 열 때 지난 제안이 남아 있다.
    sheetHandle?.close();
    sheetHandle = null;
    win.hide();
  },
});

// 코치마크는 카드 기준으로 배치된다 — 카드가 위치 기준 조상이어야 한다.
card.element.appendChild(coachEl);
const layoutToggle = card.element.querySelector<HTMLElement>("[data-layout-toggle]")!;

// 누르면 프로젝트 검색 창이 열린다. 고른 결과는 아래 `select-project` 리스너로 온다.
const projectPicker = createProjectPicker({
  button: projBtn,
  getProjects: () => projects,
  getSelectedId: () => card.state.selectedId,
});

// 아이콘만으로는 무엇인지 모르므로 버튼마다 이름을 붙인다.
bindTip(layoutToggle.querySelector('[data-layout="compact"]')!, "컴팩트 — 칩을 눌러 값 바꾸기", "below");
bindTip(layoutToggle.querySelector('[data-layout="expanded"]')!, "한눈에 보기 — 모든 항목 펼쳐 보기", "below");
bindTip(card.element.querySelector("[data-close]")!, "닫기 <kbd>Esc</kbd>", "below");

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
  resizeWindow();
}

function maybeShowCoach() {
  if (coachShownThisRun || coachSeenCount() >= COACH_MAX) return;
  coachShownThisRun = true;
  localStorage.setItem(COACH_KEY, String(coachSeenCount() + 1));
  coachEl.hidden = false;
  layoutToggle.classList.add("spotlight");
  positionCoach();
  resizeWindow();
}

/** 화살표가 토글 한가운데를 가리키게 맞춘다. 카드 폭이 레이아웃에 따라 달라지므로
 *  띄울 때마다 다시 잰다. 좌우로는 카드 안에 머물게 물린다. */
function positionCoach() {
  const t = layoutToggle.getBoundingClientRect();
  const p = card.element.getBoundingClientRect();
  const centre = t.left - p.left + t.width / 2;
  const left = Math.max(8, Math.min(centre - coachEl.offsetWidth / 2, p.width - coachEl.offsetWidth - 8));
  coachEl.style.left = `${left}px`;
  coachEl.style.top = `${t.bottom - p.top + 10}px`;
  coachEl.style.setProperty("--arrow", `${centre - left - 6}px`);
}

function coachBottom(): number {
  return coachEl.hidden ? 0 : Math.ceil(coachEl.getBoundingClientRect().bottom);
}

/** 코치마크처럼 카드 밖 요소만 바뀐 경우에도 창 크기를 다시 잡는다. */
function resizeWindow() {
  const h = Math.max(card.contentHeight(), coachBottom()) + 4;
  win.setSize(new LogicalSize(card.layoutWidth, h)).catch((err) => {
    console.error("setSize failed:", err);
  });
}

coachOk.addEventListener("click", () => {
  dismissCoach(true);
  card.titleElement.focus();
});

/* ---- AI 작업 분해 ----
   제목을 다듬고 하위 작업을 제안받는다. 적용은 폼에 반영만 하고 등록하지 않는다 —
   확정은 언제나 Ctrl+Enter다. */

// 무엇을 고칠지. ▾ 메뉴에서 고르고 창이 살아 있는 동안 기억한다.
let aiModes = defaultAiModes();

function renderAiMenu() {
  aiRefineBox.checked = aiModes.refine;
  aiSplitBox.checked = aiModes.split;
  aiStripBox.checked = aiModes.stripProject;
  // 프로젝트명 제거는 제목 편집이다 — 다듬기를 끄면 같이 잠근다(선택은 기억).
  aiStripBox.disabled = !aiModes.refine;
  // 일부만 켜 둔 상태는 버튼만 보고는 알 수 없다 — 캐럿에 표시를 남긴다.
  aiModeBtn.classList.toggle("narrowed", !(aiModes.refine && aiModes.split));
}
aiRefineBox.onchange = () => {
  aiModes = toggleAiMode(aiModes, "refine");
  renderAiMenu(); // 거부된 토글(마지막 하나 끄기)은 여기서 체크박스가 되돌아간다
};
aiSplitBox.onchange = () => {
  aiModes = toggleAiMode(aiModes, "split");
  renderAiMenu();
};
aiStripBox.onchange = () => {
  aiModes = toggleAiMode(aiModes, "stripProject");
  renderAiMenu();
};
aiModeBtn.onclick = () => {
  aiMenu.hidden = !aiMenu.hidden;
};
bindTip(aiModeBtn, "AI 제안 유형 선택", "above");
renderAiMenu();
// 메뉴 밖을 누르면 닫는다. 캐럿 자체는 onclick이 토글하므로 여기서 제외한다.
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node;
  if (!aiMenu.hidden && !aiMenu.contains(t) && !aiModeBtn.contains(t)) aiMenu.hidden = true;
});
// Esc는 창 닫기(card)까지 번진다 — 메뉴가 열려 있으면 메뉴만 닫고 멈춘다.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && !aiMenu.hidden) {
      e.stopPropagation();
      aiMenu.hidden = true;
    }
  },
  true,
);

/** 시트의 최종 상태를 폼에 반영한다 — 새 제안이든 적용본 검토든 같다.
 *  하위를 전부 꺼 두고 적용하면 붙어 있던 하위가 걷힌다 — 시트에서
 *  빠져나오는 길이다(breakdownSheet.hasAnythingToApply 참고). */
function applySheetResult(newTitle: string, children: string[]) {
  card.titleValue = newTitle;
  pendingChildren =
    children.length > 0 ? { formTitle: card.titleValue.trim(), titles: children } : null;
  renderPendingBadge();
}

async function requestSuggestion() {
  const title = card.titleValue.trim();
  if (!title) {
    card.markTitleError();
    card.showError("제목을 입력하세요");
    return;
  }
  aiMenu.hidden = true;
  aiBtn.disabled = true;
  aiBtn.textContent = "✨ 생각 중…";
  try {
    // 프로젝트명은 겹침 제거를 켰을 때만 함께 보낸다 — 그때만 이름이 외부로 나간다.
    const projectName = stripProjectName(aiModes)
      ? projects.find((p) => p.id === card.state.selectedId)?.name
      : undefined;
    const suggestion = await suggestBreakdown(
      title,
      card.descriptionValue,
      aiModes.refine,
      aiModes.split,
      projectName,
    );
    sheetHandle = openBreakdownSheet({
      host: card.element,
      suggestion,
      originalTitle: title,
      onApply: applySheetResult,
    });
  } catch (err) {
    const msg = String(err);
    card.showError(msg === "no_key" ? "설정에서 OpenAI 키를 먼저 등록하세요" : "AI 제안 실패: " + msg);
  } finally {
    aiBtn.disabled = false;
    renderPendingBadge();
  }
}

aiBtn.onclick = () => {
  const title = card.titleValue.trim();
  const active = activeChildren(pendingChildren, title);
  // 하위가 붙어 있으면(버튼이 "✨ 하위 N"일 때) 이 버튼은 현재 상태를 여는
  // 문이다 — 뭐가 붙었는지 보이지 않은 채 AI가 또 도는 것을 막는다.
  // AI를 다시 부르는 길은 시트 안의 [✨ 다시 제안]이다.
  if (active.length > 0) {
    sheetHandle = openBreakdownSheet({
      host: card.element,
      suggestion: { title, title_changed: false, children: active, reason: "" },
      originalTitle: title,
      heading: "적용된 하위 작업",
      onRefresh: () => {
        requestSuggestion();
      },
      onApply: applySheetResult,
    });
    return;
  }
  requestSuggestion();
};

/** 적용된 하위 작업이 몇 개인지 버튼에 남긴다 — 시트를 닫은 뒤에도 "쪼개진
 *  상태로 등록된다"는 것이 보여야 한다.
 *
 *  지금 제목 기준으로 센다. 제목을 고쳐 지난 제안이 떨어져 나가면 숫자도 그
 *  자리에서 사라져야 한다 — 조용히 딸려 등록되거나, 반대로 조용히 사라지거나
 *  둘 다 안 된다. 그래서 제목을 칠 때마다 다시 그린다. */
function renderPendingBadge() {
  const count = activeChildren(pendingChildren, card.titleValue.trim()).length;
  aiBtn.textContent = count > 0 ? `✨ 하위 ${count}` : "✨ AI 제안";
  aiClearBtn.hidden = count === 0;
}

// 하위만 걷어내는 길. 제목은 그대로 두고 상위 하나로만 등록하고 싶을 때 쓴다 —
// 이것이 없으면 제목을 고치거나 AI를 다시 부르는 수밖에 없다.
bindTip(aiClearBtn, "적용한 하위 작업 지우기", "above");
aiClearBtn.onclick = () => {
  pendingChildren = null;
  renderPendingBadge();
  card.titleElement.focus();
};

// Ctrl+Enter and the submit button can fire while a create request is still in flight;
// without this guard each extra press files the same issue again.
let submitting = false;

async function submitIssue() {
  if (submitting) return;
  const name = card.titleValue.trim();
  if (!name) {
    card.markTitleError();
    card.showError("제목을 입력하세요");
    return;
  }
  if (!card.state.selectedId) {
    card.showError("프로젝트를 선택하세요");
    return;
  }
  const projectId = card.state.selectedId;
  const startDate = resolveDateChoice(card.state.startChoice, card.state.startCustomDate);
  const targetDate = resolveDateChoice(card.state.dueChoice, card.state.dueCustomDate);
  const children = activeChildren(pendingChildren, name);
  const route = resolveSubmitRoute(pendingTree, children, projectId, name);

  submitting = true;
  try {
    if (route.kind === "attach") {
      // 상위는 이미 서버에 있다. 하위만 만들어 붙인다 — 폼의 제목·설명은 상위의
      // 것이라 여기서 다시 보내지 않는다.
      const failed = await attachChildren(route.tree, route.children);
      if (failed.length > 0) {
        reportPartialFailure(name, failed);
        return;
      }
    } else if (route.kind === "tree") {
      const result = await createIssueTree(
        projectId,
        name,
        route.children,
        card.state.assigneeIds,
        startDate,
        targetDate,
        card.state.priority,
        card.state.stateGroup,
        card.descriptionValue,
      );
      if (result.failed.length > 0) {
        // 부모와 일부 자식은 이미 만들어졌다 — 창을 닫지 않고 실패만 알린다.
        // 다시 누르면 이 부모에 붙이도록 하위가 물려받은 값까지 적어 둔다.
        pendingTree = {
          parentId: result.parent_id,
          title: name,
          projectId,
          assigneeIds: card.state.assigneeIds,
          startDate,
          targetDate,
          priority: card.state.priority,
          stateGroup: card.state.stateGroup,
        };
        reportPartialFailure(name, result.failed);
        return;
      }
    } else if (route.kind === "single") {
      await createIssue(
        projectId,
        name,
        card.state.assigneeIds,
        startDate,
        targetDate,
        card.state.priority,
        card.state.stateGroup,
        card.descriptionValue,
      );
    }
    // route.kind === "done"이면 아무것도 보내지 않고 여기로 온다 — 상위는 이미
    // 서버에 있고 남은 하위는 사용자가 걷어냈다. 다시 만들면 같은 이름의 작업이
    // 둘이 되므로, 등록이 끝난 것으로 보고 폼만 비운다.
    card.titleValue = "";
    resetFields();
    await win.hide();
  } catch (err) {
    card.markTitleError();
    card.showError("등록 실패: " + err);
    console.error(err);
  } finally {
    submitting = false;
  }
}

/** 이미 만들어진 상위에 하위를 하나씩 붙인다. 만들지 못한 제목만 돌려준다.
 *
 *  하위가 물려받는 값은 `tree`에 적어 둔 것을 쓴다 — 먼저 성공한 형제와 같은
 *  모양이어야 하기 때문이다. 설명은 비워 보낸다: create_issue_tree도 하위에는
 *  설명을 넣지 않으므로, 여기서 폼의 설명을 넣으면 재시도로 만들어진 하위만
 *  설명을 갖게 된다. */
async function attachChildren(tree: PendingTree, children: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const child of children) {
    try {
      await createIssue(
        tree.projectId,
        child,
        tree.assigneeIds,
        tree.startDate,
        tree.targetDate,
        tree.priority,
        tree.stateGroup,
        "",
        tree.parentId,
      );
    } catch (err) {
      console.error("child create failed:", child, err);
      failed.push(child);
    }
  }
  return failed;
}

/** 상위는 만들어졌는데 하위 일부가 남은 상태. 창을 닫지 않고 실패분만 남겨
 *  Ctrl+Enter로 다시 시도할 수 있게 한다. 남은 하위도 이 제목에 매어 둔다 —
 *  제목을 바꾸면 pendingTree와 함께 떨어져 나가야 하기 때문이다. */
function reportPartialFailure(title: string, failed: string[]) {
  card.showError(`하위 ${failed.length}개를 만들지 못했습니다: ${failed.join(", ")}`);
  pendingChildren = { formTitle: title, titles: failed };
  renderPendingBadge();
}

function resetFields() {
  resetFormFields(card.state);
  card.descriptionValue = "";
  pendingChildren = null;
  pendingTree = null;
  sheetHandle?.close();
  sheetHandle = null;
  renderPendingBadge();
  dismissCoach(false); // 등록하고 창이 숨으므로 안내도 함께 치운다
  card.resetView();
  card.render();
  card.clearError();
}

async function load() {
  lastLoadAt = Date.now();
  // 설정은 로컬 파일이라 바로 온다. 프로젝트 목록(Plane API)과 한데 묶어 기다리면
  // 네트워크가 느릴 때 큰 창으로 쓰던 사용자에게 작은 창이 먼저 뜨고 뒤늦게 넓어진다
  // — 모양은 기다릴 이유가 없으므로 먼저 적용한다.
  const settings = await getSettings();
  applyTheme(settings.theme);
  card.setLayout(layoutKindOf(settings.quickadd_layout));
  // 레이아웃이 바뀌면 창 폭이 540↔660으로 달라져 토글도 옮겨간다 — 안내가 떠 있으면
  // 화살표가 엉뚱한 곳을 가리키지 않게 다시 맞춘다.
  if (!coachEl.hidden) positionCoach();

  const fetched = await listProjects().catch(() => []);
  projects = fetched;
  card.state.selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  projectPicker.render();
  // 프로젝트가 방금 정해졌다 — 한눈에 보기의 담당자 행은 이 값에 딸려 있으므로
  // 여기서 한 번 더 그려야 목록을 받아온다.
  card.render();
}

/** Flashes the submit button — plain Enter no longer submits, so this teaches Ctrl+Enter. */
function pulseSubmit() {
  qaSubmit.classList.remove("pulse");
  void (qaSubmit as HTMLElement).offsetWidth; // restart the animation on rapid presses
  qaSubmit.classList.add("pulse");
}

card.titleElement.addEventListener("keydown", (e) => {
  card.clearTitleError();
  if (e.key !== "Enter") card.clearError();
  if (e.key === "Enter" && !e.ctrlKey) {
    e.preventDefault();
    pulseSubmit();
  }
});

// 제목이 달라지면 지난 제안의 하위는 더 이상 이 폼의 것이 아니다(activeChildren).
// 배지를 그 자리에서 다시 그려 무슨 일이 일어났는지 보이게 한다 — 되돌려 치면
// 숫자도 함께 돌아온다.
card.titleElement.addEventListener("input", renderPendingBadge);

qaSubmit.addEventListener("click", () => { submitIssue(); });

// Focus fires both when the window is summoned and when the user merely clicks
// back into the still-open window, so it must never touch the draft — a draft
// is cleared only by a successful submit (see submitIssue). Focus just parks
// the cursor and refreshes the project list (cooldown-gated).
win.listen("tauri://focus", () => {
  card.titleElement.focus();
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
  card.state.selectedId = e.payload;
  card.state.members = [];
  card.state.membersLoadedForProject = null;
  card.state.assigneeIds = [];
  projectPicker.render();
  card.render();
});

// 설정 창이 저장하면 즉시 반영한다 — 이 창은 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
});

card.titleElement.focus();
resizeWindow(); // 설명이 접혀 있는 첫 화면 크기를 잡는다
load();
