pub mod commands;
pub mod config;
pub mod idle;
pub mod monitors;
pub mod plane_api;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, Shortcut, ShortcutState};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// The app lives in the tray and is rarely restarted, so a launch-time-only
/// check would leave long-running instances on stale versions for days.
const UPDATE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// How much of the release notes the update dialog shows before truncating —
/// a native message box has no scrollbar, so an unbounded changelog could
/// push the buttons off screen.
const UPDATE_NOTES_MAX_CHARS: usize = 600;

/// 유휴 시간 폴링 간격. GetLastInputInfo는 시스템이 이미 기록해 둔
/// 타임스탬프를 읽을 뿐이라 이 주기로 돌려도 부담이 없다.
const IDLE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Last version the user was offered in an update dialog, shared between the
/// hourly loop and the sidebar's manual check so neither path re-nags a
/// version the user already declined. A newer release prompts again.
static LAST_OFFERED_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Checks the release feed on launch and then every `UPDATE_CHECK_INTERVAL`,
/// in the background. If a newer version exists, asks the user first (showing
/// the release notes); on confirmation downloads, installs, and relaunches.
/// Every failure path only logs — an unreachable update server must never
/// get in the way of actually using the app.
fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            check_for_updates_once(&app).await;
            tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
        }
    });
}

async fn check_for_updates_once(app: &tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("updater init failed: {e}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(e) => {
            eprintln!("update check failed: {e}");
            return;
        }
    };
    {
        let mut last = LAST_OFFERED_VERSION.lock().unwrap();
        if last.as_deref() == Some(update.version.as_str()) {
            return;
        }
        *last = Some(update.version.clone());
    }
    prompt_install(app, update);
}

/// Sidebar's manual "업데이트 확인" button. Unlike the hourly loop this always
/// prompts — even for a version the loop already offered — because the user
/// explicitly asked. Returns a status message for the sidebar to display when
/// there is nothing to install (the update case shows its own dialog).
#[tauri::command]
async fn check_updates_manual(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            *LAST_OFFERED_VERSION.lock().unwrap() = Some(update.version.clone());
            prompt_install(&app, update);
            Ok(None)
        }
        Ok(None) => Ok(Some(format!(
            "현재 최신 버전입니다 (v{})",
            app.package_info().version
        ))),
        Err(e) => Err(e.to_string()),
    }
}

/// Shows the confirm dialog for `update`; on confirmation downloads, installs,
/// and relaunches.
fn prompt_install(app: &tauri::AppHandle, update: tauri_plugin_updater::Update) {
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    let handle = app.clone();
    app.dialog()
        .message(update_message(&version, &notes))
        .title("Plane Quick Dock 업데이트")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "업데이트".to_string(),
            "나중에".to_string(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => handle.restart(),
                    Err(e) => eprintln!("update install failed: {e}"),
                }
            });
        });
}

/// Builds the update dialog text: version line, the release notes from the
/// update feed (truncated to `UPDATE_NOTES_MAX_CHARS`), and the confirm prompt.
/// Empty notes (older releases published before notes were wired up) collapse
/// to the version-only message.
fn update_message(version: &str, notes: &str) -> String {
    let mut msg = format!("새 버전 {version}이(가) 있습니다.");
    let notes = notes.trim();
    if !notes.is_empty() {
        msg.push_str("\n\n변경 사항:\n");
        msg.extend(notes.chars().take(UPDATE_NOTES_MAX_CHARS));
        if notes.chars().count() > UPDATE_NOTES_MAX_CHARS {
            msg.push_str("\n…");
        }
    }
    msg.push_str("\n\n지금 업데이트할까요? 설치 후 자동으로 재시작됩니다.");
    msg
}

