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
