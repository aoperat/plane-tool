# Plane Quick Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows tray-resident desktop app that, via two global shortcuts, lets the user quickly add work items to a self-hosted Plane instance and view their projects + assigned work items.

**Architecture:** A single Tauri v2 app. A Rust backend owns the Plane REST client, settings persistence, OS-keychain token storage, global-shortcut registration, and window show/hide. Three frameless WebView windows (QuickAdd popup, Sidebar panel, Settings) are built as separate Vite pages and call into Rust via `invoke`. All Plane HTTP happens in Rust so the API token never reaches JS.

**Tech Stack:** Tauri v2, Rust (stable), `reqwest` (HTTP), `keyring` (OS credential store), `tauri-plugin-global-shortcut` v2, `tauri-plugin-store` v2, `tauri-plugin-opener` v2; frontend = Vite + vanilla TypeScript (no UI framework). Tests: `wiremock` + `tokio` for the API client, `serde_json` round-trip for settings, plain `#[test]` for pure logic.

## Global Constraints

- Project root: `C:\WorkSpaces\plane-tool` (separate from the Plane monorepo).
- Target OS: Windows only (MVP). Dark theme only.
- Node 22.x + pnpm; Rust stable toolchain required (Tauri prerequisite).
- Default shortcuts: `Alt+Space` = QuickAdd, `Alt+S` = Sidebar. Both MUST be changeable in Settings (Alt+Space can collide with the Windows system menu).
- QuickAdd MVP sends only `{ "name": <title> }`. No description/priority/assignee fields.
- Plane public API (verified against the `plane` repo):
  - Auth header: `X-Api-Key` (exact casing).
  - List projects: `GET {base}/api/v1/workspaces/{slug}/projects/` — cursor-paginated, items under `results`.
  - Create work item: `POST {base}/api/v1/workspaces/{slug}/projects/{project_id}/work-items/`, body `{ "name": "..." }`.
  - List work items: `GET {base}/api/v1/workspaces/{slug}/projects/{project_id}/work-items/?expand=assignees,state&per_page=100` — **no assignee filter param; filter client-side.**
  - Current user: `GET {base}/api/v1/users/me/` → `{ id, display_name, ... }`.
  - Issue web URL: `{base}/{slug}/projects/{project_id}/issues/{issue_id}` (web route uses `/issues/`).
- State-group → sidebar dot: `completed`→done, `started`→in-progress, anything else→todo. `completed`/`cancelled` items are hidden from "assigned to me" by default.
- Project dot color: deterministic hash of the project `id` (no color field in the API payload).
- Confirmed mockup (UI source of truth): `docs/mockups/plane-quick-dock-mockup.html`. Reuse its CSS variables and component styles verbatim where possible.

---

## File Structure

```
plane-tool/
├─ package.json                  # pnpm scripts, Vite + @tauri-apps/cli
├─ vite.config.ts                # multi-page build: quickadd / sidebar / settings
├─ index.html                    # (unused root; redirect or blank)
├─ src/                          # frontend (vanilla TS)
│  ├─ shared/
│  │  ├─ ipc.ts                  # typed wrappers over @tauri-apps/api `invoke`
│  │  ├─ types.ts                # Project / WorkItem / Settings / SidebarData TS types
│  │  ├─ color.ts                # colorForId(id) deterministic dot color
│  │  └─ app.css                 # CSS vars + shared components (ported from mockup)
│  ├─ quickadd/  { index.html, main.ts }
│  ├─ sidebar/   { index.html, main.ts }
│  └─ settings/  { index.html, main.ts }
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json            # 3 hidden frameless windows, plugins, tray
   ├─ icons/                     # tray + app icons
   └─ src/
      ├─ main.rs                 # setup: tray, shortcuts, window toggle, plugin init
      ├─ config.rs               # Settings struct + store + keyring token
      ├─ plane_api.rs            # PlaneClient + DTOs + parsing + pure filters
      └─ commands.rs             # #[tauri::command] handlers (the IPC surface)
```

Responsibilities: `plane_api.rs` is pure request→response mapping (easy to mock-test). `config.rs` owns persistence only. `commands.rs` orchestrates the two (no HTTP or storage logic of its own beyond composition). `main.rs` owns OS integration (tray/shortcuts/windows). Each frontend page is isolated and only talks to Rust through `src/shared/ipc.ts`.

---

### Task 1: Scaffold Tauri v2 + Vite app that runs with a tray icon

**Files:**
- Create: `plane-tool/package.json`, `plane-tool/vite.config.ts`, `plane-tool/index.html`
- Create: `plane-tool/src/quickadd/index.html`, `plane-tool/src/sidebar/index.html`, `plane-tool/src/settings/index.html` (placeholders)
- Create: `plane-tool/src-tauri/Cargo.toml`, `plane-tool/src-tauri/tauri.conf.json`, `plane-tool/src-tauri/src/main.rs`
- Create: `plane-tool/src-tauri/icons/` (use `pnpm tauri icon` or copy Tauri defaults)

**Interfaces:**
- Produces: a running app with a system-tray icon whose menu has **Settings**, **Quit**; three hidden windows labeled `quickadd`, `sidebar`, `settings`.

- [ ] **Step 1: Initialize the project skeleton**

Run from `C:\WorkSpaces`:
```bash
cd C:/WorkSpaces/plane-tool
pnpm init
pnpm add -D vite typescript @tauri-apps/cli
pnpm add @tauri-apps/api
```

