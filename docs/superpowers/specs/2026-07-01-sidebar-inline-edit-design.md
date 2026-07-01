# 사이드바 인라인 편집 + 프로젝트 배지 — 설계 문서

- 작성일: 2026-07-01
- 상태: 승인됨 (목업 확정)
- 작성자: aoperat
- 관련 기존 스펙: [`2026-06-30-plane-quick-dock-design.md`](2026-06-30-plane-quick-dock-design.md)

## 1. 목적

F2(사이드바 단축키) 사이드바에서:
1. 할당된 작업의 **상태**와 **우선순위**를 클릭 한 번으로 바로 변경할 수 있게 한다 (지금은 읽기 전용, 클릭 시 브라우저로 이동만 가능).
2. **내 프로젝트** 목록의 각 행 옆에 "나에게 할당되고 아직 완료/취소되지 않은 항목 수" 배지를 표시한다.

## 2. 범위

### 포함
- 상태 변경: 5개 대분류(백로그/시작 전/진행 중/완료/취소) 중 선택
- 우선순위 변경: 5개 값(긴급/높음/보통/낮음/없음) 중 선택
- 프로젝트별 미완료 할당 개수 배지 (0이면 흐리게 표시, 숨기지 않음)

### 제외 (YAGNI — 추후)
- 프로젝트별 커스텀 상태 이름 노출 (지금은 group 단위로만 편집)
- 담당자/마감일/설명 등 다른 필드 인라인 편집
- 편집 실패 시 재시도 큐 (실패하면 그냥 롤백 + 에러 표시만)

## 3. UI 설계 (목업 확정)

> 확정 목업: [`docs/mockups/sidebar-inline-edit-mockup.html`](../../mockups/sidebar-inline-edit-mockup.html)

- **인터랙션 패턴**: 클릭 → 그 자리에 드롭다운 팝오버가 뜨는 방식 (Linear 스타일). 호버 아이콘이나 상시 노출 칩 방식은 기각 — 사이드바가 320px로 좁아 평소엔 최대한 깔끔하게 유지.
- **상태 점 클릭**: 팝오버에 5개 그룹(백로그/시작 전/진행 중/완료/취소)이 점 색으로 표시, 현재 값에 체크/하이라이트.
- **우선순위 텍스트 클릭**: 팝오버에 5개 값(🚨 긴급/🔴 높음/🟡 보통/⚪ 낮음/— 없음).
- **프로젝트 배지**: 프로젝트 행 오른쪽 끝에 개수. 1 이상이면 파란 필(accent-soft 배경), 0이면 텍스트만 흐리게(`muted-2`, 배경 없음) — 숨기지 않고 항상 자리 차지(레이아웃 흔들림 방지).
- 팝오버는 바깥 클릭 또는 `Esc`로 닫힘. 상태/우선순위 클릭은 `stopPropagation`으로 행 전체의 "브라우저에서 열기" 클릭과 분리되어야 함.

## 4. 데이터 흐름 & 백엔드 변경

### 4.1 프로젝트 배지 — 새 API 불필요
`fetch_sidebar_data`가 이미 반환하는 `assigned: WorkItemDto[]`는 할당+미완료로 필터링된 전체 목록이며 각 항목에 `project_id`가 있다. 프론트에서 `project_id`로 group-by count만 하면 된다. 백엔드 변경 없음.

### 4.2 상태 변경 — 프로젝트별 실제 state 목록 필요

Plane API의 워크아이템 PATCH는 `state` 필드에 **특정 state의 UUID**를 요구한다 (group 이름을 직접 못 씀). 따라서 그룹→실제 state id 매핑이 필요하다.

- `plane_api.rs`
  - `RawState`에 `id` 필드 추가 (`group`만 있던 것에서 확장)
  - 새 구조체 `State { pub id: String, pub group: String }`
  - `PlaneClient::list_states(project_id) -> Result<Vec<State>, String>` 추가 — `GET /api/v1/workspaces/{ws}/projects/{project_id}/states/` 호출
  - `PlaneClient::update_work_item(project_id, item_id, body: serde_json::Value) -> Result<(), String>` 추가 — `PATCH /api/v1/workspaces/{ws}/projects/{project_id}/work-items/{item_id}/`
