# 빠른 추가 · 할 일 수정 폼 공통화 — 설계 스펙

- 날짜: 2026-08-14
- 상태: 설계 완료
- 선행: `2026-08-10-quickadd-v2-design.md` (한눈에 보기 레이아웃),
  `2026-08-11-quickadd-header-layout-toggle-design.md` (헤더 레이아웃 토글),
  `2026-07-01-sidebar-edit-modal-design.md` (할 일 수정 창의 출발점)

## 목적

빠른 추가와 할 일 수정은 **같은 항목의 같은 필드**를 다루는데 화면이 다르다.

원인은 취향이 아니라 이력이다. 할 일 수정 창은 만들 때 빠른 추가의 칩 한 줄을
복사해 갔고(`2026-07-01-sidebar-edit-modal-design.md`), 그 뒤로 개선은 빠른 추가
쪽에만 쌓였다. 지금 벌어진 차이는 이렇다.

| | 빠른 추가 | 할 일 수정 |
|---|---|---|
| 필드 UI | `layoutCompact` / `layoutExpanded` 교체형 | 칩 한 줄 하드코딩 (구 컴팩트 복제본) |
| 폼 상태 | `state.ts` (DOM 비의존, 단위 테스트 있음) | `main.ts` 안 모듈 전역 변수로 재구현 |
| 담당자 | 아바타 색상, `(나)` 표시, 클릭=단독·Ctrl+클릭=다중, 키보드 내비 | 색상 없음, 토글 전용, 키보드 내비 없음 |
| 날짜 | PgUp/Dn 단축키 + 툴팁, 스테퍼 | 휠만 |
| 헤더 | 드래그 영역 + 레이아웃 토글 + 닫기 | 제목 + 브라우저 열기 + 닫기 (드래그 불가) |
| 카드 CSS | `.popup` 계열 | `.editmodal` 계열 (별도 한 벌) |

`layoutCompact.ts`와 `editmodal/main.ts`의 칩 코드는 거의 같은 코드 두 벌이다.
날짜 교차 방지, 휠 클램프, 팝오버 개폐까지 각자 구현되어 있어 **한쪽을 고쳐도
다른 쪽은 그대로 남는다**.

**폼 UI를 한 벌로 만든다.** 두 창은 헤더 액션과 푸터만 다르고, 할 일 수정에는
"브라우저에서 열기"가 더 붙는다.

## 핵심 설계 결정

1. **카드 셸까지 공통화한다.** 필드 영역만 공통화하면 카드 껍데기 CSS가
   `.popup` / `.editmodal` 두 벌로 남아 여백·헤더 모양 차이가 그대로 간다. 지금
   문제의 절반이 거기 있으므로 셸을 공유한다.
2. **창은 합치지 않는다.** 한 창이 "추가/수정" 모드를 갖는 쪽이 코드는 가장
   적지만, 사이드바에서 수정 창을 띄운 채 빠른 추가를 부르는 흐름이 깨지고
   always-on-top·창 크기 정책도 다르다.
3. **헤더 액션과 푸터는 슬롯이다.** 두 창의 진짜 차이는 이 둘뿐이다. 셸이
   그리려 들면 창마다 분기가 셸 안으로 스며든다 — 만들어진 DOM을 받아 꽂는다.
4. **레이아웃 토글은 설정을 공유한다.** 설정값 `quickadd_layout` 하나를 두 창이
   함께 읽고 쓴다. 한쪽에서 바꾸면 양쪽이 바뀐다 — "같은 디자인"이 설정 단계에서
   갈라지지 않는다.
