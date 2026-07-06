# 오프라인 모드 Phase 2 (충돌 감지 + 수동 병합 화면) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오프라인 중 큐에 쌓인 변경을 재생(replay)할 때, 그 사이 서버에서 같은
항목이 바뀌었거나 삭제됐으면 자동으로 덮어쓰지 않고 사용자가 직접 확인·선택하는
병합 화면으로 넘긴다.

**Architecture:** Plane의 `updated_at`을 목록 캐시(`WorkItemDto`)에 저장해뒀다가,
오프라인 큐잉 시점의 값을 `PendingMutation.base_updated_at`으로 남긴다. 재생 시
서버에서 그 항목을 다시 조회해 `updated_at`을 비교 — 다르면(또는 항목이
사라졌으면) 그 변경을 적용하지 않고 `conflicts.json`으로 옮긴다(재생은 계속
진행, 멈추지 않는다). 새 창 `conflict`가 이 목록을 필드 단위로 보여주고, 사용자가
"내 값 유지"/"서버 값 사용"을 고르면 그 결과를 반영한다.

**Tech Stack:** Phase 1과 동일 — Rust(Tauri 2, `tauri-plugin-store`, `reqwest`),
TypeScript(Vite, vitest). Phase 1이 만든 `offline.rs`/`plane_api.rs`/`lib.rs`
구조를 그대로 확장한다.

## Global Constraints

- **`CreateIssue`는 충돌 대상이 아니다** — 새로 만드는 이슈는 비교할 서버 상태가
  없다. 이 계획의 모든 충돌 감지·해결 로직은 `UpdatePriority`/`UpdateState`/
  `UpdateFields`/`Delete` 네 종류에만 적용된다.
- **`Delete` + 대상이 이미 삭제됨(TargetDeleted)은 충돌이 아니라 자동 성공이다**
  — 사용자가 원한 최종 상태(그 항목이 없음)가 이미 달성된 것이므로 조용히
  큐에서 제거한다. 사용자에게 물어볼 필요가 없다.
- **충돌 판정은 오직 `updated_at` 문자열 비교로만 한다** — 큐잉 시점 값
  (`base_updated_at`)과 재생 시점에 새로 조회한 값이 다르면 충돌, 같으면
  통과. 둘 중 하나라도 없으면(캐시에 없었거나 서버 응답에 없으면) **검증 불가로
  보고 그냥 진행한다** — Phase 1의 "정보 부족 시 막지 않는다" 원칙을 그대로
  따른다.
- **충돌을 만나도 재생은 멈추지 않는다** — Phase 1은 아무 오류에서나 재생 전체를
  멈췄지만, Phase 2는 충돌을 명확히 구분해낼 수 있으므로 그 항목만 큐에서 빼서
  `conflicts.json`으로 옮기고 **다음 항목으로 계속 진행**한다. (네트워크 오류나
  그 외 알 수 없는 오류를 만나면 Phase 1과 동일하게 멈춘다 — 이건 그대로 유지.)
- **`resolve_conflict`의 "적용"은 종류별로 다르게 동작한다**: `Delete` →
  지금 삭제 실행. `UpdatePriority`/`UpdateState` → 큐잉 당시 그대로 저장해둔
  PATCH 바디(`local_payload`)를 재전송(필드가 하나뿐이라 부분 병합이 필요 없다).
  `UpdateFields` → 프런트엔드가 필드별로 고른 값을 합쳐 보낸 `fields`를 그대로
  `try_update_fields_online`에 넘긴다(상태 그룹→id 변환은 이 함수가 이미
  온라인 상태로 다시 해준다).
- 담당자(assignee) 비교는 이름이 아니라 **id 목록 그대로 보여준다** — 이름
  해석까지 하면 범위가 커진다. 이미 좁은 기능 안의 드문 경우이므로 MVP로 충분.
- **`updated_at`을 추가하면 `WorkItem`/`WorkItemDetail`/`WorkItemDto`를 리터럴로
  만드는 모든 곳(각 파일의 테스트 헬퍼, `create_issue`의 오프라인 placeholder)이
  한꺼번에 컴파일이 깨진다** — 이 필드를 추가하는 태스크(Task 1)는 크레이트
  전체가 다시 컴파일되도록 관련된 모든 리터럴을 같은 태스크 안에서 고친다.
  "이 파일만 고치고 나중 태스크에서 나머지를 고친다"로 쪼개지 않는다 — 그렇게
  쪼개면 그 태스크의 `cargo test`가 통과할 수 없다.

---

### Task 1: `updated_at` 필드 플러밍 (plane_api.rs + commands.rs)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `WorkItem.updated_at: Option<String>`, `WorkItemDetail.updated_at: Option<String>`,
  `WorkItemDto.updated_at: Option<String>`, `pub fn is_not_found_error(err: &str) -> bool`
  — Task 5(오프라인 큐잉 시 `base_updated_at` 캡처)가 `WorkItemDto.updated_at`을
  읽고, Task 6(`replay_one`)이 `is_not_found_error`와 `WorkItemDetail.updated_at`을
  쓴다.

새 필드 하나(`updated_at`)가 `WorkItem`/`WorkItemDetail`/`WorkItemDto` 세 구조체
모두에 늘어나므로, 이 필드를 리터럴로 나열하는 **모든 곳**이 이 태스크
안에서 함께 고쳐져야 크레이트가 다시 컴파일된다 — 그래서 두 파일을 한
태스크로 묶는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`plane_api.rs`의 테스트 모듈에 추가:

```rust
    #[test]
    fn is_not_found_error_only_matches_http_404() {
        assert!(is_not_found_error("HTTP 404 Not Found (http://x): oops"));
        assert!(!is_not_found_error("HTTP 400 Bad Request (http://x): oops"));
        assert!(!is_not_found_error("error sending request for url (http://x/): connection refused"));
    }
```

`list_work_items_parses_expanded_state_and_assignees` 테스트의 mock 응답 json에
`"updated_at": "2026-07-01T10:00:00Z"`를 추가하고, 마지막에 다음 단언을 추가:

```rust
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-01T10:00:00Z"));
```

`get_work_item_parses_description_dates_and_assignees` 테스트도 같은 방식으로
mock에 `"updated_at": "2026-07-05T08:00:00Z"` 추가 + 단언
`assert_eq!(detail.updated_at.as_deref(), Some("2026-07-05T08:00:00Z"));` 추가.

`commands.rs` 테스트 모듈에 추가:

```rust
    #[test]
    fn assemble_sidebar_carries_updated_at_into_work_item_dto() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let mut item = wi("a", "started", &["me"], "p1");
        item.updated_at = Some("2026-07-01T10:00:00Z".into());
        let data = assemble_sidebar("me", projects, vec![item], vec![], "2026-06-30", "2026-07-02");
        assert_eq!(data.assigned[0].updated_at.as_deref(), Some("2026-07-01T10:00:00Z"));
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test is_not_found_error 2>&1 | tail -30`
Expected: FAIL — `is_not_found_error` 없음

- [ ] **Step 3: 구현**

`is_network_error` 함수 바로 아래에 추가(`plane_api.rs`):

```rust
/// True when `err` is specifically an HTTP 404 — used to distinguish "the
/// item was deleted on the server" from other errors during offline replay.
pub fn is_not_found_error(err: &str) -> bool {
    err.starts_with("HTTP 404")
}
```

`RawWorkItem`에 필드 추가:

```rust
#[derive(Deserialize)]
struct RawWorkItem {
    id: String,
    name: String,
    #[serde(default = "priority_none")] priority: String,
    #[serde(default)] target_date: Option<String>,
    #[serde(default)] start_date: Option<String>,
    #[serde(default)] state: Option<RawState>,
    #[serde(default)] assignees: Vec<RawAssignee>,
    #[serde(default)] completed_at: Option<String>,
    #[serde(default)] created_at: Option<String>,
    #[serde(default)] updated_at: Option<String>,
    #[serde(default)] description_html: Option<String>,
    #[serde(default)] created_by: Option<String>,
}
```

`WorkItem`에 필드 추가(`created_by` 다음):

```rust
pub struct WorkItem {
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
    pub created_by: Option<String>,
    pub updated_at: Option<String>,
}
```

`WorkItemDetail`에 필드 추가(`project_id` 다음):

