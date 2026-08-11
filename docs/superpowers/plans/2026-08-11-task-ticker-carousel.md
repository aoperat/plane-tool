# Task Ticker Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace idle-triggered sidebar opening with a focus-safe 540×64 task ticker that rotates one assigned task every seven seconds and hands off to the existing editor/sidebar.

**Architecture:** Add a sixth Tauri/Vite window under `src/ticker/`. Keep filtering, sorting, index reconciliation, and timer behavior in DOM-free TypeScript modules; keep rendering and Tauri event handling in `main.ts`. Reuse the existing sidebar data command, and route idle/window positioning plus shared mutation events through the Rust backend.

**Tech Stack:** Tauri 2, Rust 2021, Windows API via `windows` 0.61, TypeScript 6, Vite 8, Vitest 4, HTML/CSS.

## Global Constraints

- Candidate tasks are current-user assignments excluding `completed` and `cancelled`.
- Exclusive first-match order is overdue, due today, started, then all remaining open tasks.
- Compare dates in the user's local `YYYY-MM-DD` calendar date; future and undated work remains eligible.
- Rotate every `7_000` ms; hover/focus pauses and resume starts a fresh seven-second interval.
- The ticker is `540×64` logical pixels with a `16` logical-pixel right/bottom work-area margin.
- Initial show must not steal focus; focusability is restored afterward so pointer and Tab interaction work.
- Fetch once per idle session and on explicit refresh events only; do not add polling or a new cache layer.
- Keep `idle_open_enabled` and `idle_open_minutes` persisted names for configuration compatibility.
- Add a Korean `CHANGELOG.md` entry under `## [Unreleased]` in the same commit as the user-visible behavior.
- Preserve unrelated untracked files `.agents/` and `docs/mockups/quickadd-header-toggle-mockup.html`.

---

### Task 1: Task selection and carousel controller

**Files:**
- Create: `src/ticker/logic.ts`
- Create: `src/ticker/logic.test.ts`
- Create: `src/ticker/carousel.ts`
- Create: `src/ticker/carousel.test.ts`

**Interfaces:**
- Consumes: `WorkItem` and `Project` from `src/shared/types.ts`.
- Produces: `buildTickerItems(items: WorkItem[], projects: Project[], today: string): TickerItem[]`, `reconcileTickerIndex(items: TickerItem[], currentId: string | null, oldIndex: number): number`, `previousTickerIndex(index: number, length: number): number`, `nextTickerIndex(index: number, length: number): number`, and `createCarouselController(options: CarouselOptions): CarouselController`.
- `TickerItem` is `{ item: WorkItem; projectName: string; bucket: "overdue" | "today" | "started" | "remaining"; meta: string }`.
- `CarouselController` exposes `start()`, `stop()`, `setHovered(boolean)`, `setFocused(boolean)`, and `resetAfterManualNavigation()`.

- [ ] **Step 1: Write failing selection and ordering tests**

```ts
import { describe, expect, it } from "vitest";
import type { Project, WorkItem } from "../shared/types";
import { buildTickerItems, nextTickerIndex, previousTickerIndex, reconcileTickerIndex } from "./logic";

const project: Project = { id: "p1", name: "Plane Quick Dock", identifier: "PQD" };
const item = (id: string, patch: Partial<WorkItem> = {}): WorkItem => ({
  id, name: id, priority: "none", target_date: null, start_date: null,
  state_group: "unstarted", project_id: "p1", assignee_ids: ["me"],
  completed_at: null, created_at: "2026-08-01T00:00:00Z", ...patch,
});

describe("buildTickerItems", () => {
  it("excludes completed and cancelled work", () => {
    const result = buildTickerItems([
      item("open"), item("done", { state_group: "completed" }),
      item("cancelled", { state_group: "cancelled" }),
    ], [project], "2026-08-11");
    expect(result.map((x) => x.item.id)).toEqual(["open"]);
  });

  it("uses exclusive overdue, today, started, remaining buckets", () => {
    const result = buildTickerItems([
      item("future", { target_date: "2026-08-15" }),
      item("started", { state_group: "started" }),
      item("today", { target_date: "2026-08-11", state_group: "started" }),
      item("overdue", { target_date: "2026-08-10", state_group: "started" }),
    ], [project], "2026-08-11");
    expect(result.map((x) => [x.item.id, x.bucket])).toEqual([
      ["overdue", "overdue"], ["today", "today"],
      ["started", "started"], ["future", "remaining"],
    ]);
  });

  it("keeps input order when due dates tie", () => {
    const result = buildTickerItems([item("a"), item("b")], [project], "2026-08-11");
    expect(result.map((x) => x.item.id)).toEqual(["a", "b"]);
  });
});

it("wraps navigation and preserves current id across reorder", () => {
  const before = buildTickerItems([item("a"), item("b")], [project], "2026-08-11");
  const after = buildTickerItems([item("b"), item("a")], [project], "2026-08-11");
  expect(nextTickerIndex(1, 2)).toBe(0);
  expect(previousTickerIndex(0, 2)).toBe(1);
  expect(reconcileTickerIndex(after, before[1].item.id, 1)).toBe(0);
  expect(reconcileTickerIndex([after[0]], "missing", 1)).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm vitest run src/ticker/logic.test.ts`

