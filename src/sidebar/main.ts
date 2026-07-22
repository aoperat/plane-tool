import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getVersion } from "@tauri-apps/api/app";
import { acknowledgeAssignment, checkUpdatesManual, createIssue, deleteWorkItem, fetchCycleData, fetchReleaseNotes, fetchSidebarData, getConflicts, getOfflineStatus, getPendingAssignments, getSettings, openBriefing, openConflictWindow, openEditModal, openSettings, saveSettings, showQuickaddForProject, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { notesToHtml } from "./releaseNotes";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon, CALENDAR_ICON, EXTERNAL_LINK_ICON } from "../shared/planeIcons";
import { buildIssueUrl, clampSidebarWidth, computeSidebarGeometry, filterByPriority, filterBySearch, filterByStateGroup, filterHiddenCompleted, formatDateRange, formatLocalTime, formatRelativeTime, groupItemsByProject, groupProgress, offlineStatusText, resolveAssigneeName, resolveStateId, SIDEBAR_WIDTH_DEFAULT, splitByCycle, visibleTabItems } from "./logic";
import type { GroupAxis, SidebarTab, SubGroup } from "./logic";
import { sortMonitorsByPosition, pickMonitor } from "../shared/monitors";
import { isWithinCooldown } from "../shared/cooldown";
import { applyTheme, toggledThemePref } from "../shared/theme";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
import type { SidebarData, Project, ReleaseNote, WorkItem, ProjectState, PendingAssignment, CycleData } from "../shared/types";
import "../shared/app.css";

// The window is wider than the panel so the collapse tab can sit outside the
// panel's rectangle; the strip left of the panel is transparent. Keep in sync
// with `.collapse-tab` (width) in app.css and the window width in
// tauri.conf.json.
const COLLAPSE_TAB_WIDTH = 28;

// 패널 폭은 사용자가 왼쪽 가장자리를 끌어 바꾼다. 사이드바 webview만 쓰는
// 화면 취향이라 백엔드 설정이 아니라 localStorage에 둔다 — hideCompleted,
// delegatedShowAll 과 같은 자리다.
const SIDEBAR_WIDTH_KEY = "sidebarWidth";
let panelWidth = readStoredPanelWidth();

function readStoredPanelWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : SIDEBAR_WIDTH_DEFAULT;
}

/** 폭 상태와 CSS 변수를 함께 갱신한다. 둘 중 하나만 바꾸면 창 크기와 패널
 *  그림이 어긋난다. */
function applyPanelWidth(w: number): void {
  panelWidth = w;
  document.documentElement.style.setProperty("--panel-w", `${w}px`);
}

function persistPanelWidth(): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(panelWidth));
}

function windowWidth(): number {
  return panelWidth + COLLAPSE_TAB_WIDTH;
}

applyPanelWidth(panelWidth);
// Every window focus (including re-showing the sidebar on toggle) re-fetches the full sidebar
// data set, which itself is an N+1 request per project — a cooldown keeps re-focusing from
// bursting past the Plane server's rate limit (60 req/min per API key). Local edits don't
// need this refresh anymore (item-updated/item-deleted patch in place), and new items force
// their own refresh via the backend's refresh-sidebar event, so a long cooldown only delays
// picking up changes other people made on the server.
const REFRESH_COOLDOWN_MS = 60_000;

const win = getCurrentWindow();
const tasksEl = document.getElementById("tasks")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
const inboxEl = document.getElementById("inbox")!;
const emptyStateEl = document.getElementById("emptyState")!;
const searchToggle = document.getElementById("searchToggle")!;
const searchBar = document.getElementById("searchBar")!;
const searchInput = document.getElementById("searchInput") as HTMLInputElement;
const searchClearEl = document.getElementById("searchClear")!;
const searchCountEl = document.getElementById("searchCount")!;
const statusFilterChip = document.getElementById("statusFilterChip")!;
const priorityFilterChip = document.getElementById("priorityFilterChip")!;
let baseUrl = "";
let workspace = "";
let states: ProjectState[] = [];
let openPopover: HTMLElement | null = null;
let pinned = false;
let searchQuery = "";
let statusFilter: string | null = null;
let priorityFilter: string | null = null;
// 유휴 자동 열림 보호: true인 동안은 blur 자동 숨김을 무시한다. 사용자가
// 자리에 없을 때 열린 사이드바는 키보드/마우스 입력 없이는 닫히면 안 되고,
// 무인 상태에서는 화면 잠금·알림·다른 앱 활성화 등이 얼마든지 blur를
// 일으킬 수 있기 때문. 입력이 재개되면(백엔드 idle-ended, 또는 사이드바
// 직접 조작) 해제되어 평소 규칙으로 복귀한다.
let autoOpened = false;
let themePref = "auto";
let lastRefreshAt = 0;
// 접어둔 프로젝트는 webview의 localStorage에 남겨 앱을 껐다 켜도 유지된다
// (완료 표시·활성 탭과 같은 방식). 지워진 프로젝트의 id가 남아도 그 그룹이
// 다시 그려지지 않을 뿐이라 해롭지 않다.
const COLLAPSED_KEY = "collapsedProjects";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((v): v is string => typeof v === "string"));
  } catch {
    // 손상된 값이면 전부 펼친 상태로 시작한다 — 접힘은 복구할 가치가 없다.
    return new Set();
  }
}

const collapsedGroups = loadCollapsedGroups();

function persistCollapsedGroups() {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups]));
}
// 마지막 렌더에서 실제로 화면에 나온 프로젝트 id — "모두 접기"가 무엇을
// 대상으로 하는지, 그리고 지금이 전부 접힌 상태인지 판단하는 기준이다.
// 항목이 하나도 없는 프로젝트는 애초에 그룹으로 그려지지 않으므로
// collapsedGroups 전체가 아니라 이 목록과 비교해야 한다.
let lastGroupIds: string[] = [];
let lastItems: WorkItem[] = [];
let lastProjects: Project[] = [];
let lastSidebarData: SidebarData | null = null;
let delegatedMemberNames = new Map<string, string>();

const ACTIVE_TAB_KEY = "sidebarActiveTab";
let activeTab: SidebarTab = localStorage.getItem(ACTIVE_TAB_KEY) === "delegated" ? "delegated" : "assigned";

const DELEGATED_SHOW_ALL_KEY = "delegatedShowAll";
let delegatedShowAll = localStorage.getItem(DELEGATED_SHOW_ALL_KEY) === "1";
let pendingCount = 0;
let conflictCount = 0;
const conflictBadgeEl = document.getElementById("conflictBadge")!;
const conflictCountEl = document.getElementById("conflictCount")!;

function renderConflictBadge() {
  conflictBadgeEl.hidden = conflictCount === 0;
  conflictCountEl.textContent = String(conflictCount);
}

// View preferences, persisted in the webview's localStorage (no backend setting
// needed). Both are toggled from the more-menu's 보기 설정 section — see openMoreMenu.
const HIDE_DONE_KEY = "hideCompleted";
let hideCompleted = localStorage.getItem(HIDE_DONE_KEY) === "1";

// 사이클 데이터. 작업 목록(60초 쿨다운)보다 훨씬 덜 바뀌므로 갱신 주기를
// 따로 가져간다. 캐시를 localStorage에 두어 앱을 다시 켰을 때와 네트워크가
// 끊겼을 때 마지막 성공 결과를 그대로 쓴다.
const CYCLE_CACHE_KEY = "cycleDataCache";
const CYCLE_TTL_MS = 10 * 60_000;
let cycleData: CycleData | null = null;
let cycleFetchedAtMs = 0;
let cycleInFlight: Promise<void> | null = null;
let itemCycleMap = new Map<string, string>();