Add scripts to `package.json`:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri"
  }
}
```

- [ ] **Step 2: Create the multi-page Vite config**

`plane-tool/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        quickadd: resolve(__dirname, "src/quickadd/index.html"),
        sidebar: resolve(__dirname, "src/sidebar/index.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
      },
    },
  },
});
```

- [ ] **Step 3: Create placeholder page HTML**

`plane-tool/src/quickadd/index.html` (same skeleton for `sidebar/` and `settings/`, changing the title and the `main.ts` path):
```html
<!doctype html>
<html lang="ko">
  <head><meta charset="UTF-8" /><title>QuickAdd</title></head>
  <body><div id="app">quickadd</div><script type="module" src="./main.ts"></script></body>
</html>
```
Create `src/quickadd/main.ts`, `src/sidebar/main.ts`, `src/settings/main.ts` each containing:
```ts
console.log("page loaded");
```
Create `plane-tool/index.html` with a blank `<body></body>`.

- [ ] **Step 4: Scaffold the Tauri Rust crate**

`plane-tool/src-tauri/Cargo.toml`:
```toml
[package]
name = "plane-quick-dock"
version = "0.1.0"
edition = "2021"

[lib]
name = "plane_quick_dock_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-store = "2"
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }
keyring = "3"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
thiserror = "2"

[dev-dependencies]
wiremock = "0.6"
```

Create `plane-tool/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 5: Write tauri.conf.json with three hidden frameless windows**

`plane-tool/src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Plane Quick Dock",
  "version": "0.1.0",
  "identifier": "dev.aoperat.plane-quick-dock",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      {
        "label": "quickadd",
        "url": "src/quickadd/index.html",
        "width": 540, "height": 132,
        "decorations": false, "transparent": true, "alwaysOnTop": true,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": false
      },
      {
        "label": "sidebar",
        "url": "src/sidebar/index.html",
        "width": 320, "height": 720,
        "decorations": false, "alwaysOnTop": true,
        "skipTaskbar": true, "visible": false, "resizable": false
      },
      {
        "label": "settings",
        "url": "src/settings/index.html",
        "width": 460, "height": 420,
        "decorations": true, "skipTaskbar": false, "visible": false, "resizable": false
      }
    ],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": "all", "icon": ["icons/icon.ico"] }
}
```
> Note: Vite emits the page HTML under `dist/src/<page>/index.html`, so the window `url` paths match after build.

- [ ] **Step 6: Write main.rs with tray + plugins + a stubbed window toggle**

`plane-tool/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod plane_api;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn show_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
> This references `commands`, `config`, `plane_api` modules created in later tasks. Create minimal empty stubs now so it compiles: see Step 7.

- [ ] **Step 7: Create compiling stubs for the three modules**

`src-tauri/src/config.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Settings {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
}
```
`src-tauri/src/plane_api.rs`:
```rust
// filled in Task 3
```
`src-tauri/src/commands.rs`:
```rust
use crate::config::Settings;

#[tauri::command]
pub fn get_settings() -> Settings { Settings::default() }

#[tauri::command]
pub fn save_settings(_settings: Settings) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub fn create_issue(_project_id: String, _name: String) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub fn fetch_sidebar_data() -> Result<serde_json::Value, String> { Ok(serde_json::json!({})) }
```

- [ ] **Step 8: Run the app**

Run:
```bash
cd C:/WorkSpaces/plane-tool
pnpm tauri dev
```
Expected: app compiles, a tray icon appears, right-click shows **Settings** / **Quit**, **Quit** exits. Windows stay hidden. (If `pnpm tauri` is not found, run `pnpm exec tauri dev`.)

- [ ] **Step 9: Commit**

```bash
cd C:/WorkSpaces/plane-tool
git init
printf "node_modules/\ndist/\nsrc-tauri/target/\n" > .gitignore
git add -A
git commit -m "feat: scaffold Tauri v2 tray app with three hidden windows"
```

---

### Task 2: Settings model — serde round-trip + store + keychain token

**Files:**
- Modify: `src-tauri/src/config.rs`
- Test: inline `#[cfg(test)]` in `config.rs`

**Interfaces:**
- Consumes: `Settings` struct from Task 1.
- Produces:
  - `pub fn load_settings(app: &tauri::AppHandle) -> Settings`
  - `pub fn save_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String>`
  - `pub fn set_last_project(app: &tauri::AppHandle, project_id: &str) -> Result<(), String>`
  - `pub fn get_token() -> Option<String>` (keyring)
  - `pub fn set_token(token: &str) -> Result<(), String>` (keyring)
  - Constants: keyring service `"plane-quick-dock"`, account `"api-token"`; store file `"settings.json"`.

- [ ] **Step 1: Write the failing test for Settings JSON round-trip**

Add to `src-tauri/src/config.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_preserves_fields() {
        let s = Settings {
            base_url: "https://plane.example.com".into(),
            workspace: "acme".into(),
            last_project_id: Some("proj-123".into()),
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
    }
}
```

- [ ] **Step 2: Run the tests to verify they pass against the Task 1 struct**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test config::tests`
Expected: PASS (the struct already derives `Serialize/Deserialize/Default/PartialEq`). This locks the data contract before adding persistence.

- [ ] **Step 3: Implement store + keyring persistence**

Replace the body of `src-tauri/src/config.rs` above the `#[cfg(test)]` block with:
```rust
use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";
const KEYRING_SERVICE: &str = "plane-quick-dock";
const KEYRING_ACCOUNT: &str = "api-token";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Settings {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
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
```

