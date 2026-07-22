# 사이드바 폭 조정 + 프로젝트 안 사이클별 보기 — 설계 스펙

- 날짜: 2026-07-22
- 상태: 사용자 승인 대기
- 목업: `docs/superpowers/mockups/2026-07-22-sidebar-cycle-module-grouping-mockup.html`

## 목적

사이드바는 작업을 **프로젝트로만** 묶는다. "이번 스프린트에 내가 뭘 남겨뒀나"를
보려면 프로젝트를 하나씩 열어보며 머릿속에서 다시 묶어야 한다.

프로젝트 그룹은 그대로 두고, **그 안쪽만** 사이클별로 나눌 수 있게 한다. 하위
묶음이 가로 공간을 쓰므로 사이드바 기본 폭도 함께 넓히고, 사용자가 직접 끌어
조절할 수 있게 한다.

두 건은 서로 독립적이라 따로 배포할 수 있다. **폭 → 사이클별** 순서로 만든다.

**범위 밖**: 모듈별 보기(같은 UI에 항목만 추가하는 2단계 작업 — 아래 "모듈별을
2단계로 미루는 이유" 참고), 사이클 생성·수정, 작업을 사이클에 넣고 빼기,
사이클 전체(팀 전원) 진행률, 사이드바 높이 조절.

---

# Part A — 사이드바 폭

## A1. 기본 폭 320 → 352px

지금 `320`이 다섯 곳에 흩어져 있다:

| 위치 | 값 |
|---|---|
| `src/sidebar/main.ts:18` `PANEL_WIDTH` | 320 |
| `src/shared/app.css` `.sidebar` | `width: 320px` |
| `src/shared/app.css` `.notes-panel` | `width: 320px` |
| `src/shared/app.css` `.collapse-tab` | `right: 320px` |
| `src-tauri/tauri.conf.json` sidebar 창 | 348 (= 320 + 접기 탭 28) |

CSS 변수 하나로 모은다:

```css
:root { --panel-w: 352px; }
.sidebar     { width: var(--panel-w); }
.notes-panel { width: var(--panel-w); }
.collapse-tab{ right: var(--panel-w); }
```

`main.ts`는 `PANEL_WIDTH` 상수를 없애고 `panelWidth` 변수를 둔다. 설정을 읽은
직후 `document.documentElement.style.setProperty("--panel-w", panelWidth + "px")`로
CSS 쪽과 동기화하고, `WINDOW_WIDTH`는 상수 대신 `panelWidth + COLLAPSE_TAB_WIDTH`를
그때그때 계산한다. `tauri.conf.json`의 창 폭은 380(= 352 + 28)으로 올린다 —
`showSidebar`가 어차피 다시 계산하므로 첫 프레임의 깜박임만 줄이는 값이다.

## A2. 왼쪽 가장자리 드래그

`src/sidebar/index.html`의 `.sidebar` 안에 핸들을 하나 둔다:

```html
<span id="resizeHandle" class="resize-handle" title="드래그해서 폭 조절 (더블클릭: 기본값)"></span>
```

```css
.resize-handle {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: col-resize; z-index: 26; /* .collapse-tab(25)보다 위 */
}
.resize-handle:hover { background: var(--accent-soft); }
```

동작:

1. `pointerdown` — `setPointerCapture`, `startScreenX = e.screenX`,
   `startWidth = panelWidth`를 기록한다.
2. `pointermove` — `next = clamp(startWidth + (startScreenX - e.screenX), MIN, MAX)`.
   **`clientX`가 아니라 `screenX`를 쓴다** — 드래그하는 동안 창 자체가 움직이므로
   창 기준 좌표인 `clientX`는 매 프레임 원점이 바뀌어 값이 튄다.
3. 계산한 폭은 변수에 담아두고 **`requestAnimationFrame` 한 번에 한 번만** 적용한다.
   적용은 CSS 변수 갱신 + `win.setSize` + `win.setPosition`을 이어서 호출하는 것.
   창이 오른쪽에 고정돼 있으므로 폭과 x좌표를 **함께** 바꿔야 오른쪽 가장자리가
   제자리에 남는다. 두 값은 기존 `computeSidebarGeometry`에 새 `WINDOW_WIDTH`를
   넘겨 얻는다(모니터 정보는 `getTargetMonitor` 결과를 드래그 시작 시 한 번 캐시).
4. `pointerup` / `pointercancel` — 캡처를 놓고 `saveSettings({ sidebar_width })`.
   드래그 중에는 저장하지 않는다(파일 쓰기가 매 프레임 일어나면 안 된다).
5. 핸들 `dblclick` — 기본값 352로 되돌리고 저장한다.

**폭 범위**: `MIN = 300`, `MAX = min(560, 모니터 논리 폭 × 0.5)`. 상한을 모니터에
묶는 이유는 작은 화면에서 사이드바가 화면 절반을 넘게 덮는 걸 막기 위해서다.
저장된 값이 범위를 벗어나면(모니터가 바뀐 경우) 읽는 시점에 clamp 한다.

**깜박임 폴백**: 실시간 리사이즈가 눈에 띄게 떨면, 드래그 중에는 창을 그대로 두고
화면에 세로 가이드선만 그린 뒤 `pointerup`에서 한 번만 적용한다. 먼저 실시간으로
구현하고, 실제로 떨 때만 이 폴백으로 바꾼다.

## A3. 설정 저장

`src-tauri/src/config.rs` `Settings`에 필드 추가:

```rust
#[serde(default = "default_sidebar_width")]
pub sidebar_width: u32,

fn default_sidebar_width() -> u32 { 352 }
```

`#[serde(default = ...)]`가 있어야 이 기능 이전에 저장된 설정 파일이 352로 채워진다
(`show_delegated_tab` 때와 같은 패턴). `SettingsDto`(`src/shared/types.ts`)에도
`sidebar_width: number`를 더한다.

설정 화면에는 **입력란을 만들지 않는다.** 드래그로 충분하고, 같은 값을 두 곳에서
편집하면 동기화 문제만 는다.

## A4. 테스트

`src/sidebar/logic.ts`에 순수 함수를 하나 더하고 `logic.test.ts`에서 검증한다:

```ts
/** 저장된/드래그 중인 폭을 허용 범위로 자른다. `monitorLogicalWidth`가 작으면
 *  상한이 화면 절반으로 줄어든다. */
export function clampSidebarWidth(width: number, monitorLogicalWidth: number): number
```

- 300 미만 → 300, 560 초과 → 560
- 모니터 논리 폭 800 → 상한 400
- 모니터 폭이 아주 작아 상한이 300 아래로 내려가도 300은 보장

`computeSidebarGeometry`는 이미 폭을 인자로 받으므로 손대지 않는다.

---

# Part B — 프로젝트 안 사이클별 보기

## B1. 핵심 설계 결정

1. **프로젝트가 항상 최상위다.** 프로젝트 그룹 헤더(`.grp`)와
   `groupItemsByProject`는 한 줄도 바뀌지 않는다. 각 프로젝트의 `items`를 **한 번
   더 쪼개는 함수**만 더한다. 기본 축(`flat`)은 쪼개지 않으므로 지금 코드 경로 그대로다.
2. **하위 묶음은 프로젝트 헤더보다 확실히 가볍게 그린다** — 점 없음, 작은 글씨,
   기본 `--muted`, 왼쪽 세로 가이드선. 두 단의 무게가 비슷하면 어느 쪽이 상위인지
   한 박자 늦게 읽힌다(목업 A안 vs B안 비교).
3. **하위 묶음에 `position: sticky`를 걸지 않는다.** 프로젝트 헤더 하나만 상단에
   붙어 있어야 한다. 두 단이 다 sticky면 스크롤 중 서로 밀어낸다.
4. **사이클 데이터는 축을 고른 뒤에만 가져온다.** 기본 축만 쓰는 사용자에게는
   추가 요청이 0건이다.

## B2. 데이터 — 왜 별도 요청이 필요한가

Plane 공개 API의 work-items 목록 응답에는 cycle이 **없다**. `IssueSerializer`
(`apps/api/plane/api/serializers/issue.py`)에 그 필드가 없어 `expand=cycle`도
통하지 않는다 — `BaseSerializer.to_representation`의 확장은 `expand in self.fields`
일 때만 동작한다. 소속은 두 엔드포인트로 따로 받아야 한다:

| 엔드포인트 | 얻는 것 |
|---|---|
| `GET /projects/{pid}/cycles/` | 사이클 목록 (`id`, `name`, `start_date`, `end_date`) |
| `GET /projects/{pid}/cycles/{cid}/cycle-issues/` | `{cycle, issue}` 쌍 목록 |

`cycle-issues/`는 `CycleIssueSerializer`(`fields = "__all__"` on `CycleIssue`)라
행마다 `cycle`·`issue` id가 들어 있다. 응답이 가볍다.

### 요청 수를 줄이는 세 가지

1. **`cycle_view`가 꺼진 프로젝트는 건너뛴다.** Plane 프로젝트에는 사이클 사용
   여부 플래그가 있고(`ProjectSerializer`의 `cycle_view`), 꺼져 있으면 `cycles/`
   조차 부르지 않는다. `plane_api.rs`의 `Project`에 필드를 더한다:
   `#[serde(default = "default_true")] pub cycle_view: bool`.
2. **가져올 사이클을 제한한다.** 프로젝트마다 **진행 중 + 예정 전부 + 지난 것 중
   종료일 최신 6개**의 `cycle-issues/`만 받는다.
3. **갱신 주기를 따로 가져간다.** 사이클 소속은 작업 목록보다 훨씬 덜 바뀐다.
   작업 목록의 쿨다운은 60초지만 사이클 쪽은 **10분**으로 둔다.

**알려진 한계**: 6개보다 더 오래된 지난 사이클에 속한 미완료 작업은 "사이클 없음"
묶음에 들어간다. 사이드바는 미완료 작업과 오늘 완료된 작업만 보여주므로 실제로
드문 경우이고, 6개면 2주 스프린트 기준 약 3개월을 덮는다.

### 백엔드 (`src-tauri/src/plane_api.rs`, `commands.rs`)

```rust
pub struct Cycle {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub start_date: Option<String>,  // "YYYY-MM-DD"
    pub end_date: Option<String>,
}

pub struct CycleData {
    pub cycles: Vec<Cycle>,
    /// 작업 id → 사이클 id. 사이클은 작업당 최대 1개라 맵으로 충분하다.
    pub item_cycle: HashMap<String, String>,
    pub is_cached: bool,
}
```

- `PlaneClient::list_cycles(project_id)` — `cycles/` 파싱
- `PlaneClient::list_cycle_issues(project_id, cycle_id)` — `(cycle_id, issue_id)` 쌍
- `#[tauri::command] fetch_cycle_data()` — 위 세 가지 축소 규칙을 적용해 `CycleData`
  조립. 10분 캐시. 기존 오프라인 캐시 경로(`offline.rs`)에 함께 저장해 오프라인에서도
  마지막 값을 쓴다.

`fetch_sidebar_data`는 건드리지 않는다. 사이클은 완전히 별도 명령이라 기존 경로에
회귀 위험이 없다.

## B3. 그룹핑 로직 (`src/sidebar/logic.ts`)

```ts
export type GroupAxis = "flat" | "cycle";

export interface SubGroup {
  /** 접힘 상태 키. 축 접두어를 붙여 프로젝트 id와 섞이지 않게 한다. */
  key: string;
  name: string;
  /** "D-3" / "7/28 시작" / "7/12 종료" / null(날짜 미정·사이클 없음) */
  due: string | null;
  dueKind: "soon" | "plain" | "past" | null;
  /** 사이클이 없는 작업을 모은 묶음이면 true — 더 흐리게 그린다. */
  ghost: boolean;
  items: WorkItem[];
}

/** 한 프로젝트의 작업들을 사이클별로 쪼갠다. 묶음이 하나뿐이면 빈 배열을
 *  돌려주고, 호출부는 지금처럼 평평하게 그린다. */
export function splitByCycle(
  items: WorkItem[],
  cycles: Cycle[],
  itemCycle: Map<string, string>,
  now?: Date,
): SubGroup[]
```

**순서** — 아래 순위로 정렬하고, 같은 순위 안에서는 괄호 안 기준을 쓴다:

| 순위 | 묶음 | 같은 순위 내 정렬 |
|---|---|---|
| 0 | 진행 중 (start ≤ 오늘 ≤ end) | 종료일 오름차순 |
| 1 | 날짜 미정 (start/end 중 하나라도 없음) | 이름 오름차순 |
| 2 | 예정 (start > 오늘) | 시작일 오름차순 |
| 3 | 지난 (end < 오늘) | 종료일 내림차순 |
| 4 | 사이클 없음 (`ghost`) | — |

**기간 배지**

| 묶음 | `due` | `dueKind` |
|---|---|---|
| 진행 중, 남은 3일 이하 | `D-3` … `D-0` | `"soon"` (호박색) |
| 진행 중, 그 외 | `D-9` | `"plain"` |
| 예정 | `7/28 시작` | `"plain"` |
| 지난 | `7/12 종료` | `"past"` (흐린 점선) |
| 날짜 미정 / 사이클 없음 | `null` | `null` (배지 없음) |

`monthDay`는 `formatDateRange`가 쓰는 기존 헬퍼를 재사용한다.

**빈 묶음은 만들지 않는다.** 작업이 하나도 없는 사이클은 목록에 뜨지 않는다 —
사이드바는 "내게 할당된 것"만 보여주는 화면이므로, 내 작업이 없는 사이클 헤더는
정보가 아니라 노이즈다.

**묶음이 하나뿐이면 빈 배열**을 돌려준다. 사이클을 안 쓰는 프로젝트에 "사이클 없음"
헤더 한 줄만 덧붙는 건 순수한 노이즈다.

## B4. UI

### 축 전환 드롭다운 (`index.html`, `app.css`, `main.ts`)

기존 섹션 헤더(`.sb-section .h`) 오른쪽 끝에 붙인다 — 새 줄이 생기지 않아 세로
공간을 쓰지 않는다.

```html
<span id="axisBtn" class="axis-btn">전체 작업<span class="car">▾</span></span>
```

```css
.sb-section .h .axis-btn {
  margin-left: 6px; flex: none; display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 5px; border-radius: 5px; cursor: pointer;
  /* .sb-section .h 가 uppercase/letter-spacing 을 걸어두므로 되돌린다. */
  font-size: 10.5px; letter-spacing: 0; text-transform: none; color: var(--muted);
}
.sb-section .h .axis-btn:hover { background: var(--panel-2); color: var(--text); }
/* 기본 축이 아닐 때만 강조 — "지금 평소와 다르게 보고 있다"는 신호. */
.sb-section .h .axis-btn.alt { color: var(--accent); background: var(--accent-soft); }
```

누르면 기존 `.pop` 팝오버를 띄운다. 제목은 **"프로젝트 안에서"**, 항목은
**전체 작업 / 사이클별**. (모듈별은 2단계에서 항목 한 줄만 추가된다.)

`.fold-btn`이 이미 `.sb-section .h`에 붙을 수 있으므로, 두 요소의 순서를
`count → axis-btn → fold-btn`으로 고정한다.

### 하위 묶음 (`app.css`)

```css
.sub {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  margin: 4px 0 2px 12px; padding: 4px 6px; border-radius: 6px;
  font-size: 11px; font-weight: 600; color: var(--muted);
}
.sub:hover { background: var(--surface-grp-hover); color: var(--text); }
.sub .chev { flex: none; width: 9px; text-align: center; font-size: 9px; transition: transform .15s; }
.sub.collapsed .chev { transform: rotate(-90deg); }
.sub .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub .due {
  flex: none; height: 15px; display: inline-flex; align-items: center; padding: 0 4px;
  border: 1px solid var(--border); border-radius: 4px;
  font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums;
}
.sub .due.soon { color: var(--amber); border-color: var(--amber); }
.sub .due.past { color: var(--muted-2); border-style: dashed; }
.sub .prog .ring { width: 12px; height: 12px; }   /* 프로젝트 링(14px)보다 작게 */
.sub.ghost .name { color: var(--muted-2); font-weight: 500; }

/* 왼쪽 세로 가이드선이 소속을 말한다. 들여쓰기는 한 번뿐이라 카드 폭은 조금만 준다. */
.sub-body { margin-left: 17px; padding-left: 8px; border-left: 1px solid var(--border); }
.sub-body.collapsed { display: none; }
```

정확한 마크업과 두 모드(다크/라이트) 렌더링은 목업 파일에 있다.

### 진행률 링

프로젝트 헤더의 `4/9`와 하위 묶음의 `4/7`이 나란히 보인다. **둘 다 "내게 할당된
작업 기준"**으로 계산한다(기존 `groupProgress` 재사용). 사이클 전체(팀 전원)
진행률을 하위에 쓰면 "내 목록엔 2개인데 링은 12개"가 되어 두 숫자가 서로 다른
것을 세게 된다. 하위 링은 12px로 그려 위계를 나눈다.

## B5. 상호작용 규칙

1. **검색·필터가 걸려 있는 동안에는 하위 묶음을 그리지 않는다.** 검색 결과 3건이
   세 묶음에 하나씩 흩어지면 오히려 찾기 어렵다. `searchQuery`/`statusFilter`/
   `priorityFilter` 중 하나라도 활성이면 축과 무관하게 평평하게 그린다.
2. **접힘 키는 축별로 분리한다.** 기존 `collapsedGroups`(Set)에 하위 묶음도 넣되
   `cycle:{cycleId}` 형태의 접두어를 붙인다. 프로젝트는 지금처럼 raw id.
   접두어가 없으면 사이클 id와 프로젝트 id가 한 Set에 섞여 축을 오갈 때 엉뚱한
   묶음이 접힌 채로 남는다.
3. **"모두 접기" 버튼은 프로젝트 단만 접는다.** 하위까지 함께 접으면 다시 펼 때
   두 번 일해야 한다.
4. **프로젝트를 접으면 하위 묶음까지 통째로 숨는다** — 하위 묶음이 `.grp-body`
   안에 있으므로 기존 동작 그대로다.
5. **축 전환 시 데이터가 아직 없으면** 즉시 평평하게 그린 뒤, `fetch_cycle_data`가
   돌아오면 다시 그린다. 그 동안 footer에 "사이클 불러오는 중"을 띄운다.
   실패하면 축을 유지한 채 평평하게 그리고 footer에 실패를 알린다 — 축이 저절로
   되돌아가면 사용자가 자기가 뭘 잘못 눌렀다고 오해한다.
6. **선택한 축은 설정에 저장한다** (`sidebar_group_axis: String`, 기본 `"flat"`,
   `#[serde(default = ...)]`).

## B6. 테스트

`splitByCycle`은 순수 함수이므로 `src/sidebar/logic.test.ts`에서 전부 검증한다:

- 진행 중 → 날짜 미정 → 예정 → 지난 → 사이클 없음 순서
- 진행 중이 둘이면 종료일 임박순, 지난 것이 둘이면 최근 종료순
- 배지 문자열: `D-3` / `D-0` / `7/28 시작` / `7/12 종료`
- `dueKind`: 종료 3일 이하면 `"soon"`, 지난 것은 `"past"`
- 내 작업이 없는 사이클은 묶음으로 만들지 않음
- 묶음이 하나뿐이면 빈 배열 (사이클 없는 프로젝트 / 사이클 하나뿐인 프로젝트)
- `itemCycle`에 없는 작업은 `ghost` 묶음으로

`clampSidebarWidth`는 Part A에 적어둔 대로.

## B7. 모듈별을 2단계로 미루는 이유

모듈은 작업 하나가 **여러 개에 속할 수 있다**(사이클은 최대 1개). 그래서 같은
작업이 두 묶음에 중복해 나타나고, 하위 카운트를 다 더하면 프로젝트 헤더 숫자보다
커진다. Plane 웹과 같은 동작이라 규칙 자체는 사용자에게 낯설지 않지만, 표시 방법
(목업의 겹사각형 칩)과 카운트 계산을 따로 정해야 한다.

사이클은 이 문제가 없고 "이번 스프린트에 뭐가 남았나"라는 실제 질문에 바로 답한다.
드롭다운·CSS·`SubGroup` 타입은 모듈을 그대로 받으므로, 2단계는 `splitByModule`과
중복 칩만 추가하면 된다.

---

## 구현 순서

1. **Part A** — `--panel-w` 통합, 기본값 352, 드래그 핸들, `clampSidebarWidth` + 테스트
2. **Part B 백엔드** — `Project.cycle_view`, `Cycle`/`CycleData`, `list_cycles`,
   `list_cycle_issues`, `fetch_cycle_data` 명령, 오프라인 캐시
3. **Part B 로직** — `splitByCycle` + 테스트 (구현 전에 테스트부터)
4. **Part B UI** — 축 드롭다운, `.sub` / `.sub-body`, 렌더 분기, 상호작용 규칙

각 단계는 독립적으로 커밋·배포 가능하다.

## CHANGELOG

사용자에게 보이는 변경은 두 건이고, **각각 해당 커밋에서** `[Unreleased]`에 한 줄씩
추가한다(같이 쓰지 않는다 — 두 단계가 따로 배포될 수 있다).

Part A 커밋:

```
### 변경
- 사이드바 기본 폭을 조금 넓히고, 왼쪽 가장자리를 끌어 원하는 폭으로 조절할 수 있습니다
```

Part B 커밋:

```
### 추가
- 사이드바에서 각 프로젝트의 작업을 사이클별로 묶어 볼 수 있습니다
```

백엔드/로직 단계(구현 순서 2·3)는 그 자체로는 화면에 안 보이므로 기록하지 않는다.
