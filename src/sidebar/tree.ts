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
