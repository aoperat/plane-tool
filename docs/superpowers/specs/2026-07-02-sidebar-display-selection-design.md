# Sidebar Display Selection — Design

## Problem

With two monitors connected, opening the sidebar makes it slide from the left
edge of monitor 2 to the right edge of monitor 1 instead of staying within a
single display.

### Root cause

`computeSidebarGeometry` (`src/sidebar/logic.ts:81-89`) computes `visibleX`/
`hiddenX` relative to the monitor's own width only — it never adds the
monitor's absolute virtual-desktop offset (`monitor.position.x`). `slideIn`/
`slideOut` (`src/sidebar/main.ts:401-431`) call `win.setPosition` with
`PhysicalPosition`, which is in absolute virtual-desktop coordinates.

Example: monitor 1 spans x `[0, 1920)`, monitor 2 spans x `[1920, 3840)`. If
the sidebar window happens to sit on monitor 2 when `currentMonitor()` is
queried, geometry is computed as if that monitor started at x=0:
`hiddenX = 1920` (exactly the boundary between the two monitors — reads as
"left edge of monitor 2") and `visibleX = 1600` (inside monitor 1's bounds —
reads as "right side of monitor 1"). This matches the reported symptom
exactly.

A second, related gap: there is no way to pin the sidebar to a specific
display. `currentMonitor()` returns whichever monitor the window's last
position happens to fall on, which is incidental, not configured.

## Goals

- Sidebar always renders fully within one physical display.
- Which display is configurable in Settings.
- Default display is 1 (the leftmost display when monitors are sorted
  left-to-right by position).
- If the configured display is no longer connected, fall back to display 1
  instead of erroring.

## Non-goals

- Remembering separate positions per display, multi-display spanning, or any
  UI for arranging/naming displays beyond a simple numbered list.
- Changing the slide animation timing/easing.

## Design

### 1. Fix the coordinate bug (`src/sidebar/logic.ts`)

Add optional absolute-offset parameters to `computeSidebarGeometry`, defaulting
to `0` so existing tests (which assume a monitor at the origin) keep passing:

```ts
export interface SidebarGeometry {
  width: number;
  height: number;
  visibleX: number;
  hiddenX: number;
  y: number;
}

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

`slideIn`/`slideOut` pass `monitor.position.x`/`monitor.position.y` as the new
args, and use `geo.y` instead of the hardcoded `0` when positioning.

### 2. Deterministic display numbering (`src/sidebar/logic.ts`)

New pure helpers, unit-testable independent of Tauri:

```ts
export function sortMonitorsByPosition<T extends { position: { x: number; y: number } }>(
  monitors: T[],
): T[] {
  return [...monitors].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
}

/** 1-based displayIndex. Falls back to the first monitor if out of range or unset. */
export function pickMonitor<T>(sortedMonitors: T[], displayIndex: number): T | undefined {
  return sortedMonitors[displayIndex - 1] ?? sortedMonitors[0];
}
```

Sorting left-to-right by `position.x` (ties broken by `position.y`) makes
"Display 1" always the leftmost monitor, consistently, regardless of OS
enumeration order. This is what both the sidebar and the Settings dropdown
use, so the numbers always match.

### 3. Settings schema

`src-tauri/src/config.rs`:

```rust
#[serde(default = "default_sidebar_display_index")]
pub sidebar_display_index: u32,
```

`fn default_sidebar_display_index() -> u32 { 1 }`, added to `Default for Settings`.

`src-tauri/src/commands.rs`:
- `get_settings`: include `sidebar_display_index` in `SettingsDto`.
- `save_settings`: add `sidebar_display_index: Option<u32>` param; when
  present and `>= 1`, set `s.sidebar_display_index = v`.

`src/shared/types.ts`: add `sidebar_display_index: number;` to `SettingsDto`.

`src/shared/ipc.ts`: thread the new field through `saveSettings(...)`.

### 4. Sidebar uses the configured display

`src/sidebar/main.ts` replaces the two `currentMonitor()` call sites with a
helper:

```ts
async function getTargetMonitor() {
  const [s, monitors] = await Promise.all([getSettings(), availableMonitors()]);
  if (monitors.length === 0) return null;
  return pickMonitor(sortMonitorsByPosition(monitors), s.sidebar_display_index) ?? null;
}
```

`slideIn`/`slideOut` call this instead of `currentMonitor()`; the `!monitor`
fallback branches (just `show()`/`hide()` without repositioning) stay as-is
for the no-monitor-detected edge case.

Settings are re-read on every slide (same cost as the existing `getSettings()`
call in `refresh()` — a local IPC round-trip), so a display change in Settings
takes effect on the next toggle without an app restart.

### 5. Settings UI

`src/settings/index.html`: new section between "단축키" and "화면":

```html
<h2>사이드바</h2>
<label>표시할 디스플레이<select id="sidebarDisplay"></select></label>
```

`src/settings/main.ts`:
- On `load()`, call `availableMonitors()`, sort with the same
  `sortMonitorsByPosition`, and populate the `<select>` with one `<option>`
  per monitor: value = 1-based index, label = `` 디스플레이 ${n} (${width}×${height}) ``
  (logical size, i.e. `size.width / scaleFactor`). Select the option matching
  `s.sidebar_display_index` (falls back to the first option if the stored
  index no longer exists).
- On save, pass the selected option's numeric value as
  `sidebarDisplayIndex` to `saveSettings(...)`.

## Testing

- `src/sidebar/logic.test.ts`: extend `computeSidebarGeometry` cases with a
  non-zero `originX`/`originY` to confirm absolute positioning. Add cases for
  `sortMonitorsByPosition` (unordered input → left-to-right output, tie on x
  broken by y) and `pickMonitor` (in-range index, out-of-range index falls
  back to first, empty array returns `undefined`).
- `src-tauri/src/config.rs` tests: extend the round-trip and default-value
  tests to cover `sidebar_display_index` (default `1`, round-trips through
  serde).
- Manual verification: with two monitors attached, set display to 2 in
  Settings, confirm the sidebar slides fully within monitor 2's bounds; set
  back to 1, confirm it's fully within monitor 1; unplug the second monitor
  while display 2 is configured, confirm it falls back to monitor 1 without
  error.
