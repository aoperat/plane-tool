# 사이드바 인라인 편집 + 프로젝트 배지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F2 사이드바에서 작업의 상태(5개 대분류)·우선순위를 클릭 한 번으로 바로 변경하고, 프로젝트 행 옆에 "나에게 할당된 미완료" 개수 배지를 표시한다.

**Architecture:** Rust(`PlaneClient`)의 기존 `ProjectState`/`list_states`/`resolve_state_id`(QuickAdd 필드 확장 작업에서 이미 추가됨)를 확장해 `project_id`/`default` 필드를 싣고, 새 `update_work_item` PATCH 메서드를 추가한다. `fetch_sidebar_data`가 새로고침 시 프로젝트별 states를 함께 실어 보낸다. 프론트(`src/sidebar/main.ts`)는 상태 점/우선순위 텍스트 클릭 시 자리에 팝오버를 띄우고, 선택하면 optimistic하게 로컬 데이터를 바꾼 뒤 새 Tauri 커맨드를 호출하며, 실패 시 롤백한다. 아이콘은 QuickAdd가 이미 만든 `src/shared/planeIcons.ts`를 Plane 실제 아이콘으로 업그레이드해 F1/F2 양쪽에서 공유한다. 배지 개수는 이미 받아온 `assigned` 목록을 프로젝트별로 group-by만 하면 되므로 새 API가 필요 없다.

**Tech Stack:** Tauri v2 (Rust 백엔드) + 바닐라 TypeScript/Vite 프론트, `reqwest`(HTTP), `wiremock`(Rust 테스트), `vitest`(TS 테스트).

## ⚠️ 실행 전 필독 — 동시 작업 이력

이 저장소에서 **"QuickAdd 필드 확장"**이라는 별도 계획이 이미 상당 부분 구현되어 master에 커밋되어 있다 (`docs/superpowers/plans/2026-07-01-quickadd-field-expansion.md`, 커밋 `42a568d`~`b4d9a40`). 아래 사항은 그 결과물을 그대로 재사용/확장하는 것을 전제로 한다 — **새로 만들지 말 것**:

- `src-tauri/src/plane_api.rs`: `ProjectState { id, group }`, `Member`, `NewWorkItem`, `resolve_state_id()`, `PlaneClient::list_states()`, `PlaneClient::list_members()`, `PlaneClient::create_work_item(project_id, &NewWorkItem)` — 이미 존재.
- `src-tauri/src/commands.rs`: `create_issue`가 이미 `assignee_ids`/`start_date`/`target_date`/`priority`/`state_group` 전체 필드를 받음. `list_members` 커맨드 존재.
- `src/shared/types.ts`: `Member` 인터페이스 존재. `SidebarData`는 아직 `{ projects, assigned }`만 있음 (여기에 `states` 추가는 이 계획의 몫).
- `src/shared/planeIcons.ts` + `planeIcons.test.ts`: `Priority`/`StateGroup` 타입, `PRIORITY_ORDER`/`STATE_ORDER`, `CALENDAR_ICON`/`FLAG_ICON`, `priorityIcon`/`priorityLabel`/`stateIcon`/`stateLabel` — 이미 존재하고 QuickAdd 칩 툴바가 이미 사용 중. **아이콘 모양만 Plane 실제 아이콘으로 교체하고, 함수 시그니처·라벨 값은 그대로 유지한다** (사용자 확인: planeIcons.ts를 업그레이드해 F1/F2 공유).
- `src-tauri/src/lib.rs`의 `invoke_handler!`는 현재 `get_settings, save_settings, create_issue, fetch_sidebar_data, list_projects, list_members` 순서로 등록되어 있다. 새 커맨드는 그 뒤에 추가한다.

각 태스크를 시작하는 구현자는 **먼저 해당 파일을 Read해서 현재 실제 내용을 확인**한 뒤 diff를 적용한다 (이 계획의 코드 스니펫은 위 커밋들이 반영된 상태 기준으로 작성됨. 만약 파일 내용이 여기 설명과 다르면 진행을 멈추고 보고한다).

## Global Constraints

