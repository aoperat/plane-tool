import { describe, it, expect } from "vitest";
import { splitAssigneeSlots } from "./assigneeSlots";
import type { Member } from "../shared/types";

const M = (id: string, is_me = false): Member => ({ id, display_name: id, is_me });
const names = (ms: Member[]) => ms.map((m) => m.id);

// 서버가 주는 순서를 흉내낸다 — "나"가 맨 앞에 있으리라는 보장은 없다.
const MEMBERS = [M("a"), M("b"), M("me", true), M("c"), M("d"), M("e"), M("f")];

describe("splitAssigneeSlots", () => {
  it('"나"를 맨 앞에 두고 목록 순서대로 칸을 채운다', () => {
    const { inline, overflow } = splitAssigneeSlots(MEMBERS, [], 4);
    expect(names(inline)).toEqual(["me", "a", "b", "c"]);
    expect(names(overflow)).toEqual(["d", "e", "f"]);
  });
  it("멤버가 칸보다 적으면 전부 인라인이고 접힌 게 없다", () => {
    const { inline, overflow } = splitAssigneeSlots([M("me", true), M("a")], [], 4);
    expect(names(inline)).toEqual(["me", "a"]);
    expect(names(overflow)).toEqual([]);
  });
  it("뒤쪽에 있는 사람을 지정하면 인라인으로 끌어올린다", () => {
    const { inline, overflow } = splitAssigneeSlots(MEMBERS, ["f"], 4);
    expect(names(inline)).toEqual(["me", "f", "a", "b"]);
    expect(names(overflow)).toEqual(["c", "d", "e"]);
  });
  it("지정된 사람이 칸보다 많으면 인라인이 그만큼 늘어난다", () => {
    const { inline, overflow } = splitAssigneeSlots(MEMBERS, ["a", "b", "c", "d", "e"], 4);
    expect(names(inline)).toEqual(["me", "a", "b", "c", "d", "e"]);
    expect(names(overflow)).toEqual(["f"]);
  });
  it('"나"를 명시적으로 지정해도 중복되지 않는다', () => {
    const { inline } = splitAssigneeSlots(MEMBERS, ["me"], 4);
    expect(names(inline)).toEqual(["me", "a", "b", "c"]);
  });
  it('멤버 목록에 "나"가 없어도 무너지지 않는다', () => {
    const { inline } = splitAssigneeSlots([M("a"), M("b")], [], 4);
    expect(names(inline)).toEqual(["a", "b"]);
  });
  it("멤버 목록이 비면 양쪽 다 빈 배열", () => {
    expect(splitAssigneeSlots([], [], 4)).toEqual({ inline: [], overflow: [] });
  });
});
