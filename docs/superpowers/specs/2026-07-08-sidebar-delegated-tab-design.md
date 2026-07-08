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

기존 `filter_assigned_visible` 옆에 대칭 함수를 추가한다:

```rust
pub fn filter_delegated_visible(
    items: Vec<WorkItem>,
    user_id: &str,
    show_all: bool,
    completed_after: &str,
    completed_before: &str,
) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.created_by.as_deref() == Some(user_id))
        .filter(|i| !i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "cancelled")
        .filter(|i| {
            i.state_group != "completed"
                || show_all
                || completed_within(i, completed_after, completed_before)
        })
        .collect()
}
```

- `show_all == false`(오늘만 보기): 완료 항목은 기존과 동일하게 오늘 근처
  날짜창 안에서만 보임.
- `show_all == true`(전체보기): 미완료는 전부, 완료도 기간 무관하게 전부
  보여준다.
- `created_by`는 이미 `WorkItem`에 존재하는 필드이므로 API 응답/역직렬화
  변경 불필요.

## 캐시 (`src-tauri/src/offline.rs`)

`SidebarData`에 필드 추가:

```rust
pub struct SidebarData {
    pub assigned: Vec<WorkItemDto>,
    pub delegated: Vec<WorkItemDto>,  // 신규
    // ...
}
```

`fetch_sidebar_data` 커맨드가 프로젝트별 이슈를 이미 전부 조회하므로, 그
결과에 `filter_delegated_visible`을 추가로 적용해 `delegated`를 채운다.
API 호출 횟수는 늘지 않는다. 오프라인 캐시 스냅샷 크기는 늘어나지만
(중복 저장 없이 같은 이슈 목록을 두 번 필터링한 결과만 저장) 실질적으로
작다 — 위임 작업은 보통 담당 작업보다 적다.

## UI (`src/sidebar`)

- 헤더(`.sb-head`) 아래에 탭 바 추가: **담당 작업** / **내가 할당한 작업**.
  각 탭 라벨에 카운트 표시(기존 섹션 헤더 카운트 패턴 재사용).
- 기본 선택 탭은 "담당 작업". 마지막으로 선택한 탭은 `localStorage`에
  저장해(`sidebarActiveTab` 키) 다음 실행 시 복원한다 — 기존 `hideCompleted`
  저장 패턴과 동일.
- "내가 할당한 작업" 탭에서만 작업 카드에 담당자 아바타+이름 칩을
  추가로 표시한다(`.avatar` 스타일, 담당 작업 탭엔 불필요하므로 생략).
- "내가 할당한 작업" 탭 안에 "오늘만 보기" 토글 버튼을 둔다. 기존
  "완료 숨김" 토글(`hideDoneEl`, `HIDE_DONE_KEY` 패턴)과 동일한 UI로 만들고,
  별도 `localStorage` 키(`delegatedShowAll`)에 상태를 저장한다. 이 토글 값이
  `filter_delegated_visible`의 `show_all` 파라미터로 전달된다.
- 탭 전환 시 API 재호출 없이 `renderTasks(filterVisibleToday(data.assigned | data.delegated), ...)`
  형태로 소스 배열만 바꿔 다시 렌더링한다.

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
  `cancelled` 제외, `show_all` true/false에 따른 완료 항목 날짜창 동작.
- **TS 단위 테스트** (`src/sidebar`): 탭 전환 시 올바른 소스 배열 렌더링,
  `localStorage` 탭 상태 복원, "오늘만 보기" 토글 상태에 따른 필터 결과 반영.

## CHANGELOG

- `### 추가` — "사이드바에 '내가 할당한 작업' 탭을 추가해 다른 사람에게
  맡긴 작업의 진척을 확인할 수 있습니다."
