//! 오프라인 캐시 · 쓰기 큐 · 재생(replay) 순수 로직 + 영속화.
//!
//! 네트워크 판정과 백그라운드 루프는 lib.rs가 담당하고, 이 모듈은 데이터
//! 구조와 영속 상태, 순수 판정 로직만 둔다 (assign_watch.rs와 같은 구조).

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::commands::{SidebarData, StateDto, WorkItemDto};

const STORE_FILE: &str = "offline.json";
const CACHE_KEY: &str = "cache";
const QUEUE_KEY: &str = "queue";
const CONFLICTS_KEY: &str = "conflicts";

/// pending-queue.json은 백그라운드 재생(`replay_queue`, lib.rs)과 쓰기
/// 커맨드(각 `queue_*` 헬퍼)가 둘 다 read-modify-write 한다 — 이 락을 잡은
/// 채로만 load_queue→save_queue 구간을 실행할 것 (assign_watch::StateLock과
/// 같은 패턴).
#[derive(Default)]
pub struct QueueLock(pub tokio::sync::Mutex<()>);

/// conflicts.json은 백그라운드 재생(`replay_queue`, lib.rs)과 `resolve_conflict`
/// 커맨드가 둘 다 read-modify-write 한다 — 이 락을 잡은 채로만
/// load_conflicts→save_conflicts 구간을 실행할 것 (QueueLock과 같은 패턴).
#[derive(Default)]
pub struct ConflictLock(pub tokio::sync::Mutex<()>);

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
    pub base_updated_at: Option<String>,
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

/// 오프라인 생성 임시 id(`local-*`)를 참조하던 큐 항목들을 실제 서버 id로
/// 치환한다 — `CreateIssue` 재생이 성공한 직후 호출. `target_id`뿐 아니라 payload의
/// `parent_id`도 바꾼다: 오프라인에서 부모와 자식을 잇달아 만들면 자식은 부모의
/// 로컬 id를 들고 있어서, 그대로 보내면 Plane이 400으로 거절한다.
pub fn remap_target_id(queue: &mut OfflineQueue, old_id: &str, new_id: &str) {
    for m in queue.items.iter_mut() {
        if m.target_id == old_id {
            m.target_id = new_id.to_string();
        }
        if m.payload.get("parent_id").and_then(|v| v.as_str()) == Some(old_id) {
            m.payload["parent_id"] = serde_json::json!(new_id);
        }
    }
}

pub fn patch_cached_item(items: &mut [WorkItemDto], target_id: &str, patch: impl FnOnce(&mut WorkItemDto)) {
    if let Some(dto) = items.iter_mut().find(|d| d.id == target_id) {
        patch(dto);
    }
}

/// `assigned`/`delegated`는 서로 배타적이므로(같은 항목이 두 목록에 동시에
/// 있을 수 없음), 먼저 찾은 목록에만 patch를 적용한다 — `patch`가 `FnOnce`라
/// 두 번 호출할 수 없다.
pub fn patch_cached_item_in_either(
    assigned: &mut [WorkItemDto],
    delegated: &mut [WorkItemDto],
    target_id: &str,
    patch: impl FnOnce(&mut WorkItemDto),
) {
    if let Some(dto) = assigned.iter_mut().find(|d| d.id == target_id) {
        patch(dto);
    } else if let Some(dto) = delegated.iter_mut().find(|d| d.id == target_id) {
        patch(dto);
    }
}

