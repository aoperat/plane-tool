use crate::config;
use tauri::{Emitter, Manager};
use crate::plane_api::{self, filter_assigned_visible, plain_text_to_description_html, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
use serde::{Serialize, Deserialize};
use crate::assign_watch;

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
    pub idle_open_enabled: bool,
    pub idle_open_minutes: u32,
    pub has_openai_key: bool,
    pub briefing_model: String,
    pub morning_briefing_enabled: bool,
    pub morning_briefing_time: String,
    pub assign_notify_enabled: bool,
    pub assign_remind_hours: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDto { pub id: String, pub name: String, pub identifier: String }

#[derive(Serialize)]
pub struct MemberDto { pub id: String, pub display_name: String, pub is_me: bool }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub assignee_ids: Vec<String>,
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    pub states: Vec<StateDto>,
    /// 캐시(오프라인 폴백)에서 온 응답이면 true. 실시간 fetch 결과는 항상
    /// false. `skip`은 쓰지 않는다 — Tauri IPC 직렬화도 serde를 거치므로
    /// skip하면 프론트엔드에도 이 값이 전달되지 않아 오프라인 배지가 깨진다
    /// (캐시 파일에 저장돼도 항상 false/None으로 재구성되므로 무해하다).
    #[serde(default)]
    pub is_cached: bool,
    #[serde(default)]
    pub cached_at_ms: Option<u64>,
}

pub fn assemble_sidebar(
    user_id: &str,
    projects: Vec<Project>,
    items: Vec<WorkItem>,
    states: Vec<ProjectState>,
    completed_after: &str,
    completed_before: &str,
) -> SidebarData {
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            start_date: w.start_date,
            state_group: w.state_group, project_id: w.project_id,
            assignee_ids: w.assignee_ids,
            completed_at: w.completed_at,
            created_at: w.created_at, updated_at: w.updated_at,
        })
        .collect();
    let projects = projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect();
    let states = states
        .into_iter()
        .map(|s| StateDto { id: s.id, group: s.group, project_id: s.project_id, default: s.default })
        .collect();
    SidebarData { projects, assigned, states, is_cached: false, cached_at_ms: None }
}

/// 캐시에서 돌려주는 응답임을 표시한다 — 실시간 fetch 결과에는 호출하지 않는다.
pub fn mark_from_cache(data: &mut SidebarData, cached_at_ms: u64) {
    data.is_cached = true;
    data.cached_at_ms = Some(cached_at_ms);
}

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
        let v = if sd.is_empty() { serde_json::Value::Null } else { serde_json::json!(sd) };
        body.insert("start_date".into(), v);
    }
    if let Some(td) = target_date {
        let v = if td.is_empty() { serde_json::Value::Null } else { serde_json::json!(td) };
        body.insert("target_date".into(), v);
    }
    if let Some(p) = priority {
        body.insert("priority".into(), serde_json::json!(p));
    }
    if let Some(sid) = state_id {
        body.insert("state".into(), serde_json::json!(sid));
    }
    serde_json::Value::Object(body)
}