- [ ] **Step 4: Verify it compiles and tests still pass**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test config::tests`
Expected: PASS, no compile errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: settings persistence via store + keychain token"
```

---

### Task 3: Plane API client — DTOs, parsing, HTTP (wiremock TDD)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`
- Test: inline `#[cfg(test)]` in `plane_api.rs`

**Interfaces:**
- Produces:
  - `pub struct PlaneClient { base_url, workspace, api_key, http }`
  - `pub struct Project { pub id: String, pub name: String, pub identifier: String }`
  - `pub struct WorkItem { pub id: String, pub name: String, pub priority: String, pub target_date: Option<String>, pub state_group: String, pub project_id: String, pub assignee_ids: Vec<String> }`
  - `pub struct CurrentUser { pub id: String, pub display_name: String }`
  - `PlaneClient::new(base_url: String, workspace: String, api_key: String) -> Self`
  - `async fn current_user(&self) -> Result<CurrentUser, String>`
  - `async fn list_projects(&self) -> Result<Vec<Project>, String>`
  - `async fn list_work_items(&self, project_id: &str) -> Result<Vec<WorkItem>, String>`
  - `async fn create_work_item(&self, project_id: &str, name: &str) -> Result<WorkItem, String>`
  - `pub fn filter_assigned_open(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem>` (pure)

- [ ] **Step 1: Write the pure filter test first**

`src-tauri/src/plane_api.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn wi(id: &str, group: &str, assignees: &[&str]) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("item {id}"), priority: "none".into(),
            target_date: None, state_group: group.into(), project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn filter_keeps_my_open_items_only() {
        let items = vec![
            wi("a", "started", &["me"]),     // keep
            wi("b", "completed", &["me"]),   // drop: completed
            wi("c", "unstarted", &["other"]),// drop: not mine
            wi("d", "cancelled", &["me"]),   // drop: cancelled
            wi("e", "backlog", &["me", "x"]),// keep
        ];
        let kept = filter_assigned_open(items, "me");
        let ids: Vec<_> = kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "e"]);
    }
}
```

- [ ] **Step 2: Run it to verify failure**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test plane_api::tests::filter_keeps_my_open_items_only`
Expected: FAIL to compile — `WorkItem` / `filter_assigned_open` not defined.

- [ ] **Step 3: Implement DTOs + the pure filter**

Prepend to `src-tauri/src/plane_api.rs` (above the test module):
```rust
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Project { pub id: String, pub name: String, pub identifier: String }

#[derive(Debug, Clone)]
pub struct WorkItem {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub assignee_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CurrentUser { pub id: String, pub display_name: String }

pub fn filter_assigned_open(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "completed" && i.state_group != "cancelled")
        .collect()
}
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `cargo test plane_api::tests::filter_keeps_my_open_items_only`
Expected: PASS.

- [ ] **Step 5: Write the wiremock test for list_projects parsing**

Add inside the `tests` module:
```rust
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client_for(server: &MockServer) -> PlaneClient {
        PlaneClient::new(server.uri(), "acme".into(), "secret-key".into())
    }

    #[tokio::test]
    async fn list_projects_parses_results_and_sends_api_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "p1", "name": "Web App", "identifier": "WEB" },
                    { "id": "p2", "name": "Mobile", "identifier": "MOB" }
                ]
            })))
            .mount(&server)
            .await;

        let projects = client_for(&server).await.list_projects().await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, "p1");
        assert_eq!(projects[1].name, "Mobile");
    }

    #[tokio::test]
    async fn list_work_items_parses_expanded_state_and_assignees() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{
                    "id": "i1", "name": "Fix bug", "priority": "high",
                    "target_date": "2026-06-30",
                    "state": { "group": "started" },
                    "assignees": [{ "id": "me" }]
                }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state_group, "started");
        assert_eq!(items[0].assignee_ids, vec!["me".to_string()]);
        assert_eq!(items[0].project_id, "p1");
    }

    #[tokio::test]
    async fn create_work_item_posts_name_only() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "new-1", "name": "Hello", "priority": "none",
                "target_date": serde_json::Value::Null, "assignees": []
            })))
            .mount(&server)
            .await;

        let created = client_for(&server).await.create_work_item("p1", "Hello").await.unwrap();
        assert_eq!(created.id, "new-1");
        assert_eq!(created.name, "Hello");
    }

    #[tokio::test]
    async fn current_user_parses_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/users/me/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "me", "display_name": "Aoperat"
            })))
            .mount(&server)
            .await;

        let user = client_for(&server).await.current_user().await.unwrap();
        assert_eq!(user.id, "me");
        assert_eq!(user.display_name, "Aoperat");
    }
```

- [ ] **Step 6: Run the HTTP tests to verify they fail**

Run: `cargo test plane_api::tests`
Expected: FAIL to compile — `PlaneClient` and its methods not defined.

- [ ] **Step 7: Implement PlaneClient and the wire DTOs**

