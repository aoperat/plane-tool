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

export type SubmitRoute =
  /** 하위 없는 평범한 등록. */
  | { kind: "single" }
  /** 상위 하나와 하위 여럿을 새로 만든다. */
  | { kind: "tree"; children: string[] }
  /** 이미 있는 상위에 하위만 붙인다(부분 실패 재시도). */
  | { kind: "attach"; tree: PendingTree; children: string[] };

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
  if (children.length === 0) return { kind: "single" };
  if (pending && pending.projectId === projectId && pending.title === title) {
    return { kind: "attach", tree: pending, children };
  }
  return { kind: "tree", children };
}
