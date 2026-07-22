import type { Cycle, Project, ProjectState, WorkItem } from "../shared/types";

export interface ProjectGroup {
  project: Project;
  items: WorkItem[];
}

const STATE_ORDER: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, cancelled: 3, completed: 4 };
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Compares `null` last, otherwise lexicographically — correct for ISO date/timestamp strings. */
function compareNullableIso(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

/** Sort order within a project group: state (started → unstarted → backlog → cancelled →
 *  completed), then priority (urgent → none), then due date (missing last), then creation
 *  time (oldest first). Unknown state/priority values sort last within their tier. */
export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  return (
    (STATE_ORDER[a.state_group] ?? 9) - (STATE_ORDER[b.state_group] ?? 9) ||
    (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
    compareNullableIso(a.target_date, b.target_date) ||
    compareNullableIso(a.created_at, b.created_at)
  );
}

/** Groups assigned items by project, ordered to match `projects`. Projects with no items are omitted.
 *  Within a group, items are ordered by `compareWorkItems` (stable — ties keep input order). */
export function groupItemsByProject(items: WorkItem[], projects: Project[]): ProjectGroup[] {
  const byProject = new Map<string, WorkItem[]>();
  for (const it of items) {
    const list = byProject.get(it.project_id);
    if (list) list.push(it);
    else byProject.set(it.project_id, [it]);
  }
  const groups: ProjectGroup[] = [];
  for (const project of projects) {
    const groupItems = byProject.get(project.id);
    if (groupItems && groupItems.length > 0) {
      const sorted = [...groupItems].sort(compareWorkItems);
      groups.push({ project, items: sorted });
    }
  }
  return groups;
}

/** True when `item` is completed and its completion instant falls on `now`'s local calendar date.
 *  `completed_at` is a UTC timestamp from Plane; `Date` converts it to local time correctly, so this
 *  is the precise "is this actually today" check — unlike the server's coarse UTC-date-window prefilter. */
export function isCompletedToday(item: WorkItem, now: Date = new Date()): boolean {
  if (item.state_group !== "completed" || !item.completed_at) return false;
  const completed = new Date(item.completed_at);
  if (Number.isNaN(completed.getTime())) return false;
  return (
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate()
  );
}

/** Keeps open items plus items completed today (local time). Apply this to the server's response,
 *  which only guarantees completed items fall within a coarse UTC-date window around today. */
export function filterVisibleToday(items: WorkItem[], now: Date = new Date()): WorkItem[] {
  return items.filter((it) => it.state_group !== "completed" || isCompletedToday(it, now));
}

export type SidebarTab = "assigned" | "delegated";

/** The items a tab actually shows. Both the tab's count badge and the rendered list go
 *  through this, so they can't disagree — the delegated count used to ignore the
 *  "기한 무관 전체 보기" setting and reported more items than the list displayed.
 *  The assigned tab is always scoped to today; only the delegated tab can widen. */
export function visibleTabItems(
  tab: SidebarTab,
  data: { assigned: WorkItem[]; delegated: WorkItem[] },
  showAllDelegated: boolean,
  now: Date = new Date(),
): WorkItem[] {
  if (tab === "assigned") return filterVisibleToday(data.assigned, now);
  return showAllDelegated ? data.delegated : filterVisibleToday(data.delegated, now);
}

/** Drops completed items when `hide` is on; otherwise returns `items` unchanged.
 *  Applied per group at render time so the progress ring still counts hidden items. */
export function filterHiddenCompleted(items: WorkItem[], hide: boolean): WorkItem[] {
  if (!hide) return items;
  return items.filter((it) => it.state_group !== "completed");
}

/** Formats a UTC timestamp as a local "오전/오후 H:MM" string. Manual (no Intl) so it's locale-independent. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h24 = d.getHours();
  const period = h24 < 12 ? "오전" : "오후";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${period} ${h12}:${mm}`;
}

export function resolveStateId(states: ProjectState[], projectId: string, group: string): string | undefined {
  const matches = states.filter((s) => s.project_id === projectId && s.group === group);
  return (matches.find((s) => s.default) ?? matches[0])?.id;
}

/** Builds the web URL for a Plane issue, matching the format used to open issues in the browser. */
export function buildIssueUrl(baseUrl: string, workspace: string, projectId: string, itemId: string): string {
  return `${baseUrl}/${workspace}/projects/${projectId}/issues/${itemId}`;
}

export interface SidebarGeometry {
  width: number;
  height: number;
  /** x position (physical px), anchored to the right edge. */
  visibleX: number;
  /** y position (physical px), anchored to the target monitor's own top edge. */
  y: number;
}

/** Computes the sidebar's geometry for a monitor of the given physical size and scale
 *  factor. `originX`/`originY` are the monitor's absolute position in the virtual desktop (0 for a
 *  monitor at the origin) — without them the panel lands wherever that monitor's local width happens
 *  to fall in absolute screen coordinates, which is wrong for any non-primary monitor. */
export function computeSidebarGeometry(
  screenWidth: number,
  screenHeight: number,
  scaleFactor: number,
  panelWidthLogical: number,
  originX = 0,
  originY = 0,
): SidebarGeometry {
  const width = Math.round(panelWidthLogical * scaleFactor);
  return {
    width,
    height: screenHeight,
    visibleX: originX + screenWidth - width,
    y: originY,
  };
}

/** "2026-07-01" → "7/1". null/malformed → "". */
function monthDay(iso: string | null): string {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!m || !d) return "";
  return `${m}/${d}`;
}

