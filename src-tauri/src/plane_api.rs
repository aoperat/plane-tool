use serde::Deserialize;

/// Part B(맡긴 작업 창)가 이 문자열로 확인 여부를 판정한다 — 절대 바꾸지 말 것.
pub const ACK_COMMENT_TEXT: &str = "🔔 할당을 확인했습니다 (Quick Dock)";

#[derive(Debug, Clone)]
pub struct Project { pub id: String, pub name: String, pub identifier: String }

#[derive(Debug, Clone)]
pub struct WorkItem {
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
    pub created_by: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CurrentUser { pub id: String, pub display_name: String }

#[derive(Debug, Clone)]
pub struct ProjectState { pub id: String, pub group: String, pub project_id: String, pub default: bool }

#[derive(Debug, Clone)]
pub struct Member { pub id: String, pub display_name: String }

#[derive(Debug, Clone)]
pub struct Comment { pub id: String, pub comment_html: String, pub actor: String }

#[derive(Debug, Clone)]
pub struct Activity { pub field: Option<String>, pub actor: Option<String> }

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

pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
    pub description_html: Option<&'a str>,
}

pub fn resolve_state_id(states: &[ProjectState], group: &str) -> Option<String> {
    states.iter().find(|s| s.group == group).map(|s| s.id.clone())
}

/// 이 작업을 나에게 할당한 사람의 user id. assignees 필드를 바꾼 활동 중
/// 내가 아닌 actor의 마지막 것 → 없으면 created_by(내가 아닐 때만) → None.
pub fn find_assigner(activities: &[Activity], created_by: Option<&str>, me: &str) -> Option<String> {
    activities
        .iter()
        .rev()
        .find(|a| a.field.as_deref() == Some("assignees") && a.actor.as_deref().is_some_and(|x| x != me))
        .and_then(|a| a.actor.clone())
        .or_else(|| created_by.filter(|c| *c != me).map(str::to_string))
}

/// Converts plain text (as typed into QuickAdd's description textarea) into the
/// minimal HTML Plane's `description_html` field expects: HTML-escape special
/// characters, then wrap each line in its own `<p>` paragraph. No rich text
/// (bold/lists/links) is supported — this is intentionally the only formatting.
pub fn plain_text_to_description_html(text: &str) -> String {
    text.lines()
        .map(|line| format!("<p>{}</p>", escape_html(line)))
        .collect::<Vec<_>>()
        .join("")
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

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

/// Keeps items assigned to `user_id` that are still open, plus completed items
/// whose (UTC) completion date falls within `[completed_after, completed_before]`
/// (inclusive ISO `YYYY-MM-DD` bounds) — so today's wins still show up briefly
/// instead of vanishing the instant they're marked done. Cancelled items and
/// items completed outside the window are dropped.
///
/// This is a coarse, timezone-naive prefilter meant to bound how much history
/// crosses the IPC boundary — callers should pass a window a day wider than
/// "today" on each side (e.g. yesterday..tomorrow) and do the precise "is this
/// actually today in the user's local timezone" check client-side, where
/// `Date` can convert the UTC timestamp to local time correctly.
pub fn filter_assigned_visible(
    items: Vec<WorkItem>,
    user_id: &str,
    completed_after: &str,
    completed_before: &str,
) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "cancelled")
        .filter(|i| i.state_group != "completed" || completed_within(i, completed_after, completed_before))
        .collect()
}

fn completed_within(item: &WorkItem, after: &str, before: &str) -> bool {
    item.completed_at
        .as_deref()
        .and_then(|ts| ts.get(0..10))
        .is_some_and(|day| day >= after && day <= before)
}

#[derive(Deserialize)]
struct Paginated<T> { results: Vec<T> }