Add to `src-tauri/src/plane_api.rs` (above the test module, after the public DTOs):
```rust
#[derive(Deserialize)]
struct Paginated<T> { results: Vec<T> }

#[derive(Deserialize)]
struct RawProject { id: String, name: String, #[serde(default)] identifier: String }

#[derive(Deserialize)]
struct RawState { #[serde(default)] group: String }

#[derive(Deserialize)]
struct RawAssignee { id: String }

#[derive(Deserialize)]
struct RawWorkItem {
    id: String,
    name: String,
    #[serde(default = "priority_none")] priority: String,
    #[serde(default)] target_date: Option<String>,
    #[serde(default)] state: Option<RawState>,
    #[serde(default)] assignees: Vec<RawAssignee>,
}

fn priority_none() -> String { "none".into() }

#[derive(Deserialize)]
struct RawUser { id: String, #[serde(default)] display_name: String }

pub struct PlaneClient {
    base_url: String,
    workspace: String,
    api_key: String,
    http: reqwest::Client,
}

impl PlaneClient {
    pub fn new(base_url: String, workspace: String, api_key: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            workspace,
            api_key,
            http: reqwest::Client::new(),
        }
    }

    fn ws_base(&self) -> String {
        format!("{}/api/v1/workspaces/{}", self.base_url, self.workspace)
    }

    async fn get_json(&self, url: &str) -> Result<reqwest::Response, String> {
        self.http
            .get(url)
            .header("X-Api-Key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())
    }

    pub async fn current_user(&self) -> Result<CurrentUser, String> {
        let url = format!("{}/api/v1/users/me/", self.base_url);
        let raw: RawUser = self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(CurrentUser { id: raw.id, display_name: raw.display_name })
    }

    pub async fn list_projects(&self) -> Result<Vec<Project>, String> {
        let url = format!("{}/projects/", self.ws_base());
        let page: Paginated<RawProject> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|p| Project { id: p.id, name: p.name, identifier: p.identifier })
            .collect())
    }

    pub async fn list_work_items(&self, project_id: &str) -> Result<Vec<WorkItem>, String> {
        let url = format!(
            "{}/projects/{}/work-items/?expand=assignees,state&per_page=100",
            self.ws_base(),
            project_id
        );
        let page: Paginated<RawWorkItem> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page.results.into_iter().map(|w| map_work_item(w, project_id)).collect())
    }

    pub async fn create_work_item(&self, project_id: &str, name: &str) -> Result<WorkItem, String> {
        let url = format!("{}/projects/{}/work-items/", self.ws_base(), project_id);
        let raw: RawWorkItem = self
            .http
            .post(&url)
            .header("X-Api-Key", &self.api_key)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        Ok(map_work_item(raw, project_id))
    }
}

fn map_work_item(w: RawWorkItem, project_id: &str) -> WorkItem {
    WorkItem {
        id: w.id,
        name: w.name,
        priority: w.priority,
        target_date: w.target_date,
        state_group: w.state.map(|s| s.group).unwrap_or_default(),
        project_id: project_id.to_string(),
        assignee_ids: w.assignees.into_iter().map(|a| a.id).collect(),
    }
}
```

- [ ] **Step 8: Run the full module test suite**

Run: `cargo test plane_api::tests`
Expected: all 5 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat: Plane API client with wiremock-tested parsing"
```

---

### Task 4: Tauri commands — wire config + API into the IPC surface

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Test: inline `#[cfg(test)]` in `commands.rs` for the pure `SidebarData` assembly helper

**Interfaces:**
- Consumes: `config::{load_settings, save_settings, set_last_project, get_token, set_token}`, `plane_api::{PlaneClient, filter_assigned_open, Project, WorkItem, CurrentUser}`.
- Produces commands (all already registered in `main.rs` Task 1 Step 6):
  - `get_settings(app) -> SettingsDto` (includes `has_token: bool`, never the token itself)
  - `save_settings(app, base_url, workspace, token) -> Result<(), String>`
  - `create_issue(app, project_id, name) -> Result<(), String>`
  - `fetch_sidebar_data(app) -> Result<SidebarData, String>`
- Produces serializable DTOs: `SettingsDto`, `ProjectDto`, `WorkItemDto`, `SidebarData`, plus pure `assemble_sidebar(user_id, projects, items_by_project) -> SidebarData`.

- [ ] **Step 1: Write the failing test for sidebar assembly**

Replace `src-tauri/src/commands.rs` test region with:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::{Project, WorkItem};

    fn wi(id: &str, group: &str, assignees: &[&str], project: &str) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, state_group: group.into(), project_id: project.into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn assemble_filters_to_my_open_items_across_projects() {
        let projects = vec![
            Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() },
            Project { id: "p2".into(), name: "Mob".into(), identifier: "MOB".into() },
        ];
        let items = vec![
            wi("a", "started", &["me"], "p1"),
            wi("b", "completed", &["me"], "p1"),
            wi("c", "backlog", &["me"], "p2"),
            wi("d", "started", &["other"], "p2"),
        ];
        let data = assemble_sidebar("me", projects, items);
        assert_eq!(data.projects.len(), 2);
        let ids: Vec<_> = data.assigned.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }
}
```

- [ ] **Step 2: Run it to verify failure**

Run: `cargo test commands::tests`
Expected: FAIL to compile — `assemble_sidebar`, `SidebarData` not defined.

- [ ] **Step 3: Implement DTOs, the pure assembler, and the commands**

Replace the non-test portion of `src-tauri/src/commands.rs` with:
```rust
use crate::config;
use crate::plane_api::{filter_assigned_open, PlaneClient, Project, WorkItem};
use serde::Serialize;

#[derive(Serialize)]
pub struct SettingsDto {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    pub has_token: bool,
}

#[derive(Serialize)]
pub struct ProjectDto { pub id: String, pub name: String, pub identifier: String }

#[derive(Serialize)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
}

#[derive(Serialize)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
}