fn client(app: &tauri::AppHandle) -> Result<(PlaneClient, config::Settings), String> {
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
        quickadd_shortcut: s.quickadd_shortcut,
        sidebar_shortcut: s.sidebar_shortcut,
        theme: s.theme,
        display_index: s.display_index,
        idle_open_enabled: s.idle_open_enabled,
        idle_open_minutes: s.idle_open_minutes,
        has_openai_key: config::get_openai_key().is_some(),
        briefing_model: s.briefing_model,
        morning_briefing_enabled: s.morning_briefing_enabled,
        morning_briefing_time: s.morning_briefing_time,
        assign_notify_enabled: s.assign_notify_enabled,
        assign_remind_hours: s.assign_remind_hours,
    }
}

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
    idle_open_enabled: Option<bool>,
    idle_open_minutes: Option<u32>,
    openai_key: Option<String>,
    briefing_model: Option<String>,
    morning_briefing_enabled: Option<bool>,
    morning_briefing_time: Option<String>,
    assign_notify_enabled: Option<bool>,
    assign_remind_hours: Option<u32>,
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace.trim().trim_matches('/').to_string();
    let mut shortcuts_changed = false;
    if let Some(v) = quickadd_shortcut {
        if !v.is_empty() && v != s.quickadd_shortcut { s.quickadd_shortcut = v; shortcuts_changed = true; }
    }
    if let Some(v) = sidebar_shortcut {
        if !v.is_empty() && v != s.sidebar_shortcut { s.sidebar_shortcut = v; shortcuts_changed = true; }
    }
    if let Some(v) = theme { if v == "auto" || v == "light" || v == "dark" { s.theme = v; } }
    if let Some(v) = display_index { if v >= 1 { s.display_index = v; } }
    if let Some(v) = idle_open_enabled { s.idle_open_enabled = v; }
    if let Some(v) = idle_open_minutes { if v >= 1 { s.idle_open_minutes = v; } }
    if let Some(v) = briefing_model { if !v.trim().is_empty() { s.briefing_model = v.trim().to_string(); } }
    if let Some(v) = morning_briefing_enabled { s.morning_briefing_enabled = v; }
    if let Some(v) = morning_briefing_time {
        // "HH:MM"만 허용 — 형식이 다르면 조용히 무시해 기존 값을 지킨다.
        let ok = v.len() == 5 && v.as_bytes()[2] == b':'
            && v[0..2].parse::<u32>().map_or(false, |h| h < 24)
            && v[3..5].parse::<u32>().map_or(false, |m| m < 60);
        if ok { s.morning_briefing_time = v; }
    }
    if let Some(v) = assign_notify_enabled { s.assign_notify_enabled = v; }
    if let Some(v) = assign_remind_hours { if v >= 1 { s.assign_remind_hours = v; } }
    // 재시작 없이 즉시 반영. 등록에 실패하면(다른 앱이 선점 등) 아무것도
    // 저장하지 않고 에러를 돌려줘서 설정 파일과 실제 등록 상태를 일치시킨다.
    if shortcuts_changed {
        crate::reapply_shortcuts(&app, &s.quickadd_shortcut, &s.sidebar_shortcut)?;
    }
    config::save_settings(&app, &s)?;
    if let Some(t) = token {
        if !t.is_empty() {
            config::set_token(&t)?;
        }
    }
    if let Some(k) = openai_key {
        if !k.is_empty() {
            config::set_openai_key(&k)?;
        }
    }
    Ok(())
}

pub(crate) async fn try_create_issue_online(
    client: &PlaneClient,
    project_id: &str,
    name: &str,
    assignee_ids: &[String],
    start_date: Option<&str>,
    target_date: Option<&str>,
    priority: &str,
    state_group: &str,
    description: Option<&str>,
) -> Result<String, String> {
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids.to_vec()
    };
    let states = client.list_states(project_id).await?;
    let state_id = resolve_state_id(&states, state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let description_html = description.filter(|d| !d.is_empty()).map(plain_text_to_description_html);
    let item = NewWorkItem {
        name,
        assignee_ids: &assignees,
        start_date,
        target_date,
        priority,
        state_id: &state_id,
        description_html: description_html.as_deref(),
    };
    client.create_work_item(project_id, &item).await
}

