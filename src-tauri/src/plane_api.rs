use serde::Deserialize;

/// Part B(맡긴 작업 창)가 이 문자열로 확인 여부를 판정한다 — 절대 바꾸지 말 것.
pub const ACK_COMMENT_TEXT: &str = "🔔 할당을 확인했습니다 (Quick Dock)";

/// `list_work_items`가 프로젝트당 한 번에 가져오는 작업 개수. Plane 공개 v1 API는
/// 담당자/상태로 서버사이드 필터링을 지원하지 않아(내부 전용 API만 지원, 세션 쿠키
/// 인증 필요 — API Key로는 못 씀) 프로젝트의 전체 작업을 가져온 뒤 클라이언트에서
/// 거른다. 응답은 기본적으로 `-created_at`(최신순)이고 cursor 페이지네이션은
/// 따라가지 않으므로, 한 프로젝트의 전체 작업 수(완료/취소 포함)가 이 값을 넘으면
/// 가장 오래된 작업부터 조용히 누락된다. 실측상 서버의 실제 최대치는 1000(공개
/// 문서엔 100이라 적혀 있으나 실제 코드 기준)이라 필요하면 최대 1000까지 올릴 수
/// 있다 — 참고: `C:\WorkSpaces\plane`(자체 호스팅 서버 소스) 및 CLAUDE.md.
pub const WORK_ITEMS_PER_PAGE: u32 = 500;

/// `list_cycles`/`list_cycle_issue_ids`가 한 번에 가져오는 개수. 두 엔드포인트도
/// cursor 페이지네이션을 따라가지 않으므로, 한 프로젝트의 사이클 수 또는 한
/// 사이클의 작업 수가 이 값을 넘으면 나머지가 조용히 누락된다(`list_cycles`는
/// 오래된 사이클, `list_cycle_issue_ids`는 그 사이클의 일부 작업 소속이 빠진다).
/// `WORK_ITEMS_PER_PAGE`와 같은 값으로 맞춘다 — 서버의 실제 최대치는 여기서도
/// 1000(공개 문서엔 100)이라 필요하면 더 올릴 수 있다.
const CYCLE_LIST_PER_PAGE: u32 = 500;

#[derive(Debug, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub identifier: String,
    /// 프로젝트에서 사이클 기능을 켰는지. 꺼져 있으면 cycles/ 조차 부르지 않는다.
    pub cycle_view: bool,
}

#[derive(Debug, Clone)]
pub struct Cycle {
    pub id: String,
    pub name: String,
    pub project_id: String,
    /// "YYYY-MM-DD" 또는 UTC 타임스탬프. 초안 사이클은 둘 다 None이다.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

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
    pub updated_at: Option<String>,
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
    pub updated_at: Option<String>,
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

/// 지난 사이클을 프로젝트마다 최대 몇 개까지 가져올지. 2주 스프린트 기준 약
/// 3개월. 이보다 오래된 사이클에 남은 미완료 작업은 "사이클 없음"에 들어간다 —
/// 사이드바는 미완료와 오늘 완료된 작업만 보여주므로 실제로 드문 경우다.
const PAST_CYCLE_LIMIT: usize = 6;

/// 소속을 받아올 사이클을 고른다. 진행 중·예정·날짜 미정은 전부 남기고,
/// 이미 끝난 것은 종료일이 최신인 PAST_CYCLE_LIMIT개까지만 남긴다.
/// `today`는 "YYYY-MM-DD".
pub fn select_cycles_to_fetch(cycles: &[Cycle], today: &str) -> Vec<Cycle> {
    let ended = |c: &Cycle| -> Option<String> {
        // 타임스탬프면 날짜 부분만 본다. UTC와 로컬이 갈리는 자정 경계에서
        // 하루 어긋날 수 있지만, 그 경우 어느 쪽으로 갈려도 최신 6개 안에 든다.
        // end_date가 있는데 10바이트보다 짧거나 문자 경계가 아니면 `get(..10)`이
        // None을 돌려줘 이 사이클은 "아직 안 끝남"으로 취급되어 keep에 남는다 —
        // 패닉 없이 안전하게 과거 사이클 개수 상한 계산에서만 빠지는 선택이다.
        let end = c.end_date.as_deref()?;
        let day = end.get(..10)?.to_string();
        if day.as_str() < today { Some(day) } else { None }
    };
    let mut keep: Vec<Cycle> = Vec::new();
    let mut past: Vec<(String, Cycle)> = Vec::new();
    for c in cycles {
        match ended(c) {
            Some(day) => past.push((day, c.clone())),
            None => keep.push(c.clone()),
        }
    }
    past.sort_by(|a, b| b.0.cmp(&a.0));
    keep.extend(past.into_iter().take(PAST_CYCLE_LIMIT).map(|(_, c)| c));
    keep
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

/// "내가 할당한 작업" 탭의 필터. `created_by == user_id` AND 내가 담당자에
/// 없음. Plane API에는 "누가 할당했는가"를 나타내는 필드가 없으므로, 이는
/// "작업을 만든 사람이 그 자리에서 담당자를 지정한다"는 근사치다 — 남이
/// 만든 작업을 내가 나중에 제3자에게 재할당한 경우는 잡히지 않는다.
/// 완료 항목의 날짜창은 여기서 적용하지 않는다 — 프론트엔드의 "오늘만
/// 보기" 토글이 API 재호출 없이 동작해야 하므로, 그 필터링은
/// `filterVisibleToday`(TS)가 맡는다.
pub fn filter_delegated_visible(items: Vec<WorkItem>, user_id: &str) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|i| i.created_by.as_deref() == Some(user_id))
        .filter(|i| !i.assignee_ids.iter().any(|a| a == user_id))
        .filter(|i| i.state_group != "cancelled")
        .collect()
}