function setCycleData(data: CycleData, fetchedAtMs: number): void {
  cycleData = data;
  cycleFetchedAtMs = fetchedAtMs;
  itemCycleMap = new Map(Object.entries(data.item_cycle));
}

function loadCachedCycleData(): void {
  try {
    const raw = localStorage.getItem(CYCLE_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { data: CycleData; at: number };
    // 단순 truthy 체크가 아니라 실제 모양을 검사한다 — 이 캐시는 앱 버전을
    // 넘어 남으므로, 다른 버전이 써둔 다른 모양의 값이 그대로 들어올 수
    // 있다. 여기서 걸러내지 않으면 itemCycleMap 생성이나 이후 렌더링 안에서
    // 알아보기 힘든 crash로 터진다.
    const cycles = parsed?.data?.cycles;
    const itemCycle = parsed?.data?.item_cycle;
    if (Array.isArray(cycles) && itemCycle != null && typeof itemCycle === "object") {
      setCycleData(parsed.data, parsed.at);
    }
  } catch {
    // 손상된 캐시는 없는 셈 친다 — 다음 요청이 다시 채운다.
  }
}
loadCachedCycleData();

/** 사이클별 보기에 필요한 데이터를 확보한다. 신선한 캐시가 있으면 아무것도
 *  하지 않고, 없으면 백그라운드로 받아온 뒤 화면을 다시 그린다. 실패하면
 *  낡은 캐시를 그대로 쓴다 — 축을 되돌리지는 않는다. 사용자가 자기가 뭘
 *  잘못 눌렀다고 오해하기 때문이다. */
function ensureCycleData(): void {
  if (cycleInFlight) return;
  if (cycleData && Date.now() - cycleFetchedAtMs < CYCLE_TTL_MS) return;
  const stale = cycleData === null;
  if (stale) synced.textContent = "사이클 불러오는 중…";
  cycleInFlight = fetchCycleData(resolveDatePreset("today"))
    .then((data) => {
      const at = Date.now();
      setCycleData(data, at);
      // 저장은 최선-노력(best-effort) 최적화일 뿐이다 — 여기서 실패해도
      // (용량 초과 등) fetch 자체는 성공했으니 그것을 fetch 실패로 보고하면
      // 안 되고, 화면도 이미 받은 데이터로 계속 그려야 한다.
      try {
        localStorage.setItem(CYCLE_CACHE_KEY, JSON.stringify({ data, at }));
      } catch (err) {
        console.error("cycle cache setItem failed:", err);
      }
      renderFromLastData();
    })
    .catch((err) => {
      console.error("fetchCycleData failed:", err);
      if (stale) synced.textContent = "사이클을 불러오지 못했습니다";
    })
    .finally(() => {
      cycleInFlight = null;
    });
}

const sectionTitleEl = document.getElementById("sectionTitle")!;
const sectionHeadEl = document.getElementById("sectionHead")!;
const foldAllEl = document.getElementById("foldAll")!;
const axisBtnEl = document.getElementById("axisBtn")!;

// 묶는 기준. 화면 취향이라 localStorage에 둔다 (hideCompleted와 같은 자리).
const GROUP_AXIS_KEY = "sidebarGroupAxis";
let groupAxis: GroupAxis = localStorage.getItem(GROUP_AXIS_KEY) === "cycle" ? "cycle" : "flat";

const AXIS_LABEL: Record<GroupAxis, string> = { flat: "전체 작업", cycle: "사이클별" };

function syncAxisButton(): void {
  axisBtnEl.innerHTML = `${AXIS_LABEL[groupAxis]}<span class="car">▾</span>`;
  axisBtnEl.classList.toggle("alt", groupAxis !== "flat");
}
syncAxisButton();

function setGroupAxis(next: GroupAxis): void {
  groupAxis = next;
  localStorage.setItem(GROUP_AXIS_KEY, next);
  syncAxisButton();
  if (next === "cycle") ensureCycleData();
  renderTasks(lastItems, lastProjects);
}

axisBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (openPopover) {
    closePopover();
    return;
  }
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = "156px";

  const head = document.createElement("div");
  head.className = "pop-head";
  // 프로젝트가 언제나 최상위임을 제목이 못박는다.
  head.textContent = "프로젝트 안에서";
  pop.appendChild(head);

  for (const axis of ["flat", "cycle"] as GroupAxis[]) {
    const item = document.createElement("div");
    item.className = "pop-item" + (groupAxis === axis ? " sel" : "");
    item.textContent = AXIS_LABEL[axis];
    item.onclick = (ev) => {
      ev.stopPropagation();
      closePopover();
      setGroupAxis(axis);
    };
    pop.appendChild(item);
  }

  const rect = axisBtnEl.getBoundingClientRect();
  attachPopover(pop, rect.right - 156, rect.bottom + 6);
});

// 접기는 화살표가 선 쪽으로 모이고, 펼치기는 선에서 벌어진다. 서로 마주보는
// 겹화살표(chevrons-down-up)는 14px에서 X자로 뭉쳐 읽혀 쓰지 않았다.
const FOLD_ICON =
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7 8 2.5 12.5 7"/><path d="M3 12.5h10"/></svg>`;
const UNFOLD_ICON =
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9 8 13.5 12.5 9"/><path d="M3 3.5h10"/></svg>`;

/** 화면에 나온 그룹이 하나도 빠짐없이 접혀 있는지. 그룹이 없으면 false —
 *  이 경우 버튼 자체를 숨기므로 어느 쪽으로 판정하든 보이지 않는다. */
function allGroupsCollapsed(): boolean {
  return lastGroupIds.length > 0 && lastGroupIds.every((id) => collapsedGroups.has(id));
}

/** 버튼은 하나이고 상태에 따라 뜻이 바뀐다 — 하나라도 펼쳐져 있으면 "모두
 *  접기", 전부 접혀 있으면 "모두 펼치기". renderTasks가 그룹을 다시 계산할
 *  때마다 호출해 화면과 어긋나지 않게 한다. */
function syncFoldButton() {
  const collapsed = allGroupsCollapsed();
  foldAllEl.hidden = lastGroupIds.length === 0;
  foldAllEl.innerHTML = collapsed ? UNFOLD_ICON : FOLD_ICON;
  foldAllEl.title = collapsed ? "모든 프로젝트 펼치기" : "모든 프로젝트 접기";
}

foldAllEl.onclick = (e) => {
  e.stopPropagation();
  if (allGroupsCollapsed()) collapsedGroups.clear();
  else for (const id of lastGroupIds) collapsedGroups.add(id);
  persistCollapsedGroups();
  renderTasks(lastItems, lastProjects);
};
const assignedTabCountEl = document.getElementById("assignedTabCount")!;
const delegatedTabCountEl = document.getElementById("delegatedTabCount")!;
const tabEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".sb-tab"));
const sbTabsEl = document.getElementById("sbTabs")!;
// 설정 확인 전까지는 기본으로 숨긴다 — show_delegated_tab의 기본값이
// 꺼짐이므로, 첫 로드 시 탭 바가 잠깐 보였다 사라지는 깜빡임을 막는다.
sbTabsEl.hidden = true;

function syncTabButtons() {
  tabEls.forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
}

// localStorage에서 복원된 activeTab이 "delegated"일 수 있으므로, HTML의 기본
// active 클래스(assigned)를 실제 상태와 맞춘다 — 안 하면 재시작 직후 목록은
// 위임 탭인데 탭 버튼은 담당 작업이 활성으로 보이는 불일치가 생긴다.
syncTabButtons();

