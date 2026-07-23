# 마감 알림 (하루 1회 다이제스트) 설계

- 작성일: 2026-07-23
- 상태: 승인됨 (구현 대기)

## 배경 · 목적

앱은 이미 능동 알림(push) 인프라를 갖추고 있다 — 새 할당 감지 토스트, 미확인
재알림, 아침 AI 브리핑, 유휴 자동 열기, 오프라인 큐 복구. 그러나 **마감(deadline)
알림**이 빠져 있다. 항목마다 `target_date`가 있는데도 "마감이 지났거나 오늘·며칠
안에 마감"이라는 사실을 능동적으로 알려주는 경로가 없다. 아침 브리핑이 "오늘의
플랜"으로 일부 커버하지만 브리핑은 opt-in(OpenAI 키 필요, 창을 띄움)이고, 마감을
놓치는 그 지점을 전용으로 다루지 않는다.

이 기능은 **내게 할당된 미완료 작업 중 마감이 임박/도래/경과한 것**을 하루 1회
네이티브 토스트 다이제스트로 정리해 알린다. "매일 앱을 여는 이유"를 만드는 pull
요소를 강화하는 것이 목적이다.

## 핵심 설계 결정 (확정)

1. **전달 방식**: 하루 1회 다이제스트. (`target_date`가 날짜 단위라 실시간
   개별 알림은 이득이 적고 자정/앱 시작에 몰려 스팸이 된다.)
2. **아침 브리핑과 독립**: 마감 알림 전용 시각·on/off를 가진다. 브리핑을 꺼도
   마감 알림은 동작한다 — 두 기능은 직교한다.
3. **마감 범위**: 지남(overdue) + 오늘(today) + 곧(soon, 기본 3일 이내). 임박
   일수는 설정으로 조절.
4. **스코프**: 나에게 할당된 미완료 항목만 (completed/cancelled 제외) —
   할당 알림·브리핑과 동일한 대상.
5. **기본값**: 기본 **켬**(할당 알림과 같은 가벼운 토스트라 방해가 적다),
   시각 `09:00`, 임박 `3`일.
6. **빈 다이제스트**: 대상이 하나도 없으면 조용히 넘어가고(토스트 없음) 그날
   fired 처리한다. 놓치는 것 없음 — 근거는 아래 "안전성" 참고.
7. **클릭 동작**: MVP에서는 없음(기존 할당 토스트와 동일한 정보 전달용).
   토스트 클릭 시 사이드바 열기는 후속 과제.

## 아키텍처

기존 `assign_watch.rs` / `idle.rs`와 동일한 3층 구조를 따른다:
**순수 판정 모듈 + lib.rs watcher 루프 + 설정 플래그.**

- **`src-tauri/src/deadline_watch.rs`** (신규): 순수 로직만 — 마감 분류, 요약,
  토스트 문구 생성. 네트워크·알림·트레이는 다루지 않는다. 단위 테스트 대상.
- **`spawn_deadline_watcher`** (lib.rs, 신규): `spawn_morning_briefing_watcher`를
  본뜬 60초 폴링 루프. 자체 루프로 두어 관심사를 분리한다.
- **발화 판정 재사용**: `briefing::should_fire_morning(now_min, cfg_min, today, last)`와
  `briefing::parse_hhmm`은 브리핑 전용이 아니라 범용 함수이므로 그대로 재사용한다.
- **대상 항목 재사용**: `briefing::open_assigned_items(user_id, projects, items)`가
  이미 "나에게 할당된 미완료 + project identifier 부여"를 수행하므로 재사용한다.
  이 로직을 마감 알림에서 중복 구현하지 않는다.

## 데이터 흐름 (한 tick)

`spawn_deadline_watcher` 루프는 60초마다:

1. `config::load_settings` 로드. `deadline_notify_enabled`가 꺼져 있으면 skip.
2. `deadline_notify_time`을 `parse_hhmm`으로 파싱, 현재 로컬 분과 오늘 날짜
   (`chrono::Local`), `config::get_deadline_last`를 읽어
   `should_fire_morning(now_min, cfg_min, today, last)` 판정. false면 skip.
3. 발화 조건 충족 시 서버 조회 (하루 1회이므로 비용 거의 0):
   - `base_url`/`workspace`/토큰 없으면 skip (기록 안 함 → 설정 후 재시도).
   - `assign_tick`과 같은 방식으로 프로젝트 목록 → 프로젝트별 work items 조회.
     **한 프로젝트라도 실패하면 tick 전체 중단**하고 `deadline_notify_last`를
     기록하지 않는다 (오프라인/일시 오류 → 복귀 시 그날 안에 따라잡음).
   - `briefing::open_assigned_items`로 대상 필터.
4. `deadline_watch::summarize(&items, today, lead_days)` → `Digest { overdue,
   today, soon }`.
5. 셋 중 하나라도 비어 있지 않으면 `deadline_watch::digest_body`로 본문을 만들어
   네이티브 토스트 1건 발화. 전부 비어 있으면 토스트 없음.
6. **성공적으로 평가한 경우에만** `config::set_deadline_last(today)` 기록.

## 분류 로직 (`deadline_watch.rs`, 순수)

