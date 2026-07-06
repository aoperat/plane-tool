# 오프라인 모드 Phase 1 (캐시 + 쓰기 큐 + 자동 재생) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plane 서버가 꺼져있어도 마지막 목록을 계속 보고, 이슈 생성/수정/삭제를
계속할 수 있게 하며, 서버가 복구되면 자동으로 동기화한다.

**Architecture:** Rust 백엔드에 `offline.rs` 모듈을 추가해 (1) 마지막
`fetch_sidebar_data` 응답을 `cache.json`에 스냅샷으로 저장했다가 네트워크
실패 시 되돌려주고, (2) 각 쓰기 커맨드가 네트워크 오류를 만나면 요청을
`pending-queue.json`에 적재 + 캐시에 낙관적으로 반영 + `Ok(())`를 돌려주며,
(3) 별도 백그라운드 루프가 20초마다 연결을 확인하다 복구를 감지하면 큐를
순서대로 재생(replay)한다. 프런트엔드는 오프라인 배지와 대기 건수 배지만
추가한다.

**Tech Stack:** Rust(Tauri 2, `tauri-plugin-store`, `reqwest`), TypeScript(Vite,
vitest), 기존 `assign_watch.rs`/`config.rs`와 동일한 스토어 패턴.

## Global Constraints

- 이 Phase(1)는 **충돌 감지·수동 병합 화면을 다루지 않는다** — 재생은 항상
  마지막 값으로 덮어쓴다(last-write-wins). 그 사이 다른 곳에서 같은 항목이
  바뀐 경우의 안전장치는 별도 계획(Phase 2, `docs/superpowers/specs/2026-07-06-offline-mode-design.md`의
  "수동 병합 화면" 섹션)에서 다룬다. 스펙 문서 자체는 최종 상태(충돌 포함)를
  기준으로 쓰여 있으므로, 이 Phase가 그 부분 구현이 아직 없다는 걸 알고
  진행할 것.
- **`acknowledge_assignment`(할당 확인 마커 댓글)는 이 계획의 범위 밖이다** —
  별도 상태 파일(`assign-state.json`)과 락을 쓰는 다른 기능이라 오프라인
  큐잉을 섞으면 복잡도만 커진다. 오프라인 중 확인 버튼을 누르면 지금처럼
  즉시 에러가 난다(변경 없음).
- **네트워크 오류 판정**은 오직 `plane_api::is_network_error(&str)`로만
  한다 — `"HTTP "`로 시작하지 않으면 네트워크 오류로 본다(Task 1 참고).
  커맨드 최상단의 `client(&app)?`(not_configured)나 사전 검증
  (`empty_title` 등)은 이 판정 대상이 아니다 — 네트워크를 아직 타지도
  않았으므로 항상 즉시 에러로 보여준다.
- **`WorkItemDto`(목록 캐시 모양)는 `state_group`/`priority`를 사람이 읽는
  문자열 그대로 저장**하고 있어(`id`로 변환하지 않음), 오프라인 중 캐시를
  낙관적으로 갱신할 때 서버 id 조회가 전혀 필요 없다 — 이 성질이 이 계획
  전체를 단순하게 만드는 핵심 전제이니 바꾸지 말 것.
- 재생 중 큐 항목이 **네트워크 오류 외의 이유로 실패하면(검증 오류 등)
  재생을 그 항목에서 멈추고 큐에 남긴다** — 다음 재연결 때 같은 오류가
  반복될 수 있다는 걸 알고 있는 의도적 단순화다(Phase 2에서 해결).

---

### Task 1: `is_network_error` 판정 함수

**Files:**
- Modify: `src-tauri/src/plane_api.rs` (기존 `error_with_body` 함수 아래)

**Interfaces:**
- Produces: `pub fn is_network_error(err: &str) -> bool` — 이후 모든 태스크가
  `Err(e) if plane_api::is_network_error(&e) => { ... }` 형태로 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/plane_api.rs`의 `#[cfg(test)] mod tests` 블록 끝에 추가:

```rust
    #[test]
    fn is_network_error_distinguishes_http_status_from_transport_failure() {
        assert!(!is_network_error("HTTP 400 Bad Request (http://x): oops"));
        assert!(is_network_error("error sending request for url (http://x/): connection refused"));
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test is_network_error 2>&1 | tail -30`
Expected: FAIL — `cannot find function is_network_error`

- [ ] **Step 3: 함수 구현**

`error_with_body` 함수 바로 아래에 추가:

```rust
/// True when `err` (a String produced by this client's methods) reflects a
/// network-transport failure (server unreachable, timeout, DNS, TLS) rather
/// than a server-side rejection. `error_with_body` always formats HTTP error
/// responses as `"HTTP {status} (...)"`; every other error string in this
/// file comes from `reqwest`'s own `Display`, which never starts with that
/// prefix. Used by the offline queue to decide "queue for later" vs
/// "show the user a real error right now".
pub fn is_network_error(err: &str) -> bool {
    !err.starts_with("HTTP ")
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test is_network_error 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(offline): add is_network_error classifier"
```

---

### Task 2: `create_work_item`이 생성된 이슈 id를 돌려준다

**Files:**
- Modify: `src-tauri/src/plane_api.rs` (`create_work_item` 메서드 + 관련 테스트)
- Modify: `src-tauri/src/commands.rs` (`create_issue`의 호출부, id는 아직 버림)

**Interfaces:**
- Produces: `PlaneClient::create_work_item(&self, project_id: &str, item: &NewWorkItem<'_>) -> Result<String, String>`
  (기존엔 `Result<(), String>`) — Task 11에서 이 id를 실제로 사용한다.

- [ ] **Step 1: 실패하는 테스트로 기존 테스트 수정**

`create_work_item_sends_all_fields` 테스트의 mock 응답과 끝부분을 다음으로
교체(파일 내 `.respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))`
부분과 마지막 줄):

