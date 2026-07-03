# AI 브리핑 기능 설계

날짜: 2026-07-03
목업: `docs/superpowers/mockups/2026-07-03-ai-briefing-mockup.html` (B안 채택)

## 목적

사용자가 "오늘 뭐부터 해야 하지?"에 바로 답을 얻도록, 나에게 할당된 **남은 작업**
(완료·취소 제외)을 마감일·우선순위 기준으로 분석해 처리 순서와 이유를 브리핑하는
독립 창을 제공한다. 완료된 작업에 대한 브리핑은 하지 않는다.

## UI / 창 구조

- 새 Tauri 창 `briefing` 추가. QuickAdd와 동일한 창 문법:
  `decorations: false, transparent: true, alwaysOnTop: true, shadow: false,
  skipTaskbar: true, visible: false, resizable: false`, 폭 560px.
- 카드 상단에 드래그 가능한 헤더 바 (`data-tauri-drag-region`): 그립 아이콘 +
  "AI 브리핑 · M월 D일 (요일)" + ↻(다시 생성) + ✕(닫기). Esc로도 닫기.
- 창 높이는 내용에 맞춰 자동 조절 (QuickAdd의 `resizeToFit` 패턴).
- 사이드바 헤더에 ✦ 브리핑 버튼 추가 → 창 열기.

### 창 내용 (위에서 아래로)

1. **요약 문단**: AI가 쓴 2~3문장 요약 (accent-soft 배경 카드).
2. **오늘의 플랜**: 번호 매긴 추천 처리 순서. 각 항목 = 작업명 + 프로젝트
   식별자 + 이유 한 줄. 1순위(지연 항목)는 번호 배지를 red 톤으로 강조.
3. **나머지 작업**: 플랜에 들지 않은 남은 작업의 컴팩트 목록
   (우선순위 아이콘 + 이름 + 프로젝트 + 마감 칩). 마감일 오름차순,
   무마감은 뒤로.
4. **푸터**: "HH:MM 생성 · 모델명" 메타 + [복사] + [다시 생성] 버튼.

- 플랜/나머지 항목 클릭 → 해당 작업의 수정 모달(editmodal) 열기.
- [복사] → 브리핑 전체를 플레인 텍스트로 클립보드 복사 (스크럼 공유용).

## 데이터 & AI 호출

- 데이터 소스는 사이드바와 동일: 전 프로젝트에서 내게 할당된 작업 중
  `state_group != completed && != cancelled` 전부.
- OpenAI Chat Completions API 호출 (`https://api.openai.com/v1/chat/completions`),
  JSON 응답 모드 (`response_format: json_object` 또는 structured outputs).
- 전송 데이터: 작업별 **id, 제목, 프로젝트명, 우선순위, 시작일, 마감일, 상태 그룹**
  + 오늘 날짜. 설명(description)은 보내지 않는다 (토큰 절약, 노출 최소화).
- 응답 스키마:
  ```json
  {
    "summary": "2~3문장 한국어 요약",
    "plan": [{ "id": "작업 id", "reason": "이유 한 줄" }],
    "rest": ["id", ...]
  }
  ```
- 렌더링은 앱이 한다: 응답의 id를 실제 작업 목록에 매칭해 그리므로 AI가 지어낸
  가짜 작업이 표시될 수 없다. 매칭 안 되는 id는 버리고, 응답에 빠진 작업은
  "나머지 작업"에 자동 편입한다.
- 호출은 Rust 쪽에서 수행 (reqwest 재사용). 프론트는 `generate_briefing`
  커맨드 하나만 호출.

## 폴백 (규칙 기반)

키 미설정·호출 실패·타임아웃 시에도 브리핑 창은 항상 동작한다:

- 정렬 규칙: 지연됨(마감 초과) > 오늘 마감 > 진행 중(started) > 마감 임박 순.
  동순위는 우선순위(urgent > high > medium > low > none) → 마감일 오름차순.
- 플랜은 상위 최대 5개, 나머지는 목록으로.
- 이유는 정형 문구 조합: "마감 N일 초과 · 우선순위 긴급", "오늘 마감" 등.
- 요약 자리에는 집계 문구("지연 1건, 오늘 마감 2건 포함 남은 작업 6건") +
  키 미설정이면 설정 안내 한 줄.

## 설정 추가

- **OpenAI API 키**: 키링 저장 (service `plane-quick-dock`, account
  `openai-api-key`). 설정 화면에서 Plane 토큰과 같은 카드형 UI.
- **모델명**: 자유 입력 텍스트 필드, 기본 `gpt-4o-mini`.
- **아침 브리핑**: on/off 토글 + 시각 입력 (기본 09:00, HH:MM).
- `Settings` 구조체에 `briefing_model`, `morning_briefing_enabled`,
  `morning_briefing_time` 추가 (serde default로 하위 호환).

## 아침 자동 브리핑

- 켜져 있으면 매일 지정 시각에 브리핑 창 자동 표시 + 생성. **하루 1회** —
  마지막 표시 날짜(`YYYY-MM-DD`)를 스토어에 저장해 중복 방지.
- 앱 시작 시 이미 시각이 지났고 오늘 아직 표시 전이면 시작 직후 1회 표시.
- 구현: Rust 백그라운드 태스크가 1분 주기로 판정 (기존 업데이트 체크 루프와
  같은 패턴).

## 캐시 / 비용

- 마지막 생성 결과(JSON + 생성 시각 + 날짜)를 tauri store에 저장.
- 같은 날 창을 다시 열면 저장본을 즉시 표시하고 API를 다시 부르지 않는다.
- [다시 생성] 버튼을 눌렀을 때만 재호출. 날짜가 바뀌면 자동 재생성.

## 테스트

- Rust 단위 테스트:
  - 폴백 정렬 규칙 (지연/오늘/진행 중/임박, 우선순위 타이브레이크).
  - 프롬프트 빌더에 완료·취소 항목이 포함되지 않는 것.
  - 아침 스케줄 판정: 하루 1회, 시각 경과+미표시 시 즉시 표시.
  - OpenAI 응답 파싱 + 가짜 id 무시 (wiremock으로 성공/실패/429 시나리오).
  - Settings 새 필드 하위 호환 (기존 settings.json 역직렬화).

## 비범위 (이번 버전에서 안 함)

- 완료 작업 회고/성과 브리핑.
- 설명(description) 본문 전송.
- OpenAI 외 다른 LLM 제공자.
- 브리핑 알림(트레이 토스트) — 창 자동 표시로 갈음.
