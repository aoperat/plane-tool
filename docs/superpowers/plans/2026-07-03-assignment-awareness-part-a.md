# 할당 인지 시스템 (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 다른 사람이 나에게 작업을 할당하면 토스트·트레이 툴팁·사이드바 수신함으로 알리고, 사용자가 "확인"을 누를 때까지 주기적으로 재알림한다. 확인은 Plane 자동 댓글로 기록된다.

**Architecture:** Rust 백엔드에 60초 주기 폴링 태스크를 추가해 "나에게 할당된 미완료 작업"을 이전 tick과 diff한다. 새 할당은 로컬 store(`assign-state.json`)에 pending으로 영속하고, `tauri-plugin-notification` 토스트 + 트레이 툴팁 + 사이드바 이벤트로 알린다. 사이드바는 pending 목록을 수신함 섹션으로 렌더링하고, 확인 버튼이 Plane Comments API에 마커 댓글을 남기면 pending에서 제거된다. 판정 로직(diff·prune·재알림 게이트)은 OS/네트워크와 분리된 순수 함수로 두고 단위 테스트한다 (`idle.rs`의 `IdleOpenGate` 패턴).

**Tech Stack:** Tauri 2 (Rust), tauri-plugin-notification 2, tauri-plugin-store 2, reqwest+wiremock, TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-assignment-awareness-design.md`

## Global Constraints

- UI 문구는 모두 한국어. 확인 댓글 마커는 정확히 `🔔 할당을 확인했습니다 (Quick Dock)` (Part B가 이 문자열로 판정하므로 상수로만 사용).
- 폴링 간격 60초 고정, 재알림 기본 2시간(설정 `assign_remind_hours`, 최소 1), 기능 토글 `assign_notify_enabled` 기본 켬.
- 설정 신규 필드는 `#[serde(default = ...)]`로 기존 설정 파일과 호환되어야 한다.
- Rust 테스트: `cargo test --manifest-path src-tauri/Cargo.toml`, TS 테스트: `pnpm test`, 타입 체크 겸 빌드: `pnpm build`.
- 커밋은 태스크당 1개. 사용자 가시 기능이 완성되는 마지막 태스크 커밋에 `CHANGELOG.md`의 `[Unreleased]` 항목 추가를 포함한다 (CLAUDE.md 규칙).
- 스펙 대비 의도적 축소 2건 (데스크톱 플랫폼 제약, 스펙 취지는 유지):
  - 트레이 "점 찍힌 아이콘 변형" 교체는 별도 아이콘 에셋이 필요해 이번엔 **툴팁 갱신만** 구현한다 (아이콘 변형은 후속).
  - 토스트의 "클릭 시 사이드바 열기"/액션 버튼은 tauri-plugin-notification 데스크톱에서 클릭 이벤트가 안정적으로 오지 않아 **정보성 토스트**로 구현한다. 확인은 사이드바 수신함에서 한다.
- Plane API 경로는 기존 `plane_api.rs`와 같은 `/work-items/` 계열을 쓴다. 라이브 서버가 comments/activities를 `/issues/` 경로로만 제공할 가능성이 있다 — Task 7 스모크 테스트에서 stderr의 404 로그를 확인하고, 404면 해당 URL만 `/issues/`로 바꾼다 (한 줄 수정, 두 경로 모두 wiremock 테스트는 경로 상수를 따라간다).

---

### Task 1: Plane API — 댓글·활동 조회, 댓글 작성, created_by 파싱

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces (Part A 후속 태스크와 Part B가 사용):
  - `pub const ACK_COMMENT_TEXT: &str = "🔔 할당을 확인했습니다 (Quick Dock)";`
  - `pub struct Comment { pub id: String, pub comment_html: String, pub actor: String }`
  - `pub struct Activity { pub field: Option<String>, pub actor: Option<String> }`
  - `impl PlaneClient`: `pub async fn list_comments(&self, project_id: &str, item_id: &str) -> Result<Vec<Comment>, String>`, `pub async fn create_comment(&self, project_id: &str, item_id: &str, comment_html: &str) -> Result<(), String>`, `pub async fn list_activities(&self, project_id: &str, item_id: &str) -> Result<Vec<Activity>, String>`
  - `pub fn find_assigner(activities: &[Activity], created_by: Option<&str>, me: &str) -> Option<String>`
  - `WorkItem`에 `pub created_by: Option<String>` 필드 추가

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/plane_api.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
    #[tokio::test]
    async fn list_comments_parses_results_with_actor_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/comments/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "c1", "comment_html": "<p>hello</p>", "actor": "u1" },
                    { "id": "c2", "comment_html": "<p>hi</p>", "created_by": "u2" }
                ]
            })))
            .mount(&server)
            .await;

        let comments = client_for(&server).await.list_comments("p1", "i1").await.unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].actor, "u1");
        assert_eq!(comments[1].actor, "u2"); // actor 없으면 created_by로 폴백
        assert_eq!(comments[0].comment_html, "<p>hello</p>");
    }

    #[tokio::test]
    async fn create_comment_posts_comment_html() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/comments/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "comment_html": "<p>🔔 할당을 확인했습니다 (Quick Dock)</p>"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .create_comment("p1", "i1", "<p>🔔 할당을 확인했습니다 (Quick Dock)</p>")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_activities_parses_field_and_actor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/activities/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "field": null, "actor": "creator-id" },
                    { "field": "assignees", "actor": "pm-id" }
                ]
            })))
            .mount(&server)
            .await;

        let acts = client_for(&server).await.list_activities("p1", "i1").await.unwrap();
        assert_eq!(acts.len(), 2);
        assert_eq!(acts[1].field.as_deref(), Some("assignees"));
        assert_eq!(acts[1].actor.as_deref(), Some("pm-id"));
    }

    #[test]
    fn find_assigner_prefers_latest_assignee_activity_by_someone_else() {
        let acts = vec![
            Activity { field: Some("assignees".into()), actor: Some("me".into()) },
            Activity { field: Some("assignees".into()), actor: Some("pm".into()) },
            Activity { field: Some("priority".into()), actor: Some("other".into()) },
        ];
        assert_eq!(find_assigner(&acts, Some("creator"), "me"), Some("pm".to_string()));
    }

    #[test]
    fn find_assigner_falls_back_to_created_by() {
        // assignee 활동이 없거나 전부 내 것이면 created_by (내가 아닐 때만)
        let acts = vec![Activity { field: Some("assignees".into()), actor: Some("me".into()) }];
        assert_eq!(find_assigner(&acts, Some("creator"), "me"), Some("creator".to_string()));
        assert_eq!(find_assigner(&[], Some("me"), "me"), None);
        assert_eq!(find_assigner(&[], None, "me"), None);
    }

    #[tokio::test]
    async fn list_work_items_parses_created_by() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{
                    "id": "i1", "name": "Fix bug", "priority": "none",
                    "state": { "group": "started" },
                    "assignees": [{ "id": "me" }],
                    "created_by": "pm-id"
                }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items[0].created_by.as_deref(), Some("pm-id"));
    }