// 탭/토글 전환은 이미 받은 SidebarData를 재필터링할 뿐, fetchSidebarData를
// 다시 부르지 않는다 — 오프라인에서도 즉시 전환되고 서버 부하도 없다.
function renderActiveTabView() {
  if (!lastSidebarData) return;
  sectionTitleEl.textContent = activeTab === "assigned" ? "나에게 할당된 작업" : "내가 할당한 작업";
  renderTasks(visibleTabItems(activeTab, lastSidebarData, delegatedShowAll), lastSidebarData.projects);
}

/** 탭 카운트와 현재 탭 목록을 lastSidebarData 기준으로 다시 그린다 —
 *  전체 fetch(runRefresh)와 로컬 패치(item-updated/item-deleted)가 공유한다.
 *  개수는 목록과 같은 visibleTabItems로 세므로 둘이 어긋나지 않는다. */
function renderFromLastData() {
  if (!lastSidebarData) return;
  assignedTabCountEl.textContent = String(visibleTabItems("assigned", lastSidebarData, delegatedShowAll).length);
  delegatedTabCountEl.textContent = String(visibleTabItems("delegated", lastSidebarData, delegatedShowAll).length);
  renderActiveTabView();
}

// 백엔드가 수정/삭제 성공 시 보내는 로컬 패치 이벤트의 payload. 전체
// 재동기화 대신 이미 받아둔 데이터에 변경분만 반영한다 — 서버 요청이 없다.
type ItemChange = {
  project_id: string;
  item_id: string;
  name: string | null;
  assignee_ids: string[] | null;
  start_date: string | null;
  target_date: string | null;
  priority: string | null;
  state_group: string | null;
};

function applyItemChange(c: ItemChange) {
  if (!lastSidebarData) return;
  // 담당자 변경으로 항목이 내 목록에서 빠지거나 탭 간 이동해야 하는 경우는
  // 여기서 판별할 수 없다(내 user id를 모름) — 다음 전체 새로고침이 맞춘다.
  for (const list of [lastSidebarData.assigned, lastSidebarData.delegated]) {
    const it = list.find((i) => i.id === c.item_id);
    if (!it) continue;
    if (c.name != null) it.name = c.name;
    if (c.priority != null) it.priority = c.priority;
    if (c.assignee_ids != null) it.assignee_ids = c.assignee_ids;
    if (c.start_date != null) it.start_date = c.start_date === "" ? null : c.start_date;
    if (c.target_date != null) it.target_date = c.target_date === "" ? null : c.target_date;
    if (c.state_group != null && c.state_group !== it.state_group) {
      it.state_group = c.state_group;
      // 서버는 완료 전환 시 completed_at을 채운다 — 로컬에도 채워야
      // filterVisibleToday가 "오늘 완료"로 인정해 목록에서 사라지지 않는다.
      it.completed_at = c.state_group === "completed" ? new Date().toISOString() : null;
    }
  }
  renderFromLastData();
}

function removeItemLocally(itemId: string) {
  if (!lastSidebarData) return;
  lastSidebarData.assigned = lastSidebarData.assigned.filter((i) => i.id !== itemId);
  lastSidebarData.delegated = lastSidebarData.delegated.filter((i) => i.id !== itemId);
  renderFromLastData();
}

tabEls.forEach((btn) => {
  btn.onclick = () => {
    const tab = btn.dataset.tab as SidebarTab;
    if (tab === activeTab) return;
    activeTab = tab;
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
    syncTabButtons();
    renderActiveTabView();
  };
});

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const STATE_LABELS: Record<string, string> = {
  backlog: "백로그", unstarted: "시작 전", started: "진행 중", completed: "완료", cancelled: "취소",
};
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "없음",
};

// ---- 검색 줄: 헤더 밑에 붙였다 뗐다 하며, 닫으면 검색어·필터를 모두 초기화한다 ----
function openSearch() {
  searchBar.hidden = false;
  searchToggle.classList.add("active");
  searchInput.focus();
}

function closeSearch() {
  searchBar.hidden = true;
  searchToggle.classList.remove("active");
  searchQuery = "";
  searchInput.value = "";
  statusFilter = null;
  statusFilterChip.textContent = "상태: 전체";
  statusFilterChip.classList.remove("active");
  priorityFilter = null;
  priorityFilterChip.textContent = "우선순위: 전체";
  priorityFilterChip.classList.remove("active");
  renderTasks(lastItems, lastProjects);
}

searchToggle.onclick = () => { searchBar.hidden ? openSearch() : closeSearch(); };
searchClearEl.onclick = closeSearch;
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderTasks(lastItems, lastProjects);
});

statusFilterChip.onclick = (e) => {
  e.stopPropagation();
  const options = [{ value: null, label: "전체" }, ...STATE_GROUPS.map((g) => ({ value: g as string, label: STATE_LABELS[g] }))];
  openFilterPopover(statusFilterChip, options, statusFilter, (value) => {
    statusFilter = value;
    statusFilterChip.textContent = `상태: ${value ? STATE_LABELS[value] : "전체"}`;
    statusFilterChip.classList.toggle("active", value !== null);
    renderTasks(lastItems, lastProjects);
  });
};

priorityFilterChip.onclick = (e) => {
  e.stopPropagation();
  const options = [{ value: null, label: "전체" }, ...PRIORITIES.map((p) => ({ value: p as string, label: PRIORITY_LABELS[p] }))];
  openFilterPopover(priorityFilterChip, options, priorityFilter, (value) => {
    priorityFilter = value;
    priorityFilterChip.textContent = `우선순위: ${value ? PRIORITY_LABELS[value] : "전체"}`;
    priorityFilterChip.classList.toggle("active", value !== null);
    renderTasks(lastItems, lastProjects);
  });
};

const PLUS_ICON =
  `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`;

const RING_CIRCUMFERENCE = 2 * Math.PI * 6; // viewBox 16, r=6

function progressRingSvg(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0;
  const arc = frac > 0
    ? `<circle cx="8" cy="8" r="6" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-dasharray="${(frac * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 8 8)"/>`
    : "";
  return `<svg class="ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" stroke-width="2.4"/>${arc}</svg>`;
}

/** Optimistically applies a single date-field change and syncs it to the server.
 *  `value: null` clears the field (sent as "" — the backend maps it to JSON null). */
function applyDateChange(
  it: WorkItem,
  allItems: WorkItem[],
  projects: Project[],
  field: "start_date" | "target_date",
  value: string | null,
) {
  const prev = it[field];
  it[field] = value;
  renderTasks(allItems, projects);
  const payload = field === "start_date" ? { start_date: value ?? "" } : { target_date: value ?? "" };
  updateWorkItemFields(it.project_id, it.id, payload).catch((err) => {
    it[field] = prev;
    renderTasks(allItems, projects);
    synced.textContent = "기간 변경 실패: " + err;
    console.error("updateWorkItemFields failed:", err);
  });
}

function dateInputRow(label: string, value: string | null, onPick: (v: string | null) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "date-row";
  const lab = document.createElement("span");
  lab.className = "date-row-label";
  lab.textContent = label;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "date";
  input.className = "popover-date-input";
  input.value = value ?? "";
  input.onclick = (e) => e.stopPropagation();
  input.onchange = () => {
    if (input.value) onPick(input.value);
  };
  row.appendChild(input);
  const clear = document.createElement("span");
  clear.className = "date-row-clear";
  clear.textContent = "×";
  clear.title = "지우기";
  clear.onclick = (e) => {
    e.stopPropagation();
    onPick(null);
  };
  row.appendChild(clear);
  return row;
}