Expected: FAIL because `src/ticker/logic.ts` does not exist.

- [ ] **Step 3: Implement the pure selection logic**

```ts
import type { Project, WorkItem } from "../shared/types";

export type TickerBucket = "overdue" | "today" | "started" | "remaining";
export interface TickerItem { item: WorkItem; projectName: string; bucket: TickerBucket; meta: string; }

const rank: Record<TickerBucket, number> = { overdue: 0, today: 1, started: 2, remaining: 3 };
function bucketFor(item: WorkItem, today: string): TickerBucket {
  const due = item.target_date?.slice(0, 10) ?? null;
  if (due && due < today) return "overdue";
  if (due === today) return "today";
  if (item.state_group === "started") return "started";
  return "remaining";
}

export function buildTickerItems(items: WorkItem[], projects: Project[], today: string): TickerItem[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.state_group !== "completed" && item.state_group !== "cancelled")
    .map(({ item, index }) => {
      const bucket = bucketFor(item, today);
      const meta = bucket === "overdue" ? "지연" : bucket === "today" ? "오늘 마감" :
        bucket === "started" ? "진행 중" : item.target_date?.slice(0, 10) ?? "기한 없음";
      return { item, index, projectName: names.get(item.project_id) ?? "알 수 없는 프로젝트", bucket, meta };
    })
    .sort((a, b) => rank[a.bucket] - rank[b.bucket] ||
      (a.item.target_date ?? "9999").localeCompare(b.item.target_date ?? "9999") || a.index - b.index)
    .map(({ index: _index, ...entry }) => entry);
}

export const nextTickerIndex = (index: number, length: number) => length === 0 ? 0 : (index + 1) % length;
export const previousTickerIndex = (index: number, length: number) => length === 0 ? 0 : (index - 1 + length) % length;
export function reconcileTickerIndex(items: TickerItem[], currentId: string | null, oldIndex: number): number {
  if (items.length === 0) return 0;
  const preserved = currentId ? items.findIndex((x) => x.item.id === currentId) : -1;
  return preserved >= 0 ? preserved : Math.min(oldIndex, items.length - 1);
}
```

- [ ] **Step 4: Run selection tests**

Run: `pnpm vitest run src/ticker/logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing fake-timer controller tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarouselController } from "./carousel";

afterEach(() => vi.useRealTimers());
describe("carousel controller", () => {
  it("advances at seven seconds and restarts a full interval after hover", () => {
    vi.useFakeTimers();
    const advance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance: advance });
    controller.start();
    vi.advanceTimersByTime(6_999); expect(advance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(advance).toHaveBeenCalledTimes(1);
    controller.setHovered(true); vi.advanceTimersByTime(20_000);
    expect(advance).toHaveBeenCalledTimes(1);
    controller.setHovered(false); vi.advanceTimersByTime(6_999);
    expect(advance).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(advance).toHaveBeenCalledTimes(2);
  });

  it("resumes only after both hover and focus clear", () => {
    vi.useFakeTimers();
    const advance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance: advance });
    controller.start(); controller.setHovered(true); controller.setFocused(true);
    controller.setHovered(false); vi.advanceTimersByTime(7_000);
    expect(advance).not.toHaveBeenCalled();
    controller.setFocused(false); vi.advanceTimersByTime(7_000);
    expect(advance).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 6: Run the controller test and confirm failure**

Run: `pnpm vitest run src/ticker/carousel.test.ts`

Expected: FAIL because `createCarouselController` does not exist.

- [ ] **Step 7: Implement the DOM-free controller**

```ts
export interface CarouselOptions { intervalMs: number; onAdvance: () => void; }
export interface CarouselController {
  start(): void; stop(): void; setHovered(value: boolean): void;
  setFocused(value: boolean): void; resetAfterManualNavigation(): void;
}