```rust
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "new-item-1" })))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: Some("2026-07-01"),
            target_date: Some("2026-07-02"),
            priority: "high",
            state_id: "state-1",
            description_html: Some("<p>World</p>"),
        };
        let id = client_for(&server).await.create_work_item("p1", &item).await.unwrap();
        assert_eq!(id, "new-item-1");
```

같은 방식으로 `create_work_item_omits_absent_optional_fields`의 응답도
`{ "id": "new-item-2" }`로 바꾸고 마지막 줄을
`let id = client_for(&server).await.create_work_item("p1", &item).await.unwrap();`
+ `assert_eq!(id, "new-item-2");`로 바꾼다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test create_work_item 2>&1 | tail -40`
Expected: FAIL — 타입 불일치(`()` vs `String`) 컴파일 에러

- [ ] **Step 3: 구현**

`create_work_item` 메서드를 다음으로 교체(주석의 "Nothing consumes the
created item, so skip parsing the body" 문장도 삭제):

```rust
    pub async fn create_work_item(
        &self,
        project_id: &str,
        item: &NewWorkItem<'_>,
    ) -> Result<String, String> {
        // The create endpoint (no `expand` param) returns `assignees`/`state` as
        // flat id strings, not the nested objects `RawWorkItem` expects (that
        // shape only applies to the `expand=assignees,state` list endpoint).
        // We only need the new item's own id from the response.
        let url = format!("{}/projects/{}/work-items/", self.ws_base(), project_id);
        // Absent optional fields are omitted rather than sent as `null` —
        // Plane 0.27+ rejects `"description_html": null` with a 400.
        let mut body = serde_json::Map::new();
        body.insert("name".into(), serde_json::json!(item.name));
        body.insert("assignees".into(), serde_json::json!(item.assignee_ids));
        body.insert("priority".into(), serde_json::json!(item.priority));
        body.insert("state".into(), serde_json::json!(item.state_id));
        if let Some(sd) = item.start_date {
            body.insert("start_date".into(), serde_json::json!(sd));
        }
        if let Some(td) = item.target_date {
            body.insert("target_date".into(), serde_json::json!(td));
        }
        if let Some(dh) = item.description_html {
            body.insert("description_html".into(), serde_json::json!(dh));
        }
        let resp = self
            .send_retrying(
                self.http
                    .post(&url)
                    .header("X-Api-Key", &self.api_key)
                    .json(&serde_json::Value::Object(body)),
            )
            .await?;
        #[derive(Deserialize)]
        struct CreatedId {
            id: String,
        }
        let created: CreatedId = resp.json().await.map_err(|e| e.to_string())?;
        Ok(created.id)
    }
```

`commands.rs`의 `create_issue`에서 호출부를 수정(아직 id는 쓰지 않고 버림):

```rust
    let _new_id = client.create_work_item(&project_id, &item).await?;
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS (전체 테스트 스위트)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs
git commit -m "feat(offline): create_work_item returns the created item id"
```

---

### Task 3: `SidebarData`/DTO들이 캐시 왕복(Deserialize)과 `is_cached` 표시를 지원

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `SidebarData { projects, assigned, states, is_cached: bool, cached_at_ms: Option<u64> }`,
  전부 `Serialize + Deserialize + Clone`. `WorkItemDto`/`ProjectDto`/`StateDto`도
  `Deserialize + Clone` 추가.
- Consumed by: Task 4의 `CacheSnapshot { data: SidebarData, .. }`.

- [ ] **Step 1: 실패하는 테스트 작성**

`commands.rs`의 테스트 모듈에 추가:

```rust
    #[test]
    fn sidebar_data_round_trips_through_json_and_defaults_is_cached_to_false() {
        let data = assemble_sidebar("me", vec![], vec![], vec![], "2026-06-30", "2026-07-02");
        let json = serde_json::to_string(&data).unwrap();
        let back: SidebarData = serde_json::from_str(&json).unwrap();
        assert!(!back.is_cached);
        assert_eq!(back.cached_at_ms, None);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test sidebar_data_round_trips 2>&1 | tail -30`
Expected: FAIL — `SidebarData` doesn't implement `Deserialize`

- [ ] **Step 3: 구현**

`commands.rs` 상단의 DTO 정의들을 다음으로 교체:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDto { pub id: String, pub name: String, pub identifier: String }

#[derive(Serialize)]
pub struct MemberDto { pub id: String, pub display_name: String, pub is_me: bool }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Serialize)]
pub struct WorkItemDetailDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub assignee_ids: Vec<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: String,
    pub state_group: String,
    pub project_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    pub states: Vec<StateDto>,
    /// 캐시(오프라인 폴백)에서 온 응답이면 true. 실시간 fetch 결과는 항상
    /// false — 캐시 파일에는 절대 저장되지 않는 응답 전용 표시라 skip한다.
    #[serde(skip, default)]
    pub is_cached: bool,
    #[serde(skip, default)]
    pub cached_at_ms: Option<u64>,
}
```

`assemble_sidebar` 함수의 마지막 `SidebarData { projects, assigned, states }`를
`SidebarData { projects, assigned, states, is_cached: false, cached_at_ms: None }`로
바꾼다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): make SidebarData round-trip through JSON for caching"
```

---

### Task 4: `offline.rs` 모듈 — 타입 + 영속화(cache.json)

**Files:**
- Create: `src-tauri/src/offline.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod offline;` 추가, `now_ms`를 `pub(crate)`로)

**Interfaces:**
- Produces: `offline::CacheSnapshot`, `offline::load_cache(app) -> Option<CacheSnapshot>`,
  `offline::save_cache(app, data: &SidebarData, now_ms: u64) -> Result<(), String>`,
  `offline::save_cache_snapshot(app, snapshot: &CacheSnapshot) -> Result<(), String>`.

- [ ] **Step 1: 모듈 골격 작성 (테스트 없이 — 순수 저장/로드는 기존
  `assign_watch.rs`/`config.rs` 컨벤션대로 직접 테스트하지 않는다)**

`src-tauri/src/offline.rs` 새로 작성:

```rust
//! 오프라인 캐시 · 쓰기 큐 · 재생(replay) 순수 로직 + 영속화.
//!
//! 네트워크 판정과 백그라운드 루프는 lib.rs가 담당하고, 이 모듈은 데이터
//! 구조와 영속 상태, 순수 판정 로직만 둔다 (assign_watch.rs와 같은 구조).

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use crate::commands::{SidebarData, WorkItemDto};