/** Appends a preset list + manual date-input row for one date field
 *  ("시작일" / "마감일") to a sidebar date popover. */
function buildDateFieldSection(
  pop: HTMLElement,
  label: string,
  field: "start_date" | "target_date",
  it: WorkItem,
  allItems: WorkItem[],
  projects: Project[],
) {
  for (const preset of DATE_PRESETS) {
    const opt = document.createElement("div");
    opt.className = "pop-item";
    opt.textContent = label + ": " + preset.label;
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      applyDateChange(it, allItems, projects, field, resolveDatePreset(preset.key));
    };
    pop.appendChild(opt);
  }
  pop.appendChild(dateInputRow(label, it[field], (v) => {
    closePopover();
    applyDateChange(it, allItems, projects, field, v);
  }));
}

function openSidebarDatePopover(anchor: HTMLElement, it: WorkItem, allItems: WorkItem[], projects: Project[]) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = "200px";
  pop.onclick = (e) => e.stopPropagation();

  buildDateFieldSection(pop, "시작일", "start_date", it, allItems, projects);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  buildDateFieldSection(pop, "마감일", "target_date", it, allItems, projects);

  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}

function openStatePopover(anchor: HTMLElement, item: WorkItem, onPicked: (group: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  // Body-level fixed positioning (see attachPopover) — nesting inside the
  // row breaks on completed rows: their opacity creates a stacking context,
  // so the popover renders semi-transparent and rows below it win hover/click.
  pop.style.position = "fixed";
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
  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

function openPriorityPopover(anchor: HTMLElement, item: WorkItem, onPicked: (priority: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  // Body-level fixed positioning (see attachPopover) — nesting inside the
  // anchor chip doesn't work here because .chip has overflow:hidden, which
  // clips the popover entirely.
  pop.style.position = "fixed";
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
  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

/** Generic single-select list popover for the search bar's state/priority filter chips
 *  (as opposed to openStatePopover/openPriorityPopover above, which edit one work item). */
function openFilterPopover(
  anchor: HTMLElement,
  options: Array<{ value: string | null; label: string }>,
  current: string | null,
  onPicked: (value: string | null) => void,
) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "pop-item" + (opt.value === current ? " sel" : "");
    item.textContent = opt.label;
    item.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onPicked(opt.value);
    };
    pop.appendChild(item);
  }
  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}

/** Opens `url` in the default browser, dropping always-on-top first so the
 *  browser window can appear above the sidebar instead of behind it. */
async function openExternal(url: string) {
  try {
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    synced.textContent = "열기 실패: " + err;
    console.error("openUrl failed:", url, err);
  }
}

async function openInBrowser(it: WorkItem) {
  await openExternal(buildIssueUrl(baseUrl, workspace, it.project_id, it.id));
}

async function duplicateWorkItem(it: WorkItem) {
  try {
    // No assignee_ids on the frontend WorkItem type — an empty list makes
    // create_issue default to the current user, which is correct here since
    // the sidebar only ever lists items already assigned to the current user.
    await createIssue(it.project_id, it.name, [], undefined, it.target_date ?? undefined, it.priority, it.state_group, "");
    await refresh();
  } catch (err) {
    synced.textContent = "복사본 생성 실패: " + err;
    console.error("createIssue (duplicate) failed:", err);
  }
}

async function deleteWorkItemAction(it: WorkItem) {
  try {
    await deleteWorkItem(it.project_id, it.id);
  } catch (err) {
    synced.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
  }
}

async function copyIssueLink(it: WorkItem) {
  const url = buildIssueUrl(baseUrl, workspace, it.project_id, it.id);
  try {
    await writeText(url);
    synced.textContent = "링크 복사됨";
  } catch (err) {
    synced.textContent = "링크 복사 실패: " + err;
    console.error("writeText failed:", err);
  }
}

const CONTEXT_MENU_WIDTH = 180;

/**
 * Attaches `pop` to `document.body` (not the row it was triggered from) with
 * fixed positioning at viewport coordinates (x, y), clamped to stay on
 * screen. Popovers are taller than a single row, so nesting them inside a
 * row let them visually spill into sibling rows below — since those siblings
 * are later in the DOM, they'd win hover/click there instead of the menu
 * (and a completed row's opacity makes the nested popover translucent too).
 * Body-level fixed positioning sidesteps that entirely.
 */
function attachPopover(pop: HTMLElement, x: number, y: number) {
  document.body.appendChild(pop);
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width)) + "px";
  pop.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height)) + "px";
  openPopover = pop;
}

/** Appends a standard clickable menu row to `pop`; clicking closes the popover, then runs `onClick`. */
function appendPopItem(pop: HTMLElement, label: string, onClick: () => void) {
  const opt = document.createElement("div");
  opt.className = "pop-item";
  opt.textContent = label;
  opt.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    onClick();
  };
  pop.appendChild(opt);
}

function openContextMenu(it: WorkItem, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";

  appendPopItem(pop, "복사본 만들기", () => duplicateWorkItem(it));
  appendPopItem(pop, "새 탭에서 열기", () => openInBrowser(it));
  appendPopItem(pop, "링크 복사", () => copyIssueLink(it));

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  appendPopItem(pop, "삭제", () => openDeleteConfirm(it, x, y));

  attachPopover(pop, x, y);
}

function openDeleteConfirm(it: WorkItem, x: number, y: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";

  const msg = document.createElement("div");
  msg.className = "pop-msg";
  msg.textContent = "정말 삭제하시겠습니까?";
  pop.appendChild(msg);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  const del = document.createElement("div");
  del.className = "pop-item";
  del.textContent = "삭제";
  del.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    deleteWorkItemAction(it);
  };
  pop.appendChild(del);

  const cancel = document.createElement("div");
  cancel.className = "pop-item";
  cancel.textContent = "취소";
  cancel.onclick = (e) => {
    e.stopPropagation();
    closePopover();
  };
  pop.appendChild(cancel);

  attachPopover(pop, x, y);
}

