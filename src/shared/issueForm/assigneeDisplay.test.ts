import { describe, it, expect } from "vitest";
import { assigneeChip, isAssigned, memberRowLabel, personChipLabel } from "./assigneeDisplay";
import type { Member } from "../types";

const M = (id: string, is_me = false): Member => ({ id, display_name: id, is_me });
const ME = M("me", true);
const A = M("alice");
const MEMBERS = [ME, A, M("bob")];

describe("assigneeChip — 담당자 칩에 적을 글자", () => {
  it('"me" 모드에서 비어 있으면 "나"다 — 서버가 호출자에게 할당한다', () => {
    expect(assigneeChip("me", [], MEMBERS)).toEqual({ avatar: "나", label: "나" });
  });

  it('"none" 모드에서 비어 있으면 "담당자 없음"이다 — 고칠 때는 진짜 아무도 없을 수 있다', () => {
    expect(assigneeChip("none", [], MEMBERS)).toEqual({ avatar: "-", label: "담당자 없음" });
  });

  it("한 명이면 이름을 쓰고 아바타는 첫 글자다", () => {
    expect(assigneeChip("none", ["alice"], MEMBERS)).toEqual({ avatar: "a", label: "alice" });
  });

  it("멤버 목록에 없는 id면 이름 대신 인원수로 적는다", () => {
    expect(assigneeChip("me", ["ghost"], MEMBERS)).toEqual({ avatar: "1", label: "1명" });
  });

  it("여러 명이면 인원수를 쓴다", () => {
    expect(assigneeChip("me", ["alice", "bob"], MEMBERS)).toEqual({ avatar: "2", label: "2명" });
  });
});

describe("isAssigned — 이 사람이 지정된 것으로 보여야 하는가", () => {
  it('"me" 모드에서 아무도 안 골랐으면 본인이 켜져 보인다', () => {
    expect(isAssigned("me", ME, [])).toBe(true);
  });

  it('"none" 모드에서는 아무도 안 골랐을 때 본인도 꺼져 있다', () => {
    expect(isAssigned("none", ME, [])).toBe(false);
  });

  it("명시적으로 골랐으면 모드와 상관없이 켜진다", () => {
    expect(isAssigned("me", A, ["alice"])).toBe(true);
    expect(isAssigned("none", A, ["alice"])).toBe(true);
  });

  it('"me" 모드라도 다른 사람을 골랐으면 본인은 꺼진다', () => {
    expect(isAssigned("me", ME, ["alice"])).toBe(false);
  });
});

describe("이름 표기", () => {
  it('"me" 모드에서만 본인 행에 "(나)"를 붙인다', () => {
    expect(memberRowLabel("me", ME)).toBe("me (나)");
    expect(memberRowLabel("none", ME)).toBe("me");
  });

  it('"me" 모드에서만 본인 칩을 "나"로 줄인다', () => {
    expect(personChipLabel("me", ME)).toBe("나");
    expect(personChipLabel("none", ME)).toBe("me");
  });

  it("본인이 아니면 두 모드 모두 이름 그대로다", () => {
    expect(memberRowLabel("me", A)).toBe("alice");
    expect(personChipLabel("me", A)).toBe("alice");
  });
});
