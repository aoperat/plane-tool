# QuickAdd 필드 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F1 QuickAdd 트레이에서 담당자·시작일·마감일·우선순위·진행상태까지 함께 입력해 작업을 생성할 수 있게 한다.

**Architecture:** 제목 입력 아래 칩(chip) 툴바를 추가해 5개 필드를 표시하고, 클릭 시 공용 팝오버(`#fieldPopover`)에 옵션을 렌더링한다. 담당자는 프로젝트 멤버 API로, 진행상태는 표준 그룹→프로젝트 실제 상태 ID 매핑을 백엔드(Rust)에서 수행한다. 날짜는 프리셋(오늘/내일/다음 주)만 지원하며 프론트에서 ISO 문자열로 변환해 보낸다.

**Tech Stack:** Rust (Tauri v2, reqwest, serde, wiremock for tests), TypeScript (Vite, vitest), 순수 함수 기반 로직 분리(`datePresets.ts`, `planeIcons.ts`).

## Global Constraints

- 날짜는 프리셋(오늘/내일/다음 주=+7일)만 지원한다 — 캘린더나 수동 입력 없음.
- 진행상태는 표준 5개 그룹(backlog/unstarted/started/completed/cancelled)만 지원 — 프로젝트별 커스텀 상태명 선택 없음.
- 우선순위는 고정 5개 값: none/low/medium/high/urgent.
- 담당자는 다중 선택 가능, 기본값은 빈 배열(`[]`)이며 빈 배열은 서버가 "본인"으로 해석한다.
- 아이콘은 Plane 실제 에셋이 아닌, 브레인스토밍에서 승인된 커스텀 인라인 SVG를 그대로 사용한다.
- 트레이를 열 때마다(포커스 시) 모든 필드는 기본값으로 리셋된다 — 이전 입력을 기억하지 않는다.
- 스펙 문서: `docs/superpowers/specs/2026-07-01-quickadd-field-expansion-design.md`

---

## Task 1: Rust — 상태(states)/멤버(members) 조회 API 추가

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces: `pub struct ProjectState { pub id: String, pub group: String }`, `pub struct Member { pub id: String, pub display_name: String }`, `PlaneClient::list_states(&self, project_id: &str) -> Result<Vec<ProjectState>, String>`, `PlaneClient::list_members(&self, project_id: &str) -> Result<Vec<Member>, String>`, `pub fn resolve_state_id(states: &[ProjectState], group: &str) -> Option<String>`

- [ ] **Step 1: 실서버 응답 형태 재확인 (이미 완료, 근거 기록용)**

실제 서버(`localhost:8060`)에서 확인한 응답:
- `GET .../projects/{id}/states/` → `{"results": [{"id": "...", "group": "backlog", ...}, ...]}` (다른 목록 API와 동일하게 페이지네이션 래핑됨)
- `GET .../projects/{id}/members/` → `[{"id": "...", "display_name": "...", ...}, ...]` (래핑 없는 **평범한 배열** — projects/states와 다름)

- [ ] **Step 2: 실패하는 테스트 작성**

`src-tauri/src/plane_api.rs`의 `#[cfg(test)] mod tests` 블록 안, `current_user_parses_id` 테스트 뒤에 추가:

```rust
    #[test]
    fn resolve_state_id_finds_id_for_group() {
        let states = vec![
            ProjectState { id: "s-backlog".into(), group: "backlog".into() },
            ProjectState { id: "s-todo".into(), group: "unstarted".into() },
        ];
        assert_eq!(resolve_state_id(&states, "backlog"), Some("s-backlog".to_string()));
        assert_eq!(resolve_state_id(&states, "cancelled"), None);
    }

    #[tokio::test]
    async fn list_states_parses_group_and_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/states/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "s1", "name": "Backlog", "group": "backlog" },
                    { "id": "s2", "name": "Todo", "group": "unstarted" }
                ]
            })))
            .mount(&server)
            .await;

        let states = client_for(&server).await.list_states("p1").await.unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].id, "s1");
        assert_eq!(states[0].group, "backlog");
    }

    #[tokio::test]
    async fn list_members_parses_plain_array_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/members/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": "u1", "display_name": "Alice" },
                { "id": "u2", "display_name": "Bob" }
            ])))
            .mount(&server)
            .await;

        let members = client_for(&server).await.list_members("p1").await.unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].id, "u1");
        assert_eq!(members[1].display_name, "Bob");
    }
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd src-tauri && cargo test --lib resolve_state_id_finds_id_for_group list_states_parses_group_and_id list_members_parses_plain_array_response`
Expected: FAIL — `ProjectState`, `Member`, `resolve_state_id`, `list_states`, `list_members`가 존재하지 않는다는 컴파일 에러.

