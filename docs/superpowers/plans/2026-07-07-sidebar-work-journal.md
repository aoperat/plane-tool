# 사이드바 "오늘 업무일지" 모달 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바에 "오늘 업무일지" 아이콘을 추가해, 클릭 시 오늘 내가 맡은 작업을 프로젝트별·상태별(완료/진행중/예정)로 정리해 보여주고 카드별로 복사할 수 있는 새 Tauri 창을 연다.

**Architecture:** Rust 쪽은 기존 `briefing.rs` 패턴을 그대로 따라 새 `journal.rs`(순수 로직, 단위 테스트 가능) + `commands.rs`의 얇은 I/O 글루(`generate_journal`, `open_work_journal`)로 나눈다. 프론트엔드는 `src/briefing/`와 같은 구조로 `src/journal/`을 새로 만들고, Plane 웹앱의 실제 소스(`report-body.tsx`)에서 이식한 `logic.ts`(클러스터링·배지·복사 텍스트, 순수/테스트됨)와 `main.ts`(DOM 렌더링 + localStorage, 이 코드베이스 관례상 테스트 없음)로 나눈다.

**Tech Stack:** Rust(Tauri 2, serde, chrono, reqwest/wiremock 테스트), TypeScript(Vite, vitest), `@tauri-apps/plugin-clipboard-manager`.

## Global Constraints

- 그룹 순서는 항상 완료 → 진행중 → 예정 고정, 항목 없는 그룹은 통째로 생략.
- "예정" 그룹은 `state_group == "unstarted"`만 포함한다 — `backlog`와 `cancelled`는 항상 제외.
- "완료" 그룹은 `completed_at`의 로컬 날짜가 오늘인 것만 포함한다.
- 날짜 배지는 `MM-DD` 2자리 고정 포맷.
- 부모-자식 들여쓰기 깊이는 항상 1단계 고정 (조부모 관계 없음).
- 설정 4토글(프로젝트명/코드/우선순위/날짜 포함 여부) 기본값은 전부 `true`. 그룹 라벨 커스텀 편집은 이번 범위 밖.
- 사용자 가시 변경이므로 CHANGELOG.md `## [Unreleased]` → `### 추가`에 한국어 한 줄을 반드시 같은 커밋에 추가한다 (마지막 태스크).
- 참조: `docs/superpowers/specs/2026-07-07-sidebar-work-journal-design.md`.

---

## Task 1: 데이터 모델 — `sequence_id` · `parent_id` 필드 추가

**Files:**
- Modify: `src-tauri/src/plane_api.rs:10-23` (`WorkItem` struct), `:41-52` (`WorkItemDetail` struct), `:187-200` (`RawWorkItem` struct), `:517-532` (`map_work_item`), `:534-547` (`map_work_item_detail`), `:557-567` (test helper `wi_completed`)
- Modify: `src-tauri/src/commands.rs:987-997` (test helper `wi_completed`)
- Modify: `src-tauri/src/briefing.rs` (test helper `mk` inside `open_assigned_items_excludes_completed_cancelled_and_others`, around line 281-287)
- Modify: `src-tauri/src/assign_watch.rs:117-127` (test helper `wi`)
- Test: `src-tauri/src/plane_api.rs` (new `#[tokio::test]` cases)

**Interfaces:**
- Produces: `WorkItem.sequence_id: i64`, `WorkItem.parent_id: Option<String>`, `WorkItemDetail.sequence_id: i64` — consumed by Task 2 (`journal::bucket_assigned_items`) and Task 5 (`generate_journal` fetching a parent's `sequence_id` via `get_work_item`).

Plane's public REST API already returns `parent` (flat UUID) and `sequence_id` on every work item — `IssueSerializer` uses `exclude` (not a field whitelist), so nothing needs to change in the HTTP request itself, only in what we deserialize.

- [ ] **Step 1: Add the two fields to `WorkItem`, `WorkItemDetail`, and `RawWorkItem`**

In `src-tauri/src/plane_api.rs`, change the `WorkItem` struct (currently lines 9-23):

```rust
#[derive(Debug, Clone)]
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
    pub sequence_id: i64,
    pub parent_id: Option<String>,
}
```

Change `WorkItemDetail` (currently lines 40-52) to add `sequence_id`:

```rust
#[derive(Debug, Clone)]
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
    pub sequence_id: i64,
}
```

Change `RawWorkItem` (currently lines 186-200) to add the two raw fields:

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
    #[serde(default)] sequence_id: i64,
    #[serde(default)] parent: Option<String>,
}
```

- [ ] **Step 2: Map the new fields in `map_work_item` and `map_work_item_detail`**

Change `map_work_item` (currently lines 517-532):

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
        sequence_id: w.sequence_id,
        parent_id: w.parent,
    }
}
```

Change `map_work_item_detail` (currently lines 534-547):

```rust
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
        sequence_id: w.sequence_id,
    }
}
```

- [ ] **Step 3: Fix the four existing test helpers that construct `WorkItem` literals**

These will fail to compile once the struct gains two required fields. Update each:

In `src-tauri/src/plane_api.rs`, change the test helper (currently lines 557-567):

```rust
    fn wi_completed(id: &str, group: &str, assignees: &[&str], completed_at: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("item {id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(), project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
            created_at: None,
            created_by: None,
            updated_at: None,
            sequence_id: 0,
            parent_id: None,
        }
    }
```

In `src-tauri/src/commands.rs`, change the test helper (currently lines 987-997):

```rust
    fn wi_completed(id: &str, group: &str, assignees: &[&str], project: &str, completed_at: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(), project_id: project.into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
            created_at: None,
            created_by: None,
            updated_at: None,
            sequence_id: 0,
            parent_id: None,
        }
    }
```

In `src-tauri/src/briefing.rs`, find the `mk` closure inside `fn open_assigned_items_excludes_completed_cancelled_and_others()` and change it from:

```rust
        let mk = |id: &str, group: &str, assignees: &[&str]| WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None, created_by: None, updated_at: None,
        };
```

to:

```rust
        let mk = |id: &str, group: &str, assignees: &[&str]| WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None, created_by: None, updated_at: None,
            sequence_id: 0, parent_id: None,
        };
```

In `src-tauri/src/assign_watch.rs`, change the `wi` helper (currently lines 117-127):

```rust
    fn wi(id: &str, assignees: &[&str], created_by: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: "unstarted".into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None,
            created_by: created_by.map(str::to_string),
            updated_at: None,
            sequence_id: 0,
            parent_id: None,
        }
    }
```

- [ ] **Step 4: Run the existing test suite to confirm nothing broke**

Run: `cd src-tauri && cargo test`
Expected: all existing tests still pass (compile errors from Step 3 are now fixed).

- [ ] **Step 5: Write the new parsing tests**

Add to the `mod tests` block in `src-tauri/src/plane_api.rs`, after `list_work_items_parses_expanded_state_and_assignees`:

```rust
    #[tokio::test]
    async fn list_work_items_parses_sequence_id_and_parent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{
                    "id": "i2", "name": "Sub task", "priority": "none",
                    "sequence_id": 11,
                    "parent": "i1",
                    "state": { "group": "started" },
                    "assignees": []
                }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items[0].sequence_id, 11);
        assert_eq!(items[0].parent_id.as_deref(), Some("i1"));
    }

    #[tokio::test]
    async fn list_work_items_defaults_sequence_id_and_parent_when_absent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "i1", "name": "No parent", "priority": "none", "assignees": [] }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items[0].sequence_id, 0);
        assert_eq!(items[0].parent_id, None);
    }
```

- [ ] **Step 6: Run the new tests**

Run: `cd src-tauri && cargo test list_work_items_parses_sequence_id_and_parent list_work_items_defaults_sequence_id_and_parent_when_absent`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs src-tauri/src/briefing.rs src-tauri/src/assign_watch.rs
git commit -m "feat: capture sequence_id and parent on work items"
```

---

## Task 2: `journal.rs` — 오늘 업무일지 대상 선정 (`bucket_assigned_items`)

**Files:**
- Create: `src-tauri/src/journal.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod journal;` near the other `mod` declarations, e.g. next to `mod briefing;`)
- Test: inline `#[cfg(test)] mod tests` in `journal.rs`

**Interfaces:**
- Consumes: `plane_api::{Project, WorkItem}` (Task 1 fields).
- Produces: `pub struct JournalItem { id, name, sequence_id, project_id, project_identifier, priority, start_date, target_date, completed_at, parent_id }`, `pub struct BucketedItem { item: JournalItem, group: &'static str }`, `pub fn bucket_assigned_items(user_id: &str, projects: &[Project], items: Vec<WorkItem>, today: &str) -> Vec<BucketedItem>` — consumed by Task 3 (`unresolved_parents`, `group_and_sort`) and Task 5 (`generate_journal`).

- [ ] **Step 1: Find where `briefing` is declared as a module, to mirror it**

