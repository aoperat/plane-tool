# AI 브리핑 기능 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 남은 작업(완료·취소 제외)을 OpenAI로 분석해 "오늘의 플랜"(추천 처리 순서 + 이유)을 보여주는 독립 브리핑 창을 추가한다.

**Architecture:** 데이터 수집·폴백 정렬·응답 검증은 Rust(`briefing.rs`)의 순수 함수로 두고, OpenAI 호출은 `openai.rs`의 얇은 클라이언트로 분리한다. 프론트는 `generate_briefing` 커맨드 하나로 완성된 `Briefing` DTO를 받아 렌더링만 한다. AI 응답은 작업 id 매칭으로 검증되어 가짜 작업이 표시될 수 없다.

**Tech Stack:** Tauri 2 (Rust: reqwest/serde/chrono/keyring, wiremock 테스트), Vanilla TS + Vite 멀티페이지, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-ai-briefing-design.md`

## Global Constraints

- UI 문구·AI 요약은 모두 한국어.
- OpenAI에는 작업의 **id, 제목, 프로젝트명, 우선순위, 시작일, 마감일, 상태 그룹**만 전송 — 설명(description)은 절대 보내지 않는다.
- 완료(`completed`)·취소(`cancelled`) 작업은 브리핑 어디에도 나타나지 않는다.
- 비밀값(OpenAI API 키)은 키링에만 저장 (service `plane-quick-dock`).
- `Settings` 새 필드는 전부 `#[serde(default = ...)]`로 하위 호환.
- 플랜 최대 5개 (`MAX_PLAN`).
- 기존 코드 스타일 준수: 한국어/영어 혼용 주석 OK, 커맨드는 `Result<_, String>`.
- 마지막 태스크에서 CHANGELOG `[Unreleased]`에 사용자 가시 변경 1줄 기록 (프로젝트 CLAUDE.md 규칙).
- 테스트 실행: `cargo test --manifest-path src-tauri/Cargo.toml`, 프론트 `pnpm test`, 빌드 `pnpm build`.

---

### Task 1: Settings 확장 + OpenAI 키링

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/commands.rs` (SettingsDto, get_settings, save_settings)
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`

**Interfaces:**
- Produces: `Settings.briefing_model: String` (기본 `"gpt-4o-mini"`), `Settings.morning_briefing_enabled: bool` (기본 false), `Settings.morning_briefing_time: String` (기본 `"09:00"`), `config::get_openai_key() -> Option<String>`, `config::set_openai_key(&str) -> Result<(), String>`, `SettingsDto.has_openai_key: bool` + 위 3개 필드, `save_settings`에 `openai_key/briefing_model/morning_briefing_enabled/morning_briefing_time` 옵션 파라미터.

- [ ] **Step 1: 실패하는 테스트 작성** — `src-tauri/src/config.rs`의 `mod tests`에 추가:

```rust
#[test]
fn settings_without_briefing_fields_gets_defaults() {
    // 이 기능 이전에 저장된 설정 파일 — 기본값으로 채워져야 한다.
    let old_json = r#"{
        "base_url": "https://plane.example.com",
        "workspace": "acme",
        "last_project_id": null
    }"#;
    let s: Settings = serde_json::from_str(old_json).unwrap();
    assert_eq!(s.briefing_model, "gpt-4o-mini");
    assert!(!s.morning_briefing_enabled);
    assert_eq!(s.morning_briefing_time, "09:00");
}
```

기존 `settings_round_trip_preserves_fields` 테스트의 `Settings { ... }` 리터럴에도 새 필드 3개를 추가한다 (`briefing_model: "gpt-4o".into(), morning_briefing_enabled: true, morning_briefing_time: "08:30".into()`).

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings_without_briefing`
Expected: COMPILE FAIL (`briefing_model` 필드 없음)

- [ ] **Step 3: 구현** — `config.rs`:

```rust
// 상수 추가 (KEYRING_ACCOUNT 아래)
const KEYRING_OPENAI_ACCOUNT: &str = "openai-api-key";
```

`Settings` 구조체에 필드 추가 (idle 필드 아래):

```rust
    /// AI 브리핑에 쓰는 OpenAI 모델명.
    #[serde(default = "default_briefing_model")]
    pub briefing_model: String,
    /// 아침 브리핑 자동 표시 (기본 끔).
    #[serde(default)]
    pub morning_briefing_enabled: bool,
    /// 아침 브리핑 시각 "HH:MM".
    #[serde(default = "default_morning_briefing_time")]
    pub morning_briefing_time: String,
```

```rust
fn default_briefing_model() -> String { "gpt-4o-mini".into() }
fn default_morning_briefing_time() -> String { "09:00".into() }
```

`impl Default for Settings`에 세 필드 추가:

```rust
            briefing_model: default_briefing_model(),
            morning_briefing_enabled: false,
            morning_briefing_time: default_morning_briefing_time(),
```

키링 함수 추가 (`set_token` 아래):

```rust
pub fn get_openai_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_OPENAI_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn set_openai_key(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_OPENAI_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}
```

`commands.rs` — `SettingsDto`에 필드 추가:

```rust
    pub has_openai_key: bool,
    pub briefing_model: String,
    pub morning_briefing_enabled: bool,
    pub morning_briefing_time: String,
```

`get_settings`에서 채우기:

```rust
        has_openai_key: config::get_openai_key().is_some(),
        briefing_model: s.briefing_model,
        morning_briefing_enabled: s.morning_briefing_enabled,
        morning_briefing_time: s.morning_briefing_time,
```

`save_settings` 시그니처에 파라미터 추가 (`idle_open_minutes: Option<u32>` 뒤):

```rust
    openai_key: Option<String>,
    briefing_model: Option<String>,
    morning_briefing_enabled: Option<bool>,
    morning_briefing_time: Option<String>,