function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task"
    + (it.state_group === "completed" ? " completed" : "")
    + (it.state_group === "started" ? " in-progress" : "");

  const top = document.createElement("div");
  top.className = "task-top";

  const stateBtn = document.createElement("span");
  stateBtn.className = "task-state";
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
      renderTasks(allItems, projects);
      updateWorkItemState(it.project_id, it.id, stateId).catch((err) => {
        it.state_group = prev;
        renderTasks(allItems, projects);
        synced.textContent = "상태 변경 실패: " + err;
        console.error("updateWorkItemState failed:", err);
      });
    });
  };
  top.appendChild(stateBtn);

  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = it.name;
  top.appendChild(nameEl);

  const browserBtn = document.createElement("span");
  browserBtn.className = "icon-btn row-browser-btn";
  browserBtn.title = "브라우저에서 열기";
  browserBtn.innerHTML = EXTERNAL_LINK_ICON;
  browserBtn.onclick = (e) => {
    e.stopPropagation();
    openInBrowser(it);
  };
  top.appendChild(browserBtn);
  el.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "task-chips";

  const prioChip = document.createElement("span");
  const noPriority = it.priority === "none";
  prioChip.className = "chip sm" + (noPriority ? " empty" : "");
  prioChip.title = "우선순위 변경";
  if (noPriority) {
    prioChip.innerHTML = `${PLUS_ICON} 우선순위`;
  } else {
    prioChip.style.color = priorityColor(it.priority as any);
    prioChip.innerHTML = `${priorityIcon(it.priority as any)} ${PRIORITY_LABELS[it.priority] ?? it.priority}`;
  }
  prioChip.onclick = (e) => {
    e.stopPropagation();
    openPriorityPopover(prioChip, it, (priority) => {
      const prev = it.priority;
      it.priority = priority;
      renderTasks(allItems, projects);
      updateWorkItemPriority(it.project_id, it.id, priority).catch((err) => {
        it.priority = prev;
        renderTasks(allItems, projects);
        synced.textContent = "우선순위 변경 실패: " + err;
        console.error("updateWorkItemPriority failed:", err);
      });
    });
  };
  chips.appendChild(prioChip);

  if (it.state_group === "completed" && it.completed_at) {
    const doneChip = document.createElement("span");
    doneChip.className = "chip sm info";
    doneChip.innerHTML = `${CALENDAR_ICON} 완료 ${formatLocalTime(it.completed_at)}`;
    chips.appendChild(doneChip);
  } else {
    const range = formatDateRange(it.start_date, it.target_date);
    const dateChip = document.createElement("span");
    dateChip.className = "chip sm" + (range ? "" : " empty");
    dateChip.title = "기간 변경";
    dateChip.innerHTML = range ? `${CALENDAR_ICON} ${range}` : `${PLUS_ICON} 마감일`;
    dateChip.onclick = (e) => {
      e.stopPropagation();
      openSidebarDatePopover(dateChip, it, allItems, projects);
    };
    chips.appendChild(dateChip);
  }
  if (activeTab === "delegated" && it.assignee_ids.length > 0) {
    const [firstId, ...restIds] = it.assignee_ids;
    const name = resolveAssigneeName(delegatedMemberNames, firstId);
    const assigneeChip = document.createElement("span");
    assigneeChip.className = "chip sm";
    assigneeChip.title = "담당자";
    const avatarEl = document.createElement("span");
    avatarEl.className = "avatar";
    avatarEl.style.background = colorForId(firstId);
    avatarEl.textContent = name.slice(0, 1);
    assigneeChip.appendChild(avatarEl);
    assigneeChip.appendChild(document.createTextNode(name + (restIds.length > 0 ? ` +${restIds.length}` : "")));
    chips.appendChild(assigneeChip);
  }
  el.appendChild(chips);

  el.onclick = () => openEditModal(it.project_id, it.id, it);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(it, e.clientX, e.clientY);
  };

  return el;
}

function renderTasks(items: WorkItem[], projects: Project[]) {
  lastItems = items;
  lastProjects = projects;
  // 헤더의 개수는 검색/필터와 무관하게 항상 할당된 작업 총합을 보여준다 —
  // 검색·필터는 목록의 "범위"를 좁히는 것이지 표시 설정이 아니므로, 그 결과
  // 개수는 검색 줄 자체의 searchCountEl에 따로 보여준다.
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";

  let filtered = filterBySearch(items, projects, searchQuery);
  filtered = filterByStateGroup(filtered, statusFilter);
  filtered = filterByPriority(filtered, priorityFilter);
  const isFiltering = searchQuery.trim() !== "" || statusFilter !== null || priorityFilter !== null;
  searchCountEl.textContent = isFiltering ? `${filtered.length}개 결과` : "";

  const groups = groupItemsByProject(filtered, projects);
  emptyStateEl.hidden = !isFiltering || groups.length > 0;
  lastGroupIds = groups.map((g) => g.project.id);
  syncFoldButton();
  groups.forEach(({ project, items: groupItems }, i) => {
    // 검색·필터 중에는 접힘을 무시하고 펼쳐 보여준다 — 그러지 않으면
    // "3개 결과"라고 떠도 그 프로젝트가 접혀 있어 화면에는 아무것도 안 보인다.
    const collapsed = collapsedGroups.has(project.id) && !isFiltering;

    const grp = document.createElement("div");
    grp.className = "grp" + (collapsed ? " collapsed" : "") + (i > 0 ? " with-divider" : "");

    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▾";
    grp.appendChild(chev);

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(project.id);
    grp.appendChild(dot);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = project.name;
    grp.appendChild(name);

    if (project.identifier) {
      const ident = document.createElement("span");
      ident.className = "ident";
      ident.textContent = project.identifier;
      grp.appendChild(ident);
    }

    const prog = groupProgress(groupItems);
    const progEl = document.createElement("span");
    progEl.className = "prog";
    progEl.innerHTML = progressRingSvg(prog.done, prog.total) + `<span class="txt">${prog.done}/${prog.total}</span>`;
    grp.appendChild(progEl);

    const addBtn = document.createElement("span");
    addBtn.className = "addbtn";
    addBtn.title = "이 프로젝트에 작업 추가";
    addBtn.innerHTML = PLUS_ICON;
    addBtn.onclick = (e) => {
      e.stopPropagation();
      showQuickaddForProject(project.id).catch((err) => {
        synced.textContent = "QuickAdd 열기 실패: " + err;
        console.error("showQuickaddForProject failed:", err);
      });
    };
    grp.appendChild(addBtn);

    grp.onclick = () => {
      if (collapsedGroups.has(project.id)) collapsedGroups.delete(project.id);
      else collapsedGroups.add(project.id);
      persistCollapsedGroups();
      renderTasks(items, projects);
    };
    tasksEl.appendChild(grp);

    const body = document.createElement("div");
    body.className = "grp-body" + (collapsed ? " collapsed" : "");
    // 검색·필터 중에는 하위 묶음을 그리지 않는다 — "3개 결과"가 세 묶음에
    // 하나씩 흩어지면 좁히려던 목적과 반대로 찾기 어려워진다.
    const subs =
      groupAxis === "cycle" && !isFiltering && cycleData
        ? splitByCycle(groupItems, cycleData.cycles.filter((c) => c.project_id === project.id), itemCycleMap)
        : [];
    if (subs.length > 0) {
      for (const sub of subs) body.appendChild(renderSubGroup(sub, items, projects));
    } else {
      // Filter rows only — the group header (and its progress ring above) still
      // counts hidden completed items, so "3/3" stays visible when all are done.
      for (const it of filterHiddenCompleted(groupItems, hideCompleted)) {
        body.appendChild(renderTaskRow(it, items, projects));
      }
    }
    tasksEl.appendChild(body);
  });
}

/** 하위 묶음 헤더 한 줄 + 그 아래 카드들을 담은 조각을 만든다. 접힘 상태는
 *  프로젝트와 같은 collapsedGroups Set을 쓰되 sub.key가 "cycle:" 접두어를
 *  달고 있어 프로젝트 id와 섞이지 않는다. */
