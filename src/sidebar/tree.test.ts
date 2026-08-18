import { describe, it, expect } from "vitest";
import { buildTreeRows, shouldCompleteParent } from "./tree";
import type { WorkItem } from "../shared/types";

function item(id: string, parent: string | null = null, subTotal = 0, subDone = 0): WorkItem {
  return {
    id, name: `item ${id}`, priority: "none",
    target_date: null, start_date: null, state_group: "started",
    project_id: "p1", assignee_ids: ["me"], completed_at: null, created_at: null,
    parent_id: parent, sub_total: subTotal, sub_done: subDone,
  };
}

describe("buildTreeRows", () => {
  it("자식을 부모 바로 아래에 놓는다", () => {
    const rows = buildTreeRows([item("solo"), item("p", null, 2, 0), item("c1", "p"), item("c2", "p")]);
    expect(rows.map((r) => r.item.id)).toEqual(["solo", "p", "c1", "c2"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1]);
  });

  it("부모가 목록에 없는 고아 자식은 최상위로 그린다", () => {
    const rows = buildTreeRows([item("c1", "gone"), item("solo")]);
    expect(rows.map((r) => r.item.id)).toEqual(["c1", "solo"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("입력 순서를 유지한다", () => {
    const rows = buildTreeRows([item("b"), item("a"), item("c")]);
    expect(rows.map((r) => r.item.id)).toEqual(["b", "a", "c"]);
  });

  it("손자는 자식과 같은 깊이로 눌러 2단만 유지한다", () => {
    const rows = buildTreeRows([item("p", null, 1, 0), item("c", "p", 1, 0), item("g", "c")]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "c", "g"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it("접힌 부모의 자식은 빠진다", () => {
    const rows = buildTreeRows([item("p", null, 2, 0), item("c1", "p"), item("c2", "p")], new Set(["p"]));
    expect(rows.map((r) => r.item.id)).toEqual(["p"]);
  });

  it("부모 행에 표시할 접기 가능 여부를 알려준다", () => {
    const rows = buildTreeRows([item("p", null, 2, 1), item("c1", "p")]);
    expect(rows[0].isParent).toBe(true);
    expect(rows[1].isParent).toBe(false);
  });
});

describe("shouldCompleteParent", () => {
  const parent = () => ({ ...item("p", null, 3, 2), state_group: "started" });

  it("마지막 남은 자식이 완료되면 부모를 완료한다", () => {
    expect(shouldCompleteParent(parent(), "completed")).toBe(true);
  });

  it("아직 남은 자식이 있으면 부모를 건드리지 않는다", () => {
    const p = { ...parent(), sub_done: 1 };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });

  it("자식을 완료가 아닌 상태로 바꿀 때는 건드리지 않는다", () => {
    expect(shouldCompleteParent(parent(), "started")).toBe(false);
  });

  it("이미 완료된 부모는 건드리지 않는다", () => {
    const p = { ...parent(), state_group: "completed" };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });

  it("자식이 없는 항목은 부모가 아니다", () => {
    const p = { ...item("x"), state_group: "started" };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });
});