```

본문(`config::save_settings(&app, &s)?;` 앞)에:

```rust
    if let Some(v) = briefing_model { if !v.trim().is_empty() { s.briefing_model = v.trim().to_string(); } }
    if let Some(v) = morning_briefing_enabled { s.morning_briefing_enabled = v; }
    if let Some(v) = morning_briefing_time {
        // "HH:MM"만 허용 — 형식이 다르면 조용히 무시해 기존 값을 지킨다.
        let ok = v.len() == 5 && v.as_bytes()[2] == b':'
            && v[0..2].parse::<u32>().map_or(false, |h| h < 24)
            && v[3..5].parse::<u32>().map_or(false, |m| m < 60);
        if ok { s.morning_briefing_time = v; }
    }
```

token 저장 블록 아래에 OpenAI 키 저장 추가:

```rust
    if let Some(k) = openai_key {
        if !k.is_empty() {
            config::set_openai_key(&k)?;
        }
    }
```

`src/shared/types.ts` — `SettingsDto`에 추가:

```ts
  has_openai_key: boolean; briefing_model: string;
  morning_briefing_enabled: boolean; morning_briefing_time: string;
```

`src/shared/ipc.ts` — `saveSettings`에 파라미터/전달 추가:

```ts
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
  displayIndex?: number,
  idleOpenEnabled?: boolean,
  idleOpenMinutes?: number,
  openaiKey?: string,
  briefingModel?: string,
  morningBriefingEnabled?: boolean,
  morningBriefingTime?: string,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
    displayIndex,
    idleOpenEnabled,
    idleOpenMinutes,
    openaiKey,
    briefingModel,
    morningBriefingEnabled,
    morningBriefingTime,
  });
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm build`
Expected: 전체 PASS + 빌드 성공

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs src/shared/types.ts src/shared/ipc.ts
git commit -m "feat(briefing): add OpenAI key storage and briefing settings fields"
```

---

### Task 2: briefing.rs — 데이터 모델 + 폴백 로직

**Files:**
- Modify: `src-tauri/Cargo.toml` (chrono 추가)
- Create: `src-tauri/src/briefing.rs`
- Modify: `src-tauri/src/lib.rs` (모듈 등록 1줄)

**Interfaces:**
- Consumes: `plane_api::{Project, WorkItem}`
- Produces:
  - `pub struct BriefingItem { id, name, project_id, project_identifier, priority, start_date, target_date, state_group }` (모두 String / Option<String>, `Serialize+Deserialize+Clone+Debug+PartialEq`)
  - `pub struct PlanEntry { pub item: BriefingItem, pub reason: String }`
  - `pub struct Briefing { pub date: String, pub generated_at: String, pub model: String, pub source: String, pub error: Option<String>, pub summary: String, pub plan: Vec<PlanEntry>, pub rest: Vec<BriefingItem> }` (모두 `Serialize+Deserialize+Clone+Debug`)
  - `pub const MAX_PLAN: usize = 5;`
  - `pub fn open_assigned_items(user_id: &str, projects: &[Project], items: Vec<WorkItem>) -> Vec<BriefingItem>`
  - `pub fn reason_for(item: &BriefingItem, today: &str) -> String`
  - `pub fn fallback_plan(items: Vec<BriefingItem>, today: &str) -> (Vec<PlanEntry>, Vec<BriefingItem>)`
  - `pub fn fallback_summary(items: &[BriefingItem], today: &str) -> String`
  - `pub fn parse_hhmm(s: &str) -> Option<u32>` (분 단위)

- [ ] **Step 1: 의존성 추가** — `src-tauri/Cargo.toml` `[dependencies]`에:

```toml
chrono = { version = "0.4", default-features = false, features = ["clock"] }
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src-tauri/src/briefing.rs` 새 파일, 테스트 먼저 (파일 하단 `mod tests`):

```rust
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
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml briefing`
Expected: COMPILE FAIL (모듈 없음 — `lib.rs`에 `pub mod briefing;` 추가 후에도 함수 미정의로 실패)

- [ ] **Step 4: 구현** — `src-tauri/src/briefing.rs` 상단:

```rust
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
```

`src-tauri/src/lib.rs` 모듈 목록에 추가:

```rust
pub mod briefing;
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml briefing`
Expected: 위 테스트 전부 PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/briefing.rs src-tauri/src/lib.rs
git commit -m "feat(briefing): add briefing data model and rule-based fallback logic"
```

---

### Task 3: openai.rs — OpenAI Chat Completions 클라이언트

**Files:**
- Create: `src-tauri/src/openai.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod openai;` 추가)

**Interfaces:**
- Produces: `OpenAiClient::new(api_key: String)`, `OpenAiClient::with_base_url(base_url: String, api_key: String)` (테스트용), `pub async fn chat_json(&self, model: &str, system: &str, user: &str) -> Result<String, String>` — 응답 `choices[0].message.content` 문자열 반환.

- [ ] **Step 1: 실패하는 테스트 작성** — `src-tauri/src/openai.rs` (테스트 포함 골격):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn chat_json_sends_messages_and_returns_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("Authorization", "Bearer sk-test"))
            .and(body_partial_json(serde_json::json!({
                "model": "gpt-4o-mini",
                "response_format": { "type": "json_object" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "{\"summary\":\"ok\"}" } }]
            })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-test".into());
        let out = c.chat_json("gpt-4o-mini", "시스템", "유저").await.unwrap();
        assert_eq!(out, "{\"summary\":\"ok\"}");
    }

    #[tokio::test]
    async fn chat_json_surfaces_http_error_with_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "Incorrect API key provided" }
            })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-bad".into());
        let err = c.chat_json("gpt-4o-mini", "s", "u").await.unwrap_err();
        assert!(err.contains("401"), "got: {err}");
        assert!(err.contains("Incorrect API key"), "got: {err}");
    }

    #[tokio::test]
    async fn chat_json_errors_when_choices_missing() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "choices": [] })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-test".into());
        assert!(c.chat_json("gpt-4o-mini", "s", "u").await.is_err());
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml openai`
Expected: COMPILE FAIL (`OpenAiClient` 미정의)

- [ ] **Step 3: 구현** — 같은 파일 상단:

```rust
use serde::Deserialize;

/// OpenAI Chat Completions 최소 클라이언트. 브리핑 한 번에 호출 한 번이라
/// 재시도 없이 30초 타임아웃만 둔다 — 실패하면 호출자가 규칙 기반으로 폴백한다.
pub struct OpenAiClient {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct ChatMessage { content: String }
#[derive(Deserialize)]
struct ChatChoice { message: ChatMessage }
#[derive(Deserialize)]
struct ChatResponse { choices: Vec<ChatChoice> }

impl OpenAiClient {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url("https://api.openai.com".into(), api_key)
    }

    pub fn with_base_url(base_url: String, api_key: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { base_url: base_url.trim_end_matches('/').to_string(), api_key, http }
    }

    /// system/user 메시지로 JSON 모드 응답을 요청하고 본문 문자열을 돌려준다.
    pub async fn chat_json(&self, model: &str, system: &str, user: &str) -> Result<String, String> {
        let url = format!("{}/v1/chat/completions", self.base_url);
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ],
            "response_format": { "type": "json_object" }
        });
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("OpenAI HTTP {status}: {snippet}"));
        }
        let parsed: ChatResponse = resp.json().await.map_err(|e| format!("OpenAI 응답 파싱 실패: {e}"))?;
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| "OpenAI 응답에 choices가 비어 있음".into())
    }
}
```

`lib.rs` 모듈 목록에 `pub mod openai;` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml openai`
Expected: 3개 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/openai.rs src-tauri/src/lib.rs
git commit -m "feat(briefing): add minimal OpenAI chat completions client"
```

---

### Task 4: briefing.rs — 프롬프트 생성 + AI 응답 검증

**Files:**
- Modify: `src-tauri/src/briefing.rs`

**Interfaces:**
- Consumes: Task 2의 `BriefingItem`, `PlanEntry`, `MAX_PLAN`, `reason_for`, `sort_rest`
- Produces:
  - `pub fn build_prompt(items: &[BriefingItem], today: &str) -> (String, String)` — (system, user)
  - `pub fn apply_ai_response(content: &str, items: Vec<BriefingItem>, today: &str) -> Result<(String, Vec<PlanEntry>, Vec<BriefingItem>), String>` — (summary, plan, rest)

- [ ] **Step 1: 실패하는 테스트 작성** — `mod tests`에 추가:

```rust
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
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml briefing`
Expected: COMPILE FAIL (`build_prompt` 미정의)

- [ ] **Step 3: 구현** — `briefing.rs`에 추가:

```rust
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml briefing`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/briefing.rs
git commit -m "feat(briefing): add prompt builder and AI response validation"
```

---

### Task 5: generate_briefing / open_briefing 커맨드 + 캐시

**Files:**
- Modify: `src-tauri/src/config.rs` (캐시 저장/로드)
- Modify: `src-tauri/src/commands.rs` (커맨드 2개)
- Modify: `src-tauri/src/lib.rs` (`show_centered` 리팩터 + 커맨드 등록)

**Interfaces:**
- Consumes: `briefing::{Briefing, open_assigned_items, fallback_plan, fallback_summary, build_prompt, apply_ai_response}`, `openai::OpenAiClient`, `config::get_openai_key`
- Produces: `config::load_cached_briefing(app) -> Option<Briefing>`, `config::save_cached_briefing(app, &Briefing) -> Result<(), String>`, tauri 커맨드 `generate_briefing(force: bool) -> Result<Briefing, String>`, `open_briefing()`, `lib.rs`의 `pub(crate) fn show_centered(app, label)` (기존 `show_quickadd`는 `show_centered(app, "quickadd")` 위임)

- [ ] **Step 1: 실패하는 테스트 작성** — `briefing.rs` `mod tests`에 (캐시는 serde 왕복이 계약):

```rust
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
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml briefing_serde`
Expected: PASS 가능 (Task 2에서 derive 완료) — PASS라면 그대로 진행 (계약 고정용 테스트).

- [ ] **Step 3: 구현** — `config.rs`에 추가:

```rust
const BRIEFING_CACHE_KEY: &str = "briefing_cache";