```rust
pub struct WorkItemDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub assignee_ids: Vec<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: String,
    pub state_group: String,
    pub project_id: String,
    pub updated_at: Option<String>,
}
```

`map_work_item`과 `map_work_item_detail`에 각각 `updated_at: w.updated_at` 추가
(두 함수는 서로 다른 `RawWorkItem` 값을 받으므로 이동 문제 없음):

```rust
fn map_work_item(w: RawWorkItem, project_id: &str) -> WorkItem {
    WorkItem {
        id: w.id,
        name: w.name,
        priority: w.priority,
        target_date: w.target_date,
        start_date: w.start_date,
        state_group: w.state.map(|s| s.group).unwrap_or_default(),
        project_id: project_id.to_string(),
        assignee_ids: w.assignees.into_iter().map(|a| a.id).collect(),
        completed_at: w.completed_at,
        created_at: w.created_at,
        created_by: w.created_by,
        updated_at: w.updated_at,
    }
}

fn map_work_item_detail(w: RawWorkItem, project_id: &str) -> WorkItemDetail {
    WorkItemDetail {
        id: w.id,
        name: w.name,
        description: description_html_to_plain_text(w.description_html.as_deref()),
        assignee_ids: w.assignees.into_iter().map(|a| a.id).collect(),
        start_date: w.start_date,
        target_date: w.target_date,
        priority: w.priority,
        state_group: w.state.map(|s| s.group).unwrap_or_default(),
        project_id: project_id.to_string(),
        updated_at: w.updated_at,
    }
}
```

`plane_api.rs` 테스트 모듈의 `wi_completed` 헬퍼(`WorkItem { ... }` 리터럴을
직접 만드는 곳 — `wi`는 이 함수를 감싸는 얇은 래퍼라 별도 수정이 필요 없다)에
`updated_at: None,` 필드를 추가한다.

`WorkItemDto`에 필드 추가(`commands.rs`, `created_at` 다음):

```rust
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
    pub updated_at: Option<String>,
}
```

`assemble_sidebar`의 매핑에 `updated_at: w.updated_at` 추가:

```rust
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            start_date: w.start_date,
            state_group: w.state_group, project_id: w.project_id, completed_at: w.completed_at,
            created_at: w.created_at, updated_at: w.updated_at,
        })
        .collect();
```

이제 이 필드 추가로 컴파일이 깨지는 나머지 리터럴들을 전부 고친다 — 각각에
`updated_at: None,`을 추가:

- `commands.rs` 테스트 모듈의 `wi_completed` 헬퍼(`plane_api::WorkItem` 리터럴).
- `commands.rs`의 `create_issue` 함수 안, 오프라인 큐잉 분기의 `placeholder`
  (`WorkItemDto` 리터럴).
- `offline.rs` 테스트 모듈의 `dto()` 헬퍼(`WorkItemDto` 리터럴).

- [ ] **Step 4: 테스트 통과 확인 + 전체 스위트**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -80`
Expected: PASS — 이 태스크가 끝나면 크레이트 전체가 다시 컴파일되고 모든
기존 테스트 + 이 태스크에서 추가한 테스트가 통과해야 한다. 컴파일 에러가
있다면 위에서 나열한 리터럴 중 빠뜨린 곳이 있는지 확인할 것.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs src-tauri/src/offline.rs
git commit -m "feat(conflict): add updated_at plumbing and is_not_found_error"
```

---

### Task 2: `PendingMutation.base_updated_at` + `detect_conflict` (offline.rs)

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Produces: `PendingMutation.base_updated_at: Option<String>`,
  `push_mutation(queue, kind, project_id, target_id, payload, base_updated_at, now_ms) -> String`
  (시그니처에 `base_updated_at` 파라미터 추가됨 — Task 5가 이 새 시그니처로
  호출한다), `pub fn detect_conflict(base: Option<&str>, current: Option<&str>) -> Option<ConflictReason>`.

- [ ] **Step 1: 실패하는 테스트 작성 + 기존 테스트 시그니처 갱신**

`offline.rs` 테스트 모듈의 `push_mutation_appends_and_returns_a_unique_id`와
`remap_target_id_updates_every_matching_entry` 테스트에서 `push_mutation` 호출을
전부 새 시그니처(`payload` 다음에 `base_updated_at: Option<String>` 인자 추가)로
바꾼다:

```rust
    #[test]
    fn push_mutation_appends_and_returns_a_unique_id() {
        let mut q = OfflineQueue::default();
        let id1 = push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "i1", serde_json::json!({"priority":"high"}), Some("t1".into()), 1000);
        let id2 = push_mutation(&mut q, MutationKind::Delete, "p1", "i2", serde_json::Value::Null, None, 1000);
        assert_eq!(q.items.len(), 2);
        assert_ne!(id1, id2);
        assert_eq!(q.items[0].target_id, "i1");
        assert_eq!(q.items[0].base_updated_at.as_deref(), Some("t1"));
        assert_eq!(q.items[1].kind, MutationKind::Delete);
        assert_eq!(q.items[1].base_updated_at, None);
    }

    #[test]
    fn remap_target_id_updates_every_matching_entry() {
        let mut q = OfflineQueue::default();
        push_mutation(&mut q, MutationKind::CreateIssue, "p1", "local-1", serde_json::Value::Null, None, 1000);
        push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "local-1", serde_json::json!({"priority":"high"}), Some("t1".into()), 1001);
        push_mutation(&mut q, MutationKind::UpdatePriority, "p1", "other", serde_json::json!({"priority":"low"}), Some("t2".into()), 1002);
        remap_target_id(&mut q, "local-1", "real-99");
        assert_eq!(q.items[0].target_id, "real-99");
        assert_eq!(q.items[1].target_id, "real-99");
        assert_eq!(q.items[2].target_id, "other"); // untouched
    }
```

`queue_round_trips_through_json` 테스트도 `push_mutation` 호출에 `None`을 추가:

```rust
    #[test]
    fn queue_round_trips_through_json() {
        let mut q = OfflineQueue::default();
        push_mutation(&mut q, MutationKind::Delete, "p1", "i1", serde_json::Value::Null, None, 1000);
        let json = serde_json::to_string(&q).unwrap();
        let back: OfflineQueue = serde_json::from_str(&json).unwrap();
        assert_eq!(back.items.len(), 1);
        assert_eq!(back.items[0].target_id, "i1");
    }
```

새 테스트 추가:

```rust
    #[test]
    fn detect_conflict_flags_when_updated_at_differs() {
        assert_eq!(detect_conflict(Some("t1"), Some("t2")), Some(ConflictReason::ServerUpdated));
    }

    #[test]
    fn detect_conflict_passes_when_updated_at_matches() {
        assert_eq!(detect_conflict(Some("t1"), Some("t1")), None);
    }

    #[test]
    fn detect_conflict_passes_when_either_side_is_unknown() {
        // 검증할 정보가 부족하면(캐시에 없었거나 서버 응답에 없으면) 막지 않는다.
        assert_eq!(detect_conflict(None, Some("t2")), None);
        assert_eq!(detect_conflict(Some("t1"), None), None);
        assert_eq!(detect_conflict(None, None), None);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test offline:: 2>&1 | tail -60`
Expected: FAIL — 컴파일 에러(시그니처 불일치, `detect_conflict`/`ConflictReason` 없음)

- [ ] **Step 3: 구현**