#[derive(Deserialize)]
struct RawProject {
    id: String,
    name: String,
    #[serde(default)] identifier: String,
    #[serde(default)] is_member: bool,
}

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
    #[serde(default)] start_date: Option<String>,
    #[serde(default)] state: Option<RawState>,
    #[serde(default)] assignees: Vec<RawAssignee>,
    #[serde(default)] completed_at: Option<String>,
    #[serde(default)] created_at: Option<String>,
    #[serde(default)] description_html: Option<String>,
    #[serde(default)] created_by: Option<String>,
}

#[derive(Deserialize)]
struct RawComment {
    id: String,
    #[serde(default)] comment_html: String,
    #[serde(default)] actor: Option<String>,
    #[serde(default)] created_by: Option<String>,
}

#[derive(Deserialize)]
struct RawActivity {
    #[serde(default)] field: Option<String>,
    #[serde(default)] actor: Option<String>,
}

fn priority_none() -> String { "none".into() }

#[derive(Deserialize)]
struct RawUser { id: String, #[serde(default)] display_name: String }

#[derive(Deserialize)]
struct RawProjectState {
    id: String,
    group: String,
    #[serde(default)] default: bool,
}

#[derive(Deserialize)]
struct RawMember { id: String, #[serde(default)] display_name: String }

pub struct PlaneClient {
    base_url: String,
    workspace: String,
    api_key: String,
    http: reqwest::Client,
}

/// Passes successful responses through; turns error statuses into an `Err` that
/// includes the response body, where Plane puts the actual reason (e.g. per-field
/// validation messages on a 400). `error_for_status()` alone would discard it.
async fn error_with_body(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if !status.is_client_error() && !status.is_server_error() {
        return Ok(resp);
    }
    let url = resp.url().clone();
    let body = resp.text().await.unwrap_or_default();
    let mut msg = format!("HTTP {status} ({url})");
    if !body.is_empty() {
        // Cap pathological bodies (e.g. an HTML error page) so the UI stays readable.
        let snippet: String = body.chars().take(300).collect();
        msg.push_str(": ");
        msg.push_str(&snippet);
    }
    Err(msg)
}

/// Seconds to wait before retrying a 429 response: honors the server's `Retry-After` header when
/// present, otherwise falls back to exponential backoff (1s, 2s, 4s, ...) keyed on retry attempt.
fn retry_after_seconds(headers: &reqwest::header::HeaderMap, attempt: u32) -> u64 {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1u64 << attempt)
}

/// True when the base URL points at a LAN or loopback address. The self-hosted
/// Plane instance this app targets serves HTTPS with a self-signed certificate
/// that client PCs don't trust, so TLS verification is relaxed for those hosts
/// only — public hosts keep full certificate validation.
fn is_private_host(base_url: &str) -> bool {
    let Some(host) = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
    else {
        return false;
    };
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => host == "localhost",
    }
}

fn build_http_client(base_url: &str) -> reqwest::Client {
    if is_private_host(base_url) {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    } else {
        reqwest::Client::new()
    }
}