pub fn assemble_sidebar(user_id: &str, projects: Vec<Project>, items: Vec<WorkItem>) -> SidebarData {
    let assigned = filter_assigned_open(items, user_id)
        .into_iter()
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            state_group: w.state_group, project_id: w.project_id,
        })
        .collect();
    let projects = projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect();
    SidebarData { projects, assigned }
}

fn client(app: &tauri::AppHandle) -> Result<(PlaneClient, crate::config::Settings), String> {
    let s = config::load_settings(app);
    if s.base_url.is_empty() || s.workspace.is_empty() {
        return Err("not_configured".into());
    }
    let token = config::get_token().ok_or("not_configured")?;
    Ok((PlaneClient::new(s.base_url.clone(), s.workspace.clone(), token), s))
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> SettingsDto {
    let s = config::load_settings(&app);
    SettingsDto {
        base_url: s.base_url,
        workspace: s.workspace,
        last_project_id: s.last_project_id,
        has_token: config::get_token().is_some(),
    }
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    base_url: String,
    workspace: String,
    token: Option<String>,
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace;
    config::save_settings(&app, &s)?;
    if let Some(t) = token {
        if !t.is_empty() {
            config::set_token(&t)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_issue(app: tauri::AppHandle, project_id: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    client.create_work_item(&project_id, name.trim()).await?;
    config::set_last_project(&app, &project_id)?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_sidebar_data(app: tauri::AppHandle) -> Result<SidebarData, String> {
    let (client, _s) = client(&app)?;
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
    }
    Ok(assemble_sidebar(&user.id, projects, all_items))
}
```

- [ ] **Step 4: Update main.rs invoke_handler signatures**

In `src-tauri/src/main.rs`, the handler list from Task 1 already names these four commands. Confirm it matches:
```rust
.invoke_handler(tauri::generate_handler![
    commands::get_settings,
    commands::save_settings,
    commands::create_issue,
    commands::fetch_sidebar_data
])
```
No change needed if identical.

- [ ] **Step 5: Run tests + compile**

Run: `cd C:/WorkSpaces/plane-tool/src-tauri && cargo test`
Expected: all tests across `config`, `plane_api`, `commands` PASS; app crate compiles.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat: IPC commands wiring config + Plane API"
```

---

### Task 5: Global shortcuts + window show/hide/blur behavior

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/config.rs` (add shortcut fields)

**Interfaces:**
- Consumes: `Settings`, `show_window` from Task 1.
- Produces: at startup, registers the QuickAdd and Sidebar shortcuts from settings (defaults `Alt+Space`, `Alt+S`); toggling a window shows/focuses it; losing focus hides it. Sidebar is positioned flush to the right edge of the primary monitor.

- [ ] **Step 1: Add shortcut fields to Settings with defaults**

In `src-tauri/src/config.rs`, extend the struct and update the round-trip test:
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
```
Update `settings_round_trip_preserves_fields` to set both shortcut fields, and `settings_default_*` to assert `quickadd_shortcut == "Alt+Space"` and `sidebar_shortcut == "Alt+S"`.

- [ ] **Step 2: Run config tests**

Run: `cargo test config::tests`
Expected: PASS.

- [ ] **Step 3: Register shortcuts and add toggle + blur-hide in main.rs**

In `src-tauri/src/main.rs`, replace the `.plugin(tauri_plugin_global_shortcut::Builder::new().build())` line and extend `setup`:
```rust
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

fn toggle_window(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            if label == "sidebar" {
                position_sidebar(&win);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn position_sidebar(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let w = (320.0 * scale) as i32;
        let x = screen.width as i32 - w;
        let _ = win.set_position(tauri::PhysicalPosition { x, y: 0 });
        let _ = win.set_size(tauri::PhysicalSize { width: w as u32, height: screen.height });
    }
}
```
In `setup`, after the tray block, read settings and register shortcuts:
```rust
            let s = config::load_settings(app.handle());
            let qa = s.quickadd_shortcut.clone();
            let sb = s.sidebar_shortcut.clone();
            app.handle().plugin(
                ShortcutBuilder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed { return; }
                        let pressed = shortcut.to_string();
                        if pressed.eq_ignore_ascii_case(&qa) {
                            toggle_window(app, "quickadd");
                        } else if pressed.eq_ignore_ascii_case(&sb) {
                            toggle_window(app, "sidebar");
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(s.quickadd_shortcut.as_str())?;
            app.global_shortcut().register(s.sidebar_shortcut.as_str())?;
```
Add the import at the top: `use tauri_plugin_global_shortcut::GlobalShortcutExt;`

- [ ] **Step 4: Hide windows on focus loss**

In `setup`, after registering shortcuts, attach focus listeners to the two transient windows:
```rust
            for label in ["quickadd", "sidebar"] {
                if let Some(win) = app.get_webview_window(label) {
                    let w = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            let _ = w.hide();
                        }
                    });
                }
            }
```

- [ ] **Step 5: Manual verification**

Run: `pnpm tauri dev`
Verify:
- `Alt+Space` toggles the centered QuickAdd window (shows, then hides on second press or on clicking elsewhere).
- `Alt+S` toggles the right-docked Sidebar (full screen height, flush right).
- Clicking outside either window hides it.
If `Alt+Space` fails to register (system conflict), the app should still run; note it and proceed (Settings task lets the user rebind).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/config.rs
git commit -m "feat: global shortcuts + window toggle/blur-hide/positioning"
```

---

### Task 6: QuickAdd UI

**Files:**
- Create: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/shared/color.ts`, `src/shared/app.css`
- Modify: `src/quickadd/index.html`, `src/quickadd/main.ts`
- Test: `src/shared/color.test.ts` (Vitest) for the pure color function

**Interfaces:**
- Consumes IPC: `get_settings`, `create_issue`, `fetch_sidebar_data` (for the project list).
- Produces shared modules used by Sidebar/Settings too.

- [ ] **Step 1: Add Vitest and write the failing color test**

Run: `pnpm add -D vitest`
Add to `package.json` scripts: `"test": "vitest run"`.
`src/shared/color.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { colorForId } from "./color";

describe("colorForId", () => {
  it("is deterministic for the same id", () => {
    expect(colorForId("p1")).toBe(colorForId("p1"));
  });
  it("returns an hsl string", () => {
    expect(colorForId("p1")).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
  it("differs for different ids (usually)", () => {
    expect(colorForId("p1")).not.toBe(colorForId("totally-different"));
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./color`.

- [ ] **Step 3: Implement the color util and shared types/ipc**

`src/shared/color.ts`:
```ts
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
}
```
`src/shared/types.ts`:
```ts
export interface Project { id: string; name: string; identifier: string; }
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; state_group: string; project_id: string;
}
export interface SidebarData { projects: Project[]; assigned: WorkItem[]; }
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
}
```
`src/shared/ipc.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import type { SidebarData, SettingsDto } from "./types";

export const getSettings = () => invoke<SettingsDto>("get_settings");
export const saveSettings = (base_url: string, workspace: string, token?: string) =>
  invoke<void>("save_settings", { baseUrl: base_url, workspace, token });
export const createIssue = (project_id: string, name: string) =>
  invoke<void>("create_issue", { projectId: project_id, name });
export const fetchSidebarData = () => invoke<SidebarData>("fetch_sidebar_data");
```

- [ ] **Step 4: Run the color test to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Port shared CSS from the mockup**

Create `src/shared/app.css` by copying the `:root` CSS variables and the component classes (`.popup`, `.proj-select`, `.dropdown`, `.sidebar`, `.task`, etc.) from `docs/mockups/plane-quick-dock-mockup.html` `<style>` block verbatim. Remove mockup-only helpers (`.hint-bar`, `.ghost`, `.caption`).

- [ ] **Step 6: Build the QuickAdd markup**

`src/quickadd/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>빠른 추가</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <div class="popup" style="position:static;width:100%;transform:none;">
      <div class="popup-top">
        <div class="accent-bar"></div>
        <input id="title" class="title-input" placeholder="진행 중인 작업을 입력하고 Enter…" autofocus />
      </div>
      <div class="popup-bottom">
        <button id="projBtn" class="proj-select" type="button">
          <span id="projDot" class="dot"></span>
          <span id="projName">프로젝트 선택</span>
          <span class="chev">▾</span>
        </button>
        <div class="keys"><kbd>Enter</kbd> 추가 · <kbd>Esc</kbd> 닫기</div>
      </div>
      <div id="dropdown" class="dropdown" hidden></div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: Implement QuickAdd behavior**

`src/quickadd/main.ts`:
```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createIssue, fetchSidebarData, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const titleEl = document.getElementById("title") as HTMLInputElement;
const projBtn = document.getElementById("projBtn")!;
const projName = document.getElementById("projName")!;
const projDot = document.getElementById("projDot")!;
const dropdown = document.getElementById("dropdown")!;

let projects: Project[] = [];
let selectedId: string | null = null;

function renderSelected() {
  const p = projects.find((x) => x.id === selectedId);
  projName.textContent = p ? p.name : "프로젝트 선택";
  (projDot as HTMLElement).style.background = p ? colorForId(p.id) : "transparent";
}

function renderDropdown() {
  dropdown.innerHTML = "";
  for (const p of projects) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p.id === selectedId ? " sel" : "");
    item.innerHTML = `<span class="dot" style="background:${colorForId(p.id)}"></span>${p.name}`;
    item.onclick = () => { selectedId = p.id; renderSelected(); dropdown.hidden = true; titleEl.focus(); };
    dropdown.appendChild(item);
  }
}

async function load() {
  const [settings, data] = await Promise.all([getSettings(), fetchSidebarData().catch(() => null)]);
  projects = data?.projects ?? [];
  selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  renderSelected();
  renderDropdown();
}

projBtn.onclick = () => { dropdown.hidden = !dropdown.hidden; };

titleEl.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { await win.hide(); }
  if (e.key === "Enter") {
    const name = titleEl.value.trim();
    if (!name || !selectedId) return;
    try {
      await createIssue(selectedId, name);
      titleEl.value = "";
      await win.hide();
    } catch (err) {
      titleEl.classList.add("error");
      console.error(err);
    }
  }
});

