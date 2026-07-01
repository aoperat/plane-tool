# Sidebar Edit Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar row's left-click "open in browser" with "open an edit modal" (a new `editmodal` Tauri window, QuickAdd-style) that can edit title/description/assignee/dates/priority/state and delete the item; move "open in browser" behind the row's right-click menu, a hover-only row icon, and the modal's own header button.

**Architecture:** A new always-running hidden Tauri window `editmodal` (same pattern as `quickadd`/`settings`: pre-created via `tauri.conf.json`, shown on demand). The sidebar calls a new `open_edit_modal` command which shows the window and emits a `load-item` event carrying `{projectId, itemId}`. `editmodal`'s frontend fetches full item detail via a new `get_work_item` command (needed because the sidebar's list data has no `description`/`start_date`), lets the user edit the same 7 fields QuickAdd creates with, and on save calls a new `update_work_item_fields` command that PATCHes only the fields that actually changed. Both `update_work_item_fields` and the existing `delete_work_item` command notify the sidebar to refresh via `app.emit_to("sidebar", "refresh-sidebar", ())` — a backend-to-frontend event, the same mechanism `lib.rs`'s global-shortcut handler already uses for `toggle-sidebar`, so no new IPC permissions are needed.

**Tech Stack:** TypeScript (Vite, vitest), Rust (Tauri 2, reqwest, wiremock for HTTP mocking), pnpm.

## Global Constraints

