# Sidebar Display Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar render fully within one physical display (configurable in Settings, default display 1) instead of sliding across both monitors.

**Architecture:** Fix a coordinate bug where `computeSidebarGeometry` ignores a monitor's absolute virtual-desktop offset; add a new `sortMonitorsByPosition`/`pickMonitor` pair of shared pure helpers so both the sidebar and the Settings UI number monitors identically (left-to-right); add a `sidebar_display_index` field to the existing `Settings` store (Rust) threaded through to a new Settings-UI dropdown.

**Tech Stack:** TypeScript (Vite, vitest), Rust (Tauri 2, serde, `tauri_plugin_store`), pnpm.

## Global Constraints

- Default `sidebar_display_index` is `1` (1-based).
- Monitors are numbered "Display N" by sorting `availableMonitors()` left-to-right on `position.x`, ties broken by `position.y` ascending. Both the sidebar and the Settings dropdown use the exact same sort so the numbers always match.
- If the configured display index is out of range (e.g. a monitor was unplugged) or unset, fall back to the first monitor in the sorted list — never error.
- No per-display saved positions, no multi-display spanning, no display renaming — out of scope (see spec `docs/superpowers/specs/2026-07-02-sidebar-display-selection-design.md`).
- Package manager is `pnpm`; TS type-checking is `pnpm exec tsc --noEmit` (there is no dedicated `typecheck` script). TS unit tests run via `pnpm exec vitest run <path>`. Rust tests run via `cd src-tauri && cargo test <name>`.
- `src/sidebar/main.ts` and `src/settings/main.ts` have no automated test harness (no jsdom in `vite.config.ts`) — verify those tasks with `pnpm exec tsc --noEmit` plus an explicit manual run-through, consistent with prior plans in this repo.

---

### Task 1: Fix `computeSidebarGeometry` to use absolute monitor offsets

**Files:**
- Modify: `src/sidebar/logic.ts:71-89`
- Test: `src/sidebar/logic.test.ts:63-75`

**Interfaces:**
- Produces: `SidebarGeometry` gains a `y: number` field. `computeSidebarGeometry(screenWidth, screenHeight, scaleFactor, panelWidthLogical, originX = 0, originY = 0): SidebarGeometry`.

- [ ] **Step 1: Update the existing tests and add new offset tests (write failing tests first)**

Replace the `describe("computeSidebarGeometry", ...)` block in `src/sidebar/logic.test.ts:63-75` with:

```ts
describe("computeSidebarGeometry", () => {
  it("anchors the panel to the right edge at 1x scale", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 1600, hiddenX: 1920, y: 0 });
  });

  it("scales the panel width by the monitor's scale factor", () => {
    const geo = computeSidebarGeometry(3840, 2160, 2, 320);
    expect(geo.width).toBe(640);
    expect(geo.visibleX).toBe(3200);
    expect(geo.hiddenX).toBe(3840);
  });

  it("adds the monitor's absolute x position as an offset", () => {
    // A second monitor placed to the right of a 1920-wide primary monitor.
    const geo = computeSidebarGeometry(1920, 1080, 1, 320, 1920, 0);
    expect(geo).toEqual({ width: 320, height: 1080, visibleX: 3520, hiddenX: 3840, y: 0 });
  });

  it("defaults the offset to 0 when omitted", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320);
    expect(geo.visibleX).toBe(1600);
    expect(geo.y).toBe(0);
  });

  it("carries the vertical offset through to y", () => {
    const geo = computeSidebarGeometry(1920, 1080, 1, 320, 0, 200);
    expect(geo.y).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/sidebar/logic.test.ts`
Expected: FAIL — the first test fails because `geo` has no `y` field yet (`toEqual` mismatch), and the offset tests fail because `computeSidebarGeometry` only accepts 4 params.

- [ ] **Step 3: Implement the offset-aware geometry**

Replace `src/sidebar/logic.ts:71-89` with:

