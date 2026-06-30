use crate::config;
use crate::plane_api::{filter_assigned_open, PlaneClient, Project, WorkItem};
use serde::Serialize;

#[derive(Serialize)]
pub struct SettingsDto {
    pub base_url: String,
    pub workspace: String,
    pub last_project_id: Option<String>,
    pub has_token: bool,
    pub quickadd_shortcut: String,
    pub sidebar_shortcut: String,
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
) -> Result<(), String> {
    let mut s = config::load_settings(&app);
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.workspace = workspace.trim().trim_matches('/').to_string();
    if let Some(v) = quickadd_shortcut { if !v.is_empty() { s.quickadd_shortcut = v; } }
    if let Some(v) = sidebar_shortcut { if !v.is_empty() { s.sidebar_shortcut = v; } }
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

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectDto>, String> {
    let (client, _s) = client(&app)?;
    let projects = client.list_projects().await?;
    Ok(projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect())
}

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
