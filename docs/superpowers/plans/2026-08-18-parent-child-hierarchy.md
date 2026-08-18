# 상위/하위 작업 계층 구현 계획 (1단계)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plane의 부모-자식 작업 관계를 앱이 읽고 쓴다 — 사이드바에 계층으로 표시하고, 하위 작업을 직접 추가하고, 자식이 다 끝나면 부모를 자동 완료한다. AI는 이 계획에 없다(2단계).

**Architecture:** 하위 진행률(`sub_total`/`sub_done`)은 **필터링 전 전체 항목으로 Rust에서 계산**해 DTO에 실어 보낸다 — 사이드바 목록은 오래된 완료 항목을 걸러내므로 프론트에서 세면 틀린다. 트리 조립은 `src/sidebar/tree.ts`의 순수 함수가 맡고, 렌더는 기존 `renderTaskRow`를 재사용한다. 부모-자식 관계 자체는 Plane API의 `parent` 필드 하나로 표현된다.

**Tech Stack:** Tauri 2 (Rust: reqwest/serde, wiremock 테스트), Vanilla TS + Vite 멀티페이지, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-parent-child-ai-breakdown-design.md`

---

## Global Constraints

- UI 문구는 모두 한국어.
- `WorkItem.parent_id`와 `RawWorkItem.parent`는 **이미 존재한다**(`plane_api.rs:63-65`, `:428`). 이 계획은 그 값을 DTO로 흘려보내는 것부터 시작한다.
- 생성 바디에서 값이 없는 선택 필드는 `null`이 아니라 **키 자체를 생략**한다 — Plane 0.27+는 `"description_html": null`을 400으로 거절한다(`plane_api.rs:747` 주석).
- 낙관적 업데이트 유지: UI 먼저 바꾸고 실패 시 롤백 (`main.ts:774` 상태 변경 패턴).
- 새 `Settings` 필드는 없다. 마이그레이션 없음.
- 2단 계층만 그린다 — 자식의 자식(손자)은 트리 조립에서 무시한다.
- 마지막 태스크에서 CHANGELOG `[Unreleased]`에 사용자 가시 변경을 기록한다 (프로젝트 CLAUDE.md 규칙).
- 테스트: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, 빌드 `pnpm build`.

## File Structure

**Create:**
- `src/sidebar/tree.ts` — 평평한 배열 → 렌더 순서 목록. 순수 함수만. (`logic.ts`는 375줄이고 성격이 다르므로 합치지 않는다)
- `src/sidebar/tree.test.ts` — 위의 테스트.

**Modify:**
- `src-tauri/src/plane_api.rs` — `count_sub_issues` 순수 함수, `NewWorkItem.parent_id`, 생성 바디의 `parent`.
- `src-tauri/src/commands.rs` — `WorkItemDto` 필드 3개, `assemble_sidebar` 카운트 주입, `create_issue`의 `parent_id` 인자.
- `src-tauri/src/offline.rs` — 큐 payload의 `parent_id` remap.
- `src-tauri/src/briefing.rs` — `open_assigned_items`에서 부모 제외.
- `src-tauri/src/mng_report.rs` — `classify_groups`에서 자식 제외.
- `src/shared/types.ts` — `WorkItem`에 필드 3개.
- `src/shared/ipc.ts` — `createIssue`에 `parent_id`.
- `src/sidebar/main.ts` — 트리 렌더, 하위 추가 버튼, 자동 완료, 탭 카운트.
- `src/shared/app.css` — 부모 행·자식 들여쓰기 스타일.

---

### Task 1: 하위 개수 집계 (Rust 순수 함수)

부모마다 자식 총수와 완료수를 센다. **필터링 전 전체 항목**을 입력으로 받는 것이 핵심이다.

**Files:**
- Modify: `src-tauri/src/plane_api.rs` (`filter_assigned_visible` 아래, 약 365행)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/plane_api.rs`의 `mod tests` 안에 추가. 기존 헬퍼 `wi(id, group, assignees)`를 쓰되 `parent_id`를 채우는 헬퍼를 새로 만든다:

```rust
    fn wi_child(id: &str, group: &str, parent: &str) -> WorkItem {
        let mut w = wi(id, group, &["me"]);
        w.parent_id = Some(parent.into());
        w
    }

    #[test]
    fn count_sub_issues_counts_children_per_parent() {
        let items = vec![
            wi("p1", "started", &["me"]),
            wi_child("c1", "completed", "p1"),
            wi_child("c2", "started", "p1"),
            wi_child("c3", "unstarted", "p1"),
            wi("solo", "started", &["me"]),
        ];
        let counts = count_sub_issues(&items);
        assert_eq!(counts.get("p1"), Some(&(3, 1)));
        assert_eq!(counts.get("solo"), None);
    }

    /// 회귀 방지: 완료 자식이 사이드바 필터에서 빠져도 카운트는 전체 기준이다.
    /// 이 함수에 넘기는 것은 항상 필터 전 목록이어야 한다.
    #[test]
    fn count_sub_issues_counts_cancelled_children_as_not_done() {
        let items = vec![
            wi("p1", "started", &["me"]),
            wi_child("c1", "cancelled", "p1"),
            wi_child("c2", "completed", "p1"),
        ];
        let counts = count_sub_issues(&items);
        assert_eq!(counts.get("p1"), Some(&(2, 1)));
    }

    #[test]
    fn count_sub_issues_ignores_children_of_unknown_parents() {
        let items = vec![wi_child("c1", "started", "gone")];
        let counts = count_sub_issues(&items);
        assert_eq!(counts.get("gone"), Some(&(1, 0)));
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml count_sub_issues`
Expected: FAIL — `cannot find function count_sub_issues in this scope`

- [ ] **Step 3: 최소 구현을 쓴다**

