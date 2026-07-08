# 사이드바 "내가 할당한 작업" 탭 — 설계 스펙

- 날짜: 2026-07-08
- 상태: 사용자 승인 대기
- 대체함: `2026-07-03-assignment-awareness-design.md`의 Part B("맡긴 작업 창")

## 목적

사이드바가 지금은 "나에게 할당된 작업"만 보여준다. 사용자가 다른 사람에게
위임한 작업의 진척을 확인할 방법이 없다. 별도 창이 아니라 기존 사이드바
안에 탭을 하나 추가해, 위임한 일의 상태를 가볍게 훑어볼 수 있게 한다.

**범위 밖**: 할당 확인 여부(✓) 추적, Plane 댓글 마커, 지연/정체 자동 판정,
리마인드 알림. 이 기능들은 필요해지면 별도 스펙으로 다시 다룬다.

## 핵심 설계 결정

1. **"내가 할당한 작업"의 정의는 `created_by == 나` AND `assignee_ids`에
   내가 없음이다.** Plane API에는 "누가 할당했는가(assigned_by)"를 나타내는
   필드가 없다 (`IssueAssignee` 모델 확인 완료). 이 근사치는 "작업을 만든
   사람이 그 자리에서 담당자를 지정한다"는 일반적인 흐름에서는 정확하지만,
   **남이 만든 작업을 내가 나중에 제3자에게 재할당한 경우는 잡히지 않는다.**
   이는 알려진 한계로 남긴다.
2. **새 창이 아니라 기존 사이드바에 탭 2개**(담당 작업 / 내가 할당한 작업)로
   구현한다. 별도 창·단축키·설정 추가가 필요 없어 구현 범위가 작다.
3. **탭 전환은 추가 API 호출을 만들지 않는다.** 백엔드가 두 탭 분량을 한
   번의 fetch로 함께 가져와 캐시하고, 탭 전환은 이미 받은 데이터를
   필터링해서 보여주는 것뿐이다. 오프라인에서도 즉시 전환 가능.

## 데이터 / 필터 (`src-tauri/src/plane_api.rs`)

기존 `filter_assigned_visible` 옆에 대칭 함수를 추가한다. **완료 항목의
날짜창 적용은 백엔드에서 하지 않는다** — "오늘만 보기" 토글은 탭 전환처럼
API 재호출 없이 동작해야 하는데, 백엔드가 한 번의 fetch 시점에 날짜창을
미리 적용해버리면 토글이 바뀌어도 반영할 방법이 없다. 대신 백엔드는
취소 건만 제외한 전체 위임 작업을 넘기고, 날짜 범위 적용은 프론트엔드가
기존 `filterVisibleToday`(아래 UI 절 참고)로 토글 상태에 따라 그때그때
계산한다.

```rust
pub fn filter_delegated_visible(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.created_by.as_deref() == Some(user_id))
        .filter(|i| !i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "cancelled")
        .collect()
}
```

- `created_by`는 이미 `WorkItem`에 존재하는 필드이므로 API 응답/역직렬화
  변경 불필요.
- `completed_after`/`completed_before`는 `filter_assigned_visible` 호출에만
  쓰이고 `filter_delegated_visible`에는 전달하지 않는다.

## 데이터 조립 (`src-tauri/src/commands.rs`)

`SidebarData`(정의 위치는 `offline.rs`가 아니라 `commands.rs`)에 필드
추가:

```rust
pub struct SidebarData {
    pub assigned: Vec<WorkItemDto>,
    pub delegated: Vec<WorkItemDto>,  // 신규
    pub delegated_members: Vec<MemberDto>,  // 신규 — 담당자 이름 해결용
    // ...
}
```

`assemble_sidebar`가 프로젝트별 이슈를 이미 전부 받으므로, 그 결과에
`filter_delegated_visible`을 추가로 적용해 `delegated`를 채운다.
`filter_assigned_visible`이 `items`(`Vec<WorkItem>`)의 소유권을 가져가므로
`delegated` 계산에도 쓰려면 `items.clone()`을 먼저 만든다(`WorkItem`은
이미 `#[derive(Clone)]`).

### 담당자 이름 해결

사이드바 프론트엔드에는 담당자 이름을 조회하는 기능이 없다(`listMembers`는
quickadd/editmodal에서 프로젝트 1개 단위로만 쓰임). "내가 할당한 작업"은
여러 프로젝트에 걸치므로, 이름 해결을 백엔드에서 끝내고 프론트엔드는
`id → display_name` 맵만 만들도록 한다.

