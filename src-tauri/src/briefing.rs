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

/// 아침 브리핑 발화 판정. enabled 체크와 시각 파싱은 호출자(워처) 몫 —
/// 여기는 "지정 시각이 지났고 오늘 아직 안 떴다"만 판단한다.
pub fn should_fire_morning(now_min: u32, cfg_min: u32, today: &str, last_shown: Option<&str>) -> bool {
    now_min >= cfg_min && last_shown != Some(today)
}

/// LLM에 보낼 메시지. user 메시지는 open_assigned_items가 만든 항목의 직렬화라
/// 설명(description) 필드 자체가 존재하지 않는다.
pub fn build_prompt(items: &[BriefingItem], today: &str) -> (String, String) {
    let system = format!(
        "당신은 개인 업무 브리핑 어시스턴트다. 오늘 해야 할 일을 정하는 것이 목표다.\n\
         반드시 아래 형태의 JSON만 응답한다 (다른 텍스트 금지):\n\
         {{\"summary\": \"2~3문장 한국어 요약\", \"plan\": [{{\"id\": \"작업 id\", \"reason\": \"이유 한 줄\"}}], \"rest\": [\"작업 id\"]}}\n\
         규칙:\n\
         - plan은 오늘 집중할 작업을 처리 순서대로 최대 {MAX_PLAN}개.\n\
         - 우선 기준: 마감 지남 > 오늘 마감 > 진행 중 > 우선순위(urgent>high>medium>low) > 마감 임박.\n\
         - 같은 프로젝트 작업은 묶어서 처리하도록 순서를 잡아도 좋다.\n\
         - reason은 사용자가 바로 이해할 짧은 한국어 한 줄 (예: \"마감 2일 초과 · 긴급\").\n\
         - plan에 넣지 않은 작업 id는 전부 rest에 넣는다.\n\
         - 입력에 존재하는 id만 사용한다."
    );
    let payload = serde_json::json!({
        "today": today,
        "items": items.iter().map(|i| serde_json::json!({
            "id": i.id,
            "name": i.name,
            "project": i.project_identifier,
            "priority": i.priority,
            "start_date": i.start_date,
            "target_date": i.target_date,
            "state": i.state_group,
        })).collect::<Vec<_>>(),
    });
    (system, payload.to_string())
}

#[derive(Deserialize)]
struct RawPlanEntry {
    id: String,
    #[serde(default)]
    reason: String,
}

#[derive(Deserialize)]
struct RawBriefingResponse {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    plan: Vec<RawPlanEntry>,
    #[serde(default)]
    rest: Vec<String>,
}

/// JSON 모드여도 모델이 가끔 ```json 펜스로 감싼다 — 방어적으로 벗긴다.
fn strip_code_fences(s: &str) -> &str {
    let t = s.trim();
    let Some(inner) = t.strip_prefix("```") else { return t };
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    let inner = inner.strip_suffix("```").unwrap_or(inner);
    inner.trim()
}