/// 마지막 브리핑 캐시. 같은 날 다시 열면 API를 다시 부르지 않기 위한 것 —
/// 파싱 실패(구버전 포맷 등)는 캐시 없음으로 취급한다.
pub fn load_cached_briefing(app: &tauri::AppHandle) -> Option<crate::briefing::Briefing> {
    app.store(STORE_FILE)
        .ok()?
        .get(BRIEFING_CACHE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
}

pub fn save_cached_briefing(app: &tauri::AppHandle, b: &crate::briefing::Briefing) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(BRIEFING_CACHE_KEY, serde_json::to_value(b).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}
```

`lib.rs` — `show_quickadd`를 일반화 (기존 함수 본문을 그대로 옮기고 label만 파라미터화):

```rust
/// `label` 창을 설정된 디스플레이 중앙에 배치하고 표시한다.
pub(crate) fn show_centered(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        if let (Ok(mons), Ok(size)) = (win.available_monitors(), win.outer_size()) {
            let positions: Vec<(i32, i32)> = mons.iter().map(|m| (m.position().x, m.position().y)).collect();
            let sorted = monitors::sorted_indices_by_position(&positions);
            let display_index = config::load_settings(app).display_index;
            if let Some(i) = monitors::pick_index(&sorted, display_index) {
                let m = &mons[i];
                let (x, y) = monitors::centered_position(
                    (size.width as i32, size.height as i32),
                    (m.position().x, m.position().y),
                    (m.size().width as i32, m.size().height as i32),
                );
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub(crate) fn show_quickadd(app: &tauri::AppHandle) {
    show_centered(app, "quickadd");
}
```

`commands.rs`에 커맨드 추가 (파일 끝, tests 위):

```rust
/// AI 브리핑 생성. 같은 날짜의 캐시가 있으면 (force가 아닌 한) 그대로 반환.
/// OpenAI 실패는 규칙 기반 폴백으로 흡수 — 이 커맨드는 Plane 연결 문제
/// (not_configured, API 오류)에서만 Err을 낸다.
#[tauri::command]
pub async fn generate_briefing(app: tauri::AppHandle, force: bool) -> Result<crate::briefing::Briefing, String> {
    use crate::briefing;
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    if !force {
        if let Some(cached) = config::load_cached_briefing(&app) {
            if cached.date == today {
                return Ok(cached);
            }
        }
    }
    let (client, s) = client(&app)?;
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // 프로젝트 하나가 실패해도 나머지로 브리핑한다
        }
    }
    let items = briefing::open_assigned_items(&user.id, &projects, all_items);
    let fb_summary = briefing::fallback_summary(&items, &today);
    let model = s.briefing_model.clone();
    let (source, summary, plan, rest, error) = match config::get_openai_key() {
        None => {
            let (plan, rest) = briefing::fallback_plan(items, &today);
            ("fallback".into(), fb_summary, plan, rest, Some("no_key".to_string()))
        }
        Some(key) => {
            let (system, user_msg) = briefing::build_prompt(&items, &today);
            let ai = crate::openai::OpenAiClient::new(key);
            match ai.chat_json(&model, &system, &user_msg).await {
                Ok(content) => match briefing::apply_ai_response(&content, items.clone(), &today) {
                    Ok((summary, plan, rest)) => {
                        let summary = if summary.is_empty() { fb_summary } else { summary };
                        ("openai".into(), summary, plan, rest, None)
                    }
                    Err(e) => {
                        let (plan, rest) = briefing::fallback_plan(items, &today);
                        ("fallback".into(), fb_summary, plan, rest, Some(e))
                    }
                },
                Err(e) => {
                    let (plan, rest) = briefing::fallback_plan(items, &today);
                    ("fallback".into(), fb_summary, plan, rest, Some(e))
                }
            }
        }
    };
    let b = briefing::Briefing {
        date: today,
        generated_at: now.format("%H:%M").to_string(),
        model,
        source,
        error,
        summary,
        plan,
        rest,
    };
    let _ = config::save_cached_briefing(&app, &b);
    Ok(b)
}

/// 브리핑 창을 설정된 디스플레이 중앙에 표시하고, 창에게 로드 신호를 보낸다.
#[tauri::command]
pub fn open_briefing(app: tauri::AppHandle) {
    crate::show_centered(&app, "briefing");
    let _ = app.emit_to("briefing", "briefing-open", ());
}
```

`lib.rs` `invoke_handler`에 등록:

```rust
            commands::generate_briefing,
            commands::open_briefing,
```

- [ ] **Step 4: 컴파일·테스트 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 전체 PASS (신규 커맨드는 컴파일 검증)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/briefing.rs
git commit -m "feat(briefing): add generate_briefing/open_briefing commands with daily cache"
```

---

### Task 6: 브리핑 창 UI

**Files:**
- Modify: `src-tauri/tauri.conf.json` (briefing 창), `src-tauri/capabilities/default.json` (windows + start-dragging), `vite.config.ts` (input)
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`
- Create: `src/briefing/index.html`, `src/briefing/logic.ts`, `src/briefing/main.ts`
- Test: `src/briefing/logic.test.ts`
- Modify: `src/shared/app.css` (`.bf-*` 스타일)

**Interfaces:**
- Consumes: `generate_briefing`/`open_briefing` 커맨드, `openEditModal` (ipc), Task 5의 `Briefing` DTO 형태
- Produces: `generateBriefing(force: boolean): Promise<Briefing>`, `openBriefing(): Promise<void>` (ipc), `briefingToText(b: Briefing): string`, `formatDateLabel(iso: string): string`, `dueLabel(target: string | null, today: string): string` (logic.ts)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/briefing/logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { briefingToText, dueLabel, formatDateLabel } from "./logic";
import type { Briefing, BriefingItem } from "../shared/types";

const item = (id: string, name: string, target: string | null): BriefingItem => ({
  id, name, project_id: "p1", project_identifier: "WEB",
  priority: "none", start_date: null, target_date: target, state_group: "unstarted",
});

describe("formatDateLabel", () => {
  it("formats an ISO date as Korean month/day with weekday", () => {
    expect(formatDateLabel("2026-07-03")).toBe("7월 3일 (금)");
  });
});

describe("dueLabel", () => {
  it("labels overdue, today, and future dates", () => {
    expect(dueLabel("2026-07-01", "2026-07-03")).toBe("D+2");
    expect(dueLabel("2026-07-03", "2026-07-03")).toBe("오늘");
    expect(dueLabel("2026-07-05", "2026-07-03")).toBe("7/5");
    expect(dueLabel(null, "2026-07-03")).toBe("");
  });
});

describe("briefingToText", () => {
  it("renders summary, numbered plan, and rest as plain text", () => {
    const b: Briefing = {
      date: "2026-07-03", generated_at: "09:00", model: "gpt-4o-mini",
      source: "openai", error: null, summary: "요약입니다.",
      plan: [{ item: item("a", "인증서 갱신", "2026-07-01"), reason: "마감 2일 초과" }],
      rest: [item("b", "보고서 초안", "2026-07-08")],
    };
    const text = briefingToText(b);
    expect(text).toContain("[AI 브리핑] 7월 3일 (금)");
    expect(text).toContain("요약입니다.");
    expect(text).toContain("1. 인증서 갱신 (WEB) — 마감 2일 초과");
    expect(text).toContain("- 보고서 초안 (WEB) — 7/8");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test`
Expected: FAIL (`./logic` 모듈 없음)

- [ ] **Step 3: 타입/IPC/logic 구현**

`src/shared/types.ts`에 추가:

```ts
export interface BriefingItem {
  id: string; name: string; project_id: string; project_identifier: string;
  priority: string; start_date: string | null; target_date: string | null;
  state_group: string;
}
export interface BriefingPlanEntry { item: BriefingItem; reason: string; }
export interface Briefing {
  date: string; generated_at: string; model: string;
  source: string; error: string | null; summary: string;
  plan: BriefingPlanEntry[]; rest: BriefingItem[];
}
```

`src/shared/ipc.ts`에 추가 (import 타입에 `Briefing` 포함):

```ts
export const generateBriefing = (force: boolean) =>
  invoke<Briefing>("generate_briefing", { force });
export const openBriefing = () => invoke<void>("open_briefing");
```

`src/briefing/logic.ts`:

```ts
import type { Briefing } from "../shared/types";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-07-03" -> "7월 3일 (금)". new Date(iso)의 UTC 해석을 피해 직접 분해한다. */
export function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return `${m}월 ${d}일 (${WEEKDAYS[day]})`;
}

/** 마감 칩 문구: 지남 "D+n", 오늘 "오늘", 미래 "M/D", 없음 "". */
export function dueLabel(target: string | null, today: string): string {
  if (!target) return "";
  if (target === today) return "오늘";
  if (target < today) {
    const days = Math.round((toUtc(today) - toUtc(target)) / 86400000);
    return `D+${days}`;
  }
  const [, m, d] = target.split("-").map(Number);
  return `${m}/${d}`;
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 클립보드 복사용 플레인 텍스트 (일일 스크럼 공유 형식). */
export function briefingToText(b: Briefing): string {
  const lines: string[] = [`[AI 브리핑] ${formatDateLabel(b.date)}`, b.summary, ""];
  if (b.plan.length > 0) {
    lines.push("오늘의 플랜");
    b.plan.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.item.name} (${e.item.project_identifier}) — ${e.reason}`);
    });
  }
  if (b.rest.length > 0) {
    lines.push("", "나머지 작업");
    for (const it of b.rest) {
      const due = dueLabel(it.target_date, b.date);
      lines.push(`- ${it.name} (${it.project_identifier})${due ? ` — ${due}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** 로컬 기준 오늘 (YYYY-MM-DD). */
export function localToday(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test`
Expected: logic.test.ts PASS

- [ ] **Step 5: 창 등록** — `src-tauri/tauri.conf.json`의 `windows` 배열에 (editmodal 항목 뒤):

```json
      {
        "label": "briefing",
        "url": "src/briefing/index.html",
        "width": 560, "height": 340,
        "decorations": false, "transparent": true, "alwaysOnTop": true, "shadow": false,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": false
      }
```

`src-tauri/capabilities/default.json`:
- `"windows"` 배열에 `"briefing"` 추가.
- `"permissions"`의 `"core:window:allow-set-position"` 뒤에 `"core:window:allow-start-dragging"` 추가 (헤더 드래그 이동용).

`vite.config.ts` `input`에 추가:

```ts
        briefing: resolve(__dirname, "src/briefing/index.html"),
```

- [ ] **Step 6: 마크업/스타일** — `src/briefing/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>AI 브리핑</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <div class="bf-card">
      <div class="bf-head" data-tauri-drag-region>
        <svg class="bf-grip" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>
        <span class="bf-head-title">AI 브리핑 · <span id="bfDate"></span></span>
        <button type="button" id="bfRegen" class="bf-icon-btn" title="다시 생성">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" id="bfClose" class="bf-icon-btn" aria-label="닫기 (Esc)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>
      <div id="bfBody" class="bf-body"></div>
      <div class="bf-foot">
        <span id="bfMeta" class="bf-meta"></span>
        <button type="button" id="bfCopy" class="bf-btn">복사</button>
        <button type="button" id="bfRegenFoot" class="bf-btn bf-btn-primary">다시 생성</button>
      </div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/shared/app.css` 끝에 추가:

```css
/* ============ SURFACE 5: AI BRIEFING WINDOW ============ */
/* QuickAdd와 같은 창 문법(투명 바디 + 카드). 헤더 바 전체가 Tauri 드래그
   영역이고, 비대화 요소는 pointer-events:none으로 mousedown이 바에 닿게 한다. */
.bf-card {
  width: 100%; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden;
}
.bf-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px 7px 13px;
  background: var(--panel-2); border-bottom: 1px solid var(--border);
  cursor: grab; user-select: none;
}
.bf-head:active { cursor: grabbing; }
.bf-grip { width: 13px; height: 13px; color: var(--muted-2); pointer-events: none; flex: none; }
.bf-head-title { flex: 1; font-size: 12px; font-weight: 600; color: var(--muted); pointer-events: none; }
.bf-icon-btn {
  flex: none; width: 24px; height: 24px; border-radius: 6px;
  display: grid; place-items: center; background: transparent;
  border: none; color: var(--muted); cursor: pointer;
}
.bf-icon-btn:hover, .bf-icon-btn:focus-visible { background: var(--panel); color: var(--text); outline: none; }
.bf-icon-btn svg { width: 13px; height: 13px; }
.bf-body { padding: 13px 15px 6px; }
.bf-loading, .bf-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 18px 0 24px; margin: 0; }
.bf-summary {
  display: flex; gap: 9px; align-items: flex-start;
  background: var(--accent-soft); border: 1px solid rgba(79,124,255,0.28);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 12px;
}
.bf-summary .spark { flex: none; color: var(--accent); }
.bf-summary p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text); }
.bf-note { font-size: 11.5px; color: var(--muted-2); margin: 0 0 10px; }
.bf-plan { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.bf-plan-row {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 7px 8px; border-radius: 9px; cursor: pointer;
}
.bf-plan-row:hover { background: var(--panel-2); }
.bf-plan-row .num {
  flex: none; width: 21px; height: 21px; border-radius: 50%;
  display: grid; place-items: center; font-size: 11px; font-weight: 700;
  background: var(--panel-2); border: 1px solid var(--border); color: var(--muted);
}
.bf-plan-row.hot .num { background: rgba(239,77,86,0.12); border-color: rgba(239,77,86,0.5); color: var(--red); }
.bf-plan-row .t { font-size: 13px; margin-bottom: 2px; display: flex; gap: 7px; align-items: baseline; min-width: 0; }
.bf-plan-row .t .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bf-plan-row .t .proj { flex: none; font-size: 10.5px; color: var(--muted-2); font-weight: 600; }
.bf-plan-row .why { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
.bf-plan-row .bf-plan-body { flex: 1; min-width: 0; }
.bf-rest { border-top: 1px dashed var(--border); padding-top: 8px; margin-bottom: 6px; }
.bf-rest-head { font-size: 11.5px; font-weight: 700; color: var(--muted); margin-bottom: 4px; display: flex; gap: 6px; }
.bf-rest-head .cnt { color: var(--muted-2); font-weight: 600; }
.bf-rest-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px; border-radius: 7px; cursor: pointer;
}
.bf-rest-row:hover { background: var(--panel-2); }
.bf-rest-row .name { flex: 1; font-size: 12.5px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bf-rest-row .proj { flex: none; font-size: 10.5px; color: var(--muted-2); font-weight: 600; }
.bf-chip {
  flex: none; font-size: 10.5px; padding: 1px 7px; border-radius: 5px;
  border: 1px solid var(--border); color: var(--muted);
}
.bf-chip.red { color: var(--red); border-color: rgba(239,77,86,0.45); background: rgba(239,77,86,0.1); }
.bf-chip.amber { color: var(--amber); border-color: rgba(245,166,35,0.45); background: rgba(245,166,35,0.08); }
.bf-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 13px; border-top: 1px solid var(--border); background: var(--panel-2);
}
.bf-meta { flex: 1; font-size: 11px; color: var(--muted-2); }
.bf-btn {
  font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 7px;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  cursor: pointer; font-family: inherit;
}
.bf-btn:hover { color: var(--text); border-color: var(--accent); }
.bf-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.bf-btn-primary:hover { color: #fff; filter: brightness(1.08); }
.bf-btn:disabled { opacity: 0.55; cursor: default; }
```

- [ ] **Step 7: main.ts 구현** — `src/briefing/main.ts`:

```ts
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { generateBriefing, getSettings, openEditModal } from "../shared/ipc";
import { applyTheme } from "../shared/theme";
import { briefingToText, dueLabel, formatDateLabel, localToday } from "./logic";
import type { Briefing, BriefingItem } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const cardEl = document.querySelector(".bf-card") as HTMLElement;
const bodyEl = document.getElementById("bfBody")!;
const dateEl = document.getElementById("bfDate")!;
const metaEl = document.getElementById("bfMeta")!;
const copyBtn = document.getElementById("bfCopy") as HTMLButtonElement;
const regenBtn = document.getElementById("bfRegen") as HTMLButtonElement;
const regenFootBtn = document.getElementById("bfRegenFoot") as HTMLButtonElement;

let current: Briefing | null = null;
let generating = false;

function resizeToFit() {
  const height = Math.ceil(cardEl.getBoundingClientRect().height) + 4;
  win.setSize(new LogicalSize(560, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function itemRow(it: BriefingItem, today: string): HTMLElement {
  const row = el("div", "bf-rest-row");
  row.appendChild(el("span", "name", it.name));
  row.appendChild(el("span", "proj", it.project_identifier));
  const due = dueLabel(it.target_date, today);
  if (due) {
    const cls = due.startsWith("D+") ? "bf-chip red" : due === "오늘" ? "bf-chip amber" : "bf-chip";
    row.appendChild(el("span", cls, due));
  }
  row.onclick = () => openEditModal(it.project_id, it.id);
  return row;
}

function render(b: Briefing) {
  current = b;
  dateEl.textContent = formatDateLabel(b.date);
  metaEl.textContent = `${b.generated_at} 생성 · ${b.source === "openai" ? b.model : "규칙 기반"}`;
  bodyEl.innerHTML = "";

  const summary = el("div", "bf-summary");
  summary.appendChild(el("span", "spark", "✦"));
  const p = document.createElement("p");
  p.textContent = b.summary;
  summary.appendChild(p);
  bodyEl.appendChild(summary);

  if (b.error === "no_key") {
    bodyEl.appendChild(el("p", "bf-note", "OpenAI API 키가 없어 규칙 기반으로 생성했어요 — 설정에서 등록할 수 있어요."));
  } else if (b.error) {
    bodyEl.appendChild(el("p", "bf-note", "AI 호출에 실패해 규칙 기반으로 생성했어요."));
  }

  if (b.plan.length === 0 && b.rest.length === 0) {
    bodyEl.appendChild(el("p", "bf-empty", "남은 작업이 없습니다 🎉"));
  }

  const plan = el("div", "bf-plan");
  b.plan.forEach((e, i) => {
    const row = el("div", "bf-plan-row" + (i === 0 && e.reason.includes("초과") ? " hot" : ""));
    row.appendChild(el("span", "num", String(i + 1)));
    const body = el("div", "bf-plan-body");
    const t = el("div", "t");
    t.appendChild(el("span", "name", e.item.name));
    t.appendChild(el("span", "proj", e.item.project_identifier));
    body.appendChild(t);
    body.appendChild(el("div", "why", e.reason));
    row.appendChild(body);
    row.onclick = () => openEditModal(e.item.project_id, e.item.id);
    plan.appendChild(row);
  });
  if (b.plan.length > 0) bodyEl.appendChild(plan);

  if (b.rest.length > 0) {
    const rest = el("div", "bf-rest");
    const head = el("div", "bf-rest-head", "나머지 작업 ");
    head.appendChild(el("span", "cnt", String(b.rest.length)));
    rest.appendChild(head);
    for (const it of b.rest) rest.appendChild(itemRow(it, b.date));
    bodyEl.appendChild(rest);
  }
  resizeToFit();
}

function renderLoading() {
  bodyEl.innerHTML = "";
  dateEl.textContent = formatDateLabel(localToday());
  metaEl.textContent = "";
  bodyEl.appendChild(el("p", "bf-loading", "브리핑 생성 중…"));
  resizeToFit();
}

function renderError(err: unknown) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "bf-empty", "브리핑을 불러오지 못했어요: " + err));
  resizeToFit();
}

async function generate(force: boolean) {
  if (generating) return;
  generating = true;
  regenBtn.disabled = true;
  regenFootBtn.disabled = true;
  renderLoading();
  try {
    render(await generateBriefing(force));
  } catch (e) {
    console.error("generateBriefing failed:", e);
    renderError(e);
  } finally {
    generating = false;
    regenBtn.disabled = false;
    regenFootBtn.disabled = false;
  }
}

/** 창이 열릴 때: 오늘 것을 이미 들고 있으면 그대로, 아니면 (캐시 우선) 생성. */
function ensureToday() {
  if (current && current.date === localToday()) return;
  generate(false);
}

regenBtn.onclick = () => generate(true);
regenFootBtn.onclick = () => generate(true);
copyBtn.onclick = async () => {
  if (!current) return;
  try {
    await writeText(briefingToText(current));
    copyBtn.textContent = "복사됨 ✓";
    setTimeout(() => (copyBtn.textContent = "복사"), 1200);
  } catch (e) {
    console.error("clipboard write failed:", e);
  }
};
document.getElementById("bfClose")!.onclick = () => win.hide();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});