function renderSubGroup(sub: SubGroup, items: WorkItem[], projects: Project[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const collapsed = collapsedGroups.has(sub.key);

  const head = document.createElement("div");
  head.className = "sub" + (collapsed ? " collapsed" : "") + (sub.ghost ? " ghost" : "");

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▾";
  head.appendChild(chev);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sub.name;
  head.appendChild(name);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.appendChild(spacer);

  if (sub.due) {
    const due = document.createElement("span");
    due.className = "due" + (sub.dueKind === "soon" ? " soon" : sub.dueKind === "past" ? " past" : "");
    due.textContent = sub.due;
    head.appendChild(due);
  }

  const prog = groupProgress(sub.items);
  const progEl = document.createElement("span");
  progEl.className = "prog";
  progEl.title = `내 작업 ${prog.done}/${prog.total} 완료`;
  progEl.innerHTML = progressRingSvg(prog.done, prog.total) + `<span class="txt">${prog.done}/${prog.total}</span>`;
  head.appendChild(progEl);

  head.onclick = () => {
    if (collapsedGroups.has(sub.key)) collapsedGroups.delete(sub.key);
    else collapsedGroups.add(sub.key);
    persistCollapsedGroups();
    renderTasks(items, projects);
  };
  frag.appendChild(head);

  const body = document.createElement("div");
  body.className = "sub-body" + (collapsed ? " collapsed" : "");
  for (const it of filterHiddenCompleted(sub.items, hideCompleted)) {
    body.appendChild(renderTaskRow(it, items, projects));
  }
  frag.appendChild(body);
  return frag;
}

async function getTargetMonitor() {
  const [s, monitors] = await Promise.all([getSettings(), availableMonitors()]);
  if (monitors.length === 0) return null;
  return pickMonitor(sortMonitorsByPosition(monitors), s.display_index) ?? null;
}

/** 현재 패널 폭으로 창의 크기와 위치를 다시 잡는다. 창이 화면 오른쪽에
 *  붙어 있으므로 폭과 x좌표를 함께 바꿔야 오른쪽 가장자리가 제자리에 남는다. */
async function applyWindowGeometry(monitor: Awaited<ReturnType<typeof getTargetMonitor>>): Promise<void> {
  if (!monitor) return;
  const geo = computeSidebarGeometry(
    monitor.size.width,
    monitor.size.height,
    monitor.scaleFactor,
    windowWidth(),
    monitor.position.x,
    monitor.position.y,
  );
  await win.setSize(new PhysicalSize(geo.width, geo.height));
  await win.setPosition(new PhysicalPosition(geo.visibleX, geo.y));
}

// ---- 폭 조절 드래그 ----
const resizeHandleEl = document.getElementById("resizeHandle")!;
let dragStartScreenX = 0;
let dragStartWidth = 0;
let dragMonitor: Awaited<ReturnType<typeof getTargetMonitor>> = null;
let dragPendingWidth: number | null = null;
let dragFrame = 0;

resizeHandleEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dragStartScreenX = e.screenX;
  dragStartWidth = panelWidth;
  dragPendingWidth = null;
  dragMonitor = null; // 이전 드래그의 stale monitor 값이 guard를 통과하지 않도록 리셋한다.
  // 캡처는 동기적으로 먼저 잡는다 — await 뒤로 미루면 그 사이의 pointermove를 놓친다.
  resizeHandleEl.setPointerCapture(e.pointerId);
  resizeHandleEl.classList.add("dragging");
  void getTargetMonitor().then((m) => {
    dragMonitor = m;
  });
});

resizeHandleEl.addEventListener("pointermove", (e) => {
  if (!resizeHandleEl.hasPointerCapture(e.pointerId) || !dragMonitor) return;
  // 드래그하는 동안 창 자체가 왼쪽으로 자라므로 창 기준 좌표(clientX)는 매
  // 프레임 원점이 바뀌어 값이 튄다 — 데스크톱 절대 좌표인 screenX를 쓴다.
  // 왼쪽으로 끌수록 screenX가 작아지므로 (시작 - 현재)가 늘어난 폭이다.
  const logicalWidth = dragMonitor.size.width / dragMonitor.scaleFactor;
  dragPendingWidth = clampSidebarWidth(
    dragStartWidth + (dragStartScreenX - e.screenX),
    logicalWidth,
  );
  // setSize/setPosition은 IPC라 pointermove마다 부르면 밀린다 — 프레임당 한 번만.
  if (dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (dragPendingWidth == null) return;
    applyPanelWidth(dragPendingWidth);
    void applyWindowGeometry(dragMonitor);
  });
});

function endResizeDrag(e: PointerEvent): void {
  if (!resizeHandleEl.hasPointerCapture(e.pointerId)) return;
  resizeHandleEl.releasePointerCapture(e.pointerId);
  resizeHandleEl.classList.remove("dragging");
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }
  // 마지막 프레임이 아직 안 돌았을 수 있다 — 놓은 위치를 확실히 반영한다.
  if (dragPendingWidth != null) {
    applyPanelWidth(dragPendingWidth);
    void applyWindowGeometry(dragMonitor);
  }
  dragPendingWidth = null;
  // 저장은 여기서 한 번만 — 드래그 중에 쓰면 매 프레임 localStorage에 쓰게 된다.
  persistPanelWidth();
}
resizeHandleEl.addEventListener("pointerup", endResizeDrag);
resizeHandleEl.addEventListener("pointercancel", endResizeDrag);

resizeHandleEl.addEventListener("dblclick", () => {
  applyPanelWidth(SIDEBAR_WIDTH_DEFAULT);
  persistPanelWidth();
  void getTargetMonitor().then((m) => applyWindowGeometry(m));
});

async function showSidebar(takeFocus = true): Promise<void> {
  const monitor = await getTargetMonitor();
  if (!monitor) {
    await showWindow(takeFocus);
    return;
  }
  // 저장된 폭은 다른 모니터에서 정한 값일 수 있다 — 지금 모니터 기준으로 자른다.
  const clamped = clampSidebarWidth(panelWidth, monitor.size.width / monitor.scaleFactor);
  if (clamped !== panelWidth) {
    applyPanelWidth(clamped);
    persistPanelWidth();
  }
  await applyWindowGeometry(monitor);
  await win.setAlwaysOnTop(true);
  await showWindow(takeFocus);
}

// takeFocus=false는 유휴 자동 열기 전용: 포커스를 가지면 사용자가 자리에
// 없는 동안 어떤 포커스 변화(화면 잠금, 알림, 다른 앱 활성화)든 blur 자동
// 숨김을 발동시켜 사이드바가 저절로 닫힌다. show() 자체가 Windows에서 창을
// 활성화하므로, 표시하는 동안만 focusable을 꺼서 활성화를 막는다.
async function showWindow(takeFocus: boolean): Promise<void> {
  if (takeFocus) {
    await win.show();
    await win.setFocus();
    return;
  }
  // show()가 실패해도 focusable은 반드시 복구 — 아니면 이후 수동 열기의
  // setFocus()가 활성화 불가 창에 막혀 사이드바가 앱 재시작 전까지
  // 포커스를 못 받는다.
  try {
    await win.setFocusable(false);
    await win.show();
  } finally {
    await win.setFocusable(true);
  }
}

async function hideSidebar(): Promise<void> {
  if (!(await win.isVisible())) return;
  await win.hide();
}

// F2 연타(또는 OS 키 반복)로 toggle-sidebar가 겹쳐 들어오면 win.isVisible()의
// IPC 왕복 도중 여러 호출이 같은 옛 가시성 상태를 읽고 같은 동작을 중복
// 실행할 수 있다(TOCTOU) — 프라미스 체인으로 직렬화해 항상 이전 토글이 끝난
// 뒤의 상태를 보게 한다. .catch로 앞선 실패가 뒤 토글까지 막지 않게 한다.
let toggleInFlight: Promise<void> = Promise.resolve();
function toggleSidebar(): Promise<void> {
  toggleInFlight = toggleInFlight.catch(() => {}).then(async () => {
    if (await win.isVisible()) await hideSidebar();
    else await showSidebar();
  });
  return toggleInFlight;
}