- No new UI framework or state library — keep the existing plain `let`/module-state + imperative DOM rebuild pattern used by `quickadd/main.ts` and `sidebar/main.ts`.
- `editmodal/main.ts` and `sidebar/main.ts` have no automated tests (no jsdom in `vite.config.ts`) — verify via `pnpm exec tsc --noEmit` plus an explicit manual run-through (stated per task, not skipped). Only pure helpers in `*/logic.ts` get vitest coverage.
- Rust command wrappers that just build a client and delegate to a `PlaneClient` method, or that only orchestrate without real branching logic, are untested by existing convention (e.g. `list_projects`, `list_members`, `open_edit_modal`). Functions with real logic — even inside `commands.rs` — get dedicated tests as **pure, synchronous functions** (see `assemble_sidebar`'s existing pattern): this plan follows that same split for `build_update_body` and `description_html_to_plain_text`.
- **Deviation from the spec's wording, by design:** the spec (`docs/superpowers/specs/2026-07-01-sidebar-edit-modal-design.md`) says to add `description_html`/`start_date` directly onto the existing `WorkItem` struct. This plan instead adds a separate `WorkItemDetail` struct dedicated to `get_work_item`'s response, so the widely-tested list/filter path (`WorkItem`, `filter_assigned_visible`, `list_work_items`) is never touched. Functionally equivalent to the spec's intent (full detail is always fetched fresh for the modal either way).
- **Deviation from the spec's wording, by design:** the spec describes the frontend calling `emitTo` to notify the sidebar. This plan instead has the **Rust commands themselves** call `app.emit_to("sidebar", "refresh-sidebar", ())` after a successful mutation — this reuses the exact pattern `lib.rs`'s global-shortcut handler already uses for `toggle-sidebar` and requires zero new capability permissions (a frontend-initiated `emitTo` would need a new `core:event:allow-emit-to` grant; a backend `AppHandle::emit_to` call needs none).
- The chip/popover UI (assignee/date/priority/state pickers) is **duplicated** into `editmodal/main.ts` rather than extracted into a shared module. `quickadd/main.ts` is being actively modified in a separate, concurrent session — sharing a module would risk merge conflicts with that work. Revisit extraction later once both features have landed.
- Spec: `docs/superpowers/specs/2026-07-01-sidebar-edit-modal-design.md`.

---

### Task 1: `description_html_to_plain_text` (Rust, pure function)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces: `pub fn description_html_to_plain_text(html: Option<&str>) -> String` — used by Task 2's `map_work_item_detail`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/plane_api.rs`, near the existing `plain_text_to_html_*` tests:

```rust
    #[test]
    fn description_html_to_plain_text_round_trips_our_own_output() {
        let html = plain_text_to_description_html("Line one\nLine two");
        assert_eq!(description_html_to_plain_text(Some(&html)), "Line one\nLine two");
    }

    #[test]
    fn description_html_to_plain_text_strips_foreign_tags() {
        assert_eq!(
            description_html_to_plain_text(Some("<p><strong>Bold</strong> text</p>")),
            "Bold text"
        );
    }

    #[test]
    fn description_html_to_plain_text_decodes_entities() {
        assert_eq!(description_html_to_plain_text(Some("<p>A &amp; B &lt;tag&gt;</p>")), "A & B <tag>");
    }

    #[test]
    fn description_html_to_plain_text_returns_empty_string_for_none_or_empty() {
        assert_eq!(description_html_to_plain_text(None), "");
        assert_eq!(description_html_to_plain_text(Some("")), "");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test description_html_to_plain_text`
Expected: FAIL to compile — `description_html_to_plain_text` is not defined.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/plane_api.rs`, right after `plain_text_to_description_html`/`escape_html`:

```rust
/// Converts Plane's `description_html` back into plain text for display in the
/// edit modal's textarea. This is a best-effort inverse of
/// `plain_text_to_description_html`: it round-trips content this app wrote itself
/// exactly, and degrades gracefully (strips tags, decodes common entities) for
/// richer HTML written by Plane's own web editor. No rich-text formatting is
/// preserved — this app only ever shows/edits plain text.
pub fn description_html_to_plain_text(html: Option<&str>) -> String {
    let html = match html {
        Some(h) if !h.is_empty() => h,
        _ => return String::new(),
    };
    let with_breaks = html
        .replace("</p>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("<br>", "\n");
    let stripped = strip_tags(&with_breaks);
    decode_entities(&stripped).trim().to_string()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&") // must run last, or "&amp;lt;" would double-decode into "<"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test description_html_to_plain_text`
Expected: PASS — all 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add description_html_to_plain_text for edit modal display"
```

---

### Task 2: `WorkItemDetail` + `PlaneClient::get_work_item` (Rust)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Consumes: `description_html_to_plain_text` (Task 1).
- Produces: `pub struct WorkItemDetail { pub id: String, pub name: String, pub description: String, pub assignee_ids: Vec<String>, pub start_date: Option<String>, pub target_date: Option<String>, pub priority: String, pub state_group: String, pub project_id: String }` and `PlaneClient::get_work_item(&self, project_id: &str, item_id: &str) -> Result<WorkItemDetail, String>` — used by Task 3's `get_work_item` command.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/plane_api.rs`, near `list_work_items_parses_expanded_state_and_assignees`:

```rust
    #[tokio::test]
    async fn get_work_item_parses_description_dates_and_assignees() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "i1", "name": "Fix bug", "priority": "high",
                "start_date": "2026-07-01",
                "target_date": "2026-07-05",
                "state": { "group": "started" },
                "assignees": [{ "id": "me" }],
                "description_html": "<p>Steps to repro</p>"
            })))
            .mount(&server)
            .await;

        let detail = client_for(&server).await.get_work_item("p1", "i1").await.unwrap();
        assert_eq!(detail.id, "i1");
        assert_eq!(detail.name, "Fix bug");
        assert_eq!(detail.description, "Steps to repro");
        assert_eq!(detail.assignee_ids, vec!["me".to_string()]);
        assert_eq!(detail.start_date.as_deref(), Some("2026-07-01"));
        assert_eq!(detail.target_date.as_deref(), Some("2026-07-05"));
        assert_eq!(detail.priority, "high");
        assert_eq!(detail.state_group, "started");
        assert_eq!(detail.project_id, "p1");
    }

    #[tokio::test]
    async fn get_work_item_defaults_description_to_empty_when_absent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i2/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "i2", "name": "No description yet", "priority": "none",
                "state": { "group": "backlog" },
                "assignees": []
            })))
            .mount(&server)
            .await;

        let detail = client_for(&server).await.get_work_item("p1", "i2").await.unwrap();
        assert_eq!(detail.description, "");
        assert_eq!(detail.start_date, None);
        assert!(detail.assignee_ids.is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test get_work_item`
Expected: FAIL to compile — `get_work_item` is not a method on `PlaneClient`.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/plane_api.rs`, add the `start_date` and `description_html` fields to `RawWorkItem` (existing struct, near the top of the file):

```rust
#[derive(Deserialize)]
struct RawWorkItem {
    id: String,
    name: String,
    #[serde(default = "priority_none")] priority: String,
    #[serde(default)] target_date: Option<String>,
    #[serde(default)] start_date: Option<String>,
    #[serde(default)] state: Option<RawState>,
    #[serde(default)] assignees: Vec<RawAssignee>,
    #[serde(default)] completed_at: Option<String>,
    #[serde(default)] description_html: Option<String>,
}
```

Add the new `WorkItemDetail` struct near the existing `WorkItem` struct (top of the file, after `CurrentUser`/`ProjectState`/`Member`):

```rust
#[derive(Debug, Clone)]
pub struct WorkItemDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub assignee_ids: Vec<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: String,
    pub state_group: String,
    pub project_id: String,
}
```

Add the mapping function right after the existing `map_work_item` function (near the bottom, before `#[cfg(test)]`):

```rust
fn map_work_item_detail(w: RawWorkItem, project_id: &str) -> WorkItemDetail {
    WorkItemDetail {
        id: w.id,
        name: w.name,
        description: description_html_to_plain_text(w.description_html.as_deref()),
        assignee_ids: w.assignees.into_iter().map(|a| a.id).collect(),
        start_date: w.start_date,
        target_date: w.target_date,
        priority: w.priority,
        state_group: w.state.map(|s| s.group).unwrap_or_default(),
        project_id: project_id.to_string(),
    }
}
```

Add the new method to `impl PlaneClient`, right after `list_work_items`:

```rust
    // A single item's detail response uses the same `expand=assignees,state`
    // shape as the list endpoint (nested state/assignee objects), unlike the
    // create endpoint's flat id strings — see the comment on create_work_item.
    pub async fn get_work_item(&self, project_id: &str, item_id: &str) -> Result<WorkItemDetail, String> {
        let url = format!(
            "{}/projects/{}/work-items/{}/?expand=assignees,state",
            self.ws_base(),
            project_id,
            item_id
        );
        let raw: RawWorkItem = self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(map_work_item_detail(raw, project_id))
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — full suite, including the 2 new tests and the existing `list_work_items_*` test (confirms the new `RawWorkItem` fields didn't break list parsing).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add get_work_item for fetching full issue detail"
```

---

### Task 3: `get_work_item` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `PlaneClient::get_work_item` (Task 2).
- Produces: `get_work_item(project_id: String, item_id: String) -> Result<WorkItemDetailDto, String>` Tauri command — used by Task 8's `getWorkItem` ipc wrapper.

Per the Global Constraints, this thin command wrapper (build client, delegate, map to a DTO) follows the existing convention of `list_projects`/`list_members` and isn't separately unit-tested.

- [ ] **Step 1: Add the DTO and command**

In `src-tauri/src/commands.rs`, add this struct after the existing `WorkItemDto`:

```rust
#[derive(Serialize)]
pub struct WorkItemDetailDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub assignee_ids: Vec<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: String,
    pub state_group: String,
    pub project_id: String,
}
```

Add this command after `list_members`:

```rust
#[tauri::command]
pub async fn get_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<WorkItemDetailDto, String> {
    let (client, _s) = client(&app)?;
    let d = client.get_work_item(&project_id, &item_id).await?;
    Ok(WorkItemDetailDto {
        id: d.id,
        name: d.name,
        description: d.description,
        assignee_ids: d.assignee_ids,
        start_date: d.start_date,
        target_date: d.target_date,
        priority: d.priority,
        state_group: d.state_group,
        project_id: d.project_id,
    })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors. `get_work_item` isn't registered in `lib.rs`'s `invoke_handler!` yet (Task 7), so it isn't reachable from the frontend yet — that's expected at this point.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: add get_work_item Tauri command"
```

---

### Task 4: `build_update_body` (Rust, pure function)

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `pub fn build_update_body(name: Option<&str>, description_html: Option<&str>, assignee_ids: Option<&[String]>, start_date: Option<&str>, target_date: Option<&str>, priority: Option<&str>, state_id: Option<&str>) -> serde_json::Value` — used by Task 5's `update_work_item_fields` command.

This is real branching logic (which fields to include), so per the Global Constraints it gets its own unit tests as a pure function — the same treatment `assemble_sidebar` already gets in this file.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/commands.rs`, after the existing `assemble_includes_items_completed_within_the_window` test:

```rust
    #[test]
    fn build_update_body_includes_only_provided_fields() {
        let body = build_update_body(Some("New title"), None, None, None, None, None, None);
        assert_eq!(body, serde_json::json!({ "name": "New title" }));
    }

    #[test]
    fn build_update_body_includes_all_fields_when_all_provided() {
        let assignees = vec!["u1".to_string()];
        let body = build_update_body(
            Some("Title"),
            Some("<p>Desc</p>"),
            Some(&assignees),
            Some("2026-07-01"),
            Some("2026-07-05"),
            Some("high"),
            Some("state-1"),
        );
        assert_eq!(
            body,
            serde_json::json!({
                "name": "Title",
                "description_html": "<p>Desc</p>",
                "assignees": ["u1"],
                "start_date": "2026-07-01",
                "target_date": "2026-07-05",
                "priority": "high",
                "state": "state-1",
            })
        );
    }

    #[test]
    fn build_update_body_returns_empty_object_when_nothing_provided() {
        let body = build_update_body(None, None, None, None, None, None, None);
        assert_eq!(body, serde_json::json!({}));
    }

    #[test]
    fn build_update_body_includes_empty_assignee_list_to_unassign() {
        // Regression guard: unlike create_issue (where an empty assignee list means
        // "default to the current user"), editing must send an explicitly empty list
        // through as-is — the user may genuinely want to unassign everyone.
        let empty: Vec<String> = vec![];
        let body = build_update_body(None, None, Some(&empty), None, None, None, None);
        assert_eq!(body, serde_json::json!({ "assignees": [] }));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test build_update_body`
Expected: FAIL to compile — `build_update_body` is not defined.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/commands.rs`, right after `assemble_sidebar`:

```rust
pub fn build_update_body(
    name: Option<&str>,
    description_html: Option<&str>,
    assignee_ids: Option<&[String]>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    priority: Option<&str>,
    state_id: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    if let Some(n) = name {
        body.insert("name".into(), serde_json::json!(n));
    }
    if let Some(d) = description_html {
        body.insert("description_html".into(), serde_json::json!(d));
    }
    if let Some(a) = assignee_ids {
        body.insert("assignees".into(), serde_json::json!(a));
    }
    if let Some(sd) = start_date {
        body.insert("start_date".into(), serde_json::json!(sd));
    }
    if let Some(td) = target_date {
        body.insert("target_date".into(), serde_json::json!(td));
    }
    if let Some(p) = priority {
        body.insert("priority".into(), serde_json::json!(p));
    }
    if let Some(sid) = state_id {
        body.insert("state".into(), serde_json::json!(sid));
    }
    serde_json::Value::Object(body)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test build_update_body`
Expected: PASS — all 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: add build_update_body for diff-based work item PATCH bodies"
```

---

### Task 5: `update_work_item_fields` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `build_update_body` (Task 4), `plain_text_to_description_html`, `resolve_state_id`, `PlaneClient::update_work_item`, `PlaneClient::list_states` (all existing).
- Produces: `update_work_item_fields(project_id: String, item_id: String, name: Option<String>, description: Option<String>, assignee_ids: Option<Vec<String>>, start_date: Option<String>, target_date: Option<String>, priority: Option<String>, state_group: Option<String>) -> Result<(), String>` — used by Task 8's `updateWorkItemFields` ipc wrapper.

Thin orchestration around already-tested pieces (`build_update_body`, `plain_text_to_description_html`, `resolve_state_id`) — per the Global Constraints, not separately unit-tested; verified via `cargo check` here and the manual run-through in Task 14.

- [ ] **Step 1: Add the `Emitter` import**

In `src-tauri/src/commands.rs`, change the first line:

```rust
use crate::config;
```

to:

```rust
use crate::config;
use tauri::Emitter;
```

- [ ] **Step 2: Add the command**

Add to `src-tauri/src/commands.rs`, right after `update_work_item_state`:

```rust
#[tauri::command]
pub async fn update_work_item_fields(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    name: Option<String>,
    description: Option<String>,
    assignee_ids: Option<Vec<String>>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: Option<String>,
    state_group: Option<String>,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let description_html = description.as_deref().map(plain_text_to_description_html);
    let state_id = match &state_group {
        Some(sg) => {
            let states = client.list_states(&project_id).await?;
            Some(resolve_state_id(&states, sg).ok_or_else(|| format!("no state found for group '{sg}'"))?)
        }
        None => None,
    };
    let body = build_update_body(
        name.as_deref(),
        description_html.as_deref(),
        assignee_ids.as_deref(),
        start_date.as_deref(),
        target_date.as_deref(),
        priority.as_deref(),
        state_id.as_deref(),
    );
    if body.as_object().is_some_and(|m| m.is_empty()) {
        return Ok(());
    }
    client.update_work_item(&project_id, &item_id, body).await?;
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
    Ok(())
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: add update_work_item_fields command with diff-based PATCH"
```

---

### Task 6: `delete_work_item` refresh notification + `open_edit_modal` command

**Files:**
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `open_edit_modal(project_id: String, item_id: String)` Tauri command — used by Task 8's `openEditModal` ipc wrapper and Task 13's sidebar row click handler.

- [ ] **Step 1: Add the `Manager` import**

In `src-tauri/src/commands.rs`, change:

```rust
use crate::config;
use tauri::Emitter;
```

to:

```rust
use crate::config;
use tauri::{Emitter, Manager};
```

- [ ] **Step 2: Emit `refresh-sidebar` after a successful delete**

In `src-tauri/src/commands.rs`, change:

```rust
#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client.delete_work_item(&project_id, &item_id).await
}
```

to:

```rust
#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client.delete_work_item(&project_id, &item_id).await?;
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
    Ok(())
}
```

- [ ] **Step 3: Add the `open_edit_modal` command**

Add to `src-tauri/src/commands.rs`, right after `get_work_item` (Task 3):

```rust
#[tauri::command]
pub fn open_edit_modal(app: tauri::AppHandle, project_id: String, item_id: String) {
    if let Some(win) = app.get_webview_window("editmodal") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to(
        "editmodal",
        "load-item",
        serde_json::json!({ "projectId": project_id, "itemId": item_id }),
    );
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: notify sidebar on delete, add open_edit_modal command"
```

---

### Task 7: Register commands, add the `editmodal` window

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`

- [ ] **Step 1: Register the 3 new commands**

In `src-tauri/src/lib.rs`, change:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
            commands::update_work_item_priority,
            commands::update_work_item_state,
            commands::delete_work_item
        ])
```

to:

```rust
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
            commands::open_edit_modal
        ])
