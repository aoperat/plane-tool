# 사이드바 "내가 할당한 작업" 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바에 "내가 할당한 작업" 탭을 추가해, 다른 사람에게 위임한
작업(내가 만들었지만 담당자가 아닌 작업)의 진척을 확인할 수 있게 한다.

**Architecture:** 백엔드가 `fetch_sidebar_data` 한 번의 호출로 담당
작업(`assigned`)과 위임 작업(`delegated`) + 위임 작업 담당자 이름
(`delegated_members`)을 함께 반환한다. 프론트엔드는 탭 전환과 "오늘만
보기" 토글을 추가 API 호출 없이 이미 받은 데이터를 필터링해서 다시
그리는 것으로 처리한다.

**Tech Stack:** Rust(Tauri 커맨드) + TypeScript(Vite), 테스트는 `cargo test`
(src-tauri) / `pnpm test`(vitest).

## Global Constraints

- 신규 API 호출을 늘리지 않는다 — 탭 전환·"오늘만 보기" 토글은 이미 받은
  `SidebarData`를 재필터링할 뿐, `fetch_sidebar_data`를 다시 부르지 않는다.
- "내가 할당한 작업"의 정의는 `created_by == 나` AND `assignee_ids`에 내가
  없음이다. `assigned_by`(누가 할당했는지) 필드는 Plane API에 없으므로
  근사치임을 코드 주석으로 남긴다.
- 완료 항목의 날짜창(오늘 근처만/전체) 적용은 백엔드가 아니라 프론트엔드가
  한다(`filterVisibleToday` 재사용) — 토글이 API 재호출 없이 동작해야
  하므로.
- 캐시 호환성: `SidebarData`에 추가하는 신규 필드는 모두
  `#[serde(default)]`를 붙인다 — 기존 오프라인 캐시 파일(신규 필드 없음)을
  역직렬화할 때 깨지지 않게 하기 위함.
- CHANGELOG 규칙(`CLAUDE.md`): 마지막 태스크에서 `CHANGELOG.md`의
  `## [Unreleased]` → `### 추가`에 한 줄만 추가한다.

---

## File Structure

- `src-tauri/src/plane_api.rs` — `filter_delegated_visible` 신규 함수 + 단위 테스트
- `src-tauri/src/commands.rs` — `SidebarData`에 `delegated`/`delegated_members`
  필드 추가, `assemble_sidebar` 확장, `fetch_sidebar_data_online`에 멤버 이름
  해결 추가
- `src/shared/types.ts` — `SidebarData` 인터페이스에 신규 필드 추가
- `src/sidebar/logic.ts` — `resolveAssigneeName` 신규 순수 함수
- `src/sidebar/logic.test.ts` — 위 함수 테스트
- `src/sidebar/index.html` — 탭 바 마크업, 섹션 헤더에 id 추가, "오늘만 보기" 토글 버튼 마크업
- `src/shared/app.css` — 탭 바 스타일
- `src/sidebar/main.ts` — 탭/토글 상태, 전환 로직, 담당자 칩 렌더링
- `CHANGELOG.md` — Unreleased 항목 추가

---

### Task 1: Rust — `filter_delegated_visible` 필터 함수

**Files:**
- Modify: `src-tauri/src/plane_api.rs:170` (기존 `filter_assigned_visible`/`completed_within` 바로 아래에 추가)
- Modify: `src-tauri/src/plane_api.rs:561-578` (테스트 모듈 — 헬퍼 함수 추가)