`PendingMutation`에 필드 추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingMutation {
    pub id: String,
    pub kind: MutationKind,
    pub project_id: String,
    pub target_id: String,
    pub payload: serde_json::Value,
    pub base_updated_at: Option<String>,
    pub queued_at_ms: u64,
}
```

`push_mutation` 시그니처와 본문 교체:

```rust
/// 큐에 새 변경을 적재하고 그 항목의 id를 돌려준다. `base_updated_at`은 큐잉
/// 시점에 캐시에 있던 서버 `updated_at` 값 — 재생 시 충돌 판정에 쓰인다.
/// `CreateIssue`는 항상 `None`(비교할 서버 상태가 없음).
pub fn push_mutation(
    queue: &mut OfflineQueue,
    kind: MutationKind,
    project_id: &str,
    target_id: &str,
    payload: serde_json::Value,
    base_updated_at: Option<String>,
    now_ms: u64,
) -> String {
    let id = format!("pending-{now_ms}-{}", queue.items.len());
    queue.items.push(PendingMutation {
        id: id.clone(),
        kind,
        project_id: project_id.to_string(),
        target_id: target_id.to_string(),
        payload,
        base_updated_at,
        queued_at_ms: now_ms,
    });
    id
}
```

`ConflictReason` enum + `detect_conflict` 함수를 `is_recovery_transition` 아래에
추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConflictReason {
    ServerUpdated,
    TargetDeleted,
}

/// 큐잉 시점 `updated_at`(`base`)과 재생 시점에 새로 조회한 값(`current`)을
/// 비교한다. 둘 다 있고 다르면 충돌, 그 외(같음/둘 중 하나라도 없음)에는
/// 진행해도 안전하다고 본다 — 정보 부족을 막을 이유로 쓰지 않는다.
pub fn detect_conflict(base: Option<&str>, current: Option<&str>) -> Option<ConflictReason> {
    match (base, current) {
        (Some(b), Some(c)) if b != c => Some(ConflictReason::ServerUpdated),
        _ => None,
    }
}
```

- [ ] **Step 4: 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 컴파일 에러 — `queue_and_patch`/`queue_create_and_insert`/
`queue_delete_and_remove`(offline.rs)가 아직 옛 5개 인자 시그니처로
`push_mutation`을 호출하고 있어 타입 불일치. **Task 5에서 고친다 — 지금은
정상**.

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && grep -n "push_mutation(" src/offline.rs`
Expected: 이 태스크에서 수정한 테스트 5곳(호출 6번)은 모두 6개 인자(`payload`
다음에 `base_updated_at`)로 호출되고 있는지 확인. `queue_and_patch`/
`queue_create_and_insert`/`queue_delete_and_remove` 내부의 3개 호출부는 아직
5개 인자로 남아있어 컴파일이 깨진 상태 — Task 5에서 고친다.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(conflict): add base_updated_at and detect_conflict"
```

---

### Task 3: `ConflictEntry` 저장 구조 (offline.rs)

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Produces: `ConflictFields`, `ConflictEntry`, `ConflictList`, `load_conflicts(app) -> ConflictList`,
  `save_conflicts(app, &ConflictList) -> Result<(), String>`, `add_conflict(list, entry)`,
  `remove_conflict(list, id)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`offline.rs` 테스트 모듈에 추가:

```rust
    fn sample_fields() -> ConflictFields {
        ConflictFields { priority: Some("high".into()), ..Default::default() }
    }

    fn sample_entry(id: &str) -> ConflictEntry {
        ConflictEntry {
            id: id.into(),
            kind: MutationKind::UpdatePriority,
            project_id: "p1".into(),
            target_id: "i1".into(),
            item_name: "버그 수정".into(),
            reason: ConflictReason::ServerUpdated,
            local_fields: sample_fields(),
            local_payload: serde_json::json!({ "priority": "high" }),
            server_fields: Some(ConflictFields { priority: Some("urgent".into()), ..Default::default() }),
            detected_at_ms: 1000,
        }
    }

    #[test]
    fn add_conflict_appends_and_remove_conflict_drops_by_id() {
        let mut list = ConflictList::default();
        add_conflict(&mut list, sample_entry("c1"));
        add_conflict(&mut list, sample_entry("c2"));
        assert_eq!(list.items.len(), 2);
        remove_conflict(&mut list, "c1");
        let ids: Vec<_> = list.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["c2"]);
    }

    #[test]
    fn conflict_list_round_trips_through_json() {
        let mut list = ConflictList::default();
        add_conflict(&mut list, sample_entry("c1"));
        let json = serde_json::to_string(&list).unwrap();
        let back: ConflictList = serde_json::from_str(&json).unwrap();
        assert_eq!(back.items.len(), 1);
        assert_eq!(back.items[0].id, "c1");
        assert_eq!(back.items[0].local_fields.priority.as_deref(), Some("high"));
        assert_eq!(back.items[0].server_fields.as_ref().unwrap().priority.as_deref(), Some("urgent"));
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test conflict_list 2>&1 | tail -40`
Expected: FAIL — 타입 없음

- [ ] **Step 3: 구현**

`CONFLICTS_KEY` 상수를 `QUEUE_KEY` 옆에 추가하고, `ConflictFields`/`ConflictEntry`/
`ConflictList` 타입 + 저장 함수 + 순수 헬퍼를 `is_recovery_transition`/
`detect_conflict` 아래에 추가:

```rust
const CONFLICTS_KEY: &str = "conflicts";
```

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConflictFields {
    pub name: Option<String>,
    pub description: Option<String>,
    pub assignee_ids: Option<Vec<String>>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: Option<String>,
    pub state_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictEntry {
    pub id: String,
    pub kind: MutationKind,
    pub project_id: String,
    pub target_id: String,
    pub item_name: String,
    pub reason: ConflictReason,
    /// 화면 표시용으로 파싱된 값.
    pub local_fields: ConflictFields,
    /// "내 값 유지" 적용 시 그대로 재전송할 원본 페이로드(UpdatePriority/
    /// UpdateState/Delete용 — 단일 필드라 병합이 필요 없다. UpdateFields는
    /// 프런트엔드가 병합한 값을 별도로 받으므로 이 필드를 쓰지 않는다).
    pub local_payload: serde_json::Value,
    /// 대상이 삭제됐으면(`TargetDeleted`) None.
    pub server_fields: Option<ConflictFields>,
    pub detected_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConflictList {
    pub items: Vec<ConflictEntry>,
}

pub fn load_conflicts(app: &tauri::AppHandle) -> ConflictList {
    match app.store(STORE_FILE) {
        Ok(store) => store.get(CONFLICTS_KEY).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        Err(_) => ConflictList::default(),
    }
}

pub fn save_conflicts(app: &tauri::AppHandle, list: &ConflictList) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(CONFLICTS_KEY, serde_json::to_value(list).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

pub fn add_conflict(list: &mut ConflictList, entry: ConflictEntry) {
    list.items.push(entry);
}

pub fn remove_conflict(list: &mut ConflictList, id: &str) {
    list.items.retain(|c| c.id != id);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test conflict_list 2>&1 | tail -40`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(conflict): add conflict list types and persistence"
```

---

### Task 4: `local_fields_from_payload` + `build_conflict_entry` (offline.rs)

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Consumes: `crate::plane_api::WorkItemDetail`, `crate::commands::StateDto` (상태
  id→그룹 라벨 조회용).
- Produces: `pub fn build_conflict_entry(m: &PendingMutation, reason: ConflictReason, detail: Option<crate::plane_api::WorkItemDetail>, cached_states: &[crate::commands::StateDto], now_ms: u64) -> ConflictEntry`
  — Task 7(`replay_queue`)이 그대로 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`offline.rs` 상단 `use` 문에 `use crate::plane_api::WorkItemDetail;`과
`use crate::commands::StateDto;` 추가(기존 `use crate::commands::{SidebarData, WorkItemDto};`
줄에 `StateDto`를 합쳐 `use crate::commands::{SidebarData, StateDto, WorkItemDto};`로).

테스트 모듈에 추가:

```rust
    fn detail(name: &str, priority: &str, updated_at: &str) -> WorkItemDetail {
        WorkItemDetail {
            id: "i1".into(), name: name.into(), description: "".into(),
            assignee_ids: vec![], start_date: None, target_date: None,
            priority: priority.into(), state_group: "started".into(), project_id: "p1".into(),
            updated_at: Some(updated_at.into()),
        }
    }

    #[test]
    fn local_fields_from_payload_reads_only_the_touched_field_for_single_field_kinds() {
        let payload = serde_json::json!({ "priority": "high" });
        let fields = local_fields_from_payload(&MutationKind::UpdatePriority, &payload);
        assert_eq!(fields.priority.as_deref(), Some("high"));
        assert_eq!(fields.name, None);
    }

    #[test]
    fn local_fields_from_payload_resolves_state_id_to_group_label() {
        let payload = serde_json::json!({ "state": "s-started" });
        let states = vec![StateDto { id: "s-started".into(), group: "started".into(), project_id: "p1".into(), default: false }];
        let fields = local_fields_from_payload_with_states(&MutationKind::UpdateState, &payload, &states);
        assert_eq!(fields.state_group.as_deref(), Some("started"));
    }

    #[test]
    fn local_fields_from_payload_reads_every_touched_field_for_update_fields() {
        let payload = serde_json::json!({
            "name": "새 제목", "priority": "urgent", "state_group": "started",
            "description": null, "assignee_ids": null, "start_date": null, "target_date": null,
        });
        let fields = local_fields_from_payload(&MutationKind::UpdateFields, &payload);
        assert_eq!(fields.name.as_deref(), Some("새 제목"));
        assert_eq!(fields.priority.as_deref(), Some("urgent"));
        assert_eq!(fields.state_group.as_deref(), Some("started"));
        assert_eq!(fields.description, None);
    }

    #[test]
    fn build_conflict_entry_fills_item_name_and_server_fields_from_detail() {
        let m = PendingMutation {
            id: "pending-1".into(), kind: MutationKind::UpdatePriority,
            project_id: "p1".into(), target_id: "i1".into(),
            payload: serde_json::json!({ "priority": "high" }),
            base_updated_at: Some("t1".into()), queued_at_ms: 1000,
        };
        let entry = build_conflict_entry(&m, ConflictReason::ServerUpdated, Some(detail("버그 수정", "urgent", "t2")), &[], 2000);
        assert_eq!(entry.item_name, "버그 수정");
        assert_eq!(entry.local_fields.priority.as_deref(), Some("high"));
        assert_eq!(entry.server_fields.unwrap().priority.as_deref(), Some("urgent"));
        assert_eq!(entry.reason, ConflictReason::ServerUpdated);
    }

    #[test]
    fn build_conflict_entry_handles_a_deleted_target() {
        let m = PendingMutation {
            id: "pending-1".into(), kind: MutationKind::UpdateFields,
            project_id: "p1".into(), target_id: "i1".into(),
            payload: serde_json::json!({ "name": "새 제목" }),
            base_updated_at: Some("t1".into()), queued_at_ms: 1000,
        };
        let entry = build_conflict_entry(&m, ConflictReason::TargetDeleted, None, &[], 2000);
        assert_eq!(entry.reason, ConflictReason::TargetDeleted);
        assert!(entry.server_fields.is_none());
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test local_fields_from_payload 2>&1 | tail -40`
Expected: FAIL — 함수 없음

- [ ] **Step 3: 구현**

`offline.rs`에 추가(테스트 모듈 위):

```rust
fn local_fields_from_payload(kind: &MutationKind, payload: &serde_json::Value) -> ConflictFields {
    local_fields_from_payload_with_states(kind, payload, &[])
}

/// `UpdateState`의 페이로드는 이미 해석된 state id만 담고 있어(`{"state": "<id>"}`),
/// 표시용 그룹 라벨을 얻으려면 캐시된 states 목록에서 역으로 찾아야 한다.
/// 못 찾으면(캐시가 없거나 상태가 지워졌으면) id를 그대로 보여준다 — 드문
/// 경우라 이 정도 성능 저하는 감수한다.
fn local_fields_from_payload_with_states(
    kind: &MutationKind,
    payload: &serde_json::Value,
    cached_states: &[StateDto],
) -> ConflictFields {
    match kind {
        MutationKind::UpdatePriority => ConflictFields {
            priority: payload.get("priority").and_then(|v| v.as_str()).map(str::to_string),
            ..Default::default()
        },
        MutationKind::UpdateState => {
            let state_id = payload.get("state").and_then(|v| v.as_str());
            let label = state_id.and_then(|id| cached_states.iter().find(|s| s.id == id).map(|s| s.group.clone()));
            ConflictFields {
                state_group: label.or_else(|| state_id.map(str::to_string)),
                ..Default::default()
            }
        }
        MutationKind::UpdateFields => ConflictFields {
            name: payload.get("name").and_then(|v| v.as_str()).map(str::to_string),
            description: payload.get("description").and_then(|v| v.as_str()).map(str::to_string),
            assignee_ids: payload.get("assignee_ids").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
            }),
            start_date: payload.get("start_date").and_then(|v| v.as_str()).map(str::to_string),
            target_date: payload.get("target_date").and_then(|v| v.as_str()).map(str::to_string),
            priority: payload.get("priority").and_then(|v| v.as_str()).map(str::to_string),
            state_group: payload.get("state_group").and_then(|v| v.as_str()).map(str::to_string),
        },
        MutationKind::Delete | MutationKind::CreateIssue => ConflictFields::default(),
    }
}