```

- [ ] **Step 2: Add the `editmodal` window**

In `src-tauri/tauri.conf.json`, change:

```json
      {
        "label": "settings",
        "url": "src/settings/index.html",
        "width": 460, "height": 420,
        "decorations": true, "skipTaskbar": false, "visible": false, "resizable": false
      }
    ],
```

to:

```json
      {
        "label": "settings",
        "url": "src/settings/index.html",
        "width": 460, "height": 420,
        "decorations": true, "skipTaskbar": false, "visible": false, "resizable": false
      },
      {
        "label": "editmodal",
        "url": "src/editmodal/index.html",
        "width": 480, "height": 320,
        "decorations": false, "transparent": true, "alwaysOnTop": true,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": true
      }
    ],
```

- [ ] **Step 3: Grant `editmodal` the same window capabilities as the other windows**

In `src-tauri/capabilities/default.json`, change:

```json
  "description": "Permissions for the quickadd, sidebar, and settings windows",
  "windows": ["quickadd", "sidebar", "settings"],
```

to:

```json
  "description": "Permissions for the quickadd, sidebar, settings, and editmodal windows",
  "windows": ["quickadd", "sidebar", "settings", "editmodal"],
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors (the `editmodal` window references `src/editmodal/index.html`, which doesn't exist yet — that's fine, `tauri.conf.json`'s window list doesn't need the file to exist for `cargo check` to pass; it's only needed at bundle/dev-server time, added in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat: register edit-modal commands and window"
```

---

### Task 8: `shared/types.ts` + `shared/ipc.ts` additions

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`

**Interfaces:**
- Produces: `WorkItemDetail` type, `getWorkItem`, `updateWorkItemFields`, `openEditModal`, `UpdateWorkItemFields` — used by Task 12's `editmodal/main.ts` and Task 13's `sidebar/main.ts`.

- [ ] **Step 1: Add the `WorkItemDetail` type**

In `src/shared/types.ts`, add this interface right after the existing `WorkItem` interface:

```ts
export interface WorkItemDetail {
  id: string; name: string; description: string;
  assignee_ids: string[];
  start_date: string | null; target_date: string | null;
  priority: string; state_group: string; project_id: string;
}
```

- [ ] **Step 2: Add the ipc wrappers**

In `src/shared/ipc.ts`, change the top import:

```ts
import type { SidebarData, SettingsDto, Project, Member } from "./types";
```

to:

```ts
import type { SidebarData, SettingsDto, Project, Member, WorkItemDetail } from "./types";
```

Add these exports at the end of `src/shared/ipc.ts`, after `deleteWorkItem`:

```ts
export const getWorkItem = (project_id: string, item_id: string) =>
  invoke<WorkItemDetail>("get_work_item", { projectId: project_id, itemId: item_id });

export interface UpdateWorkItemFields {
  name?: string;
  description?: string;
  assignee_ids?: string[];
  start_date?: string;
  target_date?: string;
  priority?: string;
  state_group?: string;
}

export const updateWorkItemFields = (project_id: string, item_id: string, fields: UpdateWorkItemFields) =>
  invoke<void>("update_work_item_fields", {
    projectId: project_id,
    itemId: item_id,
    name: fields.name,
    description: fields.description,
    assigneeIds: fields.assignee_ids,
    startDate: fields.start_date,
    targetDate: fields.target_date,
    priority: fields.priority,
    stateGroup: fields.state_group,
  });

export const openEditModal = (project_id: string, item_id: string) =>
  invoke<void>("open_edit_modal", { projectId: project_id, itemId: item_id });
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat: add WorkItemDetail type and edit-modal ipc wrappers"
```

---

### Task 9: `EXTERNAL_LINK_ICON`

**Files:**
- Modify: `src/shared/planeIcons.ts`

**Interfaces:**
- Produces: `EXTERNAL_LINK_ICON: string` — used by Task 13's row hover button.

- [ ] **Step 1: Add the icon**

In `src/shared/planeIcons.ts`, add this export right after `FLAG_ICON`:

```ts
export const EXTERNAL_LINK_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/planeIcons.ts
git commit -m "feat: add external-link icon for row/modal browser buttons"
```

---

### Task 10: `shared/app.css` additions

**Files:**
- Modify: `src/shared/app.css`

- [ ] **Step 1: Add the edit-modal and row-hover-icon styles**

In `src/shared/app.css`, add this block at the end of the file, after the `.settings button:hover` rule:

```css

/* ============ SURFACE 4: EDIT MODAL ============ */
.editmodal {
  width: 480px; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow); color: var(--text); overflow: visible;
}
.em-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.em-title { font-size: 14px; font-weight: 600; }
.em-browser-btn {
  margin-left: auto; background: transparent; border: 1px solid var(--border); border-radius: 7px;
  color: var(--muted); font-size: 12px; padding: 5px 10px; cursor: pointer; font-family: inherit;
}
.em-browser-btn:hover { border-color: var(--accent); color: var(--text); }
.em-close { background: transparent; border: none; color: var(--muted); font-size: 14px; cursor: pointer; padding: 4px; line-height: 1; }
.em-close:hover { color: var(--text); }
.em-loading { padding: 30px 18px; text-align: center; color: var(--muted); font-size: 13px; margin: 0; }
.em-form .title-input { width: 100%; font-size: 16px; }
.em-error { color: var(--red); font-size: 12px; margin: 0; padding: 0 18px 12px; }
.em-foot {
  position: relative; display: flex; align-items: center;
  padding: 12px 18px; border-top: 1px solid var(--border); background: var(--panel-2);
  border-radius: 0 0 var(--radius) var(--radius);
}
.em-delete { background: transparent; border: none; color: var(--red); font-size: 12.5px; cursor: pointer; padding: 6px 4px; font-family: inherit; }
.em-delete:hover { text-decoration: underline; }
.em-delete-confirm { position: absolute; bottom: 100%; left: 18px; margin-bottom: 6px; width: 170px; }
.em-foot-right { margin-left: auto; display: flex; gap: 8px; }
.em-btn { padding: 7px 16px; border-radius: 8px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
.em-btn-primary { background: var(--accent); color: #fff; border: none; }
.em-btn-primary:hover { opacity: 0.85; }
.em-btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }

/* sidebar row hover "open in browser" icon */
.row-browser-btn { margin-left: auto; opacity: 0; transition: opacity .1s; }
.task:hover .row-browser-btn { opacity: 1; }
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/app.css
git commit -m "feat: add edit-modal and row hover-icon styles"
```

---

### Task 11: `vite.config.ts` — add the `editmodal` build entry

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Add the entry**

In `vite.config.ts`, change:

```ts
      input: {
        quickadd: resolve(__dirname, "src/quickadd/index.html"),
        sidebar: resolve(__dirname, "src/sidebar/index.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
      },
```

to:

```ts
      input: {
        quickadd: resolve(__dirname, "src/quickadd/index.html"),
        sidebar: resolve(__dirname, "src/sidebar/index.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
        editmodal: resolve(__dirname, "src/editmodal/index.html"),
      },
```

- [ ] **Step 2: Commit**

```bash
git add vite.config.ts
git commit -m "feat: add editmodal to the vite build entries"
```

(This task's change has no effect until Task 12 creates `src/editmodal/index.html` — committed separately here to keep config changes isolated from the large frontend addition.)

---

### Task 12: `src/editmodal/index.html` + `src/editmodal/main.ts`

**Files:**
- Create: `src/editmodal/index.html`, `src/editmodal/main.ts`

**Interfaces:**
- Consumes: `getWorkItem`, `updateWorkItemFields`, `deleteWorkItem`, `getSettings`, `listMembers`, `UpdateWorkItemFields` (Task 8, `src/shared/ipc.ts`), `buildIssueUrl` (existing, `src/sidebar/logic.ts`), `WorkItemDetail`, `Member` (Task 8, `src/shared/types.ts`), `PRIORITY_ORDER`, `STATE_ORDER`, `priorityIcon`, `priorityLabel`, `stateIcon`, `stateLabel`, `CALENDAR_ICON`, `FLAG_ICON` (existing, `src/shared/planeIcons.ts`), `DATE_PRESETS`, `resolveDatePreset` (existing, `src/shared/datePresets.ts`), `applyTheme` (existing, `src/shared/theme.ts`).

No jsdom in this project, so this task has no automated UI test. Verify via `tsc` plus the manual run-through in Task 14.

- [ ] **Step 1: Create `src/editmodal/index.html`**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>할 일 수정</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <div class="editmodal">
      <div class="em-head">
        <strong class="em-title">할 일 수정</strong>
        <button type="button" class="em-browser-btn" id="emBrowserBtn">🌐 브라우저에서 열기</button>
        <button type="button" class="em-close" id="emClose">✕</button>
      </div>
      <p class="em-loading" id="emLoading">불러오는 중…</p>
      <div class="em-form" id="emForm" hidden>
        <div class="popup-top">
          <input id="emTitleInput" class="title-input" placeholder="제목" />
        </div>
        <textarea id="emDescription" class="description-input" placeholder="설명을 입력하세요…" rows="4"></textarea>
        <div class="chip-row" id="emChipRow">
          <button type="button" class="chip" id="emChipAssignee"></button>
          <button type="button" class="chip" id="emChipStart"></button>
          <button type="button" class="chip" id="emChipDue"></button>
          <button type="button" class="chip" id="emChipState"></button>
          <button type="button" class="chip" id="emChipPriority"></button>
          <div id="emFieldPopover" class="field-popover" hidden></div>
        </div>
        <p class="em-error" id="emError" hidden></p>
      </div>
      <div class="em-foot">
        <button type="button" class="em-delete" id="emDelete">삭제</button>
        <div class="pop em-delete-confirm" id="emDeleteConfirm" hidden>
          <div class="pop-msg">정말 삭제하시겠습니까?</div>
          <div class="popover-divider"></div>
          <div class="pop-item" id="emDeleteConfirmYes">삭제</div>
          <div class="pop-item" id="emDeleteConfirmNo">취소</div>
        </div>
        <div class="em-foot-right">
          <button type="button" class="em-btn em-btn-ghost" id="emCancel">취소</button>
          <button type="button" class="em-btn em-btn-primary" id="emSave">저장</button>
        </div>
      </div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/editmodal/main.ts`**

```ts
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { deleteWorkItem, getSettings, getWorkItem, listMembers, updateWorkItemFields, type UpdateWorkItemFields } from "../shared/ipc";
import { buildIssueUrl } from "../sidebar/logic";
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from "../shared/datePresets";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import type { Member, WorkItemDetail } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const modalEl = document.querySelector(".editmodal") as HTMLElement;
const emBrowserBtn = document.getElementById("emBrowserBtn")!;
const emClose = document.getElementById("emClose")!;
const emLoading = document.getElementById("emLoading")!;
const emForm = document.getElementById("emForm")!;
const emTitleInput = document.getElementById("emTitleInput") as HTMLInputElement;
const emDescription = document.getElementById("emDescription") as HTMLTextAreaElement;
const emChipAssignee = document.getElementById("emChipAssignee")!;
const emChipStart = document.getElementById("emChipStart")!;
const emChipDue = document.getElementById("emChipDue")!;
const emChipState = document.getElementById("emChipState")!;
const emChipPriority = document.getElementById("emChipPriority")!;
const emFieldPopover = document.getElementById("emFieldPopover")!;
const emError = document.getElementById("emError")!;
const emDelete = document.getElementById("emDelete")!;
const emDeleteConfirm = document.getElementById("emDeleteConfirm")!;
const emDeleteConfirmYes = document.getElementById("emDeleteConfirmYes")!;
const emDeleteConfirmNo = document.getElementById("emDeleteConfirmNo")!;
const emCancel = document.getElementById("emCancel")!;
const emSave = document.getElementById("emSave")!;

let baseUrl = "";
let workspace = "";
let projectId = "";
let itemId = "";
let original: WorkItemDetail | null = null;
let members: Member[] = [];
let membersLoadedForProject: string | null = null;

let assigneeIds: string[] = [];
type DateChoice = DatePresetKey | "custom";
let startChoice: DateChoice = "custom";
let startCustomDate = "";
let dueChoice: DateChoice = "custom";
let dueCustomDate = "";
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";

type PopoverKind = "assignee" | "start" | "due" | "priority" | "state" | null;
let openPopover: PopoverKind = null;

// Same "measure the real box" approach as QuickAdd's resizeToFit — see
// src/quickadd/main.ts for why this beats guessing pixel constants.
function resizeToFit() {
  let height = Math.ceil(modalEl.getBoundingClientRect().height);
  if (openPopover && !emFieldPopover.hidden) {
    height = Math.max(height, Math.ceil(emFieldPopover.getBoundingClientRect().bottom));
  }
  height += 4;
  win.setSize(new LogicalSize(480, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

function dateChoiceLabel(choice: DateChoice, custom: string): string {
  if (choice === "custom") return custom || "날짜 선택";
  return DATE_PRESETS.find((d) => d.key === choice)!.label;
}

function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}

function renderAssigneeChip() {
  emChipAssignee.textContent = "";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  let label: string;
  if (assigneeIds.length === 0) {
    // Unlike QuickAdd (where an empty selection defaults to "me" at creation
    // time), an edited item can genuinely have nobody assigned — say so.
    avatar.textContent = "-";
    label = "담당자 없음";
  } else if (assigneeIds.length === 1) {
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    avatar.textContent = name.slice(0, 1);
    label = name;
  } else {
    avatar.textContent = String(assigneeIds.length);
    label = `${assigneeIds.length}명`;
  }
  emChipAssignee.appendChild(avatar);
  emChipAssignee.appendChild(document.createTextNode(" " + label));
}

function renderChips() {
  renderAssigneeChip();
  emChipStart.innerHTML = `${CALENDAR_ICON} ${dateChoiceLabel(startChoice, startCustomDate)}`;
  emChipDue.innerHTML = `${FLAG_ICON} ${dateChoiceLabel(dueChoice, dueCustomDate)}`;
  emChipPriority.innerHTML =
    `${priorityIcon(priority)} <span class="${priority === "none" ? "muted" : ""}">${priorityLabel(priority)}</span>`;
  emChipState.innerHTML = `${stateIcon(stateGroup)} ${stateLabel(stateGroup)}`;
}

function closePopover() {
  openPopover = null;
  emFieldPopover.hidden = true;
  emFieldPopover.innerHTML = "";
  resizeToFit();
}

function toggleAssignee(id: string | null) {
  if (id === null) {
    assigneeIds = [];
  } else if (assigneeIds.includes(id)) {
    assigneeIds = assigneeIds.filter((x) => x !== id);
  } else {
    assigneeIds = [...assigneeIds, id];
  }
  renderChips();
  renderAssigneePopoverItems();
}

function renderAssigneePopoverItems() {
  emFieldPopover.innerHTML = "";
  const noneItem = document.createElement("div");
  noneItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  noneItem.textContent = "담당자 없음";
  noneItem.onclick = () => toggleAssignee(null);
  emFieldPopover.appendChild(noneItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
    emFieldPopover.appendChild(item);
  }
}

async function openAssigneePopover() {
  if (!projectId) return;
  if (membersLoadedForProject !== projectId) {
    try {
      members = await listMembers(projectId);
      membersLoadedForProject = projectId;
    } catch (err) {
      members = [];
      console.error("listMembers failed:", err);
    }
  }
  renderAssigneePopoverItems();
  emFieldPopover.hidden = false;
  openPopover = "assignee";
  resizeToFit();
}

function openDatePopover(kind: "start" | "due") {
  emFieldPopover.innerHTML = "";
  const current = kind === "start" ? startChoice : dueChoice;
  for (const preset of DATE_PRESETS) {
    const item = document.createElement("div");
    item.className = "dd-item" + (preset.key === current ? " sel" : "");
    item.textContent = preset.label;
    item.onclick = () => {
      if (kind === "start") startChoice = preset.key;
      else dueChoice = preset.key;
      renderChips();
      closePopover();
    };
    emFieldPopover.appendChild(item);
  }
  const divider = document.createElement("div");
  divider.className = "popover-divider";
  emFieldPopover.appendChild(divider);
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "popover-date-input";
  if (current === "custom") {
    dateInput.value = kind === "start" ? startCustomDate : dueCustomDate;
  }
  dateInput.onchange = () => {
    if (!dateInput.value) return;
    if (kind === "start") {
      startChoice = "custom";
      startCustomDate = dateInput.value;
    } else {
      dueChoice = "custom";
      dueCustomDate = dateInput.value;
    }
    renderChips();
    closePopover();
  };
  emFieldPopover.appendChild(dateInput);
  emFieldPopover.hidden = false;
  openPopover = kind;
  resizeToFit();
}

function openPriorityPopover() {
  emFieldPopover.innerHTML = "";
  for (const p of PRIORITY_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (p === priority ? " sel" : "");
    item.innerHTML = `${priorityIcon(p)} ${priorityLabel(p)}`;
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
    };
    emFieldPopover.appendChild(item);
  }
  emFieldPopover.hidden = false;
  openPopover = "priority";
  resizeToFit();
}

function openStatePopover() {
  emFieldPopover.innerHTML = "";
  for (const g of STATE_ORDER) {
    const item = document.createElement("div");
    item.className = "dd-item" + (g === stateGroup ? " sel" : "");
    item.innerHTML = `${stateIcon(g)} ${stateLabel(g)}`;
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
    };
    emFieldPopover.appendChild(item);
  }
  emFieldPopover.hidden = false;
  openPopover = "state";
  resizeToFit();
}

emChipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
emChipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
emChipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
emChipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
emChipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };

async function loadItem(pid: string, iid: string) {
  projectId = pid;
  itemId = iid;
  original = null;
  members = [];
  membersLoadedForProject = null;
  closePopover();
  emDeleteConfirm.hidden = true;
  emError.hidden = true;
  emTitleInput.classList.remove("error");
  emForm.hidden = true;
  emLoading.hidden = false;
  emLoading.textContent = "불러오는 중…";
  resizeToFit();
  try {
    const detail = await getWorkItem(pid, iid);
    original = detail;
    emTitleInput.value = detail.name;
    emDescription.value = detail.description;
    assigneeIds = [...detail.assignee_ids];
    // Always initialize as "custom" showing the loaded date literally — the
    // preset chips (오늘/내일/다음 주) remain clickable if the user wants to
    // switch to a relative date, but there's no "existing value" concept for
    // presets, unlike QuickAdd's always-fresh "오늘" default.
    startChoice = "custom";
    startCustomDate = detail.start_date ?? "";
    dueChoice = "custom";
    dueCustomDate = detail.target_date ?? "";
    priority = detail.priority as Priority;
    stateGroup = detail.state_group as StateGroup;
    renderChips();
    emLoading.hidden = true;
    emForm.hidden = false;
    resizeToFit();
    emTitleInput.focus();
  } catch (err) {
    emLoading.textContent = "불러오기 실패: " + err;
    console.error("getWorkItem failed:", err);
  }
}

function closeModal() {
  closePopover();
  emDeleteConfirm.hidden = true;
  win.hide();
}

async function openInBrowser() {
  if (!projectId || !itemId) return;
  const url = buildIssueUrl(baseUrl, workspace, projectId, itemId);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the modal instead of behind it — same fix as the
    // sidebar's openInBrowser.
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    console.error("openUrl failed:", url, err);
  }
}

