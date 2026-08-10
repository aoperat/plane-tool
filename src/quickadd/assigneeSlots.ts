import type { Member } from "../shared/types";

export interface AssigneeSlots {
  /** 인라인 칩으로 그릴 멤버들. */
  inline: Member[];
  /** "+N"으로 접을 나머지. 비면 "+N" 버튼을 그리지 않는다. */
  overflow: Member[];
}

/** 담당자 행에 누구를 펼치고 누구를 접을지 정한다.
 *  - "나"가 항상 맨 앞이다(기본 담당자이므로).
 *  - **지정된 사람은 무조건 인라인**이다. 접힌 뒤로 숨으면 몇 명 붙었는지 세러
 *    팝오버를 다시 열어야 하고, 그러면 "한눈에 보기"가 아니게 된다.
 *  - 남는 칸은 멤버 목록 순서대로 채운다.
 *  지정된 사람이 `slots`보다 많으면 인라인이 `slots`를 넘는다 — 칸 수는 목표지
 *  상한이 아니다. */
export function splitAssigneeSlots(
  members: Member[],
  assigneeIds: string[],
  slots: number,
): AssigneeSlots {
  const inline: Member[] = [];
  const add = (m: Member | undefined) => {
    if (m && !inline.some((x) => x.id === m.id)) inline.push(m);
  };

  add(members.find((m) => m.is_me));
  for (const id of assigneeIds) add(members.find((m) => m.id === id));
  for (const m of members) {
    if (inline.length >= slots) break;
    add(m);
  }

  const taken = new Set(inline.map((m) => m.id));
  return { inline, overflow: members.filter((m) => !taken.has(m.id)) };
}