`src-tauri/src/plane_api.rs`의 `filter_delegated_visible` 아래에 추가. 파일 상단에 `use std::collections::HashMap;`이 없으면 함께 추가한다:

```rust
/// 부모 id → (자식 총수, 완료된 자식 수).
///
/// **반드시 필터링 전 전체 목록을 넘긴다.** 사이드바가 쓰는
/// `filter_assigned_visible`은 오래된 완료 항목을 걸러내므로, 필터 후 목록으로
/// 세면 "3개 중 1개 완료"가 "1개 중 0개"로 보인다. 부모가 목록에 없는 고아
/// 자식도 그대로 센다 — 그 항목은 프론트에서 최상위로 그려진다.
pub fn count_sub_issues(items: &[WorkItem]) -> HashMap<String, (usize, usize)> {
    let mut counts: HashMap<String, (usize, usize)> = HashMap::new();
    for item in items {
        let Some(parent) = item.parent_id.as_deref() else { continue };
        let entry = counts.entry(parent.to_string()).or_insert((0, 0));
        entry.0 += 1;
        if item.state_group == "completed" {
            entry.1 += 1;
        }
    }
    counts
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml count_sub_issues`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat: 부모별 하위 작업 개수를 세는 순수 함수를 추가한다"
```

---

### Task 2: DTO에 계층 정보를 실어 보낸다

**Files:**
- Modify: `src-tauri/src/commands.rs:50-62` (`WorkItemDto`), `:125-153` (`assemble_sidebar`), `:156-165` (`work_item_to_dto`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/commands.rs`의 `mod tests` 안에 추가한다. 기존 테스트가 쓰는 `WorkItem` 생성 방식을 따르되, 이 파일에 헬퍼가 없으면 다음을 함께 넣는다:

```rust
    fn item_with_parent(id: &str, group: &str, parent: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("item {id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(), assignee_ids: vec!["me".into()],
            completed_at: Some("2026-08-18T09:00:00Z".into()).filter(|_| group == "completed"),
            created_at: None, created_by: None, updated_at: None, sequence_id: 1,
            parent_id: parent.map(str::to_string),
        }
    }

    #[test]
    fn assemble_sidebar_carries_parent_id_and_sub_counts() {
        let items = vec![
            item_with_parent("p1", "started", None),
            item_with_parent("c1", "completed", Some("p1")),
            item_with_parent("c2", "started", Some("p1")),
        ];
        let data = assemble_sidebar("me", Vec::new(), items, Vec::new(), "2026-08-18", "2026-08-18");
        let parent = data.assigned.iter().find(|i| i.id == "p1").unwrap();
        assert_eq!(parent.sub_total, 2);
        assert_eq!(parent.sub_done, 1);
        assert_eq!(parent.parent_id, None);
        let child = data.assigned.iter().find(|i| i.id == "c2").unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("p1"));
        assert_eq!(child.sub_total, 0);
    }

    /// 회귀 방지: 완료 자식이 표시 창(completed_after/before) 밖이라 목록에서
    /// 빠져도 부모의 진행률은 2개 중 1개로 남아야 한다.
    #[test]
    fn assemble_sidebar_counts_children_hidden_by_completed_window() {
        let mut old_done = item_with_parent("c1", "completed", Some("p1"));
        old_done.completed_at = Some("2026-07-01T09:00:00Z".into());
        let items = vec![
            item_with_parent("p1", "started", None),
            old_done,
            item_with_parent("c2", "started", Some("p1")),
        ];
        let data = assemble_sidebar("me", Vec::new(), items, Vec::new(), "2026-08-18", "2026-08-18");
        assert!(data.assigned.iter().all(|i| i.id != "c1"), "오래된 완료 항목은 목록에서 빠진다");
        let parent = data.assigned.iter().find(|i| i.id == "p1").unwrap();
        assert_eq!((parent.sub_total, parent.sub_done), (2, 1));
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml assemble_sidebar_carries`
Expected: FAIL — `no field sub_total on type WorkItemDto`

- [ ] **Step 3: DTO에 필드를 추가한다**

`src-tauri/src/commands.rs:50` `WorkItemDto`에 세 필드를 더한다:

```rust
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub assignee_ids: Vec<String>,
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// 상위 작업 id. 사이드바가 이 값으로 트리를 조립한다.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 이 항목의 자식 총수 / 완료된 자식 수. **필터링 전 전체 목록** 기준이라
    /// 오래된 완료 자식이 목록에서 빠져도 숫자가 맞는다. 0이면 부모가 아니다.
    #[serde(default)]
    pub sub_total: usize,
    #[serde(default)]
    pub sub_done: usize,
}
```

`WorkItemDto`는 `#[derive(Debug, Serialize, Deserialize, Clone)]`이다(`commands.rs:49`). 캐시 스냅샷 파일에는 이 필드가 없는 옛 데이터가 남아 있으므로 `#[serde(default)]`가 반드시 필요하다 — 없으면 업데이트 직후 첫 실행에서 캐시 로드가 실패한다.

- [ ] **Step 4: 카운트를 주입한다**

`work_item_to_dto`를 카운트 맵을 받도록 바꾸고, `assemble_sidebar`에서 **필터 전** `items`로 카운트를 만든다:

```rust
pub fn assemble_sidebar(
    user_id: &str,
    projects: Vec<Project>,
    items: Vec<WorkItem>,
    states: Vec<ProjectState>,
    completed_after: &str,
    completed_before: &str,
) -> SidebarData {
    // 필터 전 전체 목록으로 센다 — 필터 후에 세면 오래된 완료 자식이 빠져
    // 진행률이 틀린다 (plane_api::count_sub_issues 주석 참고).
    let sub_counts = plane_api::count_sub_issues(&items);
    let delegated = filter_delegated_visible(items.clone(), user_id)
        .into_iter()
        .map(|w| work_item_to_dto(w, &sub_counts))
        .collect();
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(|w| work_item_to_dto(w, &sub_counts))
        .collect();
    // …이하 기존 코드 그대로
```

