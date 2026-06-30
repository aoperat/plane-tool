use crate::config::Settings;

#[tauri::command]
pub fn get_settings() -> Settings { Settings::default() }

#[tauri::command]
pub fn save_settings(_settings: Settings) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub fn create_issue(_project_id: String, _name: String) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub fn fetch_sidebar_data() -> Result<serde_json::Value, String> { Ok(serde_json::json!({})) }