win.listen("tauri://focus", () => { titleEl.focus(); load(); });
load();
```
> Reloading on focus keeps the project list and remembered default fresh each time the popup opens.

- [ ] **Step 8: Manual verification**

Run: `pnpm tauri dev` (configure a real Plane instance via tray → Settings first if Task 8 is done; otherwise verify the popup renders and Esc hides it).
Verify: typing a title + Enter creates an item in Plane; the project selector shows the remembered project; the dropdown changes selection; Esc hides.

- [ ] **Step 9: Commit**

```bash
git add src/shared src/quickadd package.json
git commit -m "feat: QuickAdd popup UI + shared ipc/types/color"
```

---

### Task 7: Sidebar UI

**Files:**
- Modify: `src/sidebar/index.html`, `src/sidebar/main.ts`

**Interfaces:**
- Consumes IPC: `fetchSidebarData`, `getSettings`; opens issue URLs via `@tauri-apps/plugin-opener`.

- [ ] **Step 1: Add the opener JS plugin**

Run: `pnpm add @tauri-apps/plugin-opener`

- [ ] **Step 2: Build the Sidebar markup**

`src/sidebar/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>Quick Dock</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body>
    <aside class="sidebar" style="position:static;width:100%;height:100vh;">
      <div class="sb-head">
        <div class="logo">P</div>
        <div class="t">Quick Dock</div>
        <span id="user" class="u"></span>
        <span id="refresh" class="refresh" title="새로고침">⟳</span>
      </div>
      <div class="scroll">
        <div class="sb-section">
          <div class="h"><span>내 프로젝트</span><span id="projCount" class="count">0</span></div>
          <div id="projects"></div>
        </div>
        <div class="divider"></div>
        <div class="sb-section">
          <div class="h"><span>나에게 할당된 작업</span><span id="taskCount" class="count">0</span></div>
          <div id="tasks"></div>
        </div>
      </div>
      <div class="sb-foot"><span id="synced">동기화 대기</span></div>
    </aside>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Implement Sidebar behavior**