#[tauri::command]
pub async fn create_issue(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    assignee_ids: Vec<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: String,
    state_group: String,
    description: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let trimmed = name.trim().to_string();
    let result = try_create_issue_online(
        &client, &project_id, &trimmed, &assignee_ids,
        start_date.as_deref(), target_date.as_deref(), &priority, &state_group, description.as_deref(),
    )
    .await;
    match result {
        Ok(_new_id) => {
            config::set_last_project(&app, &project_id)?;
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let payload = serde_json::json!({
                "name": trimmed, "assignee_ids": assignee_ids,
                "start_date": start_date, "target_date": target_date,
                "priority": priority, "state_group": state_group, "description": description,
            });
            let placeholder = WorkItemDto {
                id: String::new(),
                name: trimmed,
                priority: priority.clone(),
                target_date: target_date.clone(),
                start_date: start_date.clone(),
                state_group: state_group.clone(),
                project_id: project_id.clone(),
                assignee_ids: assignee_ids.clone(),
                completed_at: None,
                created_at: None,
                updated_at: None,
            };
            crate::offline::queue_create_and_insert(&app, &project_id, payload, placeholder).await?;
            config::set_last_project(&app, &project_id)?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn fetch_sidebar_data(
    app: tauri::AppHandle,
    completed_after: String,
    completed_before: String,
) -> Result<SidebarData, String> {
    let (client, _s) = client(&app)?;
    match fetch_sidebar_data_online(&client, &completed_after, &completed_before).await {
        Ok(data) => {
            if let Err(e) = crate::offline::save_cache(&app, &data, crate::now_ms()) {
                eprintln!("offline cache save failed: {e}");
            }
            Ok(data)
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let snapshot = crate::offline::load_cache(&app)
                .ok_or_else(|| "오프라인 상태이며 아직 캐시된 데이터가 없습니다".to_string())?;
            let mut data = snapshot.data;
            mark_from_cache(&mut data, snapshot.cached_at_ms);
            Ok(data)
        }
        Err(e) => Err(e),
    }
}

async fn fetch_sidebar_data_online(
    client: &PlaneClient,
    completed_after: &str,
    completed_before: &str,
) -> Result<SidebarData, String> {
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    let mut all_states: Vec<ProjectState> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
        match client.list_states(&p.id).await {
            Ok(mut states) => all_states.append(&mut states),
            Err(_) => continue, // skip a project that fails; keep the rest
        }
    }
    Ok(assemble_sidebar(&user.id, projects, all_items, all_states, completed_after, completed_before))
}

#[tauri::command]
pub async fn update_work_item_priority(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    priority: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let body = serde_json::json!({ "priority": priority });
    match client.update_work_item(&project_id, &item_id, body.clone()).await {
        Ok(()) => Ok(()),
        Err(e) if plane_api::is_network_error(&e) => {
            let p = priority.clone();
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdatePriority,
                &project_id,
                &item_id,
                body,
                move |dto| dto.priority = p,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn update_work_item_state(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    state_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let body = serde_json::json!({ "state": state_id });
    match client.update_work_item(&project_id, &item_id, body.clone()).await {
        Ok(()) => Ok(()),
        Err(e) if plane_api::is_network_error(&e) => {
            // 목록 캐시는 state_group(문자열)을 저장하므로, 표시용으로만
            // 캐시된 states 목록에서 이 state_id에 해당하는 그룹명을 찾는다
            // — 못 찾아도 큐잉 자체는 그대로 진행한다(재생 시 실제 id로 처리).
            let group = crate::offline::load_cache(&app)
                .and_then(|c| c.data.states.iter().find(|s| s.id == state_id).map(|s| s.group.clone()));
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdateState,
                &project_id,
                &item_id,
                body,
                move |dto| {
                    if let Some(g) = group {
                        dto.state_group = g;
                    }
                },
            )
            .await
        }
        Err(e) => Err(e),
    }
}

pub(crate) async fn try_update_fields_online(
    client: &PlaneClient,
    project_id: &str,
    item_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    assignee_ids: Option<&[String]>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    priority: Option<&str>,
    state_group: Option<&str>,
) -> Result<(), String> {
    let description_html = description.map(plain_text_to_description_html);
    let state_id = match state_group {
        Some(sg) => {
            let states = client.list_states(project_id).await?;
            Some(resolve_state_id(&states, sg).ok_or_else(|| format!("no state found for group '{sg}'"))?)
        }
        None => None,
    };
    let body = build_update_body(
        name,
        description_html.as_deref(),
        assignee_ids,
        start_date,
        target_date,
        priority,
        state_id.as_deref(),
    );
    if body.as_object().is_some_and(|m| m.is_empty()) {
        return Ok(());
    }
    client.update_work_item(project_id, item_id, body).await
}

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
    let result = try_update_fields_online(
        &client,
        &project_id,
        &item_id,
        name.as_deref(),
        description.as_deref(),
        assignee_ids.as_deref(),
        start_date.as_deref(),
        target_date.as_deref(),
        priority.as_deref(),
        state_group.as_deref(),
    )
    .await;
    match result {
        Ok(()) => {
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            let payload = serde_json::json!({
                "name": name, "description": description, "assignee_ids": assignee_ids,
                "start_date": start_date, "target_date": target_date,
                "priority": priority, "state_group": state_group,
            });
            let name_p = name.clone();
            let priority_p = priority.clone();
            let start_date_p = start_date.clone();
            let target_date_p = target_date.clone();
            let state_group_p = state_group.clone();
            crate::offline::queue_and_patch(
                &app,
                crate::offline::MutationKind::UpdateFields,
                &project_id,
                &item_id,
                payload,
                move |dto| {
                    if let Some(n) = name_p { dto.name = n; }
                    if let Some(p) = priority_p { dto.priority = p; }
                    if let Some(sd) = start_date_p { dto.start_date = if sd.is_empty() { None } else { Some(sd) }; }
                    if let Some(td) = target_date_p { dto.target_date = if td.is_empty() { None } else { Some(td) }; }
                    if let Some(sg) = state_group_p { dto.state_group = sg; }
                },
            )
            .await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    match client.delete_work_item(&project_id, &item_id).await {
        Ok(()) => {
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            crate::offline::queue_delete_and_remove(&app, &project_id, &item_id).await?;
            let _ = app.emit_to("sidebar", "refresh-sidebar", ());
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectDto>, String> {
    let (client, _s) = client(&app)?;
    match client.list_projects().await {
        Ok(projects) => Ok(projects
            .into_iter()
            .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
            .collect()),
        Err(e) if plane_api::is_network_error(&e) => {
            let snapshot = crate::offline::load_cache(&app)
                .ok_or_else(|| "오프라인 상태이며 아직 캐시된 데이터가 없습니다".to_string())?;
            Ok(snapshot.data.projects)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn list_members(app: tauri::AppHandle, project_id: String) -> Result<Vec<MemberDto>, String> {
    let (client, _s) = client(&app)?;
    let members = client.list_members(&project_id).await?;
    let user = client.current_user().await?;
    Ok(members
        .into_iter()
        .map(|m| {
            let is_me = m.id == user.id;
            MemberDto { id: m.id, display_name: m.display_name, is_me }
        })
        .collect())
}

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

#[tauri::command]
pub fn open_edit_modal(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    snapshot: Option<WorkItemDto>,
) {
    if let Some(win) = app.get_webview_window("editmodal") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to(
        "editmodal",
        "load-item",
        serde_json::json!({ "projectId": project_id, "itemId": item_id, "snapshot": snapshot }),
    );
}

#[tauri::command]
pub fn open_conflict_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("conflict") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to("conflict", "conflicts-open", ());
}

#[tauri::command]
pub fn open_settings(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn show_quickadd_for_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    // Persist first so QuickAdd's own load() (focus-triggered) resolves to the same project.
    config::set_last_project(&app, &project_id)?;
    let _ = app.emit_to("quickadd", "select-project", project_id);
    crate::show_quickadd(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct ReleaseNoteDto {
    pub version: String,
    pub date: String,
    pub notes: String,
}

/// The releases of this app itself, not the user's Plane server — the repo is
/// public, so no auth. Kept in sync with the updater endpoint in tauri.conf.json.
const RELEASES_URL: &str = "https://api.github.com/repos/aoperat/plane-tool/releases?per_page=10";

/// Maps the GitHub releases JSON array into display DTOs. Drafts and
/// prereleases are skipped; the `v` tag prefix is dropped and `published_at`
/// is cut down to its date part.
pub fn map_release_notes(releases: &serde_json::Value) -> Vec<ReleaseNoteDto> {
    let Some(arr) = releases.as_array() else { return Vec::new() };
    arr.iter()
        .filter(|r| {
            !r["draft"].as_bool().unwrap_or(false) && !r["prerelease"].as_bool().unwrap_or(false)
        })
        .map(|r| {
            let tag = r["tag_name"].as_str().unwrap_or("");
            ReleaseNoteDto {
                version: tag.strip_prefix('v').unwrap_or(tag).to_string(),
                date: r["published_at"].as_str().unwrap_or("").chars().take(10).collect(),
                notes: r["body"].as_str().unwrap_or("").trim().to_string(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn fetch_release_notes() -> Result<Vec<ReleaseNoteDto>, String> {
    let resp = reqwest::Client::new()
        .get(RELEASES_URL)
        // GitHub rejects requests without a User-Agent with 403.
        .header("User-Agent", "plane-quick-dock")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status().as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(map_release_notes(&json))
}

/// AI 브리핑 생성. 같은 날짜의 캐시가 있으면 (force가 아닌 한) 그대로 반환.
/// OpenAI 실패는 규칙 기반 폴백으로 흡수 — 이 커맨드는 Plane 연결 문제
/// (not_configured, API 오류)에서만 Err을 낸다.
#[tauri::command]
pub async fn generate_briefing(app: tauri::AppHandle, force: bool) -> Result<crate::briefing::Briefing, String> {
    use crate::briefing;
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    if !force {
        if let Some(cached) = config::load_cached_briefing(&app) {
            if cached.date == today {
                return Ok(cached);
            }
        }
    }
    let (client, s) = client(&app)?;
    let user = client.current_user().await?;
    let projects = client.list_projects().await?;
    let mut all_items: Vec<WorkItem> = Vec::new();
    for p in &projects {
        match client.list_work_items(&p.id).await {
            Ok(mut items) => all_items.append(&mut items),
            Err(_) => continue, // 프로젝트 하나가 실패해도 나머지로 브리핑한다
        }
    }
    let items = briefing::open_assigned_items(&user.id, &projects, all_items);
    let fb_summary = briefing::fallback_summary(&items, &today);
    let model = s.briefing_model.clone();
    // 남은 작업이 없으면 AI를 부를 이유가 없다 — 빈 상태 문구를 그대로 쓴다.
    let (source, summary, plan, rest, error) = if items.is_empty() {
        ("fallback".into(), fb_summary.clone(), Vec::new(), Vec::new(), None)
    } else {
        match config::get_openai_key() {
            None => {
                let (plan, rest) = briefing::fallback_plan(items, &today);
                ("fallback".into(), fb_summary, plan, rest, Some("no_key".to_string()))
            }
            Some(key) => {
                let (system, user_msg) = briefing::build_prompt(&items, &today);
                let ai = crate::openai::OpenAiClient::new(key);
                match ai.chat_json(&model, &system, &user_msg).await {
                    Ok(content) => match briefing::apply_ai_response(&content, items.clone(), &today) {
                        Ok((summary, plan, rest)) => {
                            let summary = if summary.is_empty() { fb_summary } else { summary };
                            ("openai".into(), summary, plan, rest, None)
                        }
                        Err(e) => {
                            let (plan, rest) = briefing::fallback_plan(items, &today);
                            ("fallback".into(), fb_summary, plan, rest, Some(e))
                        }
                    },
                    Err(e) => {
                        let (plan, rest) = briefing::fallback_plan(items, &today);
                        ("fallback".into(), fb_summary, plan, rest, Some(e))
                    }
                }
            }
        }
    };
    let b = briefing::Briefing {
        date: today,
        generated_at: now.format("%H:%M").to_string(),
        model,
        source,
        error,
        summary,
        plan,
        rest,
    };
    // 일시적 OpenAI 오류로 만든 폴백은 캐시하지 않는다 — 다음 열기에서 재시도.
    // (no_key 폴백은 키를 등록하기 전까지 결과가 같으므로 캐시해도 안전하다.)
    if b.source == "openai" || b.error.as_deref() == Some("no_key") {
        let _ = config::save_cached_briefing(&app, &b);
    }
    Ok(b)
}

/// 브리핑 창을 설정된 디스플레이 중앙에 표시하고, 창에게 로드 신호를 보낸다.
#[tauri::command]
pub fn open_briefing(app: tauri::AppHandle) {
    crate::show_centered(&app, "briefing");
    let _ = app.emit_to("briefing", "briefing-open", ());
}

#[derive(Serialize)]
pub struct PendingAssignmentDto {
    pub item_id: String,
    pub project_id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub assigner_name: String,
    pub detected_at_ms: u64,
}

#[tauri::command]
pub fn get_pending_assignments(app: tauri::AppHandle) -> Vec<PendingAssignmentDto> {
    assign_watch::load_state(&app)
        .pending
        .into_iter()
        .map(|p| PendingAssignmentDto {
            item_id: p.item_id,
            project_id: p.project_id,
            name: p.name,
            priority: p.priority,
            target_date: p.target_date,
            assigner_name: p.assigner_name,
            detected_at_ms: p.detected_at_ms,
        })
        .collect()
}

/// 수신함 "확인" 버튼: Plane에 마커 댓글을 남기고 pending에서 제거한다.
/// 댓글 작성이 실패하면 pending을 건드리지 않고 에러를 돌려준다 —
/// 확인 기록 없이 수신함에서만 사라지면 할당자 쪽 추적이 어긋난다.
#[tauri::command]
pub async fn acknowledge_assignment(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    let html = plain_text_to_description_html(crate::plane_api::ACK_COMMENT_TEXT);
    client.create_comment(&project_id, &item_id, &html).await?;
    // assign_tick(lib.rs)과 동시에 실행되면 서로의 load→save를 덮어써
    // 확인한 카드가 되살아날 수 있다 — 같은 락으로 구간을 직렬화한다.
    let lock = app.state::<assign_watch::StateLock>();
    let _guard = lock.0.lock().await;
    let mut state = assign_watch::load_state(&app);
    state.pending.retain(|p| p.item_id != item_id);
    let count = state.pending.len();
    assign_watch::save_state(&app, &state)?;
    crate::update_tray_tooltip(&app, count);
    let _ = app.emit_to("sidebar", "assignments-updated", ());
    Ok(())
}

#[derive(Serialize)]
pub struct OfflineStatusDto {
    pub pending: usize,
}

#[tauri::command]
pub fn get_offline_status(app: tauri::AppHandle) -> OfflineStatusDto {
    OfflineStatusDto { pending: crate::offline::load_queue(&app).items.len() }
}

#[derive(Serialize)]
pub struct ConflictFieldsDto {
    pub name: Option<String>,
    pub description: Option<String>,
    pub assignee_ids: Option<Vec<String>>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub priority: Option<String>,
    pub state_group: Option<String>,
}

impl From<crate::offline::ConflictFields> for ConflictFieldsDto {
    fn from(f: crate::offline::ConflictFields) -> Self {
        Self {
            name: f.name,
            description: f.description,
            assignee_ids: f.assignee_ids,
            start_date: f.start_date,
            target_date: f.target_date,
            priority: f.priority,
            state_group: f.state_group,
        }
    }
}

#[derive(Serialize)]
pub struct ConflictDto {
    pub id: String,
    pub kind: crate::offline::MutationKind,
    pub project_id: String,
    pub target_id: String,
    pub item_name: String,
    pub reason: crate::offline::ConflictReason,
    pub local_fields: ConflictFieldsDto,
    pub server_fields: Option<ConflictFieldsDto>,
    pub detected_at_ms: u64,
}

#[tauri::command]
pub fn get_conflicts(app: tauri::AppHandle) -> Vec<ConflictDto> {
    crate::offline::load_conflicts(&app)
        .items
        .into_iter()
        .map(|c| ConflictDto {
            id: c.id,
            kind: c.kind,
            project_id: c.project_id,
            target_id: c.target_id,
            item_name: c.item_name,
            reason: c.reason,
            local_fields: c.local_fields.into(),
            server_fields: c.server_fields.map(Into::into),
            detected_at_ms: c.detected_at_ms,
        })
        .collect()
}

/// 충돌 하나를 해결한다. `action`은 `"apply"`(내 값 유지 — 종류별로 아래
/// 표대로 실제 서버에 반영) 또는 `"discard"`(서버 값 그대로 두고 버림, API
/// 호출 없음). `UpdateFields` 충돌의 `"apply"`는 `fields`(프런트엔드가
/// 필드별로 고른 값을 합친 것)가 반드시 있어야 한다 — 상태 그룹→id 변환은
/// `try_update_fields_online`이 다시 온라인으로 처리한다.
#[tauri::command]
pub async fn resolve_conflict(
    app: tauri::AppHandle,
    conflict_id: String,
    action: String,
    fields: Option<serde_json::Value>,
) -> Result<(), String> {
    // 조회는 잠금 없이 — 어떤 항목을 적용할지 알기 위한 것뿐이고, 네트워크
    // 호출 동안 잠금을 들고 있으면 안 된다(QueueLock과 같은 원칙).
    let conflicts_peek = crate::offline::load_conflicts(&app);
    let Some(entry) = conflicts_peek.items.iter().find(|c| c.id == conflict_id).cloned() else {
        return Err("conflict not found".into());
    };
    if action == "apply" {
        let (client, _s) = client(&app)?;
        match entry.kind {
            crate::offline::MutationKind::Delete => {
                client.delete_work_item(&entry.project_id, &entry.target_id).await?;
            }
            crate::offline::MutationKind::UpdatePriority | crate::offline::MutationKind::UpdateState => {
                client.update_work_item(&entry.project_id, &entry.target_id, entry.local_payload.clone()).await?;
            }
            crate::offline::MutationKind::UpdateFields => {
                let f = fields.ok_or_else(|| "fields required for UpdateFields conflicts".to_string())?;
                let assignee_ids: Option<Vec<String>> = f.get("assignee_ids").and_then(|v| v.as_array()).map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
                });
                try_update_fields_online(
                    &client,
                    &entry.project_id,
                    &entry.target_id,
                    f.get("name").and_then(|v| v.as_str()),
                    f.get("description").and_then(|v| v.as_str()),
                    assignee_ids.as_deref(),
                    f.get("start_date").and_then(|v| v.as_str()),
                    f.get("target_date").and_then(|v| v.as_str()),
                    f.get("priority").and_then(|v| v.as_str()),
                    f.get("state_group").and_then(|v| v.as_str()),
                )
                .await?;
            }
            crate::offline::MutationKind::CreateIssue => {
                return Err("create_issue conflicts are not supported".into());
            }
        }
    }
    // 네트워크 호출이 끝난 뒤 잠금을 잡고 최신 목록을 다시 읽어 제거한다 —
    // 그 사이 replay_queue가 다른 충돌을 추가했을 수 있으므로, 호출 전에
    // 읽어둔 stale한 목록을 그대로 저장하면 그 추가분을 덮어써 유실시킨다.
    let lock = app.state::<crate::offline::ConflictLock>();
    let _guard = lock.0.lock().await;
    let mut conflicts = crate::offline::load_conflicts(&app);
    crate::offline::remove_conflict(&mut conflicts, &conflict_id);
    crate::offline::save_conflicts(&app, &conflicts)?;
    let _ = app.emit_to(
        "sidebar",
        "offline-conflicts-changed",
        serde_json::json!({ "count": conflicts.items.len() }),
    );
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane_api::{Project, ProjectState, WorkItem};

    fn wi(id: &str, group: &str, assignees: &[&str], project: &str) -> WorkItem {
        wi_completed(id, group, assignees, project, None)
    }

    fn wi_completed(id: &str, group: &str, assignees: &[&str], project: &str, completed_at: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("n{id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(), project_id: project.into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
            created_at: None,
            created_by: None,
            updated_at: None,
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
            wi("b", "completed", &["me"], "p1"), // no completed_at: dropped
            wi("c", "backlog", &["me"], "p2"),
            wi("d", "started", &["other"], "p2"),
        ];
        let states = vec![
            ProjectState { id: "s1".into(), group: "started".into(), project_id: "p1".into(), default: true },
        ];
        let data = assemble_sidebar("me", projects, items, states, "2026-06-30", "2026-07-02");
        assert_eq!(data.projects.len(), 2);
        let ids: Vec<_> = data.assigned.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
        assert_eq!(data.states.len(), 1);
        assert_eq!(data.states[0].id, "s1");
        assert_eq!(data.states[0].project_id, "p1");
        assert!(data.states[0].default);
    }

    #[test]
    fn assemble_includes_items_completed_within_the_window() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let items = vec![
            wi("a", "started", &["me"], "p1"),
            wi_completed("b", "completed", &["me"], "p1", Some("2026-07-01T09:00:00Z")), // in window
            wi_completed("c", "completed", &["me"], "p1", Some("2026-06-29T09:00:00Z")), // outside window
        ];
        let data = assemble_sidebar("me", projects, items, vec![], "2026-06-30", "2026-07-02");
        let ids: Vec<_> = data.assigned.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        let completed = data.assigned.iter().find(|i| i.id == "b").unwrap();
        assert_eq!(completed.completed_at.as_deref(), Some("2026-07-01T09:00:00Z"));
    }

    #[test]
    fn assemble_sidebar_carries_updated_at_into_work_item_dto() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let mut item = wi("a", "started", &["me"], "p1");
        item.updated_at = Some("2026-07-01T10:00:00Z".into());
        let data = assemble_sidebar("me", projects, vec![item], vec![], "2026-06-30", "2026-07-02");
        assert_eq!(data.assigned[0].updated_at.as_deref(), Some("2026-07-01T10:00:00Z"));
    }

    #[test]
    fn assemble_sidebar_carries_assignee_ids_into_work_item_dto() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let item = wi("a", "started", &["me", "other"], "p1");
        let data = assemble_sidebar("me", projects, vec![item], vec![], "2026-06-30", "2026-07-02");
        assert_eq!(data.assigned[0].assignee_ids, vec!["me".to_string(), "other".to_string()]);
    }

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

    #[test]
    fn build_update_body_turns_empty_date_strings_into_null() {
        // The sidebar's date popover sends "" to clear a date; Plane expects null.
        let body = build_update_body(None, None, None, Some(""), Some(""), None, None);
        assert_eq!(body, serde_json::json!({ "start_date": null, "target_date": null }));
    }

    #[test]
    fn map_release_notes_maps_tag_date_and_body() {
        let json = serde_json::json!([{
            "tag_name": "v0.1.3",
            "published_at": "2026-07-03T05:12:00Z",
            "body": "### 수정\n- 버그 수정\n",
            "draft": false,
            "prerelease": false
        }]);
        let notes = map_release_notes(&json);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].version, "0.1.3");
        assert_eq!(notes[0].date, "2026-07-03");
        assert_eq!(notes[0].notes, "### 수정\n- 버그 수정");
    }

    #[test]
    fn map_release_notes_skips_drafts_and_prereleases() {
        let json = serde_json::json!([
            { "tag_name": "v0.2.0-rc1", "published_at": "2026-07-04T00:00:00Z", "body": "", "draft": false, "prerelease": true },
            { "tag_name": "v0.2.0", "published_at": null, "body": "x", "draft": true, "prerelease": false },
            { "tag_name": "v0.1.0", "published_at": "2026-07-02T00:00:00Z", "body": "y", "draft": false, "prerelease": false }
        ]);
        let notes = map_release_notes(&json);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].version, "0.1.0");
    }

    #[test]
    fn map_release_notes_tolerates_missing_fields_and_non_array() {
        // Early releases (or a surprising API response) must not panic the command.
        let notes = map_release_notes(&serde_json::json!([{}]));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].version, "");
        assert_eq!(notes[0].date, "");
        assert_eq!(notes[0].notes, "");
        assert!(map_release_notes(&serde_json::json!({"message": "rate limited"})).is_empty());
    }

    #[test]
    fn sidebar_data_round_trips_through_json_and_defaults_is_cached_to_false() {
        let data = assemble_sidebar("me", vec![], vec![], vec![], "2026-06-30", "2026-07-02");
        let json = serde_json::to_string(&data).unwrap();
        let back: SidebarData = serde_json::from_str(&json).unwrap();
        assert!(!back.is_cached);
        assert_eq!(back.cached_at_ms, None);
    }

    #[test]
    fn sidebar_data_from_cache_marks_is_cached_and_carries_timestamp() {
        let mut data = assemble_sidebar("me", vec![], vec![], vec![], "2026-06-30", "2026-07-02");
        mark_from_cache(&mut data, 12345);
        assert!(data.is_cached);
        assert_eq!(data.cached_at_ms, Some(12345));
    }
}