export function createCarouselController(options: CarouselOptions): CarouselController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false, hovered = false, focused = false;
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => {
    clear();
    if (!running || hovered || focused) return;
    timer = setTimeout(() => { options.onAdvance(); schedule(); }, options.intervalMs);
  };
  return {
    start() { running = true; schedule(); },
    stop() { running = false; clear(); },
    setHovered(value) { hovered = value; schedule(); },
    setFocused(value) { focused = value; schedule(); },
    resetAfterManualNavigation() { schedule(); },
  };
}
```

- [ ] **Step 8: Run all ticker unit tests and commit**

Run: `pnpm vitest run src/ticker/logic.test.ts src/ticker/carousel.test.ts`

Expected: PASS.

```powershell
git add src/ticker/logic.ts src/ticker/logic.test.ts src/ticker/carousel.ts src/ticker/carousel.test.ts
git commit -m "feat: 작업 전광판 캐러셀 로직 추가"
```

### Task 2: Windows work-area placement and idle routing

**Files:**
- Modify: `src-tauri/src/idle.rs`
- Modify: `src-tauri/src/monitors.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `IdleAction::OpenTicker` and `monitors::bottom_right_position(work_area: PhysicalRect, window: PhysicalSize<u32>, margin: u32) -> PhysicalPosition<i32>`.
- Produces internal `show_ticker_without_focus(app: &tauri::AppHandle)` and `hide_ticker(app: &tauri::AppHandle)` helpers.
- Consumes existing `monitors::sorted_indices_by_position`, `monitors::pick_index`, Tauri monitor physical coordinates, and Windows `GetMonitorInfoW.rcWork`.

- [ ] **Step 1: Rename the idle action in tests first**

Change `OpenSidebar` expectations in `src-tauri/src/idle.rs` tests to `OpenTicker` while leaving the enum unchanged.

- [ ] **Step 2: Run the Rust test and confirm failure**

Run: `cargo test idle::tests --manifest-path src-tauri/Cargo.toml`

Expected: compile failure because `IdleAction::OpenTicker` is not defined.

- [ ] **Step 3: Rename the enum variant and watcher event**

Rename `OpenSidebar` to `OpenTicker`, update its comments, and in `spawn_idle_watcher` emit `open-ticker` to label `ticker`. Emit `idle-ended` to `ticker`; stop emitting the idle lifecycle to `sidebar`.

- [ ] **Step 4: Add failing placement tests**

Add a small local `PhysicalRect { left, top, right, bottom }` type and these cases in `src-tauri/src/monitors.rs`:

```rust
#[test]
fn bottom_right_uses_work_area_and_margin() {
    let p = bottom_right_position(
        PhysicalRect { left: 0, top: 0, right: 1920, bottom: 1040 },
        PhysicalSize::new(540, 64), 16,
    );
    assert_eq!(p, PhysicalPosition::new(1364, 960));
}

#[test]
fn bottom_right_supports_negative_monitor_origins() {
    let p = bottom_right_position(
        PhysicalRect { left: -1920, top: 0, right: 0, bottom: 1040 },
        PhysicalSize::new(675, 80), 20,
    );
    assert_eq!(p, PhysicalPosition::new(-695, 940));
}
```

- [ ] **Step 5: Run placement tests and confirm failure**