- 상태 편집은 5개 대분류(backlog/unstarted/started/completed/cancelled)만 노출 — 프로젝트별 커스텀 상태 이름은 노출하지 않는다.
- 우선순위는 5개 값(urgent/high/medium/low/none)만 노출.
- 프로젝트 배지는 0이어도 **숨기지 않고** 흐리게(`pcount zero`) 표시한다.
- 같은 그룹에 상태가 여러 개인 프로젝트는 Plane states API의 `default: true` 플래그를 가진 것을 우선 사용하고, 없으면 첫 번째 것을 사용한다 (이 규칙은 사이드바의 새 `resolveStateId`(TS) 전용 — 기존 Rust `resolve_state_id`는 QuickAdd 단일 프로젝트 흐름에서 그대로 두고 건드리지 않는다).
- 상태 목록은 사이드바 새로고침(`fetch_sidebar_data`) 시 프로젝트/작업항목과 함께 가져온다 — 드롭다운을 열 때 별도 요청을 하지 않는다.
- 아이콘은 F1 QuickAdd와 F2 사이드바가 `src/shared/planeIcons.ts` 하나를 공유한다 (별도 아이콘 모듈을 새로 만들지 않는다).
- 우선순위 아이콘은 lucide-static(ISC 라이선스) 아이콘을 그대로 사용한다: urgent→AlertCircle, high→SignalHigh, medium→SignalMedium, low→SignalLow, none→Ban.
- 상태 아이콘은 Plane `packages/propel/src/icons/state/*`(AGPL-3.0-only) 소스를 포팅한 것이다 — 파일 상단에 원본 경로와 SPDX 식별자를 주석으로 남긴다 (개인용 앱이라 승인됨; 배포/공유 시 재검토 필요).
- PATCH 실패 시 UI 값을 이전 값으로 롤백하고 사이드바 하단 `synced` 텍스트에 짧은 에러 메시지를 표시한다 (재시도 큐 없음).
- 관련 스펙: [`docs/superpowers/specs/2026-07-01-sidebar-inline-edit-design.md`](../specs/2026-07-01-sidebar-inline-edit-design.md), 확정 목업: [`docs/mockups/sidebar-inline-edit-mockup.html`](../../mockups/sidebar-inline-edit-mockup.html) (목업의 이모지/개별 아이콘 모듈 부분은 이 계획의 "동시 작업 이력" 절대로 대체됨 — planeIcons.ts 공유가 최종 결정).

---

## File Structure

**Rust (백엔드):**
- Modify `src-tauri/src/plane_api.rs` — `ProjectState`/`RawProjectState`에 `project_id`/`default` 필드 추가, `list_states()`가 채워서 반환, 새 `PlaneClient::update_work_item()`
- Modify `src-tauri/src/commands.rs` — `StateDto`, `SidebarData.states`, `assemble_sidebar` 시그니처 확장, `fetch_sidebar_data`가 states도 가져오도록 수정, 새 커맨드 `update_work_item_priority`/`update_work_item_state`
- Modify `src-tauri/src/lib.rs` — 새 커맨드 2개를 `invoke_handler!`에 등록

**TypeScript:**
- Modify `src/shared/types.ts` — `ProjectState` 타입 추가, `SidebarData.states` 추가
- Modify `src/shared/ipc.ts` — `updateWorkItemPriority`, `updateWorkItemState` 래퍼 추가
- Modify `src/shared/planeIcons.ts` + `planeIcons.test.ts` — 내부 SVG를 Plane 실제 아이콘(lucide/AGPL-propel)으로 교체, `priorityColor`/`stateColor` export 추가 (기존 함수명·라벨 값·타입은 그대로 유지 — QuickAdd 회귀 없음)
- Create `src/sidebar/logic.ts` + `src/sidebar/logic.test.ts` — 순수 함수: 프로젝트별 배지 카운트 집계, group→stateId 매핑
- Modify `src/shared/app.css` — 팝오버(`.pop`/`.pop-item`)·아이콘 버튼(`.icon-btn`)·배지 zero 스타일 추가, 이제 안 쓰는 `.state-dot`류 제거
- Modify `src/sidebar/main.ts` — 배지 렌더링 + 아이콘 기반 상태/우선순위 팝오버 편집 배선

---

### Task 1: `plane_api.rs` — `ProjectState`에 `project_id`/`default` 추가

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Consumes: 기존 `ProjectState { id, group }`, `RawProjectState { id, group }`, `resolve_state_id()` (QuickAdd 작업에서 이미 존재 — 시그니처 유지, 건드리지 않음)
- Produces: `ProjectState { id: String, group: String, project_id: String, default: bool }`, `PlaneClient::list_states(project_id) -> Result<Vec<ProjectState>, String>` (기존과 같은 시그니처, project_id/default를 채워서 반환)