/** Compact date-range label for a task chip: "7/1 → 7/4", "~ 7/8" (due only),
 *  "7/1 →" (start only), or "" when neither date is set. */
export function formatDateRange(start: string | null, target: string | null): string {
  const s = monthDay(start);
  const t = monthDay(target);
  if (s && t) return `${s} → ${t}`;
  if (t) return `~ ${t}`;
  if (s) return `${s} →`;
  return "";
}

/** Completed-vs-total counts for a project group's progress ring. */
export function groupProgress(items: WorkItem[]): { done: number; total: number } {
  const done = items.filter((i) => i.state_group === "completed").length;
  return { done, total: items.length };
}

/** True when `item`'s own name matches `query`, or its project's name does (case-insensitive
 *  substring). A matching project name pulls in every item under that project, not just ones
 *  whose own title also matches — searching a project surfaces its whole backlog. */
export function filterBySearch(items: WorkItem[], projects: Project[], query: string): WorkItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const projectNameById = new Map(projects.map((p) => [p.id, p.name.toLowerCase()]));
  return items.filter((it) => {
    if (it.name.toLowerCase().includes(q)) return true;
    return (projectNameById.get(it.project_id) ?? "").includes(q);
  });
}

/** Keeps only items in the given state group; `null` returns `items` unchanged. */
export function filterByStateGroup(items: WorkItem[], group: string | null): WorkItem[] {
  if (!group) return items;
  return items.filter((it) => it.state_group === group);
}

/** Keeps only items with the given priority; `null` returns `items` unchanged. */
export function filterByPriority(items: WorkItem[], priority: string | null): WorkItem[] {
  if (!priority) return items;
  return items.filter((it) => it.priority === priority);
}

/** unix ms 타임스탬프를 "방금 전"/"N분 전"/"N시간 전"/"N일 전"으로. */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs;
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

/** 사이드바 footer에 보여줄 동기화 상태 문구. 대기 중인 변경이 있으면
 *  그것부터 보여주고(가장 실용적인 정보), 없으면 캐시 여부에 따라
 *  오프라인/정상 동기화 문구를 고른다. */
export function offlineStatusText(
  isCached: boolean,
  cachedAtMs: number | null,
  pending: number,
  now: number,
): string {
  if (pending > 0) return `동기화 대기 ${pending}건`;
  if (isCached && cachedAtMs != null) {
    const d = new Date(cachedAtMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `오프라인 · 마지막 동기화 ${hh}:${mm}`;
  }
  return "동기화 완료";
}

/** `delegated_members`로 만든 id→이름 맵에서 담당자 이름을 찾는다. 맵에
 *  없는 id(예: 멤버가 프로젝트에서 제외된 경우)는 "알 수 없음"으로 폴백한다. */
export function resolveAssigneeName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? "알 수 없음";
}

/** 사이드바 폭의 허용 범위와 기본값. 기본 352는 예전 320보다 10% 넓다 —
 *  사이클 하위 묶음이 가이드선과 들여쓰기로 쓰는 가로 공간을 되돌려준다. */
export const SIDEBAR_WIDTH_MIN = 300;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_DEFAULT = 352;

/** 저장된/드래그 중인 폭을 허용 범위로 자른다. 작은 화면에서 사이드바가 화면
 *  절반을 넘게 덮지 않도록 상한이 모니터 논리 폭의 절반까지 줄어들지만,
 *  하한(300)은 언제나 보장한다 — 아주 좁은 모니터에서 상한이 하한 아래로
 *  내려가면 폭이 0에 수렴해 사이드바가 사실상 사라진다. */