- [ ] **Step 4: 구현**

`src-tauri/src/plane_api.rs`의 `pub struct CurrentUser { ... }` 바로 아래에 추가:

```rust
#[derive(Debug, Clone)]
pub struct ProjectState { pub id: String, pub group: String }

#[derive(Debug, Clone)]
pub struct Member { pub id: String, pub display_name: String }

pub fn resolve_state_id(states: &[ProjectState], group: &str) -> Option<String> {
    states.iter().find(|s| s.group == group).map(|s| s.id.clone())
}
```

`struct RawUser { ... }` 바로 아래에 raw 파싱용 구조체 추가:

```rust
#[derive(Deserialize)]
struct RawProjectState { id: String, group: String }

#[derive(Deserialize)]
struct RawMember { id: String, #[serde(default)] display_name: String }
```

`impl PlaneClient` 블록 안, `list_work_items` 메서드 뒤(`create_work_item` 앞)에 추가:

```rust
    pub async fn list_states(&self, project_id: &str) -> Result<Vec<ProjectState>, String> {
        let url = format!("{}/projects/{}/states/", self.ws_base(), project_id);
        let page: Paginated<RawProjectState> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|s| ProjectState { id: s.id, group: s.group })
            .collect())
    }

    // Unlike every other list endpoint in this file, /members/ returns a bare
    // JSON array — no `{"results": [...]}` wrapper. Confirmed against the
    // live server; do not wrap this in `Paginated<T>`.
    pub async fn list_members(&self, project_id: &str) -> Result<Vec<Member>, String> {
        let url = format!("{}/projects/{}/members/", self.ws_base(), project_id);
        let raw: Vec<RawMember> = self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(raw
            .into_iter()
            .map(|m| Member { id: m.id, display_name: m.display_name })
            .collect())
    }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri && cargo test --lib`