```ts
export interface SidebarGeometry {
  width: number;
  height: number;
  /** x position (physical px) when fully slid in, anchored to the right edge. */
  visibleX: number;
  /** x position (physical px) when fully slid out, just past the right edge. */
  hiddenX: number;
  /** y position (physical px), anchored to the target monitor's own top edge. */
  y: number;
}

/** Computes the sidebar's slide-in/out geometry for a monitor of the given physical size and scale
 *  factor. `originX`/`originY` are the monitor's absolute position in the virtual desktop (0 for a
 *  monitor at the origin) — without them the panel lands wherever that monitor's local width happens
 *  to fall in absolute screen coordinates, which is wrong for any non-primary monitor. */
export function computeSidebarGeometry(
  screenWidth: number,
  screenHeight: number,
  scaleFactor: number,
  panelWidthLogical: number,
  originX = 0,
  originY = 0,
): SidebarGeometry {
  const width = Math.round(panelWidthLogical * scaleFactor);
  return {
    width,
    height: screenHeight,
    visibleX: originX + screenWidth - width,
    hiddenX: originX + screenWidth,
    y: originY,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/sidebar/logic.test.ts`
Expected: PASS (all tests in the file, including the unrelated ones already in that file).

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "fix(sidebar): anchor slide geometry to the monitor's absolute position"
```

---

### Task 2: Shared monitor ordering/selection helpers

**Files:**
- Create: `src/shared/monitors.ts`
- Test: `src/shared/monitors.test.ts`

**Interfaces:**
- Produces: `export interface MonitorLike { position: { x: number; y: number } }`, `sortMonitorsByPosition<T extends MonitorLike>(monitors: T[]): T[]`, `pickMonitor<T>(sortedMonitors: T[], displayIndex: number): T | undefined`.
- These are consumed by Task 5 (`src/sidebar/main.ts`) and Task 6 (`src/settings/main.ts`) to number monitors identically in both places.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/monitors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortMonitorsByPosition, pickMonitor } from "./monitors";

function mon(x: number, y: number) {
  return { position: { x, y } };
}

describe("sortMonitorsByPosition", () => {
  it("orders monitors left-to-right by x position", () => {
    const monitors = [mon(1920, 0), mon(0, 0)];
    expect(sortMonitorsByPosition(monitors)).toEqual([mon(0, 0), mon(1920, 0)]);
  });

  it("breaks ties on x using y position", () => {
    const monitors = [mon(0, 1080), mon(0, 0)];
    expect(sortMonitorsByPosition(monitors)).toEqual([mon(0, 0), mon(0, 1080)]);
  });

  it("does not mutate the input array", () => {
    const monitors = [mon(1920, 0), mon(0, 0)];
    const copy = [...monitors];
    sortMonitorsByPosition(monitors);
    expect(monitors).toEqual(copy);
  });
});

describe("pickMonitor", () => {
  const sorted = [mon(0, 0), mon(1920, 0), mon(3840, 0)];

  it("returns the monitor at the 1-based displayIndex", () => {
    expect(pickMonitor(sorted, 2)).toEqual(mon(1920, 0));
  });

  it("falls back to the first monitor when the index is out of range", () => {
    expect(pickMonitor(sorted, 5)).toEqual(mon(0, 0));
  });

  it("falls back to the first monitor when the index is 0 or negative", () => {
    expect(pickMonitor(sorted, 0)).toEqual(mon(0, 0));
  });

  it("returns undefined when there are no monitors", () => {
    expect(pickMonitor([], 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/shared/monitors.test.ts`
