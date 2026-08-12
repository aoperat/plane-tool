//! mng 일일 업무일지 내용 텍스트 조립 (순수 로직).
//!
//! Plane 웹의 실제 업무보고서 포맷(`apps/web/.../work-report/report-text.ts`의
//! `projectToText`, `report-body.tsx`의 `badgeFor`/`priorityLabel`)을 한 글자도
//!다르지 않게 이식한다 — plane-tool이 만드는 내용이 사람이 웹에서 복사한 것과
//! 미묘하게 달라 헷갈리지 않게 하기 위해서다. 부모-자식 클러스터링(`└` 들여쓰기)은
//! 이번 범위에서 제외했다 — 완료 항목의 부모가 같은 상태 그룹에 없는 게 대부분이라
//! 드물게만 발생하고, 포팅 비용 대비 효과가 낮다.
//!
//! 네트워크/커맨드는 commands.rs가 담당하고, 이 모듈은 이미 가져온 `WorkItem`
//! 목록을 텍스트로 조립하는 것까지만 한다(assign_watch.rs·deadline_watch.rs와
//! 같은 구조).

use crate::plane_api::{completed_within, WorkItem};
use chrono::{Datelike, NaiveDate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MngReportGroup {
    Completed,
    InProgress,
    Upcoming,
}

/// "내용에 포함할 항목" — Plane 업무보고서 설정의 "복사 옵션" 4개 토글
/// (`work-report/settings-modal.tsx:57-61`)과 완전히 동일한 필드다.
#[derive(Debug, Clone, Copy)]
pub struct MngContentOptions {
    pub include_project_name: bool,
    pub include_code: bool,
    pub include_priority: bool,
    pub include_dates: bool,
}

impl Default for MngContentOptions {
    fn default() -> Self {
        Self {
            include_project_name: true,
            include_code: true,
            include_priority: true,
            include_dates: true,
        }
    }
}

pub fn group_label(group: MngReportGroup) -> &'static str {
    match group {
        MngReportGroup::Completed => "✅ 완료된 일",
        MngReportGroup::InProgress => "🔄 진행 중인 일",
        MngReportGroup::Upcoming => "📌 진행 예정인 일",
    }
}

/// `report-body.tsx`의 `priorityLabel` — "none"/미인식 값은 빈 문자열(표시 생략).
pub fn priority_label(priority: &str) -> &'static str {
    match priority {
        "urgent" => "긴급",
        "high" => "높음",
        "medium" => "보통",
        "low" => "낮음",
        _ => "",
    }
}

fn month_day(date: NaiveDate) -> String {
    format!("{:02}-{:02}", date.month(), date.day())
}

/// "YYYY-MM-DD" 또는 그 앞부분을 담은 UTC 타임스탬프에서 날짜만 뽑는다.
/// `completed_within`과 같은 수준의 근사치(로컬 타임존 변환 없음)다.
fn parse_date_prefix(s: &str) -> Option<NaiveDate> {
    s.get(0..10).and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
}

/// `report-body.tsx:237-279`의 `badgeFor` 이식. 완료는 항상, 진행중/예정은
/// 날짜가 있을 때만 배지가 붙는다.
pub fn badge_for(item: &WorkItem, group: MngReportGroup, today: NaiveDate) -> Option<String> {
    match group {
        MngReportGroup::Completed => item
            .completed_at
            .as_deref()
            .and_then(parse_date_prefix)
            .map(|d| format!("{} 완료", month_day(d))),
        MngReportGroup::InProgress => item.target_date.as_deref().and_then(parse_date_prefix).map(|d| {
            let diff = (d - today).num_days();
            if diff < 0 {
                format!("{}일 지연 · {} 마감", -diff, month_day(d))
            } else {
                format!("D-{} · {} 마감", diff, month_day(d))
            }
        }),
        MngReportGroup::Upcoming => {
            if let Some(start) = item.start_date.as_deref().and_then(parse_date_prefix) {
                if (start - today).num_days() > 0 {
                    return Some(format!("{} 시작 예정", month_day(start)));
                }
            }
            item.target_date
                .as_deref()
                .and_then(parse_date_prefix)
                .map(|d| format!("{} 마감", month_day(d)))
        }
    }
}

/// `report-text.ts:85-93`의 `itemToLine` 이식(깊이 0 고정 — 클러스터링 없음).
pub fn item_line(item: &WorkItem, identifier: &str, group: MngReportGroup, opts: &MngContentOptions, today: NaiveDate) -> String {
    let code = if opts.include_code {
        format!("{}-{} ", identifier, item.sequence_id)
    } else {
        String::new()
    };
    let prio = if opts.include_priority {
        let label = priority_label(&item.priority);
        if label.is_empty() { String::new() } else { format!(" ({label})") }
    } else {
        String::new()
    };
    let suffix = if opts.include_dates {
        badge_for(item, group, today).map(|b| format!(" — {b}")).unwrap_or_default()
    } else {
        String::new()
    };
    format!("  • {code}{name}{prio}{suffix}", name = item.name)
}