async function save() {
  if (!original) return;
  const name = emTitleInput.value.trim();
  if (!name) {
    emTitleInput.classList.add("error");
    emTitleInput.focus();
    return;
  }
  const description = emDescription.value;
  const startDate = resolveDateChoice(startChoice, startCustomDate);
  const dueDate = resolveDateChoice(dueChoice, dueCustomDate);

  const fields: UpdateWorkItemFields = {};
  if (name !== original.name) fields.name = name;
  if (description !== original.description) fields.description = description;
  const sortedCurrent = [...assigneeIds].sort();
  const sortedOriginal = [...original.assignee_ids].sort();
  if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedOriginal)) fields.assignee_ids = assigneeIds;
  if (startDate && startDate !== (original.start_date ?? "")) fields.start_date = startDate;
  if (dueDate && dueDate !== (original.target_date ?? "")) fields.target_date = dueDate;
  if (priority !== original.priority) fields.priority = priority;
  if (stateGroup !== original.state_group) fields.state_group = stateGroup;

  if (Object.keys(fields).length === 0) {
    await win.hide();
    return;
  }

  emError.hidden = true;
  try {
    await updateWorkItemFields(projectId, itemId, fields);
    await win.hide();
  } catch (err) {
    emError.hidden = false;
    emError.textContent = "저장 실패: " + err;
    console.error("updateWorkItemFields failed:", err);
    resizeToFit();
  }
}