const STORE_FILE: &str = "offline.json";
const CACHE_KEY: &str = "cache";
const QUEUE_KEY: &str = "queue";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSnapshot {
    pub data: SidebarData,
    pub cached_at_ms: u64,
}

pub fn load_cache(app: &tauri::AppHandle) -> Option<CacheSnapshot> {
    app.store(STORE_FILE)
        .ok()?
        .get(CACHE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
}

pub fn save_cache_snapshot(app: &tauri::AppHandle, snapshot: &CacheSnapshot) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(CACHE_KEY, serde_json::to_value(snapshot).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

pub fn save_cache(app: &tauri::AppHandle, data: &SidebarData, now_ms: u64) -> Result<(), String> {
    save_cache_snapshot(app, &CacheSnapshot { data: data.clone(), cached_at_ms: now_ms })
}
```

- [ ] **Step 2: `lib.rs`에 모듈 등록 + `now_ms` 공개**

`lib.rs` 맨 위 `pub mod` 목록에 `pub mod offline;` 추가(알파벳 순서 유지,
`monitors` 다음 `offline` 다음 `openai`):

```rust
pub mod assign_watch;
pub mod briefing;
pub mod commands;
pub mod config;
pub mod idle;
pub mod monitors;
pub mod offline;
pub mod openai;
pub mod plane_api;
```

`fn now_ms()` 정의를 `pub(crate) fn now_ms()`로 바꾼다(다른 부분은 그대로).

- [ ] **Step 3: 컴파일 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -40`
Expected: 경고(unused function 등)는 있을 수 있으나 에러 없이 빌드 성공

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/offline.rs src-tauri/src/lib.rs
git commit -m "feat(offline): add cache snapshot module and persistence"
```

---

### Task 5: `offline.rs` — 큐 타입 + 순수 로직(적재/치환/캐시 패치) + 테스트

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Produces: `MutationKind`, `PendingMutation`, `OfflineQueue`, `load_queue`,
  `save_queue`, `push_mutation`, `remap_target_id`, `patch_cached_item`,
  `remove_cached_item`, `remap_cached_item_id`, `is_recovery_transition`.
  Task 6~13이 전부 이 함수들을 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`offline.rs` 끝에 추가:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dto(id: &str) -> WorkItemDto {
        WorkItemDto {
            id: id.into(), name: "n".into(), priority: "none".into(),
            target_date: None, start_date: None, state_group: "backlog".into(),
            project_id: "p1".into(), completed_at: None, created_at: None,
        }
    }

    #[test]
    fn push_mutation_appends_and_returns_a_unique_id() {
        let mut q = OfflineQueue::default();
        let id1 = push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "i1", serde_json::json!({"priority":"high"}), 1000);
        let id2 = push_mutation(&mut q, MutationKind::Delete, "p1", "i2", serde_json::Value::Null, 1000);
        assert_eq!(q.items.len(), 2);
        assert_ne!(id1, id2);
        assert_eq!(q.items[0].target_id, "i1");
        assert_eq!(q.items[1].kind, MutationKind::Delete);
    }

    #[test]
    fn remap_target_id_updates_every_matching_entry() {
        let mut q = OfflineQueue::default();
        push_mutation(&mut q, MutationKind::CreateIssue, "p1", "local-1", serde_json::Value::Null, 1000);
        push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "local-1", serde_json::json!({"priority":"high"}), 1001);
        push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "other", serde_json::json!({"priority":"low"}), 1002);
        remap_target_id(&mut q, "local-1", "real-99");
        assert_eq!(q.items[0].target_id, "real-99");
        assert_eq!(q.items[1].target_id, "real-99");
        assert_eq!(q.items[2].target_id, "other"); // untouched
    }

    #[test]
    fn patch_cached_item_mutates_only_the_matching_item() {
        let mut items = vec![dto("a"), dto("b")];
        patch_cached_item(&mut items, "b", |d| d.priority = "urgent".into());
        assert_eq!(items[0].priority, "none");
        assert_eq!(items[1].priority, "urgent");
    }

    #[test]
    fn remove_cached_item_drops_the_matching_item_only() {
        let mut items = vec![dto("a"), dto("b")];
        remove_cached_item(&mut items, "a");
        let ids: Vec<_> = items.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn remap_cached_item_id_renames_only_the_matching_item() {
        let mut items = vec![dto("local-1"), dto("other")];
        remap_cached_item_id(&mut items, "local-1", "real-1");
        let ids: Vec<_> = items.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["real-1", "other"]);
    }

    #[test]
    fn is_recovery_transition_only_fires_going_from_offline_to_online() {
        assert!(is_recovery_transition(true, true));
        assert!(!is_recovery_transition(true, false));
        assert!(!is_recovery_transition(false, true));
        assert!(!is_recovery_transition(false, false));
    }

    #[test]
    fn queue_round_trips_through_json() {
        let mut q = OfflineQueue::default();
        push_mutation(&mut q, MutationKind::Delete, "p1", "i1", serde_json::Value::Null, 1000);
        let json = serde_json::to_string(&q).unwrap();
        let back: OfflineQueue = serde_json::from_str(&json).unwrap();
        assert_eq!(back.items.len(), 1);
        assert_eq!(back.items[0].target_id, "i1");
    }
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test offline:: 2>&1 | tail -60`
Expected: FAIL — 타입/함수 없음 컴파일 에러

- [ ] **Step 3: 구현**

`offline.rs`의 `use` 문 아래, `CacheSnapshot` 위나 아래에 추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MutationKind {
    CreateIssue,
    UpdatePriority,
    UpdateState,
    UpdateFields,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingMutation {
    pub id: String,
    pub kind: MutationKind,
    pub project_id: String,
    pub target_id: String,
    pub payload: serde_json::Value,
    pub queued_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OfflineQueue {
    pub items: Vec<PendingMutation>,
}

pub fn load_queue(app: &tauri::AppHandle) -> OfflineQueue {
    match app.store(STORE_FILE) {
        Ok(store) => store.get(QUEUE_KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        Err(_) => OfflineQueue::default(),
    }
}

pub fn save_queue(app: &tauri::AppHandle, q: &OfflineQueue) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(QUEUE_KEY, serde_json::to_value(q).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

/// 큐에 새 변경을 적재하고 그 항목의 id를 돌려준다. id는 `target_id`(실제
/// 이슈 id 또는 오프라인 생성 임시 id)와는 다른, 큐 항목 자체의 식별자다.
pub fn push_mutation(
    queue: &mut OfflineQueue,
    kind: MutationKind,
    project_id: &str,
    target_id: &str,
    payload: serde_json::Value,
    now_ms: u64,
) -> String {
    let id = format!("pending-{now_ms}-{}", queue.items.len());
    queue.items.push(PendingMutation {
        id: id.clone(),
        kind,
        project_id: project_id.to_string(),
        target_id: target_id.to_string(),
        payload,
        queued_at_ms: now_ms,
    });
    id
}

/// 오프라인 생성 임시 id(`local-*`)를 참조하던 큐 항목들을 실제 서버 id로
/// 치환한다 — `CreateIssue` 재생이 성공한 직후 호출.
pub fn remap_target_id(queue: &mut OfflineQueue, old_id: &str, new_id: &str) {
    for m in queue.items.iter_mut() {
        if m.target_id == old_id {
            m.target_id = new_id.to_string();
        }
    }
}

pub fn patch_cached_item(items: &mut [WorkItemDto], target_id: &str, patch: impl FnOnce(&mut WorkItemDto)) {
    if let Some(dto) = items.iter_mut().find(|d| d.id == target_id) {
        patch(dto);
    }
}

pub fn remove_cached_item(items: &mut Vec<WorkItemDto>, target_id: &str) {
    items.retain(|d| d.id != target_id);
}

pub fn remap_cached_item_id(items: &mut [WorkItemDto], old_id: &str, new_id: &str) {
    if let Some(dto) = items.iter_mut().find(|d| d.id == old_id) {
        dto.id = new_id.to_string();
    }
}

/// true면 직전 tick은 오프라인이었고 이번 tick은 온라인 — 큐 재생을 트리거할 시점.
pub fn is_recovery_transition(was_offline: bool, is_online_now: bool) -> bool {
    was_offline && is_online_now
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test offline:: 2>&1 | tail -60`
Expected: PASS (7개 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(offline): add pending-mutation queue and pure replay helpers"
```

---

### Task 6: `offline.rs` — 커맨드 편의 함수(큐 적재 + 캐시 패치 + 이벤트)

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Consumes: Task 5의 `push_mutation`/`patch_cached_item`/`remove_cached_item`.
- Produces: `queue_and_patch`, `queue_create_and_insert`, `queue_delete_and_remove`
  — Task 7~11의 커맨드들이 이걸 호출한다.

- [ ] **Step 1: 구현** (AppHandle을 다루는 접착 코드라 `assign_watch.rs`
  컨벤션대로 직접 단위 테스트하지 않는다 — Task 5의 순수 함수들로 이미
  핵심 로직은 커버됨)

`offline.rs` 끝(테스트 모듈 위)에 추가:

```rust
fn emit_queue_changed(app: &tauri::AppHandle, pending: usize) {
    let _ = app.emit_to("sidebar", "offline-queue-changed", serde_json::json!({ "pending": pending }));
}

/// 네트워크 실패 시 공통 처리: 큐에 적재 + 캐시에 낙관적 반영 + 이벤트 발행.
/// `patch`는 캐시 스냅샷에 있는 해당 항목(WorkItemDto)에 적용할 변경.
/// 캐시가 아직 없거나(첫 실행부터 오프라인) 항목을 못 찾으면 조용히
/// 건너뛴다 — 큐잉 자체는 캐시 유무와 무관하게 항상 성공해야 한다.
pub fn queue_and_patch(
    app: &tauri::AppHandle,
    kind: MutationKind,
    project_id: &str,
    target_id: &str,
    payload: serde_json::Value,
    patch: impl FnOnce(&mut WorkItemDto),
) -> Result<(), String> {
    let now = crate::now_ms();
    let mut queue = load_queue(app);
    push_mutation(&mut queue, kind, project_id, target_id, payload, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(mut snapshot) = load_cache(app) {
        patch_cached_item(&mut snapshot.data.assigned, target_id, patch);
        save_cache_snapshot(app, &snapshot)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
}

/// `create_issue`가 오프라인일 때: 큐에 생성 요청을 적재하고, 임시 id를 붙인
/// `placeholder`를 캐시 목록에 즉시 추가해 화면에 보이게 한다. 임시 id를 돌려준다.
pub fn queue_create_and_insert(
    app: &tauri::AppHandle,
    project_id: &str,
    payload: serde_json::Value,
    mut placeholder: WorkItemDto,
) -> Result<String, String> {
    let now = crate::now_ms();
    let mut queue = load_queue(app);
    let local_id = format!("local-{now}-{}", queue.items.len());
    push_mutation(&mut queue, MutationKind::CreateIssue, project_id, &local_id, payload, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(mut snapshot) = load_cache(app) {
        placeholder.id = local_id.clone();
        snapshot.data.assigned.push(placeholder);
        save_cache_snapshot(app, &snapshot)?;
    }
    emit_queue_changed(app, pending);
    Ok(local_id)
}

/// `delete_work_item`이 오프라인일 때: 큐에 삭제 요청을 적재하고 캐시
/// 목록에서 즉시 제거한다.
pub fn queue_delete_and_remove(app: &tauri::AppHandle, project_id: &str, target_id: &str) -> Result<(), String> {
    let now = crate::now_ms();
    let mut queue = load_queue(app);
    push_mutation(&mut queue, MutationKind::Delete, project_id, target_id, serde_json::Value::Null, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(mut snapshot) = load_cache(app) {
        remove_cached_item(&mut snapshot.data.assigned, target_id);
        save_cache_snapshot(app, &snapshot)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
}
```

- [ ] **Step 2: 컴파일 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -40`
Expected: 에러 없이 빌드 성공 (미사용 함수 경고는 이번 태스크에서는 정상 —
다음 태스크들에서 사용됨)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(offline): add queue-and-patch helpers for write commands"
```

---

### Task 7: `fetch_sidebar_data` — 성공 시 캐시 저장, 네트워크 실패 시 캐시로 폴백

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `offline::save_cache`, `offline::load_cache`.
- Produces: `pub async fn fetch_sidebar_data_online(...)` — Task 12(재생 후
  새로고침)이 재사용 가능하나 이 태스크에서는 `fetch_sidebar_data` 내부
  전용으로만 쓴다.

- [ ] **Step 1: `plane_api` 모듈 자체를 import 범위에 추가**

`commands.rs` 맨 위의 import를 (기존 항목은 그대로 두고 `self,`만 추가):

```rust
use crate::plane_api::{self, filter_assigned_visible, plain_text_to_description_html, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
```

이렇게 해야 이 태스크부터 쓰는 `plane_api::is_network_error(&e)`가 (개별
아이템만 가져오던 기존 import로는) 컴파일되지 않는 문제를 피한다 — `self`를
넣으면 모듈 이름 자체도 함께 스코프에 들어온다.

- [ ] **Step 2: 실패하는 테스트 작성**

`commands.rs` 테스트 모듈에 추가(순수 폴백 판단 로직만 분리해 테스트 —
`fetch_sidebar_data` 자체는 `AppHandle`이 필요해 다른 커맨드들처럼 직접
테스트하지 않는다):

```rust
    #[test]
    fn sidebar_data_from_cache_marks_is_cached_and_carries_timestamp() {
        let mut data = assemble_sidebar("me", vec![], vec![], vec![], "2026-06-30", "2026-07-02");
        mark_from_cache(&mut data, 12345);
        assert!(data.is_cached);
        assert_eq!(data.cached_at_ms, Some(12345));
    }
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test sidebar_data_from_cache 2>&1 | tail -30`
Expected: FAIL — `mark_from_cache` 없음

- [ ] **Step 4: 구현**

`assemble_sidebar` 함수 아래에 작은 헬퍼 추가:

```rust
/// 캐시에서 돌려주는 응답임을 표시한다 — 실시간 fetch 결과에는 호출하지 않는다.
pub fn mark_from_cache(data: &mut SidebarData, cached_at_ms: u64) {
    data.is_cached = true;
    data.cached_at_ms = Some(cached_at_ms);
}
```

`fetch_sidebar_data` 커맨드를 다음으로 교체:

```rust
#[tauri::command]
pub async fn fetch_sidebar_data(
    app: tauri::AppHandle,
    completed_after: String,
    completed_before: String,
) -> Result<SidebarData, String> {
    let (client, _s) = client(&app)?;
    match fetch_sidebar_data_online(&client, &completed_after, &completed_before).await {
        Ok(data) => {
            crate::offline::save_cache(&app, &data, crate::now_ms())?;
            Ok(data)
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let snapshot = crate::offline::load_cache(&app)
                .ok_or_else(|| "오프라인 상태이며 아직 캐시된 데이터가 없습니다".to_string())?;
            let mut data = snapshot.data;
            mark_from_cache(&mut data, snapshot.cached_at_ms);
            Ok(data)
        }
        Err(e) => Err(e),
    }
}

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
    Ok(assemble_sidebar(&user.id, projects, all_items, all_states, completed_after, completed_before))
}
```

- [ ] **Step 5: 테스트 통과 확인 + 전체 스위트**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): fall back to the last cached snapshot when fetch fails offline"
```

---

### Task 8: `update_work_item_priority` — 오프라인 큐잉

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1~4: 구현 + 빌드 확인** (이 태스크부터는 `AppHandle` 의존
  커맨드라 기존 컨벤션대로 직접 단위 테스트를 추가하지 않는다 — Task 5의
  순수 헬퍼들이 이미 테스트됨. 대신 매 태스크마다 `cargo build`/`cargo test`
  로 회귀만 확인한다.)

`update_work_item_priority` 커맨드를 다음으로 교체:

```rust
#[tauri::command]
pub async fn update_work_item_priority(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    priority: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let body = serde_json::json!({ "priority": priority });
    match client.update_work_item(&project_id, &item_id, body.clone()).await {
        Ok(()) => Ok(()),
        Err(e) if plane_api::is_network_error(&e) => {
            let p = priority.clone();
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdatePriority,
                &project_id,
                &item_id,
                body,
                move |dto| dto.priority = p,
            )
        }
        Err(e) => Err(e),
    }
}
```

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): queue priority changes made while offline"
```

---

### Task 9: `update_work_item_state` — 오프라인 큐잉 (캐시된 states로 그룹 표시)

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: 구현**

`update_work_item_state` 커맨드를 다음으로 교체:

```rust
#[tauri::command]
pub async fn update_work_item_state(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    state_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let body = serde_json::json!({ "state": state_id });
    match client.update_work_item(&project_id, &item_id, body.clone()).await {
        Ok(()) => Ok(()),
        Err(e) if plane_api::is_network_error(&e) => {
            // 목록 캐시는 state_group(문자열)을 저장하므로, 표시용으로만
            // 캐시된 states 목록에서 이 state_id에 해당하는 그룹명을 찾는다
            // — 못 찾아도 큐잉 자체는 그대로 진행한다(재생 시 실제 id로 처리).
            let group = crate::offline::load_cache(&app)
                .and_then(|c| c.data.states.iter().find(|s| s.id == state_id).map(|s| s.group.clone()));
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdateState,
                &project_id,
                &item_id,
                body,
                move |dto| {
                    if let Some(g) = group {
                        dto.state_group = g;
                    }
                },
            )
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 2: 빌드 + 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): queue state changes made while offline"
```

---

### Task 10: `update_work_item_fields` — 온라인 로직 분리 + 오프라인 큐잉

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `pub(crate) async fn try_update_fields_online(...) -> Result<(), String>`
  — Task 12(replay)가 그대로 재사용한다. 시그니처를 정확히 지킬 것.

- [ ] **Step 1: 구현**

`update_work_item_fields` 커맨드를 다음 두 함수로 교체:

```rust
pub(crate) async fn try_update_fields_online(
    client: &PlaneClient,
    project_id: &str,
    item_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    assignee_ids: Option<&[String]>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    priority: Option<&str>,
    state_group: Option<&str>,
) -> Result<(), String> {
    let description_html = description.map(plain_text_to_description_html);
    let state_id = match state_group {
        Some(sg) => {
            let states = client.list_states(project_id).await?;
            Some(resolve_state_id(&states, sg).ok_or_else(|| format!("no state found for group '{sg}'"))?)
        }
        None => None,
    };
    let body = build_update_body(
        name,
        description_html.as_deref(),
        assignee_ids,
        start_date,
        target_date,
        priority,
        state_id.as_deref(),
    );
    if body.as_object().is_some_and(|m| m.is_empty()) {
        return Ok(());
    }
    client.update_work_item(project_id, item_id, body).await
}

#[tauri::command]
pub async fn update_work_item_fields(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    name: Option<String>,
    description: Option<String>,
    assignee_ids: Option<Vec<String>>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: Option<String>,
    state_group: Option<String>,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let result = try_update_fields_online(
        &client,
        &project_id,
        &item_id,
        name.as_deref(),
        description.as_deref(),
        assignee_ids.as_deref(),
        start_date.as_deref(),
        target_date.as_deref(),
        priority.as_deref(),
        state_group.as_deref(),
    )
    .await;
    match result {
        Ok(()) => {
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let payload = serde_json::json!({
                "name": name, "description": description, "assignee_ids": assignee_ids,
                "start_date": start_date, "target_date": target_date,
                "priority": priority, "state_group": state_group,
            });
            let name_p = name.clone();
            let priority_p = priority.clone();
            let start_date_p = start_date.clone();
            let target_date_p = target_date.clone();
            let state_group_p = state_group.clone();
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdateFields,
                &project_id,
                &item_id,
                payload,
                move |dto| {
                    if let Some(n) = name_p { dto.name = n; }
                    if let Some(p) = priority_p { dto.priority = p; }
                    if let Some(sd) = start_date_p { dto.start_date = if sd.is_empty() { None } else { Some(sd) }; }
                    if let Some(td) = target_date_p { dto.target_date = if td.is_empty() { None } else { Some(td) }; }
                    if let Some(sg) = state_group_p { dto.state_group = sg; }
                },
            )
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 2: 빌드 + 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS (기존 `update_work_item_fields`를 쓰던 프런트엔드 IPC 시그니처는
변경 없음)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): queue full field edits made while offline"
```

---

### Task 11: `delete_work_item` — 오프라인 큐잉

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: 구현**

```rust
#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    match client.delete_work_item(&project_id, &item_id).await {
        Ok(()) => {
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            crate::offline::queue_delete_and_remove(&app, &project_id, &item_id)?;
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 2: 빌드 + 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): queue deletes made while offline"
```

---

### Task 12: `create_issue` — 온라인 로직 분리 + 임시 id로 오프라인 큐잉

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `pub(crate) async fn try_create_issue_online(...) -> Result<String, String>`
  — Task 13(replay)이 재사용. 시그니처를 정확히 지킬 것.

- [ ] **Step 1: 구현**

`create_issue` 커맨드를 다음 두 함수로 교체:

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
) -> Result<String, String> {
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids.to_vec()
    };
    let states = client.list_states(project_id).await?;
    let state_id = resolve_state_id(&states, state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let description_html = description.filter(|d| !d.is_empty()).map(plain_text_to_description_html);
    let item = NewWorkItem {
        name,
        assignee_ids: &assignees,
        start_date,
        target_date,
        priority,
        state_id: &state_id,
        description_html: description_html.as_deref(),
    };
    client.create_work_item(project_id, &item).await
}

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
    description: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let trimmed = name.trim().to_string();
    let result = try_create_issue_online(
        &client, &project_id, &trimmed, &assignee_ids,
        start_date.as_deref(), target_date.as_deref(), &priority, &state_group, description.as_deref(),
    )
    .await;
    match result {
        Ok(_new_id) => {
            config::set_last_project(&app, &project_id)?;
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let payload = serde_json::json!({
                "name": trimmed, "assignee_ids": assignee_ids,
                "start_date": start_date, "target_date": target_date,
                "priority": priority, "state_group": state_group, "description": description,
            });
            let placeholder = WorkItemDto {
                id: String::new(),
                name: trimmed,
                priority: priority.clone(),
                target_date: target_date.clone(),
                start_date: start_date.clone(),
                state_group: state_group.clone(),
                project_id: project_id.clone(),
                completed_at: None,
                created_at: None,
            };
            crate::offline::queue_create_and_insert(&app, &project_id, payload, placeholder)?;
            config::set_last_project(&app, &project_id)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 2: 빌드 + 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(offline): queue issue creation made while offline with a temp id"
```

---

### Task 13: `lib.rs` — 큐 재생(replay) + 재연결 감지 백그라운드 루프

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `commands::try_create_issue_online`, `commands::try_update_fields_online`,
  `offline::{load_queue, save_queue, remap_target_id, load_cache, save_cache_snapshot,
  remap_cached_item_id, is_recovery_transition}`, `plane_api::is_network_error`.

- [ ] **Step 1: replay 함수 작성**

`lib.rs`의 `spawn_assign_watcher`/`assign_tick` 아래(`fn show_window` 위)에 추가:

```rust
/// 오프라인 재연결 감지 폴링 간격. 할당 알림(assign_notify_enabled)이 꺼져
/// 있어도 오프라인 큐 동기화는 항상 동작해야 하므로 assign_tick과는 별도
/// 루프를 둔다.
const OFFLINE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

fn spawn_offline_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut was_offline = false;
        loop {
            tokio::time::sleep(OFFLINE_POLL_INTERVAL).await;
            let s = config::load_settings(&app);
            if s.base_url.is_empty() || s.workspace.is_empty() {
                continue;
            }
            let Some(token) = config::get_token() else { continue };
            let probe = plane_api::PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token);
            let is_online = probe.current_user().await.is_ok();
            if offline::is_recovery_transition(was_offline, is_online) {
                replay_queue(&app).await;
            }
            was_offline = !is_online;
        }
    });
}

/// 큐를 순서대로 재생한다. 네트워크 오류를 다시 만나거나(아직 오프라인)
/// 그 외 오류(검증 오류 등, Phase 2에서 다룰 충돌 포함)를 만나면 그 항목과
/// 이후 항목을 큐에 남긴 채 멈춘다.
async fn replay_queue(app: &tauri::AppHandle) {
    let mut queue = offline::load_queue(app);
    if queue.items.is_empty() {
        return;
    }
    let s = config::load_settings(app);
    if s.base_url.is_empty() || s.workspace.is_empty() {
        return;
    }
    let Some(token) = config::get_token() else { return };
    let client = plane_api::PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token);

    while !queue.items.is_empty() {
        let m = queue.items[0].clone();
        match replay_one(&client, &m).await {
            Ok(Some(real_id)) => {
                offline::remap_target_id(&mut queue, &m.target_id, &real_id);
                if let Some(mut snapshot) = offline::load_cache(app) {
                    offline::remap_cached_item_id(&mut snapshot.data.assigned, &m.target_id, &real_id);
                    let _ = offline::save_cache_snapshot(app, &snapshot);
                }
                queue.items.remove(0);
            }
            Ok(None) => {
                queue.items.remove(0);
            }
            Err(e) if plane_api::is_network_error(&e) => {
                eprintln!("offline replay stopped: still offline: {e}");
                break;
            }
            Err(e) => {
                eprintln!("offline replay stopped: mutation {} failed: {e}", m.id);
                break;
            }
        }
    }
    let _ = offline::save_queue(app, &queue);
    let _ = app.emit_to(
        "sidebar",
        "offline-queue-changed",
        serde_json::json!({ "pending": queue.items.len() }),
    );
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
}

/// 큐 항목 하나를 재생. `CreateIssue`가 성공하면 실제 서버 id를
/// `Some(..)`으로 돌려줘 호출자가 이후 항목들의 target_id를 치환하게 한다.
async fn replay_one(client: &plane_api::PlaneClient, m: &offline::PendingMutation) -> Result<Option<String>, String> {
    match m.kind {
        offline::MutationKind::CreateIssue => {
            let p = &m.payload;
            let assignee_ids: Vec<String> = p
                .get("assignee_ids")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let new_id = commands::try_create_issue_online(
                client,
                &m.project_id,
                p.get("name").and_then(|v| v.as_str()).unwrap_or_default(),
                &assignee_ids,
                p.get("start_date").and_then(|v| v.as_str()),
                p.get("target_date").and_then(|v| v.as_str()),
                p.get("priority").and_then(|v| v.as_str()).unwrap_or("none"),
                p.get("state_group").and_then(|v| v.as_str()).unwrap_or_default(),
                p.get("description").and_then(|v| v.as_str()),
            )
            .await?;
            Ok(Some(new_id))
        }
        offline::MutationKind::UpdatePriority | offline::MutationKind::UpdateState => {
            client.update_work_item(&m.project_id, &m.target_id, m.payload.clone()).await?;
            Ok(None)
        }
        offline::MutationKind::UpdateFields => {
            let p = &m.payload;
            let assignee_ids: Option<Vec<String>> = p.get("assignee_ids").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
            });
            commands::try_update_fields_online(
                client,
                &m.project_id,
                &m.target_id,
                p.get("name").and_then(|v| v.as_str()),
                p.get("description").and_then(|v| v.as_str()),
                assignee_ids.as_deref(),
                p.get("start_date").and_then(|v| v.as_str()),
                p.get("target_date").and_then(|v| v.as_str()),
                p.get("priority").and_then(|v| v.as_str()),
                p.get("state_group").and_then(|v| v.as_str()),
            )
            .await?;
            Ok(None)
        }
        offline::MutationKind::Delete => {
            client.delete_work_item(&m.project_id, &m.target_id).await?;
            Ok(None)
        }
    }
}
```

- [ ] **Step 2: watcher 등록**

`run()`의 `setup` 클로저 안, `spawn_assign_watcher(app.handle().clone());` 바로
아래 줄에 추가:

```rust
            spawn_offline_watcher(app.handle().clone());
