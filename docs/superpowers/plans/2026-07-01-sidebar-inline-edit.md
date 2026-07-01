# 사이드바 인라인 편집 + 프로젝트 배지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F2 사이드바에서 작업의 상태(5개 대분류)·우선순위를 클릭 한 번으로 바로 변경하고, 프로젝트 행 옆에 "나에게 할당된 미완료" 개수 배지를 표시한다.

**Architecture:** Rust(`PlaneClient`)에 상태 목록 조회(`list_states`)와 워크아이템 PATCH(`update_work_item`)를 추가하고, `fetch_sidebar_data`가 새로고침 시 프로젝트별 states를 함께 실어 보낸다. 프론트(`src/sidebar/main.ts`)는 상태 점/우선순위 텍스트 클릭 시 자리에 팝오버를 띄우고, 선택하면 optimistic하게 로컬 데이터를 바꾼 뒤 새 Tauri 커맨드를 호출하며, 실패 시 롤백한다. 배지 개수는 이미 받아온 `assigned` 목록을 프로젝트별로 group-by만 하면 되므로 새 API가 필요 없다.

**Tech Stack:** Tauri v2 (Rust 백엔드) + 바닐라 TypeScript/Vite 프론트, `reqwest`(HTTP), `wiremock`(Rust 테스트), `vitest`(TS 테스트).

## Global Constraints

- 상태 편집은 5개 대분류(backlog/unstarted/started/completed/cancelled)만 노출 — 프로젝트별 커스텀 상태 이름은 노출하지 않는다.
- 우선순위는 5개 값(urgent/high/medium/low/none)만 노출.
- 프로젝트 배지는 0이어도 **숨기지 않고** 흐리게(`pcount zero`) 표시한다.
- 같은 그룹에 상태가 여러 개인 프로젝트는 Plane states API의 `default: true` 플래그를 가진 것을 우선 사용하고, 없으면 첫 번째 것을 사용한다.
- 상태 목록(`states`)은 사이드바 새로고침(`fetch_sidebar_data`) 시 프로젝트/작업항목과 함께 가져온다 — 드롭다운을 열 때 별도 요청을 하지 않는다.
- 우선순위 아이콘은 lucide-static(ISC 라이선스) 아이콘을 그대로 사용한다: urgent→AlertCircle, high→SignalHigh, medium→SignalMedium, low→SignalLow, none→Ban.
- 상태 아이콘은 Plane `packages/propel/src/icons/state/*`(AGPL-3.0-only) 소스를 포팅한 것이다 — 포함하는 각 파일 상단에 원본 경로와 SPDX 식별자를 주석으로 남긴다 (개인용 앱이라 승인됨; 배포/공유 시 재검토 필요).
- PATCH 실패 시 UI 값을 이전 값으로 롤백하고 사이드바 하단 `synced` 텍스트에 짧은 에러 메시지를 표시한다 (재시도 큐 없음).
- 관련 스펙: [`docs/superpowers/specs/2026-07-01-sidebar-inline-edit-design.md`](../specs/2026-07-01-sidebar-inline-edit-design.md), 확정 목업: [`docs/mockups/sidebar-inline-edit-mockup.html`](../../mockups/sidebar-inline-edit-mockup.html)

---

## File Structure

**Rust (백엔드):**
- Modify `src-tauri/src/plane_api.rs` — `RawState`에 `id`/`default` 필드 추가, 새 `State` 구조체, `PlaneClient::list_states()`, `PlaneClient::update_work_item()`
- Modify `src-tauri/src/commands.rs` — `StateDto`, `SidebarData.states`, `assemble_sidebar` 시그니처 확장, `fetch_sidebar_data`가 states도 가져오도록 수정, 새 커맨드 `update_work_item_priority`/`update_work_item_state`
- Modify `src-tauri/src/lib.rs` — 새 커맨드 2개를 `invoke_handler!`에 등록

**TypeScript (프론트, F1 QuickAdd/F2 Sidebar 등 여러 창에서 재사용 가능하도록 공용 모듈로 분리):**
- Modify `src/shared/types.ts` — `State` 타입 추가, `SidebarData.states` 추가
- Modify `src/shared/ipc.ts` — `updateWorkItemPriority`, `updateWorkItemState` 래퍼 추가
- Create `src/shared/icons/priority.ts` + `src/shared/icons/priority.test.ts` — lucide 아이콘 기반 우선순위 색상/SVG
- Create `src/shared/icons/state.ts` + `src/shared/icons/state.test.ts` — Plane propel 포팅 상태 아이콘
- Create `src/shared/icons/index.ts` — 위 두 모듈 re-export
- Create `src/sidebar/logic.ts` + `src/sidebar/logic.test.ts` — 순수 함수: 프로젝트별 배지 카운트 집계, group→stateId 매핑
- Modify `src/shared/app.css` — 팝오버(`.pop`/`.pop-item`)·아이콘 버튼(`.icon-btn`)·배지 zero 스타일 추가, 이제 안 쓰는 `.state-dot`류 제거
- Modify `src/sidebar/main.ts` — 배지 렌더링 + 아이콘 기반 상태/우선순위 팝오버 편집 배선

---

### Task 1: `plane_api.rs` — 프로젝트별 상태 목록 조회 (`list_states`)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces: `pub struct State { pub id: String, pub group: String, pub project_id: String, pub default: bool }`, `pub async fn PlaneClient::list_states(&self, project_id: &str) -> Result<Vec<State>, String>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/plane_api.rs`의 `#[cfg(test)] mod tests` 블록 안, `list_work_items_parses_expanded_state_and_assignees` 테스트 뒤에 추가:

