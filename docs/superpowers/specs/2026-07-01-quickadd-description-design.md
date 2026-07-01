# QuickAdd 설명(description) 입력 설계

## 배경

[[2026-07-01-quickadd-field-expansion-design]]에서 담당자/시작일/마감일/우선순위/진행상태 칩을 추가하면서 설명(description)은 의도적으로 범위에서 제외했다. 이번 작업은 QuickAdd에서 title 한 줄 입력의 빠른 흐름을 유지하면서, 필요할 때만 description을 함께 입력할 수 있도록 확장한다.

## UI / 상호작용

`popup-top` 행(accent-bar + title-input)에 작은 토글 아이콘 버튼을 title 옆에 추가한다. 버튼을 클릭하면 title 아래, chip-row 위에 3줄짜리 `<textarea>`(리사이즈 불가, 팝업 너비에 맞춤)가 펼쳐진다. 다시 클릭하면 접히지만 입력한 텍스트는 유지된다(팝업을 닫을 때까지).

```
┌─────────────────────────────────────────────┐
│ ┃ 작업 제목 입력...                      [≡] │  ← title-input + 토글 아이콘
│  설명을 입력하세요...                          │  ← 펼쳐진 description textarea (기본 접힘)
│  [나] [📅 오늘] [🚩 오늘] [▬ 없음] [○ Todo]     │  ← 기존 칩 툴바
├─────────────────────────────────────────────┤
│ [● 프로젝트 선택 ▾]              Enter 추가 · Esc 닫기│
└─────────────────────────────────────────────┘
```

**키보드:**
- title에서 **Tab**: description이 접혀 있으면 `preventDefault()`하고 펼친 뒤 포커스를 이동한다. 이미 펼쳐진 상태라면 가로채지 않고 브라우저 기본 Tab 동작에 맡긴다 — 토글 아이콘 버튼에 `tabindex="-1"`을 줘서 tab 순서에서 제외하면, 펼쳐졌을 때 title 다음 포커스는 자연히 textarea로 간다.
- title / description 어디서든 **Ctrl+Enter**: 현재 입력값으로 바로 제출(기존 title Enter 제출 로직 재사용).
- title에서 **Enter**(기존 동작 유지): 제출. description이 비어 있어도 그대로 제출된다.
- description에서 **Enter**: 제출하지 않고 줄바꿈만 수행(textarea 기본 동작, 별도 처리 불필요).

**리셋:** 제출 성공 후, 그리고 팝업이 다시 포커스를 받을 때(`tauri://focus`, 기존 `resetFields()` 호출 지점) description 값과 펼침 상태를 모두 초기화한다 — 다른 필드들이 이미 매번 리셋되는 것과 동일한 정책.

**아이콘:** `shared/planeIcons.ts`에 기존 `CALENDAR_ICON`/`FLAG_ICON`과 같은 스타일(13x13, `stroke="#8a909c"`)로 텍스트 줄 모양의 `DESCRIPTION_ICON`을 추가한다. description에 내용이 있거나 펼쳐진 상태일 때는 버튼에 `active` 클래스를 줘서 강조한다.

**리사이즈:** `resizeToFit()`은 이미 `.popup` 전체의 `getBoundingClientRect().height`를 측정하므로, textarea가 문서 흐름에 있는 일반 엘리먼트로 펼쳐지면 별도 코드 변경 없이 창 높이가 자동으로 늘어난다.

## 데이터 흐름 / 백엔드 변경

- **프론트 (`shared/ipc.ts`)**: `createIssue()`에 `description: string` 파라미터를 추가하고 `invoke("create_issue", { ..., description })`으로 평문 텍스트를 그대로 전달한다.
- **백엔드 (`commands.rs`)**: `create_issue` 커맨드가 `description: Option<String>`(빈 문자열은 `None`으로 취급)을 받아 `NewWorkItem`에 실어 보낸다.
- **백엔드 (`plane_api.rs`)**:
  - `NewWorkItem<'a>`에 `description_html: Option<String>` 필드를 추가한다.
  - 평문 → HTML 변환 함수 `plain_text_to_description_html(text: &str) -> String`을 새로 추가한다: `&`, `<`, `>`를 이스케이프하고, 줄바꿈 단위로 각 줄을 `<p>...</p>`로 감싼다. 이 변환은 `commands.rs`의 `create_issue`에서 `description`이 비어있지 않을 때만 호출한다.
  - `create_work_item`의 POST JSON 바디에 `"description_html"` 필드를 추가한다. 기존 `start_date`/`target_date`와 동일한 패턴으로 `Option<String>`을 그대로 `serde_json::json!` 매크로에 넘기면 `None`은 자동으로 `null`로 직렬화된다(필드 자체는 항상 포함, 값만 `null`) — Plane 서버는 `null`을 빈 설명으로 처리한다.
  - 근거: [Plane API — Create a work item](https://developers.plane.so/api-reference/issue/add-issue) 문서에 요청 바디 필드로 `description_html`, `description_stripped`가 문서화되어 있다.

## 범위 제한 (의도적으로 뺀 것)

- 리치 텍스트 편집(굵게, 목록, 링크 등)은 지원하지 않는다 — 평문 textarea만 지원하고, 줄바꿈만 `<p>` 단락으로 변환한다.
- description 텍스트는 팝업이 열려 있는 동안만 유지된다. 팝업이 닫혔다가 다시 열리면(포커스 재획득) 초기화된다.

## 테스트

- Rust: `plain_text_to_description_html`에 대한 유닛 테스트 — HTML 특수문자 이스케이프, 멀티라인 입력이 여러 `<p>`로 분리되는지, 빈 문자열 입력 시 처리.
- 프론트(`quickadd/main.ts`)는 기존과 동일하게 순수 DOM 로직이라 별도 테스트를 추가하지 않는다(기존 컨벤션 유지).