/// AI 응답을 실제 작업 목록에 대조해 (summary, plan, rest)로 바꾼다.
/// 존재하지 않는 id는 버리고, 응답이 빠뜨린 작업은 rest로 편입한다 —
/// 어떤 작업도 사라지거나 날조되지 않는다.
pub fn apply_ai_response(
    content: &str,
    items: Vec<BriefingItem>,
    today: &str,
) -> Result<(String, Vec<PlanEntry>, Vec<BriefingItem>), String> {
    let raw: RawBriefingResponse =
        serde_json::from_str(strip_code_fences(content)).map_err(|e| format!("응답 JSON 파싱 실패: {e}"))?;
    let mut by_id: std::collections::HashMap<String, BriefingItem> =
        items.into_iter().map(|i| (i.id.clone(), i)).collect();
    let mut plan = Vec::new();
    for e in raw.plan {
        if plan.len() >= MAX_PLAN { break; }
        if let Some(item) = by_id.remove(&e.id) {
            let reason = if e.reason.trim().is_empty() { reason_for(&item, today) } else { e.reason };
            plan.push(PlanEntry { item, reason });
        }
    }
    let mut rest: Vec<BriefingItem> = Vec::new();
    for id in raw.rest {
        if let Some(item) = by_id.remove(&id) { rest.push(item); }
    }
    rest.extend(by_id.into_values());
    sort_rest(&mut rest);
    Ok((raw.summary.trim().to_string(), plan, rest))
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
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true }];
        let mk = |id: &str, group: &str, assignees: &[&str]| WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(),
            project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: None, created_at: None, created_by: None, updated_at: None,
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

    #[test]
    fn build_prompt_includes_items_but_never_description_key() {
        let items = vec![bi("a", "high", Some("2026-07-04"), "started")];
        let (system, user) = build_prompt(&items, TODAY);
        assert!(system.contains("JSON"));
        assert!(user.contains("\"a\""));
        assert!(user.contains("2026-07-03")); // 오늘 날짜
        assert!(!user.contains("description"));
    }

    #[test]
    fn apply_ai_response_maps_known_ids_and_drops_fakes() {
        let items = vec![
            bi("a", "urgent", Some("2026-07-01"), "unstarted"),
            bi("b", "none", Some("2026-07-05"), "unstarted"),
            bi("c", "none", None, "backlog"),
        ];
        let content = r#"{
            "summary": "요약입니다.",
            "plan": [
                { "id": "a", "reason": "가장 급함" },
                { "id": "ghost", "reason": "존재하지 않는 작업" },
                { "id": "b", "reason": "" }
            ],
            "rest": ["nope"]
        }"#;
        let (summary, plan, rest) = apply_ai_response(content, items, TODAY).unwrap();
        assert_eq!(summary, "요약입니다.");
        let ids: Vec<_> = plan.iter().map(|e| e.item.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]); // ghost 제거
        assert_eq!(plan[0].reason, "가장 급함");
        // 빈 reason은 규칙 기반 문구로 대체
        assert_eq!(plan[1].reason, "마감 7/5");
        // 응답에서 빠진 c는 rest로 자동 편입, 가짜 id "nope"는 무시
        let rest_ids: Vec<_> = rest.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(rest_ids, vec!["c"]);
    }

    #[test]
    fn apply_ai_response_caps_plan_at_max_and_strips_code_fences() {
        let items: Vec<_> = (0..7).map(|i| bi(&format!("i{i}"), "none", None, "backlog")).collect();
        let plan_json: Vec<String> = (0..7).map(|i| format!(r#"{{"id":"i{i}","reason":"r"}}"#)).collect();
        let content = format!("```json\n{{\"summary\":\"s\",\"plan\":[{}],\"rest\":[]}}\n```", plan_json.join(","));
        let (_, plan, rest) = apply_ai_response(&content, items, TODAY).unwrap();
        assert_eq!(plan.len(), MAX_PLAN);
        assert_eq!(rest.len(), 2);
    }

    #[test]
    fn apply_ai_response_rejects_non_json() {
        let items = vec![bi("a", "none", None, "backlog")];
        assert!(apply_ai_response("이건 JSON이 아님", items, TODAY).is_err());
    }

    #[test]
    fn morning_fires_once_after_configured_time() {
        let nine = 9 * 60;
        // 시각 전: 안 뜸
        assert!(!should_fire_morning(8 * 60 + 59, nine, "2026-07-03", None));
        // 시각 도달: 뜸
        assert!(should_fire_morning(nine, nine, "2026-07-03", None));
        // 훨씬 늦게 켜도 (그날 처음이면) 뜸 — 출근 후 PC 켜는 패턴
        assert!(should_fire_morning(14 * 60, nine, "2026-07-03", Some("2026-07-02")));
        // 오늘 이미 떴으면 다시 안 뜸
        assert!(!should_fire_morning(10 * 60, nine, "2026-07-03", Some("2026-07-03")));
    }

    #[test]
    fn briefing_serde_round_trips_for_cache() {
        let b = Briefing {
            date: "2026-07-03".into(), generated_at: "09:00".into(),
            model: "gpt-4o-mini".into(), source: "openai".into(), error: None,
            summary: "요약".into(),
            plan: vec![PlanEntry { item: bi("a", "urgent", Some("2026-07-01"), "unstarted"), reason: "이유".into() }],
            rest: vec![bi("b", "none", None, "backlog")],
        };
        let json = serde_json::to_value(&b).unwrap();
        let back: Briefing = serde_json::from_value(json).unwrap();
        assert_eq!(back.date, "2026-07-03");
        assert_eq!(back.plan.len(), 1);
        assert_eq!(back.plan[0].item.id, "a");
        assert_eq!(back.rest[0].id, "b");
    }
}