/// 오프라인 생성 placeholder를 캐시에 넣는다 — 부모가 캐시에 있으면(assigned든
/// delegated든) 그 부모의 `sub_total`도 하나 늘린다.
///
/// 안 늘리면 부모 행이 `0/0` 진행 바를 그리고, `sub_total == 0`이라 "하위 없는
/// 할 일"로 세어져 탭 카운트까지 어긋난다. 새로 만든 하위는 완료 상태가 아니므로
/// `sub_done`은 건드리지 않는다.
pub fn insert_placeholder_into_cache(
    assigned: &mut Vec<WorkItemDto>,
    delegated: &mut [WorkItemDto],
    placeholder: WorkItemDto,
) {
    if let Some(parent_id) = placeholder.parent_id.clone() {
        patch_cached_item_in_either(assigned, delegated, &parent_id, |p| p.sub_total += 1);
    }
    assigned.push(placeholder);
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

fn emit_queue_changed(app: &tauri::AppHandle, pending: usize) {
    let _ = app.emit_to("sidebar", "offline-queue-changed", serde_json::json!({ "pending": pending }));
}

/// 네트워크 실패 시 공통 처리: 큐에 적재 + 캐시에 낙관적 반영 + 이벤트 발행.
/// `patch`는 캐시 스냅샷에 있는 해당 항목(WorkItemDto)에 적용할 변경.
/// 캐시가 아직 없거나(첫 실행부터 오프라인) 항목을 못 찾으면 조용히
/// 건너뛴다 — 큐잉 자체는 캐시 유무와 무관하게 항상 성공해야 한다.
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
        .and_then(|s| {
            s.data.assigned.iter().find(|d| d.id == target_id)
                .or_else(|| s.data.delegated.iter().find(|d| d.id == target_id))
        })
        .and_then(|d| d.updated_at.clone());
    let mut queue = load_queue(app);
    push_mutation(&mut queue, kind, project_id, target_id, payload, base_updated_at, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(snap) = snapshot.as_mut() {
        patch_cached_item_in_either(&mut snap.data.assigned, &mut snap.data.delegated, target_id, patch);
        save_cache_snapshot(app, snap)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
}

/// `create_issue`가 오프라인일 때: 큐에 생성 요청을 적재하고, 임시 id를 붙인
/// `placeholder`를 캐시 목록에 즉시 추가해 화면에 보이게 한다. 임시 id를 돌려준다.
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
        insert_placeholder_into_cache(&mut snapshot.data.assigned, &mut snapshot.data.delegated, placeholder);
        save_cache_snapshot(app, &snapshot)?;
    }
    emit_queue_changed(app, pending);
    Ok(local_id)
}