/// 큐 항목 하나와 재생 시점에 조회한 서버 상태(`detail`, 대상이 삭제됐으면
/// `None`)로부터 사용자에게 보여줄 `ConflictEntry`를 만든다.
pub fn build_conflict_entry(
    m: &PendingMutation,
    reason: ConflictReason,
    detail: Option<crate::plane_api::WorkItemDetail>,
    cached_states: &[StateDto],
    now_ms: u64,
) -> ConflictEntry {
    let local_fields = local_fields_from_payload_with_states(&m.kind, &m.payload, cached_states);
    let (item_name, server_fields) = match detail {
        Some(d) => (
            d.name.clone(),
            Some(ConflictFields {
                name: Some(d.name),
                description: Some(d.description),
                assignee_ids: Some(d.assignee_ids),
                start_date: d.start_date,
                target_date: d.target_date,
                priority: Some(d.priority),
                state_group: Some(d.state_group),
            }),
        ),
        None => ("(삭제된 항목)".to_string(), None),
    };
    ConflictEntry {
        id: format!("conflict-{now_ms}"),
        kind: m.kind.clone(),
        project_id: m.project_id.clone(),
        target_id: m.target_id.clone(),
        item_name,
        reason,
        local_fields,
        local_payload: m.payload.clone(),
        server_fields,
        detected_at_ms: now_ms,
    }
}
```

- [ ] **Step 4: 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
(여전히 Task 5 전이라 `queue_and_patch` 등 3개 호출부는 컴파일 에러 상태 —
정상. `cargo test offline::`만 별도로는 못 돌리니, grep으로 새 함수가 제대로
추가됐는지 확인)

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && grep -n "fn build_conflict_entry\|fn local_fields_from_payload" src/offline.rs`
Expected: 두 함수 정의가 보임

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(conflict): build display-ready conflict entries from a mutation and server detail"
```

---

### Task 5: `queue_and_patch`/`queue_delete_and_remove`가 `base_updated_at` 캡처

**Files:**
- Modify: `src-tauri/src/offline.rs`

**Interfaces:**
- Consumes: Task 2의 새 `push_mutation` 시그니처.
- Produces: 기존 `queue_and_patch`/`queue_create_and_insert`/`queue_delete_and_remove`의
  **공개 시그니처는 그대로**(호출부인 `commands.rs`의 `update_work_item_priority`/
  `update_work_item_state`/`update_work_item_fields`/`delete_work_item`/
  `create_issue` — 전부 Phase 1에서 이미 구현됨 — 는 손대지 않는다) — 내부
  구현만 캐시에서 `updated_at`을 읽어 `push_mutation`에 넘기도록 바뀐다.

- [ ] **Step 1: 구현** (기존 AppHandle 의존 함수라 새 단위 테스트는 추가하지
  않는다 — Task 2/4의 순수 함수들로 이미 핵심 로직이 커버됨. 컴파일 통과이
  이 태스크의 검증 기준이다.)

`queue_and_patch`를 다음으로 교체:

```rust
pub async fn queue_and_patch(
    app: &tauri::AppHandle,
    kind: MutationKind,
    project_id: &str,
    target_id: &str,
    payload: serde_json::Value,
    patch: impl FnOnce(&mut WorkItemDto),
) -> Result<(), String> {
    let lock = app.state::<QueueLock>();
    let _guard = lock.0.lock().await;
    let now = crate::now_ms();
    let mut snapshot = load_cache(app);
    let base_updated_at = snapshot
        .as_ref()
        .and_then(|s| s.data.assigned.iter().find(|d| d.id == target_id))
        .and_then(|d| d.updated_at.clone());
    let mut queue = load_queue(app);
    push_mutation(&mut queue, kind, project_id, target_id, payload, base_updated_at, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(snap) = snapshot.as_mut() {
        patch_cached_item(&mut snap.data.assigned, target_id, patch);
        save_cache_snapshot(app, snap)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
}
```

`queue_delete_and_remove`를 다음으로 교체:

```rust
pub async fn queue_delete_and_remove(app: &tauri::AppHandle, project_id: &str, target_id: &str) -> Result<(), String> {
    let lock = app.state::<QueueLock>();
    let _guard = lock.0.lock().await;
    let now = crate::now_ms();
    let mut snapshot = load_cache(app);
    let base_updated_at = snapshot
        .as_ref()
        .and_then(|s| s.data.assigned.iter().find(|d| d.id == target_id))
        .and_then(|d| d.updated_at.clone());
    let mut queue = load_queue(app);
    push_mutation(&mut queue, MutationKind::Delete, project_id, target_id, serde_json::Value::Null, base_updated_at, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(snap) = snapshot.as_mut() {
        remove_cached_item(&mut snap.data.assigned, target_id);
        save_cache_snapshot(app, snap)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
}
```

`queue_create_and_insert`는 `push_mutation` 호출에 `base_updated_at` 자리로
`None`만 추가(새 이슈라 비교할 서버 상태가 없다):

```rust
pub async fn queue_create_and_insert(
    app: &tauri::AppHandle,
    project_id: &str,
    payload: serde_json::Value,
    mut placeholder: WorkItemDto,
) -> Result<String, String> {
    let lock = app.state::<QueueLock>();
    let _guard = lock.0.lock().await;
    let now = crate::now_ms();
    let mut queue = load_queue(app);
    let local_id = format!("local-{now}-{}", queue.items.len());
    push_mutation(&mut queue, MutationKind::CreateIssue, project_id, &local_id, payload, None, now);
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
```

- [ ] **Step 2: 빌드 + 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공 — 이 시점부터 전체 크레이트가 다시 컴파일된다.

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -80`
Expected: PASS (Task 1~5에서 추가한 테스트 전부 포함)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/offline.rs
git commit -m "feat(conflict): capture base_updated_at from the cache when queuing"
```

---

### Task 6: `replay_one`이 충돌을 감지한다 (lib.rs)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `offline::detect_conflict`, `plane_api::is_not_found_error`,
  `client.get_work_item(project_id, item_id) -> Result<WorkItemDetail, String>`.
- Produces: `enum ReplayOutcome { Applied(Option<String>), Conflict(offline::ConflictReason, Option<plane_api::WorkItemDetail>) }`,
  `async fn apply_mutation(client, m) -> Result<(), String>`, 재작성된
  `async fn replay_one(client, m) -> Result<ReplayOutcome, String>` — Task 7이
  이 반환값을 소비한다.

- [ ] **Step 1: 구현** (배경 루프 코드라 Phase 1과 같은 컨벤션대로 직접 단위
  테스트를 추가하지 않는다 — `offline::detect_conflict`가 핵심 판정 로직을
  이미 테스트함. 컴파일 + 전체 스위트 통과가 검증 기준.)

`replay_one` 함수 전체를 다음으로 교체하고, 그 위에 `ReplayOutcome`과
`apply_mutation`을 추가:

```rust
/// `replay_one`의 결과. `Applied(Some(id))`는 `CreateIssue`가 성공해 실제
/// 서버 id를 얻었을 때만 쓰인다. `Conflict`는 그 항목을 큐에서 빼서
/// 충돌 목록으로 옮겨야 함을 뜻한다 — 재생은 계속 진행된다(멈추지 않음).
enum ReplayOutcome {
    Applied(Option<String>),
    Conflict(offline::ConflictReason, Option<plane_api::WorkItemDetail>),
}

/// 충돌이 없다고 판정된 뒤 실제로 서버에 적용한다. `CreateIssue`는
/// `replay_one`에서 별도 분기로 처리하므로 여기 도달하지 않는다.
async fn apply_mutation(client: &plane_api::PlaneClient, m: &offline::PendingMutation) -> Result<(), String> {
    match m.kind {
        offline::MutationKind::UpdatePriority | offline::MutationKind::UpdateState => {
            client.update_work_item(&m.project_id, &m.target_id, m.payload.clone()).await
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
            .await
        }
        offline::MutationKind::Delete => client.delete_work_item(&m.project_id, &m.target_id).await,
        offline::MutationKind::CreateIssue => unreachable!("CreateIssue is handled separately in replay_one"),
    }
}

/// 큐 항목 하나를 재생. `CreateIssue`가 성공하면 실제 서버 id를
/// `ReplayOutcome::Applied(Some(..))`으로 돌려줘 호출자가 이후 항목들의
/// target_id를 치환하게 한다. `Delete` + 대상이 이미 삭제됨은 충돌이
/// 아니라 성공으로 본다(원하는 최종 상태가 이미 달성됨).
async fn replay_one(client: &plane_api::PlaneClient, m: &offline::PendingMutation) -> Result<ReplayOutcome, String> {
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
            Ok(ReplayOutcome::Applied(Some(new_id)))
        }
        offline::MutationKind::UpdatePriority
        | offline::MutationKind::UpdateState
        | offline::MutationKind::UpdateFields
        | offline::MutationKind::Delete => match client.get_work_item(&m.project_id, &m.target_id).await {
            Ok(detail) => {
                match offline::detect_conflict(m.base_updated_at.as_deref(), detail.updated_at.as_deref()) {
                    Some(reason) => Ok(ReplayOutcome::Conflict(reason, Some(detail))),
                    None => {
                        apply_mutation(client, m).await?;
                        Ok(ReplayOutcome::Applied(None))
                    }
                }
            }
            Err(e) if plane_api::is_not_found_error(&e) => {
                if m.kind == offline::MutationKind::Delete {
                    // 이미 지워져 있다 — 원하던 결과가 이미 달성됐으니 충돌이 아니다.
                    Ok(ReplayOutcome::Applied(None))
                } else {
                    Ok(ReplayOutcome::Conflict(offline::ConflictReason::TargetDeleted, None))
                }
            }
            Err(e) => Err(e),
        },
    }
}
```

- [ ] **Step 2: 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 — `replay_queue`가 아직 옛 `Ok(Some(..))`/`Ok(None)` 반환 형태를
기대하는 match를 쓰고 있어 타입 불일치. **Task 7에서 고친다 — 지금은 정상**.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(conflict): detect conflicts in replay_one"
```

---

### Task 7: `replay_queue`가 충돌을 큐에서 빼서 목록으로 옮기고 계속 진행

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 6의 `ReplayOutcome`, `offline::build_conflict_entry`,
  `offline::{load_conflicts, save_conflicts, add_conflict}`.

- [ ] **Step 1: 구현**

`replay_queue` 함수의 `while !queue.items.is_empty() { ... }` 루프와 그 뒤의
이벤트 발행 부분을 다음으로 교체(함수 앞부분의 락 획득까지는 그대로 둔다):

```rust
    let cached_states = offline::load_cache(app).map(|s| s.data.states).unwrap_or_default();

    while !queue.items.is_empty() {
        let m = queue.items[0].clone();
        match replay_one(&client, &m).await {
            Ok(ReplayOutcome::Applied(Some(real_id))) => {
                offline::remap_target_id(&mut queue, &m.target_id, &real_id);
                if let Some(mut snapshot) = offline::load_cache(app) {
                    offline::remap_cached_item_id(&mut snapshot.data.assigned, &m.target_id, &real_id);
                    let _ = offline::save_cache_snapshot(app, &snapshot);
                }
                queue.items.remove(0);
            }
            Ok(ReplayOutcome::Applied(None)) => {
                queue.items.remove(0);
            }
            Ok(ReplayOutcome::Conflict(reason, detail)) => {
                let entry = offline::build_conflict_entry(&m, reason, detail, &cached_states, now_ms());
                let mut conflicts = offline::load_conflicts(app);
                offline::add_conflict(&mut conflicts, entry);
                let _ = offline::save_conflicts(app, &conflicts);
                queue.items.remove(0);
                // 충돌은 이 항목만 빼고 계속 진행한다 — 재생 전체를 멈추지 않는다.
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
    let conflict_count = offline::load_conflicts(app).items.len();
    let _ = app.emit_to(
        "sidebar",
        "offline-conflicts-changed",
        serde_json::json!({ "count": conflict_count }),
    );
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
```

함수 위 doc 주석("네트워크 오류를 다시 만나거나(아직 오프라인) 그 외 오류...")을
다음으로 갱신:

```rust
/// 큐를 순서대로 재생한다. 충돌(그 사이 서버에서 항목이 바뀌었거나 삭제됨)을
/// 만나면 그 항목만 큐에서 빼서 충돌 목록으로 옮기고 계속 진행한다. 네트워크
/// 오류를 다시 만나거나(아직 오프라인) 그 외 오류(검증 오류 등)를 만나면 그
/// 항목과 이후 항목을 큐에 남긴 채 멈춘다.
```

- [ ] **Step 2: 빌드 + 전체 테스트 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -80`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(conflict): route conflicts to the conflict list instead of halting replay"
```

---

### Task 8: `get_conflicts` 커맨드 (commands.rs)

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `ConflictFieldsDto`, `ConflictDto`, `pub fn get_conflicts(app) -> Vec<ConflictDto>`.

- [ ] **Step 1: 구현** (읽기 전용 커맨드, 새 자동 테스트 없이 빌드로 확인 —
  `get_offline_status`와 같은 성격)

`get_offline_status` 아래에 추가:

```rust
#[derive(Serialize)]
pub struct ConflictFieldsDto {
    pub name: Option<String>,
    pub description: Option<String>,
    pub assignee_ids: Option<Vec<String>>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: Option<String>,
    pub state_group: Option<String>,
}

impl From<crate::offline::ConflictFields> for ConflictFieldsDto {
    fn from(f: crate::offline::ConflictFields) -> Self {
        Self {
            name: f.name,
            description: f.description,
            assignee_ids: f.assignee_ids,
            start_date: f.start_date,
            target_date: f.target_date,
            priority: f.priority,
            state_group: f.state_group,
        }
    }
}

#[derive(Serialize)]
pub struct ConflictDto {
    pub id: String,
    pub kind: crate::offline::MutationKind,
    pub project_id: String,
    pub target_id: String,
    pub item_name: String,
    pub reason: crate::offline::ConflictReason,
    pub local_fields: ConflictFieldsDto,
    pub server_fields: Option<ConflictFieldsDto>,
    pub detected_at_ms: u64,
}

#[tauri::command]
pub fn get_conflicts(app: tauri::AppHandle) -> Vec<ConflictDto> {
    crate::offline::load_conflicts(&app)
        .items
        .into_iter()
        .map(|c| ConflictDto {
            id: c.id,
            kind: c.kind,
            project_id: c.project_id,
            target_id: c.target_id,
            item_name: c.item_name,
            reason: c.reason,
            local_fields: c.local_fields.into(),
            server_fields: c.server_fields.map(Into::into),
            detected_at_ms: c.detected_at_ms,
        })
        .collect()
}
```

`crate::offline::MutationKind`와 `crate::offline::ConflictReason`이
`Serialize`를 이미 파생하고 있어(Task 2, offline.rs) `ConflictDto`에 직접
써도 컴파일된다 — 별도 변환 타입을 만들지 않는다.

- [ ] **Step 2: 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(conflict): add get_conflicts command"
```

---

### Task 9: `resolve_conflict` 커맨드 (commands.rs)

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `try_update_fields_online`(이미 Phase 1에 존재), `crate::offline::{load_conflicts, save_conflicts, remove_conflict}`.
- Produces: `pub async fn resolve_conflict(app, conflict_id: String, action: String, fields: Option<serde_json::Value>) -> Result<(), String>`.

- [ ] **Step 1: 구현**

`get_conflicts` 아래에 추가:

```rust
/// 충돌 하나를 해결한다. `action`은 `"apply"`(내 값 유지 — 종류별로 아래
/// 표대로 실제 서버에 반영) 또는 `"discard"`(서버 값 그대로 두고 버림, API
/// 호출 없음). `UpdateFields` 충돌의 `"apply"`는 `fields`(프런트엔드가
/// 필드별로 고른 값을 합친 것)가 반드시 있어야 한다 — 상태 그룹→id 변환은
/// `try_update_fields_online`이 다시 온라인으로 처리한다.
#[tauri::command]
pub async fn resolve_conflict(
    app: tauri::AppHandle,
    conflict_id: String,
    action: String,
    fields: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut conflicts = crate::offline::load_conflicts(&app);
    let Some(entry) = conflicts.items.iter().find(|c| c.id == conflict_id).cloned() else {
        return Err("conflict not found".into());
    };
    if action == "apply" {
        let (client, _s) = client(&app)?;
        match entry.kind {
            crate::offline::MutationKind::Delete => {
                client.delete_work_item(&entry.project_id, &entry.target_id).await?;
            }
            crate::offline::MutationKind::UpdatePriority | crate::offline::MutationKind::UpdateState => {
                client.update_work_item(&entry.project_id, &entry.target_id, entry.local_payload.clone()).await?;
            }
            crate::offline::MutationKind::UpdateFields => {
                let f = fields.ok_or_else(|| "fields required for UpdateFields conflicts".to_string())?;
                let assignee_ids: Option<Vec<String>> = f.get("assignee_ids").and_then(|v| v.as_array()).map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
                });
                try_update_fields_online(
                    &client,
                    &entry.project_id,
                    &entry.target_id,
                    f.get("name").and_then(|v| v.as_str()),
                    f.get("description").and_then(|v| v.as_str()),
                    assignee_ids.as_deref(),
                    f.get("start_date").and_then(|v| v.as_str()),
                    f.get("target_date").and_then(|v| v.as_str()),
                    f.get("priority").and_then(|v| v.as_str()),
                    f.get("state_group").and_then(|v| v.as_str()),
                )
                .await?;
            }
            crate::offline::MutationKind::CreateIssue => {
                return Err("create_issue conflicts are not supported".into());
            }
        }
    }
    crate::offline::remove_conflict(&mut conflicts, &conflict_id);
    crate::offline::save_conflicts(&app, &conflicts)?;
    let _ = app.emit_to(
        "sidebar",
        "offline-conflicts-changed",
        serde_json::json!({ "count": conflicts.items.len() }),
    );
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
    Ok(())
}
```

`ConflictEntry`가 `.cloned()`을 쓰려면 `Clone`을 파생해야 한다 — Task 3에서
이미 `#[derive(Debug, Clone, Serialize, Deserialize)]`로 만들어뒀으니 추가
작업 없음.

- [ ] **Step 2: 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(conflict): add resolve_conflict command"
```

---

### Task 10: `conflict` 창 등록 (tauri.conf.json, lib.rs)

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/conflict/index.html` (Task 12에서 실제 내용 채움 — 이 태스크는
  창이 뜰 수 있도록 최소한의 빈 페이지만 만든다)

**Interfaces:**
- Produces: `pub fn open_conflict_window(app: tauri::AppHandle)` 커맨드.

- [ ] **Step 1: 최소 페이지 파일 생성**

`src/conflict/index.html` 새로 작성:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>동기화 충돌</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <div id="root"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

Task 12가 이 파일의 `<body>` 내용을 실제 UI로 채운다. 지금은 `src/conflict/main.ts`가
아직 없어 Vite 빌드가 이 파일을 찾지 못하므로, 빈 파일을 함께 만든다:

`src/conflict/main.ts` 새로 작성:

```typescript
// Task 12에서 실제 로직을 채운다.
export {};
```

- [ ] **Step 2: `tauri.conf.json`에 창 등록**

`app.windows` 배열의 `editmodal` 항목 다음에 추가:

```json
      {
        "label": "conflict",
        "url": "src/conflict/index.html",
        "width": 480, "height": 420,
        "decorations": false, "transparent": true, "alwaysOnTop": true, "shadow": false,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": true
      },
```

- [ ] **Step 3: `open_conflict_window` 커맨드 추가**

`commands.rs`의 `open_edit_modal` 아래에 추가:

```rust
#[tauri::command]
pub fn open_conflict_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("conflict") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to("conflict", "conflicts-open", ());
}
```

`lib.rs`의 `invoke_handler(tauri::generate_handler![...])` 목록 끝에 추가:

```rust
            commands::get_offline_status,
            commands::get_conflicts,
            commands::resolve_conflict,
            commands::open_conflict_window
```

- [ ] **Step 4: 빌드 + 프런트엔드 빌드 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo build 2>&1 | tail -60`
Expected: 에러 없이 빌드 성공

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -60`
Expected: 에러 없음(빈 `main.ts`라 별 문제 없어야 함)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/commands.rs src-tauri/src/lib.rs src/conflict/index.html src/conflict/main.ts
git commit -m "feat(conflict): register the conflict window and open command"
```

---

### Task 11: 프런트엔드 타입/IPC 확장

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Produces: `ConflictFields`, `Conflict` 타입, `getConflicts()`, `resolveConflict()`,
  `openConflictWindow()` — Task 12(병합 화면)와 Task 13(사이드바 배지)이 사용.

- [ ] **Step 1: 타입 추가**

`src/shared/types.ts` 끝에 추가:

```typescript
export interface ConflictFields {
  name: string | null;
  description: string | null;
  assignee_ids: string[] | null;
  start_date: string | null;
  target_date: string | null;
  priority: string | null;
  state_group: string | null;
}
export type ConflictKind = "CreateIssue" | "UpdatePriority" | "UpdateState" | "UpdateFields" | "Delete";
export type ConflictReason = "ServerUpdated" | "TargetDeleted";
export interface Conflict {
  id: string;
  kind: ConflictKind;
  project_id: string;
  target_id: string;
  item_name: string;
  reason: ConflictReason;
  local_fields: ConflictFields;
  server_fields: ConflictFields | null;
  detected_at_ms: number;
}
```

- [ ] **Step 2: IPC 래퍼 추가**

`src/shared/ipc.ts` 상단 import에 `Conflict`를 추가하고
(`OfflineStatus` 옆), 파일 끝에 추가:

```typescript
export const getConflicts = () => invoke<Conflict[]>("get_conflicts");
export const resolveConflict = (conflictId: string, action: "apply" | "discard", fields?: Partial<ConflictFields>) =>
  invoke<void>("resolve_conflict", { conflictId, action, fields });
export const openConflictWindow = () => invoke<void>("open_conflict_window");
```

`import type { ... } from "./types";` 줄에 `Conflict, ConflictFields`를 추가.

- [ ] **Step 3: 타입체크**

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -60`
Expected: 에러 없음

- [ ] **Step 4: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat(conflict): add conflict types and IPC wrappers"
```

---

### Task 12: 병합 화면 (`src/conflict`)

**Files:**
- Modify: `src/conflict/index.html`
- Modify: `src/conflict/main.ts`

**Interfaces:**
- Consumes: `getConflicts`, `resolveConflict`, `priorityIcon`/`priorityLabel`/
  `stateIcon`/`stateLabel`(from `../shared/planeIcons`), `PRIORITY_ORDER`/`STATE_ORDER`.

- [ ] **Step 1: 화면 골격 작성**

`src/conflict/index.html`의 `<body>` 내용을 다음으로 교체:

```html
  <body class="transparent-body">
    <div class="editmodal" id="conflictRoot">
      <div class="em-head">
        <strong class="em-title">동기화 충돌</strong>
        <button type="button" class="em-close" id="cfClose">✕</button>
      </div>
      <div id="cfEmpty" class="em-loading" hidden>해결할 충돌이 없습니다.</div>
      <div id="cfList"></div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
```

(`editmodal`용 `.editmodal`/`.em-head`/`.em-title`/`.em-close`/`.em-loading`
클래스를 그대로 재사용한다 — `../shared/app.css`에 이미 정의돼 있다.)

- [ ] **Step 2: `main.ts` 렌더 로직**

`src/conflict/main.ts` 전체를 다음으로 교체:

```typescript
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getConflicts, getSettings, resolveConflict } from "../shared/ipc";
import { priorityIcon, priorityLabel, stateIcon, stateLabel } from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import type { Conflict, ConflictFields } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const root = document.getElementById("conflictRoot") as HTMLElement;
const listEl = document.getElementById("cfList")!;
const emptyEl = document.getElementById("cfEmpty")!;
const closeBtn = document.getElementById("cfClose")!;

