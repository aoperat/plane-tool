# 사이드바 "오늘 업무일지" 모달 — 설계

## 목표

사이드바 헤더에 새 아이콘을 추가해, 클릭 시 오늘 내가 맡은 작업을 프로젝트별 ·
상태별(완료/진행중/예정)로 정리해 보여주는 모달 창을 연다. 표시 규칙과 텍스트
포맷은 Plane 웹앱의 "업무보고서"(`/profile/[userId]/work-report`) 기능과
최대한 동일하게 맞춘다 — 실제 소스(`C:\WorkSpaces\plane`, 아래 참조 파일들)를
직접 읽어 검증했다.

**참조한 실제 소스 파일** (동작 근거):
- `apps/web/core/components/profile/work-report/report-body.tsx` — 클러스터링·
  배지·복사 텍스트 포맷 로직 (`clusterByParent`, `badgeFor`, `projectToText`).
- `apps/web/core/components/profile/work-report/settings.ts` — 설정 토글 구조,
  기본값, localStorage 저장 방식.
- `apps/api/plane/app/views/workspace/user.py`
  (`WorkspaceUserWorkReportEndpoint`) — 그룹 산정 규칙, 정렬 규칙. 이 엔드포인트
  자체는 내부 앱 API(세션 인증)라 이 데스크톱 앱의 개인 API 키로는 호출할 수
  없으므로, 로직만 이식하고 데이터는 기존처럼 공개 REST API(`/api/v1/...`,
  `plane_api.rs`)로 직접 가져온다.

## 1. 진입점

- `src/sidebar/index.html`의 `.sb-head`에 기존 `briefingBtn` 옆에
  `journalBtn`(`.hbtn`, 인라인 SVG, 15px, 제목 "오늘 업무일지") 추가.
- `tauri.conf.json`에 `workjournal` 창 추가 — `briefing`과 동일한 속성
  (`decorations:false, transparent:true, alwaysOnTop:true, shadow:false,
  skipTaskbar:true, visible:false, center:true, resizable:false`), 크기는
  520×640 정도. 내부는 스크롤 가능한 본문.
- `commands.rs`에 `open_work_journal(app)` 추가 — `briefing`과 같은 패턴으로
  `show_centered(&app, "workjournal")` 호출 후 데이터를 `emit_to`.
- `src/workjournal/{index.html,main.ts,logic.ts}` 새 창 코드 추가 (editmodal/
  briefing과 같은 디렉터리 구조).

## 2. 데이터 모델 변경 (Rust)

`src-tauri/src/plane_api.rs`:
- `RawWorkItem`, `WorkItem`에 `parent_id: Option<String>` 필드 추가.
  `list_work_items`가 이미 `parent`를 평문 UUID로 응답에 포함하고 있으므로
  (Plane 공개 API의 `IssueSerializer`는 `exclude` 방식이라 `parent`가 기본
  포함), API 호출·쿼리 파라미터 변경은 필요 없다 — `RawWorkItem`에
  `#[serde(default)] parent: Option<String>` 추가하고 `map_work_item`에서
  매핑만 하면 된다.

새 모듈 `src-tauri/src/journal.rs` (`briefing.rs`와 나란히):

```rust
pub struct JournalItem {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub project_identifier: String,
    pub priority: String,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub completed_at: Option<String>,
    pub parent_id: Option<String>,
}

pub enum JournalGroup { Completed, InProgress, Upcoming }
```

**그룹 산정 규칙** (`WorkspaceUserWorkReportEndpoint`를 그대로 이식, 이 앱은
항상 "오늘" 하루만 다루므로 활동 로그 기반 스냅샷 재구성은 필요 없다 — 스냅샷
기준 시각이 "지금"이면 현재 `state_group`과 동일하기 때문):

- **완료**: `state_group == "completed"` 이고 `completed_at`의 로컬 날짜가
  오늘인 것만.
- **진행중**: `state_group == "started"` 전체 (날짜 무관, 현재 스냅샷).
- **예정**: `state_group == "unstarted"` 전체만 — **`backlog`는 제외**,
  `cancelled`도 항상 제외.
- 대상은 내게 할당된(assignee) 이슈 전체 (프로젝트 구분 없이 모으고, 이후
  프로젝트별로 다시 묶는다).

**정렬 규칙** (원본 그대로):
- 완료: `completed_at` 내림차순.
- 진행중: `target_date` 오름차순, 없는 것은 뒤로.
- 예정: `start_date`(없으면 `target_date`) 오름차순, 둘 다 없는 것은 뒤로.
- 프로젝트: 이름 가나다순.

