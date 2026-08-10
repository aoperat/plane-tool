import { describe, it, expect } from "vitest";
import {
  createFormState, resolveDateChoice, shiftDateField,
  toggleAssignee, setSingleAssignee, resetFormFields,
} from "./state";
import type { Member } from "../shared/types";

const M = (id: string, is_me = false): Member => ({ id, display_name: id, is_me });

describe("shiftDateField — 시작일과 마감일이 교차하지 않는다", () => {
  it("시작일을 마감일 뒤로 밀면 마감일이 따라간다", () => {
    const s = createFormState();
    s.startChoice = "custom"; s.startCustomDate = "2026-01-10";
    s.dueChoice = "custom"; s.dueCustomDate = "2026-01-10";
    shiftDateField(s, "start", 1);
    expect(resolveDateChoice(s.startChoice, s.startCustomDate)).toBe("2026-01-11");
    expect(resolveDateChoice(s.dueChoice, s.dueCustomDate)).toBe("2026-01-11");
  });
  it("마감일을 시작일 앞으로 당기면 시작일이 따라온다", () => {
    const s = createFormState();
    s.startChoice = "custom"; s.startCustomDate = "2026-01-10";
    s.dueChoice = "custom"; s.dueCustomDate = "2026-01-10";
    shiftDateField(s, "due", -1);
    expect(resolveDateChoice(s.dueChoice, s.dueCustomDate)).toBe("2026-01-09");
    expect(resolveDateChoice(s.startChoice, s.startCustomDate)).toBe("2026-01-09");
  });
  it("교차하지 않으면 상대 날짜를 건드리지 않는다", () => {
    const s = createFormState();
    s.startChoice = "custom"; s.startCustomDate = "2026-01-10";
    s.dueChoice = "custom"; s.dueCustomDate = "2026-01-20";
    shiftDateField(s, "start", 1);
    expect(resolveDateChoice(s.dueChoice, s.dueCustomDate)).toBe("2026-01-20");
  });
  it("날짜를 옮기면 프리셋에서 custom으로 넘어간다", () => {
    const s = createFormState();
    expect(s.startChoice).toBe("today");
    shiftDateField(s, "start", 1);
    expect(s.startChoice).toBe("custom");
  });
});

describe("담당자", () => {
  it("toggleAssignee는 넣고 뺀다", () => {
    const s = createFormState();
    toggleAssignee(s, "a");
    expect(s.assigneeIds).toEqual(["a"]);
    toggleAssignee(s, "b");
    expect(s.assigneeIds).toEqual(["a", "b"]);
    toggleAssignee(s, "a");
    expect(s.assigneeIds).toEqual(["b"]);
  });
  it("setSingleAssignee는 선택을 통째로 바꾼다", () => {
    const s = createFormState();
    s.assigneeIds = ["a", "b"];
    setSingleAssignee(s, M("c"));
    expect(s.assigneeIds).toEqual(["c"]);
  });
  it('"나"를 고르면 빈 배열로 되돌린다 — 서버가 호출자에게 할당한다', () => {
    const s = createFormState();
    s.assigneeIds = ["a"];
    setSingleAssignee(s, M("me", true));
    expect(s.assigneeIds).toEqual([]);
  });
});

describe("resetFormFields", () => {
  it("담당자·날짜·우선순위·상태를 기본값으로 되돌린다", () => {
    const s = createFormState();
    s.assigneeIds = ["a"];
    s.startChoice = "custom"; s.startCustomDate = "2026-01-01";
    s.priority = "urgent";
    s.stateGroup = "started";
    resetFormFields(s);
    expect(s.assigneeIds).toEqual([]);
    expect(s.startChoice).toBe("today");
    expect(s.startCustomDate).toBe("");
    expect(s.priority).toBe("medium");
    expect(s.stateGroup).toBe("unstarted");
  });
  it("고른 프로젝트와 멤버 목록은 남긴다 — 연달아 등록할 때 다시 고르게 하지 않는다", () => {
    const s = createFormState();
    s.selectedId = "proj-1";
    s.members = [M("a")];
    s.membersLoadedForProject = "proj-1";
    resetFormFields(s);
    expect(s.selectedId).toBe("proj-1");
    expect(s.members).toHaveLength(1);
    expect(s.membersLoadedForProject).toBe("proj-1");
  });
});