type FieldKey = keyof ConflictFields;
const FIELD_LABELS: Record<FieldKey, string> = {
  name: "제목",
  description: "설명",
  assignee_ids: "담당자",
  start_date: "시작일",
  target_date: "마감일",
  priority: "우선순위",
  state_group: "상태",
};

function fieldValueText(key: FieldKey, value: ConflictFields[FieldKey]): string {
  if (value === null || value === undefined) return "(없음)";
  if (key === "assignee_ids") return (value as string[]).join(", ") || "담당자 없음";
  if (key === "priority") return priorityLabel(value as any);
  if (key === "state_group") return stateLabel(value as any);
  return String(value);
}

function resizeToFit() {
  const height = Math.ceil(root.getBoundingClientRect().height) + 4;
  win.setSize(new LogicalSize(480, Math.max(height, 200))).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

/** 로컬/서버 값이 실제로 다른 필드만 골라낸다 — 우연히 같아진 필드는 표시하지 않는다. */
function diffingFields(local: ConflictFields, server: ConflictFields | null): FieldKey[] {
  const keys = Object.keys(FIELD_LABELS) as FieldKey[];
  return keys.filter((k) => {
    const lv = local[k];
    if (lv === null || lv === undefined) return false; // 이 변경이 건드리지 않은 필드
    if (!server) return true; // 대상 삭제됨 — 비교할 서버 값 자체가 없음
    const sv = server[k];
    if (k === "assignee_ids") return JSON.stringify(lv) !== JSON.stringify(sv);
    return lv !== sv;
  });
}

function renderFieldRow(c: Conflict, key: FieldKey, choices: Map<string, "local" | "server">): HTMLElement {
  const row = document.createElement("div");
  row.className = "date-row";
  const label = document.createElement("span");
  label.className = "date-row-label";
  label.textContent = FIELD_LABELS[key];
  row.appendChild(label);

  const localVal = fieldValueText(key, c.local_fields[key]);
  const serverVal = c.server_fields ? fieldValueText(key, c.server_fields[key]) : "(삭제됨)";
  const choiceId = `${c.id}:${key}`;
  choices.set(choiceId, "local");

  const group = document.createElement("div");
  group.className = "chip-row";
  const localBtn = document.createElement("button");
  localBtn.type = "button";
  localBtn.className = "chip sel";
  localBtn.textContent = `내 변경: ${localVal}`;
  const serverBtn = document.createElement("button");
  serverBtn.type = "button";
  serverBtn.className = "chip";
  serverBtn.textContent = `서버 값: ${serverVal}`;
  localBtn.onclick = () => {
    choices.set(choiceId, "local");
    localBtn.classList.add("sel");
    serverBtn.classList.remove("sel");
  };
  serverBtn.onclick = () => {
    choices.set(choiceId, "server");
    serverBtn.classList.add("sel");
    localBtn.classList.remove("sel");
  };
  group.appendChild(localBtn);
  group.appendChild(serverBtn);
  row.appendChild(group);
  return row;
}

function buildMergedFields(c: Conflict, keys: FieldKey[], choices: Map<string, "local" | "server">): Partial<ConflictFields> {
  const merged: Partial<ConflictFields> = {};
  for (const k of keys) {
    const pick = choices.get(`${c.id}:${k}`) ?? "local";
    const source = pick === "local" ? c.local_fields : c.server_fields;
    if (source) (merged as any)[k] = source[k];
  }
  return merged;
}

async function resolveFieldConflict(c: Conflict, card: HTMLElement, choices: Map<string, "local" | "server">, keys: FieldKey[]) {
  const fields = buildMergedFields(c, keys, choices);
  try {
    await resolveConflict(c.id, "apply", fields);
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict failed:", err);
  }
}

async function discardConflict(c: Conflict, card: HTMLElement) {
  try {
    await resolveConflict(c.id, "discard");
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict (discard) failed:", err);
  }
}

async function deleteAnyway(c: Conflict, card: HTMLElement) {
  try {
    await resolveConflict(c.id, "apply");
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict (delete anyway) failed:", err);
  }
}

function renderConflictCard(c: Conflict): HTMLElement {
  const card = document.createElement("div");
  card.className = "pop";
  card.style.position = "static";
  card.style.marginBottom = "8px";
  card.style.width = "auto";

  const head = document.createElement("div");
  head.className = "pop-msg";
  head.textContent = `이슈: ${c.item_name}`;
  card.appendChild(head);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  card.appendChild(divider);

  if (c.reason === "TargetDeleted") {
    const msg = document.createElement("div");
    msg.className = "em-loading";
    msg.textContent = "이 항목은 서버에서 삭제되었습니다.";
    card.appendChild(msg);
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "em-btn em-btn-primary";
    discardBtn.textContent = "로컬 변경 폐기";
    discardBtn.onclick = () => discardConflict(c, card);
    card.appendChild(discardBtn);
    return card;
  }

  if (c.kind === "Delete") {
    const msg = document.createElement("div");
    msg.className = "em-loading";
    msg.textContent = "이 항목이 그 사이 서버에서 변경되었습니다. 그래도 삭제할까요?";
    card.appendChild(msg);
    const row = document.createElement("div");
    row.className = "em-foot-right";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "em-btn em-btn-primary";
    delBtn.textContent = "그래도 삭제";
    delBtn.onclick = () => deleteAnyway(c, card);
    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "em-btn em-btn-ghost";
    keepBtn.textContent = "삭제 취소";
    keepBtn.onclick = () => discardConflict(c, card);
    row.appendChild(keepBtn);
    row.appendChild(delBtn);
    card.appendChild(row);
    return card;
  }

  const keys = diffingFields(c.local_fields, c.server_fields);
  const choices = new Map<string, "local" | "server">();
  for (const k of keys) {
    card.appendChild(renderFieldRow(c, k, choices));
  }
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "em-btn em-btn-primary";
  doneBtn.textContent = "해결 완료";
  doneBtn.style.marginTop = "8px";
  doneBtn.onclick = () => resolveFieldConflict(c, card, choices, keys);
  card.appendChild(doneBtn);
  return card;
}

async function load() {
  try {
    const conflicts = await getConflicts();
    listEl.innerHTML = "";
    emptyEl.hidden = conflicts.length > 0;
    for (const c of conflicts) {
      listEl.appendChild(renderConflictCard(c));
    }
    resizeToFit();
  } catch (err) {
    console.error("getConflicts failed:", err);
  }
}

closeBtn.onclick = () => win.hide();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});
win.listen("conflicts-open", load);

