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

#[derive(Debug, Clone)]
pub struct ProjectState { pub id: String, pub group: String }

#[derive(Debug, Clone)]
pub struct Member { pub id: String, pub display_name: String }

pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
}

pub fn resolve_state_id(states: &[ProjectState], group: &str) -> Option<String> {
    states.iter().find(|s| s.group == group).map(|s| s.id.clone())
}

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

#[derive(Deserialize)]
struct RawProjectState { id: String, group: String }

#[derive(Deserialize)]
struct RawMember { id: String, #[serde(default)] display_name: String }

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

    pub async fn list_states(&self, project_id: &str) -> Result<Vec<ProjectState>, String> {
        let url = format!("{}/projects/{}/states/", self.ws_base(), project_id);
        let page: Paginated<RawProjectState> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|s| ProjectState { id: s.id, group: s.group })
            .collect())
    }

    // Unlike every other list endpoint in this file, /members/ returns a bare
    // JSON array — no `{"results": [...]}` wrapper. Confirmed against the
    // live server; do not wrap this in `Paginated<T>`.
    pub async fn list_members(&self, project_id: &str) -> Result<Vec<Member>, String> {
        let url = format!("{}/projects/{}/members/", self.ws_base(), project_id);
        let raw: Vec<RawMember> = self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(raw
            .into_iter()
            .map(|m| Member { id: m.id, display_name: m.display_name })
            .collect())
    }

    pub async fn create_work_item(
        &self,
        project_id: &str,
        item: &NewWorkItem<'_>,
    ) -> Result<(), String> {
        // The create endpoint (no `expand` param) returns `assignees`/`state` as
        // flat id strings, not the nested objects `RawWorkItem` expects (that
        // shape only applies to the `expand=assignees,state` list endpoint).
        // Nothing consumes the created item, so skip parsing the body.
        let url = format!("{}/projects/{}/work-items/", self.ws_base(), project_id);
        self.http
            .post(&url)
            .header("X-Api-Key", &self.api_key)
            .json(&serde_json::json!({
                "name": item.name,
                "assignees": item.assignee_ids,
                "start_date": item.start_date,
                "target_date": item.target_date,
                "priority": item.priority,
                "state": item.state_id,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
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
            .and(header("X-Api-Key", "secret-key"))
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
    async fn create_work_item_sends_all_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "start_date": "2026-07-01",
                "target_date": "2026-07-02",
                "priority": "high",
                "state": "state-1"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: Some("2026-07-01"),
            target_date: Some("2026-07-02"),
            priority: "high",
            state_id: "state-1",
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }

    #[tokio::test]
    async fn current_user_parses_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/users/me/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "me", "display_name": "Aoperat"
            })))
            .mount(&server)
            .await;

        let user = client_for(&server).await.current_user().await.unwrap();
        assert_eq!(user.id, "me");
        assert_eq!(user.display_name, "Aoperat");
    }

    #[test]
    fn resolve_state_id_finds_id_for_group() {
        let states = vec![
            ProjectState { id: "s-backlog".into(), group: "backlog".into() },
            ProjectState { id: "s-todo".into(), group: "unstarted".into() },
        ];
        assert_eq!(resolve_state_id(&states, "backlog"), Some("s-backlog".to_string()));
        assert_eq!(resolve_state_id(&states, "cancelled"), None);
    }

    #[tokio::test]
    async fn list_states_parses_group_and_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/states/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "s1", "name": "Backlog", "group": "backlog" },
                    { "id": "s2", "name": "Todo", "group": "unstarted" }
                ]
            })))
            .mount(&server)
            .await;

        let states = client_for(&server).await.list_states("p1").await.unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].id, "s1");
        assert_eq!(states[0].group, "backlog");
    }

    #[tokio::test]
    async fn list_members_parses_plain_array_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/members/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": "u1", "display_name": "Alice" },
                { "id": "u2", "display_name": "Bob" }
            ])))
            .mount(&server)
            .await;

        let members = client_for(&server).await.list_members("p1").await.unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].id, "u1");
        assert_eq!(members[1].display_name, "Bob");
    }
}
