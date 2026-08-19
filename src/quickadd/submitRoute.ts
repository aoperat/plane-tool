/** 트리를 만들다 하위 일부가 실패했을 때 남는 기록. 부모는 이미 서버에 있으므로
 *  재시도는 부모를 다시 만들지 않고 이 id에 하위만 붙여야 한다.
 *
 *  하위가 물려받는 값(담당자·기한·우선순위·상태)도 함께 붙잡아 둔다 — 재시도로
 *  뒤늦게 만들어지는 하위가 먼저 성공한 형제와 같은 모양이어야 하기 때문이다.
 *  그 사이 사용자가 폼의 담당자를 바꿨더라도 형제 쪽을 따른다. */
export interface PendingTree {
  parentId: string;
  /** 이 부모를 만들 때 쓴 제목. 폼 제목이 이것과 달라지면 폼은 더 이상 이 부모를
   *  가리키지 않는다 — 아래 resolveSubmitRoute 참고. */
  title: string;
  /** 부모가 있는 프로젝트. Plane의 상위-하위는 같은 프로젝트 안에서만 성립한다. */
  projectId: string;
  assigneeIds: string[];
  startDate?: string;
  targetDate?: string;
  priority: string;
  stateGroup: string;
}

/** AI 제안을 적용해 폼에 딸려 있는 하위 작업들. 어느 제목에 붙은 것인지 함께
 *  기억한다 — 적용한 뒤 제목을 지우고 전혀 다른 일을 적었는데 지난 제안의 하위가
 *  따라 등록되면 안 되기 때문이다. PendingTree와 같은 원칙이다.
 *
 *  프로젝트는 기억하지 않는다. PendingTree와 달리 이것은 아직 아무것도 만들어지지
 *  않은 제목 목록일 뿐이라, 프로젝트를 옮겨도 그대로 유효하다 — 거기서 버리면
 *  사용자가 고른 하위를 이유 없이 잃는다. */
export interface PendingChildren {
  /** 적용할 때 폼에 넣은 제목(trim된 값). */
  formTitle: string;
  titles: string[];
}

/** 지금 등록하면 함께 만들어질 하위 작업들. 제목이 적용 당시와 다르면 빈
 *  배열이다 — **폼이 곧 만들어질 것을 말한다**(아래 resolveSubmitRoute 참고).
 *
 *  기록을 지우는 것이 아니라 무시할 뿐이라, 제목을 되돌리면 하위도 함께
 *  돌아온다. 한 글자 잘못 고쳤다고 잃게 할 이유는 없다. */
export function activeChildren(pending: PendingChildren | null, title: string): string[] {
  return pending && pending.formTitle === title ? pending.titles : [];
}

export type SubmitRoute =
  /** 하위 없는 평범한 등록. */
  | { kind: "single" }
  /** 상위 하나와 하위 여럿을 새로 만든다. */
  | { kind: "tree"; children: string[] }
  /** 이미 있는 상위에 하위만 붙인다(부분 실패 재시도). */
  | { kind: "attach"; tree: PendingTree; children: string[] }
  /** 만들 것이 남지 않았다. 상위는 이미 서버에 있고 하위는 사용자가 걷어냈다. */
  | { kind: "done"; tree: PendingTree };

/** 지금 Ctrl+Enter를 누르면 무엇을 만들어야 하는가.
 *
 *  핵심은 **폼이 곧 만들어질 것을 말한다**는 원칙이다. 부분 실패로 부모가 남아
 *  있어도, 폼의 제목이나 프로젝트가 그때와 달라졌다면 사용자는 이미 다른 작업을
 *  적고 있는 것이다. 그럴 때 옛 부모에 붙이면 화면과 서버가 어긋나므로 새 트리를
 *  만든다 — 제목이 다르니 "같은 이름의 상위가 둘" 문제도 생기지 않는다.
 *  남은 하위는 버리지 않고 새 상위 밑으로 따라간다. AI가 제안한 것을 한 글자
 *  고쳤다고 잃게 할 이유는 없다. */
export function resolveSubmitRoute(
  pending: PendingTree | null,
  children: string[],
  projectId: string,
  title: string,
): SubmitRoute {
  if (pending && pending.projectId === projectId && pending.title === title) {
    // 폼이 가리키는 상위는 이미 서버에 있다. 남은 하위가 있으면 거기 붙이고,
    // 사용자가 하위를 걷어냈으면 만들 것이 없다 — 여기서 단일 등록으로 새면
    // 같은 이름의 상위가 하나 더 생긴다.
    return children.length > 0
      ? { kind: "attach", tree: pending, children }
      : { kind: "done", tree: pending };
  }
  if (children.length === 0) return { kind: "single" };
  return { kind: "tree", children };
}
