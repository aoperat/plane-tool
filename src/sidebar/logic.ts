import type { Project, ProjectState, WorkItem } from "../shared/types";

export interface ProjectGroup {
  project: Project;
  items: WorkItem[];
}

/** Groups assigned items by project, ordered to match `projects`. Projects with no items are omitted.
 *  Within a group, completed items sink to the bottom (stable — otherwise preserving input order). */
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
      const sorted = [...groupItems].sort(
        (a, b) => Number(a.state_group === "completed") - Number(b.state_group === "completed"),
      );
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
  /** x position (physical px) when fully slid in, anchored to the right edge. */
  visibleX: number;
  /** x position (physical px) when fully slid out, just past the right edge. */
  hiddenX: number;
}

/** Computes the sidebar's slide-in/out geometry for a monitor of the given physical size and scale factor. */
export function computeSidebarGeometry(
  screenWidth: number,
  screenHeight: number,
  scaleFactor: number,
  panelWidthLogical: number,
): SidebarGeometry {
  const width = Math.round(panelWidthLogical * scaleFactor);
  return { width, height: screenHeight, visibleX: screenWidth - width, hiddenX: screenWidth };
}

/** Eases a slide animation's progress (0..1) so it decelerates into place. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}