**중요:** `resolve_state_id(states: &[ProjectState], group: &str) -> Option<String>`은 QuickAdd의 `create_issue`가 이미 사용 중이다. 이 태스크는 그 함수의 **동작을 바꾸지 않는다** — `ProjectState`에 필드를 추가하는 것은 기존 호출자에 영향 없음(구조체 필드 추가는 이미 있는 코드의 필드 접근 방식과 무관).

- [ ] **Step 0: 현재 파일 확인**

Read `src-tauri/src/plane_api.rs` 전체. `ProjectState { pub id: String, pub group: String }`(라인 약 20-21), `RawProjectState { id: String, group: String }`(라인 약 74-75), `list_states`(라인 약 140-149), `resolve_state_id`(라인 약 35-37), 그리고 테스트의 `resolve_state_id_finds_id_for_group`/`list_states_parses_group_and_id`가 이 계획 설명과 일치하는지 확인. 다르면 중단하고 보고.

- [ ] **Step 1: 실패하는 테스트 작성**

`list_states_parses_group_and_id` 테스트를 다음으로 교체 (project_id/default 검증 추가):

```rust
    #[tokio::test]
    async fn list_states_parses_group_id_and_default() {
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

`resolve_state_id_finds_id_for_group` 테스트의 `ProjectState { ... }` 리터럴 2곳에 새 필드를 추가 (컴파일 유지용, 로직 변경 없음):

```rust
    #[test]
    fn resolve_state_id_finds_id_for_group() {
        let states = vec![
            ProjectState { id: "s-backlog".into(), group: "backlog".into(), project_id: "p1".into(), default: false },
            ProjectState { id: "s-todo".into(), group: "unstarted".into(), project_id: "p1".into(), default: false },
        ];
        assert_eq!(resolve_state_id(&states, "backlog"), Some("s-backlog".to_string()));
        assert_eq!(resolve_state_id(&states, "cancelled"), None);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test list_states_parses_group_id_and_default resolve_state_id_finds_id_for_group`
Expected: FAIL — `ProjectState`에 `project_id`/`default` 필드가 없어 컴파일 에러

- [ ] **Step 3: 구현**

`ProjectState`/`RawProjectState` 정의를 다음으로 교체:

```rust
#[derive(Debug, Clone)]
pub struct ProjectState { pub id: String, pub group: String, pub project_id: String, pub default: bool }
```

```rust
#[derive(Deserialize)]
struct RawProjectState {
    id: String,
    group: String,
    #[serde(default)] default: bool,
}
```

`list_states` 메서드를 다음으로 교체:

```rust
    pub async fn list_states(&self, project_id: &str) -> Result<Vec<ProjectState>, String> {
        let url = format!("{}/projects/{}/states/", self.ws_base(), project_id);
        let page: Paginated<RawProjectState> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|s| ProjectState { id: s.id, group: s.group, project_id: project_id.to_string(), default: s.default })
            .collect())
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test --lib plane_api::`
Expected: 모든 테스트(기존 + 새 것) PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add project_id/default to ProjectState"
```

---

### Task 2: `plane_api.rs` — 워크아이템 PATCH (`update_work_item`)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Consumes: 없음 (Task 1과 독립)
- Produces: `pub async fn PlaneClient::update_work_item(&self, project_id: &str, item_id: &str, body: serde_json::Value) -> Result<(), String>`

- [ ] **Step 1: 실패하는 테스트 작성**

`create_work_item_sends_all_fields` 테스트 뒤에 추가:

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
- Consumes: `crate::plane_api::ProjectState { id, group, project_id, default }` (Task 1)
- Produces: `pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }`, `SidebarData { projects, assigned, states: Vec<StateDto> }`, `pub fn assemble_sidebar(user_id: &str, projects: Vec<Project>, items: Vec<WorkItem>, states: Vec<ProjectState>) -> SidebarData`

**주의:** `commands.rs` 상단 `use crate::plane_api::{filter_assigned_open, resolve_state_id, NewWorkItem, PlaneClient, Project, WorkItem};`에 `ProjectState`를 추가해야 한다. `create_issue`(QuickAdd 작업 결과물)는 건드리지 않는다.

- [ ] **Step 0: 현재 파일 확인**

Read `src-tauri/src/commands.rs` 전체. `create_issue`, `list_members`, `assemble_sidebar`, `SidebarData` 정의가 이 계획 설명과 일치하는지 확인.

- [ ] **Step 1: 실패하는 테스트 작성**

