pub mod assign_watch;
pub mod briefing;
pub mod commands;
pub mod config;
pub mod idle;
pub mod monitors;
pub mod openai;
pub mod plane_api;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, Shortcut, ShortcutState};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
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

/// 아침 브리핑 시각 판정 주기. 설정을 매 tick 다시 읽어 재시작 없이 반영된다.
const MORNING_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Last version the user was offered in an update dialog, shared between the
/// hourly loop and the sidebar's manual check so neither path re-nags a
/// version the user already declined. A newer release prompts again.
static LAST_OFFERED_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 현재 등록되어 있는 전역 단축키 쌍. 단축키 핸들러가 시작 시점 값을
/// 클로저에 캡처하는 대신 매 이벤트마다 이 상태를 읽기 때문에, 설정 저장
/// 시 재시작 없이 단축키를 교체할 수 있다 (`reapply_shortcuts`).
#[derive(Default, Clone)]
pub struct ShortcutPair {
    pub qa: Option<Shortcut>,
    pub sb: Option<Shortcut>,
}

#[derive(Default)]
pub struct ShortcutBindings(pub std::sync::Mutex<ShortcutPair>);

fn register_one(app: &tauri::AppHandle, accel: &str) -> Result<Shortcut, String> {
    let sc: Shortcut = accel
        .parse()
        .map_err(|_| format!("'{accel}'은(는) 올바른 단축키 형식이 아닙니다"))?;
    app.global_shortcut().register(sc).map_err(|e| e.to_string())?;
    Ok(sc)
}

/// 설정 저장 시 전역 단축키를 재시작 없이 교체한다. 둘 다 등록에 성공해야
/// 반영하고, 하나라도 실패하면 이전 등록 상태로 되돌린 뒤 Err를 돌려준다 —
/// 설정 파일에 적힌 단축키와 실제 등록 상태가 어긋나면 안 되기 때문이다.
pub fn reapply_shortcuts(app: &tauri::AppHandle, qa: &str, sb: &str) -> Result<(), String> {
    let qa_sc: Shortcut = qa
        .parse()
        .map_err(|_| format!("빠른 추가 단축키 '{qa}'은(는) 올바른 형식이 아닙니다"))?;
    let sb_sc: Shortcut = sb
        .parse()
        .map_err(|_| format!("사이드바 단축키 '{sb}'은(는) 올바른 형식이 아닙니다"))?;
    if qa_sc == sb_sc {
        return Err("빠른 추가와 사이드바 단축키가 같습니다".into());
    }
    let gs = app.global_shortcut();
    let bindings = app.state::<ShortcutBindings>();
    let mut pair = bindings.0.lock().unwrap();
    let old = pair.clone();
    // 두 키를 서로 맞바꾸는 경우도 지원해야 하므로 새로 등록하기 전에
    // 기존 둘을 모두 해제한다.
    if let Some(sc) = &old.qa {
        let _ = gs.unregister(*sc);
    }
    if let Some(sc) = &old.sb {
        let _ = gs.unregister(*sc);
    }
    let result = gs
        .register(qa_sc)
        .map_err(|e| format!("빠른 추가 단축키 '{qa}' 등록 실패: {e}"))
        .and_then(|_| {
            gs.register(sb_sc).map_err(|e| {
                let _ = gs.unregister(qa_sc);
                format!("사이드바 단축키 '{sb}' 등록 실패: {e}")
            })
        });
    match result {
        Ok(()) => {
            pair.qa = Some(qa_sc);
            pair.sb = Some(sb_sc);
            Ok(())
        }
        Err(e) => {
            if let Some(sc) = &old.qa {
                let _ = gs.register(*sc);
            }
            if let Some(sc) = &old.sb {
                let _ = gs.register(*sc);
            }
            Err(e)
        }
    }
}

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
            match gate.tick(s.idle_open_enabled, idle_ms, threshold_ms) {
                idle::IdleAction::OpenSidebar => {
                    let _ = app.emit_to("sidebar", "open-sidebar", ());
                }
                idle::IdleAction::IdleEnded => {
                    let _ = app.emit_to("sidebar", "idle-ended", ());
                }
                idle::IdleAction::None => {}
            }
        }
    });
}

/// 매분 로컬 시각을 확인해, 아침 브리핑이 켜져 있고 지정 시각이 지났으며
/// 오늘 아직 안 띄웠다면 브리핑 창을 표시한다. 첫 판정을 sleep 전에 두어
/// 지정 시각 이후에 앱을 켠 경우에도 시작 직후 한 번 뜬다.
fn spawn_morning_briefing_watcher(app: tauri::AppHandle) {
    use chrono::Timelike;
    tauri::async_runtime::spawn(async move {
        loop {
            let s = config::load_settings(&app);
            if s.morning_briefing_enabled {
                if let Some(cfg_min) = briefing::parse_hhmm(&s.morning_briefing_time) {
                    let now = chrono::Local::now();
                    let today = now.format("%Y-%m-%d").to_string();
                    let now_min = now.hour() * 60 + now.minute();
                    let last = config::get_morning_last(&app);
                    if briefing::should_fire_morning(now_min, cfg_min, &today, last.as_deref()) {
                        // 먼저 기록해 실패해도 반복 팝업으로 괴롭히지 않는다.
                        let _ = config::set_morning_last(&app, &today);
                        show_centered(&app, "briefing");
                        let _ = app.emit_to("briefing", "briefing-open", ());
                    }
                }
            }
            tokio::time::sleep(MORNING_POLL_INTERVAL).await;
        }
    });
}

