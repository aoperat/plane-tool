# 사이드바 폭 조절 + 사이클별 보기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바 폭을 사용자가 끌어 조절할 수 있게 하고, 각 프로젝트 그룹 안에서 작업을 사이클별로 묶어 볼 수 있게 한다.

**Architecture:** 프로젝트 그룹(`groupItemsByProject`)은 손대지 않는다. 각 프로젝트의 `items`를 한 번 더 쪼개는 순수 함수 `splitByCycle`을 더하고, `renderTasks`가 축에 따라 분기한다. 사이클 소속은 Plane work-items 응답에 없으므로 별도 Tauri 명령 `fetch_cycle_data`로 받는다. 폭은 CSS 변수 `--panel-w` 하나로 모으고 드래그 핸들이 그 값과 창 크기를 함께 바꾼다.

**Tech Stack:** TypeScript + Vite (프론트), Rust + Tauri 2 (백엔드), vitest (프론트 테스트), `cargo test` + wiremock (백엔드 테스트), pnpm.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-22-sidebar-width-and-cycle-view-design.md`
- 목업(정확한 마크업·색·간격의 기준): `docs/superpowers/mockups/2026-07-22-sidebar-cycle-module-grouping-mockup.html`
- 기본 폭 `352`px, 최소 `300`px, 최대 `min(560, 모니터 논리 폭 ÷ 2)`
- 접기 탭 폭 `COLLAPSE_TAB_WIDTH = 28` (창 폭 = 패널 폭 + 28)
- 지난 사이클은 프로젝트마다 종료일 최신 **6개**까지만 소속을 받는다
- 사이클 데이터 캐시 수명 **10분**
- 사용자에게 보이는 변경을 커밋할 때 같은 커밋에서 `CHANGELOG.md`의 `## [Unreleased]`에 한국어 한 줄을 추가한다. 카테고리는 `### 추가` / `### 변경` / `### 수정`만 쓴다. 내부 작업(리팩터링·테스트·백엔드 배관)은 기록하지 않는다.
- 주석과 CHANGELOG는 한국어, 코드 식별자는 영어(기존 파일 관례 그대로)
- 커밋 메시지 끝에 다음 두 줄을 붙인다:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
  ```

## 스펙에서 정정된 두 가지

계획을 쓰며 코드를 읽고 확인한 사실이다. 스펙 문구보다 이 계획이 우선한다.

1. **설정은 Rust `Settings`가 아니라 webview `localStorage`에 저장한다.**
   스펙은 `SettingsDto`에 `sidebar_width` / `sidebar_group_axis`를 더한다고 했지만,
   `main.ts`에는 이미 "화면 표시 취향은 localStorage" 관례가 있다
   (`hideCompleted`, `delegatedShowAll`, `sidebarActiveTab`, `collapsedGroups`).
   두 값 모두 사이드바 webview만 쓰므로 백엔드가 알 필요가 없고,
   `saveSettings`는 이미 위치 인자가 17개라 더 늘리면 안 된다.
   → `config.rs`, `SettingsDto`, `ipc.ts`의 `saveSettings`는 **건드리지 않는다**.

2. **축 전환 버튼은 `foldAll`처럼 두 줄 사이를 옮겨 다녀야 한다.**
   "내가 할당한 작업" 탭이 켜져 있으면 섹션 헤더가 통째로 숨는다
   (`main.ts:1007` `sectionHeadEl.hidden = s.show_delegated_tab`).
   축 버튼을 섹션 헤더에만 두면 그 설정에서 사라진다.
   `foldAll`이 이미 `sbTabsEl` ↔ `sectionHeadEl`을 오가므로 같은 패턴을 쓴다.

3. **사이클 데이터의 오프라인 캐시는 프론트엔드 localStorage로 한다.**
   스펙은 `offline.rs`에 얹는다고 했으나, 캐시 수명(10분)·재요청 판단이 전부
   프론트엔드 관심사이고 `offline.rs`는 쓰기 큐/충돌까지 얽힌 모듈이다.
   `fetch_cycle_data`는 캐시 없이 매번 네트워크를 치고, 프론트엔드가 마지막
   성공 결과를 localStorage에 두었다가 실패 시 그대로 쓴다.

---

## File Structure

**새로 만드는 파일** — 없다. 기존 파일에 더한다.

| 파일 | 이 작업에서의 책임 |
|---|---|
| `src/sidebar/logic.ts` | 순수 로직: `clampSidebarWidth`, `splitByCycle`, 폭 상수 |
| `src/sidebar/logic.test.ts` | 위 두 함수의 vitest 테스트 |
| `src/shared/types.ts` | `Cycle`, `CycleData` 타입 |
| `src/shared/ipc.ts` | `fetchCycleData` 래퍼 한 줄 |
| `src/shared/app.css` | `--panel-w` 변수화, `.resize-handle`, `.axis-btn`, `.sub`, `.sub-body` |
| `src/sidebar/index.html` | 리사이즈 핸들·축 버튼 요소 |
| `src/sidebar/main.ts` | 폭 상태·드래그, 사이클 데이터 캐시, 축 상태, `renderTasks` 분기 |
| `src-tauri/tauri.conf.json` | 사이드바 창 초기 폭 348 → 380 |
| `src-tauri/src/plane_api.rs` | `Project.cycle_view`, `Cycle`, `list_cycles`, `list_cycle_issue_ids`, `select_cycles_to_fetch` |
| `src-tauri/src/commands.rs` | `CycleDataDto`, `fetch_cycle_data` 명령 |
| `src-tauri/src/lib.rs` | 명령 등록 |
| `CHANGELOG.md` | Task 3, Task 7에서 한 줄씩 |

`main.ts`는 이미 1334줄이다. 이 작업으로 200줄 정도 는다. 순수 계산은 전부
`logic.ts`로 밀어넣어 `main.ts`에는 DOM 조작과 상태만 남긴다 — 파일 분할은
이 작업 범위 밖이다.

---

# Part A — 사이드바 폭

## Task 1: 폭 clamp 순수 함수

**Files:**
- Modify: `src/sidebar/logic.ts` (파일 끝에 추가)
- Test: `src/sidebar/logic.test.ts` (파일 끝에 추가)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `SIDEBAR_WIDTH_MIN = 300`, `SIDEBAR_WIDTH_MAX = 560`, `SIDEBAR_WIDTH_DEFAULT = 352` (모두 `number`)
  - `clampSidebarWidth(width: number, monitorLogicalWidth: number): number`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/sidebar/logic.test.ts` 맨 끝에 추가한다. 파일 첫 줄의 import 목록에도
`clampSidebarWidth`, `SIDEBAR_WIDTH_DEFAULT`를 알파벳 순서에 맞게 끼워 넣는다
(`buildIssueUrl, clampSidebarWidth, computeSidebarGeometry, ...` 그리고
`resolveStateId, SIDEBAR_WIDTH_DEFAULT, visibleTabItems` 순).

```ts
describe("clampSidebarWidth", () => {
  it("keeps a width that is already in range", () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, 1920)).toBe(352);
  });

  it("raises a too-small width to the minimum", () => {
    expect(clampSidebarWidth(120, 1920)).toBe(300);
  });

  it("lowers a too-large width to the maximum", () => {
    expect(clampSidebarWidth(900, 1920)).toBe(560);
  });

  it("caps the maximum at half the monitor so the panel never covers most of the screen", () => {
    expect(clampSidebarWidth(500, 800)).toBe(400);
  });

  it("still guarantees the minimum on a monitor too narrow for half to reach it", () => {
    // 상한(250)이 하한(300)보다 작아도 폭이 0으로 수렴하면 사이드바가 사라진다.
    expect(clampSidebarWidth(352, 500)).toBe(300);
  });

  it("rounds to whole pixels — a drag delta can land on a fraction", () => {
    expect(clampSidebarWidth(352.4, 1920)).toBe(352);
    expect(clampSidebarWidth(352.6, 1920)).toBe(353);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run src/sidebar/logic.test.ts -t clampSidebarWidth`
Expected: FAIL — `clampSidebarWidth is not exported` 또는 `not a function`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/sidebar/logic.ts` 맨 끝에 추가한다.

```ts
/** 사이드바 폭의 허용 범위와 기본값. 기본 352는 예전 320보다 10% 넓다 —
 *  사이클 하위 묶음이 가이드선과 들여쓰기로 쓰는 가로 공간을 되돌려준다. */
export const SIDEBAR_WIDTH_MIN = 300;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_DEFAULT = 352;

/** 저장된/드래그 중인 폭을 허용 범위로 자른다. 작은 화면에서 사이드바가 화면
 *  절반을 넘게 덮지 않도록 상한이 모니터 논리 폭의 절반까지 줄어들지만,
 *  하한(300)은 언제나 보장한다 — 아주 좁은 모니터에서 상한이 하한 아래로
 *  내려가면 폭이 0에 수렴해 사이드바가 사실상 사라진다. */
