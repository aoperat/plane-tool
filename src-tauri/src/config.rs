use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";
const KEYRING_SERVICE: &str = "plane-quick-dock";
const KEYRING_ACCOUNT: &str = "api-token";
const KEYRING_OPENAI_ACCOUNT: &str = "openai-api-key";

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
    /// PC 유휴 시 사이드바 자동 열기 (기본 켬).
    #[serde(default = "default_idle_open_enabled")]
    pub idle_open_enabled: bool,
    /// 자동 열기까지의 유휴 기준 시간(분).
    #[serde(default = "default_idle_open_minutes")]
    pub idle_open_minutes: u32,
    /// AI 브리핑에 쓰는 OpenAI 모델명.
    #[serde(default = "default_briefing_model")]
    pub briefing_model: String,
    /// 아침 브리핑 자동 표시 (기본 끔).
    #[serde(default)]
    pub morning_briefing_enabled: bool,
    /// 아침 브리핑 시각 "HH:MM".
    #[serde(default = "default_morning_briefing_time")]
    pub morning_briefing_time: String,
}

fn default_quickadd_shortcut() -> String { "F1".into() }
fn default_sidebar_shortcut() -> String { "F2".into() }
fn default_theme() -> String { "auto".into() }
fn default_display_index() -> u32 { 1 }
fn default_idle_open_enabled() -> bool { true }
fn default_idle_open_minutes() -> u32 { 3 }
fn default_briefing_model() -> String { "gpt-4o-mini".into() }
fn default_morning_briefing_time() -> String { "09:00".into() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            // This app is built for internal distribution to a fixed self-hosted
            // Plane instance, so new installs start pre-pointed at it instead of
            // making every user look up and type the same address.
            base_url: "https://192.168.20.235".into(),
            workspace: String::new(),
            last_project_id: None,
            quickadd_shortcut: default_quickadd_shortcut(),
            sidebar_shortcut: default_sidebar_shortcut(),
            theme: default_theme(),
            display_index: default_display_index(),
            idle_open_enabled: default_idle_open_enabled(),
            idle_open_minutes: default_idle_open_minutes(),
            briefing_model: default_briefing_model(),
            morning_briefing_enabled: false,
            morning_briefing_time: default_morning_briefing_time(),
        }
    }
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    match app.store(STORE_FILE) {
        Ok(store) => store
            .get(STORE_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(s).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

pub fn set_last_project(app: &tauri::AppHandle, project_id: &str) -> Result<(), String> {
    let mut s = load_settings(app);
    s.last_project_id = Some(project_id.to_string());
    save_settings(app, &s)
}

pub fn get_token() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn set_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

pub fn get_openai_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_OPENAI_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn set_openai_key(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_OPENAI_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

const BRIEFING_CACHE_KEY: &str = "briefing_cache";

/// 마지막 브리핑 캐시. 같은 날 다시 열면 API를 다시 부르지 않기 위한 것 —
/// 파싱 실패(구버전 포맷 등)는 캐시 없음으로 취급한다.
pub fn load_cached_briefing(app: &tauri::AppHandle) -> Option<crate::briefing::Briefing> {
    app.store(STORE_FILE)
        .ok()?
        .get(BRIEFING_CACHE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
}

pub fn save_cached_briefing(app: &tauri::AppHandle, b: &crate::briefing::Briefing) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(BRIEFING_CACHE_KEY, serde_json::to_value(b).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

const MORNING_LAST_KEY: &str = "briefing_morning_last";

pub fn get_morning_last(app: &tauri::AppHandle) -> Option<String> {
    app.store(STORE_FILE)
        .ok()?
        .get(MORNING_LAST_KEY)
        .and_then(|v| v.as_str().map(str::to_owned))
}

pub fn set_morning_last(app: &tauri::AppHandle, date: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(MORNING_LAST_KEY, serde_json::json!(date));
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            idle_open_enabled: false,
            idle_open_minutes: 10,
            briefing_model: "gpt-4o".into(),
            morning_briefing_enabled: true,
            morning_briefing_time: "08:30".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_default_enables_idle_open_at_3_minutes() {
        let s = Settings::default();
        assert!(s.idle_open_enabled);
        assert_eq!(s.idle_open_minutes, 3);
    }

    #[test]
    fn settings_without_idle_fields_gets_defaults() {
        // 이 기능 이전에 저장된 설정 파일에는 idle 필드가 없다 — 기본값으로
        // 채워져야 한다 (켬 / 3분).
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert!(s.idle_open_enabled);
        assert_eq!(s.idle_open_minutes, 3);
    }

    #[test]
    fn keyring_backend_persists_across_entries() {
        // A fresh Entry must be able to read what another Entry wrote — exactly
        // how set_token writes and get_token (a separate Entry) reads. The
        // no-backend keyring mock fails this; a real OS backend passes.
        let svc = "plane-quick-dock-selftest";
        let acct = "roundtrip";
        let e1 = keyring::Entry::new(svc, acct).expect("entry");
        e1.set_password("probe-value").expect("set_password should succeed");
        let e2 = keyring::Entry::new(svc, acct).expect("entry");
        let got = e2.get_password();
        let _ = e2.delete_credential();
        assert_eq!(got.ok().as_deref(), Some("probe-value"));
    }

    #[test]
    fn settings_default_has_fixed_base_url_and_no_project() {
        let s = Settings::default();
        assert_eq!(s.base_url, "https://192.168.20.235");
        assert_eq!(s.workspace, "");
        assert_eq!(s.last_project_id, None);
        assert_eq!(s.quickadd_shortcut, "F1");
        assert_eq!(s.sidebar_shortcut, "F2");
        assert_eq!(s.theme, "auto");
        assert_eq!(s.display_index, 1);
    }

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

    #[test]
    fn settings_without_briefing_fields_gets_defaults() {
        // 이 기능 이전에 저장된 설정 파일 — 기본값으로 채워져야 한다.
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert_eq!(s.briefing_model, "gpt-4o-mini");
        assert!(!s.morning_briefing_enabled);
        assert_eq!(s.morning_briefing_time, "09:00");
    }
}