```rust
    #[tokio::test]
    async fn list_states_parses_id_group_and_default() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/states/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "s1", "name": "Backlog", "group": "backlog", "default": false },
                    { "id": "s2", "name": "In Progress", "group": "started", "default": true },
                    { "id": "s3", "name": "In Review", "group": "started", "default": false }
                ]
            })))
            .mount(&server)
            .await;

        let states = client_for(&server).await.list_states("p1").await.unwrap();
        assert_eq!(states.len(), 3);
        assert_eq!(states[0].id, "s1");
        assert_eq!(states[0].group, "backlog");
        assert_eq!(states[0].project_id, "p1");
        assert!(!states[0].default);
        assert!(states[1].default);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test list_states_parses_id_group_and_default`
Expected: FAIL — `list_states` method가 존재하지 않아 컴파일 에러 (`no method named `list_states` found`)

- [ ] **Step 3: `RawState`에 필드 추가하고 `State`/`list_states` 구현**

`RawState` 정의를 다음으로 교체 (기존: `struct RawState { #[serde(default)] group: String }`):

```rust
#[derive(Deserialize)]
struct RawState {
    #[serde(default)] id: String,
    #[serde(default)] group: String,
    #[serde(default)] default: bool,
}
```

`WorkItem`/`Project` 구조체 정의 뒤(파일 상단 struct 영역)에 추가:

```rust
#[derive(Debug, Clone)]
pub struct State { pub id: String, pub group: String, pub project_id: String, pub default: bool }
```

`PlaneClient` impl 블록 안, `list_work_items` 메서드 뒤에 추가:

```rust
    pub async fn list_states(&self, project_id: &str) -> Result<Vec<State>, String> {
        let url = format!("{}/projects/{}/states/?per_page=100", self.ws_base(), project_id);
        let page: Paginated<RawState> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|s| State { id: s.id, group: s.group, project_id: project_id.to_string(), default: s.default })
            .collect())
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test list_states_parses_id_group_and_default`
Expected: PASS

- [ ] **Step 5: 전체 plane_api 테스트 통과 확인 (회귀 없음)**