```

- [ ] **Step 3: 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -60`
Expected: PASS (전체 스위트, 회귀 없음)

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(offline): replay the queue on reconnect, remapping temp ids"
```

---

### Task 14: 대기 건수 조회 커맨드 등록

**Files:**
- Modify: `src-tauri/src/commands.rs` (새 커맨드)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler`에 등록)

**Interfaces:**
- Produces: `get_offline_status(app) -> OfflineStatusDto { pending: usize }` —
  Task 15의 프런트엔드가 사이드바 시작 시 1회 호출.

- [ ] **Step 1: 구현**

`commands.rs`의 `acknowledge_assignment` 아래에 추가:

```rust
#[derive(Serialize)]
pub struct OfflineStatusDto {
    pub pending: usize,
}

#[tauri::command]
pub fn get_offline_status(app: tauri::AppHandle) -> OfflineStatusDto {
    OfflineStatusDto { pending: crate::offline::load_queue(&app).items.len() }
}
```

`lib.rs`의 `invoke_handler(tauri::generate_handler![...])` 목록 끝
(`check_updates_manual` 다음)에 추가:

```rust
            commands::get_offline_status,
```

- [ ] **Step 2: 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -40`
Expected: 에러 없이 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(offline): add get_offline_status command"
```

---

### Task 15: 프런트엔드 — 오프라인/대기 배지 + IPC/타입 확장 + CHANGELOG

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/sidebar/logic.ts`
- Modify: `src/sidebar/logic.test.ts`
- Modify: `src/sidebar/main.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `offlineStatusText(isCached: boolean, cachedAtMs: number | null, pending: number, now: number) -> string`
  in `logic.ts` — pure, tested.