Run: `cargo test monitors::tests --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because `PhysicalRect` and `bottom_right_position` do not exist.

- [ ] **Step 6: Implement physical placement and Windows work-area lookup**

Implement `bottom_right_position` with `x = right - window.width - margin` and `y = bottom - window.height - margin`. Under `cfg(windows)`, use the selected Tauri monitor's physical center with `MonitorFromPoint(..., MONITOR_DEFAULTTONEAREST)`, fill `MONITORINFO`, and return `rcWork`. Under non-Windows or lookup failure, construct a work rectangle from the Tauri monitor position and size. Keep negative coordinates as `i32`.

- [ ] **Step 7: Implement non-activating ticker show/hide**

In `lib.rs`, select the configured monitor with existing sort/pick helpers, calculate physical window size and `16.0 * scale_factor()` margin once, position the ticker, call `set_focusable(false)`, `show()`, then always attempt `set_focusable(true)` without calling `set_focus()`. `hide_ticker` emits `close-ticker` so the frontend clears its timer, then hides the Tauri window.

- [ ] **Step 8: Run Rust tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

```powershell
git add src-tauri/src/idle.rs src-tauri/src/monitors.rs src-tauri/src/lib.rs
git commit -m "feat: 유휴 시 작업 전광판 창 표시"
```

### Task 3: Tauri window, shortcut coordination, and shared mutation events

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/shared/types.ts`
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Adds window label `ticker`; the Vite entry is deferred to Task 4 when its HTML exists.
- Produces shared TypeScript `ItemChange` with optional `priority`, `state_group`, `start_date`, `target_date`, and `assignee_ids` fields matching Rust JSON payloads.
- Emits `refresh-sidebar`, `item-updated`, and `item-deleted` with identical payloads to both `sidebar` and `ticker`.

- [ ] **Step 1: Add the Tauri window declarations**

Add this Tauri window beside sidebar:

```json
{
  "label": "ticker",
  "url": "src/ticker/index.html",
  "width": 540,
  "height": 64,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "shadow": false,
  "skipTaskbar": true,
  "visible": false,
  "resizable": false
}
```

Add `ticker` to the capability window array. Do not add the Vite input until Task 4 creates
`src/ticker/index.html`, so Task 3 remains independently buildable.

- [ ] **Step 2: Extract the shared update payload type**

Move the local sidebar payload shape to `src/shared/types.ts`:

```ts
export interface ItemChange {
  item_id: string;
  project_id: string;
  priority?: string;
  state_group?: string;
  start_date?: string | null;
  target_date?: string | null;
  assignee_ids?: string[];
}
```

Import it in sidebar and preserve the existing empty-string-to-null normalization if Rust still sends empty strings.

- [ ] **Step 3: Centralize dual-window event emission**

Add small Rust helpers in `lib.rs` or a focused local module:

```rust
fn emit_sidebar_and_ticker<T: Clone + serde::Serialize>(app: &tauri::AppHandle, event: &str, payload: T) {
    let _ = app.emit_to("sidebar", event, payload.clone());
    let _ = app.emit_to("ticker", event, payload);
}
```

Use the helper at create refresh sites, online/offline update sites, online/offline delete sites, offline replay refresh, and conflict-resolution refresh. Do not expand scope to assignment badges or release notes.

- [ ] **Step 4: Coordinate global F2**

In the sidebar shortcut branch, call `hide_ticker(app)` before emitting `toggle-sidebar`. Keep toggle semantics: if the sidebar is already visible, F2 may close it. Use the same helper for the tray sidebar action so both entry points leave no ticker behind.

- [ ] **Step 5: Remove sidebar idle-only state**

Delete `autoOpened`, the `open-sidebar`/`idle-ended` listeners, and the pointer reset listener in `src/sidebar/main.ts`. Change blur hiding back to `if (!pinned) hideSidebar()`; leave manual pin behavior unchanged.

- [ ] **Step 6: Run backend tests**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: Rust tests PASS. If the repository-wide format check still reports pre-existing files,
verify the changed Rust blocks separately and record the baseline debt.

- [ ] **Step 7: Commit the wiring**

```powershell
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json src-tauri/src/lib.rs src-tauri/src/commands.rs src/shared/types.ts src/sidebar/main.ts
git commit -m "feat: 작업 전광판 창과 이벤트 연결"
```

### Task 4: Ticker UI and Tauri event integration

**Files:**
- Create: `src/ticker/index.html`
- Create: `src/ticker/ticker.css`
- Create: `src/ticker/main.ts`
- Modify: `vite.config.ts`
- Modify: `src/settings/index.html`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes Task 1 APIs, `fetchSidebarData`, `getSettings`, `openEditModal`, `applyTheme`, `resolveDatePreset`, `shiftIsoDate`, and shared `ItemChange`.
- Listens for `open-ticker`, `close-ticker`, `idle-ended`, `refresh-sidebar`, `item-updated`, and `item-deleted` on `getCurrentWindow()`.
- Calls `openEditModal(project_id, item_id, WorkItem)` on task activation.

- [ ] **Step 1: Create semantic ticker markup**

