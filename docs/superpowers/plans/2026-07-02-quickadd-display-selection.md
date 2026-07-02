# QuickAdd Display Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QuickAdd center on the same configurable display the sidebar uses, via one shared Settings dropdown, instead of always centering on the OS-default primary monitor.

**Architecture:** Rename the existing `sidebar_display_index` setting to a display-agnostic `display_index` (with a serde alias so existing users' saved value survives), add a small pure Rust module of monitor-placement helpers mirroring the existing TS ones, and reposition QuickAdd (via `set_position` before `show()`, so there's no visible jump) inside the global-shortcut handler using that shared setting. The Settings UI collapses to one "표시할 디스플레이" dropdown that drives both windows.

**Tech Stack:** TypeScript (Vite, vitest), Rust (Tauri 2, serde, `tauri_plugin_store`), pnpm.

## Global Constraints

- One shared `display_index` setting (1-based) drives both the sidebar and QuickAdd — no separate per-window setting.
- Default `display_index` is `1`.
- Monitor numbering is left-to-right by x position, ties broken by y position ascending — must match exactly between the existing TS helpers (`sortMonitorsByPosition`/`pickMonitor` in `src/shared/monitors.ts`) and the new Rust equivalents (`src-tauri/src/monitors.rs`).
- Renaming `sidebar_display_index` → `display_index` must not reset existing users' saved value — handled via `#[serde(alias = "sidebar_display_index")]`.
- QuickAdd must have its position set *before* `show()` is called — no visible jump/flash between monitors.
- If the configured display index is out of range, or no monitors are detected, fall back to display 1 (or skip repositioning entirely if no monitors are detected) — never error.
- No per-display saved positions, no multi-display spanning, no per-window display settings — out of scope (see spec `docs/superpowers/specs/2026-07-02-quickadd-display-selection-design.md`).
- Package manager is `pnpm`; TS type-checking is `pnpm exec tsc --noEmit`; TS unit tests run via `pnpm exec vitest run <path>`; Rust tests run via `cd src-tauri && cargo test <filter>`; Rust build via `cd src-tauri && cargo build`.
- `src/sidebar/main.ts`, `src/settings/main.ts`, and the QuickAdd-centering code in `src-tauri/src/lib.rs` have no automated test harness for their Tauri-integration parts (no jsdom, and `#[tauri::command]`/shortcut-handler code needs a live `AppHandle`) — verify those with type-check/build plus an explicit manual run-through, consistent with prior plans in this repo.

---

### Task 1: Rename `sidebar_display_index` → `display_index` in the Rust settings store

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/commands.rs:6-16,127-167`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Settings.display_index: u32` (default `1` via `default_display_index()`, deserializes the legacy `sidebar_display_index` JSON key too), `SettingsDto.display_index: u32`, `save_settings(..., display_index: Option<u32>)`.

- [ ] **Step 1: Update the existing config tests to the new field name, and add a backward-compatibility test (write failing tests first)**

In `src-tauri/src/config.rs`, replace the two existing tests and add a new one in the `mod tests` block:

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
            display_index: 2,
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
        assert_eq!(s.display_index, 1);
    }
```

Add this new test in the same `mod tests` block (anywhere after the two above):

```rust
    #[test]
    fn settings_deserializes_legacy_sidebar_display_index_key() {
        // Settings saved before the sidebar_display_index -> display_index rename
        // must keep the user's chosen display instead of silently resetting to 1.
        let legacy_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null,
            "quickadd_shortcut": "F1",
            "sidebar_shortcut": "F2",
            "theme": "auto",
            "sidebar_display_index": 2
        }"#;
        let s: Settings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(s.display_index, 2);
    }
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `cd src-tauri && cargo test settings_`
Expected: FAIL to compile — `Settings` has no field `display_index` yet (the struct still uses `sidebar_display_index`).

- [ ] **Step 3: Rename the field in `config.rs` and `commands.rs`**

In `src-tauri/src/config.rs`, replace the `Settings` struct, its default functions, and `impl Default for Settings` with:

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
    /// 1-based index into monitors sorted left-to-right by position. Shared by the
    /// sidebar and QuickAdd — both windows always show on the same display. The
    /// `alias` lets settings saved before this field was renamed keep their value.
    #[serde(alias = "sidebar_display_index", default = "default_display_index")]
    pub display_index: u32,
}