`src/sidebar/main.ts`:
```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchSidebarData, getSettings } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { SidebarData, Project, WorkItem } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const projectsEl = document.getElementById("projects")!;
const tasksEl = document.getElementById("tasks")!;
const projCount = document.getElementById("projCount")!;
const taskCount = document.getElementById("taskCount")!;
const synced = document.getElementById("synced")!;
let baseUrl = "";
let workspace = "";

function dotClass(group: string): string {
  if (group === "completed") return "state-done";
  if (group === "started") return "state-prog";
  return "state-todo";
}
function prioLabel(p: string): string {
  return p === "urgent" || p === "high" ? "높음" : p === "medium" ? "보통" : "";
}

function renderProjects(projects: Project[]) {
  projCount.textContent = String(projects.length);
  projectsEl.innerHTML = "";
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "proj-row";
    row.innerHTML = `<span class="dot" style="background:${colorForId(p.id)}"></span>${p.name}`;
    projectsEl.appendChild(row);
  }
}

function renderTasks(items: WorkItem[]) {
  taskCount.textContent = String(items.length);
  tasksEl.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "task";
    const prio = prioLabel(it.priority);
    const due = it.target_date ? `<span class="due">· ${it.target_date}</span>` : "";
    el.innerHTML =
      `<span class="state-dot ${dotClass(it.state_group)}"></span>` +
      `<div class="body"><div class="name">${it.name}</div>` +
      `<div class="meta">${prio ? `<span class="prio">${prio}</span>` : ""}${due}</div></div>`;
    el.onclick = () => openUrl(`${baseUrl}/${workspace}/projects/${it.project_id}/issues/${it.id}`);
    tasksEl.appendChild(el);
  }
}

async function refresh() {
  synced.textContent = "동기화 중…";
  try {
    const s = await getSettings();
    baseUrl = s.base_url; workspace = s.workspace;
    const data: SidebarData = await fetchSidebarData();
    renderProjects(data.projects);
    renderTasks(data.assigned);
    synced.textContent = "동기화 완료";
  } catch (e) {
    synced.textContent = "동기화 실패 — 설정을 확인하세요";
    console.error(e);
  }
}

document.getElementById("refresh")!.onclick = refresh;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") win.hide(); });
win.listen("tauri://focus", refresh);
refresh();
```

- [ ] **Step 4: Manual verification**

Run: `pnpm tauri dev`
Verify: `Alt+S` shows projects + assigned items; counts match; clicking a task opens the Plane issue in the browser; ⟳ refreshes; Esc hides.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar package.json
git commit -m "feat: Sidebar UI with projects + assigned items + open-in-browser"
```

---

### Task 8: Settings UI + first-run

**Files:**
- Modify: `src/settings/index.html`, `src/settings/main.ts`

**Interfaces:**
- Consumes IPC: `getSettings`, `saveSettings`.

- [ ] **Step 1: Build the Settings markup**

`src/settings/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>설정 — Plane Quick Dock</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body>
    <div class="settings">
      <h2>Plane 연결</h2>
      <label>Base URL<input id="baseUrl" placeholder="https://plane.example.com" /></label>
      <label>Workspace slug<input id="workspace" placeholder="acme" /></label>
      <label>API 토큰<input id="token" type="password" placeholder="(저장됨 — 변경 시에만 입력)" /></label>
      <p id="status" class="status"></p>
      <div class="row"><button id="save">저장</button></div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```
Add minimal `.settings`, `.settings label`, `.settings input`, `.status` rules to `src/shared/app.css` (dark theme, consistent with the CSS vars).

- [ ] **Step 2: Implement Settings behavior**

`src/settings/main.ts`:
```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, saveSettings } from "../shared/ipc";
import "../shared/app.css";

const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

async function load() {
  const s = await getSettings();
  baseUrl.value = s.base_url;
  workspace.value = s.workspace;
  token.placeholder = s.has_token ? "(저장됨 — 변경 시에만 입력)" : "API 토큰 입력";
}