Use buttons for previous, task body, next, retry, and close. Provide `aria-label` values, a `role="status"` failure/empty region, project/meta/count elements, and a bottom progress element. Import `../shared/app.css`, then `./ticker.css`, then `./main.ts` as a module.
Add `ticker: resolve(__dirname, "src/ticker/index.html")` to the Vite multi-page input now that the HTML exists.

- [ ] **Step 2: Implement visual states**

In `ticker.css`, create a single 540×64 translucent card with one-line title ellipsis, project badge, metadata colors, `:focus-visible` outlines, paused progress animation, and:

```css
@media (prefers-reduced-motion: reduce) {
  .ticker-task, .ticker-progress { animation: none !important; transition: none !important; }
}
```

Keep empty/error messages inside the same 64-pixel window. Do not add controls that edit state, assignee, priority, or dates.

- [ ] **Step 3: Implement fetch and render lifecycle**

Register all listeners before doing any asynchronous work. Do not fetch on module startup. On `open-ticker`, load settings/theme, fetch the same `today - 1` through `today + 1` completed range as sidebar, build candidates, preserve the current ID if this is a refresh, render, and start the controller only when more than one item exists. Guard concurrent refresh with `refreshInFlight` plus `refreshQueued`.

- [ ] **Step 4: Implement interactions**

Previous/next buttons update the index, render, and call `resetAfterManualNavigation`. Task activation calls `openEditModal` with the snapshot. Pointer enter/leave and focusin/focusout update independent controller pause flags. Close stops the controller and hides the current window. `close-ticker` and `idle-ended` both stop, reset local transient state, and hide.

- [ ] **Step 5: Implement incremental event handling**

On `item-updated`, patch matching assigned work, normalize empty date strings to null, rebuild candidates, and reconcile by current task ID. On `item-deleted`, remove and reconcile. On `refresh-sidebar`, fetch only when the ticker is visible; otherwise wait for the next `open-ticker`. Show `오프라인 · HH:MM` when `is_cached` is true. Render the exact failure `작업을 불러오지 못했습니다` with retry, and the exact empty copy `남은 작업이 없습니다`.

- [ ] **Step 6: Run all frontend verification**

Before verification, update the existing settings labels without changing their DOM IDs:

```html
<h2>작업 전광판 자동 표시</h2>
<label class="check-row"><input id="idleOpenEnabled" type="checkbox" />유휴 시 작업 전광판 표시</label>
<label>전광판 표시까지의 유휴 시간(분)<input id="idleOpenMinutes" type="number" min="1" /></label>
```

Under `CHANGELOG.md` → `## [Unreleased]` → `### 변경`, add:

```markdown
- 유휴 시간이 지나면 전체 사이드바 대신 프로젝트와 할 일을 한 건씩 보여주는 작업 전광판이 표시됩니다.
```

Run:

```powershell
pnpm test
pnpm build
pnpm exec tsc --noEmit
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the UI**

```powershell
git add src/ticker/index.html src/ticker/ticker.css src/ticker/main.ts vite.config.ts src/settings/index.html CHANGELOG.md
git commit -m "feat: 작업 전광판 캐러셀 UI 추가"
```

### Task 5: End-to-end verification

**Files:**
- Test: all TypeScript and Rust test suites

**Interfaces:**
- Verifies the complete feature against the approved design without adding new scope.

- [ ] **Step 1: Run automated verification**

Run:

```powershell
pnpm test
pnpm build
pnpm exec tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 2: Run the Windows manual matrix**

Verify on 100%, 125%, and 150% display scaling, and on a secondary monitor with a negative X origin:

- ticker appears 16 logical pixels from the selected monitor work area's right/bottom edges;
- taskbar on bottom, left, or top is not overlapped;
- initial show does not change the foreground application;
- ticker accepts click and keyboard focus after showing;
- rotation occurs at seven seconds, pauses on hover/focus, and resumes with a fresh interval;
- previous/next wrap, title truncates, reduced-motion removes transition;
- task click opens the existing editor; F2 hides ticker then toggles sidebar;
- close and idle-ended hide ticker; it does not reopen in the same idle session;
- offline cache, empty state, retryable error, item update/delete, and full refresh behave as specified.

- [ ] **Step 3: Request independent final review**

Dispatch a fresh verifier/code-reviewer that did not author the changes. Require it to inspect the full diff against `docs/superpowers/specs/2026-08-11-task-ticker-carousel-design.md`, rerun relevant automated checks, and report findings by severity. Fix every blocking/high finding and rerun the verification matrix before claiming completion.