```rust
fn work_item_to_dto(w: WorkItem, sub_counts: &HashMap<String, (usize, usize)>) -> WorkItemDto {
    let (sub_total, sub_done) = sub_counts.get(&w.id).copied().unwrap_or((0, 0));
    WorkItemDto {
        id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
        start_date: w.start_date,
        state_group: w.state_group, project_id: w.project_id,
        assignee_ids: w.assignee_ids,
        completed_at: w.completed_at,
        created_at: w.created_at, updated_at: w.updated_at,
        parent_id: w.parent_id,
        sub_total, sub_done,
    }
}
```

`work_item_to_dto`의 다른 호출부가 있으면 모두 `&sub_counts` 또는 `&HashMap::new()`를 넘기도록 고친다. 파일 상단에 `use std::collections::HashMap;`이 없으면 추가한다(이미 `HashSet`을 쓰고 있으니 `use std::collections::{HashMap, HashSet};`로 합친다).

오프라인 큐가 만드는 `WorkItemDto` 리터럴(`commands.rs:405` 부근 `placeholder`)에도 새 필드를 채운다:

```rust
                parent_id: None,
                sub_total: 0,
                sub_done: 0,
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 새 테스트 2개 포함 전부 통과. 컴파일 오류가 나면 `WorkItemDto`를 만드는 다른 자리를 마저 채운다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: 사이드바 DTO에 상위 작업 id와 하위 진행률을 싣는다"
```

---

### Task 3: 트리 조립 (TypeScript 순수 함수)

**Files:**
- Create: `src/sidebar/tree.ts`, `src/sidebar/tree.test.ts`
- Modify: `src/shared/types.ts:4-13`

- [ ] **Step 1: 타입을 확장한다**

`src/shared/types.ts`의 `WorkItem`에 추가:

```ts
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; start_date: string | null;
  state_group: string; project_id: string;
  assignee_ids: string[];
  completed_at: string | null;
  created_at: string | null;
  /** 상위 작업 id. 없으면 최상위 항목이다. */
  parent_id: string | null;
  /** 자식 총수 / 완료된 자식 수. 필터 전 전체 기준(Rust가 계산). 0이면 부모가 아니다. */
  sub_total: number;
  sub_done: number;
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/sidebar/tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTreeRows } from "./tree";
import type { WorkItem } from "../shared/types";

function item(id: string, parent: string | null = null, subTotal = 0, subDone = 0): WorkItem {
  return {
    id, name: `item ${id}`, priority: "none",
    target_date: null, start_date: null, state_group: "started",
    project_id: "p1", assignee_ids: ["me"], completed_at: null, created_at: null,
    parent_id: parent, sub_total: subTotal, sub_done: subDone,
  };
}

describe("buildTreeRows", () => {
  it("자식을 부모 바로 아래에 놓는다", () => {
    const rows = buildTreeRows([item("solo"), item("p", null, 2, 0), item("c1", "p"), item("c2", "p")]);
    expect(rows.map((r) => r.item.id)).toEqual(["solo", "p", "c1", "c2"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1]);
  });

  it("부모가 목록에 없는 고아 자식은 최상위로 그린다", () => {
    const rows = buildTreeRows([item("c1", "gone"), item("solo")]);
    expect(rows.map((r) => r.item.id)).toEqual(["c1", "solo"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("입력 순서를 유지한다", () => {
    const rows = buildTreeRows([item("b"), item("a"), item("c")]);
    expect(rows.map((r) => r.item.id)).toEqual(["b", "a", "c"]);
  });

  it("손자는 자식과 같은 깊이로 눌러 2단만 유지한다", () => {
    const rows = buildTreeRows([item("p", null, 1, 0), item("c", "p", 1, 0), item("g", "c")]);
    expect(rows.map((r) => r.item.id)).toEqual(["p", "c", "g"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it("접힌 부모의 자식은 빠진다", () => {
    const rows = buildTreeRows([item("p", null, 2, 0), item("c1", "p"), item("c2", "p")], new Set(["p"]));
    expect(rows.map((r) => r.item.id)).toEqual(["p"]);
  });

  it("부모 행에 표시할 접기 가능 여부를 알려준다", () => {
    const rows = buildTreeRows([item("p", null, 2, 1), item("c1", "p")]);
    expect(rows[0].isParent).toBe(true);
    expect(rows[1].isParent).toBe(false);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm test tree`
Expected: FAIL — `Failed to resolve import "./tree"`

- [ ] **Step 4: 구현한다**

`src/sidebar/tree.ts`:

```ts
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
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm test tree`
Expected: PASS (6 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/sidebar/tree.ts src/sidebar/tree.test.ts src/shared/types.ts
git commit -m "feat: 상위/하위 작업 트리를 조립하는 순수 함수를 추가한다"
```

---

### Task 4: 사이드바에 계층을 그린다

**Files:**
- Modify: `src/sidebar/main.ts:753` (`renderTaskRow`), `:960-966` (그룹 본문 렌더), `src/shared/app.css`

- [ ] **Step 1: CSS를 추가한다**

`src/shared/app.css`의 `.task` 규칙 근처에 추가한다:

```css
/* 하위 작업. 왼쪽 여백과 갈고리 선으로 부모에 매달린 것처럼 보인다. */
.task.child { margin-left: 22px; position: relative; }
.task.child::before {
  content: ""; position: absolute; left: -11px; top: -5px; bottom: 50%; width: 9px;
  border-left: 1px solid var(--border); border-bottom: 1px solid var(--border);
  border-bottom-left-radius: 5px; pointer-events: none;
}
/* 부모 행. 칩을 그리지 않는 대신 진행 바와 비율이 들어간다. */
.task.parent { background: var(--panel-2); }
.task.parent .subprog { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.task.parent .subprog .bar { flex: 1; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.task.parent .subprog .bar > i { display: block; height: 100%; background: var(--accent); }
.task.parent .subprog .txt { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.task .subfold { color: var(--muted); font-size: 10px; width: 10px; text-align: center; cursor: pointer; flex: none; }
.task.collapsed .subfold { transform: rotate(-90deg); }
```

- [ ] **Step 2: `renderTaskRow`가 계층을 받도록 고친다**

`src/sidebar/main.ts:753`의 시그니처를 바꾸고, 클래스와 부모 행 요소를 더한다:

```ts
function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[], row?: TreeRow): HTMLElement {
  const el = document.createElement("div");
  const isParent = row?.isParent ?? false;
  const isChild = (row?.depth ?? 0) > 0;
  el.className = "task"
    + (it.state_group === "completed" ? " completed" : "")
    + (it.state_group === "started" ? " in-progress" : "")
    + (isChild ? " child" : "")
    + (isParent ? " parent" : "")
    + (isParent && collapsedGroups.has(it.id) ? " collapsed" : "");
```

파일 상단 import에 추가:

```ts
import { buildTreeRows, type TreeRow } from "./tree";
```

부모 행에는 접기 화살표를 맨 앞에 넣는다. `top.appendChild(stateBtn)` **앞에** 다음을 넣는다:

```ts
  if (isParent) {
    const fold = document.createElement("span");
    fold.className = "subfold";
    fold.textContent = "▾";
    fold.title = "하위 작업 접기";
    fold.onclick = (e) => {
      e.stopPropagation();
      if (collapsedGroups.has(it.id)) collapsedGroups.delete(it.id);
      else collapsedGroups.add(it.id);
      persistCollapsedGroups();
      renderTasks(allItems, projects);
    };
    top.appendChild(fold);
  }
```

`collapsedGroups`는 프로젝트 접기와 같은 Set을 쓴다 — 작업 id와 프로젝트 id는 서로 다른 UUID라 섞이지 않는다.

- [ ] **Step 3: 부모 행은 칩 대신 진행 바를 그린다**

`renderTaskRow`의 칩 블록 — `const chips = document.createElement("div")`부터
`el.appendChild(chips);`(`main.ts:863`)까지 — 를 통째로 `if (!isParent) { … }`로
감싸고, 부모면 진행 바를 대신 붙인다.

**조기 `return`을 쓰지 않는다.** 칩 블록 아래에 있는 `el.onclick`(수정 창 열기)과
`el.oncontextmenu`(우클릭 메뉴), 마지막 `return el`은 부모 행에도 그대로
적용돼야 한다. 부모를 눌렀을 때 담당자·날짜를 볼 수 있는 유일한 경로가 그
수정 창이다.

```ts
  if (isParent) {
    // 부모의 날짜·담당자는 자식들 것의 요약이라 새 정보가 아니다. 목록에서는
    // 접고, 값 자체는 행을 눌러 수정 창을 열면 그대로 있다.
    const prog = document.createElement("div");
    prog.className = "subprog";
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    const pct = it.sub_total > 0 ? Math.round((it.sub_done / it.sub_total) * 100) : 0;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    prog.appendChild(bar);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = `${it.sub_done}/${it.sub_total}`;
    prog.appendChild(txt);
    el.appendChild(prog);
  } else {
    const chips = document.createElement("div");
    chips.className = "task-chips";
    // … 기존 칩 코드 전부 (우선순위·완료·날짜·담당자) 그대로 …
    el.appendChild(chips);
  }

  // 아래는 부모·자식·독립 항목 모두 공통 — 손대지 않는다.
  el.onclick = () => openEditModal(it.project_id, it.id, it);
```

- [ ] **Step 4: 그룹 본문에서 트리 순서로 그린다**

`src/sidebar/main.ts:962-966`의 루프를 바꾼다. 기존:

```ts
      for (const it of filterHiddenCompleted(groupItems, hideCompleted)) {
        body.appendChild(renderTaskRow(it, items, projects));
      }
```

새 코드:

```ts
      // 트리는 완료 숨김을 적용한 뒤에 조립한다 — 숨겨진 부모의 자식이 갑자기
      // 최상위로 튀어나오는 것이 자연스럽다(고아 자식 규칙과 같은 처리).
      const visible = filterHiddenCompleted(groupItems, hideCompleted);
      for (const row of buildTreeRows(visible, collapsedGroups)) {
        body.appendChild(renderTaskRow(row.item, items, projects, row));
      }
```

`renderSubGroup`(사이클 축) 안의 같은 루프도 동일하게 바꾼다.

- [ ] **Step 5: 확인한다**

Run: `pnpm test && pnpm build`
Expected: 테스트 전부 통과, 빌드 성공.

수동 확인: Plane 웹에서 아무 작업에 하위 작업을 하나 만들고(둘 다 내 담당), 앱 사이드바를 새로고침한다. 부모 행에 진행 바와 `0/1`이 보이고 자식이 들여쓰여 매달려 있어야 한다. 화살표를 눌러 접었다 펴고, 창을 껐다 켜서 접힘이 유지되는지 본다.

- [ ] **Step 6: 커밋**

```bash
git add src/sidebar/main.ts src/shared/app.css
git commit -m "feat: 사이드바에 상위/하위 작업을 계층으로 표시한다"
```

---

### Task 5: 하위 작업 생성 (Rust)

**Files:**
- Modify: `src-tauri/src/plane_api.rs:97-110` (`NewWorkItem`), `:737-770` (`create_work_item`), `src-tauri/src/commands.rs:339-373` (`try_create_issue_online`, `create_issue`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/plane_api.rs`의 `mod tests`에 추가한다. 기존 wiremock 테스트 형식을 따른다:

```rust
    #[tokio::test]
    async fn create_work_item_sends_parent_when_present() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(body_partial_json(serde_json::json!({ "parent": "parent-1" })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "new-1" })))
            .mount(&server)
            .await;
        let client = PlaneClient::new(server.uri(), "acme".into(), "key".into());
        let item = NewWorkItem {
            name: "자식", assignee_ids: &[], start_date: None, target_date: None,
            priority: "none", state_id: "s1", description_html: None,
            parent_id: Some("parent-1"),
        };
        let id = client.create_work_item("p1", &item).await.unwrap();
        assert_eq!(id, "new-1");
    }

    /// 회귀 방지: parent가 없으면 키 자체를 보내지 않는다. Plane 0.27+는
    /// null을 400으로 거절한다 (description_html과 같은 이유).
    #[tokio::test]
    async fn create_work_item_omits_parent_key_when_absent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "new-2" })))
            .mount(&server)
            .await;
        let client = PlaneClient::new(server.uri(), "acme".into(), "key".into());
        let item = NewWorkItem {
            name: "최상위", assignee_ids: &[], start_date: None, target_date: None,
            priority: "none", state_id: "s1", description_html: None,
            parent_id: None,
        };
        client.create_work_item("p1", &item).await.unwrap();
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert!(body.get("parent").is_none(), "parent 키가 없어야 한다: {body}");
    }
```

경로는 `ws_base()`(`plane_api.rs:568`)가 만드는
`{base}/api/v1/workspaces/{workspace}`를 따른다. 워크스페이스 이름을 `acme`로
두는 것은 이 파일의 기존 wiremock 테스트(`plane_api.rs:1105` 등)와 맞춘 것이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml create_work_item_`
Expected: FAIL — `struct NewWorkItem has no field named parent_id`

- [ ] **Step 3: 구현한다**

`src-tauri/src/plane_api.rs:97`:

```rust
pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
    pub description_html: Option<&'a str>,
    /// 상위 작업 id. Plane이 워크스페이스·프로젝트 소속까지 검증한다.
    pub parent_id: Option<&'a str>,
}
```

`create_work_item`의 바디 조립부(`description_html`을 넣는 자리 근처)에 추가한다:

```rust
        if let Some(parent) = item.parent_id {
            body.insert("parent".into(), serde_json::json!(parent));
        }
```

`NewWorkItem`을 만드는 기존 자리(`commands.rs`의 `try_create_issue_online`)에 `parent_id`를 더한다:

```rust
pub(crate) async fn try_create_issue_online(
    client: &PlaneClient,
    project_id: &str,
    name: &str,
    assignee_ids: &[String],
    start_date: Option<&str>,
    target_date: Option<&str>,
    priority: &str,
    state_group: &str,
    description: Option<&str>,
    parent_id: Option<&str>,
) -> Result<String, String> {
```

같은 함수 안의 `NewWorkItem { … }` 리터럴에 `parent_id,`를 더한다.

- [ ] **Step 4: 커맨드에 인자를 추가한다**

`src-tauri/src/commands.rs:373` `create_issue`에 `parent_id: Option<String>` 인자를 더하고, `try_create_issue_online` 호출에 `parent_id.as_deref()`를 넘긴다. 오프라인 큐 payload에도 넣는다:

```rust
            let payload = serde_json::json!({
                "name": trimmed, "assignee_ids": assignee_ids,
                "start_date": start_date, "target_date": target_date,
                "priority": priority, "state_group": state_group, "description": description,
                "parent_id": parent_id,
            });
```

큐 재생 코드(`lib.rs`의 `replay_queue`에서 `MutationKind::CreateIssue`를 처리하는 자리)가 payload를 읽어 `try_create_issue_online`을 부르므로, 거기서도 `parent_id`를 꺼내 넘긴다:

```rust
            let parent_id = payload.get("parent_id").and_then(|v| v.as_str());
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 컴파일 오류가 나면 `create_issue`/`try_create_issue_online`의 모든 호출부에 새 인자를 채운다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: 상위 작업을 지정해 하위 작업을 만들 수 있게 한다"
```

---

### Task 6: 오프라인 큐의 상위 id 치환

부모와 자식을 오프라인에서 잇달아 만들면 자식의 `parent_id`는 부모의 **로컬 임시 id**를 가리킨다. 재생 중 부모가 서버 id를 받는 순간 그 값을 바꿔줘야 한다.

**Files:**
- Modify: `src-tauri/src/offline.rs:117-125` (`remap_target_id`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/offline.rs`의 `mod tests`에 추가:

```rust
    #[test]
    fn remap_target_id_also_rewrites_parent_in_payload() {
        let mut queue = OfflineQueue::default();
        push_mutation(&mut queue, MutationKind::CreateIssue, "p1", "local-1",
            serde_json::json!({ "name": "부모" }), None, 1);
        push_mutation(&mut queue, MutationKind::CreateIssue, "p1", "local-2",
            serde_json::json!({ "name": "자식", "parent_id": "local-1" }), None, 2);

        remap_target_id(&mut queue, "local-1", "server-1");

        let child = queue.items.iter().find(|i| i.target_id == "local-2").unwrap();
        assert_eq!(child.payload.get("parent_id").and_then(|v| v.as_str()), Some("server-1"));
    }

    #[test]
    fn remap_target_id_leaves_other_parents_alone() {
        let mut queue = OfflineQueue::default();
        push_mutation(&mut queue, MutationKind::CreateIssue, "p1", "local-2",
            serde_json::json!({ "name": "자식", "parent_id": "server-9" }), None, 1);

        remap_target_id(&mut queue, "local-1", "server-1");

        let child = queue.items.iter().find(|i| i.target_id == "local-2").unwrap();
        assert_eq!(child.payload.get("parent_id").and_then(|v| v.as_str()), Some("server-9"));
    }
```

큐 항목 타입은 `PendingMutation`이고 필드는 `id` / `kind` / `project_id` /
`target_id` / `payload` / `base_updated_at` / `queued_at_ms`다
(`offline.rs:104-113`). `push_mutation`의 인자 순서는 위 테스트에 쓴 그대로다
(`queue, kind, project_id, target_id, payload, base_updated_at, now_ms`).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remap_target_id`
Expected: FAIL — `parent_id`가 여전히 `local-1`

- [ ] **Step 3: 구현한다**

`src-tauri/src/offline.rs:118` `remap_target_id`에 payload 치환을 더한다:

```rust
/// 큐에 남은 항목들이 가리키는 옛 로컬 id를 서버가 준 새 id로 바꾼다 —
/// `CreateIssue` 재생이 성공한 직후 호출한다. `target_id`뿐 아니라 payload의
/// `parent_id`도 바꾼다: 오프라인에서 부모와 자식을 잇달아 만들면 자식은 부모의
/// 로컬 id를 들고 있어서, 그대로 보내면 Plane이 400으로 거절한다.
pub fn remap_target_id(queue: &mut OfflineQueue, old_id: &str, new_id: &str) {
    for item in queue.items.iter_mut() {
        if item.target_id == old_id {
            item.target_id = new_id.to_string();
        }
        if item.payload.get("parent_id").and_then(|v| v.as_str()) == Some(old_id) {
            item.payload["parent_id"] = serde_json::json!(new_id);
        }
    }
}
```

기존 본문이 다른 형태(예: `retain`/`map`)라면 그 구조를 유지한 채 payload 치환만 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remap_target_id`
Expected: PASS (기존 테스트 포함)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "fix: 오프라인 큐 재생 때 하위 작업의 상위 id도 새 id로 바꾼다"
```

---

### Task 7: 사이드바에서 하위 작업 추가

**Files:**
- Modify: `src/shared/ipc.ts:56-75` (`createIssue`), `src/sidebar/main.ts` (`renderTaskRow`), `src/shared/app.css`

- [ ] **Step 1: IPC에 인자를 더한다**

`src/shared/ipc.ts`:

```ts
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string | undefined,
  target_date: string | undefined,
  priority: string,
  state_group: string,
  description: string,
  parent_id?: string,
) =>
  invoke<void>("create_issue", {
    projectId: project_id,
    name,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
    description,
    parentId: parent_id,
  });
```

기존 호출부(`quickadd/main.ts`, `sidebar/main.ts:635`)는 인자를 안 넘겨도 그대로 동작한다.

- [ ] **Step 2: CSS를 추가한다**

`src/shared/app.css`:

```css
.task .subaddbtn { opacity: 0; color: var(--muted); cursor: pointer; flex: none; padding: 0 2px; }
.task:hover .subaddbtn { opacity: 1; }
.task .subaddbtn:hover { color: var(--accent); }
.subadd-row { margin: 0 8px 5px 30px; }
.subadd-row input {
  width: 100%; box-sizing: border-box; background: var(--surface-task);
  border: 1px solid var(--accent-ring); border-radius: 6px;
  padding: 6px 8px; color: var(--text); font-size: 12px; outline: none;
}
```

- [ ] **Step 3: 행에 추가 버튼을 단다**

`renderTaskRow`에서 `browserBtn`을 붙인 뒤에 넣는다. **자식 행에는 달지 않는다** — 2단만 그리기 때문이다:

```ts
  if (!isChild) {
    const subAddBtn = document.createElement("span");
    subAddBtn.className = "subaddbtn";
    subAddBtn.title = "하위 작업 추가";
    subAddBtn.innerHTML = PLUS_ICON;
    subAddBtn.onclick = (e) => {
      e.stopPropagation();
      openSubAddRow(el, it, allItems, projects);
    };
    top.appendChild(subAddBtn);
  }
```

- [ ] **Step 4: 입력 줄을 만든다**

`renderTaskRow` 아래에 새 함수를 넣는다:

```ts
/** 부모 행 바로 아래에 한 줄 입력을 연다. 등록하면 담당자는 나, 우선순위·마감일은
 *  부모에서 상속하고 시작일은 비운다 — 부모의 시작일은 이미 지난 날짜일 때가 많다. */
function openSubAddRow(anchor: HTMLElement, parent: WorkItem, allItems: WorkItem[], projects: Project[]) {
  if (anchor.nextElementSibling?.classList.contains("subadd-row")) return;

  const row = document.createElement("div");
  row.className = "subadd-row";
  const input = document.createElement("input");
  input.placeholder = "하위 작업 제목… (Enter 등록, Esc 취소)";
  row.appendChild(input);
  anchor.after(row);
  input.focus();

  const close = () => row.remove();
  input.onkeydown = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) { close(); return; }
    input.disabled = true;
    createIssue(
      parent.project_id, name, [], undefined, parent.target_date ?? undefined,
      parent.priority, "unstarted", "", parent.id,
    )
      .then(() => { close(); })
      .catch((err) => {
        input.disabled = false;
        synced.textContent = "하위 작업 추가 실패: " + err;
        console.error("createIssue(sub) failed:", err);
      });
  };
  input.onblur = () => { if (!input.disabled) close(); };
}
```

`create_issue` 성공은 `refresh-sidebar` 이벤트를 띄우므로(`commands.rs:398`) 목록은 저절로 다시 그려진다.

- [ ] **Step 5: 확인한다**

Run: `pnpm test && pnpm build`
Expected: 통과.

수동 확인: 사이드바에서 하위가 없는 작업에 마우스를 올려 `+`를 누르고 제목을 넣어 Enter. 목록이 새로고침되면서 그 작업이 부모가 되고 아래에 자식이 매달려야 한다. 오프라인(네트워크를 끊고) 상태에서도 같은 조작이 큐에 쌓이는지 본다.

- [ ] **Step 6: 커밋**

```bash
git add src/shared/ipc.ts src/sidebar/main.ts src/shared/app.css
git commit -m "feat: 사이드바에서 하위 작업을 바로 추가한다"
```

---

### Task 8: 마지막 자식이 끝나면 부모도 완료

**Files:**
- Modify: `src/sidebar/main.ts:766-784` (상태 변경 핸들러)

- [ ] **Step 1: 판정 함수의 테스트를 쓴다**

`src/sidebar/tree.test.ts`에 추가:

```ts
import { buildTreeRows, shouldCompleteParent } from "./tree";

describe("shouldCompleteParent", () => {
  const parent = () => ({ ...item("p", null, 3, 2), state_group: "started" });

  it("마지막 남은 자식이 완료되면 부모를 완료한다", () => {
    expect(shouldCompleteParent(parent(), "completed")).toBe(true);
  });

  it("아직 남은 자식이 있으면 부모를 건드리지 않는다", () => {
    const p = { ...parent(), sub_done: 1 };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });

  it("자식을 완료가 아닌 상태로 바꿀 때는 건드리지 않는다", () => {
    expect(shouldCompleteParent(parent(), "started")).toBe(false);
  });

  it("이미 완료된 부모는 건드리지 않는다", () => {
    const p = { ...parent(), state_group: "completed" };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });

  it("자식이 없는 항목은 부모가 아니다", () => {
    const p = { ...item("x"), state_group: "started" };
    expect(shouldCompleteParent(p, "completed")).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test tree`
Expected: FAIL — `shouldCompleteParent is not a function`

- [ ] **Step 3: 구현한다**

`src/sidebar/tree.ts`에 추가:

```ts
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
```

- [ ] **Step 4: 상태 변경 핸들러에 연결한다**

`src/sidebar/main.ts:768`의 `openStatePopover` 콜백을 고친다. 기존 낙관적 업데이트는 그대로 두고, 성공 후에 부모 처리를 잇는다:

```ts
    openStatePopover(stateBtn, it, (group) => {
      const stateId = resolveStateId(states, it.project_id, group);
      if (!stateId) {
        synced.textContent = "상태 변경 실패: 해당 그룹의 상태를 찾을 수 없음";
        return;
      }
      const prev = it.state_group;
      it.state_group = group;
      renderTasks(allItems, projects);
      updateWorkItemState(it.project_id, it.id, stateId)
        .then(() => {
          const parent = it.parent_id ? allItems.find((x) => x.id === it.parent_id) : undefined;
          if (!parent || !shouldCompleteParent(parent, group)) return;
          const parentStateId = resolveStateId(states, parent.project_id, "completed");
          if (!parentStateId) return;
          const parentPrev = parent.state_group;
          parent.state_group = "completed";
          renderTasks(allItems, projects);
          return updateWorkItemState(parent.project_id, parent.id, parentStateId).catch((err) => {
            // 자식 변경은 이미 서버에 반영됐다 — 부모만 되돌린다.
            parent.state_group = parentPrev;
            renderTasks(allItems, projects);
            synced.textContent = "상위 작업 완료 처리 실패: " + err;
            console.error("updateWorkItemState(parent) failed:", err);
          });
        })
        .catch((err) => {
          it.state_group = prev;
          renderTasks(allItems, projects);
          synced.textContent = "상태 변경 실패: " + err;
          console.error("updateWorkItemState failed:", err);
        });
    });
```

import에 `shouldCompleteParent`를 더한다.

- [ ] **Step 5: 확인한다**

Run: `pnpm test && pnpm build`
Expected: PASS.

수동 확인: 자식 2개짜리 부모를 만들고 자식을 하나씩 완료로 바꾼다. 첫 번째에서는 부모가 그대로, 두 번째에서 부모도 완료로 바뀌어야 한다.

- [ ] **Step 6: 커밋**

```bash
git add src/sidebar/tree.ts src/sidebar/tree.test.ts src/sidebar/main.ts
git commit -m "feat: 하위 작업이 모두 끝나면 상위 작업도 완료 처리한다"
```

---

### Task 9: 집계에서 부모/자식을 가려낸다

부모와 자식이 모두 내 담당이면 네 곳에서 중복으로 세어진다. **"제외"는 세지 않는다는 뜻이지 목록에서 숨긴다는 뜻이 아니다** — 사이드바 목록에는 부모 행이 그대로 보인다.

**Files:**
- Modify: `src-tauri/src/briefing.rs:43` (`open_assigned_items`), `src-tauri/src/mng_report.rs:134` (`classify_groups`), `src/sidebar/main.ts:880` (탭 카운트)

- [ ] **Step 1: 브리핑·마감 알림의 테스트를 쓴다**

`src-tauri/src/briefing.rs`의 `mod tests`에 추가한다. 항목을 만드는 방식은 같은
파일의 `open_assigned_items_excludes_completed_cancelled_and_others`(`briefing.rs:279`)와
같되, `parent_id`를 받도록 클로저에 인자 하나를 더했다:

```rust
    /// 부모는 브리핑에도 마감 알림에도 나오지 않는다 — 오늘 뭘 할지는 자식
    /// 단위이고, 부모까지 넣으면 같은 일이 두 번 울린다.
    /// (마감 알림은 lib.rs:349-350에서 이 함수의 결과를 그대로 쓴다)
    #[test]
    fn open_assigned_items_excludes_parents_with_children() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
        let mk = |id: &str, parent: Option<&str>| WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: "started".into(),
            project_id: "p1".into(),
            assignee_ids: vec!["me".into()],
            completed_at: None, created_at: None, created_by: None, updated_at: None,
            sequence_id: 0, parent_id: parent.map(str::to_string),
        };
        let items = vec![mk("parent", None), mk("child", Some("parent"))];

        let out = open_assigned_items("me", &projects, items);

        let ids: Vec<_> = out.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["child"]);
    }

    /// 회귀 방지: 자식이 없는 평범한 항목은 그대로 남는다 — 부모 제외 규칙이
    /// 목록 전체를 비우지 않는지 확인한다.
    #[test]
    fn open_assigned_items_keeps_items_without_children() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
        let solo = WorkItem {
            id: "solo".into(), name: "혼자".into(), priority: "none".into(),
            target_date: None, start_date: None, state_group: "started".into(),
            project_id: "p1".into(), assignee_ids: vec!["me".into()],
            completed_at: None, created_at: None, created_by: None, updated_at: None,
            sequence_id: 0, parent_id: None,
        };

        let out = open_assigned_items("me", &projects, vec![solo]);

        assert_eq!(out.len(), 1);
    }
```

`Project`의 필드(`cycle_view`, `mng_link`)는 `briefing.rs:280`의 기존 테스트와
같다 — 필드가 늘었으면 컴파일러가 알려준다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml open_assigned_items_excludes_parents`
Expected: FAIL — `assertion failed: left == right` (2 != 1)

- [ ] **Step 3: 브리핑에서 부모를 뺀다**

`src-tauri/src/briefing.rs:43`. 자식을 가진 항목의 id 집합을 먼저 만든 뒤 거른다:

```rust
pub fn open_assigned_items(user_id: &str, projects: &[Project], items: Vec<WorkItem>) -> Vec<BriefingItem> {
    // 자식을 가진 항목(부모)은 제외한다. 오늘 무엇을 할지는 자식 단위이고,
    // 부모까지 넣으면 브리핑과 마감 알림이 같은 일을 두 번 말한다.
    let parents: std::collections::HashSet<&str> =
        items.iter().filter_map(|i| i.parent_id.as_deref()).collect();
    let parent_ids: std::collections::HashSet<String> =
        items.iter().filter(|i| parents.contains(i.id.as_str())).map(|i| i.id.clone()).collect();
    items
        .into_iter()
        .filter(|i| !parent_ids.contains(&i.id))
        .filter(|i| i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "completed" && i.state_group != "cancelled")
        // …이하 기존 map 그대로
```

마감 알림(`deadline_watch::summarize`)은 `lib.rs:349-350`에서 이 함수의 결과를 그대로 받으므로 따로 고칠 것이 없다.

- [ ] **Step 4: mng 업무일지에서 자식을 뺀다**

`src-tauri/src/mng_report.rs:134` `classify_groups`의 루프 앞에 한 줄을 더한다:

```rust
    for item in items {
        // 보고서는 묶음 단위로 읽는 문서다 — 자식은 부모 한 줄로 갈음한다.
        if item.parent_id.is_some() { continue; }
        match item.state_group.as_str() {
```

같은 파일의 테스트에 회귀 방지를 더한다:

```rust
    #[test]
    fn classify_groups_excludes_sub_issues() {
        let mut parent = item("a", "부모", 1, "none", None);
        parent.state_group = "started".into();
        let mut child = item("b", "자식", 2, "none", None);
        child.state_group = "started".into();
        child.parent_id = Some(parent.id.clone());

        let (_, in_progress, _) = classify_groups(&[parent, child], "2026-08-18");

        assert_eq!(in_progress.len(), 1);
        assert_eq!(in_progress[0].name, "부모");
    }
```

- [ ] **Step 5: 탭 카운트에서 부모를 뺀다**

`src/sidebar/main.ts:880`:

```ts
  // 세는 것은 실제 할 일이다 — 하위를 가진 부모는 묶음 머리글이라 빼고 센다.
  // (목록에는 그대로 보인다. 부모 1 + 자식 3이면 4줄에 카운트는 3이다.)
  taskCount.textContent = String(items.filter((i) => i.sub_total === 0).length);
```

`delegated` 탭 카운트를 계산하는 자리에도 같은 필터를 적용한다.

- [ ] **Step 6: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm build`
Expected: 전부 통과.

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/briefing.rs src-tauri/src/mng_report.rs src/sidebar/main.ts
git commit -m "feat: 상위 작업을 카운트와 알림에서, 하위 작업을 업무일지에서 제외한다"
```

---

### Task 10: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `[Unreleased]`에 항목을 더한다**

`## [Unreleased]` 아래 `### 추가`에 (없으면 만들어서) 넣는다:

```markdown
- 사이드바에서 상위/하위 작업을 계층으로 봅니다. 상위 작업 행에는 진행률이 뜨고, 마우스를 올려 하위 작업을 바로 추가할 수 있습니다. 하위를 모두 끝내면 상위 작업도 자동으로 완료됩니다.
```

프로젝트 규칙상 `### 추가` / `### 변경` / `### 수정` 세 가지만 쓰고, 항목이 없는 카테고리는 만들지 않는다.

- [ ] **Step 2: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: 상위/하위 작업 계층을 변경 내역에 적는다"
```

---

## 완료 확인

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 전부 통과
- [ ] `pnpm test` 전부 통과
- [ ] `pnpm build` 성공
- [ ] 수동: Plane 웹에서 만든 부모-자식이 사이드바에 계층으로 보이고, 접힘이 창을 껐다 켜도 유지된다
- [ ] 수동: `+`로 하위 작업을 추가하면 목록이 갱신되며 그 아래 매달린다
- [ ] 수동: 마지막 자식을 완료하면 부모도 완료로 바뀐다
- [ ] 수동: 부모 1 + 자식 3일 때 탭 카운트가 `3`이다(목록은 4줄)

## 다음 단계

2단계(AI 작업 분해)는 별도 계획으로 쓴다. 이 계획의 `create_issue(parent_id)`와
`WorkItem.parent_id`/`sub_total` 위에 얹힌다 — 스펙의 "구현 순서" 절 참고.