document.getElementById("save")!.onclick = async () => {
  status.textContent = "저장 중…";
  try {
    await saveSettings(baseUrl.value.trim(), workspace.value.trim(), token.value || undefined);
    token.value = "";
    status.textContent = "저장됨 ✓ (단축키 변경은 재시작 후 적용)";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};

load();
```

- [ ] **Step 3: Open Settings automatically on first run**

In `src-tauri/src/main.rs` `setup`, after registering shortcuts, add:
```rust
            let cfg = config::load_settings(app.handle());
            if cfg.base_url.is_empty() {
                show_window(app.handle(), "settings");
            }
```

- [ ] **Step 4: Manual verification**

Run: `pnpm tauri dev` with no prior config.
Verify: Settings opens on first run; entering base URL + workspace + token and saving lets QuickAdd/Sidebar reach Plane; reopening Settings shows the saved base URL/workspace and a "(저장됨)" token placeholder (token never round-trips to the UI).

- [ ] **Step 5: Commit**

```bash
git add src/settings src-tauri/src/main.rs
git commit -m "feat: Settings UI + first-run onboarding"
```

---

### Task 9: Error polish, shortcut rebinding, and Windows packaging

**Files:**
- Modify: `src/settings/index.html`, `src/settings/main.ts`, `src/shared/ipc.ts`, `src-tauri/src/main.rs`

**Interfaces:**
- Adds shortcut fields to the Settings form and surfaces a registration-failure notice.

- [ ] **Step 1: Add shortcut inputs to Settings**

In `src/settings/index.html`, add before `<p id="status">`:
```html
      <h2>단축키</h2>
      <label>빠른 추가<input id="qaShortcut" placeholder="Alt+Space" /></label>
      <label>사이드바<input id="sbShortcut" placeholder="Alt+S" /></label>
```

- [ ] **Step 2: Extend save/get IPC to carry shortcuts**

In `src-tauri/src/commands.rs`, extend `save_settings` params with `quickadd_shortcut: Option<String>` and `sidebar_shortcut: Option<String>`, writing them into `Settings` (fall back to existing values when `None`). Extend `SettingsDto` with both shortcut strings and populate them in `get_settings`. Update `src/shared/types.ts` `SettingsDto` and `src/shared/ipc.ts` `saveSettings` signature accordingly, and set/read the two new inputs in `src/settings/main.ts`.

```rust
// commands.rs save_settings additions:
    if let Some(v) = quickadd_shortcut { if !v.is_empty() { s.quickadd_shortcut = v; } }
    if let Some(v) = sidebar_shortcut { if !v.is_empty() { s.sidebar_shortcut = v; } }
```

- [ ] **Step 3: Surface shortcut-registration failure**

In `src-tauri/src/main.rs`, replace the two `?`-propagated `register(...)` calls with non-fatal handling that logs to a tray tooltip or eprintln:
```rust
            if let Err(e) = app.global_shortcut().register(s.quickadd_shortcut.as_str()) {
                eprintln!("quickadd shortcut '{}' failed: {e}", s.quickadd_shortcut);
            }
            if let Err(e) = app.global_shortcut().register(s.sidebar_shortcut.as_str()) {
                eprintln!("sidebar shortcut '{}' failed: {e}", s.sidebar_shortcut);
            }
```
So a conflict (e.g. `Alt+Space`) never prevents the app from starting; the user can rebind in Settings and restart.

- [ ] **Step 4: Full test + build**

Run:
```bash
cd C:/WorkSpaces/plane-tool/src-tauri && cargo test
cd C:/WorkSpaces/plane-tool && pnpm test
pnpm tauri build
```
Expected: all Rust + Vitest tests pass; `pnpm tauri build` produces a Windows installer under `src-tauri/target/release/bundle/`.

- [ ] **Step 5: End-to-end smoke test against a real self-hosted Plane**

Install the built app (or run the release binary). Verify the full loop: first-run Settings → save → `Alt+Space` add an item (appears in Plane) → `Alt+S` see it under assigned → click opens it in the browser → rebind `Alt+Space` to `Alt+Shift+Space`, restart, confirm new binding works.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: shortcut rebinding in settings + non-fatal registration + packaging"
```

---

## Self-Review Notes

- **Spec coverage:** §3 shortcuts → Tasks 5, 9; §4.1 QuickAdd → Task 6; §4.2 Sidebar → Task 7; §5 components → Tasks 2–5; §6 data flow → Tasks 3–7; §7 API (verified endpoints, `X-Api-Key`, `/work-items/`, client-side assignee filter, `users/me`, issue URL) → Tasks 3, 4, 7; §8 token in keychain + base URL/workspace in store, all HTTP in Rust → Tasks 2, 4; §9 error handling (shortcut conflict, 401/not_configured, network → cached/failed text, empty title disabled) → Tasks 4, 5, 7, 9; §10 tests (API client mocked, settings round-trip, manual integration) → Tasks 2, 3, 4, 6.
- **Color field gap:** spec notes no color in API → `colorForId` hash (Task 6) covers project dots.
- **Naming consistency:** IPC command names (`get_settings`, `save_settings`, `create_issue`, `fetch_sidebar_data`) match between `main.rs` handler list (Task 1/4) and `ipc.ts` (Task 6). DTO field `state_group` is consistent across Rust `WorkItemDto` and TS `WorkItem`.
- **Known caveat:** shortcut changes require an app restart (re-registration on startup); surfaced to the user in the Settings save message (Task 8 Step 2). Live re-registration is deliberately out of MVP scope (YAGNI).