export function clampSidebarWidth(width: number, monitorLogicalWidth: number): number {
  const max = Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, Math.floor(monitorLogicalWidth / 2)),
  );
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, width)));
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run src/sidebar/logic.test.ts`
Expected: PASS — 새 6개 포함 전부 통과

- [ ] **Step 5: 커밋**

내부 작업이므로 CHANGELOG에 쓰지 않는다.

```bash
git add src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "$(cat <<'EOF'
refactor: 사이드바 폭 clamp 순수 함수 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## Task 2: 폭을 CSS 변수 하나로 모으고 기본값 352로 올린다

**Files:**
- Modify: `src/shared/app.css` (`:root` 블록, `.collapse-tab`, `.sidebar`, `.notes-panel`)
- Modify: `src/sidebar/main.ts:18-24` (상수), 그리고 `showSidebar`
- Modify: `src-tauri/tauri.conf.json:25`

**Interfaces:**
- Consumes: Task 1의 `SIDEBAR_WIDTH_DEFAULT`, `clampSidebarWidth`
- Produces:
  - `main.ts` 모듈 스코프 변수 `panelWidth: number`
  - `applyPanelWidth(w: number): void` — `panelWidth`와 CSS 변수 `--panel-w`를 함께 갱신
  - `windowWidth(): number` — `panelWidth + COLLAPSE_TAB_WIDTH`
  - `applyWindowGeometry(monitor): Promise<void>` — 현재 폭으로 창 크기·위치를 다시 잡는다

- [ ] **Step 1: CSS를 변수로 바꾼다**

`src/shared/app.css`의 첫 번째 `:root` 블록 끝(테마 색 정의들 바로 뒤)에 한 줄 더한다:

```css
  /* 사이드바 패널 폭. 테마와 무관하며 main.ts가 사용자 설정값으로 덮어쓴다.
     .sidebar / .notes-panel / .collapse-tab 세 곳이 이 값을 함께 본다 —
     따로 두면 폭을 바꿀 때 접기 탭만 제자리에 남는다. */
  --panel-w: 352px;
```

그리고 `320px`을 쓰던 세 곳을 바꾼다:

```css
.collapse-tab {
  position: fixed; top: 0; right: var(--panel-w); width: 28px; height: 57px;
```

```css
.sidebar {
  position: fixed; top: 0; right: 0; bottom: 0; width: var(--panel-w);
```

```css
  position: fixed; top: 0; right: 0; bottom: 0; width: var(--panel-w);
  z-index: 30; /* above sidebar content (20), below popovers (40) */
```
(마지막 것은 `.notes-panel` 안이다.)

- [ ] **Step 2: `main.ts`의 상수를 변수로 바꾼다**

`src/sidebar/main.ts:18-24`의

```ts
const PANEL_WIDTH = 320;
// The window is wider than the panel so the collapse tab can sit outside the
// panel's rectangle; the strip left of the panel is transparent. Keep in sync
// with `.collapse-tab` (right/width) in app.css and the window width in
// tauri.conf.json.
const COLLAPSE_TAB_WIDTH = 28;
const WINDOW_WIDTH = PANEL_WIDTH + COLLAPSE_TAB_WIDTH;
```

을 아래로 바꾼다:

```ts
// The window is wider than the panel so the collapse tab can sit outside the
// panel's rectangle; the strip left of the panel is transparent. Keep in sync
// with `.collapse-tab` (width) in app.css and the window width in
// tauri.conf.json.
const COLLAPSE_TAB_WIDTH = 28;

// 패널 폭은 사용자가 왼쪽 가장자리를 끌어 바꾼다. 사이드바 webview만 쓰는
// 화면 취향이라 백엔드 설정이 아니라 localStorage에 둔다 — hideCompleted,
// delegatedShowAll 과 같은 자리다.
const SIDEBAR_WIDTH_KEY = "sidebarWidth";
let panelWidth = readStoredPanelWidth();

function readStoredPanelWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : SIDEBAR_WIDTH_DEFAULT;
}

/** 폭 상태와 CSS 변수를 함께 갱신한다. 둘 중 하나만 바꾸면 창 크기와 패널
 *  그림이 어긋난다. */
function applyPanelWidth(w: number): void {
  panelWidth = w;
  document.documentElement.style.setProperty("--panel-w", `${w}px`);
}

function persistPanelWidth(): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(panelWidth));
}

function windowWidth(): number {
  return panelWidth + COLLAPSE_TAB_WIDTH;
}

applyPanelWidth(panelWidth);
```

9번째 줄의 `./logic` import 목록에 `clampSidebarWidth`와 `SIDEBAR_WIDTH_DEFAULT`를
추가한다 (`buildIssueUrl, clampSidebarWidth, computeSidebarGeometry, ...`,
그리고 `resolveStateId, SIDEBAR_WIDTH_DEFAULT, visibleTabItems`).

- [ ] **Step 3: `showSidebar`에서 창 배치 계산을 떼어낸다**

`main.ts`의 `showSidebar`(약 840행)를 아래로 바꾼다:

```ts
/** 현재 패널 폭으로 창의 크기와 위치를 다시 잡는다. 창이 화면 오른쪽에
 *  붙어 있으므로 폭과 x좌표를 함께 바꿔야 오른쪽 가장자리가 제자리에 남는다. */
async function applyWindowGeometry(monitor: Awaited<ReturnType<typeof getTargetMonitor>>): Promise<void> {
  if (!monitor) return;
  const geo = computeSidebarGeometry(
    monitor.size.width,
    monitor.size.height,
    monitor.scaleFactor,
    windowWidth(),
    monitor.position.x,
    monitor.position.y,
  );
  await win.setSize(new PhysicalSize(geo.width, geo.height));
  await win.setPosition(new PhysicalPosition(geo.visibleX, geo.y));
}

async function showSidebar(takeFocus = true): Promise<void> {
  const monitor = await getTargetMonitor();
  if (!monitor) {
    await showWindow(takeFocus);
    return;
  }
  // 저장된 폭은 다른 모니터에서 정한 값일 수 있다 — 지금 모니터 기준으로 자른다.
  const clamped = clampSidebarWidth(panelWidth, monitor.size.width / monitor.scaleFactor);
  if (clamped !== panelWidth) {
    applyPanelWidth(clamped);
    persistPanelWidth();
  }
  await applyWindowGeometry(monitor);
  await win.setAlwaysOnTop(true);
  await showWindow(takeFocus);
}
```

- [ ] **Step 4: 창 초기 폭을 올린다**

`src-tauri/tauri.conf.json:25`의 사이드바 창 정의에서 `"width": 348`을
`"width": 380`으로 바꾼다 (= 352 + 28). `showSidebar`가 어차피 다시 계산하므로
첫 프레임의 깜박임만 줄이는 값이다.

- [ ] **Step 5: 타입 검사와 테스트를 돌린다**

Run: `pnpm build && pnpm test`
Expected: 빌드 성공, 테스트 전부 PASS

- [ ] **Step 6: 앱을 띄워 눈으로 확인한다**

Run: `pnpm tauri dev`
확인: 사이드바를 열었을 때 (1) 폭이 눈에 띄게 넓어졌고, (2) 접기 탭이 패널
왼쪽 바깥에 정확히 붙어 있으며(사이에 틈이나 겹침이 없다), (3) 릴리즈 노트
패널(⋯ → 릴리즈 노트)이 패널을 정확히 덮는다.

- [ ] **Step 7: 커밋**

이 커밋 단독으로는 "폭이 넓어졌다"만 보이지만, CHANGELOG는 드래그까지 끝나는
Task 3에서 한 줄로 쓴다 — 사용자에게는 두 변화가 하나의 기능이다.

```bash
git add src/shared/app.css src/sidebar/main.ts src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
refactor: 사이드바 폭을 --panel-w 변수로 모으고 기본값을 352px로

320px이 main.ts·.sidebar·.notes-panel·.collapse-tab·tauri.conf.json
다섯 곳에 흩어져 있어 한 곳만 바꾸면 접기 탭이 제자리에 남았다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## Task 3: 왼쪽 가장자리 드래그로 폭 조절

**Files:**
- Modify: `src/sidebar/index.html:14` (`<aside class="sidebar">` 바로 뒤)
- Modify: `src/shared/app.css` (`.sidebar` 규칙 뒤에 `.resize-handle` 추가)
- Modify: `src/sidebar/main.ts` (`applyWindowGeometry` 정의 뒤에 드래그 핸들러 추가)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2의 `panelWidth`, `applyPanelWidth`, `persistPanelWidth`, `applyWindowGeometry`, `getTargetMonitor`; Task 1의 `clampSidebarWidth`, `SIDEBAR_WIDTH_DEFAULT`
- Produces: 없음 (UI 종단)

- [ ] **Step 1: 핸들 요소를 넣는다**

`src/sidebar/index.html`의 `<aside class="sidebar">` 바로 다음 줄에 추가한다:

```html
      <span id="resizeHandle" class="resize-handle" title="드래그해서 폭 조절 (더블클릭: 기본 폭)"></span>
