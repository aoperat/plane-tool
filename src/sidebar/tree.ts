import type { WorkItem } from "../shared/types";

/** 하위끼리의 순서 — 만든 순서(오래된 것이 위)로 세운다.
 *
 *  최상위 목록은 상태·우선순위·마감일로 정렬하지만(`compareWorkItems`), 하위는
 *  묶음 안에서 밟아 갈 단계라 그 차례가 흐트러지면 읽기 어렵다. "확인 → 처리 →
 *  전달"로 만든 것이 진행 상태에 따라 뒤섞이면 안 된다.
 *
 *  `created_at`이 없는 항목(오프라인에서 방금 만들어 아직 서버 id를 못 받은
 *  것)은 맨 뒤에 둔다 — 방금 추가한 것이므로 실제로도 마지막이다. */
export function sortChildren(children: WorkItem[]): WorkItem[] {
  return children.sort((a, b) => {
    if (a.created_at === b.created_at) return 0;
    if (!a.created_at) return 1;
    if (!b.created_at) return -1;
    return a.created_at < b.created_at ? -1 : 1;
  });
}

export interface TreeRow {
  item: WorkItem;
  /** 0 = 최상위, 1 = 자식. 2단까지만 쓴다. */
  depth: number;
  /** 자식을 가진 항목인가. 부모 행은 칩 대신 진행 바를 그린다. */
  isParent: boolean;
}

/** 평평한 목록을 [부모, 자식…, 부모, 자식…, 독립항목…] 순서로 편다.
 *
 *  - 부모가 목록에 없는 자식(남의 담당이거나 필터에 걸린 부모)은 최상위로
 *    그린다. 들여쓰면 연결선이 허공에 뜬다.
 *  - 깊이가 얼마든 모든 후손을 depth 1에 눌러 2단만 유지한다. 앱은 2단까지만
 *    만들지만 Plane 웹에서 더 깊은 계층이 생길 수 있고, 그때 항목이 화면에서
 *    조용히 사라지면 안 된다.
 *  - 최상위 항목은 입력 순서(정렬 결과)를 그대로 존중한다.
 *  - 하위끼리는 **만든 순서**로 세운다 — 아래 sortChildren 참고. */
export function buildTreeRows(items: WorkItem[], collapsed: Set<string> = new Set()): TreeRow[] {
  const present = new Set(items.map((i) => i.id));
  const childrenOf = new Map<string, WorkItem[]>();
  for (const it of items) {
    const parent = it.parent_id;
    if (!parent || !present.has(parent)) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(it);
    else childrenOf.set(parent, [it]);
  }
  for (const list of childrenOf.values()) sortChildren(list);

  // 최상위 항목의 후손인가 — 후손은 그 조상 차례에 딸려 나오므로 제 차례를
  // 건너뛴다. 순환(A의 부모가 B, B의 부모가 A)은 최상위가 하나도 없어 여기
  // 걸리지 않고, 아래 루프에서 먼저 만난 쪽이 최상위가 된다.
  const descendant = new Set<string>();
  for (const it of items) {
    if (it.parent_id && present.has(it.parent_id)) continue;
    const walk = [it.id];
    while (walk.length) {
      for (const child of childrenOf.get(walk.pop()!) ?? []) {
        if (descendant.has(child.id)) continue;
        descendant.add(child.id);
        walk.push(child.id);
      }
    }
  }

  const rows: TreeRow[] = [];
  const drawn = new Set<string>();
  for (const it of items) {
    if (descendant.has(it.id) || drawn.has(it.id)) continue;
    const children = childrenOf.get(it.id) ?? [];
    drawn.add(it.id);
    rows.push({ item: it, depth: 0, isParent: children.length > 0 });
    if (collapsed.has(it.id)) continue;
    // 손자든 증손자든 전부 같은 깊이로 눌러 넣는다 — 2단만 그리되 하나도
    // 빠뜨리지 않는다. `drawn`이 순환을 끊는다.
    const stack = [...children].reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (drawn.has(node.id)) continue;
      drawn.add(node.id);
      rows.push({ item: node, depth: 1, isParent: false });
      const kids = childrenOf.get(node.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }
  return rows;
}

/** 개수로 셀 만한 항목 — 하위를 가진 부모는 빼고 센다.
 *
 *  부모는 묶음 머리글이라 그 자체로 할 일이 아니고, 자식과 함께 세면 같은 일이
 *  두 번 세어진다. "제외"는 세지 않는다는 뜻일 뿐 숨긴다는 뜻이 아니다 —
 *  목록에는 부모 행이 그대로 보이므로 부모 1 + 자식 3이면 4줄에 카운트는 3이다. */
export function countActionable(items: WorkItem[]): number {
  return items.filter((it) => it.sub_total === 0).length;
}

/** 자식 하나를 `nextGroup`으로 바꿀 때, 그 부모도 완료 처리해야 하는가.
 *
 *  `sub_done`은 이 변경이 반영되기 전 값이므로 "남은 미완료 자식이 하나뿐"이
 *  곧 "이번 것이 마지막"이라는 뜻이다. */
export function shouldCompleteParent(parent: WorkItem, nextGroup: string): boolean {
  if (nextGroup !== "completed") return false;
  if (parent.sub_total === 0) return false;
  if (parent.state_group === "completed") return false;
  return parent.sub_done === parent.sub_total - 1;
}

/** 자식 상태가 `prevGroup`에서 `nextGroup`으로 바뀔 때 부모 `sub_done`의 증감.
 *
 *  완료로 들어가면 +1, 완료에서 나오면 -1, 완료를 거치지 않는 이동은 0이다.
 *  낙관적 업데이트에서 이 값을 더하고, 서버 호출이 실패하면 다시 빼서 되돌린다. */
export function subDoneDelta(prevGroup: string, nextGroup: string): -1 | 0 | 1 {
  const was = prevGroup === "completed";
  const now = nextGroup === "completed";
  if (was === now) return 0;
  return now ? 1 : -1;
}

export interface ParentEffect {
  /** 부모 `sub_done`에 더할 값. */
  delta: -1 | 0 | 1;
  /** 부모도 완료 처리해야 하는가. */
  complete: boolean;
}

/** 자식 하나가 `prevGroup`에서 `nextGroup`으로 바뀔 때 부모에 미치는 영향.
 *
 *  자식 상태를 바꾸는 경로가 여럿이라(사이드바 상태 팝오버, 수정 창이 보내는
 *  item-updated) 규칙을 여기 한 곳에 모은다 — 두 벌로 두면 한쪽만 고쳐진다.
 *
 *  `parent`의 `sub_done`은 이 변경이 아직 반영되지 않은 값이어야 한다.
 *
 *  한계: 2단만 본다. 부모가 또 다른 항목의 자식이더라도 할아버지의 `sub_done`은
 *  건드리지 않고 완료도 연쇄시키지 않는다 — 이 앱은 2단까지만 만들고(자식 행에는
 *  하위 추가 버튼이 없다), 3단은 Plane 웹에서만 생기며 다음 전체 동기화가 맞춘다. */
export function parentEffect(
  parent: WorkItem | undefined,
  prevGroup: string,
  nextGroup: string,
): ParentEffect {
  if (!parent) return { delta: 0, complete: false };
  return { delta: subDoneDelta(prevGroup, nextGroup), complete: shouldCompleteParent(parent, nextGroup) };
}
