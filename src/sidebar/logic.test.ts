import { describe, it, expect } from "vitest";
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatLocalTime, groupItemsByProject, isCompletedToday, resolveStateId } from "./logic";
import type { Project, ProjectState, WorkItem } from "../shared/types";

function wi(id: string, project_id: string, state_group = "started"): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, state_group, project_id, completed_at: null };
}
function wiCompleted(id: string, project_id: string, completed_at: string | null): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, state_group: "completed", project_id, completed_at };
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
});

describe("computeSidebarGeometry", () => {
  it("anchors the panel to the right edge at 1x scale", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 1600, hiddenX: 1920, y: 0 });
  });

  it("scales the panel width by the monitor's scale factor", () => {
    const geo = computeSidebarGeometry(3840, 2160, 2, 320);
    expect(geo.width).toBe(640);
    expect(geo.visibleX).toBe(3200);
    expect(geo.hiddenX).toBe(3840);
  });

  it("adds the monitor's absolute x position as an offset", () => {
    // A second monitor placed to the right of a 1920-wide primary monitor.
    const geo = computeSidebarGeometry(1920, 1080, 1, 320, 1920, 0);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 3520, hiddenX: 3840, y: 0 });
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

describe("easeOutCubic", () => {
  it("starts at 0 and ends at 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("clamps out-of-range progress", () => {
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(1.5)).toBe(1);
  });

  it("decelerates: later progress advances less than earlier progress", () => {
    const early = easeOutCubic(0.25) - easeOutCubic(0);
    const late = easeOutCubic(1) - easeOutCubic(0.75);
    expect(late).toBeLessThan(early);
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
