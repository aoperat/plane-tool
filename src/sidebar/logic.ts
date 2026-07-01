import type { ProjectState, WorkItem } from "../shared/types";

export function countAssignedByProject(items: WorkItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    counts[it.project_id] = (counts[it.project_id] ?? 0) + 1;
  }
  return counts;
}

export function resolveStateId(states: ProjectState[], projectId: string, group: string): string | undefined {
  const matches = states.filter((s) => s.project_id === projectId && s.group === group);
  return (matches.find((s) => s.default) ?? matches[0])?.id;
}