listen("briefing-open", ensureToday);
getSettings().then((s) => applyTheme(s.theme)).catch(() => {});
resizeToFit();
```

- [ ] **Step 8: 빌드·테스트 확인**

Run: `pnpm test && pnpm build && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 전부 PASS. (참고: capabilities에 새 창을 추가하면 `src-tauri/gen/schemas`가 재생성될 수 있음 — 함께 커밋.)

- [ ] **Step 9: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json vite.config.ts src/briefing src/shared/types.ts src/shared/ipc.ts src/shared/app.css src-tauri/gen
git commit -m "feat(briefing): add briefing window UI with plan list, copy and regenerate"
```

---

### Task 7: 사이드바 브리핑 버튼

**Files:**
- Modify: `src/sidebar/index.html` (헤더 버튼), `src/sidebar/main.ts` (클릭 핸들러)

**Interfaces:**
- Consumes: `openBriefing()` (ipc, Task 6)

- [ ] **Step 1: 버튼 추가** — `src/sidebar/index.html`의 `sb-head`에서 `openPlane` 버튼 **앞**에:

```html
        <span id="briefingBtn" class="hbtn" title="AI 브리핑"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z"/><path d="M12.8 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></svg></span>
```

- [ ] **Step 2: 핸들러 연결** — `src/sidebar/main.ts`의 `document.getElementById("refresh")!.onclick = refresh;` 근처에 추가. 상단 import 문의 `../shared/ipc`에서 `openBriefing`도 가져온다:

```ts
document.getElementById("briefingBtn")!.onclick = () => {
  openBriefing().catch((e) => console.error("openBriefing failed:", e));
};
```

- [ ] **Step 3: 확인**

Run: `pnpm build`
Expected: 빌드 성공. 수동 확인(가능하면): `pnpm tauri dev` → 사이드바 ✦ 버튼 → 브리핑 창 표시.

- [ ] **Step 4: Commit**

```bash
git add src/sidebar/index.html src/sidebar/main.ts
git commit -m "feat(briefing): add sidebar header button to open the briefing window"
```

---

### Task 8: 설정 UI — OpenAI 키·모델·아침 브리핑

**Files:**
- Modify: `src/settings/index.html`, `src/settings/main.ts`

**Interfaces:**
- Consumes: Task 1의 `SettingsDto.{has_openai_key, briefing_model, morning_briefing_enabled, morning_briefing_time}`, `saveSettings(...)` 확장 파라미터

- [ ] **Step 1: 마크업** — `src/settings/index.html`의 "사이드바 자동 열기" 섹션 뒤에:

```html
      <h2>AI 브리핑</h2>
      <label>OpenAI API 키
        <span id="oaSaved" class="token-saved-row" hidden>
          <span class="check"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
          <span class="mask">••••••••••••</span>
          <span class="meta">저장됨</span>
          <button type="button" class="token-change-btn" id="oaChange">변경</button>
        </span>
        <input id="openaiKey" type="password" placeholder="sk-..." />
      </label>
      <label>모델<input id="briefingModel" placeholder="gpt-4o-mini" /></label>
      <label class="check-row"><input id="morningEnabled" type="checkbox" />아침 브리핑 자동 표시</label>
      <label>아침 브리핑 시각<input id="morningTime" type="time" /></label>
