import { describe, it, expect } from "vitest";
import { filterProjects } from "./projectSearch";
import type { Project } from "./types";

const P = (name: string): Project => ({ id: name, name, identifier: name.slice(0, 2) });
const PROJECTS = [
  P("Plane Quick Dock"),
  P("디자인 시스템"),
  P("QA 자동화"),
  P("데이터 파이프라인"),
];

describe("filterProjects — 빈 검색어", () => {
  it("전체를 순서 그대로 돌려주고 강조 구간은 없다", () => {
    const out = filterProjects(PROJECTS, "");
    expect(out.map((m) => m.project.name)).toEqual([
      "Plane Quick Dock", "디자인 시스템", "QA 자동화", "데이터 파이프라인",
    ]);
    expect(out.every((m) => m.range === null)).toBe(true);
  });
  it("공백만 있어도 빈 검색어로 본다", () => {
    expect(filterProjects(PROJECTS, "   ")).toHaveLength(4);
  });
});

describe("filterProjects — 부분 일치", () => {
  it("이름 중간에 걸려도 남는다", () => {
    const out = filterProjects(PROJECTS, "자");
    expect(out.map((m) => m.project.name)).toEqual(["디자인 시스템", "QA 자동화"]);
  });
  it("맞은 구간을 이름 기준 인덱스로 돌려준다", () => {
    const out = filterProjects(PROJECTS, "자");
    expect(out[0].range).toEqual([1, 2]); // 디[자]인 시스템
    expect(out[1].range).toEqual([3, 4]); // QA [자]동화
  });
  it("영문 대소문자를 가리지 않는다", () => {
    const out = filterProjects(PROJECTS, "pl");
    expect(out.map((m) => m.project.name)).toEqual(["Plane Quick Dock"]);
    expect(out[0].range).toEqual([0, 2]);
  });
  it("맞는 게 없으면 빈 배열", () => {
    expect(filterProjects(PROJECTS, "존재하지않음")).toEqual([]);
  });
});

describe("filterProjects — 초성 일치", () => {
  it("초성만으로 찾는다", () => {
    const out = filterProjects(PROJECTS, "ㄷㅈ");
    expect(out.map((m) => m.project.name)).toEqual(["디자인 시스템"]);
    expect(out[0].range).toEqual([0, 2]);
  });
  it("초성 한 글자는 여러 개를 문다 — 첫 음절만이 아니라 어느 음절이든", () => {
    // "QA 자동화"가 걸리는 건 자'동'화의 ㄷ 때문이다. 부분 일치가 이름 중간에
    // 걸리는 것과 같은 규칙이라 일부러 이렇게 둔다.
    const out = filterProjects(PROJECTS, "ㄷ");
    expect(out.map((m) => m.project.name)).toEqual([
      "디자인 시스템", "QA 자동화", "데이터 파이프라인",
    ]);
  });
  it("이름 중간의 초성도 찾는다", () => {
    const out = filterProjects(PROJECTS, "ㅈㄷㅎ");
    expect(out.map((m) => m.project.name)).toEqual(["QA 자동화"]);
    expect(out[0].range).toEqual([3, 6]); // QA [자동화]
  });
  it("완성된 음절이 섞이면 초성 모드로 빠지지 않는다", () => {
    // "ㄷ자"는 초성 검색어가 아니므로 일반 부분 일치로 본다 — 맞는 이름이 없다.
    expect(filterProjects(PROJECTS, "ㄷ자")).toEqual([]);
  });
});
