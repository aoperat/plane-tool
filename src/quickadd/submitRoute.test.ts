import { describe, it, expect } from "vitest";
import { resolveSubmitRoute, activeChildren } from "./submitRoute";
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

  it("남은 하위를 걷어내면 만들 것이 없다 — 상위는 이미 서버에 있다", () => {
    // 여기서 단일 등록으로 새면 같은 이름의 상위가 하나 더 만들어진다.
    const t = tree();
    expect(resolveSubmitRoute(t, [], "proj-1", "로그인 개선")).toEqual({ kind: "done", tree: t });
  });

  it("제목이 달라진 뒤 하위도 비면 그냥 새 작업 하나다", () => {
    // 옛 상위는 더 이상 이 폼의 것이 아니므로 중복 걱정이 없다.
    expect(resolveSubmitRoute(tree(), [], "proj-1", "전혀 다른 일")).toEqual({ kind: "single" });
  });

  it("제목 앞뒤 공백만 다른 것은 같은 제목이 아니다 — 호출부가 trim해서 넘긴다", () => {
    // submitIssue()는 언제나 trim한 제목을 넘긴다. 이 함수는 받은 값을 그대로
    // 비교하므로, 호출부가 trim을 빠뜨리면 새 트리가 만들어진다.
    expect(resolveSubmitRoute(tree(), ["b"], "proj-1", "로그인 개선 ").kind).toBe("tree");
  });
});

describe("폼에 딸린 하위 작업", () => {
  const applied = { formTitle: "로그인 개선", titles: ["폼 검증", "에러 문구"] };

  it("적용한 것이 없으면 하위도 없다", () => {
    expect(activeChildren(null, "로그인 개선")).toEqual([]);
  });

  it("적용할 때의 제목 그대로면 하위가 따라간다", () => {
    expect(activeChildren(applied, "로그인 개선")).toEqual(["폼 검증", "에러 문구"]);
  });

  it("제목을 전혀 다른 일로 바꾸면 지난 제안의 하위는 딸려가지 않는다", () => {
    // 이걸 지키지 않으면 "회원가입 버그" 밑에 로그인 하위가 붙는다.
    expect(activeChildren(applied, "회원가입 버그 수정")).toEqual([]);
  });

  it("한 글자만 고쳐도 떨어져 나간다 — 폼이 곧 만들어질 것을 말한다", () => {
    expect(activeChildren(applied, "로그인 개선!")).toEqual([]);
  });

  it("제목을 되돌리면 하위도 돌아온다 — 기록을 지우는 것이 아니라 무시할 뿐이다", () => {
    expect(activeChildren(applied, "딴 일")).toEqual([]);
    expect(activeChildren(applied, "로그인 개선")).toEqual(["폼 검증", "에러 문구"]);
  });

  it("앞뒤 공백만 다른 제목은 같은 제목이 아니다 — 호출부가 trim해서 넘긴다", () => {
    expect(activeChildren(applied, " 로그인 개선")).toEqual([]);
  });
});