```

- [ ] **Step 2: 스크립트** — `src/settings/main.ts`:

요소 참조 추가 (`idleOpenMinutes` 아래):

```ts
const openaiKey = document.getElementById("openaiKey") as HTMLInputElement;
const oaSaved = document.getElementById("oaSaved")!;
const oaChange = document.getElementById("oaChange")!;
const briefingModel = document.getElementById("briefingModel") as HTMLInputElement;
const morningEnabled = document.getElementById("morningEnabled") as HTMLInputElement;
const morningTime = document.getElementById("morningTime") as HTMLInputElement;

// Plane 토큰 카드와 같은 규칙: 저장된 키는 카드로만 보이고 값은 절대
// 페이지로 로드하지 않는다. 입력창의 값은 언제나 '새 키'다.
let hasOpenaiKey = false;
function renderOpenaiKeyField(editing: boolean) {
  const showCard = hasOpenaiKey && !editing;
  oaSaved.hidden = !showCard;
  openaiKey.hidden = showCard;
}
oaChange.onclick = (e) => {
  e.preventDefault();
  renderOpenaiKeyField(true);
  openaiKey.focus();
};
```

`load()` 안에 (`idleOpenMinutes.value = ...` 뒤):

```ts
  hasOpenaiKey = s.has_openai_key;
  renderOpenaiKeyField(false);
  briefingModel.value = s.briefing_model;
  morningEnabled.checked = s.morning_briefing_enabled;
  morningTime.value = s.morning_briefing_time;