Run: `cd src-tauri && cargo test --lib plane_api::`
Expected: 모든 기존 테스트(`filter_keeps_my_open_items_only`, `list_projects_parses_results_and_sends_api_key`, `list_work_items_parses_expanded_state_and_assignees`, `create_work_item_assigns_creator`, `current_user_parses_id`)와 새 테스트 PASS

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add list_states for per-project state groups"
```

---

### Task 2: `plane_api.rs` — 워크아이템 PATCH (`update_work_item`)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Consumes: 없음 (Task 1과 독립)
- Produces: `pub async fn PlaneClient::update_work_item(&self, project_id: &str, item_id: &str, body: serde_json::Value) -> Result<(), String>`

- [ ] **Step 1: 실패하는 테스트 작성**

`create_work_item_assigns_creator` 테스트 뒤에 추가:

```rust
    #[tokio::test]
    async fn update_work_item_sends_patch_with_body() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "priority": "high" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .update_work_item("p1", "i1", serde_json::json!({ "priority": "high" }))
            .await
            .unwrap();
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test update_work_item_sends_patch_with_body`
Expected: FAIL — `update_work_item` method not found

- [ ] **Step 3: 구현**

`PlaneClient` impl 블록 안, `create_work_item` 메서드 뒤에 추가:

```rust
    pub async fn update_work_item(
        &self,
        project_id: &str,
        item_id: &str,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/", self.ws_base(), project_id, item_id);
        self.http
            .patch(&url)
            .header("X-Api-Key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test update_work_item_sends_patch_with_body`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add update_work_item PATCH method"
```

---

### Task 3: `commands.rs` — `StateDto` + `SidebarData.states` + `assemble_sidebar` 확장

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `crate::plane_api::State { id, group, project_id, default }` (Task 1)
- Produces: `pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }`, `SidebarData { projects, assigned, states: Vec<StateDto> }`, `pub fn assemble_sidebar(user_id: &str, projects: Vec<Project>, items: Vec<WorkItem>, states: Vec<State>) -> SidebarData`

- [ ] **Step 1: 실패하는 테스트 작성 (기존 테스트를 새 시그니처로 확장)**

`commands.rs` 맨 아래 `#[cfg(test)] mod tests`의 `use` 문을 다음으로 교체:

```rust
    use crate::plane_api::{Project, State, WorkItem};
```

`assemble_filters_to_my_open_items_across_projects` 테스트를 다음으로 교체:

```rust
    #[test]
    fn assemble_filters_to_my_open_items_across_projects() {
        let projects = vec![
            Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() },
            Project { id: "p2".into(), name: "Mob".into(), identifier: "MOB".into() },
        ];
        let items = vec![
            wi("a", "started", &["me"], "p1"),
            wi("b", "completed", &["me"], "p1"),
            wi("c", "backlog", &["me"], "p2"),
            wi("d", "started", &["other"], "p2"),
        ];
        let states = vec![
            State { id: "s1".into(), group: "started".into(), project_id: "p1".into(), default: true },
        ];
        let data = assemble_sidebar("me", projects, items, states);
        assert_eq!(data.projects.len(), 2);
        let ids: Vec<_> = data.assigned.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
        assert_eq!(data.states.len(), 1);
        assert_eq!(data.states[0].id, "s1");
        assert_eq!(data.states[0].project_id, "p1");
        assert!(data.states[0].default);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test assemble_filters_to_my_open_items_across_projects`
Expected: FAIL — `assemble_sidebar`가 인자 3개만 받아 컴파일 에러

- [ ] **Step 3: 구현**

파일 상단 `use` 문 교체:

```rust
use crate::plane_api::{filter_assigned_open, PlaneClient, Project, State, WorkItem};
```

`WorkItemDto` 뒤에 `StateDto` 추가:

```rust
#[derive(Serialize)]
pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }
```

`SidebarData`를 다음으로 교체:

```rust
#[derive(Serialize)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    pub states: Vec<StateDto>,
}
```

`assemble_sidebar`를 다음으로 교체:

```rust
pub fn assemble_sidebar(
    user_id: &str,
    projects: Vec<Project>,
    items: Vec<WorkItem>,
    states: Vec<State>,
) -> SidebarData {
    let assigned = filter_assigned_open(items, user_id)
        .into_iter()
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            state_group: w.state_group, project_id: w.project_id,
        })
        .collect();
    let projects = projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect();
    let states = states
        .into_iter()
        .map(|s| StateDto { id: s.id, group: s.group, project_id: s.project_id, default: s.default })
        .collect();
    SidebarData { projects, assigned, states }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test --lib commands::`
Expected: PASS (이 파일의 모든 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): add states to SidebarData and assemble_sidebar"
```

---

### Task 4: `commands.rs` — `fetch_sidebar_data`에 states 포함 + 편집 커맨드 2개

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `PlaneClient::list_states` (Task 1), `PlaneClient::update_work_item` (Task 2), `assemble_sidebar(.., states: Vec<State>)` (Task 3)
- Produces: `#[tauri::command] pub async fn update_work_item_priority(app, project_id: String, item_id: String, priority: String) -> Result<(), String>`, `#[tauri::command] pub async fn update_work_item_state(app, project_id: String, item_id: String, state_id: String) -> Result<(), String>`

이 태스크는 얇은 커맨드 배선이라 전용 단위 테스트 없이 컴파일 확인으로 검증한다 (기존 `create_issue`/`get_settings` 커맨드와 동일한 패턴).

- [ ] **Step 1: `fetch_sidebar_data` 수정**

`fetch_sidebar_data` 함수 전체를 다음으로 교체:

```rust
#[tauri::command]
pub async fn fetch_sidebar_data(app: tauri::AppHandle) -> Result<SidebarData, String> {
    let (client, _s) = client(&app)?;
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    let mut all_states: Vec<State> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
        match client.list_states(&p.id).await {
            Ok(mut states) => all_states.append(&mut states),
            Err(_) => {} // states are best-effort; edit UI just won't resolve for this project
        }
    }
    Ok(assemble_sidebar(&user.id, projects, all_items, all_states))
}
```

- [ ] **Step 2: 편집 커맨드 2개 추가**

`fetch_sidebar_data` 뒤에 추가:

```rust
#[tauri::command]
pub async fn update_work_item_priority(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    priority: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client
        .update_work_item(&project_id, &item_id, serde_json::json!({ "priority": priority }))
        .await
}

#[tauri::command]
pub async fn update_work_item_state(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    state_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client
        .update_work_item(&project_id, &item_id, serde_json::json!({ "state": state_id }))
        .await
}
```

- [ ] **Step 3: 컴파일 + 전체 테스트 확인**

Run: `cd src-tauri && cargo build && cargo test`
Expected: 빌드 성공, 모든 테스트 PASS

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): fetch states on sidebar refresh; add priority/state update commands"
```

---

### Task 5: `lib.rs` — 새 커맨드 등록

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `commands::update_work_item_priority`, `commands::update_work_item_state` (Task 4)

- [ ] **Step 1: `invoke_handler!` 목록에 추가**

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::update_work_item_priority,
            commands::update_work_item_state
        ])
```

- [ ] **Step 2: 빌드 + 전체 Rust 테스트 확인**

Run: `cd src-tauri && cargo build && cargo test`
Expected: 빌드 성공, 모든 테스트 PASS (이 시점에 전체 Rust 사이드 작업 완료)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: register update_work_item_priority/state Tauri commands"
```

---

### Task 6: `src/shared/types.ts` — `State` 타입 + `SidebarData.states`

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `export interface State { id: string; group: string; project_id: string; default: boolean; }`, `SidebarData.states: State[]`

이 파일은 순수 타입 선언이라 전용 테스트가 없다 (기존 `types.ts`도 테스트 없음) — `pnpm build`(tsc) 통과로 검증.

- [ ] **Step 1: 타입 추가**

`src/shared/types.ts` 전체를 다음으로 교체:

```ts
export interface Project { id: string; name: string; identifier: string; }
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; state_group: string; project_id: string;
}
export interface State { id: string; group: string; project_id: string; default: boolean; }
export interface SidebarData { projects: Project[]; assigned: WorkItem[]; states: State[]; }
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
}
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm build`
Expected: 성공 (이 시점엔 `types.ts`만 바뀌었고 아무도 `states`를 안 쓰므로 에러 없음)

- [ ] **Step 3: 커밋**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add State type and SidebarData.states"
```

---

### Task 7: `src/shared/ipc.ts` — 편집 커맨드 래퍼

**Files:**
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Consumes: Tauri 커맨드 `update_work_item_priority`/`update_work_item_state` (Task 4, 5)
- Produces: `updateWorkItemPriority(project_id: string, item_id: string, priority: string): Promise<void>`, `updateWorkItemState(project_id: string, item_id: string, state_id: string): Promise<void>`

- [ ] **Step 1: 래퍼 추가**

`src/shared/ipc.ts` 맨 끝에 추가:

```ts
export const updateWorkItemPriority = (project_id: string, item_id: string, priority: string) =>
  invoke<void>("update_work_item_priority", { projectId: project_id, itemId: item_id, priority });
export const updateWorkItemState = (project_id: string, item_id: string, state_id: string) =>
  invoke<void>("update_work_item_state", { projectId: project_id, itemId: item_id, stateId: state_id });
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 3: 커밋**

```bash
git add src/shared/ipc.ts
git commit -m "feat(ipc): add updateWorkItemPriority/updateWorkItemState wrappers"
```

---

### Task 8: `src/shared/icons/priority.ts` — 우선순위 아이콘 (lucide, ISC)

**Files:**
- Create: `src/shared/icons/priority.ts`
- Test: `src/shared/icons/priority.test.ts`

**Interfaces:**
- Produces: `priorityColor(priority: string): string`, `priorityIconSvg(priority: string): string`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/icons/priority.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { priorityColor, priorityIconSvg } from "./priority";

describe("priorityColor", () => {
  it("returns the mapped hex color for each known priority", () => {
    expect(priorityColor("urgent")).toBe("#D7443E");
    expect(priorityColor("high")).toBe("#DB7A2A");
    expect(priorityColor("medium")).toBe("#D9A916");
    expect(priorityColor("low")).toBe("#3D6FD9");
    expect(priorityColor("none")).toBe("#8C9199");
  });
  it("falls back to none's color for unknown values", () => {
    expect(priorityColor("bogus")).toBe(priorityColor("none"));
  });
});

describe("priorityIconSvg", () => {
  it("returns non-empty svg markup containing the priority's color for every known priority", () => {
    for (const p of ["urgent", "high", "medium", "low", "none"]) {
      const svg = priorityIconSvg(p);
      expect(svg).toContain("<svg");
      expect(svg).toContain(priorityColor(p));
    }
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/shared/icons/priority.test.ts`
Expected: FAIL — `./priority` 모듈이 없음

- [ ] **Step 3: 구현**

`src/shared/icons/priority.ts`:

```ts
// Icon shapes from lucide-static v1.22.0 (ISC license): AlertCircle, SignalHigh,
// SignalMedium, SignalLow, Ban. https://lucide.dev — colors approximate Plane's
// packages/tailwind-config/variables.css --priority-* oklch tokens.

const COLORS: Record<string, string> = {
  urgent: "#D7443E",
  high: "#DB7A2A",
  medium: "#D9A916",
  low: "#3D6FD9",
  none: "#8C9199",
};

const PATHS: Record<string, string> = {
  urgent: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  high: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
  medium: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/>',
  low: '<path d="M2 20h.01"/><path d="M7 20v-4"/>',
  none: '<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>',
};

export function priorityColor(priority: string): string {
  return COLORS[priority] ?? COLORS.none;
}

export function priorityIconSvg(priority: string): string {
  const color = priorityColor(priority);
  const inner = PATHS[priority] ?? PATHS.none;
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/shared/icons/priority.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/shared/icons/priority.ts src/shared/icons/priority.test.ts
git commit -m "feat(icons): add priority icons ported from lucide-static"
```

---

### Task 9: `src/shared/icons/state.ts` — 상태 그룹 아이콘 (Plane propel 포팅, AGPL-3.0)

**Files:**
- Create: `src/shared/icons/state.ts`
- Test: `src/shared/icons/state.test.ts`

**Interfaces:**
- Consumes: 없음 (Task 8과 독립)
- Produces: `stateGroupColor(group: string): string`, `stateGroupIconSvg(group: string): string`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/icons/state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { stateGroupColor, stateGroupIconSvg } from "./state";

describe("stateGroupColor", () => {
  it("maps each known group to its Plane color", () => {
    expect(stateGroupColor("backlog")).toBe("#60646C");
    expect(stateGroupColor("unstarted")).toBe("#60646C");
    expect(stateGroupColor("started")).toBe("#F59E0B");
    expect(stateGroupColor("completed")).toBe("#46A758");
    expect(stateGroupColor("cancelled")).toBe("#9AA4BC");
  });
});

