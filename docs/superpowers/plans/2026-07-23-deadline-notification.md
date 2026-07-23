# 마감 알림 (하루 1회 다이제스트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 내게 할당된 미완료 작업 중 마감이 지났거나 오늘·며칠 안에 마감인 것을 하루 1회 네이티브 토스트 다이제스트로 알린다.

**Architecture:** 기존 `assign_watch.rs`/`idle.rs`와 같은 3층 구조 — 순수 판정 모듈(`deadline_watch.rs`) + lib.rs watcher 루프(`spawn_deadline_watcher`) + 설정 플래그. 발화 판정(`briefing::should_fire_morning`)과 대상 필터(`briefing::open_assigned_items`)는 기존 범용 함수를 재사용한다.

**Tech Stack:** Rust (Tauri 2, tokio, chrono, tauri-plugin-notification, tauri-plugin-store), TypeScript (프론트엔드 설정 UI).

## Global Constraints

- 스코프는 "나에게 할당된 미완료 항목"(state_group ≠ completed/cancelled). `briefing::open_assigned_items`가 이 필터를 수행하므로 재사용한다.
- `target_date`는 날짜 단위 문자열 `"YYYY-MM-DD"` (시각 없음). 로컬 날짜는 `chrono::Local`.
- 설정 기본값: `deadline_notify_enabled = true`, `deadline_notify_time = "09:00"`, `deadline_lead_days = 3`.
- 새 설정 필드는 반드시 `#[serde(default = "...")]`를 달아 구버전 settings.json이 기본값으로 채워지게 한다.
- Rust 테스트: `cd src-tauri; cargo test`. 프론트엔드 타입체크: `pnpm exec tsc --noEmit`.
- 커밋 메시지는 한국어 conventional 형식. 각 커밋 메시지 끝에 세션 규칙대로 `Co-Authored-By:`/`Claude-Session:` 트레일러를 붙인다.
- 사용자 가시 변경이므로 `CHANGELOG.md`의 `[Unreleased] > ### 추가`에 한 줄 기록(Task 5).

---

### Task 1: `deadline_watch.rs` 순수 로직 모듈

마감 분류·요약·토스트 문구를 만드는 순수 함수. 네트워크/알림 없음 — 전부 단위 테스트로 검증한다.

**Files:**
- Create: `src-tauri/src/deadline_watch.rs`
- Modify: `src-tauri/src/lib.rs:1-9` (모듈 선언 추가)

**Interfaces:**
- Consumes: `crate::briefing::BriefingItem`(필드: `name`, `project_identifier`, `target_date: Option<String>`).
- Produces:
  - `pub enum DueClass { Overdue, Today, Soon, Later, NoDate }`
  - `pub fn classify(target: Option<&str>, today: &str, lead_days: u32) -> DueClass`
  - `pub struct DueEntry { pub project_identifier: String, pub name: String, pub tail: String }`
  - `pub struct Digest { pub overdue: Vec<DueEntry>, pub today: Vec<DueEntry>, pub soon: Vec<DueEntry> }` + `Digest::is_empty(&self) -> bool`, `Digest::total(&self) -> usize`
  - `pub fn summarize(items: &[BriefingItem], today: &str, lead_days: u32) -> Digest`
  - `pub fn digest_body(d: &Digest) -> String`

- [ ] **Step 1: 모듈 선언 추가**

`src-tauri/src/lib.rs` 상단 모듈 목록(1–9줄)에 알파벳 순서에 맞춰 한 줄 추가:

```rust
pub mod assign_watch;
pub mod briefing;
pub mod commands;
pub mod config;
pub mod deadline_watch;
pub mod idle;
pub mod monitors;
pub mod offline;
pub mod openai;
pub mod plane_api;
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src-tauri/src/deadline_watch.rs`를 새로 만들고 아래 전체 내용을 넣는다. (구현 본문은 다음 스텝에서 채우므로 지금은 `todo!()`.)

