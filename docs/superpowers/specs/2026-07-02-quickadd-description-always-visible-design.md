# QuickAdd 설명(description) 입력 — 토글 제거, 상시 표시로 전환

## 배경

[[2026-07-01-quickadd-description-design]]에서 title 옆 토글 아이콘 버튼으로 description textarea를 펼치고/접는 방식을 도입했다. 실사용해보니 토글이라는 개념 자체가 불필요하다는 피드백이 있었다: 버튼이 작아 발견성이 낮고, 매번 클릭해서 펼쳐야 하는 것이 키보드 중심 워크플로우에 방해가 된다. 이번 작업은 토글 버튼과 펼침/접힘 상태를 완전히 제거하고, description textarea를 처음부터 항상 보이는 요소로 바꾼다.

## UI / 상호작용

`popup-top` 행의 토글 아이콘 버튼(`#descToggle`)을 제거한다. `<textarea id="description">`은 `hidden` 없이 항상 렌더링되며, 기본 높이는 1줄이다.

```
┌─────────────────────────────────────────────┐
│ ┃ 작업 제목 입력...                          │  ← title-input (토글 버튼 없음)
│  설명을 입력하세요...                          │  ← 항상 보이는 description textarea (1줄, 자동 확장)
│  [나] [📅 오늘] [🚩 오늘] [▬ 없음] [○ Todo]     │  ← 기존 칩 툴바
├─────────────────────────────────────────────┤
│ [● 프로젝트 선택 ▾]              Enter 추가 · Esc 닫기│
└─────────────────────────────────────────────┘
```

**자동 확장(auto-grow):** description에 여러 줄을 입력하면 textarea 자체의 높이가 내용에 맞춰 늘어난다(리사이즈 핸들 없음, 사용자가 직접 드래그해서 키우는 기능은 없음). `input` 이벤트마다 `height`를 `"auto"`로 리셋한 뒤 `scrollHeight`만큼 다시 지정하는 방식으로 구현한다.

**키보드:**
- title에서 **Tab**: 더 이상 가로채지 않는다. description이 항상 문서 흐름에 존재하므로, 브라우저 기본 Tab 순서(title → description → 칩들)를 그대로 따른다. 기존의 "펼치기 위한 Tab 가로채기" 로직은 제거한다.
- title / description 어디서든 **Ctrl+Enter**: 기존과 동일하게 즉시 제출.
- title에서 **Enter**(기존 동작 유지): 제출. description이 비어 있어도 그대로 제출된다.
- description에서 **Enter**: 제출하지 않고 줄바꿈만 수행(기존과 동일).

**리셋:** 제출 성공 후, 그리고 팝업이 다시 포커스를 받을 때(`tauri://focus`, 기존 `resetFields()` 호출 지점) description 값을 비우고 높이를 1줄로 되돌린다. "펼침/접힘 상태"라는 개념 자체가 없어지므로 관련 상태 변수(`descriptionOpen`)와 그 상태를 리셋하는 코드는 제거한다.

**스타일:** `.desc-toggle`, `.desc-toggle:hover`, `.desc-toggle.active`, `.description-input[hidden]` 규칙을 제거한다. `.description-input`에 `overflow: hidden`을 추가해 auto-grow 중 스크롤바가 잠깐 보였다 사라지는 현상을 막는다. `.icon-btn`은 사이드바(`sidebar/main.ts`)에서도 쓰는 공용 클래스이므로 그대로 둔다.

**아이콘:** `shared/planeIcons.ts`의 `DESCRIPTION_ICON`은 토글 버튼 전용이었고 다른 곳에서 쓰이지 않으므로 제거한다.

**리사이즈:** `resizeToFit()`은 이미 `.popup` 전체의 `getBoundingClientRect().height`를 측정하므로, textarea 높이가 auto-grow로 바뀌어도 별도 코드 변경 없이 창 높이가 자동으로 따라간다. `input` 이벤트 핸들러에서 높이 조정 후 `resizeToFit()`을 호출하기만 하면 된다.

## 데이터 흐름 / 백엔드 변경

없음. `createIssue()` 파라미터, `create_issue` 커맨드, `NewWorkItem.description_html`, `plain_text_to_description_html` 등 [[2026-07-01-quickadd-description-design]]에서 정의한 백엔드 계약은 그대로 유지한다. 빈 설명은 여전히 백엔드에서 `None`으로 취급되어 `description_html: null`로 전송된다(변경 없음).

## 범위 제한 (의도적으로 뺀 것)

- 리치 텍스트 편집은 여전히 지원하지 않는다 — 평문 textarea, 줄바꿈만 `<p>` 단락으로 변환(기존 정책 유지).
- description 텍스트는 팝업이 열려 있는 동안만 유지되고, 팝업이 닫혔다가 다시 열리면 초기화된다(기존 정책 유지).
- textarea 최대 높이 제한(예: 일정 줄 수 이상이면 내부 스크롤로 전환)은 두지 않는다 — 팝업 창 자체가 내용에 맞춰 커지는 기존 동작을 그대로 따른다.

## 테스트

- 프론트(`quickadd/main.ts`, `index.html`, `app.css`)는 순수 DOM/스타일 변경이라 자동 테스트를 추가하지 않는다(기존 컨벤션 유지). `pnpm exec tsc --noEmit`으로 타입 체크하고, 수동으로 QuickAdd를 띄워 다음을 확인한다: description이 처음부터 보이는지, 여러 줄 입력 시 높이가 늘어나며 팝업 창도 같이 커지는지, Tab이 title→description→칩 순서로 자연스럽게 이동하는지, 제출/리셋 후 1줄 높이로 돌아오는지.
- Rust 쪽 변경 없음 — 기존 `plain_text_to_description_html` 테스트는 그대로 유지된다.