describe("stateGroupIconSvg", () => {
  it("returns non-empty svg markup for every known group", () => {
    for (const g of ["backlog", "unstarted", "started", "completed", "cancelled"]) {
      expect(stateGroupIconSvg(g)).toContain("<svg");
    }
  });
  it("backlog renders all 15 dashed segments (percentage=0)", () => {
    const matches = stateGroupIconSvg("backlog").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(15);
  });
  it("unstarted renders zero dashed segments (solid ring)", () => {
    const matches = stateGroupIconSvg("unstarted").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(0);
  });
  it("completed and cancelled render a single filled path", () => {
    expect(stateGroupIconSvg("completed")).toContain("<path fill=");
    expect(stateGroupIconSvg("cancelled")).toContain("<path fill=");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/shared/icons/state.test.ts`
Expected: FAIL — `./state` 모듈이 없음

- [ ] **Step 3: 구현**

`src/shared/icons/state.ts`:

```ts
// Ported from Plane packages/propel/src/icons/state/{dashed-circle,progress-circle,
// backlog-group-icon,unstarted-group-icon,started-group-icon,completed-group-icon,
// cancelled-group-icon}.tsx — source: C:\WorkSpaces\plane\packages\propel\src\icons\state\
// SPDX-License-Identifier: AGPL-3.0-only (Copyright Plane Software, Inc. and contributors).
// Kept for personal, non-distributed use of plane-tool; revisit AGPL obligations if this
// app is ever shared or distributed. See docs/superpowers/specs/2026-07-01-sidebar-inline-edit-design.md#31.

const CENTER = 8;
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function dashedCircleSegments(color: string, percentage: number, totalSegments = 15): string {
  const angleIncrement = 360 / totalSegments;
  let segments = "";
  for (let i = 0; i < totalSegments; i++) {
    const angle = i * angleIncrement - 90;
    const segmentStartPercentage = (i / totalSegments) * 100;
    if (segmentStartPercentage >= percentage) {
      segments += `<g transform="translate(${CENTER} ${CENTER}) rotate(${angle})"><line x1="5.75" y1="0" x2="6.5" y2="0" stroke="${color}" stroke-width="1.21" stroke-linecap="round"/></g>`;
    }
  }
  return segments;
}

function progressCircle(color: string, strokeWidth: number, dashOffset: number): string {
  return `<circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${dashOffset}" stroke-linecap="round" transform="rotate(-90 ${CENTER} ${CENTER})"/>`;
}

const COLORS: Record<string, string> = {
  backlog: "#60646C",
  unstarted: "#60646C",
  started: "#F59E0B",
  completed: "#46A758",
  cancelled: "#9AA4BC",
};

const COMPLETED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.3587 6.18828C11.6007 5.85214 11.5244 5.38343 11.1882 5.14141C10.8521 4.89938 10.3834 4.97568 10.1414 5.31183L7.03706 9.62335L5.25956 7.97751C4.95563 7.69609 4.4811 7.71434 4.19968 8.01828C3.91826 8.32221 3.93651 8.79673 4.24045 9.07815L6.64045 11.3004C6.79816 11.4464 7.01095 11.5178 7.22481 11.4963C7.43868 11.4749 7.63307 11.3627 7.75865 11.1883L11.3587 6.18828Z"';

const CANCELLED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.1018 4.89826C11.3947 5.19115 11.3947 5.66603 11.1018 5.95892L9.06068 8.00002L11.1018 10.0411C11.3947 10.334 11.3947 10.8089 11.1018 11.1018C10.8089 11.3947 10.334 11.3947 10.0411 11.1018L8.00002 9.06068L5.95892 11.1018C5.66603 11.3947 5.19115 11.3947 4.89826 11.1018C4.60537 10.8089 4.60537 10.334 4.89826 10.0411L6.93936 8.00002L4.89826 5.95892C4.60537 5.66603 4.60537 5.19115 4.89826 4.89826C5.19115 4.60537 5.66603 4.60537 5.95892 4.89826L8.00002 6.93936L10.0411 4.89826C10.334 4.60537 10.8089 4.60537 11.1018 4.89826Z"';

export function stateGroupColor(group: string): string {
  return COLORS[group] ?? COLORS.unstarted;
}

export function stateGroupIconSvg(group: string): string {
  const color = stateGroupColor(group);
  let inner: string;
  switch (group) {
    case "backlog":
      inner = dashedCircleSegments(color, 0);
      break;
    case "started":
      inner =
        dashedCircleSegments(color, 100) +
        `<circle cx="6" cy="6" r="3" stroke-width="1.5" stroke-linecap="round" fill="none" transform="rotate(-90 8 6)" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="0" stroke="${color}"/>` +
        progressCircle(color, 1.5, 0);
      break;
    case "completed":
      inner = `<path fill="${color}" ${COMPLETED_PATH}/>`;
      break;
    case "cancelled":
      inner = `<path fill="${color}" ${CANCELLED_PATH}/>`;
      break;
    case "unstarted":
    default:
      inner = dashedCircleSegments(color, 100) + progressCircle(color, 1.5, 0);
      break;
  }
  return `<svg width="14" height="14" viewBox="0 0 16 16">${inner}</svg>`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/shared/icons/state.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/shared/icons/state.ts src/shared/icons/state.test.ts
git commit -m "feat(icons): port state group icons from Plane propel (AGPL-3.0)"
```

---

### Task 10: `src/shared/icons/index.ts` — 배럴 re-export

**Files:**
- Create: `src/shared/icons/index.ts`

**Interfaces:**
- Consumes: `priority.ts` (Task 8), `state.ts` (Task 9)
- Produces: `import { priorityColor, priorityIconSvg, stateGroupColor, stateGroupIconSvg } from "../shared/icons"`

- [ ] **Step 1: 배럴 파일 작성**

`src/shared/icons/index.ts`:

```ts
export { priorityColor, priorityIconSvg } from "./priority";
export { stateGroupColor, stateGroupIconSvg } from "./state";
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 3: 커밋**

```bash
git add src/shared/icons/index.ts
git commit -m "feat(icons): add barrel export for shared icon module"
```

---

### Task 11: `src/sidebar/logic.ts` — 배지 카운트 집계 + group→stateId 매핑

**Files:**
- Create: `src/sidebar/logic.ts`
- Test: `src/sidebar/logic.test.ts`

**Interfaces:**
- Consumes: `WorkItem`, `State` 타입 (Task 6)
- Produces: `countAssignedByProject(items: WorkItem[]): Record<string, number>`, `resolveStateId(states: State[], projectId: string, group: string): string | undefined`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/sidebar/logic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { State, WorkItem } from "../shared/types";

function wi(id: string, project_id: string): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, state_group: "started", project_id };
}
function st(id: string, group: string, project_id: string, isDefault = false): State {
  return { id, group, project_id, default: isDefault };
}

describe("countAssignedByProject", () => {
  it("counts items per project_id", () => {
    const counts = countAssignedByProject([wi("a", "p1"), wi("b", "p1"), wi("c", "p2")]);
    expect(counts).toEqual({ p1: 2, p2: 1 });
  });
  it("returns an empty object for no items", () => {
    expect(countAssignedByProject([])).toEqual({});
  });
});

describe("resolveStateId", () => {
  const states = [st("s1", "backlog", "p1"), st("s2", "started", "p1"), st("s3", "started", "p2")];

  it("finds the state id matching project and group", () => {
    expect(resolveStateId(states, "p1", "started")).toBe("s2");
  });
  it("returns undefined when no state matches", () => {
    expect(resolveStateId(states, "p1", "completed")).toBeUndefined();
  });
  it("uses the first match when a project has duplicate states in a group and none is default", () => {
    const dup = [...states, st("s4", "started", "p1")];
    expect(resolveStateId(dup, "p1", "started")).toBe("s2");
  });
  it("prefers the state flagged default over the first match", () => {
    const dup = [st("s5", "started", "p1"), st("s6", "started", "p1", true)];
    expect(resolveStateId(dup, "p1", "started")).toBe("s6");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/sidebar/logic.test.ts`
Expected: FAIL — `./logic` 모듈이 없음

- [ ] **Step 3: 구현**

`src/sidebar/logic.ts`:

```ts
import type { State, WorkItem } from "../shared/types";

export function countAssignedByProject(items: WorkItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    counts[it.project_id] = (counts[it.project_id] ?? 0) + 1;
  }
  return counts;
}

export function resolveStateId(states: State[], projectId: string, group: string): string | undefined {
  const matches = states.filter((s) => s.project_id === projectId && s.group === group);
  return (matches.find((s) => s.default) ?? matches[0])?.id;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/sidebar/logic.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "feat(sidebar): add badge count and group-to-state-id resolution logic"
```

---

### Task 12: `src/shared/app.css` — 팝오버/아이콘 버튼 스타일, 배지 zero 상태

**Files:**
- Modify: `src/shared/app.css`

**Interfaces:**
- Produces: CSS 클래스 `.pop`, `.pop-item`, `.pop-item.sel`, `.icon-btn`, `.icon-btn:hover`, `.proj-row .pcount.zero`; 제거: `.state-dot`, `.state-todo`, `.state-prog`, `.state-done`, `.prio.high`, `.prio.med` (더 이상 안 씀 — 아이콘이 인라인 색상을 직접 지정)

CSS만 바뀌므로 전용 테스트 없음 — `pnpm build` 통과 + Task 14 수동 QA로 검증.

- [ ] **Step 1: `.proj-row .pcount` 아래에 zero 변형 추가**

기존:
```css
.proj-row .pcount { margin-left: auto; font-size: 11.5px; color: var(--muted-2); }
```
를 다음으로 교체:
```css
.proj-row .pcount { margin-left: auto; font-size: 11px; font-weight: 700; color: var(--accent); background: var(--accent-soft); padding: 1px 7px; border-radius: 20px; }
.proj-row .pcount.zero { color: var(--muted-2); background: transparent; font-weight: 500; }
```

- [ ] **Step 2: `.task`/상태·우선순위 관련 블록을 아이콘 기반으로 교체**

기존 블록:
```css
.task { display: flex; gap: 10px; padding: 9px 9px; border-radius: 8px; cursor: pointer; }
.task:hover { background: var(--panel-2); }
.state-dot { width: 11px; height: 11px; border-radius: 50%; margin-top: 3px; flex: none; border: 2px solid; }
.state-todo { border-color: var(--muted-2); }
.state-prog { border-color: var(--amber); background: var(--amber); }
.state-done { border-color: var(--green); background: var(--green); }
.task .body { min-width: 0; flex: 1; }
.task .name { font-size: 13.5px; line-height: 1.35; }
.task .meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--muted); }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 5px; background: var(--bg); border: 1px solid var(--border); }
.tag .dot { width: 7px; height: 7px; border-radius: 50%; }
.prio { font-weight: 600; }
.prio.high { color: var(--red); }
.prio.med { color: var(--amber); }
.due { color: var(--muted); }
```
를 다음으로 교체:
```css
.task { display: flex; gap: 10px; padding: 9px 9px; border-radius: 8px; cursor: pointer; position: relative; }
.task:hover { background: var(--panel-2); }
.icon-btn { display: flex; margin-top: 2px; flex: none; cursor: pointer; border-radius: 4px; }
.icon-btn:hover { outline: 1px dashed var(--accent); outline-offset: 2px; }
.task .body { min-width: 0; flex: 1; }
.task .name { font-size: 13.5px; line-height: 1.35; }
.task .meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--muted); }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 5px; background: var(--bg); border: 1px solid var(--border); }
.tag .dot { width: 7px; height: 7px; border-radius: 50%; }
.prio { display: inline-flex; align-items: center; gap: 3px; font-weight: 600; cursor: pointer; }
.due { color: var(--muted); }

.pop { position: absolute; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); padding: 5px; z-index: 40; width: 150px; }
.pop-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--text); }
.pop-item:hover { background: var(--panel-2); }
.pop-item.sel { background: var(--accent-soft); }
```

- [ ] **Step 3: 빌드 확인**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 4: 커밋**

```bash
git add src/shared/app.css
git commit -m "feat(sidebar): style popovers, icon buttons, and zero-count badge"
```

---

### Task 13: `src/sidebar/main.ts` — 프로젝트 배지 렌더링

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `countAssignedByProject` (Task 11), `SidebarData.states` (Task 6)

DOM 렌더링 파일이라 (기존 `main.ts`와 동일하게) 전용 유닛 테스트는 없다 — `pnpm build` + Task 14 수동 QA로 검증.

- [ ] **Step 1: import 추가 및 `renderProjects` 시그니처 변경**

`src/sidebar/main.ts` 상단 import 블록:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { countAssignedByProject } from "./logic";
import type { SidebarData, Project, WorkItem } from "../shared/types";
import "../shared/app.css";
```