/// PC 유휴 시간을 폴링하다가 설정 기준(idle_open_minutes)을 넘으면
/// 사이드바에 열기 전용 이벤트를 보낸다. 설정은 매 tick 다시 읽어
/// 재시작 없이 반영된다. 유휴 세션당 1회 발화는 IdleOpenGate가 보장.
fn spawn_idle_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut gate = idle::IdleOpenGate::new();
        loop {
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
            let Some(idle_ms) = idle::system_idle_ms() else { continue };
            let s = config::load_settings(&app);
            let threshold_ms = u64::from(s.idle_open_minutes) * 60_000;
            if gate.tick(s.idle_open_enabled, idle_ms, threshold_ms) {
                let _ = app.emit_to("sidebar", "open-sidebar", ());
            }
        }
    });
}

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub(crate) fn show_quickadd(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
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

fn toggle_quickadd(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
    }
    show_quickadd(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_i, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => show_window(app, "settings"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let s = config::load_settings(app.handle());
            let qa = s.quickadd_shortcut.clone();
            let sb = s.sidebar_shortcut.clone();
            let qa_sc: Option<Shortcut> = qa.parse().ok();
            let sb_sc: Option<Shortcut> = sb.parse().ok();
            app.handle().plugin(
                ShortcutBuilder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed { return; }
                        if qa_sc.as_ref() == Some(shortcut) {
                            toggle_quickadd(app);
                        } else if sb_sc.as_ref() == Some(shortcut) {
                            // The sidebar animates its own show/hide (slide in/out
                            // from the screen edge), so just ask it to toggle
                            // itself instead of driving show()/hide() here.
                            let _ = app.emit_to("sidebar", "toggle-sidebar", ());
                        }
                    })
                    .build(),
            )?;
            if let Err(e) = app.global_shortcut().register(s.quickadd_shortcut.as_str()) {
                eprintln!("quickadd shortcut '{}' failed: {e}", s.quickadd_shortcut);
            }
            if let Err(e) = app.global_shortcut().register(s.sidebar_shortcut.as_str()) {
                eprintln!("sidebar shortcut '{}' failed: {e}", s.sidebar_shortcut);
            }

            let cfg = config::load_settings(app.handle());
            if cfg.base_url.is_empty() {
                show_window(app.handle(), "settings");
            }

            check_for_updates(app.handle().clone());
            spawn_idle_watcher(app.handle().clone());
            // Note: no focus-loss auto-hide here — QuickAdd stays open until
            // dismissed with Esc or its shortcut. The Sidebar auto-hides on
            // focus loss instead (see sidebar/main.ts's tauri://blur listener),
            // unless the user has pinned it via the pin button.

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
            commands::update_work_item_priority,
            commands::update_work_item_state,
            commands::delete_work_item,
            commands::get_work_item,
            commands::update_work_item_fields,
            commands::open_edit_modal,
            commands::open_settings,
            commands::show_quickadd_for_project,
            commands::fetch_release_notes,
            check_updates_manual
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;

    #[test]
    fn update_message_includes_release_notes() {
        let msg = update_message("0.2.0", "- fix: keep quickadd draft\n- feat: hourly update check");
        assert!(msg.contains("새 버전 0.2.0"));
        assert!(msg.contains("변경 사항:"));
        assert!(msg.contains("- fix: keep quickadd draft"));
        assert!(msg.contains("지금 업데이트할까요?"));
    }

    #[test]
    fn update_message_without_notes_collapses_to_version_only() {
        let msg = update_message("0.2.0", "  \n ");
        assert!(!msg.contains("변경 사항"));
        assert!(msg.contains("새 버전 0.2.0"));
    }

    #[test]
    fn update_message_truncates_overlong_notes() {
        let notes = "가".repeat(UPDATE_NOTES_MAX_CHARS + 50);
        let msg = update_message("0.2.0", &notes);
        assert!(msg.contains('…'));
        // The dialog body must stay bounded regardless of changelog length.
        assert!(msg.chars().count() < UPDATE_NOTES_MAX_CHARS + 120);
    }

    #[test]
    fn default_shortcuts_parse_as_valid_accelerators() {
        // The whole app hinges on these registering; guard that the defaults
        // are always parseable by the global-shortcut plugin.
        let s = Settings::default();
        assert!(
            s.quickadd_shortcut.parse::<Shortcut>().is_ok(),
            "quickadd default '{}' is not a valid shortcut",
            s.quickadd_shortcut
        );
        assert!(
            s.sidebar_shortcut.parse::<Shortcut>().is_ok(),
            "sidebar default '{}' is not a valid shortcut",
            s.sidebar_shortcut
        );
    }
}