/// 할당 감지 폴링 간격. Plane 레이트 리밋을 고려해 60초 고정 (스펙 승인값).
const ASSIGN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

fn spawn_assign_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ASSIGN_POLL_INTERVAL).await;
            let s = config::load_settings(&app);
            if !s.assign_notify_enabled {
                continue;
            }
            if let Err(e) = assign_tick(&app, &s).await {
                // 오프라인/미설정은 정상 상황 — 로그만 남기고 다음 tick.
                eprintln!("assign watch tick failed: {e}");
            }
        }
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn assign_tick(app: &tauri::AppHandle, s: &config::Settings) -> Result<(), String> {
    if s.base_url.is_empty() || s.workspace.is_empty() {
        return Ok(());
    }
    let Some(token) = config::get_token() else { return Ok(()) };
    let client = plane_api::PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token);
    let me = client.current_user().await?.id;

    // 나에게 할당된 미완료 작업 전체 (프로젝트별 N+1 — 사이드바와 같은 패턴)
    // 사이드바(fetch_sidebar_data)와 달리 여기서는 프로젝트 하나가 실패해도
    // skip-and-continue 하면 안 된다 — 이 루프의 결과가 diff baseline으로
    // 영속화(last_ids/pending)되기 때문에, 일부만 담긴 assigned_open으로
    // prune_pending을 돌리면 실패한 프로젝트의 항목이 seen-set에서 사라지고
    // 다음 성공 tick에서 전부 "새 할당"으로 재감지된다 (중복 토스트/ACK).
    // 그래서 실패하면 tick 전체를 중단하고 상태를 건드리지 않는다.
    let projects = client.list_projects().await?;
    let mut assigned_open: Vec<plane_api::WorkItem> = Vec::new();
    for p in &projects {
        let items = client.list_work_items(&p.id).await?;
        assigned_open.extend(items.into_iter().filter(|i| {
            i.assignee_ids.iter().any(|a| a == &me)
                && i.state_group != "completed"
                && i.state_group != "cancelled"
        }));
    }

    // assign-state.json은 이 tick과 acknowledge_assignment 커맨드 양쪽에서
    // read-modify-write 된다. 네트워크 조회(위)는 락 없이 끝냈으니, 이제부터
    // load_state→save_state 구간(중간의 activities/members 조회 포함) 전체를
    // 락 아래 유지해 확인 커맨드와의 경합을 막는다 — 홀드 시간이 조금 늘어도
    // 정확성이 우선이라 락 범위를 세분화하지 않는다.
    let lock = app.state::<assign_watch::StateLock>();
    let _guard = lock.0.lock().await;
    let mut state = assign_watch::load_state(app);
    let current_ids: std::collections::HashSet<String> =
        assigned_open.iter().map(|i| i.id.clone()).collect();

    // 새 할당 감지 → 할당자 이름 조회 → pending 추가 + 개별 토스트
    let new_items: Vec<plane_api::WorkItem> =
        assign_watch::detect_new_assignments(&assigned_open, &me, &state)
            .into_iter()
            .cloned()
            .collect();
    for item in &new_items {
        let assigner_id = match client.list_activities(&item.project_id, &item.id).await {
            Ok(acts) => plane_api::find_assigner(&acts, item.created_by.as_deref(), &me),
            Err(e) => {
                // 스모크 테스트가 stderr의 404를 보고 라이브 서버에서 activities
                // 엔드포인트가 /issues/ 인지 /work-items/ 인지 판단한다 — 조용히
                // 삼키면 그 절차가 무력화되므로 반드시 로그를 남긴다.
                eprintln!("list_activities failed for {}: {e}", item.id);
                plane_api::find_assigner(&[], item.created_by.as_deref(), &me)
            }
        };
        let assigner_name = match &assigner_id {
            Some(id) => client
                .list_members(&item.project_id)
                .await
                .ok()
                .and_then(|ms| ms.into_iter().find(|m| &m.id == id))
                .map(|m| m.display_name)
                .unwrap_or_else(|| "누군가".into()),
            None => "누군가".into(),
        };
        let _ = app
            .notification()
            .builder()
            .title("새 작업이 할당되었습니다")
            .body(assign_watch::toast_body(
                &assigner_name,
                &item.name,
                item.target_date.as_deref(),
                item.priority.as_str(),
            ))
            .show();
        state.pending.push(assign_watch::PendingAssignment {
            item_id: item.id.clone(),
            project_id: item.project_id.clone(),
            name: item.name.clone(),
            priority: item.priority.clone(),
            target_date: item.target_date.clone(),
            assigner_name,
            detected_at_ms: now_ms(),
        });
    }
    if !new_items.is_empty() {
        // 방금 개별 토스트를 보냈으니 재알림 타이머도 지금부터 센다.
        state.last_remind_ms = now_ms();
    }

    // 사라진 항목 정리 + 재알림
    state.pending = assign_watch::prune_pending(std::mem::take(&mut state.pending), &current_ids);
    if assign_watch::should_remind(state.pending.len(), state.last_remind_ms, now_ms(), s.assign_remind_hours) {
        let _ = app
            .notification()
            .builder()
            .title("미확인 할당이 있습니다")
            .body(format!("확인하지 않은 할당 작업 {}건 — 사이드바에서 확인하세요", state.pending.len()))
            .show();
        state.last_remind_ms = now_ms();
    }

    state.last_ids = current_ids;
    state.initialized = true;
    let pending_count = state.pending.len();
    assign_watch::save_state(app, &state)?;
    update_tray_tooltip(app, pending_count);
    let _ = app.emit_to("sidebar", "assignments-updated", ());
    Ok(())
}

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// `label` 창을 설정된 디스플레이 중앙에 배치하고 표시한다.
pub(crate) fn show_centered(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
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

pub(crate) fn show_quickadd(app: &tauri::AppHandle) {
    show_centered(app, "quickadd");
}

/// 미확인 할당 수를 트레이 툴팁에 반영. 0이면 기본 툴팁으로 복귀.
pub fn update_tray_tooltip(app: &tauri::AppHandle, pending_count: usize) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if pending_count > 0 {
            format!("Plane Quick Dock — 미확인 할당 {pending_count}건")
        } else {
            "Plane Quick Dock".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_i, &quit_i])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => show_window(app, "settings"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let s = config::load_settings(app.handle());
            app.manage(ShortcutBindings::default());
            app.handle().plugin(
                ShortcutBuilder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed { return; }
                        let pair = app.state::<ShortcutBindings>().0.lock().unwrap().clone();
                        if pair.qa.as_ref() == Some(shortcut) {
                            toggle_quickadd(app);
                        } else if pair.sb.as_ref() == Some(shortcut) {
                            // The sidebar animates its own show/hide (slide in/out
                            // from the screen edge), so just ask it to toggle
                            // itself instead of driving show()/hide() here.
                            let _ = app.emit_to("sidebar", "toggle-sidebar", ());
                        }
                    })
                    .build(),
            )?;
            // 시작 시엔 각 단축키를 독립적으로 등록한다 — 하나가 (다른 앱
            // 점유 등으로) 실패해도 나머지는 살아 있어야 한다.
            {
                let bindings = app.state::<ShortcutBindings>();
                let mut pair = bindings.0.lock().unwrap();
                match register_one(app.handle(), &s.quickadd_shortcut) {
                    Ok(sc) => pair.qa = Some(sc),
                    Err(e) => eprintln!("quickadd shortcut '{}' failed: {e}", s.quickadd_shortcut),
                }
                match register_one(app.handle(), &s.sidebar_shortcut) {
                    Ok(sc) => pair.sb = Some(sc),
                    Err(e) => eprintln!("sidebar shortcut '{}' failed: {e}", s.sidebar_shortcut),
                }
            }

            let cfg = config::load_settings(app.handle());
            if cfg.base_url.is_empty() {
                show_window(app.handle(), "settings");
            }

            app.manage(assign_watch::StateLock::default());
            check_for_updates(app.handle().clone());
            spawn_idle_watcher(app.handle().clone());
            spawn_morning_briefing_watcher(app.handle().clone());
            spawn_assign_watcher(app.handle().clone());
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
            commands::generate_briefing,
            commands::open_briefing,
            commands::get_pending_assignments,
            commands::acknowledge_assignment,
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
    fn ui_captured_accelerators_parse() {
        // 설정 화면의 키 캡처(src/shared/hotkey.ts)가 만들어내는 형식이
        // global-shortcut 플러그인 파서와 계속 호환되는지 지키는 가드.
        for accel in [
            "F1", "Shift+F2", "Ctrl+Shift+A", "Alt+Space", "Ctrl+7", "Super+F24",
            "Ctrl+Comma", "Ctrl+Alt+Up", "Alt+PageDown", "Ctrl+Backquote",
            "Ctrl+BracketLeft", "Alt+Semicolon", "Ctrl+Minus", "Ctrl+Enter",
        ] {
            assert!(accel.parse::<Shortcut>().is_ok(), "'{accel}' failed to parse");
        }
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
