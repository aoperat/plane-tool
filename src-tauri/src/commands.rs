use crate::config;
use tauri::{Emitter, Manager};
use crate::plane_api::{self, filter_assigned_visible, filter_delegated_visible, plain_text_to_description_html, resolve_state_id, Member, MngApiError, MngDailyReportsResponse, MngDailyRow, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
use crate::mng_report;
use serde::{Serialize, Deserialize};
use crate::assign_watch;
use std::collections::HashSet;
use futures::stream::{self, StreamExt};

/// 사이드바 동기화 시 프로젝트별로 동시에 날릴 요청 개수. 너무 높이면 Plane
/// 서버의 rate limit(429)에 걸리기 쉬워지므로 적당한 값으로 고정한다.
const SYNC_CONCURRENCY: usize = 6;

/// mng 프로젝트 검색 한 페이지 크기. 창의 목록이 한 화면에 담기는 정도로 잡는다 —
/// 크게 잡으면 mng 응답이 느려지고, 작게 잡으면 페이지를 계속 넘겨야 한다.
const MNG_SEARCH_PER_PAGE: u32 = 20;

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
    pub deadline_notify_enabled: bool,
    pub deadline_notify_time: String,
    pub deadline_lead_days: u32,
    pub show_delegated_tab: bool,
    pub quickadd_layout: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectDto { pub id: String, pub name: String, pub identifier: String }

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct CycleDto {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CycleDataDto {
    pub cycles: Vec<CycleDto>,
    /// 작업 id → 사이클 id. 사이클은 작업당 최대 1개라 맵으로 충분하다.
    pub item_cycle: std::collections::HashMap<String, String>,
    /// 요청 실패로 통째로 건너뛴 프로젝트가 하나라도 있으면 true —
    /// 즉 이 응답은 "성공했지만 불완전"하다. 건너뛴 프로젝트는 사이클을 안
    /// 쓰는 프로젝트와 화면에서 구분되지 않으므로, 이 표시가 없으면
    /// 프론트엔드가 열화된 결과를 온전한 것으로 캐시해 한동안 재시도조차
    /// 하지 않는다.
    pub is_partial: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidebarData {
    pub projects: Vec<ProjectDto>,
    pub assigned: Vec<WorkItemDto>,
    /// 내가 만들었지만 담당자가 아닌 작업("내가 할당한 작업" 탭). 완료
    /// 항목의 날짜창은 적용되지 않은 전체 목록 — 필터링은 프론트엔드가 한다.
    #[serde(default)]
    pub delegated: Vec<WorkItemDto>,
    /// `delegated`에 속한 작업들의 담당자 이름 해결용. 프로젝트 간 중복은
    /// id 기준으로 제거되어 있다.
    #[serde(default)]
    pub delegated_members: Vec<MemberDto>,
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
    let delegated = filter_delegated_visible(items.clone(), user_id)
        .into_iter()
        .map(work_item_to_dto)
        .collect();
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(work_item_to_dto)
        .collect();
    let projects = projects
        .into_iter()
        .map(|p| ProjectDto { id: p.id, name: p.name, identifier: p.identifier })
        .collect();
    let states = states
        .into_iter()
        .map(|s| StateDto { id: s.id, group: s.group, project_id: s.project_id, default: s.default })
        .collect();
    SidebarData {
        projects, assigned, delegated,
        delegated_members: Vec::new(), // fetch_sidebar_data_online이 채운다 (Task 3)
        states, is_cached: false, cached_at_ms: None,
    }
}

fn work_item_to_dto(w: WorkItem) -> WorkItemDto {
    WorkItemDto {
        id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
        start_date: w.start_date,
        state_group: w.state_group, project_id: w.project_id,
        assignee_ids: w.assignee_ids,
        completed_at: w.completed_at,
        created_at: w.created_at, updated_at: w.updated_at,
    }
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
        deadline_notify_enabled: s.deadline_notify_enabled,
        deadline_notify_time: s.deadline_notify_time,
        deadline_lead_days: s.deadline_lead_days,
        show_delegated_tab: s.show_delegated_tab,
        quickadd_layout: s.quickadd_layout,
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
    deadline_notify_enabled: Option<bool>,
    deadline_notify_time: Option<String>,
    deadline_lead_days: Option<u32>,
    show_delegated_tab: Option<bool>,
    quickadd_layout: Option<String>,
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
    if let Some(v) = deadline_notify_enabled { s.deadline_notify_enabled = v; }
    if let Some(v) = deadline_notify_time {
        let ok = v.len() == 5 && v.as_bytes()[2] == b':'
            && v[0..2].parse::<u32>().map_or(false, |h| h < 24)
            && v[3..5].parse::<u32>().map_or(false, |m| m < 60);
        if ok { s.deadline_notify_time = v; }
    }
    if let Some(v) = deadline_lead_days { if v >= 1 { s.deadline_lead_days = v; } }
    if let Some(v) = show_delegated_tab { s.show_delegated_tab = v; }
    if let Some(v) = quickadd_layout {
        if v == "compact" || v == "expanded" { s.quickadd_layout = v; }
    }
    // 재시작 없이 즉시 반영. 등록에 실패하면(다른 앱이 선점 등) 아무것도
    // 저장하지 않고 에러를 돌려줘서 설정 파일과 실제 등록 상태를 일치시킨다.
    if shortcuts_changed {
        crate::reapply_shortcuts(&app, &s.quickadd_shortcut, &s.sidebar_shortcut)?;
    }
    config::save_settings(&app, &s)?;
    // 빠른 추가 창은 재로드되지 않는다 — 설정이 바뀌었음을 알려 렌더러를 갈아끼우게 한다.
    let _ = app.emit_to("quickadd", "settings-changed", ());
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

/// "내가 할당한 작업" 탭을 켤 때 요구하는 비밀번호. 진짜 보안이 아니라
/// 가벼운 프라이버시 잠금이다 — 이 상수는 앱 바이너리를 디컴파일하면
/// 누구나 알아낼 수 있다. 목적은 즉흥적으로 체크박스를 켜는 것을 막는
/// 정도.
const DELEGATED_TAB_PASSWORD: &str = "16006937";

#[tauri::command]
pub fn verify_delegated_tab_password(password: String) -> bool {
    password == DELEGATED_TAB_PASSWORD
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
        let user = client.current_user_cached().await?;
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
            // 새 항목은 서버가 id 등을 부여하므로 로컬 패치로는 표현할 수 없어
            // 전체 재동기화를 요청한다 — 생성은 드물어서 rate limit에 부담이 없고,
            // 포커스 갱신 쿨다운이 길어진 뒤에도 새 항목이 바로 보이게 한다.
            crate::emit_shared_item_event(&app, "refresh-sidebar", ());
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
            // 오프라인 새로고침은 방금 placeholder가 삽입된 캐시를 그대로
            // 돌려주므로, 여기서도 새 항목이 즉시 보인다.
            crate::emit_shared_item_event(&app, "refresh-sidebar", ());
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

/// 사이클 목록과 작업↔사이클 소속을 가져온다. `fetch_sidebar_data`와 별도인
/// 이유는 두 가지다 — (1) 사용자가 사이클별 보기를 고르기 전에는 요청이
/// 한 건도 나가지 않아야 하고, (2) 소속은 작업 목록보다 훨씬 덜 바뀌어
/// 갱신 주기를 따로 가져가기 때문이다(캐시는 프론트엔드가 관리한다).
/// `today`는 "YYYY-MM-DD" — 사용자 로컬 날짜는 프론트엔드가 안다
/// (`fetch_sidebar_data`가 날짜창을 받는 것과 같은 이유).
///
/// 실제 동작은 `fetch_cycle_data_online`에 있다 — 단위 테스트에서
/// `tauri::AppHandle` 없이 `&PlaneClient`만으로 호출할 수 있도록 커맨드
/// 본체를 분리했다.
#[tauri::command]
pub async fn fetch_cycle_data(
    app: tauri::AppHandle,
    today: String,
) -> Result<CycleDataDto, String> {
    let (client, _s) = client(&app)?;
    fetch_cycle_data_online(&client, &today).await
}

/// 프로젝트를 순차로 도는 것은 의도적이다 — `fetch_sidebar_data_online`은
/// `buffer_unordered`로 병렬화하지만, 여기서는 사이클마다 요청이 한 건씩 더
/// 붙어 총 요청 수가 훨씬 많다. 다만 순차 실행이 막아 주는 것은 **동시성**
/// 이지 **속도(rate)**가 아니다 — 순차라도 빠른 서버에서는 수십 건이 몇 초
/// 만에 나가므로 이것만으로 Plane의 API 키당 60 req/min 안에 들어간다는
/// 보장은 없다. rate limit을 실제로 지켜 주는 건 `get_json`의 429/`Retry-After`
/// 처리이고, 10분 캐시가 평균 요청량을 낮게 유지한다. 한 번의 버스트가
/// 한도를 넘길 수 있다는 문제는 아직 남아 있다.
///
/// 프로젝트 하나에서 요청이 실패해도(`list_cycles` 자체든, 그 안의 어느
/// 사이클의 `list_cycle_issue_ids`든) 전체 커맨드를 중단하지 않고 그
/// 프로젝트만 건너뛴다 — `fetch_sidebar_data_online`("한쪽이 실패해도 다른
/// 쪽은 그대로 쓴다")과 같은 관례다. 단, 프로젝트 하나가 기여하는 사이클
/// 데이터는 **전부 아니면 전무**여야 한다: `list_cycles`는 성공했는데 그중
/// 한 사이클의 `list_cycle_issue_ids`만 실패했다고 그 사이클만 건너뛰고
/// `CycleDto`는 그대로 남기면, 실제로는 그 사이클에 속한 작업들이
/// `item_cycle`에 안 들어가 프론트엔드(`splitByCycle`)가 "사이클 없음"으로
/// 잘못 분류한다 — 조용히 틀린 분류는 아예 안 보이는 것보다 나쁘다. 그래서
/// 프로젝트별로 `fetch_project_cycle_data`가 사이클·소속을 로컬 임시 변수에
/// 모았다가, 그 프로젝트의 모든 요청이 성공했을 때만 통째로 반영한다.
/// 실패한 프로젝트는 사이클을 하나도 못 받은 것처럼 취급되어(`cycle_view`가
/// 꺼진 프로젝트와 시각적으로 동일하게 평범한 목록으로) 표시된다 — 이건
/// 정직한 열화다. `list_projects` 실패만은 그대로 전체 커맨드를 실패시킨다
/// (프로젝트 목록 자체가 없으면 애초에 할 일이 없다).
async fn fetch_cycle_data_online(client: &PlaneClient, today: &str) -> Result<CycleDataDto, String> {
    let projects = client.list_projects().await?;
    let mut cycles: Vec<CycleDto> = Vec::new();
    let mut item_cycle = std::collections::HashMap::new();
    let mut is_partial = false;
    for p in projects.iter().filter(|p| p.cycle_view) {
        match fetch_project_cycle_data(client, &p.id, today).await {
            Ok((mut project_cycles, project_item_cycle)) => {
                cycles.append(&mut project_cycles);
                item_cycle.extend(project_item_cycle);
            }
            // 건너뛴 프로젝트가 있었다는 사실만 남긴다 — 열화 자체는 그대로 두되
            // 호출부가 이 결과를 온전한 것으로 오해하지 않게 한다.
            Err(_) => is_partial = true,
        }
    }
    Ok(CycleDataDto { cycles, item_cycle, is_partial })
}

/// 프로젝트 하나의 사이클·소속을 가져온다. 도중에 어떤 요청이든 실패하면
/// 그 시점까지 모은 것도 전부 버리고 `Err`를 돌려준다 — 호출부
/// (`fetch_cycle_data_online`)가 이 프로젝트를 통째로 건너뛸 수 있도록.
async fn fetch_project_cycle_data(
    client: &PlaneClient,
    project_id: &str,
    today: &str,
) -> Result<(Vec<CycleDto>, std::collections::HashMap<String, String>), String> {
    let all = client.list_cycles(project_id).await?;
    let mut cycles = Vec::new();
    let mut item_cycle = std::collections::HashMap::new();
    for c in plane_api::select_cycles_to_fetch(&all, today) {
        for issue_id in client.list_cycle_issue_ids(project_id, &c.id).await? {
            item_cycle.insert(issue_id, c.id.clone());
        }
        cycles.push(CycleDto {
            id: c.id,
            name: c.name,
            project_id: c.project_id,
            start_date: c.start_date,
            end_date: c.end_date,
        });
    }
    Ok((cycles, item_cycle))
}

async fn fetch_sidebar_data_online(
    client: &PlaneClient,
    completed_after: &str,
    completed_before: &str,
) -> Result<SidebarData, String> {
    let user = client.current_user_cached().await?;
    let projects = client.list_projects().await?;

    // 프로젝트당 work-items/states를 동시에, 프로젝트 간에도 최대
    // SYNC_CONCURRENCY개까지 동시에 보낸다 — 예전에는 프로젝트 수만큼
    // 순차로 기다렸다(N+1). 한쪽이 실패해도 다른 쪽은 그대로 쓴다.
    let per_project: Vec<(Vec<WorkItem>, Vec<ProjectState>)> = stream::iter(projects.clone())
        .map(move |p| async move {
            let (items, states) = tokio::join!(client.list_work_items(&p.id), client.list_states(&p.id));
            (items.unwrap_or_default(), states.unwrap_or_default())
        })
        .buffer_unordered(SYNC_CONCURRENCY)
        .collect()
        .await;

    let mut all_items: Vec<WorkItem> = Vec::new();
    let mut all_states: Vec<ProjectState> = Vec::new();
    for (mut items, mut states) in per_project {
        all_items.append(&mut items);
        all_states.append(&mut states);
    }
    let mut data = assemble_sidebar(&user.id, projects, all_items, all_states, completed_after, completed_before);
    data.delegated_members = fetch_delegated_members(client, &data.delegated, &user.id).await;
    Ok(data)
}

/// `delegated`에 등장하는 프로젝트에 한해서만(전체 프로젝트가 아니라)
/// 멤버 목록을 조회해 이름을 해결한다 — 위임 작업이 없으면 추가 API 호출도
/// 없다. 같은 사용자가 여러 프로젝트에 걸쳐 나오면 id 기준으로 dedupe한다.
/// 멤버 조회가 실패한 프로젝트는 조용히 건너뛴다(items/states 루프와 같은
/// 관례) — 실패해도 프론트엔드가 "알 수 없음"으로 폴백하므로 안전하다.
async fn fetch_delegated_members(
    client: &PlaneClient,
    delegated: &[WorkItemDto],
    my_id: &str,
) -> Vec<MemberDto> {
    let project_ids: HashSet<String> = delegated.iter().map(|i| i.project_id.clone()).collect();
    let per_project: Vec<Vec<Member>> = stream::iter(project_ids)
        .map(move |pid| async move { client.list_members(&pid).await.unwrap_or_default() })
        .buffer_unordered(SYNC_CONCURRENCY)
        .collect()
        .await;

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<MemberDto> = Vec::new();
    for members in per_project {
        for m in members {
            if seen.insert(m.id.clone()) {
                let is_me = m.id == my_id;
                out.push(MemberDto { id: m.id, display_name: m.display_name, is_me });
            }
        }
    }
    out
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
    // 성공 시 전체 재동기화(refresh-sidebar) 대신 바뀐 필드만 알린다 —
    // 사이드바가 로컬 데이터를 패치해 즉시 반영하므로, 수정할 때마다
    // 프로젝트별 N+1 재조회 묶음이 나가 rate limit을 갉아먹는 일이 없다.
    let changed = serde_json::json!({
        "project_id": project_id, "item_id": item_id,
        "name": name, "assignee_ids": assignee_ids,
        "start_date": start_date, "target_date": target_date,
        "priority": priority, "state_group": state_group,
    });
    match result {
        Ok(()) => {
            crate::emit_shared_item_event(&app, "item-updated", changed);
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
            .await?;
            // 오프라인 큐잉도 화면 반영은 동일하게 — 캐시는 위에서 패치됐고,
            // 열려 있는 사이드바에는 이 이벤트가 즉시 반영한다.
            crate::emit_shared_item_event(&app, "item-updated", changed);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    // 삭제도 전체 재동기화 대신 해당 항목 제거만 알린다 (item-updated와 같은 이유).
    let removed = serde_json::json!({ "project_id": project_id, "item_id": item_id });
    match client.delete_work_item(&project_id, &item_id).await {
        Ok(()) => {
            crate::emit_shared_item_event(&app, "item-deleted", removed);
            Ok(())
        }
        Err(e) if plane_api::is_network_error(&e) => {
            crate::offline::queue_delete_and_remove(&app, &project_id, &item_id).await?;
            crate::emit_shared_item_event(&app, "item-deleted", removed);
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
    let user = client.current_user_cached().await?;
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

/// 작업 항목 URL을 기본 브라우저로 연다.
#[tauri::command]
pub fn open_issue_popup(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
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

// QuickAdd's own project dropdown needs the same persist-on-select behavior as
// show_quickadd_for_project above — otherwise a focus-triggered load() (window
// re-summoned after alt-tabbing away) resolves last_project_id back to the
// project that was selected before the in-window switch.
#[tauri::command]
pub fn set_last_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    config::set_last_project(&app, &project_id)
}

/// 프로젝트 검색 창을 연다. 빠른 추가 창 안에서 드롭다운으로 열던 것을 자체 크기를
/// 갖는 창으로 뺐다 — 창 높이를 목록 길이에 맞춰 늘리던 방식은 화면 아래 끝을 넘어가
/// 잘렸다(설계: docs/superpowers/specs/2026-08-14-project-picker-window-design.md).
///
/// `requester`는 고른 결과를 돌려받을 창의 label이다. 지금은 "quickadd"만 넘어오지만,
/// mng 업무일지·사이드바가 같은 창을 쓰게 될 때 이 인자만으로 붙는다.
#[tauri::command]
pub fn open_project_picker(app: tauri::AppHandle, requester: String, selected_id: Option<String>) {
    // 창을 먼저 띄우고 이벤트를 보낸다 — 반대 순서면 아직 숨어 있는 창의 리스너가
    // 못 받는 경우가 생긴다(editmodal의 open_edit_modal과 같은 순서).
    crate::show_centered(&app, "projectpicker");
    let _ = app.emit_to(
        "projectpicker",
        "picker-open",
        serde_json::json!({ "requester": requester, "selectedId": selected_id }),
    );
}

/// 프로젝트 검색 창에서 하나를 골랐다. 요청한 창에 결과를 넘기고 피커는 물러난다.
#[tauri::command]
pub fn pick_project(
    app: tauri::AppHandle,
    requester: String,
    project_id: String,
) -> Result<(), String> {
    // 저장이 emit보다 먼저다. 피커가 닫히면 요청자 창이 포커스를 되찾고, QuickAdd는
    // 그때 도는 load()에서 last_project_id로 선택을 덮어쓴다 — 나중에 저장하면 방금
    // 고른 프로젝트가 이전 값으로 되돌아간다(show_quickadd_for_project와 같은 이유).
    config::set_last_project(&app, &project_id)?;
    let _ = app.emit_to(&requester, "select-project", project_id);

    if let Some(win) = app.get_webview_window("projectpicker") {
        let _ = win.hide();
    }
    if let Some(win) = app.get_webview_window(&requester) {
        let _ = win.set_focus();
    }
    Ok(())
}

/// 피커를 고르지 않고 닫는다(Esc·포커스 잃음). 요청자 창에 포커스를 돌려준다 —
/// QuickAdd는 포커스를 받으면 제목 칸으로 커서를 되돌리므로 곧바로 타이핑을 잇는다.
#[tauri::command]
pub fn close_project_picker(app: tauri::AppHandle, requester: String, refocus: bool) {
    if let Some(win) = app.get_webview_window("projectpicker") {
        let _ = win.hide();
    }
    if refocus {
        if let Some(win) = app.get_webview_window(&requester) {
            let _ = win.set_focus();
        }
    }
}

/// 빠른 추가 헤더의 레이아웃 토글. 설정 화면의 "빠른 추가 화면" 항목과 **같은 값**을
/// 쓴다 — 진실을 둘로 만들지 않는다.
///
/// 저장 뒤 설정 창에 알리는 이유: 설정 창이 열려 있는 동안 헤더에서 토글하면 그쪽
/// `<select>`가 낡은 값을 들고 있게 되고, 그 상태로 "저장"을 누르면 방금 바꾼 값을
/// 되돌려 버린다. 빠른 추가 창에는 알리지 않는다 — 변경을 시작한 쪽이라 이미 안다.
#[tauri::command]
pub fn set_quickadd_layout(app: tauri::AppHandle, layout: String) -> Result<(), String> {
    if layout != "compact" && layout != "expanded" {
        return Err(format!("알 수 없는 레이아웃: {layout}"));
    }
    config::set_quickadd_layout(&app, &layout)?;
    let _ = app.emit_to("settings", "quickadd-layout-changed", layout);
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
    let user = client.current_user_cached().await?;
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

/// mng 업무일지 창을 설정된 디스플레이 중앙에 표시하고, 창에게 로드 신호를 보낸다.
/// `briefing`과 동일한 패턴 — 데이터는 여기서 담아 보내지 않고, 창이 뜬 뒤
/// `list_mng_targets`를 직접 호출해 최신 상태를 받아간다.
#[tauri::command]
pub fn open_mng_daily(app: tauri::AppHandle) {
    crate::show_centered(&app, "mngdaily");
    let _ = app.emit_to("mngdaily", "mngdaily-open", ());
}

#[derive(Debug, Serialize, Clone)]
pub struct MngReportItemDto {
    pub id: String,
    pub name: String,
    pub sequence_id: u64,
    pub priority: String,
    /// Plane 상태 그룹("backlog"|"unstarted"|"started"|"completed"|"cancelled").
    /// 창에서 상태를 바꿀 때 현재 값을 표시하고, 바꾼 뒤 어느 그룹으로 옮길지
    /// 판단하는 데 쓴다.
    pub state_group: String,
    pub completed_at: Option<String>,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
}

fn to_mng_item_dto(w: &WorkItem) -> MngReportItemDto {
    MngReportItemDto {
        id: w.id.clone(),
        name: w.name.clone(),
        sequence_id: w.sequence_id,
        priority: w.priority.clone(),
        state_group: w.state_group.clone(),
        completed_at: w.completed_at.clone(),
        target_date: w.target_date.clone(),
        start_date: w.start_date.clone(),
    }
}

/// 프로젝트 하나의 mng 제출 대상. `completed`/`in_progress`/`upcoming`은
/// "포함 항목" 토글을 켰다 껐다 할 때 프론트가 `mng_report.rs`와 동일한 규칙의
/// TS 포팅으로 내용을 즉시 재조립할 수 있도록 구조화된 형태로 내려준다 —
/// `default_content`(서버 기본 옵션으로 미리 렌더한 것)는 초기값일 뿐이다.
#[derive(Debug, Serialize, Clone)]
pub struct MngTargetDto {
    pub project_id: String,
    pub project_name: String,
    pub project_identifier: String,
    pub client_name: String,
    /// Plane 프로젝트에 mng 연계 키(`mng_link`)가 있는지. false면 카드는 목록에
    /// 남기되 제출은 막는다 — 감춰버리면 "사이드바엔 있는데 여긴 왜 없지"를
    /// 사용자가 다시 겪는다.
    pub mng_linked: bool,
    /// 연결된 mng 프로젝트명. 연결을 바꾸거나 풀려면 "지금 무엇에 연결돼
    /// 있는지"부터 보여야 한다 — 이름 없이 [해제] 버튼만 두면 사용자가 무엇을
    /// 지우는지 모른 채 누르게 된다. 연결이 없으면 빈 문자열.
    pub mng_link_name: String,
    /// 상태 그룹 -> 그 그룹의 상태 id. 창에서 작업 상태를 바꿀 때 프로젝트마다
    /// 다른 상태 id를 그때그때 조회하지 않아도 되도록 미리 담아 보낸다.
    pub state_ids: std::collections::HashMap<String, String>,
    pub completed: Vec<MngReportItemDto>,
    pub in_progress: Vec<MngReportItemDto>,
    pub upcoming: Vec<MngReportItemDto>,
    pub default_content: String,
    /// "pending" | "sent" | "unknown" | "not_linked" — `mng_linked`가 false면
    /// "not_linked", `mng_available`가 false면 실제 등록 여부를 모르므로
    /// "unknown", `existing_row`가 있으면 "sent".
    pub status: String,
    pub existing_row: Option<MngDailyRow>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MngTargetsDto {
    pub report_date: String,
    /// false면 mng 연결 자체가 실패한 것 — 모든 대상의 `status`가 "unknown"이다
    /// (미등록으로 오인해 중복 제출을 유도하지 않기 위해 구분해서 넘긴다).
    pub mng_available: bool,
    /// 비어 있으면 사번이 등록돼 있지 않다 — 프론트가 제출 버튼을 막고
    /// 안내 배너를 보여준다(서버도 POST 시점에 EMPLOYEE_NO_MISSING으로 다시
    /// 막지만, 창을 열자마자 미리 알려주는 편이 덜 답답하다).
    pub employee_no: String,
    pub targets: Vec<MngTargetDto>,
}

/// 목록 정렬 우선순위. 오늘 손댈 것이 위로 오고, 이미 끝났거나 손댈 수 없는
/// 것이 아래로 밀린다: 완료 있음 → 완료 없음 → 등록 완료 → 담을 작업 없음 →
/// mng 미연동. 같은 순위 안에서는 프로젝트명 순.
fn sort_rank(t: &MngTargetDto) -> u8 {
    if !t.mng_linked {
        return 4;
    }
    if t.status == "sent" {
        return 2;
    }
    if !t.completed.is_empty() {
        return 0;
    }
    if !t.in_progress.is_empty() || !t.upcoming.is_empty() {
        return 1;
    }
    // 세 그룹이 모두 비었다 — 백로그만 있는 프로젝트. 새 status 값을 만들지
    // 않고 이 사실만으로 프론트가 "담을 작업 없음"을 판단한다.
    3
}

/// 나에게 할당된 작업이 있는 프로젝트를 전부 모아 목록을 만든다 — 사이드바에
/// 보이는 것과 같은 범위다. 오늘 완료가 없거나 mng와 연동되지 않은 프로젝트도
/// 빼지 않고, 제출 가능 여부는 `mng_linked`/`status`로만 구분한다(제출할 대상은
/// 사용자가 화면에서 고른다).
/// mng 등록 여부는 프로젝트마다 따로 묻지 않는다 — `get_mng_daily_reports`가
/// 사번+날짜 단위로 한 번에 전체를 돌려주기 때문이다.
#[tauri::command]
pub async fn list_mng_targets(app: tauri::AppHandle) -> Result<MngTargetsDto, String> {
    let (client, _s) = client(&app)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    list_mng_targets_online(&client, &today).await
}

async fn list_mng_targets_online(client: &PlaneClient, today: &str) -> Result<MngTargetsDto, String> {
    let today_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|e| format!("invalid date {today}: {e}"))?;

    // mng 연동 여부로 거르지 않는다 — 사이드바에 보이는 프로젝트는 여기서도
    // 전부 보여주고, 연동 안 된 것은 `mng_linked: false`로 표시만 한다.
    let projects = client.list_projects().await?;

    // employee_no는 mng 연동 프로젝트 유무와 무관하게 항상 확인한다 — 예전에는
    // mng_projects가 비면 여기까지 오지도 않고 employee_no를 빈 문자열로
    // 돌려줘서, 실제로는 "내가 속한 mng 연동 프로젝트가 없다"뿐인데 화면에는
    // "사번 미등록"으로 잘못 떴다(사번을 이미 등록한 사용자도 마찬가지로
    // 잘못 표시됨). 등록 여부 조회 자체가 실패해도 화면 전체를 막지 않는다 —
    // "확인 불가"로 표시하고 넘어간다(mng 화면에서 직접 등록·삭제한 건은
    // 여기서 영원히 모르므로, 실패 시 "미등록"으로 오인시키지 않는다).
    let report: MngDailyReportsResponse = client.get_mng_daily_reports(today).await.unwrap_or_else(|_| {
        MngDailyReportsResponse {
            report_date: today.to_string(),
            employee_no: String::new(),
            mng_available: false,
            rows: Vec::new(),
        }
    });

    if projects.is_empty() {
        return Ok(MngTargetsDto {
            report_date: today.to_string(),
            mng_available: report.mng_available,
            employee_no: report.employee_no,
            targets: Vec::new(),
        });
    }

    let user = client.current_user_cached().await?;

    // 상태 목록도 같이 가져온다 — 창에서 작업 상태를 바꿀 수 있어야 하고,
    // 상태 id는 프로젝트마다 다르다. assemble_sidebar와 같은 join 패턴이라
    // 왕복 횟수는 늘지 않는다(프로젝트당 두 요청이 동시에 나간다).
    let per_project: Vec<(Project, Vec<WorkItem>, Vec<ProjectState>)> = stream::iter(projects)
        .map(move |p| async move {
            let (items, states) = tokio::join!(client.list_work_items(&p.id), client.list_states(&p.id));
            (p, items.unwrap_or_default(), states.unwrap_or_default())
        })
        .buffer_unordered(SYNC_CONCURRENCY)
        .collect()
        .await;

    let mut targets: Vec<MngTargetDto> = Vec::new();
    for (project, items, states) in per_project {
        let mine: Vec<WorkItem> =
            items.into_iter().filter(|i| i.assignee_ids.iter().any(|a| a == &user.id)).collect();
        if mine.is_empty() {
            // 사이드바 기준을 그대로 따른다 — 나에게 할당된 작업이 하나도 없는
            // 프로젝트는 사이드바에도 안 뜨므로 여기서도 뺀다. 반대로 백로그만
            // 있는 프로젝트는 남는다(세 그룹이 모두 비어 "담을 작업 없음"으로
            // 표시된다) — 사이드바에는 보이기 때문이다.
            continue;
        }
        let (completed, in_progress, upcoming) = mng_report::classify_groups(&mine, today);

        let mng_link_str = |key: &str| {
            project
                .mng_link
                .as_ref()
                .and_then(|v| v.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let client_name = mng_link_str("client");
        let mng_link_name = mng_link_str("name");

        let default_content = mng_report::project_to_text(
            &project.name,
            &project.identifier,
            Some(client_name.as_str()),
            (&completed, &in_progress, &upcoming),
            &mng_report::MngContentOptions::default(),
            today_date,
        );

        // 그룹마다 기본 상태를 하나씩 — 같은 그룹에 상태가 여럿이면
        // `resolve_state_id`와 같은 규칙으로 첫 번째를 쓴다.
        let mut state_ids = std::collections::HashMap::new();
        for group in ["backlog", "unstarted", "started", "completed", "cancelled"] {
            if let Some(id) = plane_api::resolve_state_id(&states, group) {
                state_ids.insert(group.to_string(), id);
            }
        }

        let mng_linked = project.mng_link.is_some();
        let existing_row =
            report.rows.iter().find(|r| r.project_id.as_deref() == Some(project.id.as_str())).cloned();
        let status = if !mng_linked {
            "not_linked"
        } else if !report.mng_available {
            "unknown"
        } else if existing_row.is_some() {
            "sent"
        } else {
            "pending"
        };

        targets.push(MngTargetDto {
            project_id: project.id,
            project_name: project.name,
            project_identifier: project.identifier,
            client_name,
            mng_linked,
            mng_link_name,
            state_ids,
            completed: completed.iter().map(|i| to_mng_item_dto(i)).collect(),
            in_progress: in_progress.iter().map(|i| to_mng_item_dto(i)).collect(),
            upcoming: upcoming.iter().map(|i| to_mng_item_dto(i)).collect(),
            default_content,
            status: status.to_string(),
            existing_row,
        });
    }
    targets.sort_by(|a, b| sort_rank(a).cmp(&sort_rank(b)).then_with(|| a.project_name.cmp(&b.project_name)));

    Ok(MngTargetsDto {
        report_date: today.to_string(),
        mng_available: report.mng_available,
        employee_no: report.employee_no,
        targets,
    })
}

/// mng 프로젝트 검색. 창이 입력할 때마다 부르므로 서버의 60초 캐시에 기댄다.
#[tauri::command]
pub async fn search_mng_projects_cmd(
    app: tauri::AppHandle,
    q: String,
    page: u32,
) -> Result<plane_api::MngProjectSearchResponse, String> {
    let (client, _) = client(&app)?;
    client.search_mng_projects(&q, page.max(1), MNG_SEARCH_PER_PAGE).await
}

/// Plane 프로젝트에 mng 프로젝트를 연결한다. `row`가 없으면 연결 해제.
/// 성공하면 사이드바·mng 창이 새 상태를 읽도록 새로고침 신호를 보낸다 —
/// 연결 여부는 제출 가능 여부를 좌우하므로 화면이 낡은 채로 남으면 안 된다.
#[tauri::command]
pub async fn link_mng_project_cmd(
    app: tauri::AppHandle,
    project_id: String,
    row: Option<plane_api::MngProjectRow>,
) -> Result<(), MngApiError> {
    let (client, _) = client(&app).map_err(MngApiError::network)?;
    client.link_mng_project(&project_id, row.as_ref()).await?;
    crate::emit_shared_item_event(&app, "refresh-sidebar", ());
    Ok(())
}

#[tauri::command]
pub async fn submit_mng_daily_report_cmd(
    app: tauri::AppHandle,
    project_id: String,
    state: String,
    content_html: String,
    report_date: String,
    spent_hours: u32,
    spent_minutes: u32,
) -> Result<(), MngApiError> {
    let (client, _s) = client(&app).map_err(MngApiError::network)?;
    client
        .submit_mng_daily_report(&project_id, &state, &content_html, &report_date, spent_hours, spent_minutes)
        .await
}

/// 일괄 제출 한 건. 프로젝트마다 내용·상태·소요시간이 다르므로 화면에서 조립한
/// 것을 그대로 받는다.
#[derive(Debug, Deserialize, Clone)]
pub struct MngBulkEntry {
    pub project_id: String,
    pub state: String,
    pub content_html: String,
    pub spent_hours: u32,
    pub spent_minutes: u32,
}

/// 일괄 제출 결과 한 건. 실패해도 나머지를 계속 보내므로, 어느 프로젝트가
/// 왜 실패했는지를 건별로 돌려준다.
#[derive(Debug, Serialize, Clone)]
pub struct MngBulkResult {
    pub project_id: String,
    pub ok: bool,
    pub error: Option<MngApiError>,
}

/// 선택한 프로젝트들의 업무일지를 순차 제출한다.
///
/// 순차인 이유: mng는 사번+날짜 단위로 행을 관리해서 동시에 밀어넣으면 서버가
/// 어느 요청을 먼저 반영할지 보장하지 않는다. 건마다 `mngdaily-bulk-progress`
/// 이벤트를 창에 보내 진행 상황을 즉시 반영하고, 실패해도 멈추지 않고 끝까지
/// 시도한다 — 하나가 타임아웃났다고 나머지를 안 보내면 사용자가 같은 작업을
/// 두 번 하게 된다.
#[tauri::command]
pub async fn submit_mng_daily_reports_cmd(
    app: tauri::AppHandle,
    report_date: String,
    entries: Vec<MngBulkEntry>,
) -> Result<Vec<MngBulkResult>, String> {
    let (client, _s) = client(&app)?;
    let mut results: Vec<MngBulkResult> = Vec::with_capacity(entries.len());
    for entry in entries {
        let outcome = client
            .submit_mng_daily_report(
                &entry.project_id,
                &entry.state,
                &entry.content_html,
                &report_date,
                entry.spent_hours,
                entry.spent_minutes,
            )
            .await;
        let result = match outcome {
            Ok(()) => MngBulkResult { project_id: entry.project_id, ok: true, error: None },
            Err(e) => MngBulkResult { project_id: entry.project_id, ok: false, error: Some(e) },
        };
        let _ = app.emit_to("mngdaily", "mngdaily-bulk-progress", result.clone());
        results.push(result);
    }
    Ok(results)
}

#[tauri::command]
pub async fn update_mng_daily_report_cmd(
    app: tauri::AppHandle,
    report_date: String,
    seq: String,
    state: String,
    content_html: String,
    spent_hours: u32,
    spent_minutes: u32,
) -> Result<(), MngApiError> {
    let (client, _s) = client(&app).map_err(MngApiError::network)?;
    client
        .update_mng_daily_report(&report_date, &seq, &state, &content_html, spent_hours, spent_minutes)
        .await
}

#[tauri::command]
pub async fn delete_mng_daily_report_cmd(
    app: tauri::AppHandle,
    report_date: String,
    seq: String,
) -> Result<(), MngApiError> {
    let (client, _s) = client(&app).map_err(MngApiError::network)?;
    client.delete_mng_daily_report(&report_date, &seq).await
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
    crate::emit_shared_item_event(&app, "refresh-sidebar", ());
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
            sequence_id: 0,
            parent_id: None,
        }
    }

    #[test]
    fn assemble_filters_to_my_open_items_across_projects() {
        let projects = vec![
            Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None },
            Project { id: "p2".into(), name: "Mob".into(), identifier: "MOB".into(), cycle_view: true, mng_link: None },
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
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
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
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
        let mut item = wi("a", "started", &["me"], "p1");
        item.updated_at = Some("2026-07-01T10:00:00Z".into());
        let data = assemble_sidebar("me", projects, vec![item], vec![], "2026-06-30", "2026-07-02");
        assert_eq!(data.assigned[0].updated_at.as_deref(), Some("2026-07-01T10:00:00Z"));
    }

    #[test]
    fn assemble_sidebar_carries_assignee_ids_into_work_item_dto() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
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

    fn target(name: &str, mng_linked: bool, status: &str, done: usize, doing: usize) -> MngTargetDto {
        let item = |n: usize| {
            (0..n)
                .map(|i| MngReportItemDto {
                    id: format!("i{i}"),
                    name: format!("작업 {i}"),
                    sequence_id: i as u64,
                    priority: "none".into(),
                    state_group: "started".into(),
                    completed_at: None,
                    target_date: None,
                    start_date: None,
                })
                .collect::<Vec<_>>()
        };
        MngTargetDto {
            project_id: format!("p-{name}"),
            project_name: name.into(),
            project_identifier: name.into(),
            client_name: String::new(),
            mng_linked,
            mng_link_name: String::new(),
            state_ids: std::collections::HashMap::new(),
            completed: item(done),
            in_progress: item(doing),
            upcoming: Vec::new(),
            default_content: String::new(),
            status: status.into(),
            existing_row: None,
        }
    }

    #[test]
    fn sort_rank_orders_actionable_projects_first() {
        // 완료 있음 → 완료 없음 → 등록 완료 → 담을 작업 없음 → mng 미연동
        assert_eq!(sort_rank(&target("a", true, "pending", 2, 1)), 0);
        assert_eq!(sort_rank(&target("b", true, "pending", 0, 3)), 1);
        assert_eq!(sort_rank(&target("c", true, "sent", 1, 0)), 2);
        assert_eq!(sort_rank(&target("d", true, "pending", 0, 0)), 3);
        assert_eq!(sort_rank(&target("e", false, "not_linked", 1, 1)), 4);
    }

    #[test]
    fn sort_rank_keeps_unknown_projects_actionable() {
        // mng 연결 실패("unknown")는 제출을 막지 않는다 — 완료 유무로만 나뉜다.
        assert_eq!(sort_rank(&target("a", true, "unknown", 1, 0)), 0);
        assert_eq!(sort_rank(&target("b", true, "unknown", 0, 1)), 1);
    }

    #[test]
    fn sort_rank_ranks_not_linked_below_everything_even_with_completed_items() {
        // 오늘 완료가 아무리 많아도 제출할 수 없으므로 맨 아래다.
        assert_eq!(sort_rank(&target("a", false, "not_linked", 9, 9)), 4);
    }

    #[test]
    fn targets_sort_by_rank_then_name() {
        let mut targets = [
            target("Zebra", true, "pending", 1, 0),
            target("Never", false, "not_linked", 5, 0),
            target("Alpha", true, "pending", 1, 0),
            target("Empty", true, "pending", 0, 0),
            target("Sent", true, "sent", 1, 0),
            target("Doing", true, "pending", 0, 2),
        ];

        targets
            .sort_by(|a, b| sort_rank(a).cmp(&sort_rank(b)).then_with(|| a.project_name.cmp(&b.project_name)));
        let names: Vec<&str> = targets.iter().map(|t| t.project_name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Zebra", "Doing", "Sent", "Empty", "Never"]);
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

    #[test]
    fn assemble_sidebar_fills_delegated_from_created_by() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into(), cycle_view: true, mng_link: None }];
        let mut mine_for_other = wi("a", "started", &["other"], "p1");
        mine_for_other.created_by = Some("me".into());
        let mut mine_for_me = wi("b", "started", &["me"], "p1");
        mine_for_me.created_by = Some("me".into());
        let mut not_mine = wi("c", "started", &["other"], "p1");
        not_mine.created_by = Some("someone_else".into());
        let items = vec![mine_for_other, mine_for_me, not_mine];
        let data = assemble_sidebar("me", projects, items, vec![], "2026-06-30", "2026-07-02");
        let ids: Vec<_> = data.delegated.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[test]
    fn verify_delegated_tab_password_accepts_only_the_exact_password() {
        assert!(verify_delegated_tab_password("16006937".to_string()));
        assert!(!verify_delegated_tab_password("".to_string()));
        assert!(!verify_delegated_tab_password("16006938".to_string()));
        assert!(!verify_delegated_tab_password(" 16006937".to_string()));
        assert!(!verify_delegated_tab_password("16006937 ".to_string()));
    }

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client_for(server: &MockServer) -> PlaneClient {
        PlaneClient::new(server.uri(), "acme".into(), "secret-key".into())
    }

    // Finding 1: 프로젝트 하나의 사이클-소속 조회가 (list_cycles 자체가 아니라)
    // 그 안의 한 사이클의 list_cycle_issue_ids에서만 실패해도, 그 프로젝트가
    // 기여하는 사이클/소속은 하나도 없어야 한다 — 절반만 반영되면 실제로는
    // 그 사이클에 속한 작업이 item_cycle에 빠져 "사이클 없음"으로 잘못
    // 보이기 때문이다(Finding 1 본문 참고). 반면 건강한 프로젝트(p1)는
    // 그대로 온전히 반영되어야 한다.
    #[tokio::test]
    async fn fetch_cycle_data_online_keeps_healthy_project_and_drops_failing_project_entirely() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "p1", "name": "Healthy", "identifier": "OK", "is_member": true, "cycle_view": true },
                    { "id": "p2", "name": "Flaky", "identifier": "BAD", "is_member": true, "cycle_view": true }
                ]
            })))
            .mount(&server)
            .await;
        // p1: 사이클 조회, 소속 조회 모두 성공 — 그대로 반영돼야 한다.
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "c1", "name": "Sprint 1", "start_date": null, "end_date": null }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/c1/cycle-issues/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "i1", "name": "작업1", "state": { "group": "started" } }]
            })))
            .mount(&server)
            .await;
        // p2: 사이클 조회는 성공하고, 사이클도 **두 개**다 — 첫 번째(c2)의 소속
        // 조회는 성공하지만 두 번째(c3)가 실패한다. 사이클이 하나뿐이면 "실패한
        // 사이클만 건너뛰는" 구현도 똑같이 통과하므로 아무것도 증명하지 못한다.
        // 두 개여야 이미 받아둔 c2까지 함께 버려지는지를 확인할 수 있다.
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p2/cycles/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "id": "c2", "name": "Sprint 2", "start_date": null, "end_date": null },
                    { "id": "c3", "name": "Sprint 3", "start_date": null, "end_date": null }
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p2/cycles/c2/cycle-issues/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "i2", "name": "작업2", "state": { "group": "started" } }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p2/cycles/c3/cycle-issues/"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let client = client_for(&server).await;
        let data = fetch_cycle_data_online(&client, "2026-07-22").await.unwrap();

        let cycle_ids: Vec<&str> = data.cycles.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            cycle_ids,
            vec!["c1"],
            "neither cycle of the failing project may appear — not even the one already fetched"
        );
        assert_eq!(data.item_cycle.get("i1"), Some(&"c1".to_string()));
        assert!(
            !data.item_cycle.values().any(|v| v == "c2" || v == "c3"),
            "failing project must contribute no item_cycle entries"
        );
        assert_eq!(data.item_cycle.len(), 1, "only the healthy project's entry may remain");
        assert!(data.is_partial, "a skipped project must mark the result as incomplete");
    }

    // 모든 프로젝트가 정상이면 결과는 완전한 것으로 표시돼야 한다 — is_partial이
    // 늘 true라면 프론트엔드가 캐시를 아예 못 쓰고 2분마다 다시 요청한다.
    #[tokio::test]
    async fn fetch_cycle_data_online_marks_a_fully_successful_result_as_complete() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "p1", "name": "Healthy", "identifier": "OK", "is_member": true, "cycle_view": true }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "c1", "name": "Sprint 1", "start_date": null, "end_date": null }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/workspaces/acme/projects/p1/cycles/c1/cycle-issues/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{ "id": "i1", "name": "작업1", "state": { "group": "started" } }]
            })))
            .mount(&server)
            .await;

        let client = client_for(&server).await;
        let data = fetch_cycle_data_online(&client, "2026-07-22").await.unwrap();
        assert!(!data.is_partial);
        assert_eq!(data.item_cycle.len(), 1);
    }
}