- [ ] **Step 1: 타입/IPC 확장**

`src/shared/types.ts`의 `SidebarData` 인터페이스를 다음으로 교체:

```typescript
export interface SidebarData {
  projects: Project[]; assigned: WorkItem[]; states: ProjectState[];
  is_cached: boolean; cached_at_ms: number | null;
}
export interface OfflineStatus { pending: number; }
```

`src/shared/ipc.ts` 끝에 추가:

```typescript
export const getOfflineStatus = () => invoke<OfflineStatus>("get_offline_status");
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/sidebar/logic.test.ts`에 추가:

```typescript
import { offlineStatusText } from "./logic";

describe("offlineStatusText", () => {
  it("shows pending count when items are queued, regardless of cache state", () => {
    expect(offlineStatusText(false, null, 2, 1000)).toBe("동기화 대기 2건");
  });
  it("shows offline-with-timestamp when serving from cache and nothing pending", () => {
    const now = 1_000_000;
    const cachedAt = now - 65_000; // just over a minute ago
    expect(offlineStatusText(true, cachedAt, 0, now)).toContain("오프라인");
  });
  it("falls back to normal synced message when online and nothing pending", () => {
    expect(offlineStatusText(false, null, 0, 1000)).toBe("동기화 완료");
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool && pnpm test -- sidebar/logic 2>&1 | tail -40`
Expected: FAIL — `offlineStatusText` not exported

