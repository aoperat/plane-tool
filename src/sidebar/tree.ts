import type { WorkItem } from "../shared/types";

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
 *  - 손자는 자식과 같은 깊이로 눌러 2단만 유지한다.
 *  - 입력 순서(정렬 결과)를 그대로 존중한다. */
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

  const rows: TreeRow[] = [];
  for (const it of items) {
    // 부모가 이 목록 안에 있는 항목은 그 부모 차례에 딸려 나온다.
    if (it.parent_id && present.has(it.parent_id)) continue;
    const children = childrenOf.get(it.id) ?? [];
    rows.push({ item: it, depth: 0, isParent: children.length > 0 });
    if (collapsed.has(it.id)) continue;
    for (const child of children) {
      const grandChildren = childrenOf.get(child.id) ?? [];
      rows.push({ item: child, depth: 1, isParent: false });
      // 손자도 같은 깊이로 눌러 넣는다 — 2단만 그린다.
      for (const g of grandChildren) rows.push({ item: g, depth: 1, isParent: false });
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