```

- [ ] **Step 2: 핸들 CSS를 넣는다**

`src/shared/app.css`의 `.sidebar { ... }` 규칙 바로 뒤에 추가한다:

```css
/* 패널 왼쪽 모서리를 끌어 폭을 조절하는 손잡이. .sidebar 가 position:fixed 라
   absolute 자식은 패널 기준으로 잡힌다. 접기 탭은 패널 바깥(right: var(--panel-w))
   이라 겹치지 않는다 — z-index 는 패널 안 형제들 위에만 있으면 된다. */
.resize-handle {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  z-index: 5; cursor: col-resize;
}
.resize-handle:hover,
.resize-handle.dragging { background: var(--accent-soft); }
```

- [ ] **Step 3: 드래그 핸들러를 쓴다**

`src/sidebar/main.ts`의 `applyWindowGeometry` 정의 바로 뒤에 추가한다:

```ts
// ---- 폭 조절 드래그 ----
const resizeHandleEl = document.getElementById("resizeHandle")!;
let dragStartScreenX = 0;
let dragStartWidth = 0;
let dragMonitor: Awaited<ReturnType<typeof getTargetMonitor>> = null;
let dragPendingWidth: number | null = null;
let dragFrame = 0;

resizeHandleEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dragStartScreenX = e.screenX;
  dragStartWidth = panelWidth;
  dragPendingWidth = null;
  // 캡처는 동기적으로 먼저 잡는다 — await 뒤로 미루면 그 사이의 pointermove를 놓친다.
  resizeHandleEl.setPointerCapture(e.pointerId);
  resizeHandleEl.classList.add("dragging");
  void getTargetMonitor().then((m) => {
    dragMonitor = m;
  });
});

resizeHandleEl.addEventListener("pointermove", (e) => {
  if (!resizeHandleEl.hasPointerCapture(e.pointerId) || !dragMonitor) return;
  // 드래그하는 동안 창 자체가 왼쪽으로 자라므로 창 기준 좌표(clientX)는 매
  // 프레임 원점이 바뀌어 값이 튄다 — 데스크톱 절대 좌표인 screenX를 쓴다.
  // 왼쪽으로 끌수록 screenX가 작아지므로 (시작 - 현재)가 늘어난 폭이다.
  const logicalWidth = dragMonitor.size.width / dragMonitor.scaleFactor;
  dragPendingWidth = clampSidebarWidth(
    dragStartWidth + (dragStartScreenX - e.screenX),
    logicalWidth,
  );
  // setSize/setPosition은 IPC라 pointermove마다 부르면 밀린다 — 프레임당 한 번만.
  if (dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (dragPendingWidth == null) return;
    applyPanelWidth(dragPendingWidth);
    void applyWindowGeometry(dragMonitor);
  });
});

function endResizeDrag(e: PointerEvent): void {
  if (!resizeHandleEl.hasPointerCapture(e.pointerId)) return;
  resizeHandleEl.releasePointerCapture(e.pointerId);
  resizeHandleEl.classList.remove("dragging");
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }
  // 마지막 프레임이 아직 안 돌았을 수 있다 — 놓은 위치를 확실히 반영한다.
  if (dragPendingWidth != null) {
    applyPanelWidth(dragPendingWidth);
    void applyWindowGeometry(dragMonitor);
  }
  dragPendingWidth = null;
  // 저장은 여기서 한 번만 — 드래그 중에 쓰면 매 프레임 localStorage에 쓰게 된다.
  persistPanelWidth();
}
resizeHandleEl.addEventListener("pointerup", endResizeDrag);
resizeHandleEl.addEventListener("pointercancel", endResizeDrag);

resizeHandleEl.addEventListener("dblclick", () => {
  applyPanelWidth(SIDEBAR_WIDTH_DEFAULT);
  persistPanelWidth();
  void getTargetMonitor().then((m) => applyWindowGeometry(m));
});
```

- [ ] **Step 4: 타입 검사**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 5: 앱에서 드래그를 확인한다**

Run: `pnpm tauri dev`
확인 항목:
1. 패널 왼쪽 모서리에 마우스를 올리면 커서가 `col-resize`로 바뀌고 옅은 강조가 뜬다
2. 왼쪽으로 끌면 넓어지고 오른쪽으로 끌면 좁아진다. **오른쪽 가장자리는 제자리**
3. 아주 왼쪽까지 끌어도 화면 절반(또는 560px)에서 멈춘다
4. 아주 오른쪽까지 끌어도 300px에서 멈춘다
5. 핸들을 더블클릭하면 기본 폭으로 돌아온다
6. 사이드바를 닫았다 다시 열면 조절한 폭이 유지된다
7. 드래그 중 사이드바가 저절로 닫히지 않는다

**떨림이 눈에 띄면**: 실시간 리사이즈를 버리고 드래그 중에는 창을 그대로 둔 채
`position: fixed`인 세로 가이드선만 그리고, `endResizeDrag`에서 한 번만
`applyPanelWidth` + `applyWindowGeometry`를 부르도록 바꾼다. 먼저 실시간으로
써보고 실제로 떨 때만 바꾼다.

- [ ] **Step 6: CHANGELOG에 한 줄 쓴다**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 변경`에 (없으면 만들어서) 추가한다:

```markdown
- 사이드바 기본 폭이 조금 넓어졌고, 왼쪽 가장자리를 끌어 원하는 폭으로 조절할 수 있습니다 (더블클릭하면 기본 폭)
```

- [ ] **Step 7: 커밋**

```bash
git add src/sidebar/index.html src/shared/app.css src/sidebar/main.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat: 사이드바 왼쪽 가장자리를 끌어 폭 조절

창이 오른쪽에 붙어 있어 드래그 중 창 크기와 x좌표를 함께 바꾼다.
창 기준 clientX는 매 프레임 원점이 바뀌어 값이 튀므로 screenX를 쓴다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

# Part B — 프로젝트 안 사이클별 보기

## Task 4: `splitByCycle` 순수 함수

**Files:**
- Modify: `src/shared/types.ts` (파일 끝에 추가)
- Modify: `src/sidebar/logic.ts` (파일 끝에 추가)
- Test: `src/sidebar/logic.test.ts` (파일 끝에 추가)

**Interfaces:**
- Consumes: 기존 `WorkItem` 타입
- Produces:
  - `Cycle { id, name, project_id, start_date, end_date }`
  - `CycleData { cycles: Cycle[]; item_cycle: Record<string, string> }`
  - `GroupAxis = "flat" | "cycle"`
  - `SubGroup { key, name, due, dueKind, ghost, items }`
  - `splitByCycle(items, cycles, itemCycle, now?): SubGroup[]`

- [ ] **Step 1: 타입을 더한다**

`src/shared/types.ts` 맨 끝에 추가한다:

```ts
export interface Cycle {
  id: string; name: string; project_id: string;
  /** "YYYY-MM-DD" 또는 UTC 타임스탬프. 초안 사이클은 둘 다 null일 수 있다. */
  start_date: string | null; end_date: string | null;
}
export interface CycleData {
  cycles: Cycle[];
  /** 작업 id → 사이클 id. 사이클은 작업당 최대 1개라 맵으로 충분하다. */
  item_cycle: Record<string, string>;
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/sidebar/logic.test.ts` 맨 끝에 추가한다. import 줄에 `splitByCycle`을,
타입 import 줄(`import type { Project, ProjectState, WorkItem }`)에 `Cycle`을 더한다.

```ts
function cy(id: string, name: string, start: string | null, end: string | null): Cycle {
  return { id, name, project_id: "p1", start_date: start, end_date: end };
}
// 모든 테스트의 "오늘"
const NOW = new Date(2026, 6, 22); // 2026-07-22

describe("splitByCycle", () => {
  it("orders groups: running, undated, upcoming, past, then the no-cycle bucket", () => {
    const cycles = [
      cy("past", "Sprint 4", "2026-06-29", "2026-07-12"),
      cy("next", "Sprint 13", "2026-07-28", "2026-08-08"),
      cy("draft", "백로그 정리", null, null),
      cy("now", "Sprint 12", "2026-07-13", "2026-07-25"),
    ];
    const items = [wi("a", "p1"), wi("b", "p1"), wi("c", "p1"), wi("d", "p1"), wi("e", "p1")];
    const map = new Map([["a", "now"], ["b", "next"], ["c", "past"], ["d", "draft"]]);
    const groups = splitByCycle(items, cycles, map, NOW);
    expect(groups.map((g) => g.name)).toEqual([
      "Sprint 12", "백로그 정리", "Sprint 13", "Sprint 4", "사이클 없음",
    ]);
    expect(groups[4].items.map((i) => i.id)).toEqual(["e"]);
    expect(groups[4].ghost).toBe(true);
  });

  it("labels a running cycle with the days left and flags the last three as soon", () => {
    const cycles = [cy("now", "Sprint 12", "2026-07-13", "2026-07-25"), cy("x", "Sprint 9", "2026-07-01", "2026-07-30")];
    const map = new Map([["a", "now"], ["b", "x"]]);
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, map, NOW);
    expect(groups[0]).toMatchObject({ name: "Sprint 12", due: "D-3", dueKind: "soon" });
    expect(groups[1]).toMatchObject({ name: "Sprint 9", due: "D-8", dueKind: "plain" });
  });

  it("labels a cycle ending today as D-0", () => {
    const cycles = [cy("now", "Sprint 12", "2026-07-13", "2026-07-22"), cy("d", "초안", null, null)];
    const map = new Map([["a", "now"], ["b", "d"]]);
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, map, NOW);
    expect(groups[0].due).toBe("D-0");
  });

