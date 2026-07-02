# 설명 입력 토글 (QuickAdd + 수정모달) — 설계

날짜: 2026-07-02
목업: `docs/mockups/quickadd-description-toggle-mockup.html` (사용자 승인됨)

## 문제

QuickAdd와 수정모달 모두 설명 textarea가 항상 표시된다. 설명은 대부분 비워두는 필드라
공간만 차지한다. 또한 수정모달(480px)은 칩 내용이 길면 칩 로우가 두 줄로 꺾인다.

## 변경안

### 설명 토글 칩

- 칩 로우 **맨 오른쪽**에 "설명" 토글 칩을 추가한다. `margin-left: auto`로 필드 값
  칩들(담당자/날짜/상태/우선순위)과 시각적으로 분리 — 값 선택이 아니라 UI 토글이기 때문.
- off(기본): muted 톤. on: 액센트 색 + `--accent-soft` 배경 + 액센트 테두리.
- 아이콘은 `currentColor` stroke의 문서 라인 SVG (`DESCRIPTION_ICON`, planeIcons.ts에 추가)
  — 칩 상태(muted/액센트)를 따라 색이 바뀐다.
- 토글 on → 설명 textarea가 제목 아래(기존 위치)에 나타나고 포커스 이동.
  off → textarea만 숨기고 **내용은 유지**(제출/저장 시 그대로 반영).

### QuickAdd (`src/quickadd/`)

- 설명 textarea는 `hidden`으로 시작. 토글 상태는 팝업이 리셋될 때(`resetFields`) off로 초기화.
- ArrowLeft/Right 칩 내비게이션 배열 끝에 토글 칩 포함.

### 수정모달 (`src/editmodal/`)

- 아이템 로드 시 설명이 **있으면 토글 자동 on** (기존 내용이 안 보이면 지워진 걸로
  오해할 수 있으므로), 없으면 off.
- 저장 로직은 변경 없음 — textarea 값은 숨김 여부와 무관하게 유지되므로 기존
  "original과 다르면 PATCH" 비교가 그대로 동작한다.

### 칩 로우 한 줄 보장 + 모달 폭 통일

- `.chip-row`: `flex-wrap: wrap` → `nowrap`. 어떤 환경에서도 줄바꿈이 구조적으로 불가능.
- `.chip`: `flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden` —
  극단적으로 긴 라벨(긴 멤버 이름 등)은 칩이 줄어들며 잘린다.
- 토글 칩은 `flex: none` — 절대 줄어들지 않는다.
- 수정모달 폭 480px → **540px** (QuickAdd와 동일): CSS `.editmodal`,
  `resizeToFit()`의 `LogicalSize`, `tauri.conf.json`의 editmodal 창 폭 3곳.

## 범위 밖

- 사이드바/설정 화면 변경 없음.
- 설명 필드의 리치 텍스트 지원 없음 (기존 plain text 유지).