```

저장 핸들러의 `saveSettings(...)` 호출 인자 끝에 추가:

```ts
      openaiKey.value || undefined,
      briefingModel.value.trim() || undefined,
      morningEnabled.checked,
      morningTime.value || undefined,
```

저장 성공 처리(`token.value = ""; renderTokenField(false);` 뒤)에:

```ts
    if (openaiKey.value) hasOpenaiKey = true;
    openaiKey.value = "";
    renderOpenaiKeyField(false);
```

- [ ] **Step 3: 확인**

Run: `pnpm build`
Expected: 빌드 성공. 수동 확인(가능하면): 설정 창에서 키 저장 → 재오픈 시 "저장됨" 카드.

- [ ] **Step 4: Commit**

```bash
git add src/settings/index.html src/settings/main.ts
git commit -m "feat(briefing): add OpenAI key, model, and morning briefing settings UI"
```

---

### Task 9: 아침 자동 브리핑 스케줄러

**Files:**
- Modify: `src-tauri/src/briefing.rs` (`should_fire_morning`), `src-tauri/src/config.rs` (마지막 표시일 저장), `src-tauri/src/lib.rs` (워처)

**Interfaces:**
- Consumes: `parse_hhmm` (Task 2), `show_centered` (Task 5)
- Produces: `briefing::should_fire_morning(now_min: u32, cfg_min: u32, today: &str, last_shown: Option<&str>) -> bool`, `config::get_morning_last(app) -> Option<String>`, `config::set_morning_last(app, &str) -> Result<(), String>`

- [ ] **Step 1: 실패하는 테스트 작성** — `briefing.rs` `mod tests`에:

```rust
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
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml morning`
Expected: COMPILE FAIL (`should_fire_morning` 미정의)

- [ ] **Step 3: 구현**

`briefing.rs`:

```rust
/// 아침 브리핑 발화 판정. enabled 체크와 시각 파싱은 호출자(워처) 몫 —
/// 여기는 "지정 시각이 지났고 오늘 아직 안 떴다"만 판단한다.
pub fn should_fire_morning(now_min: u32, cfg_min: u32, today: &str, last_shown: Option<&str>) -> bool {
    now_min >= cfg_min && last_shown != Some(today)
}
```

`config.rs`:

```rust
const MORNING_LAST_KEY: &str = "briefing_morning_last";

