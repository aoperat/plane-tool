//! 오프라인 캐시 · 쓰기 큐 · 재생(replay) 순수 로직 + 영속화.
//!
//! 네트워크 판정과 백그라운드 루프는 lib.rs가 담당하고, 이 모듈은 데이터
//! 구조와 영속 상태, 순수 판정 로직만 둔다 (assign_watch.rs와 같은 구조).

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use crate::commands::{SidebarData, WorkItemDto};

const STORE_FILE: &str = "offline.json";
const CACHE_KEY: &str = "cache";
const QUEUE_KEY: &str = "queue";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSnapshot {
    pub data: SidebarData,
    pub cached_at_ms: u64,
}

pub fn load_cache(app: &tauri::AppHandle) -> Option<CacheSnapshot> {
    app.store(STORE_FILE)
        .ok()?
        .get(CACHE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
}

pub fn save_cache_snapshot(app: &tauri::AppHandle, snapshot: &CacheSnapshot) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(CACHE_KEY, serde_json::to_value(snapshot).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

pub fn save_cache(app: &tauri::AppHandle, data: &SidebarData, now_ms: u64) -> Result<(), String> {
    save_cache_snapshot(app, &CacheSnapshot { data: data.clone(), cached_at_ms: now_ms })
}