`#[cfg(test)] mod tests`의 `use crate::plane_api::{Project, WorkItem};`를 다음으로 교체:

```rust
    use crate::plane_api::{Project, ProjectState, WorkItem};
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
            ProjectState { id: "s1".into(), group: "started".into(), project_id: "p1".into(), default: true },
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

파일 상단 `use` 문에 `ProjectState` 추가:

```rust
use crate::plane_api::{filter_assigned_open, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
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
    states: Vec<ProjectState>,
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
Expected: PASS (이 파일의 모든 테스트 — `create_issue`는 안 건드렸으므로 영향 없음)

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
- Consumes: `PlaneClient::list_states` (Task 1), `PlaneClient::update_work_item` (Task 2), `assemble_sidebar(.., states: Vec<ProjectState>)` (Task 3)
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
    let mut all_states: Vec<ProjectState> = Vec::new();
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

`fetch_sidebar_data` 뒤에 추가 (`list_members` 커맨드 앞이든 뒤든 무관):

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

- [ ] **Step 0: 현재 파일 확인**

Read `src-tauri/src/lib.rs`의 `invoke_handler!` 블록. 현재 `get_settings, save_settings, create_issue, fetch_sidebar_data, list_projects, list_members` 순서로 등록되어 있는지 확인.

- [ ] **Step 1: `invoke_handler!` 목록에 추가**

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
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

### Task 6: `src/shared/types.ts` — `ProjectState` 타입 + `SidebarData.states`

**Files:**
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces: `export interface ProjectState { id: string; group: string; project_id: string; default: boolean; }`, `SidebarData.states: ProjectState[]`

이 파일은 순수 타입 선언이라 전용 테스트가 없다 — `pnpm build`(tsc) 통과로 검증.

- [ ] **Step 0: 현재 파일 확인**

Read `src/shared/types.ts`. `Member` 인터페이스와 현재 `SidebarData { projects: Project[]; assigned: WorkItem[]; }`가 있는지 확인.

- [ ] **Step 1: 타입 추가**

`Member` 인터페이스 뒤에 추가:

```ts
export interface ProjectState { id: string; group: string; project_id: string; default: boolean; }
```

`SidebarData`를 다음으로 교체:

```ts
export interface SidebarData { projects: Project[]; assigned: WorkItem[]; states: ProjectState[]; }
```

- [ ] **Step 2: 타입체크 확인**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 3: 커밋**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add ProjectState type and SidebarData.states"
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

### Task 8: `src/shared/planeIcons.ts` — Plane 실제 아이콘으로 업그레이드

**Files:**
- Modify: `src/shared/planeIcons.ts`
- Modify: `src/shared/planeIcons.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces (기존 유지, 시그니처 불변): `priorityIcon(p: Priority): string`, `priorityLabel(p: Priority): string`, `stateIcon(g: StateGroup): string`, `stateLabel(g: StateGroup): string`, `PRIORITY_ORDER`, `STATE_ORDER`, `CALENDAR_ICON`, `FLAG_ICON`, 타입 `Priority`/`StateGroup`
- Produces (신규): `priorityColor(p: Priority): string`, `stateColor(g: StateGroup): string`

**중요:** 이 파일은 QuickAdd 칩 툴바(`src/quickadd/main.ts`)가 이미 import해서 쓰고 있다. 함수명·타입명·`PRIORITY_LABELS`/`STATE_LABELS`의 실제 문자열 값은 절대 바꾸지 않는다 — SVG 모양(내부 `PRIORITY_ICONS`/`STATE_ICONS`)만 교체한다. 기존 `planeIcons.test.ts`의 모든 테스트는 라벨 문자열과 `<svg` 포함 여부만 검사하므로 그대로 통과해야 한다 (건드리지 않음, 실패하면 되돌린다).

- [ ] **Step 0: 현재 파일 확인**

Read `src/shared/planeIcons.ts`와 `src/shared/planeIcons.test.ts` 전체. `PRIORITY_LABELS`/`STATE_LABELS`의 정확한 문자열 값이 이 태스크 설명과 일치하는지 확인 (예: `none: "우선순위 없음"`, `backlog: "Backlog"`).

- [ ] **Step 1: 실패하는 테스트 추가 (기존 테스트는 그대로 둠)**

`src/shared/planeIcons.test.ts` 맨 끝, `describe("planeIcons", ...)` 블록 안 마지막 `it(...)` 뒤에 추가:

```ts
  it("exposes the Plane priority color for every priority", () => {
    expect(priorityColor("urgent")).toBe("#D7443E");
    expect(priorityColor("high")).toBe("#DB7A2A");
    expect(priorityColor("medium")).toBe("#D9A916");
    expect(priorityColor("low")).toBe("#3D6FD9");
    expect(priorityColor("none")).toBe("#8C9199");
  });
  it("exposes the Plane state color for every group", () => {
    expect(stateColor("backlog")).toBe("#60646C");
    expect(stateColor("unstarted")).toBe("#60646C");
    expect(stateColor("started")).toBe("#F59E0B");
    expect(stateColor("completed")).toBe("#46A758");
    expect(stateColor("cancelled")).toBe("#9AA4BC");
  });
  it("backlog icon renders all 15 dashed segments (percentage=0)", () => {
    const matches = stateIcon("backlog").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(15);
  });
  it("unstarted icon renders zero dashed segments (solid ring)", () => {
    const matches = stateIcon("unstarted").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(0);
  });
  it("completed and cancelled icons render a single filled path", () => {
    expect(stateIcon("completed")).toContain("<path fill=");
    expect(stateIcon("cancelled")).toContain("<path fill=");
  });
```

그리고 파일 상단 import를 다음으로 교체:

```ts
import { describe, it, expect } from "vitest";
import {
  priorityIcon, priorityColor, priorityLabel, stateIcon, stateColor, stateLabel,
  PRIORITY_ORDER, STATE_ORDER, CALENDAR_ICON, FLAG_ICON,
} from "./planeIcons";
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/shared/planeIcons.test.ts`
Expected: FAIL — `priorityColor`/`stateColor`가 없어 import 에러, 또는 새 아이콘 구조 테스트 실패

- [ ] **Step 3: `planeIcons.ts` 내부 아이콘을 Plane 실제 아이콘으로 교체**

`src/shared/planeIcons.ts` 전체를 다음으로 교체:

```ts
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export const PRIORITY_ORDER: Priority[] = ["none", "low", "medium", "high", "urgent"];
export const STATE_ORDER: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

export const CALENDAR_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

export const FLAG_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><path d="M5 21V4h13l-3 4 3 4H5"/></svg>`;

// Priority icon shapes: lucide-static v1.22.0 (ISC license) — AlertCircle, SignalHigh,
// SignalMedium, SignalLow, Ban. https://lucide.dev — colors approximate Plane's
// packages/tailwind-config/variables.css --priority-* oklch tokens.
const PRIORITY_COLORS: Record<Priority, string> = {
  urgent: "#D7443E", high: "#DB7A2A", medium: "#D9A916", low: "#3D6FD9", none: "#8C9199",
};

const PRIORITY_PATHS: Record<Priority, string> = {
  urgent: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  high: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
  medium: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/>',
  low: '<path d="M2 20h.01"/><path d="M7 20v-4"/>',
  none: '<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>',
};

function buildPriorityIcon(p: Priority): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${PRIORITY_COLORS[p]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PRIORITY_PATHS[p]}</svg>`;
}

