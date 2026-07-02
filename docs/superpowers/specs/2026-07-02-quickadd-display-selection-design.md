# QuickAdd Display Selection — Design

## Problem

The sidebar has a Settings option ("표시할 디스플레이") that pins it to a chosen
monitor. QuickAdd has no equivalent: `tauri.conf.json` sets `"center": true`
on the `quickadd` window, which only centers it once, on whatever monitor the
OS treats as primary, at window-creation time. On a multi-monitor setup there
is no way to make QuickAdd open on a different display.

## Goals

- Which display QuickAdd centers on is configurable in Settings, using the
  same 1-based, left-to-right numbering the sidebar already uses
  (`sortMonitorsByPosition`/`pickMonitor` in `src/shared/monitors.ts`).
- QuickAdd is re-centered on the configured display every time it is shown
  (not just once at startup), with no visible jump/flash — the window is
  positioned before it becomes visible.
- Default display is 1 (leftmost/primary), matching current behavior for
  users who don't touch the setting.
- If the configured display is no longer connected, fall back to display 1,
  same as the sidebar.

## Non-goals

- Any change to the sidebar's own display-selection behavior.
- Remembering QuickAdd's position independent of centering, or any animation
  (QuickAdd has none today; it just appears).

## Design

### 1. Settings schema

`src-tauri/src/config.rs` — new field, mirroring `sidebar_display_index`:

```rust
#[serde(default = "default_quickadd_display_index")]
pub quickadd_display_index: u32,
```

`fn default_quickadd_display_index() -> u32 { 1 }`, added to `Default for
Settings`.

`src-tauri/src/commands.rs`:
- `SettingsDto`: add `quickadd_display_index: u32`.
- `get_settings`: include it.
- `save_settings`: add `quickadd_display_index: Option<u32>` param; when
  present and `>= 1`, set `s.quickadd_display_index = v` (same validation as
  `sidebar_display_index`).

`src/shared/types.ts`: add `quickadd_display_index: number;` to
`SettingsDto`.

`src/shared/ipc.ts`: thread `quickaddDisplayIndex` through `saveSettings(...)`
the same way `sidebarDisplayIndex` is threaded today.

### 2. Pure monitor-placement helpers (new `src-tauri/src/monitors.rs`)

The sidebar's placement logic lives in TypeScript and is unit-tested against
plain objects, not real Tauri `Monitor`s. QuickAdd's placement decision is
made in Rust (see §3), so it needs the Rust equivalent, kept just as testable
by operating on plain coordinates rather than `tauri::Monitor` directly
(`tauri::Monitor` has no public constructor, so tests couldn't build one
anyway):

```rust
/// Returns the original indices of `positions`, ordered left-to-right by x
/// (ties broken by y) — mirrors `sortMonitorsByPosition` in
/// src/shared/monitors.ts.
pub fn sorted_indices_by_position(positions: &[(i32, i32)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..positions.len()).collect();
    idx.sort_by(|&a, &b| {
        positions[a].0.cmp(&positions[b].0).then(positions[a].1.cmp(&positions[b].1))
    });
    idx
}

/// 1-based `display_index` into `sorted_indices`. Falls back to the first
/// entry if out of range; `None` if `sorted_indices` is empty. Mirrors
/// `pickMonitor` in src/shared/monitors.ts.
pub fn pick_index(sorted_indices: &[usize], display_index: u32) -> Option<usize> {
    let i = (display_index as usize).checked_sub(1).and_then(|i| sorted_indices.get(i));
    i.or_else(|| sorted_indices.first()).copied()
}

/// Top-left position that centers a `window_size` window within a monitor
/// occupying `monitor_position` + `monitor_size` (all in physical pixels).
pub fn centered_position(
    window_size: (i32, i32),
    monitor_position: (i32, i32),
    monitor_size: (i32, i32),
) -> (i32, i32) {
    (
        monitor_position.0 + (monitor_size.0 - window_size.0) / 2,
        monitor_position.1 + (monitor_size.1 - window_size.1) / 2,
    )
}
```

All three are pure and unit-tested directly (no Tauri runtime needed).

### 3. Show QuickAdd centered on the configured display (`src-tauri/src/lib.rs`)

Today the global-shortcut handler calls `toggle_window(app, "quickadd")`,
which just calls `win.show()` / `win.set_focus()` — the window keeps
whatever position it last had (or its creation-time OS-centered position).

Replace that call with a new `toggle_quickadd(app)`:

```rust
fn toggle_quickadd(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("quickadd") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let (Ok(monitors), Ok(size)) = (win.available_monitors(), win.outer_size()) {
        let positions: Vec<(i32, i32)> = monitors.iter().map(|m| (m.position().x, m.position().y)).collect();
        let sorted = monitors::sorted_indices_by_position(&positions);
        let display_index = config::load_settings(app).quickadd_display_index;
        if let Some(i) = monitors::pick_index(&sorted, display_index) {
            let m = &monitors[i];
            let (x, y) = monitors::centered_position(
                (size.width as i32, size.height as i32),
                (m.position().x, m.position().y),
                (m.size().width as i32, m.size().height as i32),
            );
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}
```

Position is set *before* `show()`, so there is no visible jump. If
`available_monitors()`/`outer_size()` fail (theoretical — matches the
sidebar's existing "no monitor detected" fallback), QuickAdd just shows at
its last position, same as today.

`show_window`/`toggle_window` are untouched and keep serving `settings` and
the tray menu.

### 4. Settings UI

`src/settings/index.html` — new section next to "사이드바":

```html
<h2>빠른 추가</h2>
<label>표시할 디스플레이<select id="quickaddDisplay"></select></label>
```

`src/settings/main.ts`:
- On `load()`, populate `#quickaddDisplay` the same way `#sidebarDisplay` is
  populated (same `sortMonitorsByPosition(await availableMonitors())` list,
  same label format), selecting the option matching
  `s.quickadd_display_index` (falls back to `"1"` if stale).
- On save, pass `Number(quickaddDisplay.value)` as `quickaddDisplayIndex` to
  `saveSettings(...)`.

## Testing

- `src-tauri/src/monitors.rs`: unit tests for `sorted_indices_by_position`
  (unordered input → left-to-right indices, tie on x broken by y, empty
  input), `pick_index` (in-range, out-of-range falls back to first, empty
  input returns `None`), and `centered_position` (window smaller than
  monitor centers with equal margins; non-zero monitor origin is honored).
- `src-tauri/src/config.rs`: extend the existing round-trip and
  default-value tests to cover `quickadd_display_index` (default `1`,
  round-trips through serde).
- Manual verification: with two monitors attached, set QuickAdd's display to
  2 in Settings, trigger the QuickAdd shortcut, confirm it appears centered
  on monitor 2 with no flash on monitor 1 first; set back to 1, confirm it's
  centered on monitor 1; unplug the second monitor while display 2 is
  configured, confirm QuickAdd falls back to monitor 1 without error.
