import { describe, it, expect } from "vitest";
import { buildTreeRows, countActionable, parentEffect, shouldCompleteParent, subDoneDelta } from "./tree";
import type { WorkItem } from "../shared/types";

function item(id: string, parent: string | null = null, subTotal = 0, subDone = 0): WorkItem {
  return {
    id, name: `item ${id}`, priority: "none",
    target_date: null, start_date: null, state_group: "started",
    project_id: "p1", assignee_ids: ["me"], completed_at: null, created_at: null,
    parent_id: parent, sub_total: subTotal, sub_done: subDone,
  };
}

/** 만든 시각이 있는 자식. 하위 정렬 테스트에 쓴다. */
function child(id: string, parent: string, createdAt: string | null): WorkItem {
  return { ...item(id, parent), created_at: createdAt };
}

describe("하위 작업 순서", () => {
  it("만든 순서대로 세운다 — 먼저 만든 것이 위", () => {
    const rows = buildTreeRows([
      item("p", null, 3, 0),
      child("late", "p", "2026-08-19T12:00:00Z"),
      child("first", "p", "2026-08-19T09:00:00Z"),
      child("mid", "p", "2026-08-19T10:00:00Z"),
    ]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "first", "mid", "late"]);
  });

  it("상태가 달라도 만든 순서를 지킨다 — 진행 중인 하위가 위로 튀지 않는다", () => {
    const done = { ...child("done", "p", "2026-08-19T09:00:00Z"), state_group: "completed" };
    const todo = { ...child("todo", "p", "2026-08-19T10:00:00Z"), state_group: "unstarted" };
    const rows = buildTreeRows([item("p", null, 2, 1), todo, done]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "done", "todo"]);
  });

  it("만든 시각이 없는 항목(오프라인에서 방금 추가)은 맨 뒤에 둔다", () => {
    const rows = buildTreeRows([
      item("p", null, 2, 0),
      child("pending", "p", null),
      child("known", "p", "2026-08-19T09:00:00Z"),
    ]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "known", "pending"]);
  });
});

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

  it("4단 이상으로 깊어져도 후손을 하나도 잃지 않는다", () => {
    const rows = buildTreeRows([
      item("p", null, 1, 0),
      item("c", "p", 1, 0),
      item("g", "c", 1, 0),
      item("gg", "g"),
    ]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "c", "g", "gg"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 1]);
  });

  it("부모-자식이 서로를 가리켜도 무한 루프 없이 한 번씩만 그린다", () => {
    const a = item("a", "b");
    const b = item("b", "a");
    const rows = buildTreeRows([a, b]);
    expect(rows.map((r) => r.item.id).sort()).toEqual(["a", "b"]);
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

describe("countActionable", () => {
  it("하위를 가진 부모는 빼고 센다", () => {
    const items = [item("p", null, 3, 0), item("c1", "p"), item("c2", "p"), item("c3", "p")];
    expect(countActionable(items)).toBe(3);
  });

  it("하위가 없는 평범한 목록은 그대로 센다", () => {
    expect(countActionable([item("a"), item("b")])).toBe(2);
    expect(countActionable([])).toBe(0);
  });

  it("부모가 목록에 없는 고아 자식도 하나로 센다", () => {
    expect(countActionable([item("c", "gone")])).toBe(1);
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

describe("subDoneDelta", () => {
  it("완료로 들어가면 하나 늘린다", () => {
    expect(subDoneDelta("started", "completed")).toBe(1);
  });

  it("완료에서 나오면 하나 줄인다", () => {
    expect(subDoneDelta("completed", "started")).toBe(-1);
  });

  it("완료를 거치지 않는 이동은 그대로 둔다", () => {
    expect(subDoneDelta("started", "unstarted")).toBe(0);
  });

  it("완료에서 취소로 가도 하나 줄인다", () => {
    expect(subDoneDelta("completed", "cancelled")).toBe(-1);
  });

  it("같은 상태로 두면 그대로 둔다", () => {
    expect(subDoneDelta("unstarted", "unstarted")).toBe(0);
    expect(subDoneDelta("completed", "completed")).toBe(0);
  });
});

describe("parentEffect", () => {
  const parent = () => ({ ...item("p", null, 3, 2), state_group: "started" });

  it("부모가 없으면 아무 영향도 없다", () => {
    expect(parentEffect(undefined, "started", "completed")).toEqual({ delta: 0, complete: false });
  });

  it("마지막 자식이 완료되면 카운트를 올리고 부모도 완료한다", () => {
    expect(parentEffect(parent(), "started", "completed")).toEqual({ delta: 1, complete: true });
  });

  it("남은 자식이 있으면 카운트만 올린다", () => {
    const p = { ...parent(), sub_done: 0 };
    expect(parentEffect(p, "started", "completed")).toEqual({ delta: 1, complete: false });
  });

  it("완료를 취소하면 카운트를 내리고 부모는 건드리지 않는다", () => {
    const p = { ...parent(), sub_done: 3, state_group: "completed" };
    expect(parentEffect(p, "completed", "started")).toEqual({ delta: -1, complete: false });
  });

  it("완료를 거치지 않는 이동은 아무것도 바꾸지 않는다", () => {
    expect(parentEffect(parent(), "unstarted", "started")).toEqual({ delta: 0, complete: false });
  });
});