const PRIORITY_ICONS: Record<Priority, string> = {
  urgent: buildPriorityIcon("urgent"),
  high: buildPriorityIcon("high"),
  medium: buildPriorityIcon("medium"),
  low: buildPriorityIcon("low"),
  none: buildPriorityIcon("none"),
};

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "우선순위 없음",
};

// State group icon shapes ported from Plane packages/propel/src/icons/state/{dashed-circle,
// progress-circle,backlog-group-icon,unstarted-group-icon,started-group-icon,
// completed-group-icon,cancelled-group-icon}.tsx
// Source: C:\WorkSpaces\plane\packages\propel\src\icons\state\
// SPDX-License-Identifier: AGPL-3.0-only (Copyright Plane Software, Inc. and contributors).
// Kept for personal, non-distributed use of plane-tool; revisit AGPL obligations if this
// app is ever shared or distributed. See docs/superpowers/specs/2026-07-01-sidebar-inline-edit-design.md#31.
const STATE_COLORS: Record<StateGroup, string> = {
  backlog: "#60646C", unstarted: "#60646C", started: "#F59E0B", completed: "#46A758", cancelled: "#9AA4BC",
};

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

const COMPLETED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.3587 6.18828C11.6007 5.85214 11.5244 5.38343 11.1882 5.14141C10.8521 4.89938 10.3834 4.97568 10.1414 5.31183L7.03706 9.62335L5.25956 7.97751C4.95563 7.69609 4.4811 7.71434 4.19968 8.01828C3.91826 8.32221 3.93651 8.79673 4.24045 9.07815L6.64045 11.3004C6.79816 11.4464 7.01095 11.5178 7.22481 11.4963C7.43868 11.4749 7.63307 11.3627 7.75865 11.1883L11.3587 6.18828Z"';

