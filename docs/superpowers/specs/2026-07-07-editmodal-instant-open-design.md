# 수정 모달 즉시 열기 설계

## 배경

지금 사이드바에서 로우를 클릭해 수정 모달([[2026-07-01-sidebar-edit-modal-design]])을 열면, 이미 동기화로 받아둔 이름/날짜/상태/우선순위 등을 그대로 다시 요청해 "불러오는 중…" 스피너를 거친 뒤 폼을 보여준다(`src/editmodal/main.ts:290-322`). 동기화 시점(`fetch_sidebar_data`)과 상세보기 시점(`get_work_item`)이 받아오는 필드는 `description`을 빼면 사실상 동일해, 이 대기가 불필요하다.

이번 설계는 모달을 열자마자 이미 갖고 있는 동기화 데이터로 즉시 폼을 채우고 바로 편집 가능하게 하되, `description`(동기화에는 없음)과 최신 서버 상태 확인은 백그라운드로 처리한다.

## 데이터 확장 — 동기화에 assignee_ids 포함

`src-tauri/src/commands.rs`의 `WorkItemDto`(사이드바로 내려가는 실제 DTO)에는 지금 `assignee_ids`가 없다 — 내부 `plane_api::WorkItem`엔 있지만 `assemble_sidebar()`가 DTO로 변환하며 버린다. 이 필드를 추가하지 않으면 즉시 표시 시 담당자 칩이 항상 "담당자 없음"으로 잘못 뜬다.

- `WorkItemDto`에 `assignee_ids: Vec<String>` 추가, `assemble_sidebar()`에서 채움. 이미 받는 응답의 값을 버리지 않는 것뿐이라 API 호출 추가 없음.
- `src/shared/types.ts`의 `WorkItem`에도 `assignee_ids: string[]` 추가.
- 오프라인 캐시(`offline::save_cache`)는 이 구조체를 그대로 직렬화하므로 캐시 포맷도 자연히 새 필드를 포함한다 — 필드 추가라 기존 캐시 파일과도 하위 호환.

## 스냅샷 전달 — 클릭 시점에 이미 가진 데이터를 함께 넘김

사이드바 창과 editmodal 창은 별개 프로세스라 로컬 배열을 공유할 수 없다. 클릭 시점에 사이드바가 이미 갖고 있는 항목 객체를 IPC로 함께 실어 보낸다.

- `openEditModal(project_id, item_id)` → `openEditModal(project_id, item_id, snapshot?: WorkItem)`로 확장(`src/shared/ipc.ts`).
- 일반 작업 목록 클릭(`src/sidebar/main.ts:577`)은 클릭한 `it` 객체 전체를 `snapshot`으로 전달.
- "맡긴 작업" 목록 클릭(`src/sidebar/main.ts:796`)은 `PendingAssignment`에 `state_group`/`assignee_ids`가 없어 완전한 스냅샷을 만들 수 없다 — `snapshot`을 생략하고 기존 스피너 플로우로 폴백한다.
- `open_edit_modal` Rust 커맨드(`commands.rs:601-612`)는 `snapshot: Option<WorkItemDto>`를 받아 `load-item` 이벤트 payload(`{ projectId, itemId, snapshot }`)에 그대로 실어 emit한다.

## editmodal 로딩 플로우 (`src/editmodal/main.ts`)

`loadItem()`이 `snapshot`을 받은 경우:

1. 전체 로딩 스피너 없이 즉시 `emForm`을 보여주고 이름/담당자/시작일/마감일/우선순위/상태를 채운다 — 이 시점부터 바로 편집 가능.
2. `description` 칩은 "불러오는 중…"으로 표시하고 클릭 비활성화(설명이 "없음"인지 "아직 못 불러옴"인지 구분해야 하므로).
3. 동시에 백그라운드로 기존 `getWorkItem()`을 호출한다. 완료되면:
   - description 칩을 활성화하고 값 채움 — 내용이 있으면 자동 펼침(기존 정책 유지), 없으면 숨김 유지.
   - 이 응답으로 받은 `WorkItemDetail`을 `latestOriginal`로 저장해둔다(저장 시 비교용 — 아래 참고). 스냅샷 기반으로 이미 채워둔 폼 값은 덮어쓰지 않는다(사용자가 이미 편집 중일 수 있으므로).
4. `snapshot`이 없는 경우(폴백)는 기존 동작(전체 스피너 → 폼) 그대로 유지.

## 저장 시 충돌 검사

- Save 클릭 시 백그라운드 fetch가 아직 진행 중이면 Save 버튼을 잠그고 완료를 기다린다(보통 수백 ms 이내).
- fetch 성공 후: `snapshot`(사용자가 처음 본 값)과 `latestOriginal`(방금 받은 최신 서버 값)을 비교한다.
  - 다른 필드가 하나도 없으면 조용히 기존 `save()` 로직대로 진행(비교 기준을 `latestOriginal`로 사용 — description 등 정확한 diff 가능).
  - 다른 필드가 있으면 "이 항목이 그 사이 변경되었습니다. 그대로 저장하시겠습니까?" 확인 대화상자를 띄운다.
    - 확인 → 현재 폼 값과 `latestOriginal`을 기준으로 diff해 저장(기존 `save()`의 필드별 diff 로직 재사용, 기준값만 최신화).
    - 취소 → 저장하지 않고 모달에 남는다. 사용자가 값을 다시 확인하고 재시도.
- 백그라운드 fetch 자체가 실패하면(오프라인 등) `snapshot`을 기준값으로 폴백해 저장을 진행한다 — 기존 오프라인 큐잉 경로(`queue_and_patch` 등)를 그대로 탄다.

## 범위 제한 (의도적으로 뺀 것)

- 동일 항목을 모달을 닫지 않고 재오픈할 때의 기존 캐시 재사용 단락(`original && pid===projectId && iid===itemId`, `editmodal/main.ts:277-281`)은 그대로 유지 — 이번 변경과 무관.
- 필드별 세밀한 충돌 하이라이트(어떤 필드가 바뀌었는지 구분 표시)는 넣지 않는다 — 확인창은 단순 예/아니오.
- description을 제외한 필드에 대해서도 "불러오는 중" 상태를 표시하지 않는다 — snapshot 값을 신뢰하고 즉시 편집 가능하게 둔다(그 사이 값이 바뀌었으면 저장 시점 확인창에서만 걸러낸다).

## 테스트

- Rust: `assemble_sidebar()`가 `assignee_ids`를 그대로 통과시키는지 유닛 테스트.
- 프론트(`editmodal/main.ts`)는 기존 컨벤션대로 자동 테스트 없이 `pnpm exec tsc --noEmit` + 수동 실행(스냅샷 있는 경우/없는 경우, 저장 시 충돌 확인창, 오프라인 폴백)으로 검증한다.