function renderInbox(pending: PendingAssignment[]) {
  inboxEl.hidden = pending.length === 0;
  inboxEl.innerHTML = "";
  if (pending.length === 0) return;

  const head = document.createElement("div");
  head.className = "inbox-h";
  head.innerHTML = `<span><span class="inbox-dot"></span>새로 할당됨</span><span>${pending.length}</span>`;
  inboxEl.appendChild(head);

  for (const p of pending) {
    const card = document.createElement("div");
    card.className = "new-task";

    const who = document.createElement("div");
    who.className = "assigner";
    who.innerHTML = `<b></b>님이 할당 <span class="when">${formatRelativeTime(p.detected_at_ms, Date.now())}</span>`;
    who.querySelector("b")!.textContent = p.assigner_name;
    card.appendChild(who);

    const name = document.createElement("div");
    name.className = "nt-name";
    name.textContent = p.name;
    card.appendChild(name);

    const chips = document.createElement("div");
    chips.className = "nt-chips";
    if (p.priority !== "none") {
      const prio = document.createElement("span");
      prio.className = "chip sm";
      prio.style.color = priorityColor(p.priority as any);
      prio.innerHTML = `${priorityIcon(p.priority as any)} ${PRIORITY_LABELS[p.priority] ?? p.priority}`;
      chips.appendChild(prio);
    }
    if (p.target_date) {
      const due = document.createElement("span");
      due.className = "chip sm";
      due.innerHTML = `${CALENDAR_ICON} ~ ${p.target_date}`;
      chips.appendChild(due);
    }
    if (chips.childElementCount > 0) card.appendChild(chips);

    const row = document.createElement("div");
    row.className = "ack-row";
    const ack = document.createElement("button");
    ack.className = "ack-btn";
    ack.textContent = "✓ 확인했습니다";
    ack.onclick = async () => {
      ack.disabled = true;
      try {
        await acknowledgeAssignment(p.project_id, p.item_id);
        // 목록 갱신은 백엔드가 emit하는 assignments-updated가 처리한다.
      } catch (err) {
        ack.disabled = false;
        synced.textContent = "확인 처리 실패: " + err;
        console.error("acknowledgeAssignment failed:", err);
      }
    };
    row.appendChild(ack);
    const open = document.createElement("button");
    open.className = "ack-ghost";
    open.textContent = "열기";
    open.onclick = () => openEditModal(p.project_id, p.item_id);
    row.appendChild(open);
    card.appendChild(row);

    inboxEl.appendChild(card);
  }
}

async function refreshInbox() {
  try {
    renderInbox(await getPendingAssignments());
  } catch (err) {
    console.error("getPendingAssignments failed:", err);
  }
}

// 새로고침 버튼과 백엔드의 refresh-sidebar 이벤트는 refreshIfStale()의
// 쿨다운을 거치지 않고 refresh()를 직접 부른다. 연속 편집/삭제나 버튼 연타로
// 여러 호출이 겹치면 프로젝트당 N+1 요청 묶음이 동시에 나가고, 응답 순서가
// 뒤바뀌면 최신 렌더가 옛 데이터로 되돌아갈 수 있다 — 진행 중인 요청이 있으면
// 새로 fetch하지 않고 완료 후 한 번만 더 돌게 합쳐(coalesce) 항상 순차 실행되게 한다.
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

function refresh(): Promise<void> {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = runRefresh().finally(() => {
    refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  });
  return refreshInFlight;
}

async function runRefresh() {
  lastRefreshAt = Date.now();
  synced.textContent = "동기화 중…";
  try {
    const s = await getSettings();
    sbTabsEl.hidden = !s.show_delegated_tab;
    // 탭이 목록 이름과 개수를 전담한다 — 탭이 보이는 동안 섹션 헤더를 두면
    // 같은 정보가 두 줄에 반복되므로 숨기고, 탭이 꺼져 있을 때만 되살린다.
    sectionHeadEl.hidden = s.show_delegated_tab;
    // 두 버튼 모두 지금 보이는 줄의 오른쪽 끝에 있어야 한다 — appendChild가
    // 노드를 옮기므로 양쪽에 버튼을 두 개 두고 동기화할 필요가 없다. 순서가
    // 곧 화면 순서이므로 축 버튼을 먼저 붙인다.
    const controlRow = s.show_delegated_tab ? sbTabsEl : sectionHeadEl;
    controlRow.appendChild(axisBtnEl);
    controlRow.appendChild(foldAllEl);
    if (!s.show_delegated_tab) activeTab = "assigned";
    syncTabButtons();
    baseUrl = s.base_url;
    workspace = s.workspace;
    themePref = s.theme;
    applyTheme(s.theme);
    const today = resolveDatePreset("today");
    const data: SidebarData = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    states = data.states;
    lastSidebarData = data;
    delegatedMemberNames = new Map(data.delegated_members.map((m) => [m.id, m.display_name]));
    renderFromLastData();
    if (groupAxis === "cycle") ensureCycleData();
    synced.textContent = offlineStatusText(data.is_cached, data.cached_at_ms, pendingCount, Date.now());
    refreshInbox();
  } catch (e) {
    const msg = typeof e === "string" ? e : ((e as any)?.message ?? JSON.stringify(e));
    synced.textContent = "동기화 실패: " + msg;
    synced.title = msg;
    console.error(e);
  }
}

function refreshIfStale() {
  if (!isWithinCooldown(lastRefreshAt, Date.now(), REFRESH_COOLDOWN_MS)) refresh();
}

document.getElementById("refresh")!.onclick = refresh;

document.getElementById("briefingBtn")!.onclick = () => {
  openBriefing().catch((e) => console.error("openBriefing failed:", e));
};

document.getElementById("openPlane")!.onclick = () => {
  if (!baseUrl) {
    synced.textContent = "설정에서 Base URL을 먼저 입력하세요";
    return;
  }
  openExternal(baseUrl);
};

// Manual update check: the result lands in the footer. When an update exists
// the backend opens its own confirm dialog instead of returning a message.
let updateCheckInFlight = false;
async function runUpdateCheck() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  synced.textContent = "업데이트 확인 중…";
  try {
    const msg = await checkUpdatesManual();
    synced.textContent = msg ?? "새 버전 안내를 확인하세요";
  } catch (err) {
    synced.textContent = "업데이트 확인 실패: " + err;
  } finally {
    updateCheckInFlight = false;
  }
}

// Persists the flipped theme as an explicit preference. Settings are re-read
// first so a toggle before the initial refresh cannot save an empty base_url
// over the stored one.
async function toggleTheme() {
  const next = toggledThemePref(themePref, window.matchMedia("(prefers-color-scheme: light)").matches);
  themePref = next;
  applyTheme(next);
  try {
    const s = await getSettings();
    await saveSettings(s.base_url, s.workspace, undefined, undefined, undefined, next, undefined);
  } catch (err) {
    synced.textContent = "테마 저장 실패: " + err;
  }
}

// Release notes panel: an overlay covering the whole sidebar, fed from this
// app's GitHub releases. Cached for the session — the list only changes when
// a release ships, and unauthenticated GitHub API calls are rate limited.
const notesPanel = document.getElementById("notesPanel")!;
const notesBody = document.getElementById("notesBody")!;
let cachedReleaseNotes: ReleaseNote[] | null = null;

function closeReleaseNotes() {
  notesPanel.hidden = true;
}

function notesStatus(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "notes-status";
  el.textContent = text;
  return el;
}

async function renderReleaseNotes(notes: ReleaseNote[]) {
  notesBody.innerHTML = "";
  if (notes.length === 0) {
    notesBody.appendChild(notesStatus("표시할 릴리즈가 없습니다"));
    return;
  }
  const current = await getVersion();
  for (const n of notes) {
    const item = document.createElement("div");
    item.className = "rn-item";

    const head = document.createElement("div");
    head.className = "rn-head";
    const ver = document.createElement("span");
    ver.className = "rn-ver";
    ver.textContent = "v" + n.version;
    head.appendChild(ver);
    const date = document.createElement("span");
    date.className = "rn-date";
    date.textContent = n.date;
    head.appendChild(date);
    if (n.version === current) {
      const badge = document.createElement("span");
      badge.className = "rn-badge";
      badge.textContent = "현재 버전";
      head.appendChild(badge);
    }
    item.appendChild(head);

    const body = document.createElement("div");
    body.innerHTML = n.notes ? notesToHtml(n.notes) : `<p class="rn-empty">(변경 내역 없음)</p>`;
    item.appendChild(body);

    notesBody.appendChild(item);
  }
}