const CANCELLED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.1018 4.89826C11.3947 5.19115 11.3947 5.66603 11.1018 5.95892L9.06068 8.00002L11.1018 10.0411C11.3947 10.334 11.3947 10.8089 11.1018 11.1018C10.8089 11.3947 10.334 11.3947 10.0411 11.1018L8.00002 9.06068L5.95892 11.1018C5.66603 11.3947 5.19115 11.3947 4.89826 11.1018C4.60537 10.8089 4.60537 10.334 4.89826 10.0411L6.93936 8.00002L4.89826 5.95892C4.60537 5.66603 4.60537 5.19115 4.89826 4.89826C5.19115 4.60537 5.66603 4.60537 5.95892 4.89826L8.00002 6.93936L10.0411 4.89826C10.334 4.60537 10.8089 4.60537 11.1018 4.89826Z"';

function buildStateIcon(group: StateGroup): string {
  const color = STATE_COLORS[group];
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
  return `<svg width="13" height="13" viewBox="0 0 16 16">${inner}</svg>`;
}

const STATE_ICONS: Record<StateGroup, string> = {
  backlog: buildStateIcon("backlog"),
  unstarted: buildStateIcon("unstarted"),
  started: buildStateIcon("started"),
  completed: buildStateIcon("completed"),
  cancelled: buildStateIcon("cancelled"),
};

const STATE_LABELS: Record<StateGroup, string> = {
  backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", cancelled: "Cancelled",
};

export function priorityIcon(p: Priority): string { return PRIORITY_ICONS[p]; }
export function priorityColor(p: Priority): string { return PRIORITY_COLORS[p]; }
export function priorityLabel(p: Priority): string { return PRIORITY_LABELS[p]; }
export function stateIcon(g: StateGroup): string { return STATE_ICONS[g]; }
export function stateColor(g: StateGroup): string { return STATE_COLORS[g]; }
export function stateLabel(g: StateGroup): string { return STATE_LABELS[g]; }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/shared/planeIcons.test.ts`
Expected: PASS — 기존 테스트(라벨 값, PRIORITY_ORDER/STATE_ORDER, svg 포함 여부)와 새 테스트 전부

- [ ] **Step 5: QuickAdd 회귀 확인**

Run: `pnpm test`
Expected: 전체 vitest 스위트 PASS (QuickAdd 칩 툴바 관련 테스트 포함 — 함수 시그니처/라벨을 안 바꿨으므로 영향 없어야 함)

- [ ] **Step 6: 커밋**

```bash
git add src/shared/planeIcons.ts src/shared/planeIcons.test.ts
git commit -m "feat(icons): upgrade planeIcons to Plane's real priority/state icon shapes"
```

---

### Task 9: `src/sidebar/logic.ts` — 배지 카운트 집계 + group→stateId 매핑

**Files:**
- Create: `src/sidebar/logic.ts`
- Test: `src/sidebar/logic.test.ts`

**Interfaces:**
- Consumes: `WorkItem`, `ProjectState` 타입 (Task 6)
- Produces: `countAssignedByProject(items: WorkItem[]): Record<string, number>`, `resolveStateId(states: ProjectState[], projectId: string, group: string): string | undefined`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/sidebar/logic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { ProjectState, WorkItem } from "../shared/types";

function wi(id: string, project_id: string): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, state_group: "started", project_id };
}
function st(id: string, group: string, project_id: string, isDefault = false): ProjectState {
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
import type { ProjectState, WorkItem } from "../shared/types";

export function countAssignedByProject(items: WorkItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    counts[it.project_id] = (counts[it.project_id] ?? 0) + 1;
  }
  return counts;
}

export function resolveStateId(states: ProjectState[], projectId: string, group: string): string | undefined {
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

### Task 10: `src/shared/app.css` — 팝오버/아이콘 버튼 스타일, 배지 zero 상태

**Files:**
- Modify: `src/shared/app.css`

**Interfaces:**
- Produces: CSS 클래스 `.pop`, `.pop-item`, `.pop-item.sel`, `.icon-btn`, `.icon-btn:hover`, `.proj-row .pcount.zero`; 제거: `.state-dot`, `.state-todo`, `.state-prog`, `.state-done`, `.prio.high`, `.prio.med` (더 이상 안 씀 — 아이콘이 인라인 색상을 직접 지정)

CSS만 바뀌므로 전용 테스트 없음 — `pnpm build` 통과 + Task 13 수동 QA로 검증.

- [ ] **Step 0: 현재 파일 확인**

Read `src/shared/app.css` 전체. `.proj-row .pcount`, `.task`, `.state-dot`/`.state-todo`/`.state-prog`/`.state-done`, `.prio`/`.prio.high`/`.prio.med` 블록이 이 태스크 설명과 일치하는 내용인지 확인 (QuickAdd 작업이 칩 툴바 CSS를 파일 다른 곳에 추가했을 수 있음 — 아래 블록들 자체는 안 건드렸을 것으로 예상되지만 확인 필수).

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

### Task 11: `src/sidebar/main.ts` — 프로젝트 배지 렌더링

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `countAssignedByProject` (Task 9), `SidebarData.states` (Task 6)

DOM 렌더링 파일이라 전용 유닛 테스트는 없다 — `pnpm build` + Task 13 수동 QA로 검증. 이 파일은 QuickAdd 작업의 영향을 받지 않았다 (session 시작 시점 그대로).

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
Expected: 성공 (아직 `renderTasks`는 옛 아이콘 방식이라 `dotClass` 등은 그대로 남아있음 — Task 12에서 정리)

- [ ] **Step 3: 수동 확인**

Run: `pnpm tauri dev`, F2로 사이드바 열기 → 각 프로젝트 행 오른쪽에 개수 배지가 보이는지, 0개인 프로젝트는 흐리게 보이는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add src/sidebar/main.ts
git commit -m "feat(sidebar): render unfinished-assigned-to-me count badge per project"
```