```

기존 테스트 헬퍼 `wi_completed`(plane_api.rs와 commands.rs 각각)는 `WorkItem`에 `created_by` 필드가 생기므로 `created_by: None,`을 추가해야 컴파일된다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL — `Comment`/`Activity`/`find_assigner`/`created_by` 미정의 컴파일 에러

- [ ] **Step 3: 최소 구현**

`src-tauri/src/plane_api.rs`에 추가 (구조체들은 기존 `Member` 정의 근처, 메서드는 `impl PlaneClient` 안, `find_assigner`는 `resolve_state_id` 근처):

```rust
/// Part B(맡긴 작업 창)가 이 문자열로 확인 여부를 판정한다 — 절대 바꾸지 말 것.
pub const ACK_COMMENT_TEXT: &str = "🔔 할당을 확인했습니다 (Quick Dock)";

#[derive(Debug, Clone)]
pub struct Comment { pub id: String, pub comment_html: String, pub actor: String }

#[derive(Debug, Clone)]
pub struct Activity { pub field: Option<String>, pub actor: Option<String> }

/// 이 작업을 나에게 할당한 사람의 user id. assignees 필드를 바꾼 활동 중
/// 내가 아닌 actor의 마지막 것 → 없으면 created_by(내가 아닐 때만) → None.
pub fn find_assigner(activities: &[Activity], created_by: Option<&str>, me: &str) -> Option<String> {
    activities
        .iter()
        .rev()
        .find(|a| a.field.as_deref() == Some("assignees") && a.actor.as_deref().is_some_and(|x| x != me))
        .and_then(|a| a.actor.clone())
        .or_else(|| created_by.filter(|c| *c != me).map(str::to_string))
}
```

Raw 타입 (`RawMember` 근처):

```rust
#[derive(Deserialize)]
struct RawComment {
    id: String,
    #[serde(default)] comment_html: String,
    #[serde(default)] actor: Option<String>,
    #[serde(default)] created_by: Option<String>,
}

#[derive(Deserialize)]
struct RawActivity {
    #[serde(default)] field: Option<String>,
    #[serde(default)] actor: Option<String>,
}
```

`RawWorkItem`에 `#[serde(default)] created_by: Option<String>,` 추가, `WorkItem`에 `pub created_by: Option<String>,` 추가, `map_work_item`/`map_work_item_detail`에서 `created_by: w.created_by,` 전달 (detail은 필드가 없으므로 `map_work_item`만).

`impl PlaneClient` 메서드:

```rust
    pub async fn list_comments(&self, project_id: &str, item_id: &str) -> Result<Vec<Comment>, String> {
        let url = format!("{}/projects/{}/work-items/{}/comments/", self.ws_base(), project_id, item_id);
        let page: Paginated<RawComment> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|c| Comment {
                id: c.id,
                comment_html: c.comment_html,
                actor: c.actor.or(c.created_by).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn create_comment(&self, project_id: &str, item_id: &str, comment_html: &str) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/comments/", self.ws_base(), project_id, item_id);
        let resp = self
            .http
            .post(&url)
            .header("X-Api-Key", &self.api_key)
            .json(&serde_json::json!({ "comment_html": comment_html }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        error_with_body(resp).await?;
        Ok(())
    }

    pub async fn list_activities(&self, project_id: &str, item_id: &str) -> Result<Vec<Activity>, String> {
        let url = format!("{}/projects/{}/work-items/{}/activities/", self.ws_base(), project_id, item_id);
        let page: Paginated<RawActivity> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page.results.into_iter().map(|a| Activity { field: a.field, actor: a.actor }).collect())
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs
git commit -m "feat(api): add comments/activities endpoints and created_by parsing"
```

---

### Task 2: assign_watch — 상태 영속 + 순수 판정 로직

**Files:**
- Create: `src-tauri/src/assign_watch.rs`
- Modify: `src-tauri/src/lib.rs:1-5` (`pub mod assign_watch;` 추가)

