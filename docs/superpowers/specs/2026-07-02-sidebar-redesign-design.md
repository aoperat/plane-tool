# 사이드바 디자인 개선 (A안 최종 — 칩 방식 + 프로젝트 헤더 개선)

날짜: 2026-07-02
목업: `docs/superpowers/mockups/2026-07-02-sidebar-redesign-mockup.html` (A안 최종 패널)

## 배경 / 문제

- 상태 아이콘·우선순위 텍스트가 클릭 가능하지만 평범한 텍스트처럼 보여 **수정 가능 여부를 구분할 수 없음** (호버 시 dashed 아웃라인이 유일한 힌트).
- 히트 영역이 작음: 상태 아이콘 14px, 헤더 버튼은 이모지(📌⟳⚙)에 패딩 최소.
- 마감일은 표시만 되고 수정 불가, **시작일은 아예 표시되지 않음**. 날짜를 바꾸려면 편집 모달을 열어야 함.
- 프로젝트 그룹 헤더는 접기 가능 여부가 드러나지 않고, 색 점 외에 프로젝트 구분 정보가 없음.

## 목표

편집 가능한 모든 필드(상태·우선순위·기간)를 "항상 버튼처럼 보이게" 만들고, QuickAdd와 UI 문법(칩)을 통일한다. 기능 추가는 최소화하고 기존 IPC/팝오버를 재사용한다.

## 변경 사항

### 1. 헤더 버튼 (sidebar `index.html` + `app.css`)

- 이모지 📌 ⟳ ⚙ → 인라인 SVG 아이콘으로 교체.
- 공통 `.hbtn` 스타일: 28×28px, radius 7px, 호버 시 `--panel-2` 배경 + 텍스트색 상승. 핀 활성 상태는 기존처럼 `--accent` + `--accent-soft` 유지.

### 2. 작업 행 — 칩 방식 (`main.ts` `renderTaskRow` + `app.css`)

레이아웃: 2단 구조.

```
[상태버튼 26px] [작업 제목................] [↗ 호버시]
                [우선순위 칩] [기간 칩]
```

- **상태 버튼**: 26×26px, radius 7px. 평소 테두리 투명, 행 호버 시 `--border` 테두리 + `--bg` 배경, 버튼 호버 시 `--accent` 테두리. 클릭 → 기존 상태 팝오버 그대로.
- **우선순위 칩**: 항상 표시되는 테두리 칩(높이 24px, `--bg` 배경, `--border` 테두리, 호버 시 `--accent` 테두리). 아이콘 + 라벨. 값이 `none`이면 **점선 테두리 + muted 색의 "우선순위" 칩**으로 진입점 노출. 클릭 → 기존 우선순위 팝오버.
- **기간 칩**: 시작일·마감일을 한 칩에 표시. 클릭 → 날짜 팝오버(아래 4번). 표기 규칙 (`formatDateRange(start, target)` 순수 함수, `M/D` 형식):
  - 둘 다 있음: `7/1 → 7/4`
  - 마감일만: `~ 7/8`
  - 시작일만: `7/1 →`
  - 둘 다 없음: 점선 "마감일" 칩 (클릭 시 동일 팝오버)
- **완료된 작업**: 기존 opacity 처리 유지 + 제목 취소선. 기간 칩 대신 `완료 HH:MM` 정보 칩(클릭 불가, 팝오버 없음). 우선순위 칩은 유지.
- 칩 스타일은 QuickAdd의 기존 `.chip`을 공용화해 재사용하고, `.chip.empty`(점선) 변형만 추가.
- 행 클릭 → 편집 모달, 우클릭 → 컨텍스트 메뉴, 호버 시 브라우저 열기 버튼: 모두 기존 동작 유지. 브라우저 버튼은 제목 행 오른쪽 끝(현 위치와 동일).

### 3. 시작일 데이터 파이프라인 (Rust + TS)

`start_date`가 현재 사이드바 목록 경로에 없음. 추가:

- `plane_api.rs` `WorkItem` 구조체에 `start_date: Option<String>` 추가, `map_work_item`에서 매핑 (RawWorkItem에는 이미 있음).
- `commands.rs` `WorkItemDto`에 `start_date` 추가.
- `src/shared/types.ts` `WorkItem`에 `start_date: string | null` 추가.