---

### Task 12: `src/sidebar/main.ts` — 상태/우선순위 아이콘 + 클릭 편집 팝오버

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `priorityIcon`, `priorityColor`, `stateIcon`, `stateColor` (Task 8, from `../shared/planeIcons`), `resolveStateId` (Task 9), `updateWorkItemPriority`, `updateWorkItemState` (Task 7)

DOM 렌더링 + 이벤트 배선이라 전용 유닛 테스트는 없다 — `pnpm build` + 수동 QA로 검증 (Plane 인스턴스가 필요한 실제 PATCH 확인 포함). 사이드바는 자체 한국어 라벨(`STATE_LABELS`/`PRIORITY_LABELS`)을 유지한다 — 확정 목업과 일치시키기 위함이며, `planeIcons.ts`의 영어 `stateLabel`/한국어 `priorityLabel`은 QuickAdd 쪽 표기를 그대로 두고 재사용하지 않는다(아이콘 모양·색상만 공유).

- [ ] **Step 1: import 및 모듈 상태 추가**

import 블록을 다음으로 교체:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { colorForId } from "../shared/color";
import { priorityIcon, priorityColor, stateIcon, stateColor } from "../shared/planeIcons";
import { countAssignedByProject, resolveStateId } from "./logic";
import type { SidebarData, Project, WorkItem, ProjectState } from "../shared/types";
import "../shared/app.css";
```

`let workspace = "";` 뒤에 추가:

```ts
let states: ProjectState[] = [];
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
    opt.innerHTML = stateIcon(group);
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
    opt.style.color = priorityColor(p as any);
    opt.innerHTML = priorityIcon(p as any);
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
    stateBtn.innerHTML = stateIcon(it.state_group as any);
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
    prioEl.style.color = priorityColor(it.priority as any);
    prioEl.innerHTML = priorityIcon(it.priority as any);
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

`priorityIcon`/`priorityColor`/`stateIcon`/`stateColor`는 `Priority`/`StateGroup` 유니언 타입을 받는데 이 파일의 `it.priority`/`it.state_group`은 백엔드에서 온 `string`이다 — 위 `as any` 캐스트로 통과시킨다 (백엔드가 이미 5개 값 중 하나만 보냄이 보장되므로 런타임 위험 없음).

- [ ] **Step 4: `refresh()`가 `states`를 채우도록 수정, 팝오버 닫기용 전역 리스너 추가**

`refresh()` 함수 안, `const data: SidebarData = await fetchSidebarData();` 다음 줄에 추가:

```ts
    states = data.states;
```

파일 맨 아래, 기존 이벤트 리스너 블록을 다음으로 교체:

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