Expected: 13개 테스트 전부 PASS (기존 10개 + 신규 3개).

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat: add project states/members lookup + group-to-state-id resolver"
```

---

## Task 2: Rust — `create_work_item`이 담당자/날짜/우선순위/상태를 함께 전송하도록 확장

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Consumes: Task 1의 `ProjectState`(직접 사용 없음, 참고용)
- Produces: `pub struct NewWorkItem<'a> { pub name: &'a str, pub assignee_ids: &'a [String], pub start_date: Option<&'a str>, pub target_date: Option<&'a str>, pub priority: &'a str, pub state_id: &'a str }`, `PlaneClient::create_work_item(&self, project_id: &str, item: &NewWorkItem<'_>) -> Result<(), String>` (시그니처 변경 — 기존 `(project_id, name, assignee_id)` 3-인자 버전을 대체)

- [ ] **Step 1: 실패하는 테스트로 교체**

`src-tauri/src/plane_api.rs`의 기존 `create_work_item_assigns_creator` 테스트 전체를 아래로 교체:

```rust
    #[tokio::test]
    async fn create_work_item_sends_all_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "start_date": "2026-07-01",
                "target_date": "2026-07-02",
                "priority": "high",
                "state": "state-1"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: Some("2026-07-01"),
            target_date: Some("2026-07-02"),
            priority: "high",
            state_id: "state-1",
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test --lib create_work_item_sends_all_fields`
Expected: FAIL — `NewWorkItem`이 없거나 `create_work_item` 시그니처 불일치로 컴파일 에러.

- [ ] **Step 3: 구현**

`src-tauri/src/plane_api.rs`에서 `pub struct Member { ... }` 바로 아래에 추가:

```rust
pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
}
```

기존 `create_work_item` 메서드 전체를 아래로 교체:

```rust
    pub async fn create_work_item(
        &self,
        project_id: &str,
        item: &NewWorkItem<'_>,
    ) -> Result<(), String> {
        // The create endpoint (no `expand` param) returns `assignees`/`state` as
        // flat id strings, not the nested objects `RawWorkItem` expects (that
        // shape only applies to the `expand=assignees,state` list endpoint).
        // Nothing consumes the created item, so skip parsing the body.
        let url = format!("{}/projects/{}/work-items/", self.ws_base(), project_id);
        self.http
            .post(&url)
            .header("X-Api-Key", &self.api_key)
            .json(&serde_json::json!({
                "name": item.name,
                "assignees": item.assignee_ids,
                "start_date": item.start_date,
                "target_date": item.target_date,
                "priority": item.priority,
                "state": item.state_id,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test --lib`
Expected: 13개 테스트 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat: send assignees/dates/priority/state on work item creation"
```

---

## Task 3: Rust — `create_issue` 커맨드 확장 + `list_members` 커맨드 추가

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1의 `resolve_state_id`, `Member`; Task 2의 `NewWorkItem`
- Produces: `#[tauri::command] pub async fn list_members(app, project_id: String) -> Result<Vec<MemberDto>, String>`, `#[tauri::command] pub async fn create_issue(app, project_id: String, name: String, assignee_ids: Vec<String>, start_date: Option<String>, target_date: Option<String>, priority: String, state_group: String) -> Result<(), String>` (시그니처 변경)

- [ ] **Step 1: import 갱신**

`src-tauri/src/commands.rs` 최상단 import를 교체:

```rust
use crate::config;
use crate::plane_api::{filter_assigned_open, resolve_state_id, NewWorkItem, PlaneClient, Project, WorkItem};
use serde::Serialize;
```

- [ ] **Step 2: `MemberDto` + `list_members` 커맨드 추가**

`ProjectDto` 선언 바로 아래에 추가:

```rust
#[derive(Serialize)]
pub struct MemberDto { pub id: String, pub display_name: String }
```

`list_projects` 커맨드 뒤에 추가:

```rust
#[tauri::command]
pub async fn list_members(app: tauri::AppHandle, project_id: String) -> Result<Vec<MemberDto>, String> {
    let (client, _s) = client(&app)?;
    let members = client.list_members(&project_id).await?;
    Ok(members
        .into_iter()
        .map(|m| MemberDto { id: m.id, display_name: m.display_name })
        .collect())
}
```

- [ ] **Step 3: `create_issue` 시그니처 확장**

기존 `create_issue` 함수 전체를 아래로 교체:

```rust
#[tauri::command]
pub async fn create_issue(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    assignee_ids: Vec<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: String,
    state_group: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids
    };
    let states = client.list_states(&project_id).await?;
    let state_id = resolve_state_id(&states, &state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let item = NewWorkItem {
        name: name.trim(),
        assignee_ids: &assignees,
        start_date: start_date.as_deref(),
        target_date: target_date.as_deref(),
        priority: &priority,
        state_id: &state_id,
    };
    client.create_work_item(&project_id, &item).await?;
    config::set_last_project(&app, &project_id)?;
    Ok(())
}
```

- [ ] **Step 4: `list_members`를 Tauri invoke_handler에 등록**

`src-tauri/src/lib.rs`의 `.invoke_handler(tauri::generate_handler![...])` 목록을 교체:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members
        ])
```

- [ ] **Step 5: 빌드 + 전체 테스트 확인**

Run: `cd src-tauri && cargo test --lib`
Expected: 13개 테스트 전부 PASS (commands.rs는 create_issue를 직접 테스트하지 않으므로 컴파일만 통과하면 됨).

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: extend create_issue with assignee/date/priority/state + add list_members command"
```

---

## Task 4: 프론트 — `Member` 타입 + `ipc.ts` 시그니처 확장

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Produces: `export interface Member { id: string; display_name: string; }`, `listMembers(project_id: string): Promise<Member[]>`, `createIssue(project_id, name, assignee_ids, start_date, target_date, priority, state_group): Promise<void>` (시그니처 변경)

- [ ] **Step 1: `Member` 타입 추가**

`src/shared/types.ts`의 `Project` 인터페이스 바로 아래에 추가:

```ts
export interface Member { id: string; display_name: string; }
```

- [ ] **Step 2: `ipc.ts` 갱신**

`src/shared/ipc.ts` 최상단 import 교체:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { SidebarData, SettingsDto, Project, Member } from "./types";
```

기존 `createIssue` 선언을 아래로 교체하고 바로 뒤에 `listMembers`를 추가:

```ts
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string,
  target_date: string,
  priority: string,
  state_group: string,
) =>
  invoke<void>("create_issue", {
    projectId: project_id,
    name,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
  });
export const listMembers = (project_id: string) =>
  invoke<Member[]>("list_members", { projectId: project_id });
```

- [ ] **Step 3: 타입체크 확인**

Run: `pnpm exec tsc --noEmit`
Expected: `src/quickadd/main.ts`에서 기존 `createIssue(selectedId, name)` 호출이 인자 개수 불일치로 에러가 남 (Task 8에서 고침 — 지금은 타입 선언 자체의 오탈자만 없으면 됨). 에러 메시지가 `src/quickadd/main.ts`를 가리키는지 확인하고, `src/shared/types.ts`/`src/shared/ipc.ts` 자체에 에러가 없는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat: add Member type + extend createIssue/listMembers ipc signatures"
```

---

## Task 5: 프론트 — 날짜 프리셋 순수 함수 (`datePresets.ts`)

**Files:**
- Create: `src/shared/datePresets.ts`
- Test: `src/shared/datePresets.test.ts`

**Interfaces:**
- Produces: `export type DatePresetKey = "today" | "tomorrow" | "next_week"`, `export const DATE_PRESETS: { key: DatePresetKey; label: string }[]`, `export function resolveDatePreset(key: DatePresetKey, now?: Date): string` (YYYY-MM-DD)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/datePresets.test.ts` 생성:

```ts
import { describe, it, expect } from "vitest";
import { resolveDatePreset } from "./datePresets";

describe("resolveDatePreset", () => {
  it("returns the same date for today", () => {
    expect(resolveDatePreset("today", new Date(2026, 0, 15))).toBe("2026-01-15");
  });
  it("adds one day for tomorrow", () => {
    expect(resolveDatePreset("tomorrow", new Date(2026, 0, 15))).toBe("2026-01-16");
  });
  it("adds seven days for next_week", () => {
    expect(resolveDatePreset("next_week", new Date(2026, 0, 15))).toBe("2026-01-22");
  });
  it("rolls over month boundaries", () => {
    expect(resolveDatePreset("next_week", new Date(2026, 0, 28))).toBe("2026-02-04");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/shared/datePresets.test.ts`
Expected: FAIL — `./datePresets` 모듈을 찾을 수 없음.

- [ ] **Step 3: 구현**

`src/shared/datePresets.ts` 생성:

```ts
export type DatePresetKey = "today" | "tomorrow" | "next_week";

export const DATE_PRESETS: { key: DatePresetKey; label: string }[] = [
  { key: "today", label: "오늘" },
  { key: "tomorrow", label: "내일" },
  { key: "next_week", label: "다음 주" },
];

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveDatePreset(key: DatePresetKey, now: Date = new Date()): string {
  const d = new Date(now);
  if (key === "tomorrow") d.setDate(d.getDate() + 1);
  if (key === "next_week") d.setDate(d.getDate() + 7);
  return toIsoDate(d);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/shared/datePresets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/shared/datePresets.ts src/shared/datePresets.test.ts
git commit -m "feat: add date preset resolver (today/tomorrow/next week)"
```

---

## Task 6: 프론트 — 우선순위/상태 아이콘 순수 함수 (`planeIcons.ts`)

**Files:**
- Create: `src/shared/planeIcons.ts`
- Test: `src/shared/planeIcons.test.ts`

**Interfaces:**
- Produces: `export type Priority = "none" | "low" | "medium" | "high" | "urgent"`, `export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled"`, `export const PRIORITY_ORDER: Priority[]`, `export const STATE_ORDER: StateGroup[]`, `export function priorityIcon(p: Priority): string`, `export function priorityLabel(p: Priority): string`, `export function stateIcon(g: StateGroup): string`, `export function stateLabel(g: StateGroup): string`, `export const CALENDAR_ICON: string`, `export const FLAG_ICON: string`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/planeIcons.test.ts` 생성:

```ts
import { describe, it, expect } from "vitest";
import {
  priorityIcon, priorityLabel, stateIcon, stateLabel,
  PRIORITY_ORDER, STATE_ORDER, CALENDAR_ICON, FLAG_ICON,
} from "./planeIcons";

describe("planeIcons", () => {
  it("has 5 priority levels in none→urgent order", () => {
    expect(PRIORITY_ORDER).toEqual(["none", "low", "medium", "high", "urgent"]);
  });
  it("has 5 state groups in backlog→cancelled order", () => {
    expect(STATE_ORDER).toEqual(["backlog", "unstarted", "started", "completed", "cancelled"]);
  });
  it("returns an svg string for every priority", () => {
    for (const p of PRIORITY_ORDER) expect(priorityIcon(p)).toContain("<svg");
  });
  it("returns an svg string for every state group", () => {
    for (const g of STATE_ORDER) expect(stateIcon(g)).toContain("<svg");
  });
  it("labels none as '우선순위 없음'", () => {
    expect(priorityLabel("none")).toBe("우선순위 없음");
  });
  it("labels backlog as 'Backlog'", () => {
    expect(stateLabel("backlog")).toBe("Backlog");
  });
  it("exposes calendar and flag icon markup", () => {
    expect(CALENDAR_ICON).toContain("<svg");
    expect(FLAG_ICON).toContain("<svg");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test src/shared/planeIcons.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음.

- [ ] **Step 3: 구현**

`src/shared/planeIcons.ts` 생성 (브레인스토밍에서 승인된 목업의 SVG를 그대로 사용):

```ts
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export const PRIORITY_ORDER: Priority[] = ["none", "low", "medium", "high", "urgent"];
export const STATE_ORDER: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

export const CALENDAR_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

export const FLAG_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><path d="M5 21V4h13l-3 4 3 4H5"/></svg>`;

const PRIORITY_ICONS: Record<Priority, string> = {
  urgent: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="17" width="20" height="4" rx="1" fill="#ef4d56"/></svg>`,
  high: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#ef4d56"/><rect x="9" y="11" width="4" height="10" fill="#ef4d56"/><rect x="16" y="6" width="4" height="15" fill="#ef4d56"/></svg>`,
  medium: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#f5a623"/><rect x="9" y="11" width="4" height="10" fill="#f5a623"/><rect x="16" y="6" width="4" height="15" fill="#5c626d" opacity="0.4"/></svg>`,
  low: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#8a909c"/><rect x="9" y="11" width="4" height="10" fill="#5c626d" opacity="0.4"/><rect x="16" y="6" width="4" height="15" fill="#5c626d" opacity="0.4"/></svg>`,
  none: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="4" y="16" width="3" height="4" rx="0.5" fill="#5c626d"/><rect x="10.5" y="12" width="3" height="8" rx="0.5" fill="#5c626d"/><rect x="17" y="8" width="3" height="12" rx="0.5" fill="#5c626d"/></svg>`,
};

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "우선순위 없음",
};

const STATE_ICONS: Record<StateGroup, string> = {
  backlog: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-dasharray="3 3"><circle cx="12" cy="12" r="9"/></svg>`,
  unstarted: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`,
  started: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="#f5a623" stroke="none"/></svg>`,
  completed: `<svg width="13" height="13" viewBox="0 0 24 24" fill="#2ecc71" stroke="#2ecc71"><circle cx="12" cy="12" r="9" fill="#2ecc71"/><path d="M8 12l3 3 5-6" stroke="#16181d" stroke-width="2" fill="none"/></svg>`,
  cancelled: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`,
};

const STATE_LABELS: Record<StateGroup, string> = {
  backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", cancelled: "Cancelled",
};

export function priorityIcon(p: Priority): string { return PRIORITY_ICONS[p]; }
export function priorityLabel(p: Priority): string { return PRIORITY_LABELS[p]; }
export function stateIcon(g: StateGroup): string { return STATE_ICONS[g]; }
export function stateLabel(g: StateGroup): string { return STATE_LABELS[g]; }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test src/shared/planeIcons.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/shared/planeIcons.ts src/shared/planeIcons.test.ts
git commit -m "feat: add Plane-style priority/state icon set"
```

---

## Task 7: 프론트 — 칩 툴바 마크업/스타일 + 창 높이 조정

**Files:**
- Modify: `src/quickadd/index.html`
- Modify: `src/shared/app.css`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: DOM ids `chipAssignee`, `chipStart`, `chipDue`, `chipPriority`, `chipState`, `fieldPopover` (Task 8에서 사용)

- [ ] **Step 1: `index.html`에 칩 툴바 + 필드 팝오버 컨테이너 추가**

`src/quickadd/index.html`의 `.popup-top` div 바로 뒤, `.popup-bottom` div 바로 앞에 삽입:

```html
      <div class="chip-row" id="chipRow">
        <button type="button" class="chip" id="chipAssignee"></button>
        <button type="button" class="chip" id="chipStart"></button>
        <button type="button" class="chip" id="chipDue"></button>
        <button type="button" class="chip" id="chipPriority"></button>
        <button type="button" class="chip" id="chipState"></button>
        <div id="fieldPopover" class="field-popover" hidden></div>
      </div>
```

(칩의 텍스트/아이콘 내용은 Task 8에서 `main.ts`가 채운다.)

- [ ] **Step 2: `app.css`에 칩/팝오버 스타일 추가**

`src/shared/app.css`의 `.title-input.error { color: var(--red); }` 바로 아래에 추가:

```css
.chip-row { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 14px; position: relative; }
.chip {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px;
  font-size: 12.5px; color: var(--text); cursor: pointer; font-family: inherit;
}
.chip:hover { border-color: var(--accent); }
.chip .muted { color: var(--muted-2); }
.chip .avatar {
  width: 16px; height: 16px; border-radius: 50%; background: var(--accent);
  color: #fff; font-size: 8px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; flex: none;
}
.field-popover {
  position: absolute; top: 100%; left: 18px; right: 18px; margin-top: 4px;
  max-height: 200px; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow); padding: 6px; z-index: 50;
}
```

- [ ] **Step 3: 창 높이 확장**

`src-tauri/tauri.conf.json`의 `quickadd` 창 정의에서 `"height": 132`를 `"height": 300`으로 변경. (칩 툴바 + 필드 팝오버가 잘리지 않게 여유 공간 확보. 팝오버는 `.field-popover`가 `overflow-y:auto; max-height:200px`로 자체 스크롤하므로 창 높이를 그 이상 무한정 늘릴 필요는 없다.)

- [ ] **Step 4: 수동 확인**

Run: `pnpm tauri dev` (프로세스가 이미 떠 있다면 재시작 필요 — Rust 변경은 핫리로드되지 않음)
F1로 QuickAdd를 띄워 창이 잘리지 않고 칩 5개 자리(현재는 빈 버튼)가 제목 입력 아래·프로젝트 선택 바 위에 보이는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add src/quickadd/index.html src/shared/app.css src-tauri/tauri.conf.json
git commit -m "feat: add chip toolbar markup/styles + grow quickadd window for it"
```

---

## Task 8: 프론트 — `quickadd/main.ts`에 칩 상호작용 구현 + 제출 로직 연결

**Files:**
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Consumes: Task 4의 `listMembers`, `createIssue(project_id, name, assignee_ids, start_date, target_date, priority, state_group)`, `Member`; Task 5의 `DATE_PRESETS`, `resolveDatePreset`, `DatePresetKey`; Task 6의 `PRIORITY_ORDER`, `STATE_ORDER`, `priorityIcon`, `priorityLabel`, `stateIcon`, `stateLabel`, `CALENDAR_ICON`, `FLAG_ICON`, `Priority`, `StateGroup`; Task 7의 DOM ids

- [ ] **Step 1: `src/quickadd/main.ts` 전체를 아래 내용으로 교체**

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project, Member } from "../shared/types";
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from "../shared/datePresets";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import "../shared/app.css";

const win = getCurrentWindow();
const titleEl = document.getElementById("title") as HTMLInputElement;
const projBtn = document.getElementById("projBtn")!;
const projName = document.getElementById("projName")!;
const projDot = document.getElementById("projDot")!;
const dropdown = document.getElementById("dropdown")!;
const chipAssignee = document.getElementById("chipAssignee")!;
const chipStart = document.getElementById("chipStart")!;
const chipDue = document.getElementById("chipDue")!;
const chipPriority = document.getElementById("chipPriority")!;
const chipState = document.getElementById("chipState")!;
const fieldPopover = document.getElementById("fieldPopover")!;

let projects: Project[] = [];
let selectedId: string | null = null;
let members: Member[] = [];
let membersLoadedForProject: string | null = null;

let assigneeIds: string[] = []; // empty = server defaults to self
let startPreset: DatePresetKey = "today";
let duePreset: DatePresetKey = "today";
let priority: Priority = "none";
let stateGroup: StateGroup = "backlog";

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;
let openPopover: PopoverKind = null;

function renderSelected() {
  const p = projects.find((x) => x.id === selectedId);
  projName.textContent = p ? p.name : "프로젝트 선택";
  (projDot as HTMLElement).style.background = p ? colorForId(p.id) : "transparent";
}

function renderDropdown() {
  dropdown.innerHTML = "";
  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p.id === selectedId ? " sel" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorForId(p.id);
    item.appendChild(dot);
    item.appendChild(document.createTextNode(p.name));
    item.onclick = () => {
      selectedId = p.id;
      members = [];
      membersLoadedForProject = null;
      assigneeIds = [];
      renderSelected();
      renderDropdown();
      renderChips();
      dropdown.hidden = true;
      titleEl.focus();
    };
    dropdown.appendChild(item);
  }
}

function assigneeChipHtml(): string {
  if (assigneeIds.length === 0) return `<span class="avatar">나</span> 나`;
  if (assigneeIds.length === 1) {
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    return `<span class="avatar">${name.slice(0, 1)}</span> ${name}`;
  }
  return `<span class="avatar">${assigneeIds.length}</span> ${assigneeIds.length}명`;
}

function renderChips() {
  chipAssignee.innerHTML = assigneeChipHtml();
  chipStart.innerHTML = `${CALENDAR_ICON} ${DATE_PRESETS.find((d) => d.key === startPreset)!.label}`;
  chipDue.innerHTML = `${FLAG_ICON} ${DATE_PRESETS.find((d) => d.key === duePreset)!.label}`;
  chipPriority.innerHTML =
    `${priorityIcon(priority)} <span class="${priority === "none" ? "muted" : ""}">${priorityLabel(priority)}</span>`;
  chipState.innerHTML = `${stateIcon(stateGroup)} ${stateLabel(stateGroup)}`;
}

function closePopover() {
  openPopover = null;
  fieldPopover.hidden = true;
  fieldPopover.innerHTML = "";
}

function toggleAssignee(id: string | null) {
  if (id === null) {
    assigneeIds = [];
  } else if (assigneeIds.includes(id)) {
    assigneeIds = assigneeIds.filter((x) => x !== id);
  } else {
    assigneeIds = [...assigneeIds, id];
  }
  renderChips();
  renderAssigneePopoverItems();
}

function renderAssigneePopoverItems() {
  fieldPopover.innerHTML = "";
  const selfItem = document.createElement("div");
  selfItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  selfItem.textContent = "나 (기본값)";
  selfItem.onclick = () => toggleAssignee(null);
  fieldPopover.appendChild(selfItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
    fieldPopover.appendChild(item);
  }
}

async function openAssigneePopover() {
  if (!selectedId) return;
  if (membersLoadedForProject !== selectedId) {
    try {
      members = await listMembers(selectedId);
      membersLoadedForProject = selectedId;
    } catch (err) {
      members = [];
      console.error("listMembers failed:", err);
    }
  }
  renderAssigneePopoverItems();
  fieldPopover.hidden = false;
  openPopover = "assignee";
}

function openDatePopover(kind: "start" | "due") {
  fieldPopover.innerHTML = "";
  const current = kind === "start" ? startPreset : duePreset;
  for (const preset of DATE_PRESETS) {
    const item = document.createElement("div");
    item.className = "dd-item" + (preset.key === current ? " sel" : "");
    item.textContent = preset.label;
    item.onclick = () => {
      if (kind === "start") startPreset = preset.key;
      else duePreset = preset.key;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = kind;
}

function openPriorityPopover() {
  fieldPopover.innerHTML = "";
  for (const p of PRIORITY_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p === priority ? " sel" : "");
    item.innerHTML = `${priorityIcon(p)} ${priorityLabel(p)}`;
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = "priority";
}

function openStatePopover() {
  fieldPopover.innerHTML = "";
  for (const g of STATE_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (g === stateGroup ? " sel" : "");
    item.innerHTML = `${stateIcon(g)} ${stateLabel(g)}`;
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = "state";
}

chipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
chipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
chipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
chipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
chipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };

function resetFields() {
  assigneeIds = [];
  startPreset = "today";
  duePreset = "today";
  priority = "none";
  stateGroup = "backlog";
  closePopover();
  renderChips();
}

async function load() {
  const [settings, fetched] = await Promise.all([getSettings(), listProjects().catch(() => [])]);
  projects = fetched;
  selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  renderSelected();
  renderDropdown();
}

projBtn.onclick = () => { dropdown.hidden = !dropdown.hidden; };

titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    await win.hide();
    return;
  }
  if (e.key === "Enter") {
    if (openPopover) return;
    const name = titleEl.value.trim();
    if (!name || !selectedId) return;
    try {
      await createIssue(
        selectedId,
        name,
        assigneeIds,
        resolveDatePreset(startPreset),
        resolveDatePreset(duePreset),
        priority,
        stateGroup,
      );
      titleEl.value = "";
      resetFields();
      await win.hide();
    } catch (err) {
      titleEl.classList.add("error");
      console.error(err);
    }
  }
});

win.listen("tauri://focus", () => {
  titleEl.focus();
  resetFields();
  load();
});
renderChips();
load();
```

- [ ] **Step 2: 타입체크**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 프론트 단위 테스트 전체 재확인**

Run: `pnpm test`
Expected: 모든 vitest 테스트 PASS (color, datePresets, planeIcons).

- [ ] **Step 4: 수동 확인 (앱 재시작 필요 — Rust 커맨드 변경 포함)**

1. `pnpm tauri dev`로 앱을 (재)시작한다.
2. F1로 QuickAdd를 띄운다. 칩 5개가 기본값(나 / 오늘 / 오늘 / 우선순위 없음 / Backlog)으로 보이는지 확인.
3. 각 칩을 클릭해 팝오버가 열리고, 항목 클릭 시 칩 값이 바뀌며 팝오버가 닫히는지 확인. 담당자 칩은 여러 명을 토글로 선택할 수 있고 팝오버가 계속 열려 있는지 확인.
4. Esc를 눌렀을 때: 팝오버가 열려 있으면 팝오버만 닫히고, 없으면 트레이가 닫히는지 확인.
5. 제목을 입력하고 Enter — 트레이가 닫히고 Plane에서 방금 만든 작업에 담당자/날짜/우선순위/상태가 반영됐는지 확인.
6. F1로 다시 열었을 때 모든 칩이 기본값으로 리셋돼 있는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add src/quickadd/main.ts
git commit -m "feat: wire chip toolbar interactions into QuickAdd submit flow"
```

---

## Self-Review Notes

- **스펙 커버리지:** 레이아웃(칩 툴바, Task 7), 필드 5개+기본값(Task 8), 날짜 프리셋 전용(Task 5), 담당자 다중선택(Task 8), 우선순위/상태 고정값+아이콘(Task 6), 백엔드 매핑(Task 1-3) 모두 태스크로 커버됨.
- **플레이스홀더 스캔:** 없음 — 모든 스텝에 실제 코드/명령어 포함.
- **타입 일관성:** `NewWorkItem`/`ProjectState`/`Member`/`Priority`/`StateGroup`/`DatePresetKey` 필드명이 Task 1→2→3, Task 5-6→8 사이에서 동일하게 사용됨을 확인.
- **범위 체크:** 8개 태스크 모두 이 기능 하나(QuickAdd 필드 확장)에 집중돼 있어 추가 분해 불필요.
