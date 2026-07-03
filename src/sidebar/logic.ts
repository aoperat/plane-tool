import type { Project, ProjectState, WorkItem } from "../shared/types";

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

/** unix ms 타임스탬프를 "방금 전"/"N분 전"/"N시간 전"/"N일 전"으로. */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs;
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}