Expected: FAIL with "Failed to resolve import './monitors'" (file doesn't exist yet).

- [ ] **Step 3: Implement the helpers**

Create `src/shared/monitors.ts`:

```ts
export interface MonitorLike {
  position: { x: number; y: number };
}

/** Sorts monitors left-to-right by x position (ties broken by y), giving a stable, predictable
 *  numbering — "Display 1" is always the leftmost monitor — independent of OS enumeration order. */
export function sortMonitorsByPosition<T extends MonitorLike>(monitors: T[]): T[] {
  return [...monitors].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
}

/** Picks the monitor at the given 1-based `displayIndex` from an already-sorted list. Falls back to
 *  the first monitor when the index is out of range (including 0/negative), and to `undefined` when
 *  the list is empty. */
export function pickMonitor<T>(sortedMonitors: T[], displayIndex: number): T | undefined {
  return sortedMonitors[displayIndex - 1] ?? sortedMonitors[0];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/shared/monitors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/monitors.ts src/shared/monitors.test.ts
git commit -m "feat(shared): add monitor sorting/selection helpers"
```

---

### Task 3: Add `sidebar_display_index` to the Rust settings store

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/commands.rs:6-15,126-163`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings.sidebar_display_index: u32` (default `1`, via `default_sidebar_display_index()`), `SettingsDto.sidebar_display_index: u32`, `save_settings(..., sidebar_display_index: Option<u32>)`.

- [ ] **Step 1: Add the field to `Settings` with a default, update existing tests**

In `src-tauri/src/config.rs`, add the field to the struct (after `theme`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    #[serde(default = "default_quickadd_shortcut")]
    pub quickadd_shortcut: String,
    #[serde(default = "default_sidebar_shortcut")]
    pub sidebar_shortcut: String,
    /// "auto" | "light" | "dark"
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 1-based index into monitors sorted left-to-right by position.
    #[serde(default = "default_sidebar_display_index")]
    pub sidebar_display_index: u32,
}

fn default_quickadd_shortcut() -> String { "F1".into() }
fn default_sidebar_shortcut() -> String { "F2".into() }
fn default_theme() -> String { "auto".into() }
fn default_sidebar_display_index() -> u32 { 1 }

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            workspace: String::new(),
            last_project_id: None,
            quickadd_shortcut: default_quickadd_shortcut(),
            sidebar_shortcut: default_sidebar_shortcut(),
            theme: default_theme(),
            sidebar_display_index: default_sidebar_display_index(),
        }
    }
}
```

Update the two existing tests in the same file's `mod tests` block:

```rust
    #[test]
    fn settings_round_trip_preserves_fields() {
        let s = Settings {
            base_url: "https://plane.example.com".into(),
            workspace: "acme".into(),
            last_project_id: Some("proj-123".into()),
            quickadd_shortcut: "Alt+Space".into(),
            sidebar_shortcut: "Alt+S".into(),
            theme: "light".into(),
            sidebar_display_index: 2,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
```

```rust
    #[test]
    fn settings_default_has_empty_strings_and_no_project() {
        let s = Settings::default();
        assert_eq!(s.base_url, "");
        assert_eq!(s.workspace, "");
        assert_eq!(s.last_project_id, None);
        assert_eq!(s.quickadd_shortcut, "F1");
        assert_eq!(s.sidebar_shortcut, "F2");
        assert_eq!(s.theme, "auto");
        assert_eq!(s.sidebar_display_index, 1);
    }
```

- [ ] **Step 2: Run the config tests to verify they pass**

Run: `cd src-tauri && cargo test settings_` (a single substring filter — `cargo test` only accepts one — that matches both `settings_round_trip_preserves_fields` and `settings_default_has_empty_strings_and_no_project`)
Expected: PASS (2 tests)

- [ ] **Step 3: Thread the field through the `get_settings`/`save_settings` commands**

In `src-tauri/src/commands.rs`, update `SettingsDto` (lines 6-15):

```rust
#[derive(Serialize)]
pub struct SettingsDto {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    pub has_token: bool,
    pub quickadd_shortcut: String,
    pub sidebar_shortcut: String,
    pub theme: String,
    pub sidebar_display_index: u32,
}
```

Update `get_settings` (lines 126-138):

```rust
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> SettingsDto {
    let s = config::load_settings(&app);
    SettingsDto {
        base_url: s.base_url,
        workspace: s.workspace,
        last_project_id: s.last_project_id,
        has_token: config::get_token().is_some(),
        quickadd_shortcut: s.quickadd_shortcut,
        sidebar_shortcut: s.sidebar_shortcut,
        theme: s.theme,
        sidebar_display_index: s.sidebar_display_index,
    }
}
```

Update `save_settings` (lines 140-163):

```rust
#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    base_url: String,
    workspace: String,
    token: Option<String>,
    quickadd_shortcut: Option<String>,
    sidebar_shortcut: Option<String>,
    theme: Option<String>,
    sidebar_display_index: Option<u32>,
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace.trim().trim_matches('/').to_string();
    if let Some(v) = quickadd_shortcut { if !v.is_empty() { s.quickadd_shortcut = v; } }
    if let Some(v) = sidebar_shortcut { if !v.is_empty() { s.sidebar_shortcut = v; } }
    if let Some(v) = theme { if v == "auto" || v == "light" || v == "dark" { s.theme = v; } }
    if let Some(v) = sidebar_display_index { if v >= 1 { s.sidebar_display_index = v; } }
    config::save_settings(&app, &s)?;
    if let Some(t) = token {
        if !t.is_empty() {
            config::set_token(&t)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Build to verify the whole crate compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors (there is no dedicated unit test harness for `#[tauri::command]` functions in this codebase — they require an `AppHandle` — so a clean build plus the Task 3 Step 2 tests are the verification for this step).

- [ ] **Step 5: Run the full Rust test suite to confirm nothing else broke**

Run: `cd src-tauri && cargo test`
Expected: PASS (all existing tests, unaffected by this change)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs
git commit -m "feat(settings): add sidebar_display_index to the settings store"
```

---

### Task 4: Add `sidebar_display_index` to the frontend settings type and IPC

**Files:**
- Modify: `src/shared/types.ts:16-21`
- Modify: `src/shared/ipc.ts:5-20`

**Interfaces:**
- Consumes: `sidebar_display_index: u32` from Task 3's `SettingsDto`/`save_settings`.
- Produces: `SettingsDto.sidebar_display_index: number`; `saveSettings(base_url, workspace, token?, quickaddShortcut?, sidebarShortcut?, theme?, sidebarDisplayIndex?)`.

- [ ] **Step 1: Add the field to `SettingsDto`**

In `src/shared/types.ts`, replace lines 16-21 with:

```ts
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
  theme: string; sidebar_display_index: number;
}
```

- [ ] **Step 2: Thread the field through `saveSettings`**

In `src/shared/ipc.ts`, replace lines 5-20 with:

```ts
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
  sidebarDisplayIndex?: number,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
    sidebarDisplayIndex,
  });
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (`saveSettings`'s new parameter is optional and appended last, so the existing call site in `src/settings/main.ts` — not yet updated, that's Task 6 — still type-checks.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat(settings): expose sidebar_display_index through SettingsDto and IPC"
```

---

### Task 5: Sidebar slides on the configured display

**Files:**
- Modify: `src/sidebar/main.ts:1,401-431`

**Interfaces:**
- Consumes: `computeSidebarGeometry(...)` with `y` field and offset params (Task 1), `sortMonitorsByPosition`/`pickMonitor` from `../shared/monitors` (Task 2), `SettingsDto.sidebar_display_index` (Task 4), `availableMonitors` from `@tauri-apps/api/window`.
- Produces: sidebar now slides within the configured display's bounds instead of `currentMonitor()`'s bounds.

- [ ] **Step 1: Replace the `currentMonitor` import and add a `getTargetMonitor` helper**

In `src/sidebar/main.ts`, change line 1 from:

```ts
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
```

to:

```ts
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
```

Update the import from `./logic` (line 7) and add the new `../shared/monitors` import right after it:

```ts
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatLocalTime, groupItemsByProject, resolveStateId } from "./logic";
import { sortMonitorsByPosition, pickMonitor } from "../shared/monitors";
```

Add this helper right before `function slideIn()` (before line 401):

```ts
async function getTargetMonitor() {
  const [s, monitors] = await Promise.all([getSettings(), availableMonitors()]);
  if (monitors.length === 0) return null;
  return pickMonitor(sortMonitorsByPosition(monitors), s.sidebar_display_index) ?? null;
}
```

- [ ] **Step 2: Use the configured monitor and its offset in `slideIn`/`slideOut`**

Replace `slideIn` (lines 401-417):

```ts
function slideIn(): Promise<void> {
  return queueSlide(async () => {
    const monitor = await getTargetMonitor();
    if (!monitor) {
      await win.show();
      await win.setFocus();
      return;
    }
    const geo = computeSidebarGeometry(
      monitor.size.width,
      monitor.size.height,
      monitor.scaleFactor,
      PANEL_WIDTH,
      monitor.position.x,
      monitor.position.y,
    );
    await win.setSize(new PhysicalSize(geo.width, geo.height));
    await win.setPosition(new PhysicalPosition(geo.hiddenX, geo.y));
    await win.setAlwaysOnTop(true);
    await win.show();
    await win.setFocus();
    await animatePosition(geo.hiddenX, geo.visibleX, geo.y, SLIDE_MS);
  });
}
```

Replace `slideOut` (lines 419-431):

```ts
function slideOut(): Promise<void> {
  return queueSlide(async () => {
    if (!(await win.isVisible())) return;
    const monitor = await getTargetMonitor();
    if (!monitor) {
      await win.hide();
      return;
    }
    const geo = computeSidebarGeometry(
      monitor.size.width,
      monitor.size.height,
      monitor.scaleFactor,
      PANEL_WIDTH,
      monitor.position.x,
      monitor.position.y,
    );
    await animatePosition(geo.visibleX, geo.hiddenX, geo.y, SLIDE_MS);
    await win.hide();
  });
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual run-through**

`src/sidebar/main.ts` has no automated test harness (no jsdom). Run the app (`pnpm tauri dev`), open Settings, confirm the sidebar's slide shortcut still opens/closes it on a single-monitor machine exactly as before (visibleX/hiddenX with `originX=0` reduces to the old behavior). If a second monitor is available, set the display in Settings to display 2 first (Task 6 must land for this — otherwise skip and revisit after Task 6), and confirm the sidebar now stays fully within that monitor's bounds instead of straddling the boundary.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/main.ts
git commit -m "fix(sidebar): slide within the configured display's bounds"
```

---

### Task 6: Settings UI — choose the sidebar's display

**Files:**
- Modify: `src/settings/index.html:14-24`
- Modify: `src/settings/main.ts`

**Interfaces:**
- Consumes: `sortMonitorsByPosition` from `../shared/monitors` (Task 2), `SettingsDto.sidebar_display_index` and updated `saveSettings(...)` (Task 4), `availableMonitors` from `@tauri-apps/api/window`.
- Produces: a working "표시할 디스플레이" dropdown that persists the chosen 1-based display index.

- [ ] **Step 1: Add the dropdown markup**

In `src/settings/index.html`, insert a new section between the "단축키" (`</label>` closing line 16) and "화면" (`<h2>화면</h2>` line 17) sections — i.e. replace line 17 (`      <h2>화면</h2>`) with:

```html
      <h2>사이드바</h2>
      <label>표시할 디스플레이<select id="sidebarDisplay"></select></label>
      <h2>화면</h2>
```

- [ ] **Step 2: Populate and save the dropdown**

In `src/settings/main.ts`, add the import and element reference. Change line 1-2 to:

```ts
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, saveSettings } from "../shared/ipc";
import { sortMonitorsByPosition } from "../shared/monitors";
```

Add the element reference after line 11 (`const theme = ...`):

```ts
const sidebarDisplay = document.getElementById("sidebarDisplay") as HTMLSelectElement;
```

Replace `load()` (lines 14-23) with:

```ts
async function load() {
  const s = await getSettings();
  baseUrl.value = s.base_url;
  workspace.value = s.workspace;
  token.placeholder = s.has_token ? "(저장됨 — 변경 시에만 입력)" : "API 토큰 입력";
  qaShortcut.value = s.quickadd_shortcut;
  sbShortcut.value = s.sidebar_shortcut;
  theme.value = s.theme;
  applyTheme(s.theme);

  const monitors = sortMonitorsByPosition(await availableMonitors());
  sidebarDisplay.innerHTML = "";
  monitors.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `디스플레이 ${i + 1} (${Math.round(m.size.width / m.scaleFactor)}×${Math.round(m.size.height / m.scaleFactor)})`;
    sidebarDisplay.appendChild(opt);
  });
  const wanted = String(s.sidebar_display_index);
  sidebarDisplay.value = [...sidebarDisplay.options].some((o) => o.value === wanted) ? wanted : "1";
}
```

Replace the save handler (lines 27-44) — add `Number(sidebarDisplay.value)` as the 7th argument to `saveSettings`:

```ts
document.getElementById("save")!.onclick = async () => {
  status.textContent = "저장 중…";
  try {
    await saveSettings(
      baseUrl.value.trim(),
      workspace.value.trim(),
      token.value || undefined,
      qaShortcut.value.trim() || undefined,
      sbShortcut.value.trim() || undefined,
      theme.value,
      Number(sidebarDisplay.value),
    );
    token.value = "";
    status.textContent = "저장됨 ✓ (단축키 변경은 재시작 후 적용)";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual run-through**

`src/settings/main.ts` has no automated test harness (no jsdom). Run the app (`pnpm tauri dev`), open Settings, confirm the "사이드바" section shows a "표시할 디스플레이" dropdown populated with one option per connected monitor (labelled with logical resolution), defaulting to "디스플레이 1" on first run. Change the selection, save, reopen Settings, and confirm the choice persisted. Then re-run the Task 5 Step 4 manual check with a second monitor if available: set display 2, save, toggle the sidebar, and confirm it slides fully within monitor 2's bounds; switch back to display 1 and confirm the same for monitor 1.

- [ ] **Step 5: Commit**

```bash
git add src/settings/index.html src/settings/main.ts
git commit -m "feat(settings): add sidebar display selector"
```