- [ ] **Step 4: 구현**

`src/sidebar/logic.ts`에 추가(파일 내 다른 순수 함수들과 같은 위치 스타일로):

```typescript
/** 사이드바 footer에 보여줄 동기화 상태 문구. 대기 중인 변경이 있으면
 *  그것부터 보여주고(가장 실용적인 정보), 없으면 캐시 여부에 따라
 *  오프라인/정상 동기화 문구를 고른다. */
export function offlineStatusText(
  isCached: boolean,
  cachedAtMs: number | null,
  pending: number,
  now: number,
): string {
  if (pending > 0) return `동기화 대기 ${pending}건`;
  if (isCached && cachedAtMs != null) {
    const d = new Date(cachedAtMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `오프라인 · 마지막 동기화 ${hh}:${mm}`;
  }
  return "동기화 완료";
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool && pnpm test -- sidebar/logic 2>&1 | tail -40`
Expected: PASS

- [ ] **Step 6: `main.ts` 배선**

`src/sidebar/main.ts` 상단 import 목록에 `getOfflineStatus`를 추가하고
(`fetchReleaseNotes` 옆), `logic` import 목록에 `offlineStatusText`를 추가.

`let lastProjects: Project[] = [];` 아래에 상태 변수 추가:

```typescript
let pendingCount = 0;
```