**Interfaces:**
- Consumes: `plane_api::WorkItem` (Task 1의 `created_by` 포함)
- Produces (Task 3·4가 사용):
  - `pub struct PendingAssignment { pub item_id: String, pub project_id: String, pub name: String, pub priority: String, pub target_date: Option<String>, pub assigner_name: String, pub detected_at_ms: u64 }` (Serialize/Deserialize/Clone)
  - `pub struct AssignState { pub last_ids: HashSet<String>, pub pending: Vec<PendingAssignment>, pub last_remind_ms: u64, pub initialized: bool }` (serde default 포함)
  - `pub fn detect_new_assignments<'a>(assigned_open: &'a [WorkItem], me: &str, state: &AssignState) -> Vec<&'a WorkItem>`
  - `pub fn prune_pending(pending: Vec<PendingAssignment>, current_ids: &HashSet<String>) -> Vec<PendingAssignment>`
  - `pub fn should_remind(pending_count: usize, last_remind_ms: u64, now_ms: u64, interval_hours: u32) -> bool`
  - `pub fn toast_body(assigner_name: &str, item_name: &str, target_date: Option<&str>, priority: &str) -> String`
  - `pub fn load_state(app: &tauri::AppHandle) -> AssignState` / `pub fn save_state(app: &tauri::AppHandle, s: &AssignState) -> Result<(), String>` (store 파일 `assign-state.json`, 키 `state` — `config.rs` 패턴)

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/assign_watch.rs` 생성, 파일 끝에:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::WorkItem;

    fn wi(id: &str, assignees: &[&str], created_by: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: "unstarted".into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None,
            created_by: created_by.map(str::to_string),
        }
    }

    fn state_with_ids(ids: &[&str]) -> AssignState {
        AssignState {
            last_ids: ids.iter().map(|s| s.to_string()).collect(),
            pending: vec![],
            last_remind_ms: 0,
            initialized: true,
        }
    }

    #[test]
    fn detects_items_not_seen_last_tick() {
        let items = vec![wi("a", &["me"], Some("pm")), wi("b", &["me"], Some("pm"))];
        let new = detect_new_assignments(&items, "me", &state_with_ids(&["a"]));
        let ids: Vec<_> = new.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn skips_items_i_created_myself() {
        // QuickAdd 셀프 할당(내가 만들고 나에게 할당)은 알림 대상이 아니다
        let items = vec![wi("a", &["me"], Some("me")), wi("b", &["me"], None)];
        let new = detect_new_assignments(&items, "me", &state_with_ids(&[]));
        let ids: Vec<_> = new.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]); // created_by 미상은 알림 (놓치는 것보다 낫다)
    }

    #[test]
    fn first_run_detects_nothing() {
        // 최초 실행(state 미초기화)에는 기존 할당 전체가 새것으로 보인다 —
        // 폭주 방지를 위해 아무것도 감지하지 않고 seen 처리만 한다.
        let uninit = AssignState::default();
        assert!(!uninit.initialized);
        let items = vec![wi("a", &["me"], Some("pm"))];
        assert!(detect_new_assignments(&items, "me", &uninit).is_empty());
    }

    fn pa(id: &str) -> PendingAssignment {
        PendingAssignment {
            item_id: id.into(), project_id: "p1".into(), name: format!("n{id}"),
            priority: "none".into(), target_date: None,
            assigner_name: "pm".into(), detected_at_ms: 0,
        }
    }

    #[test]
    fn prune_drops_pending_no_longer_open_or_assigned() {
        let pending = vec![pa("a"), pa("b"), pa("c")];
        let current: std::collections::HashSet<String> =
            ["a", "c"].iter().map(|s| s.to_string()).collect();
        let kept = prune_pending(pending, &current);
        let ids: Vec<_> = kept.iter().map(|p| p.item_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn remind_fires_only_after_interval_with_pending() {
        const H: u64 = 3_600_000;
        assert!(!should_remind(0, 0, 10 * H, 2));            // pending 없음
        assert!(!should_remind(3, 9 * H, 10 * H, 2));        // 1시간 경과 < 2시간
        assert!(should_remind(3, 8 * H, 10 * H, 2));         // 2시간 경과
        assert!(should_remind(1, 0, 2 * H, 2));              // 최초(0)부터도 동작
    }

    #[test]
    fn toast_body_includes_assigner_name_due_and_priority() {
        let body = toast_body("김PM", "결제 모듈 오류 수정", Some("2026-07-05"), "urgent");
        assert!(body.contains("김PM"));
        assert!(body.contains("결제 모듈 오류 수정"));
        assert!(body.contains("2026-07-05"));
        assert!(body.contains("긴급"));
    }

    #[test]
    fn toast_body_omits_empty_due_and_none_priority() {
        let body = toast_body("김PM", "작업", None, "none");
        assert!(!body.contains("마감"));
        assert!(!body.contains("우선순위"));
    }

    #[test]
    fn assign_state_round_trips_and_defaults() {
        let s = AssignState {
            last_ids: ["a".to_string()].into_iter().collect(),
            pending: vec![pa("a")],
            last_remind_ms: 42,
            initialized: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: AssignState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.last_ids.len(), 1);
        assert_eq!(back.pending[0].item_id, "a");
        assert_eq!(back.last_remind_ms, 42);
        assert!(back.initialized);
        // 빈 JSON → 전 필드 기본값 (store에 처음 쓰기 전 상태)
        let empty: AssignState = serde_json::from_str("{}").unwrap();
        assert!(!empty.initialized);
        assert!(empty.last_ids.is_empty());
    }
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL — 모듈/타입 미정의 컴파일 에러 (lib.rs에 `pub mod assign_watch;`를 먼저 추가해야 테스트가 발견된다)

- [ ] **Step 3: 최소 구현**

`src-tauri/src/assign_watch.rs` 상단에:

```rust
//! 할당 인지: 새 할당 감지·pending 관리·재알림 판정.
//!
//! 네트워크/알림/트레이는 lib.rs의 watcher 루프가 담당하고, 이 모듈은
//! 영속 상태와 순수 판정 로직만 둔다 (idle.rs와 같은 구조).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri_plugin_store::StoreExt;

use crate::plane_api::WorkItem;