/// 담당 항목을 상태 그룹별로 나눈다 — completed는 `completed_at`이 오늘 범위 안인
/// 것만, in_progress는 `state_group == "started"` 전체, upcoming은
/// `state_group == "unstarted"` 전체(backlog/cancelled 제외). 정렬 규칙은 Plane
/// 웹과 동일: 완료는 최근 완료순, 진행중은 마감 임박순(없는 것은 뒤로), 예정은
/// 시작일(없으면 마감일) 임박순(둘 다 없는 것은 뒤로).
pub fn classify_groups<'a>(
    items: &'a [WorkItem],
    today: &str,
) -> (Vec<&'a WorkItem>, Vec<&'a WorkItem>, Vec<&'a WorkItem>) {
    let mut completed: Vec<&WorkItem> = Vec::new();
    let mut in_progress: Vec<&WorkItem> = Vec::new();
    let mut upcoming: Vec<&WorkItem> = Vec::new();
    for item in items {
        match item.state_group.as_str() {
            "completed" if completed_within(item, today, today) => completed.push(item),
            "started" => in_progress.push(item),
            "unstarted" => upcoming.push(item),
            _ => {}
        }
    }
    completed.sort_by(|a, b| b.completed_at.as_deref().unwrap_or("").cmp(a.completed_at.as_deref().unwrap_or("")));
    in_progress.sort_by(|a, b| {
        let ka = a.target_date.as_deref().unwrap_or("9999-99-99");
        let kb = b.target_date.as_deref().unwrap_or("9999-99-99");
        ka.cmp(kb)
    });
    upcoming.sort_by(|a, b| {
        let ka = a.start_date.as_deref().or(a.target_date.as_deref()).unwrap_or("9999-99-99");
        let kb = b.start_date.as_deref().or(b.target_date.as_deref()).unwrap_or("9999-99-99");
        ka.cmp(kb)
    });
    (completed, in_progress, upcoming)
}

