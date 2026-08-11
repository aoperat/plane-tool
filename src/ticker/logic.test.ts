import { describe, expect, it } from "vitest";
import type { Project, WorkItem } from "../shared/types";
import {
  buildTickerItems,
  nextTickerIndex,
  previousTickerIndex,
  reconcileTickerIndex,
} from "./logic";

function item(
  id: string,
  overrides: Partial<WorkItem> = {},
): WorkItem {
  return {
    id,
    name: `작업 ${id}`,
    priority: "none",
    target_date: null,
    start_date: null,
    state_group: "backlog",
    project_id: "p1",
    assignee_ids: [],
    completed_at: null,
    created_at: null,
    ...overrides,
  };
}

function project(id: string, name = `프로젝트 ${id}`): Project {
  return { id, name, identifier: id.toUpperCase() };
}

describe("buildTickerItems", () => {
  it("excludes completed and cancelled items", () => {
    const items = [
      item("open"),
      item("done", { state_group: "completed" }),
      item("cancelled", { state_group: "cancelled" }),
    ];

    expect(buildTickerItems(items, [project("p1")], "2026-08-11").map((entry) => entry.item.id)).toEqual([
      "open",
    ]);
  });

  it("uses exclusive overdue, today, started, then remaining precedence", () => {
    const items = [
      item("overdue-started", { state_group: "started", target_date: "2026-08-10" }),
      item("today-started", { state_group: "started", target_date: "2026-08-11" }),
      item("started-future", { state_group: "started", target_date: "2026-08-12" }),
      item("remaining-future", { target_date: "2026-08-12" }),
      item("remaining-undated"),
    ];

    expect(buildTickerItems(items, [project("p1")], "2026-08-11").map((entry) => [entry.item.id, entry.bucket, entry.meta])).toEqual([
      ["overdue-started", "overdue", "지연"],
      ["today-started", "today", "오늘 마감"],
      ["started-future", "started", "진행 중"],
      ["remaining-future", "remaining", "2026-08-12"],
      ["remaining-undated", "remaining", "기한 없음"],
    ]);
  });

  it("sorts by bucket and due date, preserving stable ties and falling back for missing projects", () => {
    const items = [
      item("remaining-undated", { project_id: "missing" }),
      item("remaining-late", { target_date: "2026-08-20" }),
      item("remaining-early", { target_date: "2026-08-12" }),
      item("remaining-tie-a", { target_date: "2026-08-15" }),
      item("remaining-tie-b", { target_date: "2026-08-15" }),
    ];

    const entries = buildTickerItems(items, [project("p1")], "2026-08-11");
    expect(entries.map((entry) => entry.item.id)).toEqual([
      "remaining-early",
      "remaining-tie-a",
      "remaining-tie-b",
      "remaining-late",
      "remaining-undated",
    ]);
    expect(entries[4].projectName).toBe("알 수 없는 프로젝트");
  });
});

describe("ticker navigation", () => {
  it("wraps navigation and returns zero for an empty list", () => {
    expect(previousTickerIndex(0, 3)).toBe(2);
    expect(previousTickerIndex(1, 3)).toBe(0);
    expect(nextTickerIndex(2, 3)).toBe(0);
    expect(nextTickerIndex(1, 3)).toBe(2);
    expect(previousTickerIndex(0, 0)).toBe(0);
    expect(nextTickerIndex(0, 0)).toBe(0);
  });

  it("preserves the current ID and clamps a removed ID's old index", () => {
    const items = [item("a"), item("b"), item("c")].map((workItem) => ({
      item: workItem,
      projectName: "프로젝트 p1",
      bucket: "remaining" as const,
      meta: "기한 없음",
    }));

    expect(reconcileTickerIndex(items, "b", 0)).toBe(1);
    expect(reconcileTickerIndex(items.slice(0, 2), "c", 2)).toBe(1);
    expect(reconcileTickerIndex(items.slice(0, 2), "c", -4)).toBe(0);
    expect(reconcileTickerIndex([], "a", 1)).toBe(0);
  });
});
