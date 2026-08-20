/** AI 제안에서 무엇을 고칠지. 요청을 보내기 전에 ▾ 메뉴에서 고르고,
 *  창이 살아 있는 동안(앱 실행 단위) 기억한다. */
export interface AiModes {
  /** 제목 다듬기 — 맞춤법·띄어쓰기·말투. */
  refine: boolean;
  /** 하위 작업 분해. */
  split: boolean;
}

export function defaultAiModes(): AiModes {
  return { refine: true, split: true };
}

/** 하나를 뒤집는다. 둘 다 꺼지는 조합은 보낼 부탁이 없으므로 거부한다 —
 *  이전 상태를 그대로 돌려주고, 체크박스는 렌더가 되돌린다. */
export function toggleAiMode(modes: AiModes, key: keyof AiModes): AiModes {
  const next = { ...modes, [key]: !modes[key] };
  if (!next.refine && !next.split) return modes;
  return next;
}