const STORE_FILE: &str = "assign-state.json";
const STORE_KEY: &str = "state";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAssignment {
    pub item_id: String,
    pub project_id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub assigner_name: String,
    pub detected_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssignState {
    /// 직전 tick에 "나에게 할당된 미완료"였던 이슈 id들.
    #[serde(default)]
    pub last_ids: HashSet<String>,
    /// 아직 사용자가 확인하지 않은 할당.
    #[serde(default)]
    pub pending: Vec<PendingAssignment>,
    /// 마지막 재알림 시각 (unix ms).
    #[serde(default)]
    pub last_remind_ms: u64,
    /// false면 최초 실행 — 감지 없이 seen 처리만 한다.
    #[serde(default)]
    pub initialized: bool,
}

/// 이번 tick의 새 할당. `assigned_open`은 이미 "나에게 할당 + 미완료"로
/// 필터된 목록이어야 한다. 내가 만든 이슈(셀프 할당)는 제외.
pub fn detect_new_assignments<'a>(
    assigned_open: &'a [WorkItem],
    me: &str,
    state: &AssignState,
) -> Vec<&'a WorkItem> {
    if !state.initialized {
        return Vec::new();
    }
    assigned_open
        .iter()
        .filter(|i| !state.last_ids.contains(&i.id))
        .filter(|i| i.created_by.as_deref() != Some(me))
        .collect()
}

/// 더 이상 나에게 할당된 미완료 상태가 아닌 pending 제거 (삭제·완료·재할당).
pub fn prune_pending(pending: Vec<PendingAssignment>, current_ids: &HashSet<String>) -> Vec<PendingAssignment> {
    pending.into_iter().filter(|p| current_ids.contains(&p.item_id)).collect()
}

/// 미확인 건이 있고 마지막 재알림에서 interval이 지났으면 true.
pub fn should_remind(pending_count: usize, last_remind_ms: u64, now_ms: u64, interval_hours: u32) -> bool {
    pending_count > 0 && now_ms.saturating_sub(last_remind_ms) >= u64::from(interval_hours) * 3_600_000
}

fn priority_label(p: &str) -> Option<&'static str> {
    match p {
        "urgent" => Some("긴급"),
        "high" => Some("높음"),
        "medium" => Some("보통"),
        "low" => Some("낮음"),
        _ => None,
    }
}

/// 토스트 본문: "김PM님이 '…'을(를) 할당했습니다" + 있으면 마감/우선순위.
pub fn toast_body(assigner_name: &str, item_name: &str, target_date: Option<&str>, priority: &str) -> String {
    let mut body = format!("{assigner_name}님이 '{item_name}'을(를) 할당했습니다");
    if let Some(d) = target_date {
        body.push_str(&format!("\n마감 {d}"));
    }
    if let Some(label) = priority_label(priority) {
        body.push_str(&format!(" · 우선순위 {label}"));
    }
    body
}

pub fn load_state(app: &tauri::AppHandle) -> AssignState {
    match app.store(STORE_FILE) {
        Ok(store) => store
            .get(STORE_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default(),
        Err(_) => AssignState::default(),
    }
}

pub fn save_state(app: &tauri::AppHandle, s: &AssignState) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(s).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}
```

주의: `toast_body`의 마감 없이 우선순위만 있는 경우 `\n마감` 없이 ` · 우선순위 …`가 첫 줄에 붙는다 — 테스트가 요구하는 것은 포함 여부뿐이므로 그대로 둔다.

`src-tauri/src/lib.rs`의 모듈 선언에 `pub mod assign_watch;` 추가 (알파벳 순서: `commands` 다음).

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/assign_watch.rs src-tauri/src/lib.rs
git commit -m "feat(assign): add assignment watch state and detection logic"
```

---

### Task 3: 설정 필드 — assign_notify_enabled / assign_remind_hours

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/commands.rs` (`SettingsDto`, `get_settings`, `save_settings`)
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`
- Modify: `src/settings/index.html`, `src/settings/main.ts`

**Interfaces:**
- Produces: `Settings.assign_notify_enabled: bool` (기본 true), `Settings.assign_remind_hours: u32` (기본 2). `save_settings`에 `assign_notify_enabled: Option<bool>`, `assign_remind_hours: Option<u32>` 파라미터(끝에 추가). TS `SettingsDto`에 `assign_notify_enabled: boolean; assign_remind_hours: number;`, `saveSettings`에 optional 파라미터 2개(끝에 추가 — 기존 호출부는 그대로 컴파일된다).

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/config.rs` tests에 추가:

```rust
    #[test]
    fn settings_default_enables_assign_notify_every_2_hours() {
        let s = Settings::default();
        assert!(s.assign_notify_enabled);
        assert_eq!(s.assign_remind_hours, 2);
    }

    #[test]
    fn settings_without_assign_fields_gets_defaults() {
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert!(s.assign_notify_enabled);
        assert_eq!(s.assign_remind_hours, 2);
    }
```

기존 `settings_round_trip_preserves_fields` 테스트의 구조체 리터럴에 `assign_notify_enabled: false, assign_remind_hours: 6,` 추가.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL — 필드 미정의 컴파일 에러

- [ ] **Step 3: 구현**

`config.rs`의 `Settings`에 (idle 필드 다음):

```rust
    /// 작업 할당 알림 (기본 켬).
    #[serde(default = "default_assign_notify_enabled")]
    pub assign_notify_enabled: bool,
    /// 미확인 할당 재알림 주기(시간).
    #[serde(default = "default_assign_remind_hours")]
    pub assign_remind_hours: u32,