**Interfaces:**
- Produces: `pub fn filter_delegated_visible(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem>` — Task 2가 이 함수를 `assemble_sidebar`에서 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/plane_api.rs`의 `mod tests` 블록(561번 줄 근처, 기존 `wi`/`wi_completed` 헬퍼 바로 아래)에 새 헬퍼와 테스트를 추가한다:

```rust
    fn wi_created_by(id: &str, group: &str, assignees: &[&str], created_by: Option<&str>) -> WorkItem {
        let mut item = wi(id, group, assignees);
        item.created_by = created_by.map(|s| s.to_string());
        item
    }

    #[test]
    fn filter_delegated_keeps_my_created_items_not_assigned_to_me() {
        let items = vec![
            wi_created_by("a", "started", &["other"], Some("me")), // keep: created by me, assigned to other
            wi_created_by("b", "started", &["me"], Some("me")),    // drop: assigned to me too
            wi_created_by("c", "started", &["other"], Some("someone_else")), // drop: not created by me
            wi_created_by("d", "started", &["other"], None),       // drop: no created_by
            wi_created_by("e", "cancelled", &["other"], Some("me")), // drop: cancelled
            wi_created_by("f", "started", &["a", "b"], Some("me")), // keep: multiple assignees, none is me
        ];
        let kept = filter_delegated_visible(items, "me");
        let ids: Vec<_> = kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "f"]);
    }

    #[test]
    fn filter_delegated_ignores_completed_date_entirely() {
        // 날짜창은 프론트엔드가 적용한다 — 백엔드는 완료 여부/날짜와 무관하게 다 넘긴다.
        let items = vec![
            wi_created_by("old", "completed", &["other"], Some("me")),
        ];
        let kept = filter_delegated_visible(items, "me");
        assert_eq!(kept.len(), 1);
    }
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd src-tauri && cargo test filter_delegated -- --nocapture`
Expected: FAIL — `filter_delegated_visible` not found in this scope

- [ ] **Step 3: 최소 구현 작성**

`src-tauri/src/plane_api.rs`의 `completed_within` 함수(172-177번 줄) 바로 아래에 추가:

```rust
/// "내가 할당한 작업" 탭의 필터. `created_by == user_id` AND 내가 담당자에
/// 없음. Plane API에는 "누가 할당했는가"를 나타내는 필드가 없으므로, 이는
/// "작업을 만든 사람이 그 자리에서 담당자를 지정한다"는 근사치다 — 남이
/// 만든 작업을 내가 나중에 제3자에게 재할당한 경우는 잡히지 않는다.
/// 완료 항목의 날짜창은 여기서 적용하지 않는다 — 프론트엔드의 "오늘만
/// 보기" 토글이 API 재호출 없이 동작해야 하므로, 그 필터링은
/// `filterVisibleToday`(TS)가 맡는다.
pub fn filter_delegated_visible(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.created_by.as_deref() == Some(user_id))
        .filter(|i| !i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "cancelled")
        .collect()
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd src-tauri && cargo test filter_delegated -- --nocapture`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat: add filter_delegated_visible for delegated-task filtering"
```

---

### Task 2: Rust — `SidebarData`에 `delegated` 필드 추가 (`assemble_sidebar` 확장)

**Files:**
- Modify: `src-tauri/src/commands.rs:1-5` (import에 `filter_delegated_visible` 추가)
- Modify: `src-tauri/src/commands.rs:64-107` (`SidebarData` 구조체, `assemble_sidebar`)
- Modify: `src-tauri/src/commands.rs:979-997` (테스트 헬퍼)

