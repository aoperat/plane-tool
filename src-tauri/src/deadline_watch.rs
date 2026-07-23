//! 마감 다이제스트: 마감 분류·요약·토스트 문구 (순수 로직).
//!
//! 네트워크/알림/트레이는 lib.rs의 watcher 루프가 담당하고, 이 모듈은 순수
//! 판정 로직만 둔다 (assign_watch.rs·idle.rs와 같은 구조).

use crate::briefing::BriefingItem;
use chrono::{Datelike, NaiveDate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueClass {
    Overdue,
    Today,
    Soon,
    Later,
    NoDate,
}

pub struct DueEntry {
    pub project_identifier: String,
    pub name: String,
    /// 표시용 꼬리표: "오늘" | "지남 N일" | "M/D".
    pub tail: String,
}

#[derive(Default)]
pub struct Digest {
    pub overdue: Vec<DueEntry>,
    pub today: Vec<DueEntry>,
    pub soon: Vec<DueEntry>,
}

impl Digest {
    pub fn is_empty(&self) -> bool {
        self.overdue.is_empty() && self.today.is_empty() && self.soon.is_empty()
    }
    pub fn total(&self) -> usize {
        self.overdue.len() + self.today.len() + self.soon.len()
    }
}

fn parse(d: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
}

/// "2026-07-05" -> "7/5" (파싱 실패 시 원문 그대로).
fn md(date: &str) -> String {
    match parse(date) {
        Some(d) => format!("{}/{}", d.month(), d.day()),
        None => date.to_string(),
    }
}

pub fn classify(target: Option<&str>, today: &str, lead_days: u32) -> DueClass {
    let (Some(t), Some(now)) = (target.and_then(parse), parse(today)) else {
        return DueClass::NoDate;
    };
    if t < now {
        DueClass::Overdue
    } else if t == now {
        DueClass::Today
    } else if (t - now).num_days() <= i64::from(lead_days) {
        DueClass::Soon
    } else {
        DueClass::Later
    }
}

pub fn summarize(items: &[BriefingItem], today: &str, lead_days: u32) -> Digest {
    // 마감일 오름차순 — overdue는 가장 지난 것부터, soon은 가장 임박한 것부터.
    let mut sorted: Vec<&BriefingItem> = items.iter().collect();
    sorted.sort_by(|a, b| a.target_date.cmp(&b.target_date));

    let mut d = Digest::default();
    for it in sorted {
        let ident = it.project_identifier.clone();
        let name = it.name.clone();
        match classify(it.target_date.as_deref(), today, lead_days) {
            DueClass::Overdue => {
                let days = it
                    .target_date
                    .as_deref()
                    .and_then(parse)
                    .zip(parse(today))
                    .map(|(t, now)| (now - t).num_days())
                    .unwrap_or(0);
                d.overdue.push(DueEntry { project_identifier: ident, name, tail: format!("지남 {days}일") });
            }
            DueClass::Today => {
                d.today.push(DueEntry { project_identifier: ident, name, tail: "오늘".into() });
            }
            DueClass::Soon => {
                let tail = it.target_date.as_deref().map(md).unwrap_or_default();
                d.soon.push(DueEntry { project_identifier: ident, name, tail });
            }
            DueClass::Later | DueClass::NoDate => {}
        }
    }
    d
}

pub fn digest_body(d: &Digest) -> String {
    let mut segs = Vec::new();
    if !d.overdue.is_empty() { segs.push(format!("지남 {}", d.overdue.len())); }
    if !d.today.is_empty() { segs.push(format!("오늘 {}", d.today.len())); }
    if !d.soon.is_empty() { segs.push(format!("곧 {}", d.soon.len())); }

    let mut lines = vec![segs.join(" · ")];
    for e in d.overdue.iter().chain(&d.today).chain(&d.soon).take(3) {
        let head = if e.project_identifier.is_empty() {
            String::new()
        } else {
            format!("[{}] ", e.project_identifier)
        };
        lines.push(format!("• {head}{} — {}", e.name, e.tail));
    }
    let total = d.total();
    if total > 3 {
        lines.push(format!("…외 {}건", total - 3));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::briefing::BriefingItem;

    const TODAY: &str = "2026-07-03";

    fn bi(name: &str, ident: &str, target: Option<&str>) -> BriefingItem {
        BriefingItem {
            id: name.into(),
            name: name.into(),
            project_id: "p1".into(),
            project_identifier: ident.into(),
            priority: "none".into(),
            start_date: None,
            target_date: target.map(str::to_string),
            state_group: "unstarted".into(),
        }
    }

    #[test]
    fn classify_covers_each_boundary() {
        assert_eq!(classify(Some("2026-07-01"), TODAY, 3), DueClass::Overdue); // 지남
        assert_eq!(classify(Some("2026-07-03"), TODAY, 3), DueClass::Today);   // 오늘
        assert_eq!(classify(Some("2026-07-04"), TODAY, 3), DueClass::Soon);    // 내일
        assert_eq!(classify(Some("2026-07-06"), TODAY, 3), DueClass::Soon);    // 정확히 lead_days째
        assert_eq!(classify(Some("2026-07-07"), TODAY, 3), DueClass::Later);   // lead_days+1
        assert_eq!(classify(None, TODAY, 3), DueClass::NoDate);                // 마감 없음
        assert_eq!(classify(Some("garbage"), TODAY, 3), DueClass::NoDate);     // 파싱 실패
    }

    #[test]
    fn summarize_buckets_and_orders_by_date() {
        let items = vec![
            bi("곧2", "WEB", Some("2026-07-05")),
            bi("지남더", "API", Some("2026-07-01")),
            bi("오늘", "WEB", Some("2026-07-03")),
            bi("지남덜", "API", Some("2026-07-02")),
            bi("곧1", "WEB", Some("2026-07-04")),
            bi("먼미래", "WEB", Some("2026-07-30")), // Later: 제외
            bi("무마감", "WEB", None),               // NoDate: 제외
        ];
        let d = summarize(&items, TODAY, 3);
        // overdue는 가장 지난 것부터 (날짜 오름차순)
        let overdue: Vec<_> = d.overdue.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(overdue, vec!["지남더", "지남덜"]);
        assert_eq!(d.overdue[0].tail, "지남 2일");
        assert_eq!(d.overdue[1].tail, "지남 1일");
        let today: Vec<_> = d.today.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(today, vec!["오늘"]);
        assert_eq!(d.today[0].tail, "오늘");
        let soon: Vec<_> = d.soon.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(soon, vec!["곧1", "곧2"]); // 날짜 오름차순
        assert_eq!(d.soon[0].tail, "7/4");
        assert_eq!(d.total(), 5);
        assert!(!d.is_empty());
    }

    #[test]
    fn summarize_empty_when_nothing_qualifies() {
        let items = vec![bi("먼미래", "WEB", Some("2026-07-30")), bi("무마감", "WEB", None)];
        let d = summarize(&items, TODAY, 3);
        assert!(d.is_empty());
        assert_eq!(d.total(), 0);
    }

    #[test]
    fn digest_body_shows_counts_top_three_and_overflow() {
        let items = vec![
            bi("지남더", "API", Some("2026-07-01")),
            bi("지남덜", "API", Some("2026-07-02")),
            bi("오늘1", "WEB", Some("2026-07-03")),
            bi("오늘2", "WEB", Some("2026-07-03")),
            bi("곧1", "WEB", Some("2026-07-04")),
        ];
        let body = digest_body(&summarize(&items, TODAY, 3));
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines[0], "지남 2 · 오늘 2 · 곧 1"); // 카운트 요약
        assert_eq!(lines[1], "• [API] 지남더 — 지남 2일");
        assert_eq!(lines[2], "• [API] 지남덜 — 지남 1일");
        assert_eq!(lines[3], "• [WEB] 오늘1 — 오늘");
        assert_eq!(lines[4], "…외 2건"); // 5건 중 상위 3건 표시, 나머지 2건
    }

    #[test]
    fn digest_body_omits_empty_buckets_and_overflow_line() {
        let items = vec![bi("오늘", "WEB", Some("2026-07-03"))];
        let body = digest_body(&summarize(&items, TODAY, 3));
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines[0], "오늘 1"); // 지남·곧 0건은 요약에서 생략
        assert_eq!(lines[1], "• [WEB] 오늘 — 오늘");
        assert_eq!(lines.len(), 2); // "…외" 줄 없음
    }
}