```

```rust
fn default_assign_notify_enabled() -> bool { true }
fn default_assign_remind_hours() -> u32 { 2 }
```

`Default` impl에 `assign_notify_enabled: default_assign_notify_enabled(), assign_remind_hours: default_assign_remind_hours(),` 추가.

`commands.rs`: `SettingsDto`에 `pub assign_notify_enabled: bool, pub assign_remind_hours: u32,` 추가하고 `get_settings`에서 채운다. `save_settings` 시그니처 끝에 `assign_notify_enabled: Option<bool>, assign_remind_hours: Option<u32>,` 추가하고 본문에:

```rust
    if let Some(v) = assign_notify_enabled { s.assign_notify_enabled = v; }
    if let Some(v) = assign_remind_hours { if v >= 1 { s.assign_remind_hours = v; } }
```

`src/shared/types.ts`의 `SettingsDto`에 `assign_notify_enabled: boolean; assign_remind_hours: number;` 추가.

`src/shared/ipc.ts`의 `saveSettings`에 파라미터·invoke 인자 추가 (끝에):

```ts
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
  displayIndex?: number,
  idleOpenEnabled?: boolean,
  idleOpenMinutes?: number,
  assignNotifyEnabled?: boolean,
  assignRemindHours?: number,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
    displayIndex,
    idleOpenEnabled,
    idleOpenMinutes,
    assignNotifyEnabled,
    assignRemindHours,
  });
```

(현재 ipc.ts의 saveSettings가 idleOpenEnabled/idleOpenMinutes를 이미 받고 있는지 확인하고 — settings/main.ts가 9개 인자로 호출 중이므로 받고 있어야 정상 — 그 뒤에 2개를 잇는다.)

`src/settings/index.html`의 "사이드바 자동 열기" 섹션 다음에:

```html
      <h2>할당 알림</h2>
      <label class="check-row"><input id="assignNotifyEnabled" type="checkbox" />다른 사람이 나에게 작업을 할당하면 알림</label>
      <label>미확인 재알림 주기(시간)<input id="assignRemindHours" type="number" min="1" /></label>
```

`src/settings/main.ts`: 요소 참조 2개, `load()`에서 값 반영, `save` 핸들러의 `saveSettings(...)` 호출 끝에 두 인자 추가:

```ts
const assignNotifyEnabled = document.getElementById("assignNotifyEnabled") as HTMLInputElement;
const assignRemindHours = document.getElementById("assignRemindHours") as HTMLInputElement;
// load() 안:
assignNotifyEnabled.checked = s.assign_notify_enabled;
assignRemindHours.value = String(s.assign_remind_hours);
// saveSettings(...) 마지막 인자로:
assignNotifyEnabled.checked,
Math.max(1, Math.floor(Number(assignRemindHours.value) || 2)),
```

- [ ] **Step 4: 테스트·빌드 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS
Run: `pnpm build` → 성공 (TS 타입 에러 없음)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs src/shared/types.ts src/shared/ipc.ts src/settings/index.html src/settings/main.ts
git commit -m "feat(settings): add assignment notification settings"
```

---

### Task 4: 백엔드 커맨드 — pending 조회·확인 처리

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (invoke_handler 등록)

**Interfaces:**
- Consumes: Task 1 `create_comment`/`ACK_COMMENT_TEXT`/`plain_text_to_description_html`, Task 2 `load_state`/`save_state`/`PendingAssignment`
- Produces (Task 5·6이 사용):
  - command `get_pending_assignments() -> Vec<PendingAssignmentDto>` — DTO 필드: `item_id, project_id, name, priority, target_date, assigner_name, detected_at_ms` (Task 2 구조체와 동일 형태)
  - command `acknowledge_assignment(project_id: String, item_id: String) -> Result<(), String>`
  - 이벤트 `assignments-updated` (payload 없음, sidebar 대상) — 확인 처리 후 emit
  - `pub fn update_tray_tooltip(app: &tauri::AppHandle, pending_count: usize)` — Task 5의 watcher도 사용

- [ ] **Step 1: 구현** (커맨드는 store·네트워크 의존이라 이 태스크는 순수 로직이 없다 — 단위 테스트 대상은 Task 1·2에서 이미 커버된 부품들이고, 여기는 조립만.)

`commands.rs`에 추가:

```rust
use crate::assign_watch;

#[derive(Serialize)]
pub struct PendingAssignmentDto {
    pub item_id: String,
    pub project_id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub assigner_name: String,
    pub detected_at_ms: u64,
}

#[tauri::command]
pub fn get_pending_assignments(app: tauri::AppHandle) -> Vec<PendingAssignmentDto> {
    assign_watch::load_state(&app)
        .pending
        .into_iter()
        .map(|p| PendingAssignmentDto {
            item_id: p.item_id,
            project_id: p.project_id,
            name: p.name,
            priority: p.priority,
            target_date: p.target_date,
            assigner_name: p.assigner_name,
            detected_at_ms: p.detected_at_ms,
        })
        .collect()
}

/// 수신함 "확인" 버튼: Plane에 마커 댓글을 남기고 pending에서 제거한다.
/// 댓글 작성이 실패하면 pending을 건드리지 않고 에러를 돌려준다 —
/// 확인 기록 없이 수신함에서만 사라지면 할당자 쪽 추적이 어긋난다.
#[tauri::command]
pub async fn acknowledge_assignment(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let html = plain_text_to_description_html(crate::plane_api::ACK_COMMENT_TEXT);
    client.create_comment(&project_id, &item_id, &html).await?;
    let mut state = assign_watch::load_state(&app);
    state.pending.retain(|p| p.item_id != item_id);
    let count = state.pending.len();
    assign_watch::save_state(&app, &state)?;
    crate::update_tray_tooltip(&app, count);
    let _ = app.emit_to("sidebar", "assignments-updated", ());
    Ok(())
}
```