async function openReleaseNotes() {
  notesPanel.hidden = false;
  if (cachedReleaseNotes) return;
  notesBody.innerHTML = "";
  notesBody.appendChild(notesStatus("릴리즈 노트 불러오는 중…"));
  try {
    const notes = await fetchReleaseNotes();
    cachedReleaseNotes = notes;
    await renderReleaseNotes(notes);
  } catch (err) {
    notesBody.innerHTML = "";
    notesBody.appendChild(notesStatus("릴리즈 노트를 불러오지 못했습니다: " + err));
    const retry = document.createElement("button");
    retry.className = "rn-retry";
    retry.textContent = "다시 시도";
    retry.onclick = () => openReleaseNotes();
    notesBody.appendChild(retry);
    console.error("fetchReleaseNotes failed:", err);
  }
}

document.getElementById("notesClose")!.onclick = closeReleaseNotes;

const MORE_MENU_WIDTH = 170;
const moreBtn = document.getElementById("moreMenu")!;

/** 켬/끔 상태를 가진 보기 설정 항목. 체크는 "선택"이 아니라 "켜져 있음"을
 *  뜻하므로 여러 줄이 동시에 체크될 수 있다. 다른 메뉴 항목과 달리 클릭해도
 *  메뉴를 닫지 않는다 — 보기 설정은 연달아 바꾸는 경우가 많다. */
function appendPopToggle(pop: HTMLElement, label: string, on: boolean, onToggle: () => void) {
  const item = document.createElement("div");
  item.className = "pop-item" + (on ? " on" : "");
  item.textContent = label;
  item.onclick = (e) => {
    e.stopPropagation();
    onToggle();
    item.classList.toggle("on");
  };
  pop.appendChild(item);
}

function appendDivider(pop: HTMLElement) {
  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);
}

function openMoreMenu() {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = MORE_MENU_WIDTH + "px";

  const viewHead = document.createElement("div");
  viewHead.className = "pop-head";
  viewHead.textContent = "보기 설정";
  pop.appendChild(viewHead);

  appendPopToggle(pop, "완료 항목 표시", !hideCompleted, () => {
    hideCompleted = !hideCompleted;
    localStorage.setItem(HIDE_DONE_KEY, hideCompleted ? "1" : "0");
    renderTasks(lastItems, lastProjects);
  });
  // 담당 탭은 항상 "오늘" 기준으로 좁혀 보여주므로 이 설정이 없다 —
  // 기간 전체 보기는 위임 탭에만 있는 선택지다.
  if (activeTab === "delegated") {
    appendPopToggle(pop, "기한 무관 전체 보기", delegatedShowAll, () => {
      delegatedShowAll = !delegatedShowAll;
      localStorage.setItem(DELEGATED_SHOW_ALL_KEY, delegatedShowAll ? "1" : "0");
      // 목록뿐 아니라 탭 개수도 이 설정에 따라 달라지므로 둘 다 다시 그린다.
      renderFromLastData();
    });
  }
  appendDivider(pop);

  const pinItem = document.createElement("div");
  pinItem.className = "pop-item" + (pinned ? " sel" : "");
  pinItem.textContent = "고정";
  pinItem.title = pinned
    ? "고정됨 — 클릭하면 다른 창 활성화 시 자동으로 닫힙니다"
    : "고정 — 다른 창이 활성화돼도 사이드바를 열어둡니다";
  pinItem.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    pinned = !pinned;
  };
  pop.appendChild(pinItem);

  appendPopItem(pop, "업데이트 확인", () => runUpdateCheck());
  appendPopItem(pop, "릴리즈 노트", () => openReleaseNotes());
  appendPopItem(pop, "설정", () => openSettings());
  appendPopItem(pop, "다크/라이트 전환", () => toggleTheme());

  appendDivider(pop);

  const ver = document.createElement("div");
  ver.className = "pop-version";
  getVersion().then((v) => {
    ver.textContent = `Plane Quick Dock v${v}`;
  });
  pop.appendChild(ver);

  const rect = moreBtn.getBoundingClientRect();
  attachPopover(pop, rect.right - MORE_MENU_WIDTH, rect.bottom + 6);
}

moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (openPopover) {
    closePopover();
    return;
  }
  openMoreMenu();
});

conflictBadgeEl.onclick = () => {
  openConflictWindow().catch((err) => console.error("openConflictWindow failed:", err));
};

document.getElementById("collapseTab")!.onclick = (e) => {
  e.stopPropagation();
  hideSidebar();
};

document.addEventListener("click", (e) => {
  const hadPopover = openPopover !== null;
  closePopover();
  // The transparent strip beside the panel still belongs to this window, so a
  // click there never reaches the app underneath and never fires tauri://blur.
  // Treat it as "clicked outside the sidebar" and close, which is what the user
  // means by clicking next to the panel — but let a first click merely dismiss
  // an open popover, matching how clicking inside the panel behaves.
  if (!hadPopover && e.target === document.body) hideSidebar();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
    } else if (!notesPanel.hidden) {
      closeReleaseNotes();
    } else if (!searchBar.hidden) {
      closeSearch();
    } else {
      hideSidebar();
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
  }
});
win.listen("tauri://focus", refreshIfStale);
win.listen("refresh-sidebar", refresh);
win.listen("item-updated", (e) => applyItemChange(e.payload as ItemChange));
win.listen("item-deleted", (e) => removeItemLocally((e.payload as { item_id: string }).item_id));
win.listen("assignments-updated", refreshInbox);
win.listen("offline-queue-changed", (e) => {
  pendingCount = (e.payload as { pending: number }).pending;
  synced.textContent = offlineStatusText(false, null, pendingCount, Date.now());
});
win.listen("offline-conflicts-changed", (e) => {
  conflictCount = (e.payload as { count: number }).count;
  renderConflictBadge();
});
win.listen("tauri://blur", () => {
  if (!pinned && !autoOpened) hideSidebar();
});
win.listen("toggle-sidebar", () => {
  toggleSidebar();
});
// 백엔드 유휴 워처(spawn_idle_watcher)가 보내는 열기 전용 이벤트.
// toggle과 달리 이미 열려 있으면 아무것도 하지 않는다 — 폴링이 토글로
// 이어지면 열려 있던 사이드바를 닫아 버릴 수 있어서 이벤트를 분리했다.
win.listen("open-sidebar", async () => {
  if (await win.isVisible()) return;
  autoOpened = true;
  await showSidebar(false);
  // 포커스 없이 열었으니 tauri://focus 기반 갱신이 안 돈다 — 직접 갱신.
  refreshIfStale();
});
// 입력 재개(폴링 5초 이내 감지) — 자동 열림 보호 해제.
win.listen("idle-ended", () => {
  autoOpened = false;
});
// 사이드바를 직접 조작하기 시작하면 idle-ended 폴링을 기다리지 않고 즉시 해제.
document.addEventListener("pointerdown", () => {
  autoOpened = false;
}, true);
getOfflineStatus().then((s) => { pendingCount = s.pending; }).catch(() => {});
getConflicts().then((cs) => {
  conflictCount = cs.length;
  renderConflictBadge();
}).catch(() => {});
refresh();
refreshInbox();