/// `report-text.ts:68-123`의 `projectToText` 이식. `groups`는
/// `classify_groups`가 돌려준 (완료, 진행중, 예정) 순서 그대로 받는다.
pub fn project_to_text(
    project_name: &str,
    identifier: &str,
    client: Option<&str>,
    groups: (&[&WorkItem], &[&WorkItem], &[&WorkItem]),
    opts: &MngContentOptions,
    today: NaiveDate,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    if opts.include_project_name {
        let suffix = client
            .filter(|c| !c.is_empty())
            .map(|c| format!(" ({c})"))
            .unwrap_or_default();
        lines.push(format!("[{project_name} / {identifier}]{suffix}"));
    }
    let (completed, in_progress, upcoming) = groups;
    for (group, items) in [
        (MngReportGroup::Completed, completed),
        (MngReportGroup::InProgress, in_progress),
        (MngReportGroup::Upcoming, upcoming),
    ] {
        if items.is_empty() {
            continue;
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(group_label(group).to_string());
        for item in items {
            lines.push(item_line(item, identifier, group, opts, today));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, seq: u64, priority: &str, completed_at: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(),
            name: name.into(),
            priority: priority.into(),
            target_date: None,
            start_date: None,
            state_group: "completed".into(),
            project_id: "p1".into(),
            assignee_ids: vec!["me".into()],
            completed_at: completed_at.map(str::to_string),
            created_at: None,
            created_by: None,
            updated_at: None,
            sequence_id: seq,
            parent_id: None,
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 12).unwrap()
    }

    // 목업(docs/mockups/mng-daily-quick-submit-mockup.html) 3번 섹션의 예시
    // 문자열과 정확히 일치해야 한다.
    #[test]
    fn project_to_text_matches_mockup_example_with_all_options_on() {
        let items = vec![
            item("i1", "사이드바 폭 조절 버그 수정", 142, "medium", Some("2026-08-12T09:00:00Z")),
            item("i2", "전광판 색상 테마 통일", 139, "high", Some("2026-08-12T10:00:00Z")),
        ];
        let refs: Vec<&WorkItem> = items.iter().collect();
        let text = project_to_text(
            "Plane Quick Dock",
            "PQD",
            None,
            (&refs, &[], &[]),
            &MngContentOptions::default(),
            today(),
        );
        assert_eq!(
            text,
            "[Plane Quick Dock / PQD]\n\n✅ 완료된 일\n  • PQD-142 사이드바 폭 조절 버그 수정 (보통) — 08-12 완료\n  • PQD-139 전광판 색상 테마 통일 (높음) — 08-12 완료"
        );
    }

    // 3-1번 섹션: 우선순위·기한 토글을 끄면 그 두 필드만 빠져야 한다.
    #[test]
    fn project_to_text_matches_mockup_example_with_priority_and_dates_off() {
        let items = vec![
            item("i1", "사이드바 폭 조절 버그 수정", 142, "medium", Some("2026-08-12T09:00:00Z")),
            item("i2", "전광판 색상 테마 통일", 139, "high", Some("2026-08-12T10:00:00Z")),
        ];
        let refs: Vec<&WorkItem> = items.iter().collect();
        let opts = MngContentOptions {
            include_priority: false,
            include_dates: false,
            ..Default::default()
        };
        let text = project_to_text("Plane Quick Dock", "PQD", None, (&refs, &[], &[]), &opts, today());
        assert_eq!(
            text,
            "[Plane Quick Dock / PQD]\n\n✅ 완료된 일\n  • PQD-142 사이드바 폭 조절 버그 수정\n  • PQD-139 전광판 색상 테마 통일"
        );
    }

    #[test]
    fn project_to_text_omits_header_when_project_name_excluded() {
        let items = vec![item("i1", "작업", 1, "none", Some("2026-08-12T09:00:00Z"))];
        let refs: Vec<&WorkItem> = items.iter().collect();
        let opts = MngContentOptions { include_project_name: false, ..Default::default() };
        let text = project_to_text("아무 프로젝트", "ANY", None, (&refs, &[], &[]), &opts, today());
        assert!(!text.starts_with('['));
        assert!(text.starts_with("✅ 완료된 일"));
    }

    #[test]
    fn project_to_text_appends_client_suffix_when_present() {
        let items = vec![item("i1", "작업", 1, "none", Some("2026-08-12T09:00:00Z"))];
        let refs: Vec<&WorkItem> = items.iter().collect();
        let text = project_to_text(
            "프로젝트",
            "PRJ",
            Some("고객사 A"),
            (&refs, &[], &[]),
            &MngContentOptions::default(),
            today(),
        );
        assert!(text.starts_with("[프로젝트 / PRJ] (고객사 A)"));
    }

    #[test]
    fn project_to_text_skips_empty_groups_and_joins_non_empty_ones_with_blank_line() {
        let completed = vec![item("i1", "완료작업", 1, "none", Some("2026-08-12T09:00:00Z"))];
        let mut in_progress_item = item("i2", "진행작업", 2, "none", None);
        in_progress_item.state_group = "started".into();
        in_progress_item.target_date = Some("2026-08-15".into());
        let in_progress = vec![in_progress_item];
        let c_refs: Vec<&WorkItem> = completed.iter().collect();
        let p_refs: Vec<&WorkItem> = in_progress.iter().collect();
        let text = project_to_text(
            "P",
            "P",
            None,
            (&c_refs, &p_refs, &[]),
            &MngContentOptions::default(),
            today(),
        );
        assert_eq!(
            text,
            "[P / P]\n\n✅ 완료된 일\n  • P-1 완료작업 — 08-12 완료\n\n🔄 진행 중인 일\n  • P-2 진행작업 — D-3 · 08-15 마감"
        );
    }

    #[test]
    fn badge_for_in_progress_marks_overdue_items() {
        let mut it = item("i1", "지연작업", 1, "none", None);
        it.state_group = "started".into();
        it.target_date = Some("2026-08-10".into());
        assert_eq!(badge_for(&it, MngReportGroup::InProgress, today()), Some("2일 지연 · 08-10 마감".into()));
    }

    #[test]
    fn badge_for_upcoming_prefers_future_start_date_over_target_date() {
        let mut it = item("i1", "예정작업", 1, "none", None);
        it.state_group = "unstarted".into();
        it.start_date = Some("2026-08-20".into());
        it.target_date = Some("2026-08-25".into());
        assert_eq!(badge_for(&it, MngReportGroup::Upcoming, today()), Some("08-20 시작 예정".into()));
    }

    #[test]
    fn badge_for_upcoming_falls_back_to_target_date_when_start_date_is_not_future() {
        let mut it = item("i1", "예정작업", 1, "none", None);
        it.state_group = "unstarted".into();
        it.start_date = Some("2026-08-01".into()); // 과거 — 미래 시작일 아님
        it.target_date = Some("2026-08-25".into());
        assert_eq!(badge_for(&it, MngReportGroup::Upcoming, today()), Some("08-25 마감".into()));
    }

    #[test]
    fn classify_groups_buckets_by_state_and_completed_window() {
        let mut items = vec![
            item("a", "완료 오늘", 1, "none", Some("2026-08-12T09:00:00Z")),
            item("b", "완료 어제", 2, "none", Some("2026-08-11T09:00:00Z")), // 오늘 범위 밖 -> 제외
        ];
        let mut started = item("c", "진행중", 3, "none", None);
        started.state_group = "started".into();
        let mut unstarted = item("d", "예정", 4, "none", None);
        unstarted.state_group = "unstarted".into();
        let mut backlog = item("e", "백로그", 5, "none", None);
        backlog.state_group = "backlog".into();
        let mut cancelled = item("f", "취소", 6, "none", None);
        cancelled.state_group = "cancelled".into();
        items.extend([started, unstarted, backlog, cancelled]);

        let (completed, in_progress, upcoming) = classify_groups(&items, "2026-08-12");
        assert_eq!(completed.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(in_progress.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["c"]);
        assert_eq!(upcoming.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["d"]);
    }
}