impl PlaneClient {
    pub fn new(base_url: String, workspace: String, api_key: String) -> Self {
        let http = build_http_client(&base_url);
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            workspace,
            api_key,
            http,
        }
    }

    fn ws_base(&self) -> String {
        format!("{}/api/v1/workspaces/{}", self.base_url, self.workspace)
    }

    /// Sends `req`, retrying up to 2 times on 429 (honoring `Retry-After`, else
    /// exponential backoff). Safe for mutations too: a 429 means the server
    /// rejected the request without processing it, so nothing ran twice.
    async fn send_retrying(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        const MAX_RETRIES: u32 = 2;
        let mut attempt = 0;
        loop {
            let attempt_req = req.try_clone().ok_or("request body is not retryable")?;
            let resp = attempt_req.send().await.map_err(|e| e.to_string())?;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < MAX_RETRIES {
                let wait_secs = retry_after_seconds(resp.headers(), attempt);
                tokio::time::sleep(std::time::Duration::from_secs(wait_secs)).await;
                attempt += 1;
                continue;
            }
            return error_with_body(resp).await;
        }
    }

    async fn get_json(&self, url: &str) -> Result<reqwest::Response, String> {
        self.send_retrying(self.http.get(url).header("X-Api-Key", &self.api_key)).await
    }

    pub async fn current_user(&self) -> Result<CurrentUser, String> {
        let url = format!("{}/api/v1/users/me/", self.base_url);
        let raw: RawUser = self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(CurrentUser { id: raw.id, display_name: raw.display_name })
    }

    /// Returns only the projects the authenticated user is a member of. Plane's
    /// `/projects/` endpoint lists every project in the workspace regardless of
    /// project-level membership, flagging each with `is_member`, so we filter here.
    pub async fn list_projects(&self) -> Result<Vec<Project>, String> {
        let url = format!("{}/projects/", self.ws_base());
        let page: Paginated<RawProject> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .filter(|p| p.is_member)
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

    pub async fn list_states(&self, project_id: &str) -> Result<Vec<ProjectState>, String> {
        let url = format!("{}/projects/{}/states/", self.ws_base(), project_id);
        let page: Paginated<RawProjectState> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|s| ProjectState { id: s.id, group: s.group, project_id: project_id.to_string(), default: s.default })
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
        // Absent optional fields are omitted rather than sent as `null` —
        // Plane 0.27+ rejects `"description_html": null` with a 400.
        let mut body = serde_json::Map::new();
        body.insert("name".into(), serde_json::json!(item.name));
        body.insert("assignees".into(), serde_json::json!(item.assignee_ids));
        body.insert("priority".into(), serde_json::json!(item.priority));
        body.insert("state".into(), serde_json::json!(item.state_id));
        if let Some(sd) = item.start_date {
            body.insert("start_date".into(), serde_json::json!(sd));
        }
        if let Some(td) = item.target_date {
            body.insert("target_date".into(), serde_json::json!(td));
        }
        if let Some(dh) = item.description_html {
            body.insert("description_html".into(), serde_json::json!(dh));
        }
        self.send_retrying(
            self.http
                .post(&url)
                .header("X-Api-Key", &self.api_key)
                .json(&serde_json::Value::Object(body)),
        )
        .await?;
        Ok(())
    }

    pub async fn update_work_item(
        &self,
        project_id: &str,
        item_id: &str,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/", self.ws_base(), project_id, item_id);
        self.send_retrying(self.http.patch(&url).header("X-Api-Key", &self.api_key).json(&body))
            .await?;
        Ok(())
    }

    pub async fn delete_work_item(&self, project_id: &str, item_id: &str) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/", self.ws_base(), project_id, item_id);
        self.send_retrying(self.http.delete(&url).header("X-Api-Key", &self.api_key)).await?;
        Ok(())
    }

    pub async fn list_comments(&self, project_id: &str, item_id: &str) -> Result<Vec<Comment>, String> {
        let url = format!("{}/projects/{}/work-items/{}/comments/", self.ws_base(), project_id, item_id);
        let page: Paginated<RawComment> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|c| Comment {
                id: c.id,
                comment_html: c.comment_html,
                actor: c.actor.or(c.created_by).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn create_comment(&self, project_id: &str, item_id: &str, comment_html: &str) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/comments/", self.ws_base(), project_id, item_id);
        self.send_retrying(
            self.http
                .post(&url)
                .header("X-Api-Key", &self.api_key)
                .json(&serde_json::json!({ "comment_html": comment_html })),
        )
        .await?;
        Ok(())
    }

    pub async fn list_activities(&self, project_id: &str, item_id: &str) -> Result<Vec<Activity>, String> {
        let url = format!("{}/projects/{}/work-items/{}/activities/", self.ws_base(), project_id, item_id);
        let page: Paginated<RawActivity> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page.results.into_iter().map(|a| Activity { field: a.field, actor: a.actor }).collect())
    }
}

