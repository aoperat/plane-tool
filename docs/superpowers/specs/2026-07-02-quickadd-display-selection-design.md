# QuickAdd Display Selection — Design

## Problem

The sidebar has a Settings option ("표시할 디스플레이") that pins it to a chosen
monitor. QuickAdd has no equivalent: `tauri.conf.json` sets `"center": true`
on the `quickadd` window, which only centers it once, on whatever monitor the
OS treats as primary, at window-creation time. On a multi-monitor setup there
is no way to make QuickAdd open on a different display.

Both windows are part of the same quick-capture workflow and should stay on
the same physical display, so this isn't two independent preferences — it's
one "which display do my quick-access windows live on" setting that both
windows read.

## Goals

- One shared Settings option decides which display both the sidebar and
  QuickAdd use — no separate QuickAdd-only setting.
- QuickAdd is re-centered on the configured display every time it is shown
  (not just once at startup), with no visible jump/flash — the window is
  positioned before it becomes visible.
- Changing the display in Settings affects both windows on their next
  show/toggle, without an app restart.
- Default display is 1 (leftmost/primary), matching current behavior for
  users who don't touch the setting.
- If the configured display is no longer connected, fall back to display 1
  for both windows, same as the sidebar does today.
- Users who already configured a sidebar display keep that value after this
  change (no silent reset to the default).

## Non-goals

- Any UI or setting for choosing different displays per window.
- Any change to the sidebar's slide animation or QuickAdd's appearance
  behavior beyond which monitor it centers on.

## Design

### 1. Rename the settings field to be display-agnostic (`src-tauri/src/config.rs`)

```rust
#[serde(alias = "sidebar_display_index", default = "default_display_index")]
pub display_index: u32,
```

`fn default_display_index() -> u32 { 1 }`, added to `Default for Settings`.

The `alias` means a `settings.json` written before this change (with the old
`sidebar_display_index` key) still loads correctly into the renamed field —
existing users keep whatever display they'd already picked. The next save
persists it under the new `display_index` key; the old key is simply no
longer written.

### 2. `src-tauri/src/commands.rs`

- `SettingsDto`: `sidebar_display_index: u32` → `display_index: u32`.
- `get_settings`: return the renamed field.
- `save_settings`: param renamed `sidebar_display_index: Option<u32>` →
  `display_index: Option<u32>`, same `>= 1` validation as before.

### 3. Frontend plumbing

- `src/shared/types.ts`: `SettingsDto.sidebar_display_index` → `display_index`.
- `src/shared/ipc.ts`: `saveSettings`'s `sidebarDisplayIndex` param →
  `displayIndex`.
- `src/sidebar/main.ts`'s `getTargetMonitor()` reads `s.display_index`
  instead of `s.sidebar_display_index`; no other sidebar logic changes.

### 4. Pure monitor-placement helpers (new `src-tauri/src/monitors.rs`)

QuickAdd's placement decision is made in Rust (per earlier discussion: doing
it in Rust before `show()` avoids any flash), so it needs a Rust equivalent
of the sidebar's TS placement helpers. Kept testable by operating on plain
coordinates rather than `tauri::Monitor` (which has no public constructor,
so tests couldn't build one anyway):

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

### 5. Show QuickAdd centered on the configured display (`src-tauri/src/lib.rs`)

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
        let display_index = config::load_settings(app).display_index;
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

### 6. Settings UI — one shared dropdown

`src/settings/index.html` — the existing "사이드바" section is renamed and
generalized (still in the same place, between "단축키" and "화면"):

```html
<h2>디스플레이</h2>
<label>표시할 디스플레이<select id="displaySelect"></select></label>
```

`src/settings/main.ts`:
- The `sidebarDisplay` element/variable is renamed `displaySelect`; population
  logic (from `sortMonitorsByPosition(await availableMonitors())`, same label
  format) and selected-option logic (falls back to `"1"` if the stored index
  is stale) are otherwise unchanged.
- On save, `Number(displaySelect.value)` is passed once, as `displayIndex`,
  to `saveSettings(...)` — it drives both windows.

## Testing

- `src-tauri/src/monitors.rs`: unit tests for `sorted_indices_by_position`
  (unordered input → left-to-right indices, tie on x broken by y, empty
  input), `pick_index` (in-range, out-of-range falls back to first, empty
  input returns `None`), and `centered_position` (window smaller than
  monitor centers with equal margins; non-zero monitor origin is honored).
- `src-tauri/src/config.rs`: rename the existing round-trip/default tests'
  assertions to `display_index`; add a test that deserializing a JSON blob
  containing the old `sidebar_display_index` key (and no `display_index`
  key) populates `display_index` via the serde alias.
- Manual verification: with two monitors attached, set the display to 2 in
  Settings, confirm the sidebar slides fully within monitor 2 *and* the
  QuickAdd shortcut centers it on monitor 2 with no flash on monitor 1
  first; set back to 1, confirm both land on monitor 1; unplug the second
  monitor while display 2 is configured, confirm both fall back to monitor 1
  without error.