#[derive(Deserialize)]
struct Paginated<T> { results: Vec<T> }

#[derive(Deserialize)]
struct RawProject {
    id: String,
    name: String,
    #[serde(default)] identifier: String,
    #[serde(default)] is_member: bool,
    /// 응답에 없으면 켜진 것으로 본다 — 없다고 사이클을 못 보게 하면
    /// 서버 버전 차이가 조용한 기능 상실이 된다.
    #[serde(default = "default_true")] cycle_view: bool,
}

fn default_true() -> bool { true }

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
    #[serde(default)] updated_at: Option<String>,
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
struct RawCycle {
    id: String,
    #[serde(default)] name: String,
    start_date: Option<String>,
    end_date: Option<String>,
}

/// cycle-issues/ 행에서 필요한 건 작업 id뿐이다 (cycle id는 요청 경로로 이미 안다).
#[derive(Deserialize)]
struct RawCycleIssue { issue: String }

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

/// True when `err` (a String produced by this client's methods) reflects a
/// network-transport failure (server unreachable, timeout, DNS, TLS) rather
/// than a server-side rejection. `error_with_body` always formats HTTP error
/// responses as `"HTTP {status} (...)"`; every other error string in this
/// file comes from `reqwest`'s own `Display`, which never starts with that
/// prefix. Used by the offline queue to decide "queue for later" vs
/// "show the user a real error right now".
pub fn is_network_error(err: &str) -> bool {
    !err.starts_with("HTTP ")
}

