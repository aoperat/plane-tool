# 사이드바 할 일 수정 모달 설계

## 배경

지금 사이드바(`src/sidebar/main.ts`)에서 할 일 로우를 좌클릭하면 바로 브라우저로 해당 이슈가 열린다. 우클릭 메뉴는 이미 [[2026-07-01-sidebar-context-menu-design]]에서 구현되어 복사본 만들기/새 탭에서 열기/링크 복사/삭제를 지원한다.

이번 작업은 좌클릭 동작을 "브라우저 열기"에서 "수정 모달 열기"로 바꾸고, 브라우저 열기는 버튼(우클릭 메뉴 + 모달 헤더 + 로우 호버 아이콘) 경로로만 가능하게 한다. 브레인스토밍 중 브라우저 목업(`.superpowers/brainstorm/13085-1782907714/content/modal-placement.html`)으로 배치를 비교했고, "별도 창(QuickAdd 방식)"을 채택했다.

## 아키텍처 — 새 Tauri 창 `editmodal`

`quickadd`와 같은 패턴으로 새 창을 `tauri.conf.json`에 추가한다:

```json
{
  "label": "editmodal",
  "url": "src/editmodal/index.html",
  "width": 480, "height": 320,
  "decorations": false, "transparent": true, "alwaysOnTop": true,
  "skipTaskbar": true, "visible": false, "center": true, "resizable": true
}
```

OS 타이틀바 없이 HTML로 자체 헤더(제목 "할 일 수정" + 🌐 브라우저에서 열기 버튼 + ✕ 닫기)를 그린다. QuickAdd의 `resizeToFit()` 패턴을 그대로 재사용해 description textarea 등 콘텐츠 높이에 맞춰 창 높이를 조절한다.

**여는 흐름:**
1. 사이드바 로우 클릭 → 신규 Tauri 커맨드 `open_edit_modal(app, project_id, item_id)` 호출. 이 커맨드는 `editmodal` 창을 `show()`하고 `app.emit_to("editmodal", "load-item", { project_id, item_id })`로 어떤 아이템을 열지 알린다.
2. `editmodal` 프론트엔드는 `load-item` 이벤트를 받으면 신규 백엔드 커맨드 `get_work_item(project_id, item_id)`로 최신 상세 데이터(설명 포함)를 가져와 폼을 채운다. fetch 중에는 폼 대신 "불러오는 중…" 텍스트를 보여준다(QuickAdd에 스피너 컴포넌트가 없으므로 동일한 최소 수준으로 통일).
3. 이미 `editmodal`이 다른 아이템을 보여주는 중에 새 `load-item`이 오면(사이드바에서 다른 로우를 다시 클릭한 경우), 저장하지 않은 변경사항은 확인 없이 버리고 새 아이템으로 교체한다 — QuickAdd의 "매번 리셋" 정책과 동일.

**닫는 흐름 / 사이드바와의 상호작용:**
- `Esc` 또는 헤더 ✕ 클릭 → 저장하지 않은 변경사항을 확인 없이 버리고 창을 `hide()`.
- QuickAdd처럼 **창 포커스를 잃어도 자동으로 닫히지 않는다** (수정 중 다른 창을 확인하러 갔다 와도 안전).
- `editmodal`이 포커스를 얻으면 사이드바는 기존 blur 리스너에 따라 pinned가 아닌 이상 슬라이드아웃된다 — 지금 브라우저를 열 때 이미 벌어지는 동작과 동일하므로 별도 처리 불필요.
- 저장/삭제 성공 시 `editmodal`이 `getCurrentWindow().emitTo("sidebar", "refresh-sidebar")`를 호출하고, 사이드바는 `win.listen("refresh-sidebar", refresh)`로 받아 기존 `refresh()`(전체 재조회)를 실행한다 — 두 창이 별도 프로세스이므로 로컬 배열을 직접 공유할 수 없어, 기존 앱 전반의 "성공 후 전체 refresh" 컨벤션을 그대로 따른다.

## 필드 & 상호작용

QuickAdd와 동일한 7개 필드 — title, description, 담당자, 시작일, 마감일, 우선순위, 진행상태. QuickAdd의 칩/팝오버 컴포넌트를 그대로 재사용한다(`shared/planeIcons.ts`, `.chip`/`.pop` CSS 등). description은 QuickAdd와 달리 **처음부터 펼쳐진 상태**로 보여준다 — 수정 화면이므로 기존 내용을 바로 봐야 하기 때문.