fn default_quickadd_shortcut() -> String { "F1".into() }
fn default_sidebar_shortcut() -> String { "F2".into() }
fn default_theme() -> String { "auto".into() }
fn default_display_index() -> u32 { 1 }

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            workspace: String::new(),
            last_project_id: None,
            quickadd_shortcut: default_quickadd_shortcut(),
            sidebar_shortcut: default_sidebar_shortcut(),
            theme: default_theme(),
            display_index: default_display_index(),
        }
    }
}
```

In `src-tauri/src/commands.rs`, replace `SettingsDto` (lines 6-16):

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
    pub display_index: u32,
}
```

Replace `get_settings` (lines 127-140):

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
        display_index: s.display_index,
    }
}
```

Replace `save_settings` (lines 142-167):

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
    display_index: Option<u32>,
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace.trim().trim_matches('/').to_string();
    if let Some(v) = quickadd_shortcut { if !v.is_empty() { s.quickadd_shortcut = v; } }
    if let Some(v) = sidebar_shortcut { if !v.is_empty() { s.sidebar_shortcut = v; } }
    if let Some(v) = theme { if v == "auto" || v == "light" || v == "dark" { s.theme = v; } }
    if let Some(v) = display_index { if v >= 1 { s.display_index = v; } }
    config::save_settings(&app, &s)?;
    if let Some(t) = token {
        if !t.is_empty() {
            config::set_token(&t)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `cd src-tauri && cargo test settings_`
Expected: PASS (3 tests: `settings_round_trip_preserves_fields`, `settings_default_has_empty_strings_and_no_project`, `settings_deserializes_legacy_sidebar_display_index_key`).

- [ ] **Step 5: Build the whole crate to confirm no other Rust file references the old field name**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 6: Run the full Rust test suite to confirm nothing else broke**

Run: `cd src-tauri && cargo test`
Expected: PASS (all existing tests, unaffected by this change).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs
git commit -m "refactor(settings): rename sidebar_display_index to display_index"
```

---

### Task 2: Rename the display setting across the frontend and unify the Settings UI

**Files:**
- Modify: `src/shared/types.ts:16-21`
- Modify: `src/shared/ipc.ts:5-22`
- Modify: `src/sidebar/main.ts:411`
- Modify: `src/settings/index.html:19-20`
- Modify: `src/settings/main.ts` (targeted edits only — see Step 5 note)

**Interfaces:**
- Consumes: `SettingsDto.display_index: u32` and `save_settings(..., display_index: Option<u32>)` from Task 1.
- Produces: `SettingsDto.display_index: number` (TS); `saveSettings(base_url, workspace, token?, quickaddShortcut?, sidebarShortcut?, theme?, displayIndex?)`; a single "표시할 디스플레이" dropdown in Settings that persists the shared 1-based display index.

**Note (drift since this plan was written):** two concurrent commits (`561aaf9`, `be5ad3e`) added a "토큰 발급받기" token-page link to `settings/index.html`/`settings/main.ts` — a `tokenLink` element, its `onclick` handler, and `status`-based error messages. `settings/index.html`'s "사이드바" section shifted from lines 17-18 to 19-20 (content unchanged). `settings/main.ts` steps below are targeted edits, not a full-file replace, specifically to leave the token-link feature intact.

- [ ] **Step 1: Rename the field in `SettingsDto`**

In `src/shared/types.ts`, replace lines 16-21 with:

```ts
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
  theme: string; display_index: number;
}
```

- [ ] **Step 2: Rename the parameter threaded through `saveSettings`**

In `src/shared/ipc.ts`, replace lines 5-22 with:

```ts
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
  displayIndex?: number,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
    displayIndex,
  });
```

- [ ] **Step 3: Update the sidebar's one reference to the renamed field**

In `src/sidebar/main.ts`, replace line 411:

```ts
  return pickMonitor(sortMonitorsByPosition(monitors), s.sidebar_display_index) ?? null;
```

with:

```ts
  return pickMonitor(sortMonitorsByPosition(monitors), s.display_index) ?? null;
```

- [ ] **Step 4: Rename and generalize the Settings UI section**

In `src/settings/index.html`, replace lines 19-20:

```html
      <h2>사이드바</h2>
      <label>표시할 디스플레이<select id="sidebarDisplay"></select></label>
```

with:

```html
      <h2>디스플레이</h2>
      <label>표시할 디스플레이<select id="displaySelect"></select></label>
```

- [ ] **Step 5: Update `settings/main.ts` to populate and save the renamed/shared dropdown**

`settings/main.ts` currently also contains a `tokenLink` click handler (added by an unrelated, already-shipped commit) — do NOT remove or restructure it. Make only these targeted replacements, leaving every other line (imports, `tokenLink`, its `onclick`, `status` messages) exactly as they are:

Replace:
```ts
const sidebarDisplay = document.getElementById("sidebarDisplay") as HTMLSelectElement;
```
with:
```ts
const displaySelect = document.getElementById("displaySelect") as HTMLSelectElement;
```

Inside `load()`, replace:
```ts
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
```
with:
```ts
  const monitors = sortMonitorsByPosition(await availableMonitors());
  displaySelect.innerHTML = "";
  monitors.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `디스플레이 ${i + 1} (${Math.round(m.size.width / m.scaleFactor)}×${Math.round(m.size.height / m.scaleFactor)})`;
    displaySelect.appendChild(opt);
  });
  const wanted = String(s.display_index);
  displaySelect.value = [...displaySelect.options].some((o) => o.value === wanted) ? wanted : "1";
```

In the `save` button's `onclick`, replace the last argument to `saveSettings`:
```ts
      Number(sidebarDisplay.value),
```
with:
```ts
      Number(displaySelect.value),
```

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual run-through**

None of the changed files have an automated test harness (no jsdom for `sidebar/main.ts`/`settings/main.ts`). Run the app (`pnpm tauri dev`), open Settings, confirm the section is now labeled "디스플레이" with one "표시할 디스플레이" dropdown, populated with one option per connected monitor. Change the selection, save, reopen Settings, and confirm the choice persisted. Toggle the sidebar and confirm it still slides in on a single-monitor machine exactly as before.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/sidebar/main.ts src/settings/index.html src/settings/main.ts
git commit -m "refactor(settings): unify sidebar/quickadd display setting into one dropdown"
```

---

### Task 3: Pure Rust monitor-placement helpers

**Files:**
- Create: `src-tauri/src/monitors.rs`
- Modify: `src-tauri/src/lib.rs:1-3`

**Interfaces:**
- Produces: `pub fn sorted_indices_by_position(positions: &[(i32, i32)]) -> Vec<usize>`, `pub fn pick_index(sorted_indices: &[usize], display_index: u32) -> Option<usize>`, `pub fn centered_position(window_size: (i32, i32), monitor_position: (i32, i32), monitor_size: (i32, i32)) -> (i32, i32)`.
- These are consumed by Task 4 (`src-tauri/src/lib.rs`'s `toggle_quickadd`).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/monitors.rs` with just the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_indices_orders_left_to_right() {
        let positions = [(1920, 0), (0, 0)];
        assert_eq!(sorted_indices_by_position(&positions), vec![1, 0]);
    }

    #[test]
    fn sorted_indices_breaks_ties_on_y() {
        let positions = [(0, 1080), (0, 0)];
        assert_eq!(sorted_indices_by_position(&positions), vec![1, 0]);
    }

    #[test]
    fn sorted_indices_empty_input() {
        let positions: [(i32, i32); 0] = [];
        assert_eq!(sorted_indices_by_position(&positions), Vec::<usize>::new());
    }

    #[test]
    fn pick_index_returns_the_1_based_entry() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 2), Some(1));
    }

    #[test]
    fn pick_index_falls_back_to_first_when_out_of_range() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 5), Some(0));
    }

    #[test]
    fn pick_index_falls_back_to_first_when_zero() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 0), Some(0));
    }

    #[test]
    fn pick_index_returns_none_when_empty() {
        let sorted: Vec<usize> = vec![];
        assert_eq!(pick_index(&sorted, 1), None);
    }

    #[test]
    fn centered_position_centers_with_equal_margins() {
        // 1920x1080 monitor at the origin, 540x175 window.
        let pos = centered_position((540, 175), (0, 0), (1920, 1080));
        assert_eq!(pos, (690, 452));
    }

    #[test]
    fn centered_position_honors_a_non_zero_monitor_origin() {
        // Same-size monitor, placed to the right of a 1920-wide primary monitor.
        let pos = centered_position((540, 175), (1920, 0), (1920, 1080));
        assert_eq!(pos, (2610, 452));
    }
}
```

Add `pub mod monitors;` to `src-tauri/src/lib.rs`, so the new file is compiled as part of the crate. Replace lines 1-3:

```rust
pub mod commands;
pub mod config;
```

with:

```rust
pub mod commands;
pub mod config;
pub mod monitors;
```

(line 3, `pub mod plane_api;`, stays as-is right after.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test monitors::`
Expected: FAIL to compile — `sorted_indices_by_position`, `pick_index`, and `centered_position` don't exist yet.