/// True when `err` is specifically an HTTP 404 — used to distinguish "the
/// item was deleted on the server" from other errors during offline replay.
pub fn is_not_found_error(err: &str) -> bool {
    err.starts_with("HTTP 404")
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

    /// `current_user`의 캐시 버전. 같은 토큰이 가리키는 사용자는 변하지
    /// 않으므로 (base_url, api_key)당 최초 1회만 서버에 묻는다 — `/users/me/`는
    /// 동기화·할당 감지·빠른 추가 등 거의 모든 흐름의 첫 요청이라, 매번
    /// 재조회하면 Plane의 API 키당 분당 요청 한도를 그 호출들만으로 갉아먹는다.
    /// 연결 상태 확인이 목적인 곳(오프라인 프로브)은 이걸 쓰면 안 된다.
    pub async fn current_user_cached(&self) -> Result<CurrentUser, String> {
        static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CurrentUser>>> =
            std::sync::OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let key = format!("{}\n{}", self.base_url, self.api_key);
        if let Some(user) = cache.lock().unwrap().get(&key) {
            return Ok(user.clone());
        }
        let user = self.current_user().await?;
        cache.lock().unwrap().insert(key, user.clone());
        Ok(user)
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
            .map(|p| Project {
                id: p.id,
                name: p.name,
                identifier: p.identifier,
                cycle_view: p.cycle_view,
            })
            .collect())
    }

    pub async fn list_work_items(&self, project_id: &str) -> Result<Vec<WorkItem>, String> {
        let url = format!(
            "{}/projects/{}/work-items/?expand=assignees,state&per_page={}",
            self.ws_base(),
            project_id,
            WORK_ITEMS_PER_PAGE
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

    pub async fn list_cycles(&self, project_id: &str) -> Result<Vec<Cycle>, String> {
        let url = format!("{}/projects/{}/cycles/?per_page={}", self.ws_base(), project_id, CYCLE_LIST_PER_PAGE);
        let page: Paginated<RawCycle> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page
            .results
            .into_iter()
            .map(|c| Cycle {
                id: c.id,
                name: c.name,
                project_id: project_id.to_string(),
                start_date: c.start_date,
                end_date: c.end_date,
            })
            .collect())
    }

    /// 사이클에 속한 작업 id 목록. Plane의 work-items 응답에는 cycle 필드가
    /// 없어(IssueSerializer에 정의되지 않아 expand=cycle도 통하지 않는다)
    /// 소속은 이 엔드포인트로만 알 수 있다.
    pub async fn list_cycle_issue_ids(
        &self,
        project_id: &str,
        cycle_id: &str,
    ) -> Result<Vec<String>, String> {
        let url = format!(
            "{}/projects/{}/cycles/{}/cycle-issues/?per_page={}",
            self.ws_base(),
            project_id,
            cycle_id,
            CYCLE_LIST_PER_PAGE
        );
        let page: Paginated<RawCycleIssue> =
            self.get_json(&url).await?.json().await.map_err(|e| e.to_string())?;
        Ok(page.results.into_iter().map(|c| c.issue).collect())
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
    ) -> Result<String, String> {
        // The create endpoint (no `expand` param) returns `assignees`/`state` as
        // flat id strings, not the nested objects `RawWorkItem` expects (that
        // shape only applies to the `expand=assignees,state` list endpoint).
        // We only need the new item's own id from the response.
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
        let resp = self
            .send_retrying(
                self.http
                    .post(&url)
                    .header("X-Api-Key", &self.api_key)
                    .json(&serde_json::Value::Object(body)),
            )
            .await?;
        #[derive(Deserialize)]
        struct CreatedId {
            id: String,
        }
        let created: CreatedId = resp.json().await.map_err(|e| e.to_string())?;
        Ok(created.id)
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
        updated_at: w.updated_at,
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
        updated_at: w.updated_at,
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
            updated_at: None,
        }
    }

    fn wi_created_by(id: &str, group: &str, assignees: &[&str], created_by: Option<&str>) -> WorkItem {
        let mut item = wi(id, group, assignees);
        item.created_by = created_by.map(|s| s.to_string());
        item
    }

    #[test]
    fn filter_delegated_keeps_my_created_items_not_assigned_to_me() {
        let items = vec![
            wi_created_by("a", "started", &["other"], Some("me")), // keep: created by me, assigned to other
            wi_created_by("b", "started", &["me"], Some("me")),    // drop: assigned to me too
            wi_created_by("c", "started", &["other"], Some("someone_else")), // drop: not created by me
            wi_created_by("d", "started", &["other"], None),       // drop: no created_by
            wi_created_by("e", "cancelled", &["other"], Some("me")), // drop: cancelled
            wi_created_by("f", "started", &["a", "b"], Some("me")), // keep: multiple assignees, none is me
        ];
        let kept = filter_delegated_visible(items, "me");
        let ids: Vec<_> = kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "f"]);
    }

    #[test]
    fn filter_delegated_ignores_completed_date_entirely() {
        // 날짜창은 프론트엔드가 적용한다 — 백엔드는 완료 여부/날짜와 무관하게 다 넘긴다.
        let items = vec![
            wi_created_by("old", "completed", &["other"], Some("me")),
        ];
        let kept = filter_delegated_visible(items, "me");
        assert_eq!(kept.len(), 1);
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
    async fn list_projects_defaults_cycle_view_to_true_when_field_is_absent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "p1", "name": "Web App", "identifier": "WEB", "is_member": true }
                ]
            })))
            .mount(&server)
            .await;

        let projects = client_for(&server).await.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert!(projects[0].cycle_view);
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
                    "completed_at": "2026-07-01T09:00:00Z",
                    "updated_at": "2026-07-01T10:00:00Z"
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
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-01T10:00:00Z"));
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
                "description_html": "<p>Steps to repro</p>",
                "updated_at": "2026-07-05T08:00:00Z"
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
        assert_eq!(detail.updated_at.as_deref(), Some("2026-07-05T08:00:00Z"));
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
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "new-item-1" })))
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
        let id = client_for(&server).await.create_work_item("p1", &item).await.unwrap();
        assert_eq!(id, "new-item-1");
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
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "new-item-2" })))
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
        let id = client_for(&server).await.create_work_item("p1", &item).await.unwrap();
        assert_eq!(id, "new-item-2");
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

    #[tokio::test]
    async fn current_user_cached_hits_the_server_only_once() {
        let server = MockServer::start().await;
        // expect(1): 두 번째 호출이 서버로 다시 나가면 wiremock 검증이 실패한다.
        // 캐시 키에 base_url이 들어가므로 (MockServer는 테스트마다 포트가 다름)
        // 병렬로 도는 다른 테스트와 캐시가 섞이지 않는다.
        Mock::given(method("GET"))
            .and(path("/api/v1/users/me/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "me", "display_name": "Aoperat"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = client_for(&server).await;
        let first = client.current_user_cached().await.unwrap();
        let second = client.current_user_cached().await.unwrap();
        assert_eq!(first.id, "me");
        assert_eq!(second.id, "me");
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

    #[test]
    fn is_network_error_distinguishes_http_status_from_transport_failure() {
        assert!(!is_network_error("HTTP 400 Bad Request (http://x): oops"));
        assert!(is_network_error("error sending request for url (http://x/): connection refused"));
    }

    #[test]
    fn is_not_found_error_only_matches_http_404() {
        assert!(is_not_found_error("HTTP 404 Not Found (http://x): oops"));
        assert!(!is_not_found_error("HTTP 400 Bad Request (http://x): oops"));
        assert!(!is_not_found_error("error sending request for url (http://x/): connection refused"));
    }

    fn cyc(id: &str, end: Option<&str>) -> Cycle {
        Cycle {
            id: id.into(),
            name: format!("c{id}"),
            project_id: "p1".into(),
            start_date: Some("2026-01-01".into()),
            end_date: end.map(|e| e.into()),
        }
    }

    #[test]
    fn select_cycles_keeps_every_running_upcoming_and_undated_cycle() {
        let cycles = vec![
            cyc("running", Some("2026-07-25")),
            cyc("upcoming", Some("2026-09-01")),
            cyc("undated", None),
        ];
        let picked = select_cycles_to_fetch(&cycles, "2026-07-22");
        let mut ids: Vec<&str> = picked.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["running", "undated", "upcoming"]);
    }

    #[test]
    fn select_cycles_keeps_only_the_six_most_recently_ended_past_cycles() {
        let mut cycles = vec![cyc("live", Some("2026-08-01"))];
        // 2026-07-01 부터 하루씩 앞당겨 지난 사이클 8개
        for i in 1..=8 {
            cycles.push(cyc(&format!("past{i}"), Some(&format!("2026-07-{:02}", 21 - i))));
        }
        let picked = select_cycles_to_fetch(&cycles, "2026-07-22");
        let ids: Vec<&str> = picked.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"live"));
        // 종료일이 최신인 6개(past1..past6)만 남고 past7/past8은 빠진다.
        for keep in ["past1", "past6"] {
            assert!(ids.contains(&keep), "{keep} should be kept, got {ids:?}");
        }
        for drop in ["past7", "past8"] {
            assert!(!ids.contains(&drop), "{drop} should be dropped, got {ids:?}");
        }
        assert_eq!(picked.len(), 7);
    }

    #[test]
    fn select_cycles_treats_a_cycle_ending_today_as_still_running() {
        let cycles = vec![cyc("today", Some("2026-07-22T14:59:59Z"))];
        assert_eq!(select_cycles_to_fetch(&cycles, "2026-07-22").len(), 1);
    }

    #[tokio::test]
    async fn list_cycles_parses_names_and_dates() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "c1", "name": "Sprint 12", "start_date": "2026-07-13", "end_date": "2026-07-25" },
                    { "id": "c2", "name": "초안", "start_date": null, "end_date": null }
                ]
            })))
            .mount(&server)
            .await;
        let client = client_for(&server).await;
        let cycles = client.list_cycles("p1").await.unwrap();
        assert_eq!(cycles.len(), 2);
        assert_eq!(cycles[0].name, "Sprint 12");
        assert_eq!(cycles[0].project_id, "p1");
        assert_eq!(cycles[0].end_date.as_deref(), Some("2026-07-25"));
        assert_eq!(cycles[1].start_date, None);
    }

    #[tokio::test]
    async fn list_cycle_issue_ids_returns_just_the_issue_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/c1/cycle-issues/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "ci1", "issue": "i1", "cycle": "c1" },
                    { "id": "ci2", "issue": "i2", "cycle": "c1" }
                ]
            })))
            .mount(&server)
            .await;
        let client = client_for(&server).await;
        assert_eq!(client.list_cycle_issue_ids("p1", "c1").await.unwrap(), vec!["i1", "i2"]);
    }
}