`lib.rs`에 트레이 툴팁 헬퍼 추가 (`show_window` 근처) — 트레이는 Task 5에서 `with_id("main")`로 바뀌기 전이므로 이 시점엔 `tray_by_id`가 None을 반환해도 무해하다:

```rust
/// 미확인 할당 수를 트레이 툴팁에 반영. 0이면 기본 툴팁으로 복귀.
pub fn update_tray_tooltip(app: &tauri::AppHandle, pending_count: usize) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if pending_count > 0 {
            format!("Plane Quick Dock — 미확인 할당 {pending_count}건")
        } else {
            "Plane Quick Dock".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}
```

`lib.rs`의 `invoke_handler`에 `commands::get_pending_assignments, commands::acknowledge_assignment,` 등록 (`check_updates_manual` 앞).

- [ ] **Step 2: 컴파일·기존 테스트 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (회귀 없음)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(assign): add pending list and acknowledge commands"
```

---

### Task 5: 알림 플러그인 + watcher 루프 배선

**Files:**
- Modify: `src-tauri/Cargo.toml` (tauri-plugin-notification 추가)
- Modify: `src-tauri/src/lib.rs` (플러그인 init, 트레이 id, watcher spawn + tick 함수)

**Interfaces:**
- Consumes: Task 1 `list_activities`/`find_assigner`/`list_members`, Task 2 전체, Task 3 설정, Task 4 `update_tray_tooltip`
- Produces: 60초 주기 감지가 실제로 돈다. 새 할당 → 토스트 + 툴팁 + `assignments-updated` emit. 재알림 토스트("미확인 할당 N건").

- [ ] **Step 1: 의존성·플러그인 추가**

`src-tauri/Cargo.toml` dependencies에:

```toml
tauri-plugin-notification = "2"
```

`lib.rs`의 builder 체인에 `.plugin(tauri_plugin_notification::init())` 추가 (`tauri_plugin_dialog` 다음). `TrayIconBuilder::new()`를 `TrayIconBuilder::with_id("main")`으로 변경.

- [ ] **Step 2: watcher 구현**

`lib.rs`에 (spawn_idle_watcher 근처). 파일 상단 import에 `use tauri_plugin_notification::NotificationExt;` 추가:

```rust
/// 할당 감지 폴링 간격. Plane 레이트 리밋을 고려해 60초 고정 (스펙 승인값).
const ASSIGN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

fn spawn_assign_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ASSIGN_POLL_INTERVAL).await;
            let s = config::load_settings(&app);
            if !s.assign_notify_enabled {
                continue;
            }
            if let Err(e) = assign_tick(&app, &s).await {
                // 오프라인/미설정은 정상 상황 — 로그만 남기고 다음 tick.
                eprintln!("assign watch tick failed: {e}");
            }
        }
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn assign_tick(app: &tauri::AppHandle, s: &config::Settings) -> Result<(), String> {
    if s.base_url.is_empty() || s.workspace.is_empty() {
        return Ok(());
    }
    let Some(token) = config::get_token() else { return Ok(()) };
    let client = plane_api::PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token);
    let me = client.current_user().await?.id;

    // 나에게 할당된 미완료 작업 전체 (프로젝트별 N+1 — 사이드바와 같은 패턴)
    let projects = client.list_projects().await?;
    let mut assigned_open: Vec<plane_api::WorkItem> = Vec::new();
    for p in &projects {
        let Ok(items) = client.list_work_items(&p.id).await else { continue };
        assigned_open.extend(items.into_iter().filter(|i| {
            i.assignee_ids.iter().any(|a| a == &me)
                && i.state_group != "completed"
                && i.state_group != "cancelled"
        }));
    }

    let mut state = assign_watch::load_state(app);
    let current_ids: std::collections::HashSet<String> =
        assigned_open.iter().map(|i| i.id.clone()).collect();

    // 새 할당 감지 → 할당자 이름 조회 → pending 추가 + 개별 토스트
    let new_items: Vec<plane_api::WorkItem> =
        assign_watch::detect_new_assignments(&assigned_open, &me, &state)
            .into_iter()
            .cloned()
            .collect();
    for item in &new_items {
        let assigner_id = client
            .list_activities(&item.project_id, &item.id)
            .await
            .ok()
            .and_then(|acts| plane_api::find_assigner(&acts, item.created_by.as_deref(), &me));
        let assigner_name = match &assigner_id {
            Some(id) => client
                .list_members(&item.project_id)
                .await
                .ok()
                .and_then(|ms| ms.into_iter().find(|m| &m.id == id))
                .map(|m| m.display_name)
                .unwrap_or_else(|| "누군가".into()),
            None => "누군가".into(),
        };
        let _ = app
            .notification()
            .builder()
            .title("새 작업이 할당되었습니다")
            .body(assign_watch::toast_body(
                &assigner_name,
                &item.name,
                item.target_date.as_deref(),
                item.priority.as_str(),
            ))
            .show();
        state.pending.push(assign_watch::PendingAssignment {
            item_id: item.id.clone(),
            project_id: item.project_id.clone(),
            name: item.name.clone(),
            priority: item.priority.clone(),
            target_date: item.target_date.clone(),
            assigner_name,
            detected_at_ms: now_ms(),
        });
    }
    if !new_items.is_empty() {
        // 방금 개별 토스트를 보냈으니 재알림 타이머도 지금부터 센다.
        state.last_remind_ms = now_ms();
    }

    // 사라진 항목 정리 + 재알림
    state.pending = assign_watch::prune_pending(std::mem::take(&mut state.pending), &current_ids);
    if assign_watch::should_remind(state.pending.len(), state.last_remind_ms, now_ms(), s.assign_remind_hours) {
        let _ = app
            .notification()
            .builder()
            .title("미확인 할당이 있습니다")
            .body(format!("확인하지 않은 할당 작업 {}건 — 사이드바에서 확인하세요", state.pending.len()))
            .show();
        state.last_remind_ms = now_ms();
    }

    state.last_ids = current_ids;
    state.initialized = true;
    let pending_count = state.pending.len();
    assign_watch::save_state(app, &state)?;
    update_tray_tooltip(app, pending_count);
    let _ = app.emit_to("sidebar", "assignments-updated", ());
    Ok(())
}
```

`setup`에서 `spawn_idle_watcher(...)` 다음에 `spawn_assign_watcher(app.handle().clone());` 추가.

- [ ] **Step 3: 컴파일·기존 테스트 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS. (`cargo build`가 새 플러그인을 받아오며 시간이 걸릴 수 있음)

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat(assign): wire 60s assignment watcher with toast and tray tooltip"
```