export function clampSidebarWidth(width: number, monitorLogicalWidth: number): number {
  const max = Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, Math.floor(monitorLogicalWidth / 2)),
  );
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, width)));
}

/** 프로젝트 그룹 안에서 작업을 어떤 기준으로 다시 묶을지. "flat"이 기본이며
 *  지금까지의 화면과 같다. 모듈은 작업당 여러 개에 속할 수 있어 중복 규칙을
 *  따로 정해야 하므로 다음 단계로 미뤄져 있다. */
export type GroupAxis = "flat" | "cycle";

export interface SubGroup {
  /** 접힘 상태 키. `cycle:` 접두어를 붙여 프로젝트 id와 한 Set에서 섞이지 않게 한다. */
  key: string;
  name: string;
  /** "D-3" / "7/28 시작" / "7/12 종료". 날짜가 없으면 null. */
  due: string | null;
  dueKind: "soon" | "plain" | "past" | null;
  /** 사이클이 없는 작업을 모은 묶음이면 true — 더 흐리게 그린다. */
  ghost: boolean;
  items: WorkItem[];
}

/** ISO 날짜/타임스탬프를 로컬 달력 날짜(자정)로 읽는다. Plane은 프로젝트
 *  타임존 기준 날짜를 UTC로 저장해 내려주므로 문자열을 앞 10자로 자르면
 *  타임존에 따라 하루가 어긋난다 — isCompletedToday와 같이 Date로 변환해
 *  로컬 게터를 쓴다. */
function localDateOf(iso: string | null): Date | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 자정 기준 두 Date 사이의 날짜 수. */
function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** 한 프로젝트의 작업을 사이클별로 쪼갠다. 묶음이 하나뿐이면 빈 배열을
 *  돌려주고 호출부는 지금처럼 평평하게 그린다 — 사이클을 안 쓰는 프로젝트에
 *  "사이클 없음" 헤더 한 줄만 덧붙는 건 노이즈다.
 *
 *  순서는 진행 중 → 날짜 미정 → 예정 → 지난 → 사이클 없음. 진행 중은 종료가
 *  임박한 순, 예정은 시작이 이른 순, 지난 것은 최근 종료 순이다. 내 작업이
 *  하나도 없는 사이클은 묶음으로 만들지 않는다. */
export function splitByCycle(
  items: WorkItem[],
  cycles: Cycle[],
  itemCycle: Map<string, string>,
  now: Date = new Date(),
): SubGroup[] {
  const today = startOfDay(now);
  const byCycle = new Map<string, WorkItem[]>();
  const orphans: WorkItem[] = [];
  for (const it of items) {
    const cid = itemCycle.get(it.id);
    if (!cid) {
      orphans.push(it);
      continue;
    }
    const list = byCycle.get(cid);
    if (list) list.push(it);
    else byCycle.set(cid, [it]);
  }

  const ranked: { phase: number; sortKey: number; name: string; group: SubGroup }[] = [];
  for (const c of cycles) {
    const its = byCycle.get(c.id);
    if (!its || its.length === 0) continue;
    const start = localDateOf(c.start_date);
    const end = localDateOf(c.end_date);
    let phase: number;
    let sortKey: number;
    let due: string | null;
    let dueKind: SubGroup["dueKind"];
    if (!start || !end) {
      phase = 1; sortKey = 0; due = null; dueKind = null;
    } else if (start > today) {
      phase = 2; sortKey = start.getTime();
      due = `${start.getMonth() + 1}/${start.getDate()} 시작`; dueKind = "plain";
    } else if (end < today) {
      phase = 3; sortKey = -end.getTime();
      due = `${end.getMonth() + 1}/${end.getDate()} 종료`; dueKind = "past";
    } else {
      const left = dayDiff(today, end);
      phase = 0; sortKey = end.getTime();
      due = `D-${left}`; dueKind = left <= 3 ? "soon" : "plain";
    }
    ranked.push({
      phase, sortKey, name: c.name,
      group: { key: `cycle:${c.id}`, name: c.name, due, dueKind, ghost: false, items: its },
    });
  }
  ranked.sort(
    (a, b) =>
      a.phase - b.phase ||
      a.sortKey - b.sortKey ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const groups = ranked.map((r) => r.group);
  if (orphans.length > 0) {
    groups.push({
      key: "cycle:none", name: "사이클 없음",
      due: null, dueKind: null, ghost: true, items: orphans,
    });
  }
  return groups.length > 1 ? groups : [];
}