fn map_work_item(w: RawWorkItem, project_id: &str) -> WorkItem {
    WorkItem {
        id: w.id,
        name: w.name,
        priority: w.priority,
        target_date: w.target_date,
        start_date: w.start_date,
        state_group: w.state.map(|s| s.group).unwrap_or_default(),
        project_id: project_id.to_string(),
        assignee_ids: w.assignees.into_iter().map(|a| a.id).collect(),
        completed_at: w.completed_at,
        created_at: w.created_at,
        created_by: w.created_by,
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn wi(id: &str, group: &str, assignees: &[&str]) -> WorkItem {
        wi_completed(id, group, assignees, None)
    }

    fn wi_completed(id: &str, group: &str, assignees: &[&str], completed_at: Option<&str>) -> WorkItem {
        WorkItem {
            id: id.into(), name: format!("item {id}"), priority: "none".into(),
            target_date: None, start_date: None, state_group: group.into(), project_id: "p1".into(),
            assignee_ids: assignees.iter().map(|s| s.to_string()).collect(),
            completed_at: completed_at.map(|s| s.to_string()),
            created_at: None,
            created_by: None,
        }
    }

    #[test]
    fn filter_keeps_my_open_items_and_drops_cancelled() {
        let items = vec![
            wi("a", "started", &["me"]),     // keep
            wi("c", "unstarted", &["other"]),// drop: not mine
            wi("d", "cancelled", &["me"]),   // drop: cancelled
            wi("e", "backlog", &["me", "x"]),// keep
        ];
        let kept = filter_assigned_visible(items, "me", "2026-06-30", "2026-07-02");
        let ids: Vec<_> = kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "e"]);
    }

    #[test]
    fn filter_keeps_items_completed_within_the_window_inclusive() {
        let items = vec![
            wi_completed("a", "completed", &["me"], Some("2026-07-01T09:00:00Z")), // keep: window start
            wi_completed("b", "completed", &["me"], Some("2026-07-02T09:00:00Z")), // keep: window end
            wi_completed("c", "completed", &["me"], Some("2026-06-30T23:59:00Z")), // drop: before window
            wi_completed("d", "completed", &["me"], Some("2026-07-03T00:01:00Z")), // drop: after window
            wi_completed("e", "completed", &["me"], None),                        // drop: no timestamp
        ];
        let kept = filter_assigned_visible(items, "me", "2026-07-01", "2026-07-02");
        let ids: Vec<_> = kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client_for(server: &MockServer) -> PlaneClient {
        PlaneClient::new(server.uri(), "acme".into(), "secret-key".into())
    }

    #[test]
    fn is_private_host_relaxes_lan_and_loopback_only() {
        assert!(is_private_host("https://192.168.20.235"));
        assert!(is_private_host("https://10.0.0.5:8443"));
        assert!(is_private_host("http://172.16.1.1"));
        assert!(is_private_host("http://localhost:8060"));
        assert!(is_private_host("http://127.0.0.1"));
        assert!(!is_private_host("https://plane.example.com"));
        assert!(!is_private_host("https://8.8.8.8"));
        assert!(!is_private_host("not a url"));
    }

    #[test]
    fn retry_after_seconds_uses_the_header_when_present() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "7".parse().unwrap());
        assert_eq!(retry_after_seconds(&headers, 0), 7);
    }

    #[test]
    fn retry_after_seconds_falls_back_to_exponential_backoff_without_header() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after_seconds(&headers, 0), 1);
        assert_eq!(retry_after_seconds(&headers, 1), 2);
    }

    #[tokio::test]
    async fn get_json_retries_once_after_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "p1", "name": "Web App", "identifier": "WEB", "is_member": true }]
            })))
            .mount(&server)
            .await;

        let projects = client_for(&server).await.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "p1");
    }

    #[tokio::test]
    async fn delete_work_item_retries_once_after_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server).await.delete_work_item("p1", "i1").await.unwrap();
    }

    #[tokio::test]
    async fn update_work_item_retries_once_after_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "priority": "high" })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .update_work_item("p1", "i1", serde_json::json!({ "priority": "high" }))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn get_json_gives_up_after_max_retries_and_returns_the_429_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .expect(3) // initial attempt + 2 retries, then give up
            .mount(&server)
            .await;

        let err = client_for(&server).await.list_projects().await.unwrap_err();
        assert!(err.contains("429"), "expected error to mention 429, got: {err}");
    }

    #[tokio::test]
    async fn list_projects_parses_results_and_sends_api_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "p1", "name": "Web App", "identifier": "WEB", "is_member": true },
                    { "id": "p2", "name": "Mobile", "identifier": "MOB", "is_member": true }
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
    async fn list_projects_drops_projects_the_user_is_not_a_member_of() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "p1", "name": "Web App", "identifier": "WEB", "is_member": true },
                    { "id": "p2", "name": "Not Invited", "identifier": "NOPE", "is_member": false }
                ]
            })))
            .mount(&server)
            .await;

        let projects = client_for(&server).await.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "p1");
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
                    "start_date": "2026-07-01",
                    "state": { "group": "started" },
                    "assignees": [{ "id": "me" }],
                    "completed_at": "2026-07-01T09:00:00Z"
                }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state_group, "started");
        assert_eq!(items[0].assignee_ids, vec!["me".to_string()]);
        assert_eq!(items[0].project_id, "p1");
        assert_eq!(items[0].completed_at.as_deref(), Some("2026-07-01T09:00:00Z"));
        assert_eq!(items[0].start_date.as_deref(), Some("2026-07-01"));
    }

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
                "state": "state-1",
                "description_html": "<p>World</p>"
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
            description_html: Some("<p>World</p>"),
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }

    // Plane 0.27+ rejects explicit `null` for description_html ("This field may
    // not be null.") — absent optional fields must be omitted from the body
    // entirely, not sent as null.
    #[tokio::test]
    async fn create_work_item_omits_absent_optional_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "priority": "none",
                "state": "state-1"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: None,
            target_date: None,
            priority: "none",
            state_id: "state-1",
            description_html: None,
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }

    // The server's validation errors arrive in the response body — surfacing
    // only "400 Bad Request" gives the user nothing to act on.
    #[tokio::test]
    async fn create_work_item_error_includes_response_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "description_html": ["This field may not be null."]
            })))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: None,
            target_date: None,
            priority: "none",
            state_id: "state-1",
            description_html: None,
        };
        let err = client_for(&server).await.create_work_item("p1", &item).await.unwrap_err();
        assert!(err.contains("400"), "error should include status: {err}");
        assert!(err.contains("This field may not be null."), "error should include body: {err}");
    }

    #[tokio::test]
    async fn update_work_item_sends_patch_with_body() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({ "priority": "high" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .update_work_item("p1", "i1", serde_json::json!({ "priority": "high" }))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn delete_work_item_sends_delete_request() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        client_for(&server).await.delete_work_item("p1", "i1").await.unwrap();
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
            ProjectState { id: "s-backlog".into(), group: "backlog".into(), project_id: "p1".into(), default: false },
            ProjectState { id: "s-todo".into(), group: "unstarted".into(), project_id: "p1".into(), default: false },
        ];
        assert_eq!(resolve_state_id(&states, "backlog"), Some("s-backlog".to_string()));
        assert_eq!(resolve_state_id(&states, "cancelled"), None);
    }

    #[test]
    fn plain_text_to_html_escapes_special_characters() {
        assert_eq!(
            plain_text_to_description_html("A & B <tag>"),
            "<p>A &amp; B &lt;tag&gt;</p>"
        );
    }

    #[test]
    fn plain_text_to_html_splits_multiline_input_into_paragraphs() {
        assert_eq!(
            plain_text_to_description_html("Line one\nLine two"),
            "<p>Line one</p><p>Line two</p>"
        );
    }

    #[test]
    fn plain_text_to_html_returns_empty_string_for_empty_input() {
        assert_eq!(plain_text_to_description_html(""), "");
    }

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

    #[tokio::test]
    async fn list_states_parses_group_id_and_default() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/states/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "s1", "name": "Backlog", "group": "backlog", "default": false },
                    { "id": "s2", "name": "In Progress", "group": "started", "default": true },
                    { "id": "s3", "name": "In Review", "group": "started", "default": false }
                ]
            })))
            .mount(&server)
            .await;

        let states = client_for(&server).await.list_states("p1").await.unwrap();
        assert_eq!(states.len(), 3);
        assert_eq!(states[0].id, "s1");
        assert_eq!(states[0].group, "backlog");
        assert_eq!(states[0].project_id, "p1");
        assert!(!states[0].default);
        assert!(states[1].default);
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

    #[tokio::test]
    async fn list_comments_parses_results_with_actor_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/comments/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "c1", "comment_html": "<p>hello</p>", "actor": "u1" },
                    { "id": "c2", "comment_html": "<p>hi</p>", "created_by": "u2" }
                ]
            })))
            .mount(&server)
            .await;

        let comments = client_for(&server).await.list_comments("p1", "i1").await.unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].actor, "u1");
        assert_eq!(comments[1].actor, "u2"); // actor 없으면 created_by로 폴백
        assert_eq!(comments[0].comment_html, "<p>hello</p>");
    }

    #[tokio::test]
    async fn create_comment_posts_comment_html() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/comments/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "comment_html": "<p>🔔 할당을 확인했습니다 (Quick Dock)</p>"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        client_for(&server)
            .await
            .create_comment("p1", "i1", "<p>🔔 할당을 확인했습니다 (Quick Dock)</p>")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_activities_parses_field_and_actor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/activities/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "field": null, "actor": "creator-id" },
                    { "field": "assignees", "actor": "pm-id" }
                ]
            })))
            .mount(&server)
            .await;

        let acts = client_for(&server).await.list_activities("p1", "i1").await.unwrap();
        assert_eq!(acts.len(), 2);
        assert_eq!(acts[1].field.as_deref(), Some("assignees"));
        assert_eq!(acts[1].actor.as_deref(), Some("pm-id"));
    }

    #[test]
    fn find_assigner_prefers_latest_assignee_activity_by_someone_else() {
        let acts = vec![
            Activity { field: Some("assignees".into()), actor: Some("me".into()) },
            Activity { field: Some("assignees".into()), actor: Some("pm".into()) },
            Activity { field: Some("priority".into()), actor: Some("other".into()) },
        ];
        assert_eq!(find_assigner(&acts, Some("creator"), "me"), Some("pm".to_string()));
    }

    #[test]
    fn find_assigner_falls_back_to_created_by() {
        // assignee 활동이 없거나 전부 내 것이면 created_by (내가 아닐 때만)
        let acts = vec![Activity { field: Some("assignees".into()), actor: Some("me".into()) }];
        assert_eq!(find_assigner(&acts, Some("creator"), "me"), Some("creator".to_string()));
        assert_eq!(find_assigner(&[], Some("me"), "me"), None);
        assert_eq!(find_assigner(&[], None, "me"), None);
    }

    #[tokio::test]
    async fn list_work_items_parses_created_by() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{
                    "id": "i1", "name": "Fix bug", "priority": "none",
                    "state": { "group": "started" },
                    "assignees": [{ "id": "me" }],
                    "created_by": "pm-id"
                }]
            })))
            .mount(&server)
            .await;

        let items = client_for(&server).await.list_work_items("p1").await.unwrap();
        assert_eq!(items[0].created_by.as_deref(), Some("pm-id"));
    }
}