pub fn get_morning_last(app: &tauri::AppHandle) -> Option<String> {
    app.store(STORE_FILE)
        .ok()?
        .get(MORNING_LAST_KEY)
        .and_then(|v| v.as_str().map(str::to_owned))
}

pub fn set_morning_last(app: &tauri::AppHandle, date: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(MORNING_LAST_KEY, serde_json::json!(date));
    store.save().map_err(|e| e.to_string())
}
```

`lib.rs` — 상단 상수들 옆에:

```rust
/// 아침 브리핑 시각 판정 주기. 설정을 매 tick 다시 읽어 재시작 없이 반영된다.
const MORNING_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
```

`spawn_idle_watcher` 아래에:

```rust
/// 매분 로컬 시각을 확인해, 아침 브리핑이 켜져 있고 지정 시각이 지났으며
/// 오늘 아직 안 띄웠다면 브리핑 창을 표시한다. 첫 판정을 sleep 전에 두어
/// 지정 시각 이후에 앱을 켠 경우에도 시작 직후 한 번 뜬다.
fn spawn_morning_briefing_watcher(app: tauri::AppHandle) {
    use chrono::Timelike;
    tauri::async_runtime::spawn(async move {
        loop {
            let s = config::load_settings(&app);
            if s.morning_briefing_enabled {
                if let Some(cfg_min) = briefing::parse_hhmm(&s.morning_briefing_time) {
                    let now = chrono::Local::now();
                    let today = now.format("%Y-%m-%d").to_string();
                    let now_min = now.hour() * 60 + now.minute();
                    let last = config::get_morning_last(&app);
                    if briefing::should_fire_morning(now_min, cfg_min, &today, last.as_deref()) {
                        // 먼저 기록해 실패해도 반복 팝업으로 괴롭히지 않는다.
                        let _ = config::set_morning_last(&app, &today);
                        show_centered(&app, "briefing");
                        let _ = app.emit_to("briefing", "briefing-open", ());
                    }
                }
            }
            tokio::time::sleep(MORNING_POLL_INTERVAL).await;
        }
    });
}
```

`setup`의 `spawn_idle_watcher(...)` 호출 뒤에:

```rust
            spawn_morning_briefing_watcher(app.handle().clone());
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/briefing.rs src-tauri/src/config.rs src-tauri/src/lib.rs
git commit -m "feat(briefing): auto-show morning briefing at the configured time"
```

---

### Task 10: CHANGELOG + 전체 검증

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG 기록** — `## [Unreleased]`의 `### 추가` 섹션에 (없으면 만들고, 기존 항목은 유지):

```markdown
### 추가
- AI 브리핑: 남은 작업의 마감일·우선순위를 분석해 "오늘의 플랜"을 보여주는 브리핑 창 (사이드바 ✦ 버튼, 설정에서 OpenAI 키·아침 자동 표시 설정 가능)
```

- [ ] **Step 2: 전체 검증**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm build`
Expected: 전부 PASS.

수동 스모크 테스트 (`pnpm tauri dev`):
1. 사이드바 ✦ 버튼 → 브리핑 창이 뜨고 "브리핑 생성 중…" 후 내용 표시 (키 없으면 규칙 기반 + 안내문).
2. 창 닫고 다시 열기 → 즉시 표시 (캐시, API 재호출 없음 — 네트워크 로그로 확인).
3. ↻ 다시 생성 → 재생성.
4. 항목 클릭 → 수정 모달 열림. [복사] → 클립보드에 텍스트.
5. 설정에서 키 저장 후 다시 생성 → AI 요약 표시.
6. 설정에서 아침 브리핑 켜고 시각을 1~2분 뒤로 → 해당 시각에 창 자동 표시, 같은 날 반복 안 됨.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "feat(briefing): note AI briefing feature in changelog"
```