### 4. 날짜 팝오버 (사이드바 신규, 기존 부품 재사용)

- QuickAdd의 날짜 프리셋(`shared/datePresets.ts`의 `DATE_PRESETS`: 오늘/내일/다음 주 등) + 네이티브 date input 2개(시작일/마감일)를 담은 팝오버.
- 사이드바의 기존 `attachPopover`(body 기준 fixed 위치, 화면 클램프)로 부착 — 행 내부 부착 시 아래 행에 가려지는 문제 회피.
- 날짜 변경 시 기존 `update_work_item_fields` 커맨드 호출(`start_date`/`target_date`만 전달). 성공 시 낙관적 갱신, 실패 시 롤백 + `synced`에 오류 표시 — 상태/우선순위 변경과 동일한 패턴.
- 프리셋 클릭은 **마감일**을 설정한다(시작일은 date input으로만 변경).
- 날짜 지우기: 각 input 옆 "지움" 버튼 → IPC로 빈 문자열 `""` 전달. `build_update_body`에서 `start_date`/`target_date`에 한해 빈 문자열을 JSON `null`로 변환해 전송한다(현재는 문자열을 그대로 보냄 — 이 변환 규칙을 추가하고 단위 테스트 포함). `None`은 기존대로 "변경 없음".

### 5. 프로젝트 그룹 헤더 (`renderTasks` + `app.css`)

- 헤더 행 전체를 버튼화: padding 6px 8px, radius 7px, 호버 시 `--panel-2` 배경. 접힘 시 ▾ 회전(기존 유지). sticky 유지.
- **식별자 배지**: `project.identifier` (이미 프론트까지 내려옴) — 9.5px, `--muted-2`, `--border` 테두리 pill. identifier가 빈 문자열이면 미표시.
- **진행률**: 카운트 `N` → SVG 링(14px) + `완료/전체` 텍스트. 완료 = 그룹 내 `state_group === "completed"` 항목 수. 계산은 순수 함수 `groupProgress(items)` 로 분리.
- **`+` 버튼** (호버 시 표시): 클릭 → 신규 커맨드 `show_quickadd_for_project(project_id)`:
  1. `config::set_last_project`로 프로젝트 저장
  2. quickadd 창에 `select-project` 이벤트 emit (payload: project_id)
  3. quickadd 창 표시 + 포커스 (기존 `toggle_quickadd`의 모니터 배치 로직을 `show_quickadd`로 추출해 재사용)
  - QuickAdd 프론트는 `select-project` 이벤트를 수신해 `selectedId` 갱신 + 칩 라벨 재렌더.
  - 클릭 시 `e.stopPropagation()`으로 그룹 접힘 토글과 분리.

## 변경하지 않는 것

- 사이드바 폭(320px), 슬라이드 애니메이션, 새로고침/쿨다운 로직, 편집 모달, 컨텍스트 메뉴, 삭제 확인, 설정/테마.
- 상태·우선순위 팝오버의 내용과 동작(앵커만 새 버튼/칩으로 바뀜).

## 테스트

- **vitest (순수 함수)**: `formatDateRange` 4가지 표기 규칙, `groupProgress` 완료/전체 계산. 기존 `logic.test.ts`에 추가.
- **cargo test**: `list_work_items`가 `start_date`를 파싱하는지 기존 wiremock 테스트에 필드 추가로 검증. `build_update_body`의 빈 문자열→null 변환 테스트. `show_quickadd_for_project`는 창 의존이라 단위 테스트 제외(수동 확인).
- **수동 확인**: 칩 클릭→팝오버→서버 반영, 실패 시 롤백 문구, `+` 버튼→QuickAdd 프로젝트 프리셀렉트, 라이트 테마 확인.

## 구현 순서 (플랜 개요)

1. Rust: `start_date` 파이프라인 + 테스트
2. CSS: `.hbtn`/`.chip` 공용화, 새 사이드바 스타일
3. 헤더 SVG 교체
4. 작업 행 칩 렌더링 + `formatDateRange` + 테스트
5. 날짜 팝오버 + 업데이트 연동
6. 그룹 헤더(배지·진행률·`+`) + `show_quickadd_for_project`