5. **담당자 의미 차이는 옵션 하나로 흡수한다.** 빈 배열의 뜻이 두 창에서 다르고,
   이건 도메인상 필연이다(생성 시엔 "비우면 나에게", 수정 시엔 "정말 아무도
   없음"이 가능하다). 레이아웃을 갈라내지 않고 `emptyAssignee` 옵션으로 받는다.
6. **수정 창 고유 화면은 셸 밖에 남긴다.** 로딩 표시, 저장 충돌 확인, 삭제 확인은
   수정 창에만 있는 흐름이다. 셸에 넣으면 빠른 추가가 쓰지 않는 상태를 이고 간다.
7. **브라우저 열기는 아이콘 버튼이다.** 컴팩트 540px 헤더에 그립·제목·레이아웃
   토글·닫기가 이미 들어간다. 텍스트 버튼을 유지하면 제목이 사라진다. 닫기 버튼과
   같은 24px 아이콘으로 두고 앱이 이미 쓰는 `.qa-tip` 툴팁으로 이름을 밝힌다.

## 모듈 구조

```
src/shared/issueForm/
  card.ts            ← 새로 만드는 카드 셸
  layout.ts          ← quickadd/layout.ts 이동 (+ 옵션 타입)
  layoutCompact.ts   ← 이동
  layoutExpanded.ts  ← 이동
  state.ts           ← 이동 (state.test.ts 함께)
  assigneeSlots.ts   ← 이동 (assigneeSlots.test.ts 함께)

src/quickadd/    → main.ts, projectPicker.ts, index.html
src/editmodal/   → main.ts, index.html
```

이동은 경로만 바뀐다. `layout.ts`의 `LayoutHosts` / `LayoutContext` /
`LayoutHandle` 계약과 두 레이아웃의 내부는 그대로다 — 이 스펙이 바꾸는 것은
**누가 그 계약을 쓰는가**다.

## 카드 셸 (`card.ts`)

```ts
export interface IssueCardOptions {
  /** 카드가 들어갈 자리(창 body 안). */
  root: HTMLElement;
  /** 헤더 제목. "빠른 추가" / "할 일 수정". */
  title: string;
  titlePlaceholder: string;
  /** 헤더가 Tauri 드래그 영역인가. 두 창 모두 true — 수정 창은 지금 못 움직인다. */
  draggable: boolean;
  /** 담당자가 비었을 때의 뜻. 두 창의 유일한 필드 동작 차이다. */
  emptyAssignee: "me" | "none";
  /** 헤더에서 레이아웃 토글과 닫기 사이에 꽂을 버튼들. */
  headerExtra?: HTMLElement[];
  /** 창별 푸터. 셸은 자리만 내주고 내용은 만들지 않는다. */
  footer: HTMLElement;
  loadMembers: () => Promise<void>;
  /** 레이아웃이 바뀌었다 — 설정에 저장할 기회. */
  onLayoutChange: (kind: LayoutKind) => void;
  /** 내용 크기가 바뀌었다. 창 크기는 창이 정한다. */
  onResize: (width: number, height: number) => void;
  /** Ctrl+Enter. 빠른 추가는 등록, 수정은 저장. */
  onSubmit: () => void;
  /** Esc(팝오버가 닫힌 뒤) 또는 닫기 버튼. */
  onClose: () => void;
}

export interface IssueCardHandle {
  readonly state: FormState;
  render(): void;
  setLayout(kind: LayoutKind): void;

  titleValue: string;          // getter/setter
  descriptionValue: string;    // getter/setter
  setValues(fields: IssueFormFields): void;
  setDescriptionVisible(visible: boolean): void;
  setDescriptionLoading(loading: boolean): void;
  setFormVisible(visible: boolean): void;

  markTitleError(): void;
  clearTitleError(): void;
  showError(message: string): void;
  clearError(): void;

  closeOverlays(): void;
  hasOpenOverlay(): boolean;
  resetView(): void;

  readonly layoutWidth: number;
  /** 카드 밖으로 떠 있는 것까지 포함한 내용 높이. */
  contentHeight(): number;
}
```

셸이 가져가는 것:

- 헤더(그립·제목·레이아웃 토글·`headerExtra`·닫기)와 제목 입력·설명 입력·에러 줄
- 레이아웃 교체(`mountCompact` ↔ `mountExpanded`)와 토글 표시
- PgUp/Dn 날짜 단축키 (팝오버가 열려 있으면 비켜서는 지금 규칙 그대로)
- Ctrl+Enter → `onSubmit`, Esc → 팝오버 먼저 닫고 없으면 `onClose`
- 크기 계산 → `onResize(layout.width, height)`

셸이 건드리지 않는 것:

- 로딩 표시, 저장 충돌·삭제 확인 팝업 (수정 창)
- 프로젝트 선택 버튼, 업데이트 안내 코치마크 (빠른 추가)
- 창 자체의 `setSize` / `hide` / `setAlwaysOnTop` — 셸은 창을 모른다

### `setValues` — 수정 창의 진입점

빠른 추가는 빈 폼에서 시작하지만 수정 창은 기존 값을 채운다. 그것도 두 번:
스냅샷으로 먼저(즉시 편집 가능), 상세 응답으로 한 번 더(설명 포함).

```ts
export interface IssueFormFields {
  name: string;
  assigneeIds: string[];
  startDate: string | null;   // ISO yyyy-mm-dd
  targetDate: string | null;
  priority: Priority;
  stateGroup: StateGroup;
}
```

날짜는 `startChoice: "custom"`으로 채운다(지금 `applyFieldsToForm`과 같다).
한눈에 보기의 날짜 행은 프리셋이 하나도 안 켜진 채 실제 날짜만 뜨는데, 이는 빠른
추가에서 임의 날짜를 고른 경우와 같은 표시라 새 상태가 아니다.

### 담당자 — `emptyAssignee`

| | `"me"` (빠른 추가) | `"none"` (할 일 수정) |
|---|---|---|
| 빈 배열의 뜻 | 나 (서버가 호출자에게 할당) | 담당자 없음 |
| 컴팩트 칩 | 아바타 `나`, 라벨 `나` | 아바타 `-`, 라벨 `담당자 없음` |
| 컴팩트 팝오버 | `is_me` 행이 `(나)`로 표시되고 빈 배열일 때 선택됨 | 맨 위 `담당자 없음` 행, 빈 배열일 때 선택됨 |
| 한눈에 보기 | `is_me` 칩이 `나`로 줄어 표시, 빈 배열이면 켜짐 | 첫 칸이 `없음` 칩, 빈 배열이면 켜짐 |
| 단독 선택 | `is_me` 고르면 빈 배열로 되돌림 (`setSingleAssignee`) | `is_me`도 명시적 id로 넣음 |

`setSingleAssignee(state, member)`에 모드 인자를 더한다. `"none"`에서는 `is_me`를
특별 취급하지 않는다 — 수정 창에서 "나"를 고르는 것은 "비우기"가 아니라 "나를
지정"이다.

나머지 차이(아바타 색상, Ctrl+클릭 다중, 키보드 내비, 오버플로 `+N` 팝오버)는
분기 없이 **수정 창이 빠른 추가 쪽으로 올라온다**.

## 창별 구성

| | 빠른 추가 | 할 일 수정 |
|---|---|---|
| 헤더 | 그립 · "빠른 추가" · 레이아웃 토글 · 닫기 | 그립 · "할 일 수정" · 레이아웃 토글 · **브라우저 열기(아이콘)** · 닫기 |
| 푸터 | 프로젝트 선택 · 추가 `Ctrl+↵` | 삭제 · (우측) 취소 · 저장 |
| 창 폭 | 540 ↔ 660 | 540 ↔ 660 (지금 540 고정) |
| `emptyAssignee` | `"me"` | `"none"` |

### 수정 창에 새로 생기는 것

- 레이아웃 토글과 한눈에 보기 레이아웃
- 담당자 아바타 색상, `Ctrl+클릭` 다중 선택, 팝오버 키보드 내비
- PgUp/Dn 날짜 조정과 그 툴팁
- 헤더 드래그로 창 옮기기

### 수정 창에서 사라지는 것

- 텍스트 "🌐 브라우저에서 열기" → 아이콘 버튼 + 툴팁
- 담당자 팝오버의 토글 전용 동작 → 클릭=단독 / Ctrl+클릭=다중 (빠른 추가와 동일)

담당자 팝오버가 토글 전용에서 단독 선택으로 바뀌면 **한 번의 클릭으로 여러 담당자가
한 명으로 줄어들 수 있다**. 이는 빠른 추가와 같은 계약이고 Ctrl+클릭이 기존
동작을 그대로 남기지만, 다중 담당자 항목을 자주 다루면 체감되는 변화다.

### 담당자 목록 로드

수정 창에는 프로젝트 선택 버튼이 없다. `state.selectedId`에 그 이슈의
`project_id`를 넣으면 `loadMembers`도, `layoutExpanded`의 프로젝트별
재요청·실패 캐시 로직도 그대로 탄다. 새 배관이 필요 없다.

## CSS 정리 (`src/shared/app.css`)

삭제: `.editmodal`, `.em-head`, `.em-title`, `.em-close`, `.em-error`,
`.em-foot`, `.em-foot-right`
존치: `.em-btn`(+`-primary`/`-ghost`), `.em-delete`, `.em-delete-confirm`,
`.em-loading` — 수정 창 푸터·로딩 전용
고쳐 씀: `.em-browser-btn` — 텍스트 버튼 규칙을 버리고 `.qa-close`와 같은 24px
아이콘 버튼으로 다시 쓴다

수정 창 푸터는 `.popup-bottom`을 쓰되 삭제 버튼이 왼쪽, 취소·저장이 오른쪽인
배치라 안에서 `.em-foot-right`가 하던 `margin-left: auto`만 남긴다. 삭제 확인
팝업이 `bottom: 100%`로 푸터에 붙어 있으므로 `.popup-bottom`에
`position: relative`가 필요하다 — 빠른 추가 푸터에는 영향이 없다.
재사용: `.popup`, `.qa-header`, `.qa-grip`, `.qa-layout-toggle`, `.qa-close`,
`.popup-top`, `.title-input`, `.description-input`, `.popup-bottom`

에러 줄은 두 창이 이미 `.em-error`를 함께 쓰고 있다(`quickadd/index.html`의
`#qaError`). 셸로 올리면서 `.form-error`로 이름을 옮긴다.

`.popup`의 `position: fixed; top: 230px; left: 50%` 는 창 안에서 의미가 없어
빠른 추가가 인라인 스타일로 덮고 있다. 셸이 그리므로 이 좌표를 규칙에서 빼고
인라인 덮어쓰기도 없앤다.

## `tauri.conf.json`

`editmodal` 창을 빠른 추가와 같은 조건으로 맞춘다.

- `resizable: true` → `false` — 셸이 크기를 잡으므로 손잡이는 뜻이 없다
- `width` 540 유지 (첫 프레임. 이후 레이아웃에 따라 `setSize`)
- `height` 320 유지 (로딩 표시 높이. 이후 실측으로 덮인다)

## 작업 순서

각 단계마다 `pnpm test`와 빌드가 통과해야 한다.

1. **파일 이동만.** `layout` / `layoutCompact` / `layoutExpanded` / `state` /
   `assigneeSlots`(+테스트)를 `src/shared/issueForm/`으로. 임포트 경로만 바뀐다.
2. **`card.ts` 추출.** 빠른 추가를 먼저 셸 위에 올린다. 이 단계의 성공 기준은
   "빠른 추가가 완전히 그대로"다.
3. **`emptyAssignee` 옵션.** 두 레이아웃 분기 + `setSingleAssignee` 모드 인자 +
   단위 테스트.
4. **수정 창 교체.** 헤더/푸터 주입, 브라우저 열기 아이콘 버튼, `setValues`로
   스냅샷·상세 채우기. 로딩·충돌·삭제 확인은 셸 밖에 그대로.
5. **CSS 정리.** 위 목록대로.
6. **`tauri.conf.json`** 조정.

2단계까지 끝나면 리팩터링만으로 빠른 추가가 무사한지 먼저 확인되고, 그 뒤에야
수정 창을 갈아끼우므로 회귀 범위가 좁다.

## 검증

- `pnpm test` — 옮긴 `state.test.ts` · `assigneeSlots.test.ts` +
  `emptyAssignee` 분기 신규 테스트
- 앱 실행:
  - 빠른 추가에서 두 레이아웃 전환 · 등록 · 프로젝트 선택 · 코치마크
  - 사이드바에서 항목 수정 → 두 레이아웃 전환 · 저장 · 삭제 · 저장 충돌 ·
    브라우저 열기 · 헤더 드래그
  - 설정 창에서 레이아웃을 바꿨을 때 두 창 모두 반영되는지
  - 오프라인에서 수정 창을 열었을 때 스냅샷 폴백이 그대로인지

## CHANGELOG

`[Unreleased]` / `### 변경`

> - 할 일 수정 창이 빠른 추가와 같은 모양이 되었습니다 — 컴팩트/한눈에 보기 전환,
>   담당자 아바타 색상과 Ctrl+클릭 다중 선택, PgUp/Dn 날짜 조정을 수정 창에서도 씁니다.
