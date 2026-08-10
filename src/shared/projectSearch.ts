import type { Project } from "./types";

export interface ProjectMatch {
  project: Project;
  /** `project.name` 안에서 맞은 구간 [시작, 끝). 검색어가 비면 null. */
  range: [number, number] | null;
}

/** 한글 초성 19자. 인덱스가 유니코드 음절의 초성 번호와 같은 순서다. */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
/** 초성 하나가 담당하는 음절 수 = 중성 21 × 종성 28. */
const SYLLABLES_PER_CHOSEONG = 588;

/** 이름을 초성 문자열로 바꾼다. 한글 음절은 초성 한 글자로, 나머지 문자는 그대로 —
 *  **길이가 원본과 같으므로** 여기서 찾은 인덱스를 그대로 이름의 인덱스로 쓸 수 있다. */
function choseongOf(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    out += code >= HANGUL_START && code <= HANGUL_END
      ? CHOSEONG[Math.floor((code - HANGUL_START) / SYLLABLES_PER_CHOSEONG)]
      : ch;
  }
  return out;
}

/** 검색어가 전부 초성 자모일 때만 초성 모드로 본다. 이 조건이 없으면 "자" 같은
 *  완성 음절 하나가 초성 검색과 섞여 엉뚱한 항목까지 물어온다. */
function isChoseongQuery(query: string): boolean {
  return [...query].every((ch) => CHOSEONG.includes(ch));
}

/** 이름 부분 일치(대소문자 무시) 또는 초성 일치. 입력 순서를 유지한다. */
export function filterProjects(projects: Project[], query: string): ProjectMatch[] {
  const q = query.trim();
  if (!q) return projects.map((project) => ({ project, range: null }));

  const choseong = isChoseongQuery(q);
  const needle = choseong ? q : q.toLowerCase();
  const out: ProjectMatch[] = [];
  for (const project of projects) {
    const hay = choseong ? choseongOf(project.name) : project.name.toLowerCase();
    const i = hay.indexOf(needle);
    if (i !== -1) out.push({ project, range: [i, i + q.length] });
  }
  return out;
}
