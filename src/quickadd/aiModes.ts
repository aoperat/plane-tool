/** AI 제안에서 무엇을 고칠지. 요청을 보내기 전에 ▾ 메뉴에서 고르고,
 *  창이 살아 있는 동안(앱 실행 단위) 기억한다. */
export interface AiModes {
  /** 제목 다듬기 — 맞춤법·띄어쓰기·말투. */
  refine: boolean;
  /** 하위 작업 분해. */
  split: boolean;
  /** 제목이 프로젝트명으로 시작하면 지운다. 제목 편집이므로 refine이 켜져
   *  있을 때만 실제로 동작한다 — 판정은 stripProjectName()이 한다. */
  stripProject: boolean;
}

export function defaultAiModes(): AiModes {
  return { refine: true, split: true, stripProject: true };
}

/** 하나를 뒤집는다. refine과 split이 둘 다 꺼지는 조합은 보낼 부탁이 없으므로
 *  거부한다 — 이전 상태를 그대로 돌려주고, 체크박스는 렌더가 되돌린다.
 *  stripProject는 refine의 부속 옵션이라 이 제한과 무관하다. */
export function toggleAiMode(modes: AiModes, key: keyof AiModes): AiModes {
  const next = { ...modes, [key]: !modes[key] };
  if (!next.refine && !next.split) return modes;
  return next;
}

/** 이번 요청에서 프로젝트명 제거가 실제로 동작하는가 — 켜 두었어도 제목
 *  다듬기를 껐으면 제목을 건드릴 수 없다. 이름을 외부로 내보낼지도 이
 *  판정을 따른다. */
export function stripProjectName(modes: AiModes): boolean {
  return modes.refine && modes.stripProject;
}