`runRefresh()` 함수의 `try` 블록 내부, `synced.textContent = "동기화 완료";`
줄을 다음으로 교체:

```typescript
    synced.textContent = offlineStatusText(data.is_cached, data.cached_at_ms, pendingCount, Date.now());
```

같은 함수의 `catch` 블록은 그대로 둔다(진짜 설정 오류 등 네트워크 이외의
실패는 지금처럼 "동기화 실패: …"로 보여준다 — `fetch_sidebar_data`는 순수
네트워크 실패일 때 더 이상 던지지 않고 캐시를 반환하므로 이 catch는 이제
`not_configured` 같은 경우에만 걸린다).

파일 맨 아래, `win.listen("assignments-updated", refreshInbox);` 다음 줄에 추가:

```typescript
win.listen("offline-queue-changed", (e) => {
  pendingCount = (e.payload as { pending: number }).pending;
  synced.textContent = offlineStatusText(false, null, pendingCount, Date.now());
});
```

`refresh(); refreshInbox();` 두 줄 위에 초기 대기 건수 조회 추가:

```typescript
getOfflineStatus().then((s) => { pendingCount = s.pending; }).catch(() => {});
```

- [ ] **Step 7: 타입체크 + 전체 테스트**

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -60`
Expected: 에러 없음

Run: `cd C:/WorkSpaces/plane-tool && pnpm test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 8: CHANGELOG**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 추가` 섹션에 한 줄 추가(섹션이
없으면 새로 만든다):

```markdown
### 추가