```
enum DueClass { Overdue, Today, Soon, Later, NoDate }

fn classify(target: Option<&str>, today: &str, lead_days: u32) -> DueClass
    target 없음                          -> NoDate
    target < today                       -> Overdue
    target == today                      -> Today
    today < target <= today + lead_days  -> Soon
    그 외 (더 먼 미래)                    -> Later
```

- 날짜 비교는 브리핑의 `bucket`과 같은 방식. `chrono::NaiveDate::parse_from_str`로
  파싱해 `today + lead_days` 경계를 계산한다 (문자열 비교로는 월/연 경계를 넘는
  "+3일"을 못 구하므로 파싱이 필요하다).
- 파싱 실패한 `target`은 `NoDate`로 취급(방어적).

```
struct Digest {
    overdue: Vec<DueEntry>,   // 급한 순 우선
    today:   Vec<DueEntry>,
    soon:    Vec<DueEntry>,
}
// DueEntry: 표시에 필요한 최소 필드 (name, project_identifier, target_date, days)
fn summarize(items: &[BriefingItem], today: &str, lead_days: u32) -> Digest
```

`Later`/`NoDate`는 다이제스트에 들어가지 않는다.

## 토스트 내용

- 제목: **"마감 임박 작업"**
- 본문: 요약 줄 + 급한 순(지남 > 오늘 > 곧) 상위 3건, 초과분은 "…외 N건".

예시:
```
지남 2 · 오늘 3 · 곧 1
• [WEB] 결제 오류 수정 — 오늘
• [API] 배포 스크립트 — 지남 2일
• [WEB] 로그 정리 — 오늘
…외 3건
```

- `digest_body(&Digest) -> String` 순수 함수로 분리해 단위 테스트한다.
- 각 항목 꼬리표: 지남은 "지남 N일", 오늘은 "오늘", 곧은 "M/D"(브리핑
  `short_md`와 같은 형식).

## 설정 (config.rs)

`Settings`에 필드 3개 추가. 기존 컨벤션(`#[serde(default = "...")]` + 레거시
설정 파일 기본값 테스트)을 따른다.

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

fn default_deadline_notify_enabled() -> bool { true }
fn default_deadline_notify_time() -> String { "09:00".into() }
fn default_deadline_lead_days() -> u32 { 3 }
```

`Default for Settings`에 세 필드 반영. `settings_round_trip_preserves_fields`
테스트에도 세 필드 추가.

**영속 상태** (settings.json 스토어, `morning_last` 패턴):

```rust
const DEADLINE_LAST_KEY: &str = "deadline_notify_last";
pub fn get_deadline_last(app) -> Option<String>
pub fn set_deadline_last(app, date: &str) -> Result<(), String>
```

## 설정 UI (`src/settings/main.ts`)

브리핑/할당 설정 근처에 추가:
- 토글: "마감 알림"
- 시각 입력: "HH:MM" (브리핑 시각 입력과 같은 컴포넌트)
- 숫자 입력: 임박 일수

## 안전성 (엣지 케이스)

- **늦게 켠 경우**: `should_fire_morning`이 "시각 지남 + 오늘 처음"이면 발화 →
  출근 후 PC 켜는 패턴을 커버한다.
- **하루 중 재분류 없음**: `target_date`가 날짜 단위라 "오늘"은 하루 내내
  "오늘"이고, 지남/곧도 그날 안에서 바뀌지 않는다. 따라서 빈 다이제스트를 fired
  처리해도 그날 새로 놓치는 항목이 생기지 않는다. 하루 중 새로 할당된 오늘-마감
  항목은 별도의 **할당 알림**(`assign_watch`)이 즉시 잡는다.
- **오프라인/일시 오류**: fetch 실패 시 `deadline_notify_last`를 기록하지 않아,
  네트워크 복구 후 다음 tick에서 같은 날 안에 따라잡는다.
- **미설정**: base_url/workspace/토큰이 없으면 skip.

## 테스트

**`deadline_watch` 단위 테스트:**
- `classify`: 경계값 — 지남 1일, 오늘, 정확히 lead_days째(Soon), lead_days+1일
  (Later), 무마감(NoDate), 파싱 실패(NoDate).
- `summarize`: 여러 항목을 overdue/today/soon 버킷으로 정확히 분류, Later/NoDate
  제외, 급한 순 정렬.
- `digest_body`: 카운트 요약, 상위 3건 캡 + "…외 N건", 버킷별 꼬리표 문구,
  일부 버킷이 빈 경우.

**`config` 테스트:**
- `Settings::default()`가 마감 필드 기본값(켬 / "09:00" / 3)을 갖는지.
- 마감 필드가 없는 레거시 설정 파일이 기본값으로 채워지는지.
- 라운드트립 보존.

**발화 판정**: `briefing::should_fire_morning` 재사용이므로 기존 테스트가 커버.

## CHANGELOG

`CHANGELOG.md`의 `## [Unreleased] > ### 추가`에 추가:

> - 마감이 지났거나 오늘·며칠 안에 마감인 내 작업을 아침에 알림으로 정리해줍니다.

## 범위 밖 (후속 과제)

- 토스트 클릭 시 사이드바(마감 필터) 열기.
- 지남 항목의 별도 재알림 주기.
- 하이브리드(하루 중 새로 도래한 건 즉시 알림).
