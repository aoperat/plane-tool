use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";
const KEYRING_SERVICE: &str = "plane-quick-dock";
const KEYRING_ACCOUNT: &str = "api-token";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    #[serde(default = "default_quickadd_shortcut")]
    pub quickadd_shortcut: String,
    #[serde(default = "default_sidebar_shortcut")]
    pub sidebar_shortcut: String,
}

fn default_quickadd_shortcut() -> String { "Alt+Space".into() }
fn default_sidebar_shortcut() -> String { "Alt+S".into() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            workspace: String::new(),
            last_project_id: None,
            quickadd_shortcut: default_quickadd_shortcut(),
            sidebar_shortcut: default_sidebar_shortcut(),
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
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_default_has_empty_strings_and_no_project() {
        let s = Settings::default();
        assert_eq!(s.base_url, "");
        assert_eq!(s.workspace, "");
        assert_eq!(s.last_project_id, None);
        assert_eq!(s.quickadd_shortcut, "Alt+Space");
        assert_eq!(s.sidebar_shortcut, "Alt+S");
    }
}