**Interfaces:**
- Consumes: `filter_delegated_visible(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem>` (Task 1)
- Produces: `SidebarData.delegated: Vec<WorkItemDto>` — Task 3(멤버 이름 해결)과 Task 4(TS 타입)가 이 필드를 소비한다. `assemble_sidebar` 시그니처는 변경하지 않는다(기존 파라미터 그대로).

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/commands.rs`의 `mod tests` 블록(979번 줄 근처) 끝에 추가:

```rust
    #[test]
    fn assemble_sidebar_fills_delegated_from_created_by() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let mut mine_for_other = wi("a", "started", &["other"], "p1");
        mine_for_other.created_by = Some("me".into());
        let mut mine_for_me = wi("b", "started", &["me"], "p1");
        mine_for_me.created_by = Some("me".into());
        let mut not_mine = wi("c", "started", &["other"], "p1");
        not_mine.created_by = Some("someone_else".into());
        let items = vec![mine_for_other, mine_for_me, not_mine];
        let data = assemble_sidebar("me", projects, items, vec![], "2026-06-30", "2026-07-02");
        let ids: Vec<_> = data.delegated.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
    }
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd src-tauri && cargo test assemble_sidebar_fills_delegated -- --nocapture`
Expected: FAIL — `data.delegated`가 아직 존재하지 않아 컴파일 에러

- [ ] **Step 3: 최소 구현 작성**

`src-tauri/src/commands.rs:3`의 import에 `filter_delegated_visible` 추가:

```rust
use crate::plane_api::{self, filter_assigned_visible, filter_delegated_visible, plain_text_to_description_html, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
```

`SidebarData` 구조체(64-77번 줄)에 필드 추가:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    /// 내가 만들었지만 담당자가 아닌 작업("내가 할당한 작업" 탭). 완료
    /// 항목의 날짜창은 적용되지 않은 전체 목록 — 필터링은 프론트엔드가 한다.
    #[serde(default)]
    pub delegated: Vec<WorkItemDto>,
    /// `delegated`에 속한 작업들의 담당자 이름 해결용. 프로젝트 간 중복은
    /// id 기준으로 제거되어 있다.
    #[serde(default)]
    pub delegated_members: Vec<MemberDto>,
    pub states: Vec<StateDto>,
    #[serde(default)]
    pub is_cached: bool,
    #[serde(default)]
    pub cached_at_ms: Option<u64>,
}
```

`assemble_sidebar` 함수(79-107번 줄)를 수정 — `items`를 clone해서 `delegated`도 계산:

```rust
pub fn assemble_sidebar(
    user_id: &str,
    projects: Vec<Project>,
    items: Vec<WorkItem>,
    states: Vec<ProjectState>,
    completed_after: &str,
    completed_before: &str,
) -> SidebarData {
    let delegated = filter_delegated_visible(items.clone(), user_id)
        .into_iter()
        .map(work_item_to_dto)
        .collect();
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(work_item_to_dto)
        .collect();
    let projects = projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect();
    let states = states
        .into_iter()
        .map(|s| StateDto { id: s.id, group: s.group, project_id: s.project_id, default: s.default })
        .collect();
    SidebarData {
        projects, assigned, delegated,
        delegated_members: Vec::new(), // fetch_sidebar_data_online이 채운다 (Task 3)
        states, is_cached: false, cached_at_ms: None,
    }
}

fn work_item_to_dto(w: WorkItem) -> WorkItemDto {
    WorkItemDto {
        id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
        start_date: w.start_date,
        state_group: w.state_group, project_id: w.project_id,
        assignee_ids: w.assignee_ids,
        completed_at: w.completed_at,
        created_at: w.created_at, updated_at: w.updated_at,
    }
}
```

(기존 `assigned`를 만들던 인라인 `.map(|w| WorkItemDto { ... })` 클로저를
`work_item_to_dto` 함수로 뽑아 `assigned`/`delegated` 둘 다 재사용한다 —
같은 변환 로직을 두 번 쓰지 않기 위해.)

테스트 헬퍼(979-997번 줄)의 `wi`/`wi_completed`는 이미 `created_by: None`을
설정하므로 그대로 두고, 위 Step 1에서 쓴 것처럼 개별 테스트에서
`item.created_by = Some(...)`로 덮어쓴다(가변 바인딩이 필요하므로
`let mut item = wi(...)` 형태 — 기존 `assemble_sidebar_carries_updated_at_into_work_item_dto` 테스트가 이미 이 패턴을 쓰고 있다).

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd src-tauri && cargo test assemble_sidebar -- --nocapture`
Expected: PASS (기존 assemble_sidebar 테스트 전부 + 신규 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: compute delegated work items in assemble_sidebar"
```

---

### Task 3: Rust — 위임 작업 담당자 이름 해결 (`fetch_sidebar_data_online`)

**Files:**
- Modify: `src-tauri/src/commands.rs:1` (import에 `HashMap`, `HashSet`, `Member` 추가)
- Modify: `src-tauri/src/commands.rs:358-378` (`fetch_sidebar_data_online`)

**Interfaces:**
- Consumes: `client.list_members(project_id: &str) -> Result<Vec<Member>, String>` (기존, `plane_api.rs:424`), `Member { id: String, display_name: String }` (기존, `plane_api.rs:42`)
- Produces: `SidebarData.delegated_members`를 실제 이름으로 채운 결과. Task 4(프론트엔드)가 이 배열을 소비한다.

이 작업은 네트워크 호출(async)이 얽혀 있어 순수 단위 테스트로 감쌀 수 없다
— 기존 코드도 `fetch_sidebar_data_online`의 프로젝트 루프(이슈/상태 조회)
자체는 테스트하지 않고 `assemble_sidebar`(순수 함수)만 테스트한다. 이
태스크도 같은 관례를 따른다: 코드 작성 후 `cargo build`로 컴파일만
검증하고, Task 6에서 실제 앱 실행으로 동작을 확인한다.

- [ ] **Step 1: import 추가**

`src-tauri/src/commands.rs:1` 근처에 추가:

```rust
use std::collections::HashSet;
use crate::plane_api::Member;
```

- [ ] **Step 2: `fetch_sidebar_data_online` 수정**

`src-tauri/src/commands.rs:358-378`을 다음으로 교체:

```rust
async fn fetch_sidebar_data_online(
    client: &PlaneClient,
    completed_after: &str,
    completed_before: &str,
) -> Result<SidebarData, String> {
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    let mut all_states: Vec<ProjectState> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
        match client.list_states(&p.id).await {
            Ok(mut states) => all_states.append(&mut states),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
    }
    let mut data = assemble_sidebar(&user.id, projects, all_items, all_states, completed_after, completed_before);
    data.delegated_members = fetch_delegated_members(client, &data.delegated, &user.id).await;
    Ok(data)
}

/// `delegated`에 등장하는 프로젝트에 한해서만(전체 프로젝트가 아니라)
/// 멤버 목록을 조회해 이름을 해결한다 — 위임 작업이 없으면 추가 API 호출도
/// 없다. 같은 사용자가 여러 프로젝트에 걸쳐 나오면 id 기준으로 dedupe한다.
/// 멤버 조회가 실패한 프로젝트는 조용히 건너뛴다(items/states 루프와 같은
/// 관례) — 실패해도 프론트엔드가 "알 수 없음"으로 폴백하므로 안전하다.
async fn fetch_delegated_members(
    client: &PlaneClient,
    delegated: &[WorkItemDto],
    my_id: &str,
) -> Vec<MemberDto> {
    let project_ids: HashSet<&str> = delegated.iter().map(|i| i.project_id.as_str()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<MemberDto> = Vec::new();
    for pid in project_ids {
        let members: Vec<Member> = match client.list_members(pid).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        for m in members {
            if seen.insert(m.id.clone()) {
                let is_me = m.id == my_id;
                out.push(MemberDto { id: m.id, display_name: m.display_name, is_me });
            }
        }
    }
    out
}
```

- [ ] **Step 3: 컴파일 확인**

Run: `cd src-tauri && cargo build`
Expected: 컴파일 성공(경고 없음)

- [ ] **Step 4: 전체 Rust 테스트 통과 확인 (회귀 없음)**

Run: `cd src-tauri && cargo test`
Expected: PASS (기존 테스트 전부 + Task 1/2의 신규 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: resolve delegated task assignee names via list_members"
```

---

### Task 4: TypeScript — `SidebarData` 타입 확장 + `resolveAssigneeName` 헬퍼

**Files:**
- Modify: `src/shared/types.ts:18-21` (`SidebarData` 인터페이스)
- Modify: `src/sidebar/logic.ts` (파일 끝에 함수 추가)
- Modify: `src/sidebar/logic.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `Member { id: string; display_name: string; is_me: boolean }` (기존, `src/shared/types.ts:2`)
- Produces: `resolveAssigneeName(names: Map<string, string>, id: string): string` — Task 6(main.ts)이 담당자 칩 렌더링에 사용한다. `SidebarData.delegated: WorkItem[]`, `SidebarData.delegated_members: Member[]` — Task 6이 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/sidebar/logic.test.ts` 끝에 추가:

```typescript
describe("resolveAssigneeName", () => {
  it("returns the mapped display name when the id is known", () => {
    const names = new Map([["u1", "재석"]]);
    expect(resolveAssigneeName(names, "u1")).toBe("재석");
  });

  it("falls back to 알 수 없음 when the id isn't in the map", () => {
    const names = new Map([["u1", "재석"]]);
    expect(resolveAssigneeName(names, "missing")).toBe("알 수 없음");
  });
});
```

`import` 줄(1번 줄)에 `resolveAssigneeName` 추가:

```typescript
import { buildIssueUrl, computeSidebarGeometry, filterByPriority, filterBySearch, filterByStateGroup, filterHiddenCompleted, filterVisibleToday, formatDateRange, formatLocalTime, formatRelativeTime, groupItemsByProject, groupProgress, isCompletedToday, offlineStatusText, resolveAssigneeName, resolveStateId } from "./logic";
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pnpm test -- logic.test.ts`
Expected: FAIL — `resolveAssigneeName` is not exported from "./logic"

- [ ] **Step 3: 최소 구현 작성**

`src/shared/types.ts:18-21`의 `SidebarData`를 다음으로 교체:

```typescript
export interface SidebarData {
  projects: Project[]; assigned: WorkItem[]; delegated: WorkItem[]; delegated_members: Member[];
  states: ProjectState[]; is_cached: boolean; cached_at_ms: number | null;
}
```

`src/sidebar/logic.ts` 파일 끝에 추가:

```typescript
/** `delegated_members`로 만든 id→이름 맵에서 담당자 이름을 찾는다. 맵에
 *  없는 id(예: 멤버가 프로젝트에서 제외된 경우)는 "알 수 없음"으로 폴백한다. */
export function resolveAssigneeName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? "알 수 없음";
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pnpm test -- logic.test.ts`
Expected: PASS (전체 logic.test.ts)

- [ ] **Step 5: 타입 체크**

Run: `pnpm build`
Expected: 성공 — `SidebarData` 필드 변경으로 인한 타입 에러가 없어야 함 (있다면 Task 6에서 `main.ts`가 아직 새 필드를 안 써서 나는 것이 아니라, 기존 코드가 `SidebarData`를 구조분해 하는 곳에서 나는 문제이므로 여기서 먼저 잡는다)

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "feat: add delegated fields to SidebarData type, add resolveAssigneeName"
```

---

### Task 5: HTML/CSS — 탭 바 + "오늘만 보기" 토글 마크업

**Files:**
- Modify: `src/sidebar/index.html:10-40`
- Modify: `src/shared/app.css` (249번 줄 근처, `.sb-section .h` 블록 뒤에 추가)

**Interfaces:**
- Produces: DOM 엘리먼트 id `sbTabs`(탭 바 컨테이너), `.sb-tab[data-tab="assigned"|"delegated"]`, `assignedTabCount`, `delegatedTabCount`, `sectionTitle`, `showAllDelegated` — Task 6(main.ts)이 이 id들로 엘리먼트를 찾아 바인딩한다.

이 태스크는 순수 마크업/스타일이라 자동 테스트 대상이 아니다(기존
`index.html`/`app.css`도 테스트되지 않음). 브라우저 렌더링 확인은 Task 6
완료 후 앱을 띄워서 함께 한다.

- [ ] **Step 1: 탭 바 마크업 추가**

`src/sidebar/index.html:18` (`.sb-head` 닫는 태그 바로 다음) 뒤에 삽입:

```html
      <div class="sb-tabs" id="sbTabs">
        <button type="button" class="sb-tab active" data-tab="assigned">담당 작업 <span class="count" id="assignedTabCount">0</span></button>
        <button type="button" class="sb-tab" data-tab="delegated">내가 할당한 작업 <span class="count" id="delegatedTabCount">0</span></button>
      </div>
```

- [ ] **Step 2: 섹션 헤더에 id 추가 + "오늘만 보기" 토글 버튼 추가**

`src/sidebar/index.html:34-40`을 다음으로 교체:

```html
          <div class="h">
            <span id="sectionTitle">나에게 할당된 작업</span>
            <span class="h-tools">
              <span id="showAllDelegated" class="h-toggle" hidden></span>
              <span id="hideDone" class="h-toggle"></span>
              <span id="taskCount" class="count">0</span>
            </span>
          </div>
```

- [ ] **Step 3: 탭 바 CSS 추가**

`src/shared/app.css:264`(`.h-toggle svg { ... }` 다음 줄) 뒤에 추가:

```css
.sb-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border); }
.sb-tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 6px; margin-bottom: -1px; border: none; background: none; cursor: pointer;
  font-size: 12px; color: var(--muted); font-family: inherit;
  border-bottom: 2px solid transparent;
}
.sb-tab:hover { color: var(--text); }
.sb-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.sb-tab .count { color: inherit; opacity: .7; font-size: 10.5px; }
```

- [ ] **Step 4: 빌드 확인**

Run: `pnpm build`
Expected: 성공 (마크업/CSS만 바뀌었으므로 타입 에러 없음)

- [ ] **Step 5: 커밋**

```bash
git add src/sidebar/index.html src/shared/app.css
git commit -m "feat: add tab bar and today-only toggle markup for delegated view"
```

---

### Task 6: TypeScript — 탭 전환/토글 로직 + 담당자 칩 렌더링 (`main.ts`)

**Files:**
- Modify: `src/sidebar/main.ts:53-54` (module 상태 변수)
- Modify: `src/sidebar/main.ts:89` 이후 (탭/토글 상태 + 바인딩 추가)
- Modify: `src/sidebar/main.ts:481-585` (`renderTaskRow` — 담당자 칩 추가)
- Modify: `src/sidebar/main.ts:835-856` (`runRefresh` — `lastSidebarData`/`delegatedMemberNames` 저장, 탭 카운트 갱신, 렌더 호출 교체)

**Interfaces:**
- Consumes: `SidebarData.delegated`, `SidebarData.delegated_members` (Task 4), `resolveAssigneeName(names, id)` (Task 4), `filterVisibleToday` (기존, `logic.ts`), `colorForId` (기존, `shared/color.ts`)

이 파일은 기존에도 단위 테스트가 없다(DOM 바인딩 위주 — 순수 로직은
`logic.ts`로 이미 분리되어 있음). 이 태스크는 TDD 사이클 대신 Step
마지막에 `pnpm build` + 수동 실행 확인으로 검증한다.

- [ ] **Step 1: 모듈 상태 변수 추가**

`src/sidebar/main.ts:54`(`let lastProjects: Project[] = [];`) 다음 줄에 추가:

```typescript
let lastSidebarData: SidebarData | null = null;
let delegatedMemberNames = new Map<string, string>();

const ACTIVE_TAB_KEY = "sidebarActiveTab";
type SidebarTab = "assigned" | "delegated";
let activeTab: SidebarTab = localStorage.getItem(ACTIVE_TAB_KEY) === "delegated" ? "delegated" : "assigned";

const DELEGATED_SHOW_ALL_KEY = "delegatedShowAll";
let delegatedShowAll = localStorage.getItem(DELEGATED_SHOW_ALL_KEY) === "1";
```

`main.ts:9`의 `logic` import에 `resolveAssigneeName` 추가(이미 Task 4에서
`logic.ts`가 export하도록 만들어둠):

```typescript
import { buildIssueUrl, computeSidebarGeometry, filterByPriority, filterBySearch, filterByStateGroup, filterHiddenCompleted, filterVisibleToday, formatDateRange, formatLocalTime, formatRelativeTime, groupItemsByProject, groupProgress, offlineStatusText, resolveAssigneeName, resolveStateId } from "./logic";
```

`main.ts:7`의 `colorForId` import는 이미 존재하므로 그대로 재사용한다.

- [ ] **Step 2: 탭/토글 DOM 바인딩과 렌더 함수 추가**

`src/sidebar/main.ts:89`(`hideDoneEl.onclick = ...` 블록이 끝나는 줄) 다음에 추가:

```typescript
const sectionTitleEl = document.getElementById("sectionTitle")!;
const showAllDelegatedEl = document.getElementById("showAllDelegated")!;
const assignedTabCountEl = document.getElementById("assignedTabCount")!;
const delegatedTabCountEl = document.getElementById("delegatedTabCount")!;
const tabEls = Array.from(document.querySelectorAll<HTMLButtonElement>(".sb-tab"));

function syncShowAllDelegatedButton() {
  showAllDelegatedEl.hidden = activeTab !== "delegated";
  showAllDelegatedEl.classList.toggle("active", delegatedShowAll);
  showAllDelegatedEl.innerHTML = delegatedShowAll ? `${EYE_OFF_ICON}<span>전체보기</span>` : `${EYE_ICON}<span>오늘만</span>`;
  showAllDelegatedEl.title = delegatedShowAll ? "클릭하면 오늘 근처 항목만 봅니다" : "클릭하면 기한과 무관하게 전체를 봅니다";
}

// 탭/토글 전환은 이미 받은 SidebarData를 재필터링할 뿐, fetchSidebarData를
// 다시 부르지 않는다 — 오프라인에서도 즉시 전환되고 서버 부하도 없다.
function renderActiveTabView() {
  if (!lastSidebarData) return;
  sectionTitleEl.textContent = activeTab === "assigned" ? "나에게 할당된 작업" : "내가 할당한 작업";
  syncShowAllDelegatedButton();
  const items = activeTab === "assigned"
    ? filterVisibleToday(lastSidebarData.assigned)
    : delegatedShowAll
      ? lastSidebarData.delegated
      : filterVisibleToday(lastSidebarData.delegated);
  renderTasks(items, lastSidebarData.projects);
}

tabEls.forEach((btn) => {
  btn.onclick = () => {
    const tab = btn.dataset.tab as SidebarTab;
    if (tab === activeTab) return;
    activeTab = tab;
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
    tabEls.forEach((b) => b.classList.toggle("active", b === btn));
    renderActiveTabView();
  };
});

showAllDelegatedEl.onclick = () => {
  delegatedShowAll = !delegatedShowAll;
  localStorage.setItem(DELEGATED_SHOW_ALL_KEY, delegatedShowAll ? "1" : "0");
  renderActiveTabView();
};
```

- [ ] **Step 3: `runRefresh`가 `lastSidebarData`/담당자 맵을 채우고 탭 뷰를 그리도록 교체**

`src/sidebar/main.ts:845-849`의 다음 블록:

```typescript
    const data: SidebarData = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    states = data.states;
    renderTasks(filterVisibleToday(data.assigned), data.projects);
    synced.textContent = offlineStatusText(data.is_cached, data.cached_at_ms, pendingCount, Date.now());
    refreshInbox();
```

를 다음으로 교체:

```typescript
    const data: SidebarData = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    states = data.states;
    lastSidebarData = data;
    delegatedMemberNames = new Map(data.delegated_members.map((m) => [m.id, m.display_name]));
    assignedTabCountEl.textContent = String(filterVisibleToday(data.assigned).length);
    delegatedTabCountEl.textContent = String(data.delegated.length);
    renderActiveTabView();
    synced.textContent = offlineStatusText(data.is_cached, data.cached_at_ms, pendingCount, Date.now());
    refreshInbox();
```

- [ ] **Step 4: `renderTaskRow`에 담당자 칩 추가**

`src/sidebar/main.ts:573-575`(날짜 칩을 `chips.appendChild(dateChip)`으로
넣는 `else` 블록이 끝나는 지점) 바로 다음, `el.appendChild(chips)` 이전에
삽입:

```typescript
  if (activeTab === "delegated" && it.assignee_ids.length > 0) {
    const [firstId, ...restIds] = it.assignee_ids;
    const name = resolveAssigneeName(delegatedMemberNames, firstId);
    const assigneeChip = document.createElement("span");
    assigneeChip.className = "chip sm";
    assigneeChip.title = "담당자";
    assigneeChip.innerHTML =
      `<span class="avatar" style="background:${colorForId(firstId)}">${name.slice(0, 1)}</span>` +
      name + (restIds.length > 0 ? ` +${restIds.length}` : "");
    chips.appendChild(assigneeChip);
  }
```

정리하면 `renderTaskRow`의 마지막 부분은:

```typescript
  chips.appendChild(dateChip); // (완료가 아닌 경우의 기존 코드)
  }
  if (activeTab === "delegated" && it.assignee_ids.length > 0) {
    // ...위 블록...
  }
  el.appendChild(chips);
```

- [ ] **Step 5: 타입/빌드 확인**

Run: `pnpm build`
Expected: 성공, 타입 에러 없음

- [ ] **Step 6: 전체 테스트 확인 (회귀 없음)**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: 수동 확인**

Run: `pnpm tauri dev` (또는 기존 개발 실행 방법)
확인 항목:
- 사이드바 상단에 "담당 작업"/"내가 할당한 작업" 탭이 보이는지
- "내가 할당한 작업" 탭 클릭 시 API 재호출 없이(네트워크 탭/로그로 확인)
  즉시 목록이 바뀌는지, 각 카드에 담당자 칩(색상 원 + 이름)이 보이는지
- "오늘만" / "전체보기" 토글이 목록을 바꾸는지
- 앱을 껐다 켰을 때 마지막에 선택한 탭이 유지되는지
- 위임 작업이 0건인 프로젝트에서 "위임한 작업이 없습니다" 류의 빈 상태가
  보이는지(기존 `emptyState`/`emptyText` 재사용 여부는 실행해보고 어색하면
  이 스텝에서 텍스트만 조정)

- [ ] **Step 8: 커밋**

```bash
git add src/sidebar/main.ts
git commit -m "feat: wire delegated tab switching and assignee chips in sidebar"
```

---

### Task 7: CHANGELOG + 최종 검증

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### 추가`)

**Interfaces:**
- (없음 — 문서 변경 + 최종 회귀 확인)

- [ ] **Step 1: CHANGELOG 항목 추가**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 추가` 섹션(없으면 새로
만든다)에 한 줄 추가:

```markdown
- 사이드바에 "내가 할당한 작업" 탭을 추가해 다른 사람에게 맡긴 작업의 진척을 확인할 수 있습니다.
```

- [ ] **Step 2: 전체 Rust 테스트**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 3: 전체 TS 테스트**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: 빌드**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 5: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog entry for delegated tasks tab"
```

---

## Self-Review Notes

- **스펙 커버리지**: 핵심 설계 결정 1(created_by 근사치) → Task 1 주석/테스트.
  결정 2(사이드바 탭) → Task 5/6. 결정 3(API 재호출 없음) → Task 6의
  `renderActiveTabView`가 `fetchSidebarData`를 부르지 않음. 데이터/필터 →
  Task 1. 캐시(`#[serde(default)]`) → Task 2. 담당자 이름 해결 → Task 3.
  UI(탭·토글·칩·기본 탭·localStorage 복원) → Task 5/6. 엣지 케이스(0건,
  다중 담당자 "+N", 오프라인) → Task 6 Step 4/7. 테스트 항목 전부 →
  Task 1/2/4. CHANGELOG → Task 7.
- **플레이스홀더 스캔**: 없음 — 모든 스텝에 실제 코드/명령을 그대로 실었다.
- **타입 일관성**: `filter_delegated_visible(items, user_id)` 시그니처가
  Task 1 정의부터 Task 2 호출부까지 동일. `resolveAssigneeName(names, id)`가
  Task 4 정의부터 Task 6 호출부까지 동일. `SidebarData.delegated_members`
  (스네이크 케이스, serde 기본 규칙 그대로 — 이 코드베이스는 camelCase 변환
  없이 Rust 필드명을 그대로 JSON 키로 쓴다. 기존 `is_cached`/`cached_at_ms`도
  동일 패턴)로 Task 2(Rust)와 Task 4(TS 타입)가 일치.
