import { describe, it, expect } from "vitest";
import { resolveSubmitRoute } from "./submitRoute";
import type { PendingTree } from "./submitRoute";

function tree(over: Partial<PendingTree> = {}): PendingTree {
  return {
    parentId: "parent-1",
    title: "로그인 개선",
    projectId: "proj-1",
    assigneeIds: ["me"],
    priority: "medium",
    stateGroup: "unstarted",
    ...over,
  };
}

describe("등록 경로 판정", () => {
  it("하위가 없으면 평범한 단일 등록이다", () => {
    expect(resolveSubmitRoute(null, [], "proj-1", "로그인 개선")).toEqual({ kind: "single" });
  });

  it("하위가 있고 만들어 둔 상위가 없으면 트리를 새로 만든다", () => {
    expect(resolveSubmitRoute(null, ["a", "b"], "proj-1", "로그인 개선")).toEqual({
      kind: "tree",
      children: ["a", "b"],
    });
  });

  it("부분 실패 뒤 그대로 재시도하면 있던 상위에 하위만 붙인다", () => {
    const t = tree();
    expect(resolveSubmitRoute(t, ["b"], "proj-1", "로그인 개선")).toEqual({
      kind: "attach",
      tree: t,
      children: ["b"],
    });
  });

  it("제목을 고치면 옛 상위에 붙이지 않고 새 트리를 만든다", () => {
    // 이걸 지키지 않으면 같은 이름의 상위가 둘 생기거나, 화면에 적힌 제목과
    // 다른 상위 밑으로 하위가 들어간다.
    expect(resolveSubmitRoute(tree(), ["b"], "proj-1", "회원가입 버그 수정")).toEqual({
      kind: "tree",
      children: ["b"],
    });
  });

  it("제목을 고쳐도 남은 하위는 새 트리로 따라간다", () => {
    const route = resolveSubmitRoute(tree(), ["b", "c"], "proj-1", "다른 작업");
    expect(route.kind).toBe("tree");
    expect(route).toMatchObject({ children: ["b", "c"] });
  });

  it("프로젝트를 바꾸면 새 트리를 만든다 — 상위는 다른 프로젝트에 있다", () => {
    expect(resolveSubmitRoute(tree(), ["b"], "proj-2", "로그인 개선")).toEqual({
      kind: "tree",
      children: ["b"],
    });
  });

  it("상위가 남아 있어도 하위가 비면 단일 등록이다", () => {
    expect(resolveSubmitRoute(tree(), [], "proj-1", "로그인 개선")).toEqual({ kind: "single" });
  });

  it("제목 앞뒤 공백만 다른 것은 같은 제목이 아니다 — 호출부가 trim해서 넘긴다", () => {
    // submitIssue()는 언제나 trim한 제목을 넘긴다. 이 함수는 받은 값을 그대로
    // 비교하므로, 호출부가 trim을 빠뜨리면 새 트리가 만들어진다.
    expect(resolveSubmitRoute(tree(), ["b"], "proj-1", "로그인 개선 ").kind).toBe("tree");
  });
});