- **저장**: 폼 하단 취소/저장 버튼. `Ctrl+Enter`로도 저장(QuickAdd와 일관된 단축키).
- **삭제**: 저장/취소 버튼과 반대쪽(왼쪽)에 작게 배치. 클릭하면 기존 사이드바 컨텍스트 메뉴의 삭제 확인 팝오버와 같은 패턴("정말 삭제하시겠습니까?" + 삭제/취소)이 같은 자리에 뜬다. 확인 시 기존 `deleteWorkItem` IPC(`src/shared/ipc.ts`)를 호출하고, 성공하면 `refresh-sidebar` 이벤트를 보낸 뒤 모달을 닫는다.
- **저장 실패 시**: 모달 안에 인라인 에러 메시지를 띄우고 모달은 닫지 않는다(재시도 가능). 별도 창이라 사이드바의 `synced` 상태줄을 재사용할 수 없으므로 모달 자체에 작은 에러 영역을 둔다.
- **브라우저에서 열기** — 세 곳에서 모두 가능, 어느 쪽도 모달을 닫지 않는다:
  1. 사이드바 로우 우클릭 메뉴의 기존 "새 탭에서 열기" (변경 없음)
  2. 로우에 마우스를 올렸을 때만 보이는 작은 아이콘(상태/우선순위 아이콘과 같은 자리 스타일)
  3. 모달 헤더의 🌐 버튼

## 데이터 흐름 / 백엔드 변경

- **`plane_api.rs`**: `WorkItem`에 `description_html: Option<String>`, `start_date: Option<String>` 필드를 추가한다(목록 조회 시에는 채워지지 않을 수 있으므로 모달은 항상 아래 `get_work_item`으로 새로 가져온다).
- **`plane_api.rs`**: 신규 `PlaneClient::get_work_item(project_id, item_id) -> Result<WorkItem, String>` — `GET .../work-items/{id}/?expand=assignees,state`, 기존 `list_work_items`의 `RawWorkItem` 매핑 로직을 재사용.
- **`commands.rs`**: 신규 `get_work_item` 커맨드(위 메서드를 얇게 감쌈), 신규 `open_edit_modal(app, project_id, item_id)` 커맨드(창 show + `load-item` 이벤트 emit).
- **`commands.rs`**: 신규 `update_work_item_fields(app, project_id, item_id, ...)` 커맨드 — 모달에서 **원래 불러온 값과 달라진 필드만** 골라 PATCH 바디를 만들어 기존 제네릭 `PlaneClient::update_work_item`으로 보낸다. 현재 우선순위/상태 변경 커맨드가 각각 단일 필드만 보내는 것과 같은 컨벤션이며, 매번 7개 필드 전부를 보내지 않는다. 이 diff 계산은 프론트(`editmodal/main.ts`)에서 수행해 바뀐 필드만 커맨드 인자로 넘긴다(빈 필드는 생략).
- description ↔ description_html 변환은 [[2026-07-01-quickadd-description-design]]에서 설계한 `plain_text_to_description_html`을 그대로 재사용한다. 반대 방향인 `description_html_to_plain_text`(표시용, `<p>` 태그 제거·HTML 엔티티 디코드·줄바꿈 복원)를 `plane_api.rs`에 새로 추가한다.
- 삭제는 기존 `deleteWorkItem` IPC/`delete_work_item` 커맨드를 그대로 재사용 — 신규 백엔드 코드 없음.

## 범위 제한 (의도적으로 뺀 것)

- **프로젝트 이동**: QuickAdd는 프로젝트를 고르지만, 수정 모달에서 다른 프로젝트로 이슈를 옮기는 기능은 Plane 자체에서도 별도 기능(move)으로 복잡도가 높아 이번 범위에서 제외한다.
- **변경사항 확인 다이얼로그**: Esc/✕로 닫을 때 "저장하지 않았습니다" 같은 확인 없이 그냥 버린다 — QuickAdd의 기존 Esc 정책과 동일하게 가볍게 취급.
- **로딩 스켈레톤 애니메이션**: 별도 스피너 컴포넌트 없이 텍스트("불러오는 중…")로만 표시.
- **동시 편집 충돌 처리**: 모달이 열려있는 동안 같은 이슈가 Plane 웹 등 다른 곳에서 바뀌어도 감지/경고하지 않는다(단일 사용자 개인 도구이므로 리스크 낮음).

## 테스트

- Rust: `get_work_item`에 대한 wiremock 테스트(`expand=assignees,state` 쿼리, description_html/start_date 파싱 확인) — `list_work_items_parses_expanded_state_and_assignees`와 같은 패턴.
- Rust: `description_html_to_plain_text`에 대한 유닛 테스트 — `<p>` 분리/엔티티 디코드/빈 입력.
- Rust: diff 기반 PATCH 바디 구성 로직에 대한 유닛 테스트(바뀐 필드만 포함되는지).
- 프론트(`editmodal/main.ts`)는 QuickAdd와 동일하게 순수 DOM 로직이라 자동 테스트를 추가하지 않고, `pnpm exec tsc --noEmit` + 수동 실행으로 검증한다(기존 컨벤션 유지).