async function loadTheme() {
  const s = await getSettings();
  applyTheme(s.theme);
}

loadTheme();
load();
```

- [ ] **Step 3: 타입체크 + 전체 프런트엔드 테스트**

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -60`
Expected: 에러 없음(quickadd의 기존 무관한 에러 하나는 이 변경 전부터 있던
것 — Phase 1 Task 15에서 이미 확인된 사전 존재 이슈이니 무시)

Run: `cd C:/WorkSpaces/plane-tool && pnpm test 2>&1 | tail -60`
Expected: PASS (이 태스크는 새 vitest 테스트를 추가하지 않는다 — DOM 렌더
로직이라 기존 컨벤션상 수동 확인 대상. 순수 판정 로직인 `diffingFields`는
다른 태스크 없이 이 파일 안에만 있어 테스트 파일을 분리하지 않았다 — 나중에
로직이 늘면 `src/conflict/logic.ts`로 분리를 고려할 것.)

- [ ] **Step 4: 커밋**

```bash
git add src/conflict/index.html src/conflict/main.ts
git commit -m "feat(conflict): build the manual merge screen"
```

---

### Task 13: 사이드바 충돌 배지 + 열기 버튼

**Files:**
- Modify: `src/sidebar/index.html`
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `getConflicts`, `openConflictWindow`(from `../shared/ipc`).