---

### Task 6: 사이드바 수신함 UI

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`
- Modify: `src/sidebar/logic.ts`, Test: `src/sidebar/logic.test.ts`
- Modify: `src/sidebar/index.html`, `src/sidebar/main.ts`
- Modify: `src/shared/app.css`

**Interfaces:**
- Consumes: Task 4 커맨드 `get_pending_assignments`/`acknowledge_assignment`, 이벤트 `assignments-updated`
- Produces: `formatRelativeTime(thenMs: number, nowMs: number): string` (logic.ts), `PendingAssignment` TS 타입

- [ ] **Step 1: 실패하는 테스트 작성**

`src/sidebar/logic.test.ts`에 추가:

```ts
import { formatRelativeTime } from "./logic";

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;
  it("1분 미만은 '방금 전'", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("방금 전");
  });
  it("분 단위", () => {
    expect(formatRelativeTime(now - 10 * 60_000, now)).toBe("10분 전");
  });
  it("시간 단위", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3시간 전");
  });
  it("일 단위", () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2일 전");
  });
  it("미래 타임스탬프(시계 오차)는 '방금 전'으로 처리", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("방금 전");
  });
});
```

(파일 상단 import 스타일은 기존 logic.test.ts를 따른다 — 이미 `./logic`에서 여러 함수를 import하고 있으면 거기에 `formatRelativeTime`을 추가.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test`
Expected: FAIL — `formatRelativeTime` is not exported

- [ ] **Step 3: 구현**

`src/sidebar/logic.ts`에 추가:

```ts
/** unix ms 타임스탬프를 "방금 전"/"N분 전"/"N시간 전"/"N일 전"으로. */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs;
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}
```

`src/shared/types.ts`에:

```ts
export interface PendingAssignment {
  item_id: string; project_id: string; name: string;
  priority: string; target_date: string | null;
  assigner_name: string; detected_at_ms: number;
}
```

`src/shared/ipc.ts`에:

```ts
export const getPendingAssignments = () =>
  invoke<PendingAssignment[]>("get_pending_assignments");
export const acknowledgeAssignment = (project_id: string, item_id: string) =>
  invoke<void>("acknowledge_assignment", { projectId: project_id, itemId: item_id });
```

(타입 import 줄에 `PendingAssignment` 추가.)

`src/sidebar/index.html`의 `<div class="sb-section">` 안, `<div class="h">…` 위에 수신함 컨테이너 추가:

```html
          <div id="inbox" class="inbox-sec" hidden></div>
```

정확한 위치: `<div class="sb-section">` 바로 다음 줄 (기존 "나에게 할당된 작업" 헤더보다 위).

`src/shared/app.css`의 사이드바 섹션(릴리즈 노트 스타일 앞)에 추가:

```css
/* ---- sidebar assignment inbox ---- */
.inbox-sec {
  background: var(--accent-soft); border: 1px solid rgba(79,124,255,.35);
  border-radius: 9px; padding: 9px 8px 4px; margin-bottom: 12px;
}
.inbox-sec[hidden] { display: none; }
.inbox-sec .inbox-h {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 5px; padding: 0 2px;
}
.inbox-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); display: inline-block; margin-right: 6px; }
.new-task {
  background: var(--panel); border: 1px solid rgba(79,124,255,.3);
  border-radius: 8px; margin-bottom: 6px; padding: 8px 9px;
}
.new-task .assigner { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--muted); margin-bottom: 6px; }
.new-task .assigner b { color: var(--text); font-weight: 600; }
.new-task .assigner .when { margin-left: auto; color: var(--muted-2); }
.new-task .nt-name { font-size: 13px; line-height: 1.4; }
.new-task .nt-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.ack-row { display: flex; gap: 6px; margin-top: 8px; }
.ack-btn {
  flex: 1; text-align: center; font-size: 11px; font-weight: 600; padding: 5px 0;
  border-radius: 6px; background: var(--accent); color: #fff; border: none;
  cursor: pointer; font-family: inherit;
}
.ack-btn:hover { filter: brightness(1.08); }
.ack-btn:disabled { opacity: .6; cursor: default; }
.ack-ghost {
  flex: none; font-size: 11px; padding: 5px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  cursor: pointer; font-family: inherit;
}
.ack-ghost:hover { color: var(--text); border-color: var(--accent); }
```

`src/sidebar/main.ts`에 수신함 렌더링 추가. import에 `getPendingAssignments, acknowledgeAssignment`(ipc), `PendingAssignment`(types), `formatRelativeTime`(logic)을 잇는다 (우선순위 라벨은 main.ts에 이미 있는 `PRIORITY_LABELS` 상수 재사용):