  it("labels upcoming and past cycles with their boundary date", () => {
    const cycles = [
      cy("next", "Sprint 13", "2026-07-28", "2026-08-08"),
      cy("past", "Sprint 4", "2026-06-29", "2026-07-12"),
    ];
    const map = new Map([["a", "next"], ["b", "past"]]);
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, map, NOW);
    expect(groups[0]).toMatchObject({ due: "7/28 시작", dueKind: "plain" });
    expect(groups[1]).toMatchObject({ due: "7/12 종료", dueKind: "past" });
  });

  it("sorts running cycles by soonest end and past cycles by most recent end", () => {
    const cycles = [
      cy("r2", "느긋", "2026-07-01", "2026-07-30"),
      cy("r1", "임박", "2026-07-01", "2026-07-24"),
      cy("p2", "오래된", "2026-05-01", "2026-05-30"),
      cy("p1", "최근", "2026-06-20", "2026-07-04"),
    ];
    const map = new Map([["a", "r2"], ["b", "r1"], ["c", "p2"], ["d", "p1"]]);
    const items = [wi("a", "p1"), wi("b", "p1"), wi("c", "p1"), wi("d", "p1")];
    expect(splitByCycle(items, cycles, map, NOW).map((g) => g.name))
      .toEqual(["임박", "느긋", "최근", "오래된"]);
  });

  it("skips cycles that hold none of my items", () => {
    const cycles = [cy("now", "Sprint 12", "2026-07-13", "2026-07-25"), cy("empty", "Sprint 11", "2026-07-01", "2026-07-12")];
    const map = new Map([["a", "now"]]);
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, map, NOW);
    expect(groups.map((g) => g.name)).toEqual(["Sprint 12", "사이클 없음"]);
  });

  it("returns nothing when there is only one bucket — the caller renders flat", () => {
    // 사이클을 안 쓰는 프로젝트: 전부 사이클 없음 하나
    expect(splitByCycle([wi("a", "p1")], [], new Map(), NOW)).toEqual([]);
    // 사이클이 하나뿐이고 바깥에 남은 작업이 없는 프로젝트
    const one = [cy("now", "Sprint 12", "2026-07-13", "2026-07-25")];
    expect(splitByCycle([wi("a", "p1")], one, new Map([["a", "now"]]), NOW)).toEqual([]);
  });

  it("keys groups with a cycle: prefix so they cannot collide with project ids", () => {
    const cycles = [cy("now", "Sprint 12", "2026-07-13", "2026-07-25")];
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, new Map([["a", "now"]]), NOW);
    expect(groups.map((g) => g.key)).toEqual(["cycle:now", "cycle:none"]);
  });

  it("reads UTC timestamps as their local calendar date", () => {
    // Plane은 프로젝트 타임존 기준 날짜를 UTC로 저장해 내려준다.
    const cycles = [cy("now", "Sprint 12", "2026-07-12T15:00:00Z", "2026-07-25T14:59:59Z"), cy("d", "초안", null, null)];
    const map = new Map([["a", "now"], ["b", "d"]]);
    const groups = splitByCycle([wi("a", "p1"), wi("b", "p1")], cycles, map, NOW);
    expect(groups[0].name).toBe("Sprint 12");
    expect(groups[0].dueKind).not.toBe("past");
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run src/sidebar/logic.test.ts -t splitByCycle`
Expected: FAIL — `splitByCycle is not a function`

- [ ] **Step 4: 구현을 쓴다**

`src/sidebar/logic.ts` 맨 끝에 추가한다. 파일 첫 줄의 타입 import에 `Cycle`을 더한다
(`import type { Cycle, Project, ProjectState, WorkItem } from "../shared/types";`).

```ts
/** 프로젝트 그룹 안에서 작업을 어떤 기준으로 다시 묶을지. "flat"이 기본이며
 *  지금까지의 화면과 같다. 모듈은 작업당 여러 개에 속할 수 있어 중복 규칙을
 *  따로 정해야 하므로 다음 단계로 미뤄져 있다. */
export type GroupAxis = "flat" | "cycle";

export interface SubGroup {
  /** 접힘 상태 키. `cycle:` 접두어를 붙여 프로젝트 id와 한 Set에서 섞이지 않게 한다. */
  key: string;
  name: string;
  /** "D-3" / "7/28 시작" / "7/12 종료". 날짜가 없으면 null. */
  due: string | null;
  dueKind: "soon" | "plain" | "past" | null;
  /** 사이클이 없는 작업을 모은 묶음이면 true — 더 흐리게 그린다. */
  ghost: boolean;
  items: WorkItem[];
}

/** ISO 날짜/타임스탬프를 로컬 달력 날짜(자정)로 읽는다. Plane은 프로젝트
 *  타임존 기준 날짜를 UTC로 저장해 내려주므로 문자열을 앞 10자로 자르면
 *  타임존에 따라 하루가 어긋난다 — isCompletedToday와 같이 Date로 변환해
 *  로컬 게터를 쓴다. */
function localDateOf(iso: string | null): Date | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 자정 기준 두 Date 사이의 날짜 수. */
function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** 한 프로젝트의 작업을 사이클별로 쪼갠다. 묶음이 하나뿐이면 빈 배열을
 *  돌려주고 호출부는 지금처럼 평평하게 그린다 — 사이클을 안 쓰는 프로젝트에
 *  "사이클 없음" 헤더 한 줄만 덧붙는 건 노이즈다.
 *
 *  순서는 진행 중 → 날짜 미정 → 예정 → 지난 → 사이클 없음. 진행 중은 종료가
 *  임박한 순, 예정은 시작이 이른 순, 지난 것은 최근 종료 순이다. 내 작업이
 *  하나도 없는 사이클은 묶음으로 만들지 않는다. */
export function splitByCycle(
  items: WorkItem[],
  cycles: Cycle[],
  itemCycle: Map<string, string>,
  now: Date = new Date(),
): SubGroup[] {
  const today = startOfDay(now);
  const byCycle = new Map<string, WorkItem[]>();
  const orphans: WorkItem[] = [];
  for (const it of items) {
    const cid = itemCycle.get(it.id);
    if (!cid) {
      orphans.push(it);
      continue;
    }
    const list = byCycle.get(cid);
    if (list) list.push(it);
    else byCycle.set(cid, [it]);
  }

  const ranked: { phase: number; sortKey: number; name: string; group: SubGroup }[] = [];
  for (const c of cycles) {
    const its = byCycle.get(c.id);
    if (!its || its.length === 0) continue;
    const start = localDateOf(c.start_date);
    const end = localDateOf(c.end_date);
    let phase: number;
    let sortKey: number;
    let due: string | null;
    let dueKind: SubGroup["dueKind"];
    if (!start || !end) {
      phase = 1; sortKey = 0; due = null; dueKind = null;
    } else if (start > today) {
      phase = 2; sortKey = start.getTime();
      due = `${start.getMonth() + 1}/${start.getDate()} 시작`; dueKind = "plain";
    } else if (end < today) {
      phase = 3; sortKey = -end.getTime();
      due = `${end.getMonth() + 1}/${end.getDate()} 종료`; dueKind = "past";
    } else {
      const left = dayDiff(today, end);
      phase = 0; sortKey = end.getTime();
      due = `D-${left}`; dueKind = left <= 3 ? "soon" : "plain";
    }
    ranked.push({
      phase, sortKey, name: c.name,
      group: { key: `cycle:${c.id}`, name: c.name, due, dueKind, ghost: false, items: its },
    });
  }
  ranked.sort(
    (a, b) =>
      a.phase - b.phase ||
      a.sortKey - b.sortKey ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const groups = ranked.map((r) => r.group);
  if (orphans.length > 0) {
    groups.push({
      key: "cycle:none", name: "사이클 없음",
      due: null, dueKind: null, ghost: true, items: orphans,
    });
  }
  return groups.length > 1 ? groups : [];
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run src/sidebar/logic.test.ts`
Expected: PASS — 새 9개 포함 전부 통과

- [ ] **Step 6: 커밋**

내부 작업이므로 CHANGELOG에 쓰지 않는다.

```bash
git add src/shared/types.ts src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "$(cat <<'EOF'
refactor: 프로젝트 작업을 사이클별로 쪼개는 splitByCycle 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## Task 5: 사이클 데이터를 가져오는 백엔드

**Files:**
- Modify: `src-tauri/src/plane_api.rs` (`Project` 구조체 17행, `RawProject` 199행, 새 타입·메서드·순수 함수, `#[cfg(test)]` 블록)
- Modify: `src-tauri/src/commands.rs` (새 DTO + 명령)
- Modify: `src-tauri/src/lib.rs` (명령 등록)

**Interfaces:**
- Consumes: 기존 `PlaneClient`, `Paginated<T>`, `client(&app)`
- Produces:
  - `plane_api::Project`에 `cycle_view: bool` 필드가 생긴다
  - `plane_api::Cycle { id, name, project_id, start_date, end_date }`
  - `PlaneClient::list_cycles(&self, project_id: &str) -> Result<Vec<Cycle>, String>`
  - `PlaneClient::list_cycle_issue_ids(&self, project_id: &str, cycle_id: &str) -> Result<Vec<String>, String>`
  - `plane_api::select_cycles_to_fetch(cycles: &[Cycle], today: &str) -> Vec<Cycle>`
  - Tauri 명령 `fetch_cycle_data(today: String) -> CycleDataDto`
  - `commands::CycleDataDto { cycles: Vec<CycleDto>, item_cycle: HashMap<String, String> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/plane_api.rs`의 `#[cfg(test)] mod tests` 안, 기존 테스트 뒤에 추가한다:

```rust
fn cyc(id: &str, end: Option<&str>) -> Cycle {
    Cycle {
        id: id.into(),
        name: format!("c{id}"),
        project_id: "p1".into(),
        start_date: Some("2026-01-01".into()),
        end_date: end.map(|e| e.into()),
    }
}

#[test]
fn select_cycles_keeps_every_running_upcoming_and_undated_cycle() {
    let cycles = vec![
        cyc("running", Some("2026-07-25")),
        cyc("upcoming", Some("2026-09-01")),
        cyc("undated", None),
    ];
    let picked = select_cycles_to_fetch(&cycles, "2026-07-22");
    let mut ids: Vec<&str> = picked.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["running", "undated", "upcoming"]);
}

#[test]
fn select_cycles_keeps_only_the_six_most_recently_ended_past_cycles() {
    let mut cycles = vec![cyc("live", Some("2026-08-01"))];
    // 2026-07-01 부터 하루씩 앞당겨 지난 사이클 8개
    for i in 1..=8 {
        cycles.push(cyc(&format!("past{i}"), Some(&format!("2026-07-{:02}", 21 - i))));
    }
    let picked = select_cycles_to_fetch(&cycles, "2026-07-22");
    let ids: Vec<&str> = picked.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"live"));
    // 종료일이 최신인 6개(past1..past6)만 남고 past7/past8은 빠진다.
    for keep in ["past1", "past6"] {
        assert!(ids.contains(&keep), "{keep} should be kept, got {ids:?}");
    }
    for drop in ["past7", "past8"] {
        assert!(!ids.contains(&drop), "{drop} should be dropped, got {ids:?}");
    }
    assert_eq!(picked.len(), 7);
}

#[test]
fn select_cycles_treats_a_cycle_ending_today_as_still_running() {
    let cycles = vec![cyc("today", Some("2026-07-22T14:59:59Z"))];
    assert_eq!(select_cycles_to_fetch(&cycles, "2026-07-22").len(), 1);
}

#[tokio::test]
async fn list_cycles_parses_names_and_dates() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/workspaces/ws/projects/p1/cycles/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                { "id": "c1", "name": "Sprint 12", "start_date": "2026-07-13", "end_date": "2026-07-25" },
                { "id": "c2", "name": "초안", "start_date": null, "end_date": null }
            ]
        })))
        .mount(&server)
        .await;
    let client = client_for(&server).await;
    let cycles = client.list_cycles("p1").await.unwrap();
    assert_eq!(cycles.len(), 2);
    assert_eq!(cycles[0].name, "Sprint 12");
    assert_eq!(cycles[0].project_id, "p1");
    assert_eq!(cycles[0].end_date.as_deref(), Some("2026-07-25"));
    assert_eq!(cycles[1].start_date, None);
}

#[tokio::test]
async fn list_cycle_issue_ids_returns_just_the_issue_ids() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/workspaces/ws/projects/p1/cycles/c1/cycle-issues/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                { "id": "ci1", "issue": "i1", "cycle": "c1" },
                { "id": "ci2", "issue": "i2", "cycle": "c1" }
            ]
        })))
        .mount(&server)
        .await;
    let client = client_for(&server).await;
    assert_eq!(client.list_cycle_issue_ids("p1", "c1").await.unwrap(), vec!["i1", "i2"]);
}
```

> 기존 mock 테스트가 어떤 경로 접두어(`/api/v1/workspaces/ws/...`)를 쓰는지는
> 같은 파일의 `list_projects_parses_results_and_sends_api_key`(약 788행)를 그대로
> 따른다. 접두어가 다르면 그 테스트에 맞춘다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd src-tauri && cargo test select_cycles list_cycle`
Expected: 컴파일 실패 — `cannot find type Cycle` / `no method named list_cycles`

- [ ] **Step 3: `plane_api.rs`에 타입과 메서드를 더한다**

`Project` 구조체(17행)를 바꾼다:

```rust
#[derive(Debug, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub identifier: String,
    /// 프로젝트에서 사이클 기능을 켰는지. 꺼져 있으면 cycles/ 조차 부르지 않는다.
    pub cycle_view: bool,
}
```

`RawProject`(199행)에 필드를 더한다:

```rust
#[derive(Deserialize)]
struct RawProject {
    id: String,
    name: String,
    #[serde(default)] identifier: String,
    #[serde(default)] is_member: bool,
    /// 응답에 없으면 켜진 것으로 본다 — 없다고 사이클을 못 보게 하면
    /// 서버 버전 차이가 조용한 기능 상실이 된다.
    #[serde(default = "default_true")] cycle_view: bool,
}

fn default_true() -> bool { true }
```

`list_projects`의 매핑을 바꾼다:

```rust
            .map(|p| Project {
                id: p.id,
                name: p.name,
                identifier: p.identifier,
                cycle_view: p.cycle_view,
            })
```

`Project` 정의 뒤에 사이클 타입을 더한다:

```rust
#[derive(Debug, Clone)]
pub struct Cycle {
    pub id: String,
    pub name: String,
    pub project_id: String,
    /// "YYYY-MM-DD" 또는 UTC 타임스탬프. 초안 사이클은 둘 다 None이다.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}
```

`RawProjectState` 근처(약 248행)에 원시 타입을 더한다:

```rust
#[derive(Deserialize)]
struct RawCycle {
    id: String,
    #[serde(default)] name: String,
    start_date: Option<String>,
    end_date: Option<String>,
}

/// cycle-issues/ 행에서 필요한 건 작업 id뿐이다 (cycle id는 요청 경로로 이미 안다).
#[derive(Deserialize)]
struct RawCycleIssue { issue: String }
```

`list_states` 근처에 메서드 두 개를 더한다:

```rust
    pub async fn list_cycles(&self, project_id: &str) -> Result<Vec<Cycle>, String> {
        let url = format!("{}/projects/{}/cycles/?per_page=100", self.ws_base(), project_id);
        let page: Paginated<RawCycle> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|c| Cycle {
                id: c.id,
                name: c.name,
                project_id: project_id.to_string(),
                start_date: c.start_date,
                end_date: c.end_date,
            })
            .collect())
    }

    /// 사이클에 속한 작업 id 목록. Plane의 work-items 응답에는 cycle 필드가
    /// 없어(IssueSerializer에 정의되지 않아 expand=cycle도 통하지 않는다)
    /// 소속은 이 엔드포인트로만 알 수 있다.
    pub async fn list_cycle_issue_ids(
        &self,
        project_id: &str,
        cycle_id: &str,
    ) -> Result<Vec<String>, String> {
        let url = format!(
            "{}/projects/{}/cycles/{}/cycle-issues/?per_page=100",
            self.ws_base(),
            project_id,
            cycle_id
        );
        let page: Paginated<RawCycleIssue> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page.results.into_iter().map(|c| c.issue).collect())
    }
```

`resolve_state_id` 근처(파일 위쪽 순수 함수 구역)에 선택 로직을 더한다:

```rust
/// 지난 사이클을 프로젝트마다 최대 몇 개까지 가져올지. 2주 스프린트 기준 약
/// 3개월. 이보다 오래된 사이클에 남은 미완료 작업은 "사이클 없음"에 들어간다 —
/// 사이드바는 미완료와 오늘 완료된 작업만 보여주므로 실제로 드문 경우다.
const PAST_CYCLE_LIMIT: usize = 6;

/// 소속을 받아올 사이클을 고른다. 진행 중·예정·날짜 미정은 전부 남기고,
/// 이미 끝난 것은 종료일이 최신인 PAST_CYCLE_LIMIT개까지만 남긴다.
/// `today`는 "YYYY-MM-DD".
pub fn select_cycles_to_fetch(cycles: &[Cycle], today: &str) -> Vec<Cycle> {
    let ended = |c: &Cycle| -> Option<String> {
        // 타임스탬프면 날짜 부분만 본다. UTC와 로컬이 갈리는 자정 경계에서
        // 하루 어긋날 수 있지만, 그 경우 어느 쪽으로 갈려도 최신 6개 안에 든다.
        let end = c.end_date.as_deref()?;
        let day = end.get(..10)?.to_string();
        if day.as_str() < today { Some(day) } else { None }
    };
    let mut keep: Vec<Cycle> = Vec::new();
    let mut past: Vec<(String, Cycle)> = Vec::new();
    for c in cycles {
        match ended(c) {
            Some(day) => past.push((day, c.clone())),
            None => keep.push(c.clone()),
        }
    }
    past.sort_by(|a, b| b.0.cmp(&a.0));
    keep.extend(past.into_iter().take(PAST_CYCLE_LIMIT).map(|(_, c)| c));
    keep
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd src-tauri && cargo test`
Expected: PASS — 새 5개 포함 전부 통과. `Project` 필드가 늘어 기존 테스트가
컴파일에 실패하면 그 생성부에 `cycle_view: true`를 더한다.

- [ ] **Step 5: Tauri 명령을 더한다**

`src-tauri/src/commands.rs`의 `SidebarData` 정의 근처에 DTO를 더한다:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct CycleDto {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CycleDataDto {
    pub cycles: Vec<CycleDto>,
    /// 작업 id → 사이클 id. 사이클은 작업당 최대 1개라 맵으로 충분하다.
    pub item_cycle: std::collections::HashMap<String, String>,
}
```

`fetch_sidebar_data` 뒤에 명령을 더한다:

```rust
/// 사이클 목록과 작업↔사이클 소속을 가져온다. `fetch_sidebar_data`와 별도인
/// 이유는 두 가지다 — (1) 사용자가 사이클별 보기를 고르기 전에는 요청이
/// 한 건도 나가지 않아야 하고, (2) 소속은 작업 목록보다 훨씬 덜 바뀌어
/// 갱신 주기를 따로 가져가기 때문이다(캐시는 프론트엔드가 관리한다).
/// `today`는 "YYYY-MM-DD" — 사용자 로컬 날짜는 프론트엔드가 안다
/// (`fetch_sidebar_data`가 날짜창을 받는 것과 같은 이유).
///
/// 프로젝트를 순차로 도는 것은 의도적이다 — `fetch_sidebar_data_online`은
/// `buffer_unordered`로 병렬화하지만, 여기서는 사이클마다 요청이 한 건씩 더
/// 붙어 총 요청 수가 훨씬 많다. Plane의 API 키당 60 req/min을 넘기지 않도록
/// 느리더라도 순차로 둔다 (호출 자체가 10분에 한 번뿐이다).
#[tauri::command]
pub async fn fetch_cycle_data(
    app: tauri::AppHandle,
    today: String,
) -> Result<CycleDataDto, String> {
    let (client, _s) = client(&app)?;
    let projects = client.list_projects().await?;
    let mut cycles: Vec<CycleDto> = Vec::new();
    let mut item_cycle = std::collections::HashMap::new();
    for p in projects.iter().filter(|p| p.cycle_view) {
        let all = client.list_cycles(&p.id).await?;
        for c in plane_api::select_cycles_to_fetch(&all, &today) {
            for issue_id in client.list_cycle_issue_ids(&p.id, &c.id).await? {
                item_cycle.insert(issue_id, c.id.clone());
            }
            cycles.push(CycleDto {
                id: c.id,
                name: c.name,
                project_id: c.project_id,
                start_date: c.start_date,
                end_date: c.end_date,
            });
        }
    }
    Ok(CycleDataDto { cycles, item_cycle })
}
```

`src-tauri/src/lib.rs`의 `invoke_handler![...]` 목록에서 `commands::fetch_sidebar_data`
바로 뒤에 `commands::fetch_cycle_data,`를 더한다.

- [ ] **Step 6: 빌드와 테스트**

Run: `cd src-tauri && cargo test && cargo build`
Expected: 둘 다 성공

- [ ] **Step 7: 커밋**

백엔드 배관이라 CHANGELOG에 쓰지 않는다 (화면에는 아직 아무 변화가 없다).

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(backend): 사이클 목록과 작업 소속을 가져오는 fetch_cycle_data

work-items 응답에 cycle 필드가 없어(IssueSerializer에 없어 expand도
통하지 않는다) cycles/ 와 cycle-issues/ 로 따로 받는다. cycle_view가
꺼진 프로젝트는 건너뛰고, 지난 사이클은 종료일 최신 6개까지만 본다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## Task 6: 프론트엔드 사이클 데이터 계층

**Files:**
- Modify: `src/shared/ipc.ts` (`fetchSidebarData` 근처)
- Modify: `src/sidebar/main.ts` (상태 변수 구역 — `HIDE_DONE_KEY` 근처)

**Interfaces:**
- Consumes: Task 4의 `CycleData` 타입, Task 5의 `fetch_cycle_data` 명령
- Produces:
  - `fetchCycleData(today: string): Promise<CycleData>` (ipc.ts)
  - `main.ts` 모듈 스코프: `cycleData: CycleData | null`, `itemCycleMap: Map<string, string>`
  - `ensureCycleData(): void` — 캐시가 신선하지 않으면 백그라운드로 받아오고, 도착하면 `renderFromLastData()`를 부른다

- [ ] **Step 1: ipc 래퍼를 더한다**

`src/shared/ipc.ts`의 타입 import 줄에 `CycleData`를 더하고, `fetchSidebarData`
정의 바로 뒤에 추가한다:

```ts
export const fetchCycleData = (today: string) =>
  invoke<CycleData>("fetch_cycle_data", { today });
```

- [ ] **Step 2: `main.ts`에 캐시와 로더를 더한다**

`main.ts`의 `const HIDE_DONE_KEY = "hideCompleted";` 블록 바로 뒤에 추가한다:

```ts
// 사이클 데이터. 작업 목록(60초 쿨다운)보다 훨씬 덜 바뀌므로 갱신 주기를
// 따로 가져간다. 캐시를 localStorage에 두어 앱을 다시 켰을 때와 네트워크가
// 끊겼을 때 마지막 성공 결과를 그대로 쓴다.
const CYCLE_CACHE_KEY = "cycleDataCache";
const CYCLE_TTL_MS = 10 * 60_000;
let cycleData: CycleData | null = null;
let cycleFetchedAtMs = 0;
let cycleInFlight: Promise<void> | null = null;
let itemCycleMap = new Map<string, string>();

function setCycleData(data: CycleData, fetchedAtMs: number): void {
  cycleData = data;
  cycleFetchedAtMs = fetchedAtMs;
  itemCycleMap = new Map(Object.entries(data.item_cycle));
}

function loadCachedCycleData(): void {
  try {
    const raw = localStorage.getItem(CYCLE_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { data: CycleData; at: number };
    if (parsed?.data?.cycles && parsed.data.item_cycle) setCycleData(parsed.data, parsed.at);
  } catch {
    // 손상된 캐시는 없는 셈 친다 — 다음 요청이 다시 채운다.
  }
}
loadCachedCycleData();

/** 사이클별 보기에 필요한 데이터를 확보한다. 신선한 캐시가 있으면 아무것도
 *  하지 않고, 없으면 백그라운드로 받아온 뒤 화면을 다시 그린다. 실패하면
 *  낡은 캐시를 그대로 쓴다 — 축을 되돌리지는 않는다. 사용자가 자기가 뭘
 *  잘못 눌렀다고 오해하기 때문이다. */
function ensureCycleData(): void {
  if (cycleInFlight) return;
  if (cycleData && Date.now() - cycleFetchedAtMs < CYCLE_TTL_MS) return;
  const stale = cycleData === null;
  if (stale) synced.textContent = "사이클 불러오는 중…";
  cycleInFlight = fetchCycleData(resolveDatePreset("today"))
    .then((data) => {
      const at = Date.now();
      setCycleData(data, at);
      localStorage.setItem(CYCLE_CACHE_KEY, JSON.stringify({ data, at }));
      renderFromLastData();
    })
    .catch((err) => {
      console.error("fetchCycleData failed:", err);
      if (stale) synced.textContent = "사이클을 불러오지 못했습니다";
    })
    .finally(() => {
      cycleInFlight = null;
    });
}
```

`main.ts` 5번째 줄의 `../shared/ipc` import 목록에 `fetchCycleData`를,
15번째 줄의 타입 import에 `CycleData`를 더한다.

- [ ] **Step 3: 타입 검사**

Run: `pnpm build`
Expected: 성공. `renderFromLastData`는 `main.ts:176`의 함수 **선언**이라
호이스팅되므로 이 코드가 그 위에 있어도 된다.

- [ ] **Step 4: 커밋**

아직 화면에 안 보이므로 CHANGELOG에 쓰지 않는다.

```bash
git add src/shared/ipc.ts src/sidebar/main.ts
git commit -m "$(cat <<'EOF'
refactor: 사이클 데이터 IPC 래퍼와 10분 localStorage 캐시

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## Task 7: 축 전환 UI와 하위 묶음 렌더링

**Files:**
- Modify: `src/sidebar/index.html` (섹션 헤더 `#sectionHead`)
- Modify: `src/shared/app.css` (`.fold-btn` 규칙 근처에 `.axis-btn`, `.grp` 규칙 뒤에 `.sub` / `.sub-body`)
- Modify: `src/sidebar/main.ts` (축 상태, 팝오버, `renderTasks` 분기, `runRefresh`의 버튼 이동)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 4의 `splitByCycle`·`GroupAxis`·`SubGroup`, Task 6의 `cycleData`·`itemCycleMap`·`ensureCycleData`, 기존 `collapsedGroups`·`persistCollapsedGroups`·`groupProgress`·`progressRingSvg`·`renderTaskRow`·`attachPopover`·`closePopover`
- Produces: 없음 (기능 종단)

- [ ] **Step 1: 축 버튼 요소를 넣는다**

`src/sidebar/index.html`의 `#sectionHead` 블록을 바꾼다:

```html
          <div class="h" id="sectionHead">
            <span id="sectionTitle">나에게 할당된 작업</span>
            <span id="taskCount" class="count">0</span>
            <span id="axisBtn" class="axis-btn" title="프로젝트 안에서 묶는 기준">전체 작업<span class="car">▾</span></span>
```

(`</div>` 앞이며, `#foldAll`은 스크립트가 옮겨 붙이므로 여기 쓰지 않는다.)

- [ ] **Step 2: CSS를 넣는다**

`src/shared/app.css`의 `.fold-btn[hidden] { ... }` 규칙 바로 뒤에 추가한다:

```css
/* 프로젝트 안에서 작업을 어떻게 묶을지 고르는 버튼. fold-btn 과 마찬가지로
   지금 보이는 줄(탭 줄 또는 섹션 헤더)로 스크립트가 옮겨 붙인다 — 위임 탭이
   켜져 있으면 섹션 헤더가 통째로 숨기 때문이다. */
.axis-btn {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 5px; border-radius: 5px; cursor: pointer;
  /* .sb-section .h 가 uppercase/letter-spacing 을 걸어두므로 되돌린다. */
  font-size: 10.5px; letter-spacing: 0; text-transform: none; color: var(--muted);
}
.axis-btn:hover { background: var(--panel-2); color: var(--text); }
/* 기본(전체 작업)이 아닐 때만 강조 — "지금 평소와 다르게 보고 있다"는 신호. */
.axis-btn.alt { color: var(--accent); background: var(--accent-soft); }
.axis-btn .car { font-size: 8px; opacity: .8; }
.axis-btn[hidden] { display: none; }
.sb-section .h .axis-btn { margin-left: 6px; }
.sb-tabs .axis-btn { align-self: center; margin: 0 0 4px 4px; }
```

`.grp-body.collapsed { display: none; }` 규칙 바로 뒤에 추가한다:

```css
/* 프로젝트 그룹 안의 하위 묶음(사이클). 프로젝트 헤더(.grp)보다 확실히
   가벼워야 두 단이 안 싸운다 — 점 없음, 작은 글씨, 기본 muted.
   .grp 와 달리 sticky 를 걸지 않는다: 상단에 붙어 있어야 할 줄은 프로젝트
   헤더 하나뿐이고, 두 단이 다 sticky 면 스크롤 중 서로 밀어낸다. */
.sub {
  display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
  margin: 4px 0 2px 12px; padding: 4px 6px; border-radius: 6px;
  font-size: 11px; font-weight: 600; color: var(--muted);
}
.sub:hover { background: var(--surface-grp-hover); color: var(--text); }
.sub .chev { flex: none; width: 9px; text-align: center; font-size: 9px; transition: transform .15s; }
.sub.collapsed .chev { transform: rotate(-90deg); }
.sub .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub .spacer { margin-left: auto; }
.sub .due {
  flex: none; height: 15px; display: inline-flex; align-items: center; padding: 0 4px;
  border: 1px solid var(--border); border-radius: 4px;
  font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums;
}
.sub .due.soon { color: var(--amber); border-color: var(--amber); }
.sub .due.past { color: var(--muted-2); border-style: dashed; }
.sub .prog { margin-left: 6px; display: flex; align-items: center; gap: 5px; flex: none; }
/* 프로젝트 링(14px)보다 작게 그려 위계를 나눈다. 두 링 모두 "내게 할당된
   작업" 기준이다 — 하위에 사이클 전체(팀 전원) 진행률을 쓰면 "내 목록엔
   2개인데 링은 12개"가 되어 두 숫자가 서로 다른 것을 세게 된다. */
.sub .prog .ring { width: 12px; height: 12px; display: block; }
.sub .prog .txt { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
/* "사이클 없음"은 실체가 있는 묶음이 아니라 한 단계 더 흐리게. */
.sub.ghost .name { color: var(--muted-2); font-weight: 500; }

/* 왼쪽 세로 가이드선이 "이 카드들은 위 줄에 속한다"를 말한다. 들여쓰기가
   한 번뿐이라 작업 카드 폭은 조금만 준다. */
.sub-body { margin-left: 17px; padding-left: 8px; border-left: 1px solid var(--border); }
.sub-body.collapsed { display: none; }
```

- [ ] **Step 3: 축 상태와 팝오버를 더한다**

`main.ts`의 `const foldAllEl = document.getElementById("foldAll")!;` 바로 뒤에 추가한다:

```ts
const axisBtnEl = document.getElementById("axisBtn")!;

// 묶는 기준. 화면 취향이라 localStorage에 둔다 (hideCompleted와 같은 자리).
const GROUP_AXIS_KEY = "sidebarGroupAxis";
let groupAxis: GroupAxis = localStorage.getItem(GROUP_AXIS_KEY) === "cycle" ? "cycle" : "flat";

const AXIS_LABEL: Record<GroupAxis, string> = { flat: "전체 작업", cycle: "사이클별" };

function syncAxisButton(): void {
  axisBtnEl.innerHTML = `${AXIS_LABEL[groupAxis]}<span class="car">▾</span>`;
  axisBtnEl.classList.toggle("alt", groupAxis !== "flat");
}
syncAxisButton();

function setGroupAxis(next: GroupAxis): void {
  groupAxis = next;
  localStorage.setItem(GROUP_AXIS_KEY, next);
  syncAxisButton();
  if (next === "cycle") ensureCycleData();
  renderTasks(lastItems, lastProjects);
}

axisBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (openPopover) {
    closePopover();
    return;
  }
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = "156px";

  const head = document.createElement("div");
  head.className = "pop-head";
  // 프로젝트가 언제나 최상위임을 제목이 못박는다.
  head.textContent = "프로젝트 안에서";
  pop.appendChild(head);

  for (const axis of ["flat", "cycle"] as GroupAxis[]) {
    const item = document.createElement("div");
    item.className = "pop-item" + (groupAxis === axis ? " sel" : "");
    item.textContent = AXIS_LABEL[axis];
    item.onclick = (ev) => {
      ev.stopPropagation();
      closePopover();
      setGroupAxis(axis);
    };
    pop.appendChild(item);
  }

  const rect = axisBtnEl.getBoundingClientRect();
  attachPopover(pop, rect.right - 156, rect.bottom + 6);
});
```

`main.ts` 9번째 줄의 `./logic` import 목록에 `splitByCycle`을 더하고,
10번째 줄의 타입 import를 `import type { GroupAxis, SidebarTab, SubGroup } from "./logic";`으로 바꾼다.

- [ ] **Step 4: 축 버튼도 보이는 줄로 옮긴다**

`main.ts`의 `runRefresh`(약 1012행)에서

```ts
    (s.show_delegated_tab ? sbTabsEl : sectionHeadEl).appendChild(foldAllEl);
```

를 아래로 바꾼다:

```ts
    // 두 버튼 모두 지금 보이는 줄의 오른쪽 끝에 있어야 한다. 순서가 곧
    // 화면 순서이므로 축 버튼을 먼저 붙인다.
    const controlRow = s.show_delegated_tab ? sbTabsEl : sectionHeadEl;
    controlRow.appendChild(axisBtnEl);
    controlRow.appendChild(foldAllEl);
```

- [ ] **Step 5: `renderTasks`가 하위 묶음을 그리게 한다**

`main.ts`의 `renderTasks` 안, 프로젝트 본문을 만드는 마지막 부분

```ts
    const body = document.createElement("div");
    body.className = "grp-body" + (collapsed ? " collapsed" : "");
    // Filter rows only — the group header (and its progress ring above) still
    // counts hidden completed items, so "3/3" stays visible when all are done.
    for (const it of filterHiddenCompleted(groupItems, hideCompleted)) {
      body.appendChild(renderTaskRow(it, items, projects));
    }
    tasksEl.appendChild(body);
```

를 아래로 바꾼다:

```ts
    const body = document.createElement("div");
    body.className = "grp-body" + (collapsed ? " collapsed" : "");
    // 검색·필터 중에는 하위 묶음을 그리지 않는다 — "3개 결과"가 세 묶음에
    // 하나씩 흩어지면 좁히려던 목적과 반대로 찾기 어려워진다.
    const subs =
      groupAxis === "cycle" && !isFiltering && cycleData
        ? splitByCycle(groupItems, cycleData.cycles.filter((c) => c.project_id === project.id), itemCycleMap)
        : [];
    if (subs.length > 0) {
      for (const sub of subs) body.appendChild(renderSubGroup(sub, items, projects));
    } else {
      // Filter rows only — the group header (and its progress ring above) still
      // counts hidden completed items, so "3/3" stays visible when all are done.
      for (const it of filterHiddenCompleted(groupItems, hideCompleted)) {
        body.appendChild(renderTaskRow(it, items, projects));
      }
    }
    tasksEl.appendChild(body);
```

그리고 `renderTasks` 정의 바로 뒤에 하위 묶음 렌더러를 더한다:

```ts
/** 하위 묶음 헤더 한 줄 + 그 아래 카드들을 담은 조각을 만든다. 접힘 상태는
 *  프로젝트와 같은 collapsedGroups Set을 쓰되 sub.key가 "cycle:" 접두어를
 *  달고 있어 프로젝트 id와 섞이지 않는다. */
function renderSubGroup(sub: SubGroup, items: WorkItem[], projects: Project[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const collapsed = collapsedGroups.has(sub.key);

  const head = document.createElement("div");
  head.className = "sub" + (collapsed ? " collapsed" : "") + (sub.ghost ? " ghost" : "");

  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▾";
  head.appendChild(chev);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sub.name;
  head.appendChild(name);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.appendChild(spacer);

  if (sub.due) {
    const due = document.createElement("span");
    due.className = "due" + (sub.dueKind === "soon" ? " soon" : sub.dueKind === "past" ? " past" : "");
    due.textContent = sub.due;
    head.appendChild(due);
  }

  const prog = groupProgress(sub.items);
  const progEl = document.createElement("span");
  progEl.className = "prog";
  progEl.title = `내 작업 ${prog.done}/${prog.total} 완료`;
  progEl.innerHTML = progressRingSvg(prog.done, prog.total) + `<span class="txt">${prog.done}/${prog.total}</span>`;
  head.appendChild(progEl);

  head.onclick = () => {
    if (collapsedGroups.has(sub.key)) collapsedGroups.delete(sub.key);
    else collapsedGroups.add(sub.key);
    persistCollapsedGroups();
    renderTasks(items, projects);
  };
  frag.appendChild(head);

  const body = document.createElement("div");
  body.className = "sub-body" + (collapsed ? " collapsed" : "");
  for (const it of filterHiddenCompleted(sub.items, hideCompleted)) {
    body.appendChild(renderTaskRow(it, items, projects));
  }
  frag.appendChild(body);
  return frag;
}
```

- [ ] **Step 6: 축이 사이클일 때 시작하자마자 데이터를 받아온다**

`main.ts`의 `runRefresh` 안, `renderTasks`를 부르는 자리(약 649행 / 694행이 아니라
`runRefresh` 본문에서 데이터를 받은 직후) 뒤에 한 줄 더한다:

```ts
    if (groupAxis === "cycle") ensureCycleData();
```

- [ ] **Step 7: "모두 접기"가 프로젝트 단만 접는지 확인한다**

`allGroupsCollapsed`와 `foldAllEl.onclick`은 `lastGroupIds`(프로젝트 id 목록)만
본다. `collapsedGroups.clear()`가 하위 묶음의 접힘까지 지우는 것은 "모두 펼치기"의
자연스러운 뜻이므로 그대로 둔다. **코드 변경 없음** — 읽어서 확인만 한다.

- [ ] **Step 8: 타입 검사와 테스트**

Run: `pnpm build && pnpm test`
Expected: 빌드 성공, 테스트 전부 PASS

- [ ] **Step 9: 앱에서 확인한다**

Run: `pnpm tauri dev`
확인 항목:
1. 섹션 헤더 오른쪽에 "전체 작업 ▾"이 있고, 눌러 "사이클별"을 고르면 파랗게 강조된다
2. 사이클을 쓰는 프로젝트 안에 사이클 헤더가 뜨고, 왼쪽 세로 가이드선이 카드들을 감싼다
3. 사이클 헤더 순서가 진행 중 → 예정 → 지난 → 사이클 없음이고, 기간 배지(D-n / 시작 / 종료)가 맞다
4. 사이클을 안 쓰는 프로젝트는 하위 헤더 없이 지금처럼 평평하다
5. 사이클 헤더를 눌러 접었다 펴진다. 프로젝트를 접으면 하위까지 통째로 숨는다
6. Ctrl+F로 검색하면 하위 묶음이 사라지고 평평해진다. 검색을 닫으면 돌아온다
7. 설정에서 "내가 할당한 작업" 탭을 켜면 축 버튼이 탭 줄 오른쪽 끝으로 옮겨 간다
8. 사이드바를 닫았다 열어도 축 선택이 유지된다
9. 축을 사이클별로 바꾸기 전에는 네트워크 요청이 늘지 않는다 (개발자 도구 네트워크 탭)

- [ ] **Step 10: CHANGELOG에 한 줄 쓴다**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 추가`에 (없으면 만들어서) 추가한다:

```markdown
- 사이드바에서 각 프로젝트의 작업을 사이클별로 묶어 볼 수 있습니다 (섹션 오른쪽 "전체 작업 ▾")
```

- [ ] **Step 11: 커밋**

```bash
git add src/sidebar/index.html src/shared/app.css src/sidebar/main.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat: 프로젝트 안에서 작업을 사이클별로 묶어 보기

프로젝트 그룹은 그대로 두고 그 안쪽만 사이클로 나눈다. 하위 묶음은
sticky 를 걸지 않고 세로 가이드선으로 소속을 보여 프로젝트 헤더와
위계가 뒤집히지 않게 했다. 검색·필터 중에는 결과가 흩어지지 않도록
하위 묶음을 끈다.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QWybNn4CPQZZWRLPN6Lv8i
EOF
)"
```

---

## 자체 검토 결과

스펙 대비 확인한 것:

- **A1 기본 폭 352 + 다섯 곳 통합** → Task 2
- **A2 드래그(screenX, rAF, 범위, 더블클릭 리셋, 폴백)** → Task 3
- **A3 설정 저장** → Task 2/3 (localStorage로 변경, 위 "정정" 항목 참고)
- **A4 `clampSidebarWidth` 테스트** → Task 1
- **B1 프로젝트 최상위·가벼운 하위·sticky 없음·축 선택 후 요청** → Task 4/5/7
- **B2 `cycle_view` 건너뛰기·지난 6개 제한·10분 주기** → Task 5(앞 둘) / Task 6(마지막)
- **B3 `splitByCycle` 순서·배지·빈 묶음 제외·하나면 빈 배열** → Task 4
- **B4 축 드롭다운·`.sub` CSS·진행률 링 위계** → Task 7
- **B5 상호작용 5가지(검색 중 끔, 접힘 키 분리, 모두 접기, 프로젝트 접힘, 실패 시 축 유지)** → Task 6/7
- **B6 테스트** → Task 1/4/5
- **B7 모듈 2단계** → 이 계획의 범위 밖 (`GroupAxis`에 `"module"`을 더하고 `splitByModule`과 중복 칩만 추가하면 되도록 타입을 열어뒀다)

스펙 대비 빠진 요구사항은 없다.