emClose.onclick = closeModal;
emCancel.onclick = closeModal;
emSave.onclick = save;
emBrowserBtn.onclick = openInBrowser;

emDelete.onclick = () => {
  emDeleteConfirm.hidden = false;
  resizeToFit();
};
emDeleteConfirmNo.onclick = () => {
  emDeleteConfirm.hidden = true;
  resizeToFit();
};
emDeleteConfirmYes.onclick = async () => {
  try {
    await deleteWorkItem(projectId, itemId);
    await win.hide();
  } catch (err) {
    emDeleteConfirm.hidden = true;
    emError.hidden = false;
    emError.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
    resizeToFit();
  }
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openPopover) {
      closePopover();
      return;
    }
    if (!emDeleteConfirm.hidden) {
      emDeleteConfirm.hidden = true;
      resizeToFit();
      return;
    }
    closeModal();
    return;
  }
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    save();
  }
});

win.listen<{ projectId: string; itemId: string }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId);
});

async function loadSettings() {
  const s = await getSettings();
  baseUrl = s.base_url;
  workspace = s.workspace;
  applyTheme(s.theme);
}

resizeToFit();
loadSettings();
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/editmodal/index.html src/editmodal/main.ts
git commit -m "feat: add editmodal window frontend"
```

---

### Task 13: Wire the sidebar row to the modal + hover browser icon

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `openEditModal` (Task 8), `EXTERNAL_LINK_ICON` (Task 9).

No automated UI test (same reasoning as Task 12) — verify via `tsc` plus the manual run-through in Task 14.

- [ ] **Step 1: Import `openEditModal` and `EXTERNAL_LINK_ICON`**

In `src/sidebar/main.ts`, change:

```ts
import { createIssue, deleteWorkItem, fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

to:

```ts
import { createIssue, deleteWorkItem, fetchSidebarData, getSettings, openEditModal, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

Change:

```ts
import { priorityIcon, priorityColor, stateIcon } from "../shared/planeIcons";
```

to:

```ts
import { priorityIcon, priorityColor, stateIcon, EXTERNAL_LINK_ICON } from "../shared/planeIcons";
```

- [ ] **Step 2: Stop double-refreshing on delete**

`delete_work_item` now emits `refresh-sidebar` itself (Task 6) — the row's own `.then(refresh)` would trigger a second, redundant fetch. In `src/sidebar/main.ts`, change:

```ts
async function deleteWorkItemAction(it: WorkItem) {
  try {
    await deleteWorkItem(it.project_id, it.id);
    await refresh();
  } catch (err) {
    synced.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
  }
}
```

to:

```ts
async function deleteWorkItemAction(it: WorkItem) {
  try {
    await deleteWorkItem(it.project_id, it.id);
  } catch (err) {
    synced.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
  }
}
```

- [ ] **Step 3: Add the hover browser-icon button and switch the row click to open the modal**

In `renderTaskRow`, change:

```ts
  body.appendChild(meta);
  el.appendChild(body);

  el.onclick = () => openInBrowser(it);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(it, e.clientX, e.clientY);
  };

  return el;
}
```

to:

```ts
  body.appendChild(meta);
  el.appendChild(body);

  const browserBtn = document.createElement("span");
  browserBtn.className = "icon-btn row-browser-btn";
  browserBtn.title = "브라우저에서 열기";
  browserBtn.innerHTML = EXTERNAL_LINK_ICON;
  browserBtn.onclick = (e) => {
    e.stopPropagation();
    openInBrowser(it);
  };
  el.appendChild(browserBtn);

  el.onclick = () => openEditModal(it.project_id, it.id);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(it, e.clientX, e.clientY);
  };

  return el;
}
```

- [ ] **Step 4: Listen for `refresh-sidebar`**

Change:

```ts
win.listen("tauri://focus", refresh);
win.listen("tauri://blur", () => {
  if (!pinned) slideOut();
});
```

to:

```ts
win.listen("tauri://focus", refresh);
win.listen("refresh-sidebar", refresh);
win.listen("tauri://blur", () => {
  if (!pinned) slideOut();
});
```

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/main.ts
git commit -m "feat(sidebar): open edit modal on row click, add hover browser icon"
```