**부모 캡션 조회**: 자식의 `parent_id`가 이번에 뽑힌 항목 집합에 없으면(다른
담당자 것이거나 이번 범위 밖 상태), 해당 프로젝트의 기존 `get_work_item()`으로
부모의 이름만 조회해 캡션용으로 보관한다 (parent UUID만으로는 이름을 알 수
없음 — Plane의 경량 참조는 id/sequence_id/project_id만 주기 때문). 조회 실패
(삭제됨 등)면 그 항목은 그냥 최상위 항목으로 표시(캡션 없이).

## 3. 텍스트 포맷 · 클러스터링 (프론트, `src/workjournal/logic.ts`)

`report-body.tsx`의 `clusterByParent` / `badgeFor` / `projectToText`를 TS로
그대로 이식한다.

**그룹 순서 고정**: 완료 → 진행중 → 예정, 항목 없는 그룹은 통째로 생략.
**그룹 라벨 (고정, 커스텀 편집 없음)**: `✅ 완료된 일` / `🔄 진행 중인 일` /
`📌 진행 예정인 일`.

**부모-자식 클러스터링** (깊이 1단계 고정):
- 같은 그룹 안에서 다른 항목이 참조하는 부모는 "승격(promoted)" — 그 부모
  항목 자체가 최상위 줄이 되고 자식들이 바로 아래 붙는다.
- 부모가 이번 그룹에 없으면 "캡션(caption)" — 회색 코드+이름 줄 아래 자식들이
  붙는다.
- 이미 누군가의 부모로 승격된 항목은 그 자체가 다시 자식으로 내려가지 않는다
  (깊이 1 고정).

**항목 한 줄**: `  · {코드 }{이름}{ (우선순위)}{ — 배지}` — 코드/우선순위/배지는
설정이 꺼져있거나 값이 없으면 통째로 생략 (빈 괄호·잔여 `—` 없음). 자식 줄은
들여쓰기 4칸.

**배지 규칙** (`MM-DD` 2자리 고정):
| 그룹 | 조건 | 배지 |
|---|---|---|
| 완료 | 항상 | `MM-DD 완료` |
| 진행중 | 마감 지남 | `N일 지연 · MM-DD 마감` |
| 진행중 | 마감 남음/없음 지남아님 | `D-N · MM-DD 마감` |
| 예정 | 시작일이 미래 | `MM-DD 시작 예정` |
| 예정 | (시작일 조건 미해당) 마감일 있음 | `MM-DD 마감` |
| 예정 | 둘 다 없음 | 배지 없음 |

**프로젝트 헤더**: `[{프로젝트명} / {식별자}]`, `includeProjectName` 꺼지면
헤더 줄 생략(프로젝트 구분은 빈 줄로만).

화면 표시는 텍스트와 별개로 배지 색상(완료 초록/지연 빨강/D-3 이내 주황/그 외
회색 — 원본 색상 그대로) 붙은 카드 UI로 렌더링, "복사" 버튼은 프로젝트
카드별로 하나씩(전체 일괄 복사는 없음 — 원본과 동일).

## 4. 설정 (⚙️ 토글 4개)

모달 안에 작은 설정 버튼 → 팝오버로 4개 토글: 프로젝트명/코드/우선순위/날짜
포함 여부. `localStorage` 키 `plane-quick-dock-journal-settings`에 JSON 저장,
기본값 전부 `true`. (그룹 라벨 커스텀 텍스트 편집은 이번 범위에서 제외 —
원본엔 있지만 이번 요청 범위 밖.)

## 5. 이슈 / 특이사항 메모 (신규 기능, Plane 원본에는 없음)

프로젝트 카드 헤더에 "⚠️ 이슈" 버튼(기본 닫힘, 내용 있으면 테두리 주황).
입력할 때마다 자동 저장, 저장 위치는 `localStorage`, 키는
`plane-quick-dock-journal-note:{오늘 날짜 YYYY-MM-DD}:{프로젝트ID}` — 날짜가
바뀌면 자동으로 빈 칸. 복사 텍스트 마지막에 그룹들 뒤 빈 줄 하나 두고
`⚠️ 금일 이슈 / 특이사항` 섹션으로 추가, 여러 줄 입력 시 각 줄이 `  • ` 불릿.

## 6. 범위 밖 (Non-goals)

- 기간 선택(어제/이번 주 등) — 항상 "오늘"만.
- 팀 보고서(다른 사람 것 보기) — 본인 것만.
- 그룹 라벨 커스텀 텍스트 편집.
- 전체 프로젝트 일괄 복사(카드별 복사만).