- 서버 연결이 끊겨도 마지막으로 불러온 목록을 계속 보고, 이슈 생성·수정·
  삭제를 이어갈 수 있습니다. 연결이 복구되면 자동으로 동기화됩니다.
```

- [ ] **Step 9: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/sidebar/logic.ts src/sidebar/logic.test.ts src/sidebar/main.ts CHANGELOG.md
git commit -m "feat(offline): show offline/pending status in the sidebar footer"
```

---

## 완료 후 수동 확인 (커밋 대상 아님)

`/verify` 또는 아래를 직접 실행해 실제 동작을 확인한다:

1. 앱 실행 → 정상 동기화 확인.
2. Windows 방화벽 또는 hosts 파일로 Plane 서버 주소를 일시 차단 →
   사이드바를 새로고침 → "오프라인 · 마지막 동기화 …" 표시 확인, 기존 목록이
   그대로 남아있는지 확인.
3. 차단된 상태에서 QuickAdd로 새 이슈 생성, 사이드바에서 우선순위/상태/날짜
   변경, 삭제 시도 → 전부 즉시 반영(롤백 없이)되고 "동기화 대기 N건" 배지가
   올라가는지 확인.
4. 차단 해제 → 최대 20초 내 자동으로 "동기화 완료"로 바뀌고, 오프라인 중
   만든 항목들이 실제 Plane 서버에 반영됐는지 웹에서 확인.
