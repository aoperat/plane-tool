import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import type { Priority, StateGroup } from "../shared/planeIcons";
import type { Member } from "../shared/types";

export type DateChoice = DatePresetKey | "custom";

/** 빠른 추가 한 건의 폼 상태. DOM을 모른다 — 두 레이아웃이 같은 것을 그린다. */
export interface FormState {
  selectedId: string | null;
  members: Member[];
  membersLoadedForProject: string | null;
  /** 비어 있으면 "나" — 서버가 호출자에게 할당한다. */
  assigneeIds: string[];
  startChoice: DateChoice;
  /** ISO yyyy-mm-dd. startChoice === "custom"일 때만 쓴다. */
  startCustomDate: string;
  dueChoice: DateChoice;
  dueCustomDate: string;
  priority: Priority;
  stateGroup: StateGroup;
}

export function createFormState(): FormState {
  return {
    selectedId: null,
    members: [],
    membersLoadedForProject: null,
    assigneeIds: [],
    startChoice: "today",
    startCustomDate: "",
    dueChoice: "today",
    dueCustomDate: "",
    priority: "medium",
    stateGroup: "unstarted",
  };
}

export function dateChoiceLabel(choice: DateChoice, custom: string): string {
  if (choice === "custom") return custom || "날짜 선택";
  return DATE_PRESETS.find((d) => d.key === choice)!.label;
}

export function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}

/** 날짜를 하루씩 옮긴다. ISO yyyy-mm-dd 문자열은 그냥 비교해도 순서가 맞으므로
 *  아래 교차 방지에 Date 파싱이 필요 없다. */
export function shiftDateField(s: FormState, kind: "start" | "due", delta: number): void {
  if (kind === "start") {
    const next = shiftIsoDate(resolveDateChoice(s.startChoice, s.startCustomDate), delta);
    s.startCustomDate = next;
    s.startChoice = "custom";
    // 시작일을 마감일 뒤로 밀면 기간이 뒤집힌다 — 마감일을 끌고 간다.
    if (next > resolveDateChoice(s.dueChoice, s.dueCustomDate)) {
      s.dueCustomDate = next;
      s.dueChoice = "custom";
    }
  } else {
    const next = shiftIsoDate(resolveDateChoice(s.dueChoice, s.dueCustomDate), delta);
    s.dueCustomDate = next;
    s.dueChoice = "custom";
    // 반대 방향으로 같은 보호 — 마감일을 시작일 앞으로 당기면 시작일이 따라온다.
    if (resolveDateChoice(s.startChoice, s.startCustomDate) > next) {
      s.startCustomDate = next;
      s.startChoice = "custom";
    }
  }
}

export function toggleAssignee(s: FormState, id: string): void {
  s.assigneeIds = s.assigneeIds.includes(id)
    ? s.assigneeIds.filter((x) => x !== id)
    : [...s.assigneeIds, id];
}

/** 선택을 이 한 사람으로 바꾼다. "나"를 고르면 빈 배열로 되돌린다 — 명시적 id를
 *  박아두는 것보다, 멤버 목록을 다시 받아도 "고르지 않음"으로 읽히는 게 낫다. */
export function setSingleAssignee(s: FormState, member: Member): void {
  s.assigneeIds = member.is_me ? [] : [member.id];
}

/** 등록 성공 후 폼을 비운다. 고른 프로젝트와 멤버 목록은 남긴다 — 같은 프로젝트에
 *  연달아 등록하는 게 흔하다. */
export function resetFormFields(s: FormState): void {
  s.assigneeIds = [];
  s.startChoice = "today";
  s.startCustomDate = "";
  s.dueChoice = "today";
  s.dueCustomDate = "";
  s.priority = "medium";
  s.stateGroup = "unstarted";
}