```rust
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
    todo!()
}

pub fn summarize(items: &[BriefingItem], today: &str, lead_days: u32) -> Digest {
    todo!()
}

pub fn digest_body(d: &Digest) -> String {
    todo!()
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
```

- [ ] **Step 3: 테스트가 실패(패닉)하는지 확인**

Run: `cd src-tauri; cargo test deadline_watch`
Expected: 컴파일은 되나 `todo!()`로 테스트가 패닉하며 FAIL.

- [ ] **Step 4: 구현 채우기**

`classify`, `summarize`, `digest_body`의 `todo!()`를 아래로 교체:

```rust
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri; cargo test deadline_watch`
Expected: 5개 테스트 모두 PASS.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/deadline_watch.rs src-tauri/src/lib.rs
git commit -m "feat: 마감 다이제스트 순수 로직 모듈 추가"
```

---

### Task 2: 설정 필드 + 영속 상태 (config.rs)

마감 알림 설정 3개와 "오늘 이미 떴는지" 기록용 day-string 저장을 추가한다.

**Files:**
- Modify: `src-tauri/src/config.rs` (Settings 구조체, 기본값 함수, Default impl, get/set 헬퍼, 테스트)

**Interfaces:**
- Produces:
  - `Settings.deadline_notify_enabled: bool`, `Settings.deadline_notify_time: String`, `Settings.deadline_lead_days: u32`
  - `pub fn get_deadline_last(app: &tauri::AppHandle) -> Option<String>`
  - `pub fn set_deadline_last(app: &tauri::AppHandle, date: &str) -> Result<(), String>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/config.rs`의 `mod tests` 안에 아래 테스트 3개를 추가:

```rust
    #[test]
    fn settings_default_enables_deadline_notify_at_9_and_3_days() {
        let s = Settings::default();
        assert!(s.deadline_notify_enabled);
        assert_eq!(s.deadline_notify_time, "09:00");
        assert_eq!(s.deadline_lead_days, 3);
    }

    #[test]
    fn settings_without_deadline_fields_gets_defaults() {
        // 이 기능 이전에 저장된 설정 파일 — 기본값으로 채워져야 한다.
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert!(s.deadline_notify_enabled);
        assert_eq!(s.deadline_notify_time, "09:00");
        assert_eq!(s.deadline_lead_days, 3);
    }

    #[test]
    fn deadline_last_round_trips_via_helpers() {
        // get/set이 같은 키를 쓰는지, day-string이 보존되는지 확인.
        // (실제 store 접근은 통합 실행에서, 여기서는 키 상수 일관성만 컴파일로 보장)
        assert_eq!(DEADLINE_LAST_KEY, "deadline_notify_last");
    }
```

또한 기존 `settings_round_trip_preserves_fields` 테스트의 `Settings { ... }` 리터럴에 세 필드를 추가한다 (Step 2에서 필드를 추가하면 이 테스트가 컴파일 실패하므로 함께 고친다):

```rust
            assign_notify_enabled: false,
            assign_remind_hours: 6,
            deadline_notify_enabled: false,
            deadline_notify_time: "08:00".into(),
            deadline_lead_days: 5,
            show_delegated_tab: true,
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri; cargo test settings_ deadline_last`
Expected: FAIL — `deadline_notify_enabled` 등 필드/`DEADLINE_LAST_KEY` 상수가 없어 컴파일 에러.

- [ ] **Step 3: 구현 — Settings 필드 추가**

`src-tauri/src/config.rs`의 `struct Settings`에서 `assign_remind_hours` 필드 바로 다음(즉 `show_delegated_tab` 앞)에 추가:

```rust
    /// 마감 알림 다이제스트 (기본 켬).
    #[serde(default = "default_deadline_notify_enabled")]
    pub deadline_notify_enabled: bool,
    /// 마감 알림 발화 시각 "HH:MM".
    #[serde(default = "default_deadline_notify_time")]
    pub deadline_notify_time: String,
    /// "곧 마감"으로 볼 임박 일수.
    #[serde(default = "default_deadline_lead_days")]
    pub deadline_lead_days: u32,