`renderProjects` 함수를 다음으로 교체:

```ts
function renderProjects(projects: Project[], counts: Record<string, number>) {
  projCount.textContent = String(projects.length);
  projectsEl.innerHTML = "";
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "proj-row";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(p.id);
    row.appendChild(dot);
    row.appendChild(document.createTextNode(p.name));
    const count = counts[p.id] ?? 0;
    const badge = document.createElement("span");
    badge.className = "pcount" + (count === 0 ? " zero" : "");
    badge.textContent = String(count);
    row.appendChild(badge);
    projectsEl.appendChild(row);
  }
}
```

`refresh()` 안의 `renderProjects(data.projects);` 호출을 다음으로 교체:

```ts
    renderProjects(data.projects, countAssignedByProject(data.assigned));
```

- [ ] **Step 2: 빌드 확인**

Run: `pnpm build`
Expected: 성공 (아직 `renderTasks`는 옛 아이콘 방식이라 `dotClass` 등은 그대로 남아있음 — Task 14에서 정리)

- [ ] **Step 3: 수동 확인**

Run: `pnpm tauri dev`, F2로 사이드바 열기 → 각 프로젝트 행 오른쪽에 개수 배지가 보이는지, 0개인 프로젝트는 흐리게 보이는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add src/sidebar/main.ts
git commit -m "feat(sidebar): render unfinished-assigned-to-me count badge per project"
```

---

### Task 14: `src/sidebar/main.ts` — 상태/우선순위 아이콘 + 클릭 편집 팝오버

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `priorityColor`, `priorityIconSvg`, `stateGroupColor`, `stateGroupIconSvg` (Task 10), `resolveStateId` (Task 11), `updateWorkItemPriority`, `updateWorkItemState` (Task 7)

DOM 렌더링 + 이벤트 배선이라 전용 유닛 테스트는 없다 — `pnpm build` + 수동 QA로 검증 (Plane 인스턴스가 필요한 실제 PATCH 확인 포함).

- [ ] **Step 1: import 및 모듈 상태 추가**

import 블록을 다음으로 교체:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { priorityColor, priorityIconSvg, stateGroupColor, stateGroupIconSvg } from "../shared/icons";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { SidebarData, Project, WorkItem, State } from "../shared/types";
import "../shared/app.css";
```