---

### Task 14: Full build + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS — full suite, including every test added in Tasks 1, 2, and 4.

- [ ] **Step 2: Run the TypeScript test suite and type-check**

Run: `pnpm test`
Expected: PASS — existing `sidebar/logic.test.ts` (and any other suites) unaffected.

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the production build**

Run: `pnpm build`
Expected: succeeds, and `dist/` contains an `editmodal` bundle (confirms Task 11's Vite entry wired up correctly).

- [ ] **Step 4: Manual run-through**

Run: `pnpm tauri dev`, sign in to a real (or test) Plane workspace via the settings window, open the sidebar, and walk through:

- **Open the modal:** click a task row. Expected: `editmodal` appears centered, shows "불러오는 중…" briefly, then the form with the row's actual title/description/assignee/dates/priority/state.
- **Edit and save:** change the title and description, toggle the assignee, change priority and state, then click 저장 (or `Ctrl+Enter`). Expected: modal closes, and the sidebar list updates without manually clicking the refresh button (confirms the `refresh-sidebar` event round-trip from `update_work_item_fields`).
- **Reopen and confirm persistence:** click the same row again. Expected: the new title/description/assignee/priority/state are shown (confirms the PATCH actually reached Plane and `get_work_item` reads it back correctly).
- **Cancel discards:** open the modal, change the title, press `Esc` (or click ✕/취소). Expected: modal closes with no changes sent — reopening the row shows the original title.
- **No-op save:** open the modal, change nothing, click 저장. Expected: modal closes without error (confirms the empty-diff short-circuit — no network error, no needless PATCH visible in Plane's own activity log if you have access to check).
- **Delete from the modal:** open the modal for a disposable test item, click 삭제, confirm. Expected: confirm popover appears, confirming deletes the item and closes the modal, and the sidebar list drops it automatically.
- **Browser-open, 3 paths, none close the modal:**
  - Right-click a row → "새 탭에서 열기" still opens the browser (unchanged from before this feature).
  - Hover a row (don't click) → a small external-link icon fades in on the right; click it → opens the browser, modal does *not* open.
  - Open the edit modal → click "🌐 브라우저에서 열기" in the header → opens the browser, modal stays open.
- **Save failure surfaces inline:** temporarily disconnect network or use an invalid item id (e.g. via devtools) to force a failure, and confirm the modal shows an inline error message and stays open (does not silently close).
- **Blur behavior:** open the modal, then click on another application window. Expected: the modal stays open (does not auto-hide, unlike the sidebar).

- [ ] **Step 5: Report results**

Summarize pass/fail for each bullet above. If anything fails, fix it in the relevant earlier task's files and re-run the specific failing check before considering the plan complete.
