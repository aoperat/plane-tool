import { describe, it, expect } from "vitest";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { ProjectState, WorkItem } from "../shared/types";

function wi(id: string, project_id: string): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, state_group: "started", project_id };
}
function st(id: string, group: string, project_id: string, isDefault = false): ProjectState {
  return { id, group, project_id, default: isDefault };
}

describe("countAssignedByProject", () => {
  it("counts items per project_id", () => {
    const counts = countAssignedByProject([wi("a", "p1"), wi("b", "p1"), wi("c", "p2")]);
    expect(counts).toEqual({ p1: 2, p2: 1 });
  });
  it("returns an empty object for no items", () => {
    expect(countAssignedByProject([])).toEqual({});
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
