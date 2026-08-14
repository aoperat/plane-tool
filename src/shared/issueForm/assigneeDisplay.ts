import type { Member } from "../types";

/** 담당자가 비었을 때의 뜻. 만들 때(빠른 추가)는 "나에게", 고칠 때(할 일 수정)는
 *  "아무도 없음"이다 — 같은 빈 배열이 창마다 다른 것을 뜻한다. */
export type EmptyAssignee = "me" | "none";

export interface AssigneeChipText {
  /** 아바타 원 안에 넣을 짧은 글자. */
  avatar: string;
  label: string;
}

/** 컴팩트 레이아웃의 담당자 칩에 무엇을 적을지 정한다. */
export function assigneeChip(
  mode: EmptyAssignee,
  assigneeIds: string[],
  members: Member[],
): AssigneeChipText {
  if (assigneeIds.length === 0) {
    return mode === "me"
      ? { avatar: "나", label: "나" }
      : { avatar: "-", label: "담당자 없음" };
  }
  if (assigneeIds.length === 1) {
    // 멤버 목록을 아직 못 받았거나 그 사이 빠진 사람일 수 있다 — 이름 대신
    // 인원수로 적어야 "1명"이라도 맞는 말이 된다.
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    return { avatar: name.slice(0, 1), label: name };
  }
  return { avatar: String(assigneeIds.length), label: `${assigneeIds.length}명` };
}

/** 이 멤버가 지금 지정된 것으로 보여야 하는가. "me" 모드에서는 아무도 안 골랐을 때
 *  본인이 켜져 보인다 — 서버가 그렇게 할당하기 때문이다. */
export function isAssigned(mode: EmptyAssignee, member: Member, assigneeIds: string[]): boolean {
  if (assigneeIds.includes(member.id)) return true;
  return mode === "me" && member.is_me && assigneeIds.length === 0;
}

/** 컴팩트 팝오버의 멤버 행에 적을 이름. */
export function memberRowLabel(mode: EmptyAssignee, member: Member): string {
  return mode === "me" && member.is_me ? `${member.display_name} (나)` : member.display_name;
}

/** 한눈에 보기의 인라인 칩에 적을 이름. 좁은 칸이라 본인은 줄여 쓴다. */
export function personChipLabel(mode: EmptyAssignee, member: Member): string {
  return mode === "me" && member.is_me ? "나" : member.display_name;
}
