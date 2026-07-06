import { describe, it, expect } from "vitest";
import { buildIssueUrl, computeSidebarGeometry, filterHiddenCompleted, filterVisibleToday, formatDateRange, formatLocalTime, formatRelativeTime, groupItemsByProject, groupProgress, isCompletedToday, offlineStatusText, resolveStateId } from "./logic";
import type { Project, ProjectState, WorkItem } from "../shared/types";

function wi(id: string, project_id: string, state_group = "started"): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, start_date: null, state_group, project_id, completed_at: null, created_at: null };
}
function wiCompleted(id: string, project_id: string, completed_at: string | null): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, start_date: null, state_group: "completed", project_id, completed_at, created_at: null };
}
function wiSort(id: string, over: Partial<WorkItem>): WorkItem {
  return { ...wi(id, "p1"), ...over };
}
function st(id: string, group: string, project_id: string, isDefault = false): ProjectState {
  return { id, group, project_id, default: isDefault };
}
function pr(id: string, name = "p" + id): Project {
  return { id, name, identifier: id.toUpperCase() };
}

describe("groupItemsByProject", () => {
  it("groups items and orders groups to match the projects list", () => {
    const projects = [pr("p2"), pr("p1")];
    const items = [wi("a", "p1"), wi("b", "p2"), wi("c", "p1")];
    const groups = groupItemsByProject(items, projects);
    expect(groups.map((g) => g.project.id)).toEqual(["p2", "p1"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["b"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("preserves item order within a group", () => {
    const projects = [pr("p1")];
    const items = [wi("c", "p1"), wi("a", "p1"), wi("b", "p1")];
    const groups = groupItemsByProject(items, projects);
    expect(groups[0].items.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("sinks completed items to the bottom of their group, preserving relative order otherwise", () => {
    const projects = [pr("p1")];
    const items = [
      wi("a", "p1", "completed"),
      wi("b", "p1", "started"),
      wi("c", "p1", "completed"),
      wi("d", "p1", "backlog"),
    ];
    const groups = groupItemsByProject(items, projects);
    expect(groups[0].items.map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("omits projects with no assigned items", () => {
    const projects = [pr("p1"), pr("p2")];
    const groups = groupItemsByProject([wi("a", "p1")], projects);
    expect(groups.map((g) => g.project.id)).toEqual(["p1"]);
  });

  it("ignores items whose project isn't in the projects list", () => {
    const groups = groupItemsByProject([wi("a", "missing")], [pr("p1")]);
    expect(groups).toEqual([]);
  });

  it("returns an empty array for no items", () => {
    expect(groupItemsByProject([], [pr("p1")])).toEqual([]);
  });

  it("orders items by state group: started, unstarted, backlog, cancelled, completed", () => {
    const items = [
      wiSort("done", { state_group: "completed" }),
      wiSort("todo", { state_group: "unstarted" }),
      wiSort("cancel", { state_group: "cancelled" }),
      wiSort("doing", { state_group: "started" }),
      wiSort("back", { state_group: "backlog" }),
    ];
    const groups = groupItemsByProject(items, [pr("p1")]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["doing", "todo", "back", "cancel", "done"]);
  });

  it("orders same-state items by priority: urgent, high, medium, low, none", () => {
    const items = [
      wiSort("n", { priority: "none" }),
      wiSort("m", { priority: "medium" }),
      wiSort("u", { priority: "urgent" }),
      wiSort("l", { priority: "low" }),
      wiSort("h", { priority: "high" }),
    ];
    const groups = groupItemsByProject(items, [pr("p1")]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["u", "h", "m", "l", "n"]);
  });

  it("orders same-state same-priority items by due date, missing dates last", () => {
    const items = [
      wiSort("none", { target_date: null }),
      wiSort("late", { target_date: "2026-07-20" }),
      wiSort("soon", { target_date: "2026-07-05" }),
    ];
    const groups = groupItemsByProject(items, [pr("p1")]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["soon", "late", "none"]);
  });

  it("breaks remaining ties by creation time, oldest first, missing last", () => {
    const items = [
      wiSort("unknown", { created_at: null }),
      wiSort("newer", { created_at: "2026-07-02T09:00:00Z" }),
      wiSort("older", { created_at: "2026-06-28T09:00:00Z" }),
    ];
    const groups = groupItemsByProject(items, [pr("p1")]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["older", "newer", "unknown"]);
  });

  it("applies state before priority and priority before dates", () => {
    const items = [
      wiSort("backlog-urgent", { state_group: "backlog", priority: "urgent" }),
      wiSort("started-none-due", { priority: "none", target_date: "2026-07-04" }),
      wiSort("started-high", { priority: "high" }),
    ];
    const groups = groupItemsByProject(items, [pr("p1")]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["started-high", "started-none-due", "backlog-urgent"]);
  });
});

describe("computeSidebarGeometry", () => {
  it("anchors the panel to the right edge at 1x scale", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 1600, y: 0 });
  });

  it("scales the panel width by the monitor's scale factor", () => {
    const geo = computeSidebarGeometry(3840, 2160, 2, 320);
    expect(geo.width).toBe(640);
    expect(geo.visibleX).toBe(3200);
  });

  it("adds the monitor's absolute x position as an offset", () => {
    // A second monitor placed to the right of a 1920-wide primary monitor.
    const geo = computeSidebarGeometry(1920, 1080, 1, 320, 1920, 0);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 3520, y: 0 });
  });

  it("defaults the offset to 0 when omitted", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320);
    expect(geo.visibleX).toBe(1600);
    expect(geo.y).toBe(0);
  });

  it("carries the vertical offset through to y", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320, 0, 200);
    expect(geo.y).toBe(200);
  });
});

describe("isCompletedToday", () => {
  it("is true when completed_at falls on now's local calendar date, even late in the day", () => {
    const now = new Date(2026, 6, 1, 8, 0, 0); // local 2026-07-01 08:00
    const completedAt = new Date(2026, 6, 1, 23, 30, 0).toISOString(); // same local day, later
    expect(isCompletedToday(wiCompleted("a", "p1", completedAt), now)).toBe(true);
  });

  it("is false when completed_at falls on a different local calendar date", () => {
    const now = new Date(2026, 6, 1, 8, 0, 0); // local 2026-07-01
    const completedAt = new Date(2026, 5, 30, 23, 0, 0).toISOString(); // local 2026-06-30
    expect(isCompletedToday(wiCompleted("a", "p1", completedAt), now)).toBe(false);
  });

  it("is false for non-completed items even with a completed_at set", () => {
    const now = new Date(2026, 6, 1, 8, 0, 0);
    const item = { ...wiCompleted("a", "p1", now.toISOString()), state_group: "started" };
    expect(isCompletedToday(item, now)).toBe(false);
  });

  it("is false when completed_at is missing", () => {
    expect(isCompletedToday(wiCompleted("a", "p1", null))).toBe(false);
  });

  it("is false when completed_at can't be parsed", () => {
    expect(isCompletedToday(wiCompleted("a", "p1", "not-a-date"))).toBe(false);
  });
});

describe("filterVisibleToday", () => {
  it("keeps open items and drops completed items from a different local day", () => {
    const now = new Date(2026, 6, 1, 8, 0, 0);
    const items = [
      wi("a", "p1", "started"),
      wiCompleted("b", "p1", new Date(2026, 6, 1, 1, 0, 0).toISOString()), // today
      wiCompleted("c", "p1", new Date(2026, 5, 30, 1, 0, 0).toISOString()), // yesterday
    ];
    const visible = filterVisibleToday(items, now);
    expect(visible.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("filterHiddenCompleted", () => {
  it("drops completed items when hiding is on", () => {
    const items = [wi("a", "p1", "started"), wi("b", "p1", "completed"), wi("c", "p1", "backlog")];
    expect(filterHiddenCompleted(items, true).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("returns items unchanged when hiding is off", () => {
    const items = [wi("a", "p1", "started"), wi("b", "p1", "completed")];
    expect(filterHiddenCompleted(items, false)).toBe(items);
  });
});

describe("formatLocalTime", () => {
  it("formats an afternoon time with the 오후 marker and zero-padded minutes", () => {
    const iso = new Date(2026, 6, 1, 15, 4, 0).toISOString();
    expect(formatLocalTime(iso)).toBe("오후 3:04");
  });

  it("formats a morning time with the 오전 marker", () => {
    const iso = new Date(2026, 6, 1, 9, 30, 0).toISOString();
    expect(formatLocalTime(iso)).toBe("오전 9:30");
  });

  it("formats midnight as 오전 12", () => {
    const iso = new Date(2026, 6, 1, 0, 0, 0).toISOString();
    expect(formatLocalTime(iso)).toBe("오전 12:00");
  });

  it("formats noon as 오후 12", () => {
    const iso = new Date(2026, 6, 1, 12, 0, 0).toISOString();
    expect(formatLocalTime(iso)).toBe("오후 12:00");
  });

  it("returns an empty string for an unparsable timestamp", () => {
    expect(formatLocalTime("not-a-date")).toBe("");
  });
});

describe("resolveStateId", () => {
  const states = [st("s1", "backlog", "p1"), st("s2", "started", "p1"), st("s3", "started", "p2")];

  it("finds the state id matching project and group", () => {
    expect(resolveStateId(states, "p1", "started")).toBe("s2");
  });
  it("returns undefined when no state matches", () => {
    expect(resolveStateId(states, "p1", "completed")).toBeUndefined();
  });
  it("uses the first match when a project has duplicate states in a group and none is default", () => {
    const dup = [...states, st("s4", "started", "p1")];
    expect(resolveStateId(dup, "p1", "started")).toBe("s2");
  });
  it("prefers the state flagged default over the first match", () => {
    const dup = [st("s5", "started", "p1"), st("s6", "started", "p1", true)];
    expect(resolveStateId(dup, "p1", "started")).toBe("s6");
  });
});

describe("buildIssueUrl", () => {
  it("joins base url, workspace, project id and item id into a Plane issue url", () => {
    expect(buildIssueUrl("https://plane.example.com", "acme", "p1", "i1")).toBe(
      "https://plane.example.com/acme/projects/p1/issues/i1",
    );
  });
});

describe("formatDateRange", () => {
  it("formats both dates as M/D → M/D", () => {
    expect(formatDateRange("2026-07-01", "2026-07-04")).toBe("7/1 → 7/4");
  });
  it("formats target-only as ~ M/D", () => {
    expect(formatDateRange(null, "2026-07-08")).toBe("~ 7/8");
  });
  it("formats start-only as M/D →", () => {
    expect(formatDateRange("2026-07-01", null)).toBe("7/1 →");
  });
  it("returns empty string when both are missing", () => {
    expect(formatDateRange(null, null)).toBe("");
  });
  it("strips leading zeros", () => {
    expect(formatDateRange("2026-01-05", "2026-12-31")).toBe("1/5 → 12/31");
  });
});

describe("groupProgress", () => {
  it("counts completed items against the total", () => {
    const items = [wi("a", "p1"), wiCompleted("b", "p1", "2026-07-02T05:00:00Z"), wi("c", "p1")];
    expect(groupProgress(items)).toEqual({ done: 1, total: 3 });
  });
  it("returns zeros for an empty group", () => {
    expect(groupProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;
  it("1분 미만은 '방금 전'", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("방금 전");
  });
  it("분 단위", () => {
    expect(formatRelativeTime(now - 10 * 60_000, now)).toBe("10분 전");
  });
  it("시간 단위", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3시간 전");
  });
  it("일 단위", () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2일 전");
  });
  it("미래 타임스탬프(시계 오차)는 '방금 전'으로 처리", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("방금 전");
  });
});

describe("offlineStatusText", () => {
  it("shows pending count when items are queued, regardless of cache state", () => {
    expect(offlineStatusText(false, null, 2, 1000)).toBe("동기화 대기 2건");
  });
  it("shows offline-with-timestamp when serving from cache and nothing pending", () => {
    const now = 1_000_000;
    const cachedAt = now - 65_000; // just over a minute ago
    expect(offlineStatusText(true, cachedAt, 0, now)).toContain("오프라인");
  });
  it("falls back to normal synced message when online and nothing pending", () => {
    expect(offlineStatusText(false, null, 0, 1000)).toBe("동기화 완료");
  });
});
