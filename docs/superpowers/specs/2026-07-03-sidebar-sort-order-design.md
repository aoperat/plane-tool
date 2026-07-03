# 사이드바 작업 정렬 — 설계

날짜: 2026-07-03

## 요구사항

프로젝트 그룹 안의 작업을 다음 4단계 기준으로 정렬한다:

1. **상태**: 진행중(started) → 할일(unstarted) → 백로그(backlog) →
   취소(cancelled) → 완료(completed)
2. **우선순위**: 긴급(urgent) → 높음(high) → 중간(medium) → 낮음(low) →
   없음(none)
3. **마감일**(`target_date`): 빠른 날짜 먼저, 마감일 없는 항목은 뒤로
4. **생성일**(`created_at`): 먼저 만든 항목 먼저, 값이 없으면 뒤로

취소 상태 작업은 현재 서버 단계(`filter_assigned_visible`)에서 걸러져 표시되지
않는다 — 사용자 확인 결과(무응답, 권장안 채택) 계속 숨기되, 정렬 규칙에는
취소 순위를 포함해 나중에 표시로 바꿔도 그대로 동작하게 한다.

## 구현

- **Rust**: Plane API 응답의 `created_at`을 `RawWorkItem` → `WorkItem` →
  `WorkItemDto`로 전달한다 (지금까지는 버려졌음).
- **TS 타입**: `WorkItem`에 `created_at: string | null` 추가.
- **정렬**: `src/sidebar/logic.ts`에 `compareWorkItems(a, b)` 비교 함수를
  추가하고, `groupItemsByProject`의 기존 "완료 가라앉히기" 정렬을 이것으로
  교체한다. 날짜는 ISO 문자열이므로 문자열 비교로 충분하다. `Array.sort`는
  안정 정렬이므로 네 키가 모두 같으면 API 순서가 유지된다.
- **알 수 없는 값**: 목록에 없는 state_group/priority 값은 맨 뒤(순위 9)로.
- **라이브 갱신**: 사이드바에서 상태/우선순위를 바꾸면 기존 로직이 재렌더링을
  호출하므로, 바뀐 항목은 자동으로 새 위치로 이동한다.

## 테스트

- `logic.test.ts`: 상태 순서, 우선순위 순서, 마감일(없음 뒤로), 생성일,
  동률 시 입력 순서 유지 케이스 추가. 기존 테스트는 헬퍼에 `created_at: null`만
  추가하면 그대로 통과한다 (기대 순서가 새 규칙과 일치).
- Rust 쪽은 필드 전달만 추가되므로 기존 테스트 유지 + 매핑 확인.