- [ ] **Step 1: 버튼 추가**

`src/sidebar/index.html`의 `sb-head` 안, `moreMenu` 버튼 앞에 추가:

```html
        <span id="conflictBadge" class="hbtn" title="동기화 충돌" hidden><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.5 14.5 13h-13z" stroke-linejoin="round"/><path d="M8 6v3.5" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".6" fill="currentColor" stroke="none"/></svg><span id="conflictCount" class="count"></span></span>
```

- [ ] **Step 2: `main.ts` 배선**

`src/sidebar/main.ts` 상단 import 목록에 `getConflicts`, `openConflictWindow`를
`ipc` import에 추가(`getOfflineStatus` 옆).

`pendingCount` 변수 아래에 추가:

```typescript
let conflictCount = 0;
const conflictBadgeEl = document.getElementById("conflictBadge")!;
const conflictCountEl = document.getElementById("conflictCount")!;

function renderConflictBadge() {
  conflictBadgeEl.hidden = conflictCount === 0;
  conflictCountEl.textContent = String(conflictCount);
}
```

`conflictBadgeEl.onclick`을 파일 끝(다른 `win.listen`들 근처)에 추가:

```typescript
conflictBadgeEl.onclick = () => {
  openConflictWindow().catch((err) => console.error("openConflictWindow failed:", err));
};
```