Run: `grep -n "mod briefing" src-tauri/src/lib.rs`
Expected: one line like `mod briefing;` (or `pub mod briefing;`) — add `mod journal;` right after it in Step 3.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/journal.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::Project;

    fn wi(id: &str, group: &str, assignees: &[&str], completed_at: Option<&str>, parent: Option<&str>) -> crate::plane_api::WorkItem {
        crate::plane_api::WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
            created_at: None, created_by: None, updated_at: None,
            sequence_id: 1, parent_id: parent.map(|s| s.to_string()),
        }
    }

    const TODAY: &str = "2026-07-07";

    #[test]
    fn buckets_started_unstarted_and_completed_today_only() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let items = vec![
            wi("a", "started", &["me"], None, None),
            wi("b", "unstarted", &["me"], None, None),
            wi("c", "completed", &["me"], Some("2026-07-07T09:00:00Z"), None),
            wi("d", "completed", &["me"], Some("2026-07-06T09:00:00Z"), None), // 어제 완료: 제외
            wi("e", "backlog", &["me"], None, None), // 백로그: 제외
            wi("f", "cancelled", &["me"], None, None), // 취소: 제외
            wi("g", "started", &["other"], None, None), // 남의 것: 제외
        ];
        let out = bucket_assigned_items("me", &projects, items, TODAY);
        let mut got: Vec<(&str, &str)> = out.iter().map(|b| (b.item.id.as_str(), b.group)).collect();
        got.sort();
        assert_eq!(got, vec![("a", "in_progress"), ("b", "upcoming"), ("c", "completed")]);
    }

    #[test]
    fn carries_sequence_id_project_identifier_and_parent() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let out = bucket_assigned_items("me", &projects, vec![wi("a", "started", &["me"], None, Some("parent-1"))], TODAY);
        assert_eq!(out[0].item.project_identifier, "WEB");
        assert_eq!(out[0].item.sequence_id, 1);
        assert_eq!(out[0].item.parent_id.as_deref(), Some("parent-1"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test -p plane-quick-dock journal::tests 2>&1 | head -30` (adjust package name if `cargo test journal::tests` errors on the package flag — check `src-tauri/Cargo.toml`'s `[package] name` first with `grep '^name' src-tauri/Cargo.toml`)
Expected: FAIL — `bucket_assigned_items` and `Project` import don't resolve yet (the file only has a test module so far).

- [ ] **Step 3: Register the module and write the implementation**

In `src-tauri/src/lib.rs`, add `mod journal;` next to the existing `mod briefing;` line.

At the top of `src-tauri/src/journal.rs` (above the `#[cfg(test)]` block), add:

```rust
use crate::plane_api::{Project, WorkItem};

#[derive(Debug, Clone, PartialEq)]
pub struct JournalItem {
    pub id: String,
    pub name: String,
    pub sequence_id: i64,
    pub project_id: String,
    pub project_identifier: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub completed_at: Option<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BucketedItem {
    pub item: JournalItem,
    /// "completed" | "in_progress" | "upcoming"
    pub group: &'static str,
}

/// "2026-07-01T09:00:00Z" 같은 UTC 타임스탬프의 로컬 날짜가 `today`(YYYY-MM-DD)와
/// 같은지. 파싱 실패하면 false(완료 그룹에서 제외).
fn completed_on_local_day(completed_at: &str, today: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(completed_at)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string() == today)
        .unwrap_or(false)
}

/// 오늘 업무일지 대상 선정: 내게 할당된 이슈 중
///   - completed: 상태가 완료이고 완료일이 오늘인 것만
///   - in_progress: 상태가 started인 것 전체 (날짜 무관, 현재 스냅샷)
///   - upcoming: 상태가 unstarted인 것 전체 (backlog·cancelled는 항상 제외)
pub fn bucket_assigned_items(
    user_id: &str,
    projects: &[Project],
    items: Vec<WorkItem>,
    today: &str,
) -> Vec<BucketedItem> {
    items
        .into_iter()
        .filter(|i| i.assignee_ids.iter().any(|a| a == user_id))
        .filter_map(|i| {
            let group: &'static str = match i.state_group.as_str() {
                "completed" if i.completed_at.as_deref().is_some_and(|c| completed_on_local_day(c, today)) => "completed",
                "started" => "in_progress",
                "unstarted" => "upcoming",
                _ => return None,
            };
            let identifier = projects
                .iter()
                .find(|p| p.id == i.project_id)
                .map(|p| p.identifier.clone())
                .unwrap_or_default();
            Some(BucketedItem {
                item: JournalItem {
                    id: i.id, name: i.name, sequence_id: i.sequence_id,
                    project_id: i.project_id, project_identifier: identifier,
                    priority: i.priority, start_date: i.start_date, target_date: i.target_date,
                    completed_at: i.completed_at, parent_id: i.parent_id,
                },
                group,
            })
        })
        .collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test journal::tests`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/journal.rs src-tauri/src/lib.rs
git commit -m "feat: add journal selection/bucketing rules"
```

---

## Task 3: `journal.rs` — 부모 해석 · 프로젝트별 그룹핑/정렬 (`unresolved_parents`, `group_and_sort`)

**Files:**
- Modify: `src-tauri/src/journal.rs`

**Interfaces:**
- Consumes: `BucketedItem`, `Project` (Task 2).
- Produces: `pub struct JournalParent { id, sequence_id, name, project_identifier }`, `pub struct JournalItemOut { id, name, sequence_id, priority, start_date, target_date, completed_at, parent: Option<JournalParent> }`, `pub struct JournalProjectOut { project_id, project_name, project_identifier, completed, in_progress, upcoming: Vec<JournalItemOut> }`, `pub fn unresolved_parents(items: &[BucketedItem]) -> Vec<(String, String)>`, `pub fn group_and_sort(items: Vec<BucketedItem>, projects: &[Project], fetched: &HashMap<String, JournalParent>) -> Vec<JournalProjectOut>` — consumed by Task 4 (`assemble_journal_report`) and Task 5 (`generate_journal`, which computes `fetched` via extra API calls).

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src-tauri/src/journal.rs` (after the existing two tests):

```rust
    fn bi(project_id: &str, id: &str, group: &'static str, parent_id: Option<&str>, completed_at: Option<&str>, seq: i64) -> BucketedItem {
        BucketedItem {
            item: JournalItem {
                id: id.into(), name: format!("n{id}"), sequence_id: seq,
                project_id: project_id.into(), project_identifier: "WEB".into(),
                priority: "none".into(), start_date: None, target_date: None,
                completed_at: completed_at.map(|s| s.into()), parent_id: parent_id.map(|s| s.into()),
            },
            group,
        }
    }

    #[test]
    fn unresolved_parents_only_lists_parents_missing_from_the_selected_set() {
        let items = vec![
            bi("p1", "child", "in_progress", Some("parent-in-set"), None, 1),
            bi("p1", "parent-in-set", "upcoming", None, None, 2),
            bi("p1", "orphan", "upcoming", Some("parent-missing"), None, 3),
        ];
        let missing = unresolved_parents(&items);
        assert_eq!(missing, vec![("p1".to_string(), "parent-missing".to_string())]);
    }

    #[test]
    fn group_and_sort_promotes_local_parent_and_uses_fetched_map_for_missing_ones() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let items = vec![
            bi("p1", "parent-a", "in_progress", None, None, 1),
            bi("p1", "child-a", "in_progress", Some("parent-a"), None, 2),
            bi("p1", "child-b", "upcoming", Some("parent-missing"), None, 3),
        ];
        let mut fetched = std::collections::HashMap::new();
        fetched.insert("parent-missing".to_string(), JournalParent {
            id: "parent-missing".into(), sequence_id: 9, name: "먼 부모".into(), project_identifier: "WEB".into(),
        });
        let out = group_and_sort(items, &projects, &fetched);
        assert_eq!(out.len(), 1);
        let child_a = out[0].in_progress.iter().find(|i| i.id == "child-a").unwrap();
        assert_eq!(child_a.parent.as_ref().unwrap().id, "parent-a");
        let child_b = out[0].upcoming.iter().find(|i| i.id == "child-b").unwrap();
        assert_eq!(child_b.parent.as_ref().unwrap().name, "먼 부모");
    }

    #[test]
    fn group_and_sort_sorts_projects_alphabetically_and_completed_desc() {
        let projects = vec![
            Project { id: "p2".into(), name: "Zeta".into(), identifier: "ZET".into() },
            Project { id: "p1".into(), name: "Alpha".into(), identifier: "ALP".into() },
        ];
        let items = vec![
            bi("p1", "a", "completed", None, Some("2026-07-07T01:00:00Z"), 1),
            bi("p1", "b", "completed", None, Some("2026-07-07T09:00:00Z"), 2),
            bi("p2", "c", "in_progress", None, None, 3),
        ];
        let out = group_and_sort(items, &projects, &std::collections::HashMap::new());
        let names: Vec<_> = out.iter().map(|p| p.project_name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Zeta"]);
        let ids: Vec<_> = out[0].completed.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]); // 늦게 완료된 것 먼저
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test journal::tests`
Expected: FAIL — `unresolved_parents`, `group_and_sort`, `JournalParent` not found.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/journal.rs`, above the `#[cfg(test)]` block:

```rust
use std::collections::HashMap;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq)]
pub struct JournalParent {
    pub id: String,
    pub sequence_id: i64,
    pub name: String,
    pub project_identifier: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalItemOut {
    pub id: String,
    pub name: String,
    pub sequence_id: i64,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub completed_at: Option<String>,
    pub parent: Option<JournalParent>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalProjectOut {
    pub project_id: String,
    pub project_name: String,
    pub project_identifier: String,
    pub completed: Vec<JournalItemOut>,
    pub in_progress: Vec<JournalItemOut>,
    pub upcoming: Vec<JournalItemOut>,
}

/// 조회가 필요한 (project_id, parent_id) 쌍 — 부모가 이번에 뽑힌 항목 집합에
/// 없는 경우만, parent_id 기준 중복 제거.
pub fn unresolved_parents(items: &[BucketedItem]) -> Vec<(String, String)> {
    let ids: HashSet<&str> = items.iter().map(|b| b.item.id.as_str()).collect();
    let mut seen = HashSet::new();
    items
        .iter()
        .filter_map(|b| b.item.parent_id.as_ref().map(|pid| (b.item.project_id.clone(), pid.clone())))
        .filter(|(_, pid)| !ids.contains(pid.as_str()))
        .filter(|(_, pid)| seen.insert(pid.clone()))
        .collect()
}

fn date_key_asc(v: &Option<String>) -> (bool, String) {
    (v.is_none(), v.clone().unwrap_or_default())
}

/// `fetched`: unresolved_parents가 알려준 (project_id, parent_id)를 조회해서 얻은
/// parent_id -> JournalParent 맵. 이미 이번 선정 집합 안에 있는 부모는 조회 없이
/// 그 항목 자체에서 만든다. 정렬: 완료=완료일 내림차순, 진행중=마감일 오름차순
/// (없는 것은 뒤로), 예정=시작일(없으면 마감일) 오름차순(둘 다 없으면 뒤로).
/// 프로젝트는 이름 가나다순.
pub fn group_and_sort(
    items: Vec<BucketedItem>,
    projects: &[Project],
    fetched: &HashMap<String, JournalParent>,
) -> Vec<JournalProjectOut> {
    let local: HashMap<String, JournalParent> = items
        .iter()
        .map(|b| {
            (
                b.item.id.clone(),
                JournalParent {
                    id: b.item.id.clone(),
                    sequence_id: b.item.sequence_id,
                    name: b.item.name.clone(),
                    project_identifier: b.item.project_identifier.clone(),
                },
            )
        })
        .collect();

    let mut by_project: HashMap<String, JournalProjectOut> = HashMap::new();
    for b in items {
        let parent = b
            .item
            .parent_id
            .as_ref()
            .and_then(|pid| local.get(pid).or_else(|| fetched.get(pid)).cloned());
        let project_id = b.item.project_id.clone();
        let group = b.group;
        let out = JournalItemOut {
            id: b.item.id,
            name: b.item.name,
            sequence_id: b.item.sequence_id,
            priority: b.item.priority,
            start_date: b.item.start_date,
            target_date: b.item.target_date,
            completed_at: b.item.completed_at,
            parent,
        };
        let entry = by_project.entry(project_id.clone()).or_insert_with(|| {
            let p = projects.iter().find(|p| p.id == project_id);
            JournalProjectOut {
                project_id: project_id.clone(),
                project_name: p.map(|p| p.name.clone()).unwrap_or_default(),
                project_identifier: p.map(|p| p.identifier.clone()).unwrap_or_default(),
                completed: Vec::new(),
                in_progress: Vec::new(),
                upcoming: Vec::new(),
            }
        });
        match group {
            "completed" => entry.completed.push(out),
            "in_progress" => entry.in_progress.push(out),
            _ => entry.upcoming.push(out),
        }
    }

    let mut projects_out: Vec<JournalProjectOut> = by_project.into_values().collect();
    for p in &mut projects_out {
        p.completed.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
        p.in_progress.sort_by(|a, b| date_key_asc(&a.target_date).cmp(&date_key_asc(&b.target_date)));
        p.upcoming.sort_by(|a, b| {
            let ka = date_key_asc(&a.start_date.clone().or_else(|| a.target_date.clone()));
            let kb = date_key_asc(&b.start_date.clone().or_else(|| b.target_date.clone()));
            ka.cmp(&kb)
        });
    }
    projects_out.sort_by(|a, b| a.project_name.to_lowercase().cmp(&b.project_name.to_lowercase()));
    projects_out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test journal::tests`
Expected: all 5 tests in `journal::tests` PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/journal.rs
git commit -m "feat: group/sort journal items by project and resolve cross-group parents"
```

---

## Task 4: `commands.rs` — DTO 정의 및 `assemble_journal_report` (순수 함수)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Test: inline in `commands.rs`'s existing `mod tests` block

**Interfaces:**
- Consumes: `journal::{BucketedItem, JournalParent, JournalItemOut, JournalProjectOut, group_and_sort}` (Task 3), `plane_api::Project`.
- Produces: `#[derive(Serialize)] pub struct JournalParentDto`, `JournalItemDto`, `JournalProjectDto`, `JournalReportDto { today, projects }`, `pub fn assemble_journal_report(projects: &[Project], bucketed: Vec<BucketedItem>, fetched_parents: HashMap<String, JournalParent>, today: &str) -> JournalReportDto` — consumed by Task 5 (`generate_journal` command) and mirrored by Task 6's frontend TS types.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `src-tauri/src/commands.rs` (near the other `assemble_*` tests):

```rust
    #[test]
    fn assemble_journal_report_wraps_grouped_projects_with_today_and_dto_shapes() {
        use crate::journal::{BucketedItem, JournalItem, JournalParent};
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let bucketed = vec![BucketedItem {
            item: JournalItem {
                id: "a".into(), name: "Fix bug".into(), sequence_id: 5,
                project_id: "p1".into(), project_identifier: "WEB".into(),
                priority: "high".into(), start_date: None, target_date: Some("2026-07-10".into()),
                completed_at: None, parent_id: Some("missing-parent".into()),
            },
            group: "in_progress",
        }];
        let mut fetched = std::collections::HashMap::new();
        fetched.insert("missing-parent".to_string(), JournalParent {
            id: "missing-parent".into(), sequence_id: 1, name: "부모 작업".into(), project_identifier: "WEB".into(),
        });
        let report = assemble_journal_report(&projects, bucketed, fetched, "2026-07-07");
        assert_eq!(report.today, "2026-07-07");
        assert_eq!(report.projects.len(), 1);
        let item = &report.projects[0].in_progress[0];
        assert_eq!(item.sequence_id, 5);
        assert_eq!(item.parent.as_ref().unwrap().name, "부모 작업");
        assert!(report.projects[0].completed.is_empty());
        assert!(report.projects[0].upcoming.is_empty());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test assemble_journal_report`
Expected: FAIL — `assemble_journal_report` not found.

- [ ] **Step 3: Write the DTOs and the assemble function**

Add near the other DTOs in `src-tauri/src/commands.rs` (after `SidebarData`, before `assemble_sidebar`):

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalParentDto {
    pub id: String,
    pub sequence_id: i64,
    pub name: String,
    pub project_identifier: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalItemDto {
    pub id: String,
    pub name: String,
    pub sequence_id: i64,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub completed_at: Option<String>,
    pub parent: Option<JournalParentDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalProjectDto {
    pub project_id: String,
    pub project_name: String,
    pub project_identifier: String,
    pub completed: Vec<JournalItemDto>,
    pub in_progress: Vec<JournalItemDto>,
    pub upcoming: Vec<JournalItemDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalReportDto {
    pub today: String,
    pub projects: Vec<JournalProjectDto>,
}

fn to_parent_dto(p: crate::journal::JournalParent) -> JournalParentDto {
    JournalParentDto { id: p.id, sequence_id: p.sequence_id, name: p.name, project_identifier: p.project_identifier }
}

fn to_item_dto(i: crate::journal::JournalItemOut) -> JournalItemDto {
    JournalItemDto {
        id: i.id, name: i.name, sequence_id: i.sequence_id, priority: i.priority,
        start_date: i.start_date, target_date: i.target_date, completed_at: i.completed_at,
        parent: i.parent.map(to_parent_dto),
    }
}

/// 이미 선정·분류된 항목과, 조회로 보강한 부모 정보를 받아 최종 오늘 업무일지
/// DTO를 만든다. I/O 없는 순수 함수 — `generate_journal` 커맨드가 필요한 데이터를
/// 다 모은 뒤 이 함수를 호출한다.
pub fn assemble_journal_report(
    projects: &[Project],
    bucketed: Vec<crate::journal::BucketedItem>,
    fetched_parents: std::collections::HashMap<String, crate::journal::JournalParent>,
    today: &str,
) -> JournalReportDto {
    let grouped = crate::journal::group_and_sort(bucketed, projects, &fetched_parents);
    JournalReportDto {
        today: today.to_string(),
        projects: grouped
            .into_iter()
            .map(|p| JournalProjectDto {
                project_id: p.project_id,
                project_name: p.project_name,
                project_identifier: p.project_identifier,
                completed: p.completed.into_iter().map(to_item_dto).collect(),
                in_progress: p.in_progress.into_iter().map(to_item_dto).collect(),
                upcoming: p.upcoming.into_iter().map(to_item_dto).collect(),
            })
            .collect(),
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test assemble_journal_report`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: add journal report DTOs and assembly"
```

---

## Task 5: Tauri 커맨드 배선 — `generate_journal` · `open_work_journal` · 창 등록

**Files:**
- Modify: `src-tauri/src/commands.rs` (new commands, after `open_briefing` around line 789)
- Modify: `src-tauri/src/lib.rs:760-786` (`invoke_handler![...]` list)
- Modify: `src-tauri/tauri.conf.json` (new `workjournal` window, after the `briefing` entry)

**Interfaces:**
- Consumes: `commands::assemble_journal_report` (Task 4), `journal::{bucket_assigned_items, unresolved_parents, JournalParent}` (Tasks 2-3), `client()` helper and `show_centered` (existing).
- Produces: `#[tauri::command] pub async fn generate_journal(app) -> Result<JournalReportDto, String>`, `#[tauri::command] pub fn open_work_journal(app)` — consumed by Task 6's `ipc.ts` wrappers.

This task is I/O glue (network calls via `PlaneClient`), matching this codebase's existing convention where `generate_briefing`/`open_briefing` also have no dedicated unit test — only the pure modules they call (`briefing.rs`) are tested. Verification here is `cargo build` + a manual smoke test in Task 11.

- [ ] **Step 1: Add the two commands**

Add to `src-tauri/src/commands.rs`, after `open_briefing` (around line 789):

```rust
/// 오늘 업무일지 데이터 생성: 내 프로젝트 전체에서 할당된 이슈를 모아 오늘 기준
/// 완료/진행중/예정으로 분류하고, 선정 집합에 없는 부모 이슈는 같은 프로젝트에서
/// 이름만 추가 조회한다.
#[tauri::command]
pub async fn generate_journal(app: tauri::AppHandle) -> Result<JournalReportDto, String> {
    let (client, _s) = client(&app)?;
    let user = client.current_user().await?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // 프로젝트 하나가 실패해도 나머지로 보고서를 만든다
        }
    }
    let bucketed = crate::journal::bucket_assigned_items(&user.id, &projects, all_items, &today);
    let missing = crate::journal::unresolved_parents(&bucketed);
    let mut fetched = std::collections::HashMap::new();
    for (project_id, parent_id) in missing {
        if let Ok(detail) = client.get_work_item(&project_id, &parent_id).await {
            let project_identifier = projects
                .iter()
                .find(|p| p.id == project_id)
                .map(|p| p.identifier.clone())
                .unwrap_or_default();
            fetched.insert(
                parent_id.clone(),
                crate::journal::JournalParent {
                    id: parent_id,
                    sequence_id: detail.sequence_id,
                    name: detail.name,
                    project_identifier,
                },
            );
        }
    }
    Ok(assemble_journal_report(&projects, bucketed, fetched, &today))
}

/// 업무일지 창을 설정된 디스플레이 중앙에 표시.
#[tauri::command]
pub fn open_work_journal(app: tauri::AppHandle) {
    crate::show_centered(&app, "workjournal");
}
```

- [ ] **Step 2: Register both commands in the invoke handler**

In `src-tauri/src/lib.rs`, change the `invoke_handler![...]` list (currently ending at line 785 with `commands::open_conflict_window`):

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
            commands::update_work_item_priority,
            commands::update_work_item_state,
            commands::delete_work_item,
            commands::get_work_item,
            commands::update_work_item_fields,
            commands::open_edit_modal,
            commands::open_settings,
            commands::show_quickadd_for_project,
            commands::set_last_project,
            commands::fetch_release_notes,
            commands::generate_briefing,
            commands::open_briefing,
            commands::get_pending_assignments,
            commands::acknowledge_assignment,
            check_updates_manual,
            commands::get_offline_status,
            commands::get_conflicts,
            commands::resolve_conflict,
            commands::open_conflict_window,
            commands::generate_journal,
            commands::open_work_journal
        ])
```

- [ ] **Step 3: Register the new window**

In `src-tauri/tauri.conf.json`, add a new window object after the `briefing` window entry (before the closing `]` of `"windows"`):

```json
      {
        "label": "workjournal",
        "url": "src/journal/index.html",
        "width": 520, "height": 640,
        "decorations": false, "transparent": true, "alwaysOnTop": true, "shadow": false,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": false
      }
```

- [ ] **Step 4: Build to confirm everything compiles**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: builds successfully (it will complain that `src/journal/index.html` doesn't exist yet only at Tauri's asset-bundling step, not at `cargo build` — if it does fail on that, create an empty placeholder `src/journal/index.html` with just `<!doctype html><html><body></body></html>` for now; Task 10 replaces it with the real UI).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat: wire up generate_journal/open_work_journal commands and window"
```

---

## Task 6: 프론트엔드 타입 · IPC 래퍼

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- Produces: `JournalParent`, `JournalItem`, `JournalProject`, `JournalReport` (TS interfaces mirroring Task 4's Rust DTOs field-for-field), `generateJournal(): Promise<JournalReport>`, `openWorkJournal(): Promise<void>` — consumed by Task 7-10 (`logic.ts`) and Task 10 (`main.ts`).

No new runtime logic here — this is a type-check-verified task (no meaningful unit test for plain interface declarations and thin `invoke` wrappers, matching how `Briefing`/`generateBriefing` were added with no dedicated test either).

- [ ] **Step 1: Add the types**

In `src/shared/types.ts`, append after the `Briefing` interfaces:

```typescript
export interface JournalParent { id: string; sequence_id: number; name: string; project_identifier: string; }
export interface JournalItem {
  id: string; name: string; sequence_id: number; priority: string;
  start_date: string | null; target_date: string | null; completed_at: string | null;
  parent: JournalParent | null;
}
export interface JournalProject {
  project_id: string; project_name: string; project_identifier: string;
  completed: JournalItem[]; in_progress: JournalItem[]; upcoming: JournalItem[];
}
export interface JournalReport { today: string; projects: JournalProject[]; }
```

- [ ] **Step 2: Add the IPC wrappers**

In `src/shared/ipc.ts`, add `JournalReport` to the type import list at the top (currently line 2):

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { SidebarData, SettingsDto, Project, Member, WorkItem, WorkItemDetail, ReleaseNote, Briefing, PendingAssignment, OfflineStatus, Conflict, ConflictFields, JournalReport } from "./types";
```

Then append near the briefing exports (after `export const openBriefing = ...`):

```typescript
export const generateJournal = () => invoke<JournalReport>("generate_journal");
export const openWorkJournal = () => invoke<void>("open_work_journal");
```

- [ ] **Step 3: Type-check**

Run: `pnpm build 2>&1 | tail -20`
Expected: no TypeScript errors (unused-export warnings are fine — these will be consumed starting in Task 10).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat: add journal types and IPC wrappers"
```

---

## Task 7: `src/journal/logic.ts` — `clusterByParent`

**Files:**
- Create: `src/journal/logic.ts`
- Test: `src/journal/logic.test.ts`

**Interfaces:**
- Consumes: `JournalItem`, `JournalParent` (Task 6).
- Produces: `export type TJournalGroup = "completed" | "in_progress" | "upcoming"`, `export type TRenderUnit = { type: "item"; item: JournalItem } | { type: "promoted"; item: JournalItem; children: JournalItem[] } | { type: "caption"; parent: JournalParent; items: JournalItem[] }`, `export function clusterByParent(items: JournalItem[]): TRenderUnit[]` — consumed by Task 9 (`projectToText`) and Task 10 (`main.ts` rendering).

Ported from the real Plane web app source (`apps/web/core/components/profile/work-report/report-body.tsx`, function `clusterByParent`), adapted to this app's `JournalItem`/`JournalParent` types (which already carry a resolved `parent` object per item, unlike upstream's separate lookup).

- [ ] **Step 1: Write the failing test**

Create `src/journal/logic.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { clusterByParent } from "./logic";
import type { JournalItem } from "../shared/types";

const item = (id: string, parentId?: string): JournalItem => ({
  id, name: `n${id}`, sequence_id: 1, priority: "none",
  start_date: null, target_date: null, completed_at: null,
  parent: parentId ? { id: parentId, sequence_id: 1, name: `n${parentId}`, project_identifier: "WEB" } : null,
});

describe("clusterByParent", () => {
  it("keeps parentless items as flat root items", () => {
    const units = clusterByParent([item("a"), item("b")]);
    expect(units).toEqual([{ type: "item", item: item("a") }, { type: "item", item: item("b") }]);
  });

  it("promotes an in-group parent and nests its children under it", () => {
    const units = clusterByParent([item("child", "parent"), item("parent")]);
    expect(units).toEqual([
      { type: "promoted", item: item("parent"), children: [item("child", "parent")] },
    ]);
  });

  it("renders a caption cluster when the parent is not in the group", () => {
    const child = item("child", "missing-parent");
    const units = clusterByParent([child]);
    expect(units).toEqual([
      { type: "caption", parent: child.parent, items: [child] },
    ]);
  });

  it("keeps nesting depth fixed at 1 — a promoted parent never becomes someone's child", () => {
    const grandchild = item("grandchild", "middle");
    const middle = item("middle", "top");
    const top = item("top");
    const units = clusterByParent([grandchild, middle, top]);
    // "middle" is itself a referenced parent (of grandchild), so it stays a root,
    // never nested under "top" even though middle.parent === "top".
    expect(units).toEqual([
      { type: "promoted", item: top, children: [] },
      { type: "promoted", item: middle, children: [grandchild] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/journal/logic.test.ts`
Expected: FAIL — `./logic` module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/journal/logic.ts`:

```typescript
import type { JournalItem, JournalParent } from "../shared/types";

export type TJournalGroup = "completed" | "in_progress" | "upcoming";

export type TRenderUnit =
  | { type: "item"; item: JournalItem }
  | { type: "promoted"; item: JournalItem; children: JournalItem[] }
  | { type: "caption"; parent: JournalParent; items: JournalItem[] };

/** 같은 부모를 참조하는 항목을 부모 아래로 묶는다. 깊이는 항상 1단계 고정.
 *  - promoted: 부모 자체가 같은 그룹의 항목이면 그 줄 아래 자식들이 붙는다.
 *  - caption: 부모가 같은 그룹에 없으면 회색 캡션 줄 아래 자식들이 붙는다.
 *  클러스터는 구성원 중 가장 앞선 것의 위치에 놓여, 그룹 전체 정렬 순서를 지킨다. */
export function clusterByParent(items: JournalItem[]): TRenderUnit[] {
  const indexOf = new Map(items.map((item, i) => [item.id, i]));
  const inGroupParentIds = new Set(
    items.filter((i) => i.parent && indexOf.has(i.parent.id)).map((i) => i.parent!.id)
  );
  const promotedChildren = new Map<string, JournalItem[]>();
  const captionClusters = new Map<string, { parent: JournalParent; items: JournalItem[] }>();
  const roots: JournalItem[] = [];

  items.forEach((item) => {
    // 이미 누군가의 부모로 승격될 항목은 그 자체가 다시 자식으로 내려가지 않는다.
    if (inGroupParentIds.has(item.id) || !item.parent) {
      roots.push(item);
      return;
    }
    if (inGroupParentIds.has(item.parent.id)) {
      promotedChildren.set(item.parent.id, [...(promotedChildren.get(item.parent.id) ?? []), item]);
    } else {
      const cluster = captionClusters.get(item.parent.id) ?? { parent: item.parent, items: [] };
      cluster.items.push(item);
      captionClusters.set(item.parent.id, cluster);
    }
  });

  const units: { key: number; unit: TRenderUnit }[] = [];
  roots.forEach((item) => {
    const children = promotedChildren.get(item.id);
    const selfKey = indexOf.get(item.id)!;
    if (children?.length) {
      units.push({ key: Math.min(selfKey, ...children.map((c) => indexOf.get(c.id)!)), unit: { type: "promoted", item, children } });
    } else {
      units.push({ key: selfKey, unit: { type: "item", item } });
    }
  });
  captionClusters.forEach((cluster) => {
    units.push({ key: Math.min(...cluster.items.map((c) => indexOf.get(c.id)!)), unit: { type: "caption", parent: cluster.parent, items: cluster.items } });
  });

  return units
    .slice()
    .sort((a, b) => a.key - b.key)
    .map((u) => u.unit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/journal/logic.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/logic.ts src/journal/logic.test.ts
git commit -m "feat: port work-report parent clustering to journal logic"
```

---

## Task 8: `src/journal/logic.ts` — `badgeFor` 날짜 배지

**Files:**
- Modify: `src/journal/logic.ts`
- Modify: `src/journal/logic.test.ts`

**Interfaces:**
- Consumes: `JournalItem`, `TJournalGroup` (Task 7).
- Produces: `export interface Badge { text: string; color: string; bg: string }`, `export function badgeFor(item: JournalItem, group: TJournalGroup, todayStr: string): Badge | null`, `export function monthDay(dateStr: string): string`, `export function dayDiff(dateStr: string, todayStr: string): number` — consumed by Task 9 (`projectToText`) and Task 10 (`main.ts` rendering).

Ported from `report-body.tsx`'s `badgeFor`/`dayDiff`/`monthDay`/`isoToLocalDate`.

- [ ] **Step 1: Write the failing test**

Append to `src/journal/logic.test.ts`:

```typescript
import { badgeFor } from "./logic";

const withDates = (over: Partial<JournalItem>): JournalItem => ({
  id: "a", name: "n", sequence_id: 1, priority: "none",
  start_date: null, target_date: null, completed_at: null, parent: null,
  ...over,
});

describe("badgeFor", () => {
  const TODAY = "2026-07-07";

  it("labels a completed item with its local completion date", () => {
    const b = badgeFor(withDates({ completed_at: "2026-07-07T09:00:00Z" }), "completed", TODAY);
    expect(b?.text).toBe("07-07 완료");
  });

  it("labels an overdue in-progress item", () => {
    const b = badgeFor(withDates({ target_date: "2026-07-05" }), "in_progress", TODAY);
    expect(b?.text).toBe("2일 지연 · 07-05 마감");
  });

  it("labels an in-progress item with days remaining", () => {
    const b = badgeFor(withDates({ target_date: "2026-07-10" }), "in_progress", TODAY);
    expect(b?.text).toBe("D-3 · 07-10 마감");
  });

  it("labels an upcoming item with a future start date", () => {
    const b = badgeFor(withDates({ start_date: "2026-07-08" }), "upcoming", TODAY);
    expect(b?.text).toBe("07-08 시작 예정");
  });

  it("labels an upcoming item with only a target date", () => {
    const b = badgeFor(withDates({ target_date: "2026-07-08" }), "upcoming", TODAY);
    expect(b?.text).toBe("07-08 마감");
  });

  it("returns null when there is no relevant date", () => {
    expect(badgeFor(withDates({}), "upcoming", TODAY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/journal/logic.test.ts`
Expected: FAIL — `badgeFor` not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `src/journal/logic.ts`:

```typescript
const dayDiffImpl = (dateStr: string, todayStr: string): number => {
  const [ty, tm, td] = dateStr.split("-").map(Number);
  const [cy, cm, cd] = todayStr.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(cy, cm - 1, cd)) / 86_400_000);
};
export const dayDiff = dayDiffImpl;

export const monthDay = (dateStr: string): string => dateStr.slice(5); // "YYYY-MM-DD" -> "MM-DD"

const toLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const isoToLocalDate = (iso: string): string => toLocalDateString(new Date(iso));

export interface Badge { text: string; color: string; bg: string }

/** 그룹별 날짜 배지. 완료=완료일, 진행중=마감 지남/남음, 예정=시작 예정/마감. */
export function badgeFor(item: JournalItem, group: TJournalGroup, todayStr: string): Badge | null {
  if (group === "completed" && item.completed_at) {
    return { text: `${monthDay(isoToLocalDate(item.completed_at))} 완료`, color: "#16a34a", bg: "#e7f6ee" };
  }
  if (group === "in_progress" && item.target_date) {
    const d = dayDiff(item.target_date, todayStr);
    if (d < 0) return { text: `${-d}일 지연 · ${monthDay(item.target_date)} 마감`, color: "#dc2626", bg: "#fdecec" };
    const soon = d <= 3;
    return { text: `D-${d} · ${monthDay(item.target_date)} 마감`, color: soon ? "#d97706" : "#6b7280", bg: soon ? "#fef3e2" : "#f3f4f6" };
  }
  if (group === "upcoming") {
    if (item.start_date && dayDiff(item.start_date, todayStr) > 0) {
      return { text: `${monthDay(item.start_date)} 시작 예정`, color: "#6b7280", bg: "#f3f4f6" };
    }
    if (item.target_date) return { text: `${monthDay(item.target_date)} 마감`, color: "#6b7280", bg: "#f3f4f6" };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/journal/logic.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/logic.ts src/journal/logic.test.ts
git commit -m "feat: port work-report date badges to journal logic"
```

---

## Task 9: `src/journal/logic.ts` — `projectToText` · `noteToLines` · 설정 타입

**Files:**
- Modify: `src/journal/logic.ts`
- Modify: `src/journal/logic.test.ts`

**Interfaces:**
- Consumes: `clusterByParent` (Task 7), `badgeFor` (Task 8), `priorityLabel` from `src/shared/planeIcons.ts` (existing).
- Produces: `export type TJournalSettings = { includeProjectName, includeCode, includePriority, includeDates: boolean }`, `export const DEFAULT_JOURNAL_SETTINGS: TJournalSettings`, `export function projectToText(project: JournalProject, settings: TJournalSettings, today: string, note: string): string`, `export function noteToLines(note: string): string[]` — consumed by Task 10 (`main.ts`, for the copy button, settings popover default, and issue-note textarea).

- [ ] **Step 1: Write the failing test**

Append to `src/journal/logic.test.ts`:

```typescript
import { DEFAULT_JOURNAL_SETTINGS, noteToLines, projectToText } from "./logic";
import type { JournalProject } from "../shared/types";

describe("noteToLines", () => {
  it("bullets non-blank lines and drops blank/whitespace-only ones", () => {
    expect(noteToLines("첫째 줄\n\n  \n둘째 줄")).toEqual(["  • 첫째 줄", "  • 둘째 줄"]);
  });
  it("returns an empty array for an empty note", () => {
    expect(noteToLines("")).toEqual([]);
  });
});

describe("projectToText", () => {
  const project: JournalProject = {
    project_id: "p1", project_name: "울산대학교", project_identifier: "UWIN",
    completed: [],
    in_progress: [
      { id: "parent", name: "울산대 마이그레이션", sequence_id: 6, priority: "none", start_date: null, target_date: null, completed_at: null, parent: null },
      { id: "child", name: "SOD005 생성", sequence_id: 11, priority: "none", start_date: null, target_date: null, completed_at: null, parent: { id: "parent", sequence_id: 6, name: "울산대 마이그레이션", project_identifier: "UWIN" } },
    ],
    upcoming: [],
  };

  it("renders the header, group label, and a promoted parent/child pair", () => {
    const text = projectToText(project, DEFAULT_JOURNAL_SETTINGS, "2026-07-07", "");
    expect(text).toContain("[울산대학교 / UWIN]");
    expect(text).toContain("🔄 진행 중인 일");
    expect(text).toContain("  · UWIN-6 울산대 마이그레이션");
    expect(text).toContain("    · UWIN-11 SOD005 생성");
  });

  it("omits the project header when includeProjectName is off", () => {
    const text = projectToText(project, { ...DEFAULT_JOURNAL_SETTINGS, includeProjectName: false }, "2026-07-07", "");
    expect(text).not.toContain("[울산대학교");
  });

  it("omits the code prefix when includeCode is off", () => {
    const text = projectToText(project, { ...DEFAULT_JOURNAL_SETTINGS, includeCode: false }, "2026-07-07", "");
    expect(text).toContain("· 울산대 마이그레이션");
    expect(text).not.toContain("UWIN-6");
  });

  it("appends the issue-note section when a note is present", () => {
    const text = projectToText(project, DEFAULT_JOURNAL_SETTINGS, "2026-07-07", "결제 API 지연 확인 중");
    expect(text.endsWith("⚠️ 금일 이슈 / 특이사항\n  • 결제 API 지연 확인 중")).toBe(true);
  });

  it("skips the issue-note section when the note is blank", () => {
    const text = projectToText(project, DEFAULT_JOURNAL_SETTINGS, "2026-07-07", "   ");
    expect(text).not.toContain("특이사항");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test src/journal/logic.test.ts`
Expected: FAIL — `projectToText`, `noteToLines`, `DEFAULT_JOURNAL_SETTINGS` not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `src/journal/logic.ts` (needs `import { priorityLabel } from "../shared/planeIcons";` and `import type { JournalProject } from "../shared/types";` added to the top-of-file imports):

```typescript
export type TJournalSettings = {
  includeProjectName: boolean;
  includeCode: boolean;
  includePriority: boolean;
  includeDates: boolean;
};

export const DEFAULT_JOURNAL_SETTINGS: TJournalSettings = {
  includeProjectName: true, includeCode: true, includePriority: true, includeDates: true,
};

const GROUP_LABELS: Record<TJournalGroup, string> = {
  completed: "✅ 완료된 일", in_progress: "🔄 진행 중인 일", upcoming: "📌 진행 예정인 일",
};

/** "none"은 배지를 안 붙인다 (priorityIcons.ts의 "우선순위 없음"과 달리 빈 문자열). */
function journalPriorityLabel(p: string): string {
  if (p !== "urgent" && p !== "high" && p !== "medium" && p !== "low") return "";
  return priorityLabel(p);
}

/** 여러 줄 메모를 "  • " 불릿 줄 배열로. 빈 줄/공백만 있는 줄은 버린다. */
export function noteToLines(note: string): string[] {
  return note
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `  • ${l}`);
}

function itemToLine(item: JournalItem, group: TJournalGroup, project: JournalProject, settings: TJournalSettings, today: string, indent: string): string {
  const code = settings.includeCode ? `${project.project_identifier}-${item.sequence_id} ` : "";
  const prio = settings.includePriority && journalPriorityLabel(item.priority) ? ` (${journalPriorityLabel(item.priority)})` : "";
  const badge = settings.includeDates ? badgeFor(item, group, today) : null;
  const suffix = badge ? ` — ${badge.text}` : "";
  return `${indent}· ${code}${item.name}${prio}${suffix}`;
}

/** 클립보드용 프로젝트 카드 텍스트. 설정에 따라 헤더/코드/우선순위/배지가 빠진다. */
export function projectToText(project: JournalProject, settings: TJournalSettings, today: string, note: string): string {
  const lines: string[] = [];
  if (settings.includeProjectName) lines.push(`[${project.project_name} / ${project.project_identifier}]`);

  (["completed", "in_progress", "upcoming"] as TJournalGroup[]).forEach((group) => {
    const items = project[group];
    if (!items.length) return;
    lines.push(GROUP_LABELS[group]);
    clusterByParent(items).forEach((unit) => {
      if (unit.type === "item") {
        lines.push(itemToLine(unit.item, group, project, settings, today, "  "));
      } else if (unit.type === "promoted") {
        lines.push(itemToLine(unit.item, group, project, settings, today, "  "));
        unit.children.forEach((child) => lines.push(itemToLine(child, group, project, settings, today, "    ")));
      } else {
        const pcode = settings.includeCode ? `${unit.parent.project_identifier}-${unit.parent.sequence_id} ` : "";
        lines.push(`  ${pcode}${unit.parent.name}`);
        unit.items.forEach((child) => lines.push(itemToLine(child, group, project, settings, today, "    ")));
      }
    });
  });

  const noteLines = noteToLines(note);
  if (noteLines.length) lines.push("", "⚠️ 금일 이슈 / 특이사항", ...noteLines);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/journal/logic.test.ts`
Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/journal/logic.ts src/journal/logic.test.ts
git commit -m "feat: port work-report copy-text formatting to journal logic"
```

---

## Task 10: `src/journal/index.html` · `main.ts` — 창 UI

**Files:**
- Create (or replace the Task 5 placeholder): `src/journal/index.html`
- Create: `src/journal/main.ts`
- Modify: `src/shared/app.css` (new `.jn-*` styles)
- Modify: `vite.config.ts` (register the new HTML entry point)

**Interfaces:**
- Consumes: `generateJournal`, `openWorkJournal` (Task 6), `clusterByParent`, `badgeFor`, `projectToText`, `DEFAULT_JOURNAL_SETTINGS`, `TJournalSettings` (Tasks 7-9).
- Produces: the rendered window. `localStorage`-backed settings/notes persistence lives here (not in `logic.ts`), matching this codebase's existing convention (`src/sidebar/main.ts:67` reads `localStorage` directly; only pure `logic.ts` files get unit tests).

This task is UI wiring — verified manually (Step 6), matching how `src/briefing/main.ts` has no test file of its own.

- [ ] **Step 1: Register the Vite entry point**

In `vite.config.ts`, add `journal` to the `rollupOptions.input` map (currently ending with `briefing: resolve(__dirname, "src/briefing/index.html"),`):

```typescript
        briefing: resolve(__dirname, "src/briefing/index.html"),
        journal: resolve(__dirname, "src/journal/index.html"),
```

- [ ] **Step 2: Write `index.html`**

Create (overwriting the Task 5 placeholder) `src/journal/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>오늘 업무일지</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <div class="jn-card">
      <div class="jn-head" data-tauri-drag-region>
        <svg class="bf-grip" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>
        <span class="bf-head-title">오늘 업무일지 · <span id="jnDate"></span></span>
        <button type="button" id="jnClose" class="bf-icon-btn" aria-label="닫기 (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>
      <div id="jnBody" class="jn-body"></div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Add CSS**

Append to `src/shared/app.css` (reusing the same `--bg`/`--border`/`--panel`/`--muted`/`--accent` variables the rest of the app already defines):

```css
.jn-card { display: flex; flex-direction: column; height: 100vh; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.jn-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel-2); cursor: grab; }
.jn-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.jn-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 24px 0; }
.jn-proj { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.jn-proj-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
.jn-proj-head .name { font-size: 13px; font-weight: 600; }
.jn-proj-head .code { font-size: 10px; font-weight: 700; color: var(--muted); background: var(--panel); border-radius: 4px; padding: 1px 6px; }
.jn-proj-head .counts { margin-left: auto; font-size: 11px; color: var(--muted-2); }
.jn-proj-actions { display: flex; gap: 6px; margin-left: 8px; }
.jn-icon-btn { border: 1px solid var(--border); background: transparent; color: var(--muted); border-radius: 6px; font-size: 11px; padding: 3px 8px; cursor: pointer; }
.jn-icon-btn:hover { color: var(--text); border-color: var(--accent); }
.jn-icon-btn.has-note { border-color: var(--amber); color: var(--amber); }
.jn-proj-body { padding: 6px 10px 10px; }
.jn-group { margin: 8px 0; }
.jn-group-label { font-size: 12px; font-weight: 700; margin-bottom: 4px; }
.jn-row { display: flex; align-items: baseline; gap: 6px; padding: 3px 4px; font-size: 12.5px; border-radius: 6px; }
.jn-row:hover { background: var(--panel-2); }
.jn-row.child { margin-left: 20px; padding-left: 8px; border-left: 2px solid var(--border); }
.jn-row .code { flex: none; color: var(--accent); font-weight: 600; font-size: 11px; }
.jn-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jn-row .badge { flex: none; font-size: 10px; font-weight: 600; border-radius: 999px; padding: 1px 7px; }
.jn-caption { font-size: 11px; color: var(--muted-2); padding: 4px 4px 0; }
.jn-note-box { margin-top: 6px; }
.jn-note-box textarea { width: 100%; box-sizing: border-box; min-height: 56px; background: var(--panel); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-size: 12.5px; padding: 6px 8px; resize: vertical; }
.jn-settings-pop { position: absolute; right: 12px; top: 40px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; z-index: 10; }
```

- [ ] **Step 4: Write `main.ts`**

Create `src/journal/main.ts`:

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { generateJournal, getSettings, openWorkJournal as _openWorkJournal } from "../shared/ipc";
import { applyTheme } from "../shared/theme";
import { badgeFor, clusterByParent, DEFAULT_JOURNAL_SETTINGS, projectToText } from "./logic";
import type { TJournalGroup, TJournalSettings } from "./logic";
import type { JournalItem, JournalProject, JournalReport } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const bodyEl = document.getElementById("jnBody")!;
const dateEl = document.getElementById("jnDate")!;

const SETTINGS_KEY = "plane-quick-dock-journal-settings";
const noteKey = (today: string, projectId: string) => `plane-quick-dock-journal-note:${today}:${projectId}`;

function loadSettings(): TJournalSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_JOURNAL_SETTINGS;
    return { ...DEFAULT_JOURNAL_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_JOURNAL_SETTINGS;
  }
}

function saveSettings(s: TJournalSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — no-op
  }
}

function loadNote(today: string, projectId: string): string {
  try {
    return window.localStorage.getItem(noteKey(today, projectId)) ?? "";
  } catch {
    return "";
  }
}

function saveNote(today: string, projectId: string, value: string): void {
  try {
    window.localStorage.setItem(noteKey(today, projectId), value);
  } catch {
    // storage unavailable — no-op
  }
}

let settings = loadSettings();
let current: JournalReport | null = null;

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const GROUP_LABELS: Record<TJournalGroup, string> = {
  completed: "✅ 완료된 일", in_progress: "🔄 진행 중인 일", upcoming: "📌 진행 예정인 일",
};
const GROUP_COLORS: Record<TJournalGroup, string> = {
  completed: "#16a34a", in_progress: "#2563eb", upcoming: "#6b7280",
};

function itemRow(item: JournalItem, group: TJournalGroup, today: string, isChild: boolean): HTMLElement {
  const row = el("div", "jn-row" + (isChild ? " child" : ""));
  row.appendChild(el("span", "code", `${item.sequence_id}`));
  row.appendChild(el("span", "name", item.name));
  const badge = badgeFor(item, group, today);
  if (badge) {
    const b = el("span", "badge", badge.text);
    b.style.color = badge.color;
    b.style.backgroundColor = badge.bg;
    row.appendChild(b);
  }
  return row;
}

function renderGroup(project: JournalProject, group: TJournalGroup, today: string): HTMLElement | null {
  const items = project[group];
  if (!items.length) return null;
  const wrap = el("div", "jn-group");
  const label = el("div", "jn-group-label", `${GROUP_LABELS[group]} ${items.length}`);
  label.style.color = GROUP_COLORS[group];
  wrap.appendChild(label);
  clusterByParent(items).forEach((unit) => {
    if (unit.type === "item") {
      wrap.appendChild(itemRow(unit.item, group, today, false));
    } else if (unit.type === "promoted") {
      wrap.appendChild(itemRow(unit.item, group, today, false));
      unit.children.forEach((c) => wrap.appendChild(itemRow(c, group, today, true)));
    } else {
      wrap.appendChild(el("div", "jn-caption", `${unit.parent.project_identifier}-${unit.parent.sequence_id} ${unit.parent.name}`));
      unit.items.forEach((c) => wrap.appendChild(itemRow(c, group, today, true)));
    }
  });
  return wrap;
}

function renderProject(project: JournalProject, today: string): HTMLElement {
  const card = el("div", "jn-proj");
  const head = el("div", "jn-proj-head");
  head.appendChild(el("span", "name", project.project_name));
  head.appendChild(el("span", "code", project.project_identifier));
  head.appendChild(el("span", "counts", `${project.completed.length} · ${project.in_progress.length} · ${project.upcoming.length}`));

  const actions = el("div", "jn-proj-actions");
  const existingNote = loadNote(today, project.project_id);
  const noteBtn = el("button", "jn-icon-btn" + (existingNote ? " has-note" : ""), "⚠️ 이슈") as HTMLButtonElement;
  noteBtn.type = "button";
  const copyBtn = el("button", "jn-icon-btn", "복사") as HTMLButtonElement;
  copyBtn.type = "button";
  actions.appendChild(noteBtn);
  actions.appendChild(copyBtn);
  head.appendChild(actions);
  card.appendChild(head);

  const body = el("div", "jn-proj-body");
  (["completed", "in_progress", "upcoming"] as TJournalGroup[]).forEach((g) => {
    const groupEl = renderGroup(project, g, today);
    if (groupEl) body.appendChild(groupEl);
  });
  card.appendChild(body);

  const noteBox = el("div", "jn-note-box");
  const textarea = document.createElement("textarea");
  textarea.value = existingNote;
  textarea.placeholder = "오늘 이슈나 특이사항을 적어두세요";
  noteBox.appendChild(textarea);
  noteBox.hidden = true;
  card.appendChild(noteBox);

  noteBtn.onclick = () => {
    noteBox.hidden = !noteBox.hidden;
  };
  textarea.oninput = () => {
    saveNote(today, project.project_id, textarea.value);
    noteBtn.classList.toggle("has-note", textarea.value.trim().length > 0);
  };
  copyBtn.onclick = async () => {
    try {
      await writeText(projectToText(project, settings, today, textarea.value));
      copyBtn.textContent = "복사됨 ✓";
      setTimeout(() => (copyBtn.textContent = "복사"), 1200);
    } catch (e) {
      console.error("clipboard write failed:", e);
    }
  };

  return card;
}

function render(report: JournalReport) {
  current = report;
  dateEl.textContent = report.today;
  bodyEl.innerHTML = "";
  if (report.projects.length === 0) {
    bodyEl.appendChild(el("p", "jn-empty", "오늘 남은 업무가 없습니다 🎉"));
    return;
  }
  report.projects.forEach((p) => bodyEl.appendChild(renderProject(p, report.today)));
}

function renderLoading() {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "jn-empty", "불러오는 중…"));
}

function renderError(err: unknown) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "jn-empty", "업무일지를 불러오지 못했어요: " + err));
}

async function load() {
  renderLoading();
  try {
    render(await generateJournal());
  } catch (e) {
    console.error("generateJournal failed:", e);
    renderError(e);
  }
}

document.getElementById("jnClose")!.onclick = () => win.hide();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});

// briefing/main.ts와 같은 이유로: 창이 이미 열려 있는 채로 listen 등록 전에
// 열림 신호가 갈 수 있으니, 등록 뒤 이미 보이는 상태면 유실된 신호로 보고 직접 불러온다.
listen("workjournal-open", load)
  .then(() => win.isVisible())
  .then((visible) => {
    if (visible) load();
  })
  .catch((err) => console.error("workjournal-open listener setup failed:", err));
getSettings().then((s) => applyTheme(s.theme)).catch(() => {});
settings = loadSettings();
void saveSettings; // 설정 팝오버는 이후 반복에서 4개 토글 UI로 연결한다.
```

- [ ] **Step 5: Emit the open event from the backend**

In `src-tauri/src/commands.rs`, update `open_work_journal` (added in Task 5) to also emit the open signal, matching `open_briefing`:

```rust
#[tauri::command]
pub fn open_work_journal(app: tauri::AppHandle) {
    crate::show_centered(&app, "workjournal");
    let _ = app.emit_to("workjournal", "workjournal-open", ());
}
```

- [ ] **Step 6: Manual verification**

Run: `pnpm build 2>&1 | tail -30` — expect no TypeScript/build errors.
Run: `cd src-tauri && cargo build 2>&1 | tail -20` — expect success.
Run: `pnpm tauri dev`, then trigger `open_work_journal` once the sidebar wiring from Task 11 is in place (or temporarily call `invoke("open_work_journal")` from the browser devtools console on the sidebar window) — confirm the window opens, shows real project cards grouped by 완료/진행중/예정, and the 복사 button copies text matching the format from Task 9's tests.

- [ ] **Step 7: Commit**

```bash
git add src/journal/index.html src/journal/main.ts src/shared/app.css vite.config.ts src-tauri/src/commands.rs
git commit -m "feat: render the work journal window"
```

---

## Task 11: 사이드바 아이콘 배선 · 설정 4토글 · CHANGELOG

**Files:**
- Modify: `src/sidebar/index.html` (new `journalBtn`)
- Modify: `src/sidebar/main.ts` (wire the click handler)
- Modify: `src/journal/index.html` (settings gear button)
- Modify: `src/journal/main.ts` (settings popover wiring — the 4 toggles)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `openWorkJournal` (Task 6).
- Produces: user-visible sidebar entry point; completes the feature end-to-end.

- [ ] **Step 1: Add the sidebar icon**

In `src/sidebar/index.html`, add a new `<span>` right after `briefingBtn` (currently line 14):

```html
        <span id="journalBtn" class="hbtn" title="오늘 업무일지"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M4 2.5h5.5L12 5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"/><path d="M9.5 2.5V5H12"/><path d="M4.8 7.3h4.4M4.8 9.4h4.4M4.8 11.5h2.8"/></svg></span>
```

- [ ] **Step 2: Wire the click handler**

In `src/sidebar/main.ts`, add `openWorkJournal` to the import list (line 5, alongside `openBriefing`):

```typescript
import { acknowledgeAssignment, checkUpdatesManual, createIssue, deleteWorkItem, fetchReleaseNotes, fetchSidebarData, getConflicts, getOfflineStatus, getPendingAssignments, getSettings, openBriefing, openConflictWindow, openEditModal, openSettings, openWorkJournal, saveSettings, showQuickaddForProject, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

Then add the handler next to the existing `briefingBtn` one (currently lines 864-866):

```typescript
document.getElementById("journalBtn")!.onclick = () => {
  openWorkJournal().catch((e) => console.error("openWorkJournal failed:", e));
};
```

- [ ] **Step 3: Add the settings gear button and popover markup**

In `src/journal/index.html`, add a gear button next to `jnClose` (before it, inside `.jn-head`):

```html
        <button type="button" id="jnSettingsBtn" class="bf-icon-btn" title="복사 옵션">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" stroke-linecap="round"/></svg>
        </button>
        <div id="jnSettingsPop" class="jn-settings-pop" hidden>
          <label><input type="checkbox" id="jnOptProjectName" /> 프로젝트명 포함</label>
          <label><input type="checkbox" id="jnOptCode" /> 코드 포함</label>
          <label><input type="checkbox" id="jnOptPriority" /> 우선순위 포함</label>
          <label><input type="checkbox" id="jnOptDates" /> 날짜 포함</label>
        </div>
```

- [ ] **Step 4: Wire the popover in `main.ts`**

In `src/journal/main.ts`, replace the placeholder line `void saveSettings; // 설정 팝오버는...` at the end of the file with:

```typescript
const settingsBtn = document.getElementById("jnSettingsBtn") as HTMLButtonElement;
const settingsPop = document.getElementById("jnSettingsPop") as HTMLElement;
const optProjectName = document.getElementById("jnOptProjectName") as HTMLInputElement;
const optCode = document.getElementById("jnOptCode") as HTMLInputElement;
const optPriority = document.getElementById("jnOptPriority") as HTMLInputElement;
const optDates = document.getElementById("jnOptDates") as HTMLInputElement;

function syncSettingsInputs() {
  optProjectName.checked = settings.includeProjectName;
  optCode.checked = settings.includeCode;
  optPriority.checked = settings.includePriority;
  optDates.checked = settings.includeDates;
}
syncSettingsInputs();

settingsBtn.onclick = () => {
  settingsPop.hidden = !settingsPop.hidden;
};
(
  [
    [optProjectName, "includeProjectName"],
    [optCode, "includeCode"],
    [optPriority, "includePriority"],
    [optDates, "includeDates"],
  ] as [HTMLInputElement, keyof TJournalSettings][]
).forEach(([input, key]) => {
  input.onchange = () => {
    settings = { ...settings, [key]: input.checked };
    saveSettings(settings);
  };
});
```

- [ ] **Step 5: Type-check and build**

Run: `pnpm build 2>&1 | tail -30`
Expected: no errors.

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: all Rust tests still pass.

Run: `pnpm test 2>&1 | tail -20`
Expected: all vitest tests still pass.

- [ ] **Step 6: Manual verification**

Run: `pnpm tauri dev`. In the sidebar, click the new "오늘 업무일지" icon. Confirm:
- The window opens centered, showing today's date.
- Projects are grouped with 완료/진행중/예정 sections in that order, empty groups hidden.
- A sub-issue (if any test data has one) renders indented under its parent.
- Toggling the 4 settings checkboxes changes what "복사" puts on the clipboard (paste into a text editor to confirm).
- Typing in "⚠️ 이슈" for a project, closing and reopening the window, still shows the saved note (persisted via localStorage) and the note appears in the copied text.

- [ ] **Step 7: Add the CHANGELOG entry**

In `CHANGELOG.md`, add one line under `### 추가` in the `## [Unreleased]` section:

```markdown
- 사이드바에 "오늘 업무일지" 기능 추가 — 오늘 맡은 작업을 프로젝트·상태별로 정리해 보여주고 프로젝트별로 복사할 수 있습니다.
```

- [ ] **Step 8: Commit**

```bash
git add src/sidebar/index.html src/sidebar/main.ts src/journal/index.html src/journal/main.ts CHANGELOG.md
git commit -m "feat(sidebar): add today's work journal modal"
```

---

## Self-Review

**Spec coverage:**
- 진입점(아이콘+창) → Task 11 Steps 1-2, Task 5 Step 3. ✓
- 데이터 모델(parent_id, 선정 규칙) → Tasks 1-2. ✓
- 정렬/부모 해석 → Task 3. ✓
- DTO/커맨드 배선 → Tasks 4-5. ✓
- 텍스트 포맷·클러스터링·배지 → Tasks 7-9. ✓
- 설정 4토글 → Task 11 Steps 3-4 (persistence in `main.ts`, type in Task 9). ✓
- 이슈/특이사항 메모 → Task 10 (`main.ts` note textarea + `noteToLines` in Task 9). ✓
- CHANGELOG → Task 11 Step 7. ✓
- Non-goals (기간 선택, 팀 보고서, 라벨 커스텀, 전체 일괄 복사) — intentionally not built anywhere in this plan. ✓

**Placeholder scan:** no TBD/TODO, no vague instructions without code.

**Type consistency:** `JournalItem`/`JournalParent`/`JournalProject`/`JournalReport` (TS, Task 6) mirror `JournalItemDto`/`JournalParentDto`/`JournalProjectDto`/`JournalReportDto` (Rust, Task 4) field-for-field. `TJournalGroup` values (`"completed" | "in_progress" | "upcoming"`) match the Rust `BucketedItem.group` string literals (Task 2) and the JSON keys `completed`/`in_progress`/`upcoming` used in `JournalProjectDto` (Task 4) and `JournalProject` (Task 6) — verified consistent across all tasks.
