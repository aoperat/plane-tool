pub mod commands;
pub mod config;
pub mod monitors;
pub mod plane_api;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, Shortcut, ShortcutState};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
                            toggle_window(app, "quickadd");
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
            commands::open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;

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