- `fetch_sidebar_data_online`(`commands.rs`)의 기존 프로젝트 루프(이슈·상태
  조회)에서, **`delegated`에 항목이 있는 프로젝트 ID만** 추려 그 프로젝트에
  한해 `client.list_members(&p.id)`를 추가로 호출한다. (전체 프로젝트가
  아니라 위임 작업이 실제로 있는 프로젝트로 한정해 불필요한 API 호출을
  줄인다.)
- 여러 프로젝트에서 같은 사용자가 중복으로 나올 수 있으므로 `id` 기준으로
  dedupe해 `SidebarData.delegated_members: Vec<MemberDto>`에 담는다.
- 프론트엔드는 탭을 "내가 할당한 작업"으로 전환할 때 이 배열로
  `Map<string, string>`(id → display_name)을 한 번 만들어 재사용한다.

오프라인 캐시 스냅샷 크기는 늘어나지만(이슈 목록 필터링 결과 + 멤버 목록
소량 추가) 실질적으로 작다 — 위임 작업은 보통 담당 작업보다 적다.

## UI (`src/sidebar`)

- 헤더(`.sb-head`) 아래에 탭 바 추가: **담당 작업** / **내가 할당한 작업**.
  각 탭 라벨에 카운트 표시(기존 섹션 헤더 카운트 패턴 재사용).
- 기본 선택 탭은 "담당 작업". 마지막으로 선택한 탭은 `localStorage`에
  저장해(`sidebarActiveTab` 키) 다음 실행 시 복원한다 — 기존 `hideCompleted`
  저장 패턴과 동일.
- "내가 할당한 작업" 탭에서만 작업 카드에 담당자 아바타+이름 칩을
  추가로 표시한다(`.avatar` 스타일, 담당 작업 탭엔 불필요하므로 생략).
  이름은 `data.delegated_members`로 만든 `id → display_name` 맵에서
  찾는다. 맵에 없는 ID(멤버가 프로젝트에서 제외된 경우 등)는 "알 수 없음"으로
  표시한다.
- "내가 할당한 작업" 탭 안에 "오늘만 보기" 토글 버튼을 둔다. 기존
  "완료 숨김" 토글(`hideDoneEl`, `HIDE_DONE_KEY` 패턴)과 동일한 UI로 만들고,
  별도 `localStorage` 키(`delegatedShowAll`)에 상태를 저장한다.
- 탭 전환/토글은 API 재호출 없이 소스 배열만 바꿔 다시 렌더링한다:
  - 담당 작업 탭: `renderTasks(filterVisibleToday(data.assigned), ...)` (기존과 동일)
  - 내가 할당한 작업 탭, 오늘만 보기 ON: `renderTasks(filterVisibleToday(data.delegated), ...)`
  - 내가 할당한 작업 탭, 오늘만 보기 OFF: `renderTasks(data.delegated, ...)` (날짜창 없이 전체)

## 엣지 케이스

- **위임 작업이 0건**: 탭은 그대로 두되 목록 영역에 빈 상태 문구
  ("위임한 작업이 없습니다") 표시. 탭 자체를 숨기지 않는다 — 갑자기
  탭이 사라지면 사용자가 혼란스러워한다.
- **담당자가 여러 명인 위임 작업**: 프론트엔드에 기존 다중 담당자 표시
  패턴이 없으므로 이번에 신규 규칙을 정한다 — 아바타 칩은 첫 담당자만
  표시하고 나머지는 칩 끝에 "+N"을 붙여 축약한다.
- **재할당으로 인해 assignee_ids에서 내가 빠진 경우**: 다음 fetch 주기에
  자동으로 "내가 할당한 작업" 탭에 나타난다(별도 처리 불필요, 필터가
  매번 최신 데이터로 재계산되므로).
- **오프라인 상태에서 탭 전환**: 캐시된 `delegated` 배열을 그대로 사용,
  네트워크 상태와 무관하게 즉시 전환된다.

## 테스트

- **Rust 단위 테스트** (`plane_api.rs`): `filter_delegated_visible` —
  자기 자신에게 할당한 경우 제외, `created_by`가 다른 사람인 경우 제외,
  `created_by`가 없는(`None`) 경우 제외, `cancelled` 제외, 완료 항목은
  날짜와 무관하게 항상 포함(날짜창은 백엔드가 관여하지 않음을 검증).
- **TS 단위 테스트** (`src/sidebar`): 탭 전환 시 올바른 소스 배열 렌더링,
  `localStorage` 탭 상태 복원, "오늘만 보기" 토글 ON일 때 `filterVisibleToday`
  적용/OFF일 때 미적용, `delegated_members` 배열로부터 id→이름 맵 생성 및
  맵에 없는 ID의 "알 수 없음" 폴백.

## CHANGELOG

- `### 추가` — "사이드바에 '내가 할당한 작업' 탭을 추가해 다른 사람에게
  맡긴 작업의 진척을 확인할 수 있습니다."