`let workspace = "";` 뒤에 추가:

```ts
let states: State[] = [];
let openPopover: HTMLElement | null = null;

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const STATE_LABELS: Record<string, string> = {
  backlog: "백로그", unstarted: "시작 전", started: "진행 중", completed: "완료", cancelled: "취소",
};
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "없음",
};

function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}
```

`dotClass` 함수(더 이상 안 씀)를 삭제한다.

- [ ] **Step 2: 팝오버 렌더 헬퍼 추가**

`renderProjects` 함수 뒤, `renderTasks` 함수 앞에 추가:

```ts
function openStatePopover(anchor: HTMLElement, item: WorkItem, onPicked: (group: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.top = "26px";
  pop.style.left = "0px";
  for (const group of STATE_GROUPS) {
    const opt = document.createElement("div");
    opt.className = "pop-item" + (group === item.state_group ? " sel" : "");
    opt.innerHTML = stateGroupIconSvg(group);
    opt.appendChild(document.createTextNode(STATE_LABELS[group]));
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onPicked(group);
    };
    pop.appendChild(opt);
  }
  anchor.appendChild(pop);
  openPopover = pop;
}

function openPriorityPopover(anchor: HTMLElement, item: WorkItem, onPicked: (priority: string) => void) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.top = "22px";
  pop.style.left = "0px";
  for (const p of PRIORITIES) {
    const opt = document.createElement("div");
    opt.className = "pop-item" + (p === item.priority ? " sel" : "");
    opt.style.color = priorityColor(p);
    opt.innerHTML = priorityIconSvg(p);
    opt.appendChild(document.createTextNode(PRIORITY_LABELS[p]));
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onPicked(p);
    };
    pop.appendChild(opt);
  }
  anchor.appendChild(pop);
  openPopover = pop;
}
```

- [ ] **Step 3: `renderTasks`를 아이콘 + 클릭 편집으로 교체**

`renderTasks` 함수 전체를 다음으로 교체:

```ts
function renderTasks(items: WorkItem[]) {
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "task";

    const stateBtn = document.createElement("span");
    stateBtn.className = "icon-btn";
    stateBtn.title = "상태: " + STATE_LABELS[it.state_group];
    stateBtn.innerHTML = stateGroupIconSvg(it.state_group);
    stateBtn.onclick = (e) => {
      e.stopPropagation();
      openStatePopover(stateBtn, it, (group) => {
        const stateId = resolveStateId(states, it.project_id, group);
        if (!stateId) {
          synced.textContent = "상태 변경 실패: 해당 그룹의 상태를 찾을 수 없음";
          return;
        }
        const prev = it.state_group;
        it.state_group = group;
        renderTasks(items);
        updateWorkItemState(it.project_id, it.id, stateId).catch((err) => {
          it.state_group = prev;
          renderTasks(items);
          synced.textContent = "상태 변경 실패: " + err;
          console.error("updateWorkItemState failed:", err);
        });
      });
    };
    el.appendChild(stateBtn);

    const body = document.createElement("div");
    body.className = "body";

    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = it.name;
    body.appendChild(nameEl);

    const meta = document.createElement("div");
    meta.className = "meta";

    const prioEl = document.createElement("span");
    prioEl.className = "prio";
    prioEl.style.color = priorityColor(it.priority);
    prioEl.innerHTML = priorityIconSvg(it.priority);
    const prioLabel = PRIORITY_LABELS[it.priority];
    if (it.priority !== "none" && prioLabel) {
      prioEl.appendChild(document.createTextNode(prioLabel));
    }
    prioEl.onclick = (e) => {
      e.stopPropagation();
      openPriorityPopover(prioEl, it, (priority) => {
        const prev = it.priority;
        it.priority = priority;
        renderTasks(items);
        updateWorkItemPriority(it.project_id, it.id, priority).catch((err) => {
          it.priority = prev;
          renderTasks(items);
          synced.textContent = "우선순위 변경 실패: " + err;
          console.error("updateWorkItemPriority failed:", err);
        });
      });
    };
    meta.appendChild(prioEl);

    if (it.target_date) {
      const dueEl = document.createElement("span");
      dueEl.className = "due";
      dueEl.textContent = "· " + it.target_date;
      meta.appendChild(dueEl);
    }

    body.appendChild(meta);
    el.appendChild(body);

    el.onclick = async () => {
      const url = `${baseUrl}/${workspace}/projects/${it.project_id}/issues/${it.id}`;
      try {
        await openUrl(url);
      } catch (err) {
        synced.textContent = "열기 실패: " + err;
        console.error("openUrl failed:", url, err);
      }
    };

    tasksEl.appendChild(el);
  }
}
```

- [ ] **Step 4: `refresh()`가 `states`를 채우도록 수정, 팝오버 닫기용 전역 리스너 추가**

`refresh()` 함수 안, `const data: SidebarData = await fetchSidebarData();` 다음 줄에 추가:

```ts
    states = data.states;
```

파일 맨 아래, 기존 `document.addEventListener("keydown", ...)` 블록을 다음으로 교체:

```ts
document.getElementById("refresh")!.onclick = refresh;
document.addEventListener("click", () => closePopover());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
    } else {
      win.hide();
    }
  }
});
win.listen("tauri://focus", refresh);
refresh();
```

- [ ] **Step 5: 빌드 및 전체 테스트 확인**

Run: `pnpm build && pnpm test`
Expected: 빌드 성공, 모든 vitest 테스트 PASS

- [ ] **Step 6: 커밋**

```bash
git add src/sidebar/main.ts
git commit -m "feat(sidebar): click-to-edit state/priority popovers with Plane icons"
```

---

### Task 15: 전체 검증 + 수동 QA

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 전체 Rust 테스트**

Run: `cd src-tauri && cargo test`
Expected: 모든 테스트 PASS

- [ ] **Step 2: 전체 TS 테스트 + 빌드**

Run: `pnpm test && pnpm build`
Expected: 모든 vitest 테스트 PASS, 빌드 성공

- [ ] **Step 3: 수동 QA (실제 Plane 워크스페이스 대상)**

Run: `pnpm tauri dev`, F2로 사이드바 오픈 후 확인:
1. 프로젝트별 배지 숫자가 "나에게 할당된 작업" 목록의 실제 개수와 일치하는지, 0개 프로젝트는 흐리게 보이는지
2. 작업 행의 상태 아이콘 클릭 → 5개 그룹 팝오버 → 다른 그룹 선택 → 아이콘이 즉시 바뀌고, Plane 웹에서 새로고침해 실제로 상태가 바뀌었는지 확인
3. 우선순위 아이콘/텍스트 클릭 → 팝오버 → 다른 값 선택 → 같은 방식으로 Plane 웹에서 반영 확인
4. 네트워크를 잠시 끊고 상태/우선순위 변경 시도 → UI가 이전 값으로 롤백되고 `synced`에 실패 메시지가 뜨는지 확인
5. 팝오버가 열린 상태에서 바깥을 클릭하거나 `Esc`를 누르면 팝오버만 닫히고 창은 안 닫히는지, 팝오버가 없을 때 `Esc`는 기존처럼 창을 숨기는지 확인
6. 작업 행에서 아이콘이 아닌 이름 부분을 클릭하면 여전히 브라우저에서 해당 이슈가 열리는지 확인 (기존 동작 유지)

- [ ] **Step 4: 최종 커밋 (필요 시)**

QA 중 발견된 사소한 수정이 있다면:

```bash
git add -A
git commit -m "fix(sidebar): address manual QA findings for inline edit"
```

---

## Self-Review 메모 (작성자용, 실행 시 참고)

- **스펙 커버리지**: 3절(UI/아이콘) → Task 8-14, 4.1(배지)→Task 11+13, 4.2(상태 백엔드)→Task 1,3,4, 4.3(프론트)→Task 6,7,9,11,14, 5절(에러 처리)→Task 14 optimistic rollback + Task 15 Step 3-4, 6절(테스트)→각 태스크 Step 1-2,4. 커버 안 된 스펙 항목 없음.
- **일관성**: `State`/`StateDto`가 Rust와 TS 양쪽에서 `{ id, group, project_id, default }`로 동일. `resolveStateId`가 Task 3에서 확인된 Plane states API의 실제 `default` 플래그를 사용하도록 스펙의 "먼저 나온 것 사용"에서 개선됨(states API 검증 중 확인된 사실 반영).
- **타입 일관성**: `priorityIconSvg`/`stateGroupIconSvg`/`resolveStateId`/`countAssignedByProject` 함수명과 시그니처가 정의된 태스크(8,9,11)와 사용되는 태스크(14, 13)에서 동일하게 유지됨.