- `commands.rs`
  - `SidebarData`에 `states: Vec<StateDto>` 필드 추가 (`StateDto { id, group, project_id }`)
  - `fetch_sidebar_data`가 프로젝트별 work-items 조회와 **병렬로** 프로젝트별 states도 조회해 `states`에 합쳐서 반환 (동의된 대로: 새로고침 시 미리 로딩)
  - 새 커맨드: `update_work_item_priority(project_id, item_id, priority: String) -> Result<(), String>`
  - 새 커맨드: `update_work_item_state(project_id, item_id, state_id: String) -> Result<(), String>`
  - 같은 그룹에 state가 여러 개인 프로젝트는 **응답에서 먼저 나온 것**을 사용 (단순화, 커스텀 다중 state 그룹 매핑은 범위 밖)

### 4.3 프론트엔드 변경 (`src/sidebar/main.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`)

- `types.ts`: `State { id, group, project_id }` 추가, `SidebarData`에 `states` 추가
- `ipc.ts`: `updateWorkItemPriority`, `updateWorkItemState` invoke 래퍼 추가
- `main.ts`
  - `renderProjects`: `assigned` 목록을 `project_id`로 group-by한 카운트 맵을 만들어 각 행에 배지 렌더 (0이면 `pcount zero` 클래스)
  - group→stateId 매핑 함수를 순수 함수로 분리: `resolveStateId(states: State[], projectId: string, group: string): string | undefined`
  - `renderTasks`: state-dot / prio 엘리먼트에 클릭 핸들러 추가 → 팝오버 렌더 → 옵션 클릭 시:
    1. optimistic하게 로컬 데이터 갱신 + 재렌더
    2. `updateWorkItemState`/`updateWorkItemPriority` 호출
    3. 실패하면 이전 값으로 롤백, `synced` 상태줄에 "상태 변경 실패: ..." 짧게 표시
  - 팝오버 바깥 클릭/`Esc` 닫기 처리 (기존 사이드바 전체 `Esc`=창 숨김과 충돌하지 않도록, 팝오버가 열려 있을 때는 `Esc`가 팝오버만 닫고 `stopPropagation`)

## 5. 에러 처리

- PATCH 실패(네트워크/401 등): UI 값 롤백 + `synced` 텍스트에 실패 메시지, 콘솔에 상세 로그 (기존 `refresh()` 에러 처리 패턴과 동일하게)
- states 조회 실패(특정 프로젝트): 해당 프로젝트는 states 없이 진행 — 그 프로젝트의 항목은 상태 드롭다운을 열어도 그룹 매핑이 없으면 해당 옵션은 비활성 처리(클릭 무시 + 안내 없음, 범위 밖 엣지케이스)
- 배지 집계는 이미 받아온 데이터의 순수 계산이므로 별도 실패 케이스 없음

## 6. 테스트 전략

- Rust (`plane_api.rs`): `list_states` wiremock 테스트 (states 엔드포인트 파싱), `update_work_item` PATCH 요청 바디/헤더 검증 테스트
- Rust (`commands.rs`): `fetch_sidebar_data`가 `states`를 포함해 조립하는지 통합 테스트 (기존 `assemble_sidebar` 테스트 확장)
- TS (vitest): `resolveStateId` 순수 함수 단위 테스트 (그룹 매칭/중복/누락 케이스), 프로젝트별 배지 카운트 집계 함수 단위 테스트
- 수동 QA: 실제 sidebar 창에서 상태/우선순위 변경 후 Plane 웹에서 반영 확인, 실패 시 롤백 확인 (네트워크 끊고 테스트)

## 7. 열린 결정 (구현 시)

- 같은 group에 state가 여러 개인 프로젝트에서 "먼저 나온 것" 선택 로직이 실사용에서 부적절하면(예: 항상 다른 state로 바뀜), 추후 Plane의 `default` 플래그 활용 여부 재검토