### Task 13: 전체 검증 + 수동 QA

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 전체 Rust 테스트**

Run: `cd src-tauri && cargo test`
Expected: 모든 테스트 PASS (QuickAdd 관련 테스트 포함, 회귀 없음)

- [ ] **Step 2: 전체 TS 테스트 + 빌드**

Run: `pnpm test && pnpm build`
Expected: 모든 vitest 테스트 PASS (QuickAdd 관련 테스트 포함), 빌드 성공

- [ ] **Step 3: 수동 QA (실제 Plane 워크스페이스 대상)**

Run: `pnpm tauri dev`, F2로 사이드바 오픈 후 확인:
1. 프로젝트별 배지 숫자가 "나에게 할당된 작업" 목록의 실제 개수와 일치하는지, 0개 프로젝트는 흐리게 보이는지
2. 작업 행의 상태 아이콘 클릭 → 5개 그룹 팝오버 → 다른 그룹 선택 → 아이콘이 즉시 바뀌고, Plane 웹에서 새로고침해 실제로 상태가 바뀌었는지 확인
3. 우선순위 아이콘/텍스트 클릭 → 팝오버 → 다른 값 선택 → 같은 방식으로 Plane 웹에서 반영 확인
4. 네트워크를 잠시 끊고 상태/우선순위 변경 시도 → UI가 이전 값으로 롤백되고 `synced`에 실패 메시지가 뜨는지 확인
5. 팝오버가 열린 상태에서 바깥을 클릭하거나 `Esc`를 누르면 팝오버만 닫히고 창은 안 닫히는지, 팝오버가 없을 때 `Esc`는 기존처럼 창을 숨기는지 확인
6. 작업 행에서 아이콘이 아닌 이름 부분을 클릭하면 여전히 브라우저에서 해당 이슈가 열리는지 확인 (기존 동작 유지)
7. **F1 QuickAdd(Alt+Space 또는 설정된 단축키)를 열어 칩 툴바의 우선순위/상태 아이콘이 여전히 정상 동작하는지** (Task 8에서 아이콘 모양만 바꿨으므로 기능 회귀가 없어야 함)

- [ ] **Step 4: 최종 커밋 (필요 시)**

QA 중 발견된 사소한 수정이 있다면:

```bash
git add -A
git commit -m "fix(sidebar): address manual QA findings for inline edit"
```

---

## Self-Review 메모 (작성자용, 실행 시 참고)

- **동시 작업 재조정**: 원래 계획은 `plane_api.rs`에 새 `State` 구조체와 `src/shared/icons/*` 새 모듈을 만드는 것이었으나, 계획 작성 이후 QuickAdd 필드 확장 작업이 같은 저장소에 `ProjectState`/`resolve_state_id`/`planeIcons.ts`를 이미 커밋해 이 계획을 전면 재조정했다 (사용자 확인 완료: 새 타입 대신 `ProjectState` 확장, 새 아이콘 모듈 대신 `planeIcons.ts` 업그레이드).
- **스펙 커버리지**: 3절(UI/아이콘) → Task 8·12, 4.1(배지)→Task 9·11, 4.2(상태 백엔드)→Task 1·3·4, 4.3(프론트)→Task 6·7·9·12, 5절(에러 처리)→Task 12 optimistic rollback + Task 13 Step 3-4, 6절(테스트)→각 태스크 Step 1-2·4.
- **일관성**: `ProjectState`/`StateDto`가 Rust와 TS 양쪽에서 `{ id, group, project_id, default }`로 동일. `resolveStateId`(TS, 이 계획 전용)와 `resolve_state_id`(Rust, QuickAdd 전용)는 이름은 비슷하지만 별개 함수로 유지 — 서로 다른 흐름(사이드바 다중 프로젝트 집계 vs QuickAdd 단일 프로젝트 생성)에 맞게 분리됨.
- **타입 일관성**: `priorityIcon`/`priorityColor`/`stateIcon`/`stateColor`/`resolveStateId`/`countAssignedByProject` 함수명과 시그니처가 정의된 태스크(8, 9)와 사용되는 태스크(12, 11)에서 동일하게 유지됨.
- **QuickAdd 회귀 방지**: Task 8은 `planeIcons.ts`의 export 시그니처·라벨 문자열을 바꾸지 않고 내부 SVG만 교체하므로 기존 `planeIcons.test.ts`와 QuickAdd 칩 툴바 코드는 수정 없이 그대로 통과해야 한다. Task 13 Step 3-7에서 수동으로 재확인한다.
