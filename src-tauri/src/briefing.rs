use crate::plane_api::{Project, WorkItem};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

pub const MAX_PLAN: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingItem {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub project_identifier: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub state_group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanEntry {
    pub item: BriefingItem,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Briefing {
    /// 생성 기준일 (로컬 YYYY-MM-DD) — 캐시 유효성 판단에 쓴다.
    pub date: String,
    /// 로컬 HH:MM.
    pub generated_at: String,
    pub model: String,
    /// "openai" | "fallback"
    pub source: String,
    /// 폴백 사유: "no_key" 또는 오류 메시지.
    pub error: Option<String>,
    pub summary: String,
    pub plan: Vec<PlanEntry>,
    pub rest: Vec<BriefingItem>,
}

/// 브리핑 대상: 내게 할당된 미완료 작업. 완료·취소는 여기서 걸러져
/// 이후 어떤 경로(프롬프트·폴백)에도 들어가지 않는다.
pub fn open_assigned_items(user_id: &str, projects: &[Project], items: Vec<WorkItem>) -> Vec<BriefingItem> {
    items
        .into_iter()
        .filter(|i| i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "completed" && i.state_group != "cancelled")
        .map(|i| {
            let identifier = projects
                .iter()
                .find(|p| p.id == i.project_id)
                .map(|p| p.identifier.clone())
                .unwrap_or_default();
            BriefingItem {
                id: i.id,
                name: i.name,
                project_id: i.project_id,
                project_identifier: identifier,
                priority: i.priority,
                start_date: i.start_date,
                target_date: i.target_date,
                state_group: i.state_group,
            }
        })
        .collect()
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 정렬 버킷: 0 지연, 1 오늘 마감, 2 진행 중, 3 나머지.
fn bucket(item: &BriefingItem, today: &str) -> u8 {
    if let Some(t) = item.target_date.as_deref() {
        if t < today { return 0; }
        if t == today { return 1; }
    }
    if item.state_group == "started" { return 2; }
    3
}

fn priority_rank(p: &str) -> u8 {
    match p { "urgent" => 0, "high" => 1, "medium" => 2, "low" => 3, _ => 4 }
}

fn priority_suffix(p: &str) -> &'static str {
    match p { "urgent" => " · 우선순위 긴급", "high" => " · 우선순위 높음", _ => "" }
}

/// "2026-07-05" -> "7/5" (실패 시 원문 그대로).
fn short_md(date: &str) -> String {
    match parse_date(date) {
        Some(d) => format!("{}/{}", chrono::Datelike::month(&d), chrono::Datelike::day(&d)),
        None => date.to_string(),
    }
}

pub fn reason_for(item: &BriefingItem, today: &str) -> String {
    let p = priority_suffix(&item.priority);
    match bucket(item, today) {
        0 => {
            let days = match (item.target_date.as_deref().and_then(parse_date), parse_date(today)) {
                (Some(t), Some(now)) => (now - t).num_days(),
                _ => 0,
            };
            format!("마감 {days}일 초과{p}")
        }
        1 => format!("오늘 마감{p}"),
        2 => match item.target_date.as_deref() {
            Some(t) => format!("진행 중 · 마감 {}{p}", short_md(t)),
            None => format!("진행 중{p}"),
        },
        _ => match item.target_date.as_deref() {
            Some(t) => format!("마감 {}{p}", short_md(t)),
            None => format!("마감일 없음{p}"),
        },
    }
}

fn sort_key(item: &BriefingItem, today: &str) -> (u8, u8, String, String) {
    (
        bucket(item, today),
        priority_rank(&item.priority),
        item.target_date.clone().unwrap_or_else(|| "9999-99-99".into()),
        item.name.clone(),
    )
}

/// 나머지 목록 정렬: 마감일 오름차순, 무마감 뒤로, 같으면 이름순.
pub fn sort_rest(items: &mut [BriefingItem]) {
    items.sort_by_key(|i| (i.target_date.clone().unwrap_or_else(|| "9999-99-99".into()), i.name.clone()));
}

pub fn fallback_plan(mut items: Vec<BriefingItem>, today: &str) -> (Vec<PlanEntry>, Vec<BriefingItem>) {
    items.sort_by_key(|i| sort_key(i, today));
    let mut rest: Vec<BriefingItem> = if items.len() > MAX_PLAN { items.split_off(MAX_PLAN) } else { Vec::new() };
    sort_rest(&mut rest);
    let plan = items
        .into_iter()
        .map(|item| {
            let reason = reason_for(&item, today);
            PlanEntry { item, reason }
        })
        .collect();
    (plan, rest)
}

pub fn fallback_summary(items: &[BriefingItem], today: &str) -> String {
    if items.is_empty() {
        return "남은 작업이 없습니다. 여유로운 하루 보내세요!".into();
    }
    let overdue = items.iter().filter(|i| bucket(i, today) == 0).count();
    let due_today = items.iter().filter(|i| bucket(i, today) == 1).count();
    let total = items.len();
    if overdue == 0 && due_today == 0 {
        format!("남은 작업 {total}건입니다.")
    } else {
        format!("지연 {overdue}건, 오늘 마감 {due_today}건 포함 남은 작업 {total}건입니다.")
    }
}

/// "HH:MM" -> 자정 기준 분. 형식이 다르면 None.
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' { return None; }
    let h: u32 = s[0..2].parse().ok()?;
    let m: u32 = s[3..5].parse().ok()?;
    if h > 23 || m > 59 { return None; }
    Some(h * 60 + m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::{Project, WorkItem};

    fn bi(id: &str, priority: &str, target: Option<&str>, group: &str) -> BriefingItem {
        BriefingItem {
            id: id.into(), name: format!("작업 {id}"), project_id: "p1".into(),
            project_identifier: "WEB".into(), priority: priority.into(),
            start_date: None, target_date: target.map(|s| s.to_string()), state_group: group.into(),
        }
    }

    const TODAY: &str = "2026-07-03";

    #[test]
    fn open_assigned_items_excludes_completed_cancelled_and_others() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let mk = |id: &str, group: &str, assignees: &[&str]| WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None,
        };
        let items = vec![
            mk("a", "started", &["me"]),
            mk("b", "completed", &["me"]),  // 완료: 제외
            mk("c", "cancelled", &["me"]),  // 취소: 제외
            mk("d", "backlog", &["other"]), // 남의 것: 제외
        ];
        let out = open_assigned_items("me", &projects, items);
        let ids: Vec<_> = out.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
        assert_eq!(out[0].project_identifier, "WEB");
    }

    #[test]
    fn fallback_plan_orders_overdue_then_today_then_started_then_rest() {
        let items = vec![
            bi("upcoming", "high", Some("2026-07-05"), "unstarted"),
            bi("today", "medium", Some("2026-07-03"), "unstarted"),
            bi("overdue", "urgent", Some("2026-07-01"), "unstarted"),
            bi("doing", "none", Some("2026-07-04"), "started"),
        ];
        let (plan, rest) = fallback_plan(items, TODAY);
        let ids: Vec<_> = plan.iter().map(|e| e.item.id.as_str()).collect();
        assert_eq!(ids, vec!["overdue", "today", "doing", "upcoming"]);
        assert!(rest.is_empty());
    }

    #[test]
    fn fallback_plan_caps_at_max_plan_and_puts_rest_by_due_date() {
        let items: Vec<_> = (0..7).map(|i| bi(&format!("i{i}"), "none", Some("2026-07-03"), "unstarted")).collect();
        let (plan, rest) = fallback_plan(items, TODAY);
        assert_eq!(plan.len(), MAX_PLAN);
        assert_eq!(rest.len(), 2);
    }

    #[test]
    fn fallback_plan_ties_break_by_priority() {
        let items = vec![
            bi("low", "low", Some("2026-07-03"), "unstarted"),
            bi("urgent", "urgent", Some("2026-07-03"), "unstarted"),
        ];
        let (plan, _) = fallback_plan(items, TODAY);
        assert_eq!(plan[0].item.id, "urgent");
    }

    #[test]
    fn reason_for_describes_each_bucket() {
        assert_eq!(reason_for(&bi("a", "urgent", Some("2026-07-01"), "unstarted"), TODAY), "마감 2일 초과 · 우선순위 긴급");
        assert_eq!(reason_for(&bi("b", "high", Some("2026-07-03"), "unstarted"), TODAY), "오늘 마감 · 우선순위 높음");
        assert_eq!(reason_for(&bi("c", "none", Some("2026-07-04"), "started"), TODAY), "진행 중 · 마감 7/4");
        assert_eq!(reason_for(&bi("d", "none", None, "started"), TODAY), "진행 중");
        assert_eq!(reason_for(&bi("e", "none", Some("2026-07-08"), "backlog"), TODAY), "마감 7/8");
        assert_eq!(reason_for(&bi("f", "none", None, "backlog"), TODAY), "마감일 없음");
    }

    #[test]
    fn fallback_summary_counts_overdue_and_today() {
        let items = vec![
            bi("a", "none", Some("2026-07-01"), "unstarted"),
            bi("b", "none", Some("2026-07-03"), "unstarted"),
            bi("c", "none", None, "backlog"),
        ];
        assert_eq!(fallback_summary(&items, TODAY), "지연 1건, 오늘 마감 1건 포함 남은 작업 3건입니다.");
        assert_eq!(fallback_summary(&[], TODAY), "남은 작업이 없습니다. 여유로운 하루 보내세요!");
        let calm = vec![bi("c", "none", None, "backlog")];
        assert_eq!(fallback_summary(&calm, TODAY), "남은 작업 1건입니다.");
    }

    #[test]
    fn parse_hhmm_accepts_valid_and_rejects_garbage() {
        assert_eq!(parse_hhmm("09:00"), Some(540));
        assert_eq!(parse_hhmm("23:59"), Some(1439));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("9:00"), None);
        assert_eq!(parse_hhmm("abcde"), None);
    }
}