`win.listen("offline-queue-changed", ...)` 리스너 아래에 추가:

```typescript
win.listen("offline-conflicts-changed", (e) => {
  conflictCount = (e.payload as { count: number }).count;
  renderConflictBadge();
});
```

파일 맨 아래, `getOfflineStatus().then(...)` 줄 다음에 초기 조회 추가:

```typescript
getConflicts().then((cs) => {
  conflictCount = cs.length;
  renderConflictBadge();
}).catch(() => {});
```

- [ ] **Step 3: 타입체크 + 전체 테스트**

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -60`
Expected: 에러 없음

Run: `cd C:/WorkSpaces/plane-tool && pnpm test 2>&1 | tail -60`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add src/sidebar/index.html src/sidebar/main.ts
git commit -m "feat(conflict): show a conflict badge in the sidebar"
```

---

### Task 14: CHANGELOG + 최종 확인

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG 항목 추가**

`CHANGELOG.md`의 `## [Unreleased]` → `### 추가` 섹션(Phase 1이 이미 추가한
"서버 연결이 끊겨도…" 항목 바로 아래)에 한 줄 추가:

```markdown
- 오프라인 중 변경한 항목을 그 사이 다른 곳에서도 바꾼 경우, 자동으로
  덮어쓰지 않고 어떤 값을 남길지 직접 고르는 화면이 뜹니다.
```

- [ ] **Step 2: 전체 스위트 최종 확인**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test 2>&1 | tail -20`
Expected: PASS (전체)

Run: `cd C:/WorkSpaces/plane-tool && pnpm test 2>&1 | tail -20`
Expected: PASS (전체)

Run: `cd C:/WorkSpaces/plane-tool && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -30`
Expected: 이 브랜치가 만든 파일들에서는 에러 없음

- [ ] **Step 3: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: add conflict resolution changelog entry"
```

---

## 완료 후 수동 확인 (커밋 대상 아님)

1. Windows 방화벽으로 Plane 서버를 일시 차단 → 사이드바에서 이슈 우선순위
   변경 → 배지에 "동기화 대기 1건" 표시 확인.
2. **차단된 상태에서** 브라우저(다른 기기 또는 시크릿 창)로 Plane 웹에 접속해
   같은 이슈의 우선순위를 다른 값으로 바꾼다.
3. 차단 해제 → 재생이 그 항목을 충돌로 감지해 "충돌 1건" 배지가 뜨는지 확인,
   그 사이 큐에 다른 변경이 더 있었다면(다른 이슈 편집 등) 그건 정상 반영됐는지
   확인(재생이 멈추지 않았는지).
4. 배지 클릭 → 병합 화면이 열리고 "내 변경"/"서버 값"이 정확히 보이는지 확인,
   하나를 골라 "해결 완료" → Plane 웹에서 실제로 그 값이 반영됐는지 확인.
5. 차단된 상태에서 이슈를 삭제 시도 + 그 사이 웹에서 그 이슈의 필드를 편집 →
   차단 해제 후 "그래도 삭제"/"삭제 취소" 화면이 뜨는지 확인.
6. 차단된 상태에서 이슈를 삭제 시도 + 그 사이 웹에서 그 이슈를 **다른 사람이
   먼저 삭제** → 차단 해제 후 충돌 없이 조용히 처리되는지(배지가 뜨지 않아야
   함) 확인.