/// `delete_work_item`이 오프라인일 때: 큐에 삭제 요청을 적재하고 캐시
/// 목록에서 즉시 제거한다.
pub async fn queue_delete_and_remove(app: &tauri::AppHandle, project_id: &str, target_id: &str) -> Result<(), String> {
    let lock = app.state::<QueueLock>();
    let _guard = lock.0.lock().await;
    let now = crate::now_ms();
    let mut snapshot = load_cache(app);
    let base_updated_at = snapshot
        .as_ref()
        .and_then(|s| {
            s.data.assigned.iter().find(|d| d.id == target_id)
                .or_else(|| s.data.delegated.iter().find(|d| d.id == target_id))
        })
        .and_then(|d| d.updated_at.clone());
    let mut queue = load_queue(app);
    push_mutation(&mut queue, MutationKind::Delete, project_id, target_id, serde_json::Value::Null, base_updated_at, now);
    let pending = queue.items.len();
    save_queue(app, &queue)?;
    if let Some(snap) = snapshot.as_mut() {
        remove_cached_item(&mut snap.data.assigned, target_id);
        remove_cached_item(&mut snap.data.delegated, target_id);
        save_cache_snapshot(app, snap)?;
    }
    emit_queue_changed(app, pending);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::WorkItemDetail;

    fn dto(id: &str) -> WorkItemDto {
        WorkItemDto {
            id: id.into(), name: "n".into(), priority: "none".into(),
            target_date: None, start_date: None, state_group: "backlog".into(),
            project_id: "p1".into(), assignee_ids: vec![], completed_at: None, created_at: None, updated_at: None,
            parent_id: None, sub_total: 0, sub_done: 0,
        }
    }

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

    #[test]
    fn patch_cached_item_mutates_only_the_matching_item() {
        let mut items = vec![dto("a"), dto("b")];
        patch_cached_item(&mut items, "b", |d| d.priority = "urgent".into());
        assert_eq!(items[0].priority, "none");
        assert_eq!(items[1].priority, "urgent");
    }

    #[test]
    fn patch_cached_item_in_either_patches_assigned_when_present_there() {
        let mut assigned = vec![dto("a"), dto("b")];
        let mut delegated = vec![dto("c")];
        patch_cached_item_in_either(&mut assigned, &mut delegated, "b", |d| d.priority = "urgent".into());
        assert_eq!(assigned[0].priority, "none");
        assert_eq!(assigned[1].priority, "urgent");
        assert_eq!(delegated[0].priority, "none");
    }

    #[test]
    fn patch_cached_item_in_either_falls_through_to_delegated() {
        let mut assigned = vec![dto("a")];
        let mut delegated = vec![dto("b"), dto("c")];
        patch_cached_item_in_either(&mut assigned, &mut delegated, "c", |d| d.priority = "urgent".into());
        assert_eq!(assigned[0].priority, "none");
        assert_eq!(delegated[0].priority, "none");
        assert_eq!(delegated[1].priority, "urgent");
    }

    #[test]
    fn patch_cached_item_in_either_is_a_noop_when_id_in_neither() {
        let mut assigned = vec![dto("a")];
        let mut delegated = vec![dto("b")];
        patch_cached_item_in_either(&mut assigned, &mut delegated, "missing", |d| d.priority = "urgent".into());
        assert_eq!(assigned[0].priority, "none");
        assert_eq!(delegated[0].priority, "none");
    }

    #[test]
    fn insert_placeholder_bumps_the_parent_sub_total() {
        let mut assigned = vec![dto("parent")];
        let mut delegated: Vec<WorkItemDto> = vec![];
        let mut child = dto("local-1");
        child.parent_id = Some("parent".into());

        insert_placeholder_into_cache(&mut assigned, &mut delegated, child);

        assert_eq!(assigned[0].sub_total, 1);
        assert_eq!(assigned[0].sub_done, 0); // 새 하위는 완료가 아니다
        assert_eq!(assigned[1].id, "local-1");
    }

    #[test]
    fn insert_placeholder_finds_a_parent_in_delegated_too() {
        let mut assigned: Vec<WorkItemDto> = vec![];
        let mut delegated = vec![dto("parent")];
        let mut child = dto("local-1");
        child.parent_id = Some("parent".into());

        insert_placeholder_into_cache(&mut assigned, &mut delegated, child);

        assert_eq!(delegated[0].sub_total, 1);
        assert_eq!(assigned[0].id, "local-1");
    }

    #[test]
    fn insert_placeholder_without_a_parent_touches_nothing_else() {
        let mut assigned = vec![dto("a")];
        let mut delegated = vec![dto("b")];

        insert_placeholder_into_cache(&mut assigned, &mut delegated, dto("local-1"));

        assert_eq!(assigned[0].sub_total, 0);
        assert_eq!(delegated[0].sub_total, 0);
        assert_eq!(assigned[1].id, "local-1");
    }

    #[test]
    fn insert_placeholder_still_lands_when_the_parent_is_not_cached() {
        let mut assigned = vec![dto("a")];
        let mut delegated: Vec<WorkItemDto> = vec![];
        let mut child = dto("local-1");
        child.parent_id = Some("어딘가-다른-곳".into());

        insert_placeholder_into_cache(&mut assigned, &mut delegated, child);

        assert_eq!(assigned.len(), 2);
        assert_eq!(assigned[1].id, "local-1");
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
        push_mutation(&mut q, MutationKind::Delete, "p1", "i1", serde_json::Value::Null, None, 1000);
        let json = serde_json::to_string(&q).unwrap();
        let back: OfflineQueue = serde_json::from_str(&json).unwrap();
        assert_eq!(back.items.len(), 1);
        assert_eq!(back.items[0].target_id, "i1");
    }

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
        let fields = local_fields_from_payload_with_states(&MutationKind::UpdatePriority, &payload, &[]);
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
        let fields = local_fields_from_payload_with_states(&MutationKind::UpdateFields, &payload, &[]);
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
}