```

기본값 함수(`default_assign_remind_hours` 아래)에 추가:

```rust
fn default_deadline_notify_enabled() -> bool { true }
fn default_deadline_notify_time() -> String { "09:00".into() }
fn default_deadline_lead_days() -> u32 { 3 }
```

`impl Default for Settings`의 `assign_remind_hours: default_assign_remind_hours(),` 다음(즉 `show_delegated_tab` 앞)에 추가:

```rust
            deadline_notify_enabled: default_deadline_notify_enabled(),
            deadline_notify_time: default_deadline_notify_time(),
            deadline_lead_days: default_deadline_lead_days(),
```

- [ ] **Step 4: 구현 — day-string 저장 헬퍼 추가**

`config.rs`의 `set_morning_last` 함수 정의 바로 다음에 추가:

```rust
const DEADLINE_LAST_KEY: &str = "deadline_notify_last";

pub fn get_deadline_last(app: &tauri::AppHandle) -> Option<String> {
    app.store(STORE_FILE)
        .ok()?
        .get(DEADLINE_LAST_KEY)
        .and_then(|v| v.as_str().map(str::to_owned))
}

pub fn set_deadline_last(app: &tauri::AppHandle, date: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(DEADLINE_LAST_KEY, serde_json::json!(date));
    store.save().map_err(|e| e.to_string())
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri; cargo test`
Expected: config 테스트 전부 PASS (신규 3개 + 기존 라운드트립 포함).

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: 마감 알림 설정 필드와 발화 기록 저장 추가"
```

---

### Task 3: 설정 노출 (SettingsDto + 커맨드)

새 설정 3개를 프론트엔드로 읽고(get_settings) 쓸 수 있게(save_settings) 한다.

**Files:**
- Modify: `src-tauri/src/commands.rs:13-32` (SettingsDto), `:209-231` (get_settings), `:233-296` (save_settings)

**Interfaces:**
- Consumes: Task 2의 `Settings` 필드 3개.
- Produces: `SettingsDto`에 `deadline_notify_enabled: bool`, `deadline_notify_time: String`, `deadline_lead_days: u32`; `save_settings` 커맨드에 `deadline_notify_enabled: Option<bool>`, `deadline_notify_time: Option<String>`, `deadline_lead_days: Option<u32>` 파라미터.

- [ ] **Step 1: SettingsDto에 필드 추가**

`commands.rs`의 `struct SettingsDto`에서 `assign_remind_hours: u32,` 다음(즉 `show_delegated_tab` 앞)에 추가:

```rust
    pub deadline_notify_enabled: bool,
    pub deadline_notify_time: String,
    pub deadline_lead_days: u32,
```

- [ ] **Step 2: get_settings 매핑 추가**

`get_settings`의 반환 리터럴에서 `assign_remind_hours: s.assign_remind_hours,` 다음에 추가:

```rust
        deadline_notify_enabled: s.deadline_notify_enabled,
        deadline_notify_time: s.deadline_notify_time,
        deadline_lead_days: s.deadline_lead_days,
```

- [ ] **Step 3: save_settings 파라미터 + 검증 추가**

`save_settings` 시그니처에서 `assign_remind_hours: Option<u32>,` 다음(즉 `show_delegated_tab` 앞)에 추가:

```rust
    deadline_notify_enabled: Option<bool>,
    deadline_notify_time: Option<String>,
    deadline_lead_days: Option<u32>,
```

본문에서 `if let Some(v) = assign_remind_hours { ... }` 다음에 추가 (시각 검증은 morning_briefing_time과 동일 규칙):

```rust
    if let Some(v) = deadline_notify_enabled { s.deadline_notify_enabled = v; }
    if let Some(v) = deadline_notify_time {
        let ok = v.len() == 5 && v.as_bytes()[2] == b':'
            && v[0..2].parse::<u32>().map_or(false, |h| h < 24)
            && v[3..5].parse::<u32>().map_or(false, |m| m < 60);
        if ok { s.deadline_notify_time = v; }
    }
    if let Some(v) = deadline_lead_days { if v >= 1 { s.deadline_lead_days = v; } }
```

- [ ] **Step 4: 컴파일 확인**

Run: `cd src-tauri; cargo build`
Expected: 성공 (경고 없이 컴파일).

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: 마감 알림 설정을 프론트엔드로 노출"
```

---

### Task 4: 프론트엔드 설정 UI

설정 화면 "자동화" 탭에 마감 알림 토글·시각·임박 일수를 추가하고 저장 경로에 연결한다.

**Files:**
- Modify: `src/shared/types.ts:24-34` (SettingsDto)
- Modify: `src/shared/ipc.ts:5-40` (saveSettings)
- Modify: `src/settings/index.html:56-63` (automation 패널)
- Modify: `src/settings/main.ts` (element 참조, load, save)

**Interfaces:**
- Consumes: Task 3의 SettingsDto 필드·save_settings 파라미터.
- Produces: 없음(최종 소비자).

- [ ] **Step 1: SettingsDto 타입에 필드 추가**

`src/shared/types.ts`의 `interface SettingsDto`에서 `assign_notify_enabled: boolean; assign_remind_hours: number;` 다음에 추가:

```ts
  deadline_notify_enabled: boolean; deadline_notify_time: string; deadline_lead_days: number;
```

- [ ] **Step 2: saveSettings에 인자 추가**

`src/shared/ipc.ts`의 `saveSettings` 함수 — 파라미터 목록에서 `assignRemindHours?: number,` 다음(즉 `showDelegatedTab` 앞)에 추가:

```ts
  deadlineNotifyEnabled?: boolean,
  deadlineNotifyTime?: string,
  deadlineLeadDays?: number,
```

그리고 `invoke<void>("save_settings", { ... })` 객체에서 `assignRemindHours,` 다음에 추가:

```ts
    deadlineNotifyEnabled,
    deadlineNotifyTime,
    deadlineLeadDays,
```

- [ ] **Step 3: HTML에 입력 요소 추가**

`src/settings/index.html`의 automation 패널에서 "할당 알림" 블록(60–62줄) 다음, `</section>`(63줄) 앞에 추가:

```html
        <h2>마감 알림</h2>
        <label class="check-row"><input id="deadlineNotifyEnabled" type="checkbox" />마감이 임박·경과한 작업을 하루 한 번 알림</label>
        <label>마감 알림 시각<input id="deadlineNotifyTime" type="time" /></label>
        <label>임박 기준 일수<input id="deadlineLeadDays" type="number" min="1" /></label>
```

- [ ] **Step 4: main.ts에 element 참조 추가**

`src/settings/main.ts`에서 `assignRemindHours` 참조(109줄) 다음에 추가:

```ts
const deadlineNotifyEnabled = document.getElementById("deadlineNotifyEnabled") as HTMLInputElement;
const deadlineNotifyTime = document.getElementById("deadlineNotifyTime") as HTMLInputElement;
const deadlineLeadDays = document.getElementById("deadlineLeadDays") as HTMLInputElement;
```

- [ ] **Step 5: load()에 값 채우기 추가**

`load()` 함수에서 `assignRemindHours.value = String(s.assign_remind_hours);` 다음에 추가:

```ts
  deadlineNotifyEnabled.checked = s.deadline_notify_enabled;
  deadlineNotifyTime.value = s.deadline_notify_time;
  deadlineLeadDays.value = String(s.deadline_lead_days);
```

- [ ] **Step 6: save 핸들러에 인자 전달 추가**

`saveSettings(...)` 호출에서 `Math.max(1, Math.floor(Number(assignRemindHours.value) || 2)),` 다음(즉 `showDelegatedTab.checked` 앞)에 추가:

```ts
      deadlineNotifyEnabled.checked,
      deadlineNotifyTime.value || undefined,
      Math.max(1, Math.floor(Number(deadlineLeadDays.value) || 3)),
```

- [ ] **Step 7: 타입체크 통과 확인**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 8: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/settings/index.html src/settings/main.ts
git commit -m "feat: 설정 화면에 마감 알림 옵션 추가"
```

---

### Task 5: watcher 루프 통합 + CHANGELOG

매분 시각을 확인해 발화 조건이면 서버에서 내 작업을 받아 마감 다이제스트 토스트를 띄운다. 이 태스크로 기능이 사용자에게 실제로 동작한다.

**Files:**
- Modify: `src-tauri/src/lib.rs` (poll 상수, `spawn_deadline_watcher`, `deadline_tick`, setup 등록)
- Modify: `CHANGELOG.md` (`[Unreleased] > ### 추가`)

**Interfaces:**
- Consumes: `deadline_watch::{summarize, digest_body}`(Task 1), `config::{get_deadline_last, set_deadline_last}`·`Settings` 필드(Task 2), `briefing::{parse_hhmm, should_fire_morning, open_assigned_items}`(기존), `plane_api::PlaneClient`(기존).
- Produces: 없음(최종 통합).

- [ ] **Step 1: poll 상수 + watcher 루프 + tick 추가**

`src-tauri/src/lib.rs`에서 `spawn_morning_briefing_watcher` 함수 정의 다음(즉 `ASSIGN_POLL_INTERVAL` 선언 앞)에 아래를 추가:

```rust
/// 마감 다이제스트 발화 시각 판정 주기. 브리핑 워처와 같은 매분 폴링.
const DEADLINE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// 매분 로컬 시각을 확인해, 마감 알림이 켜져 있고 지정 시각이 지났으며 오늘
/// 아직 안 띄웠다면 마감 다이제스트를 평가해 토스트를 띄운다. 발화 판정은
/// 아침 브리핑과 같은 `should_fire_morning`을 재사용한다.
fn spawn_deadline_watcher(app: tauri::AppHandle) {
    use chrono::Timelike;
    tauri::async_runtime::spawn(async move {
        loop {
            let s = config::load_settings(&app);
            if s.deadline_notify_enabled {
                if let Some(cfg_min) = briefing::parse_hhmm(&s.deadline_notify_time) {
                    let now = chrono::Local::now();
                    let today = now.format("%Y-%m-%d").to_string();
                    let now_min = now.hour() * 60 + now.minute();
                    let last = config::get_deadline_last(&app);
                    if briefing::should_fire_morning(now_min, cfg_min, &today, last.as_deref()) {
                        match deadline_tick(&app, &s, &today).await {
                            // 평가 성공 시에만 오늘 발화한 것으로 기록한다.
                            Ok(true) => { let _ = config::set_deadline_last(&app, &today); }
                            // 미설정(토큰/URL 없음)은 기록하지 않는다.
                            Ok(false) => {}
                            // 오프라인/일시 오류는 기록하지 않아 다음 tick에 재시도한다.
                            Err(e) => eprintln!("deadline watch tick failed: {e}"),
                        }
                    }
                }
            }
            tokio::time::sleep(DEADLINE_POLL_INTERVAL).await;
        }
    });
}

/// 내 미완료 작업의 마감을 평가해 다이제스트 토스트를 띄운다. 대상이 하나도
/// 없으면 토스트 없이 조용히 넘어간다. 반환값: 평가에 성공하면 Ok(true),
/// 미설정으로 건너뛰면 Ok(false), 네트워크/조회 오류면 Err.
async fn deadline_tick(app: &tauri::AppHandle, s: &config::Settings, today: &str) -> Result<bool, String> {
    if s.base_url.is_empty() || s.workspace.is_empty() {
        return Ok(false);
    }
    let Some(token) = config::get_token() else { return Ok(false) };
    let client = plane_api::PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token);
    let me = client.current_user_cached().await?.id;

    // 프로젝트별 work items 조회 (assign_tick과 같은 N+1). 하나라도 실패하면
    // 부분 목록으로 잘못된 다이제스트를 내지 않도록 tick 전체를 중단한다.
    let projects = client.list_projects().await?;
    let mut items: Vec<plane_api::WorkItem> = Vec::new();
    for p in &projects {
        items.extend(client.list_work_items(&p.id).await?);
    }

    // "나에게 할당된 미완료 + project identifier 부여" 필터를 재사용.
    let open = briefing::open_assigned_items(&me, &projects, items);
    let digest = deadline_watch::summarize(&open, today, s.deadline_lead_days);
    if !digest.is_empty() {
        let _ = app
            .notification()
            .builder()
            .title("마감 임박 작업")
            .body(deadline_watch::digest_body(&digest))
            .show();
    }
    Ok(true)
}
```

- [ ] **Step 2: setup에서 watcher 기동**

`lib.rs`의 `.setup(...)` 안, `spawn_morning_briefing_watcher(app.handle().clone());` 다음 줄에 추가:

```rust
            spawn_deadline_watcher(app.handle().clone());
```

- [ ] **Step 3: 컴파일 + 전체 테스트 확인**

Run: `cd src-tauri; cargo build; cargo test`
Expected: 컴파일 성공, 기존·신규 테스트 전부 PASS.

- [ ] **Step 4: CHANGELOG 기록**

`CHANGELOG.md`의 `## [Unreleased]` 섹션에 `### 추가`를 만들고(없으면) 한 줄 추가:

```markdown
## [Unreleased]

### 추가

- 마감이 지났거나 오늘·며칠 안에 마감인 내 작업을 아침에 한 번 알림으로 정리해줍니다.
```

- [ ] **Step 5: 수동 확인 (선택, 통합 동작)**

`pnpm tauri dev`로 실행 → 설정 "자동화" 탭에서 마감 알림 시각을 현재 시각 1분 뒤로 맞추고 저장 → 해당 분에 마감 임박/경과 작업이 있으면 토스트가 뜨는지, 없으면 안 뜨는지 확인. (자동 테스트로 커버되지 않는 네트워크·알림 통합 경로.)

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/lib.rs CHANGELOG.md
git commit -m "feat: 마감 임박 작업 하루 1회 알림 다이제스트"
```

---

## Self-Review

**1. Spec coverage:**
- 아키텍처(순수 모듈+워처+설정) → Task 1·2·5 ✓
- 데이터 흐름(발화 판정→fetch→필터→요약→토스트→기록) → Task 5 `deadline_tick`/`spawn_deadline_watcher` ✓
- 분류 로직(Overdue/Today/Soon/Later/NoDate, lead_days 경계) → Task 1 `classify` + 테스트 ✓
- 토스트 내용(카운트 요약, 상위 3건, …외 N건, 버킷별 꼬리표) → Task 1 `digest_body` + 테스트 ✓
- 설정 3개 + 기본값 + 레거시 채움 → Task 2·3·4 ✓
- 영속 상태(deadline_notify_last) → Task 2 ✓
- 설정 UI → Task 4 ✓
- 안전성(늦게 켬=should_fire_morning 재사용, 오프라인=미기록 재시도, 미설정=skip) → Task 5 ✓
- 테스트(classify 경계·summarize 버킷·digest_body·config 기본/레거시) → Task 1·2 ✓
- CHANGELOG → Task 5 ✓
- 범위 밖(클릭 동작·overdue 별도 재알림·하이브리드) → 계획에 미포함(의도적) ✓

**2. Placeholder scan:** 모든 코드 스텝에 실제 코드·정확한 파일 경로·명령·기대 출력 포함. `todo!()`는 Task 1의 TDD 실패 단계용으로 의도적이며 Step 4에서 실제 구현으로 교체됨. ✓

**3. Type consistency:** `classify`/`summarize`/`digest_body`/`Digest`/`DueEntry` 시그니처가 Task 1 정의와 Task 5 사용처에서 일치. `deadline_notify_enabled`/`deadline_notify_time`/`deadline_lead_days` 이름이 config·commands·types·ipc·main.ts·lib.rs 전반에서 동일. `get/set_deadline_last`·`DEADLINE_LAST_KEY` 일치. `briefing::open_assigned_items(&me, &projects, items)` 인자 순서가 기존 시그니처(`user_id, projects, items`)와 일치. ✓
