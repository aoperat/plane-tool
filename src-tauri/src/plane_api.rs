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
}
