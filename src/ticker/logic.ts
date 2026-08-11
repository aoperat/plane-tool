import { priorityLabel } from "../shared/planeIcons";
import type { ItemChange, Project, WorkItem } from "../shared/types";

export type TickerBucket = "overdue" | "today" | "started" | "remaining";

export interface TickerItem {
  item: WorkItem;
  projectName: string;
  bucket: TickerBucket;
  meta: string;
}

const BUCKET_ORDER: Record<TickerItem["bucket"], number> = {
  overdue: 0,
  today: 1,
  started: 2,
  remaining: 3,
};

function datePrefix(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function compareDueDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

function priorityMeta(priority: string): string | null {
  switch (priority) {
    case "urgent":
    case "high":
    case "medium":
    case "low":
      return priorityLabel(priority);
    default:
      return null;
  }
}

export function itemChangeNeedsAssignedRefresh(change: ItemChange): boolean {
  return change.assignee_ids !== undefined;
}

export function buildTickerItems(items: WorkItem[], projects: Project[], today: string): TickerItem[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const ranked: Array<{ ticker: TickerItem; dueDate: string | null; inputIndex: number }> = [];

  items.forEach((item, inputIndex) => {
    if (item.state_group === "completed" || item.state_group === "cancelled") return;

    const dueDate = datePrefix(item.target_date);
    let bucket: TickerItem["bucket"];
    let meta: string;
    if (dueDate != null && dueDate < today) {
      bucket = "overdue";
      meta = "지연";
    } else if (dueDate === today) {
      bucket = "today";
      meta = "오늘 마감";
    } else if (item.state_group === "started") {
      bucket = "started";
      meta = "진행 중";
    } else {
      bucket = "remaining";
      meta = priorityMeta(item.priority) ?? dueDate ?? "기한 없음";
    }

    ranked.push({
      ticker: {
        item,
        projectName: projectNames.get(item.project_id) ?? "알 수 없는 프로젝트",
        bucket,
        meta,
      },
      dueDate,
      inputIndex,
    });
  });

  ranked.sort(
    (a, b) =>
      BUCKET_ORDER[a.ticker.bucket] - BUCKET_ORDER[b.ticker.bucket] ||
      compareDueDate(a.dueDate, b.dueDate) ||
      a.inputIndex - b.inputIndex,
  );
  return ranked.map(({ ticker }) => ticker);
}

function normalizedIndex(index: number, length: number): number {
  const truncated = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((truncated % length) + length) % length;
}

export function reconcileTickerIndex(items: TickerItem[], currentId: string | null, oldIndex: number): number {
  if (items.length === 0) return 0;
  if (currentId !== null) {
    const currentIndex = items.findIndex(({ item }) => item.id === currentId);
    if (currentIndex >= 0) return currentIndex;
  }
  const index = Number.isFinite(oldIndex) ? Math.trunc(oldIndex) : 0;
  return Math.max(0, Math.min(items.length - 1, index));
}

export function previousTickerIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (normalizedIndex(index, length) - 1 + length) % length;
}

export function nextTickerIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (normalizedIndex(index, length) + 1) % length;
}
