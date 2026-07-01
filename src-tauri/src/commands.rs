use crate::config;
use tauri::Emitter;
use crate::plane_api::{filter_assigned_visible, plain_text_to_description_html, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
use serde::Serialize;

#[derive(Serialize)]
pub struct SettingsDto {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    pub has_token: bool,
    pub quickadd_shortcut: String,
    pub sidebar_shortcut: String,
    pub theme: String,
}

#[derive(Serialize)]
pub struct ProjectDto { pub id: String, pub name: String, pub identifier: String }

#[derive(Serialize)]
pub struct MemberDto { pub id: String, pub display_name: String }

#[derive(Serialize)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub completed_at: Option<String>,
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

#[derive(Serialize)]
pub struct StateDto { pub id: String, pub group: String, pub project_id: String, pub default: bool }

#[derive(Serialize)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    pub states: Vec<StateDto>,
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
            state_group: w.state_group, project_id: w.project_id, completed_at: w.completed_at,
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
    SidebarData { projects, assigned, states }
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
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace.trim().trim_matches('/').to_string();
    if let Some(v) = quickadd_shortcut { if !v.is_empty() { s.quickadd_shortcut = v; } }
    if let Some(v) = sidebar_shortcut { if !v.is_empty() { s.sidebar_shortcut = v; } }
    if let Some(v) = theme { if v == "auto" || v == "light" || v == "dark" { s.theme = v; } }
    config::save_settings(&app, &s)?;
    if let Some(t) = token {
        if !t.is_empty() {
            config::set_token(&t)?;
        }
    }
    Ok(())
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
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids
    };
    let states = client.list_states(&project_id).await?;
    let state_id = resolve_state_id(&states, &state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let description_html = description
        .filter(|d| !d.is_empty())
        .map(|d| plain_text_to_description_html(&d));
    let item = NewWorkItem {
        name: name.trim(),
        assignee_ids: &assignees,
        start_date: start_date.as_deref(),
        target_date: target_date.as_deref(),
        priority: &priority,
        state_id: &state_id,
        description_html: description_html.as_deref(),
    };
    client.create_work_item(&project_id, &item).await?;
    config::set_last_project(&app, &project_id)?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_sidebar_data(
    app: tauri::AppHandle,
    completed_after: String,
    completed_before: String,
) -> Result<SidebarData, String> {
    let (client, _s) = client(&app)?;
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
    Ok(assemble_sidebar(&user.id, projects, all_items, all_states, &completed_after, &completed_before))
}

#[tauri::command]
pub async fn update_work_item_priority(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    priority: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client
        .update_work_item(&project_id, &item_id, serde_json::json!({ "priority": priority }))
        .await
}

#[tauri::command]
pub async fn update_work_item_state(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    state_id: String,
) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client
        .update_work_item(&project_id, &item_id, serde_json::json!({ "state": state_id }))
        .await
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

#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client.delete_work_item(&project_id, &item_id).await
}

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectDto>, String> {
    let (client, _s) = client(&app)?;
    let projects = client.list_projects().await?;
    Ok(projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect())
}

#[tauri::command]
pub async fn list_members(app: tauri::AppHandle, project_id: String) -> Result<Vec<MemberDto>, String> {
    let (client, _s) = client(&app)?;
    let members = client.list_members(&project_id).await?;
    Ok(members
        .into_iter()
        .map(|m| MemberDto { id: m.id, display_name: m.display_name })
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
            target_date: None, state_group: group.into(), project_id: project.into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
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
}