- [ ] **Step 3: Implement the helpers**

At the top of `src-tauri/src/monitors.rs` (above the `#[cfg(test)]` block), add:

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
    let wanted = (display_index as usize).checked_sub(1).and_then(|i| sorted_indices.get(i));
    wanted.or_else(|| sorted_indices.first()).copied()
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test monitors::`
Expected: PASS (9 tests).

- [ ] **Step 5: Build the whole crate to confirm the new module wiring compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/monitors.rs src-tauri/src/lib.rs
git commit -m "feat(monitors): add pure monitor sorting/selection/centering helpers"
```

---

### Task 4: QuickAdd centers on the configured display

**Files:**
- Modify: `src-tauri/src/lib.rs:14-30,62` (line numbers shifted by +1 vs. the original plan draft, because Task 3 inserted `pub mod monitors;` at line 3 — locate by content, not by these numbers alone)

**Interfaces:**
- Consumes: `config::load_settings(app).display_index` (Task 1), `monitors::sorted_indices_by_position`/`pick_index`/`centered_position` (Task 3).
- Produces: QuickAdd repositions itself onto the configured display before becoming visible, on every toggle.

- [ ] **Step 1: Add `toggle_quickadd` and switch the shortcut handler to use it**

In `src-tauri/src/lib.rs`, add a new function right after `toggle_window` (after line 29, before the `#[cfg_attr(mobile, tauri::mobile_entry_point)]` line):

```rust
fn toggle_quickadd(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        if let (Ok(mons), Ok(size)) = (win.available_monitors(), win.outer_size()) {
            let positions: Vec<(i32, i32)> = mons.iter().map(|m| (m.position().x, m.position().y)).collect();
            let sorted = monitors::sorted_indices_by_position(&positions);
            let display_index = config::load_settings(app).display_index;
            if let Some(i) = monitors::pick_index(&sorted, display_index) {
                let m = &mons[i];
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
}
```

Then, in the shortcut handler inside `run()`, replace the line (now at line 62 after Task 3's insertion):

```rust
                            toggle_window(app, "quickadd");
```

with:

```rust
                            toggle_quickadd(app);
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors. (There is no automated test for this function — it needs a live `AppHandle` with real monitors/windows, consistent with how `get_settings`/`save_settings` are verified elsewhere in this codebase: build + the unit tests on the pure helpers they call, plus manual verification below.)

- [ ] **Step 3: Run the full Rust test suite to confirm nothing else broke**

Run: `cd src-tauri && cargo test`
Expected: PASS (all existing tests plus the new ones from Tasks 1 and 3).

- [ ] **Step 4: Manual run-through**

Run the app (`pnpm tauri dev`). On a single-monitor machine, trigger the QuickAdd shortcut (default `F1`) and confirm it still appears centered on screen exactly as before, and that hiding/reshowing it (toggle again) still works.

If a second monitor is available: open Settings, set "표시할 디스플레이" to 2, save. Trigger the QuickAdd shortcut and confirm it appears centered on monitor 2 *with no flash on monitor 1 first*. Trigger the sidebar shortcut and confirm it also slides in on monitor 2 (this exercises the Task 2 change together with this task, since both windows now read the same setting). Switch the setting back to display 1, save, and confirm both QuickAdd and the sidebar land on monitor 1. Finally, if possible, unplug the second monitor while the setting is still "2" and confirm both QuickAdd and the sidebar fall back to monitor 1 without error.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(quickadd): center on the configured display before showing"
```
