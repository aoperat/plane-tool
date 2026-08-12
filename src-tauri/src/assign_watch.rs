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

/// assign-state.json은 watcher tick과 확인 커맨드 두 곳에서 read-modify-write
/// 된다 — 이 락을 잡은 채로만 load_state→save_state 구간을 실행할 것.
#[derive(Default)]
pub struct StateLock(pub tokio::sync::Mutex<()>);

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
            updated_at: None,
            sequence_id: 0,
            parent_id: None,
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