```ts
const inboxEl = document.getElementById("inbox")!;

function renderInbox(pending: PendingAssignment[]) {
  inboxEl.hidden = pending.length === 0;
  inboxEl.innerHTML = "";
  if (pending.length === 0) return;

  const head = document.createElement("div");
  head.className = "inbox-h";
  head.innerHTML = `<span><span class="inbox-dot"></span>새로 할당됨</span><span>${pending.length}</span>`;
  inboxEl.appendChild(head);

  for (const p of pending) {
    const card = document.createElement("div");
    card.className = "new-task";

    const who = document.createElement("div");
    who.className = "assigner";
    who.innerHTML = `<b></b>님이 할당 <span class="when">${formatRelativeTime(p.detected_at_ms, Date.now())}</span>`;
    who.querySelector("b")!.textContent = p.assigner_name;
    card.appendChild(who);

    const name = document.createElement("div");
    name.className = "nt-name";
    name.textContent = p.name;
    card.appendChild(name);

    const chips = document.createElement("div");
    chips.className = "nt-chips";
    if (p.priority !== "none") {
      const prio = document.createElement("span");
      prio.className = "chip sm";
      prio.style.color = priorityColor(p.priority as any);
      prio.innerHTML = `${priorityIcon(p.priority as any)} ${PRIORITY_LABELS[p.priority] ?? p.priority}`;
      chips.appendChild(prio);
    }
    if (p.target_date) {
      const due = document.createElement("span");
      due.className = "chip sm";
      due.innerHTML = `${CALENDAR_ICON} ~ ${p.target_date}`;
      chips.appendChild(due);
    }
    if (chips.childElementCount > 0) card.appendChild(chips);

    const row = document.createElement("div");
    row.className = "ack-row";
    const ack = document.createElement("button");
    ack.className = "ack-btn";
    ack.textContent = "✓ 확인했습니다";
    ack.onclick = async () => {
      ack.disabled = true;
      try {
        await acknowledgeAssignment(p.project_id, p.item_id);
        // 목록 갱신은 백엔드가 emit하는 assignments-updated가 처리한다.
      } catch (err) {
        ack.disabled = false;
        synced.textContent = "확인 처리 실패: " + err;
        console.error("acknowledgeAssignment failed:", err);
      }
    };
    row.appendChild(ack);
    const open = document.createElement("button");
    open.className = "ack-ghost";
    open.textContent = "열기";
    open.onclick = () => openEditModal(p.project_id, p.item_id);
    row.appendChild(open);
    card.appendChild(row);

    inboxEl.appendChild(card);
  }
}

async function refreshInbox() {
  try {
    renderInbox(await getPendingAssignments());
  } catch (err) {
    console.error("getPendingAssignments failed:", err);
  }
}

win.listen("assignments-updated", refreshInbox);
```

그리고 기존 `refresh()` 마지막(성공 경로)에 `refreshInbox();` 호출 한 줄을 추가하고, 파일 끝 `refresh();` 옆에 `refreshInbox();`를 추가한다.

- [ ] **Step 4: 테스트·빌드 통과 확인**

Run: `pnpm test` → PASS
Run: `pnpm build` → 성공

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/sidebar/logic.ts src/sidebar/logic.test.ts src/sidebar/index.html src/sidebar/main.ts src/shared/app.css
git commit -m "feat(sidebar): add new-assignment inbox with acknowledge action"
```

---

### Task 7: 스모크 테스트 + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 전체 테스트**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS
Run: `pnpm test` → PASS

- [ ] **Step 2: 라이브 스모크 테스트**

`pnpm tauri dev`로 실행 후:

1. Plane 웹에서 **다른 계정으로** 나에게 이슈를 할당한다 (다른 계정이 없으면: 내 계정으로 새 이슈를 만들되 assignee를 나로 두면 `created_by == me`라 알림이 안 오는 게 정상이므로, 반드시 타인 계정 또는 관리자에게 부탁).
2. 60초 내에 토스트가 뜨는지, 트레이 아이콘 툴팁이 "미확인 할당 1건"으로 바뀌는지 확인.
3. 사이드바를 열어 "새로 할당됨" 수신함에 카드(할당자 이름·경과 시간·칩)가 보이는지 확인.
4. "✓ 확인했습니다" 클릭 → 카드가 사라지고, Plane 웹의 해당 이슈 댓글에 `🔔 할당을 확인했습니다 (Quick Dock)`가 남았는지 확인.
5. **404 확인**: 콘솔(stderr)에 `HTTP 404`가 comments/activities URL로 찍히면 라이브 서버가 `/work-items/` 경로를 지원하지 않는 것 — `plane_api.rs`의 `list_comments`/`create_comment`/`list_activities` URL의 `work-items`를 `issues`로 바꾸고 wiremock 테스트 path도 같이 수정 후 재검증.
6. 설정 화면에서 "할당 알림" 체크 해제 → 저장 → 새 할당에 알림이 오지 않는지 확인(다음 tick부터).

- [ ] **Step 3: CHANGELOG 기록**

`CHANGELOG.md`의 `## [Unreleased]` → `### 추가`에:

```markdown
- 다른 사람이 나에게 작업을 할당하면 알림으로 알려줌 — 토스트·트레이 툴팁·사이드바 "새로 할당됨" 수신함, 확인 버튼을 누를 때까지 주기적으로 재알림 (설정에서 끄거나 주기 변경 가능)
```

- [ ] **Step 4: 커밋**

```bash
git add CHANGELOG.md
git commit -m "feat(assign): finish assignment awareness (Part A) with changelog"
```

---

## Part B 예고 (이 계획의 범위 밖)

"맡긴 작업" 창(Part B)은 이 계획이 라이브 검증한 comments 엔드포인트와 `ACK_COMMENT_TEXT` 마커 위에 얹는다. Part A 완료 후 별도 계획(`2026-07-XX-assignment-awareness-part-b.md`)으로 작성한다: 새 윈도우 등록(tauri.conf.json + vite input + capabilities), `fetch_delegated_data` 커맨드, `src/delegated/` UI, 지연·정체 분류 로직, 리마인드 댓글 액션.
