export interface Project { id: string; name: string; identifier: string; }
export interface Member { id: string; display_name: string; is_me: boolean; }
export interface ProjectState { id: string; group: string; project_id: string; default: boolean; }
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; start_date: string | null;
  state_group: string; project_id: string;
  assignee_ids: string[];
  completed_at: string | null;
  created_at: string | null;
}
export interface WorkItemDetail {
  id: string; name: string; description: string;
  assignee_ids: string[];
  start_date: string | null; target_date: string | null;
  priority: string; state_group: string; project_id: string;
}
export interface ItemChange {
  item_id: string;
  project_id: string;
  name: string | null;
  priority: string | null;
  state_group: string | null;
  start_date: string | null;
  target_date: string | null;
  assignee_ids: string[] | null;
}
export interface SidebarData {
  projects: Project[]; assigned: WorkItem[]; delegated: WorkItem[]; delegated_members: Member[];
  states: ProjectState[]; is_cached: boolean; cached_at_ms: number | null;
}
export interface OfflineStatus { pending: number; }
export interface ReleaseNote { version: string; date: string; notes: string; }
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
  theme: string; display_index: number;
  idle_open_enabled: boolean; idle_open_minutes: number;
  has_openai_key: boolean; briefing_model: string;
  morning_briefing_enabled: boolean; morning_briefing_time: string;
  assign_notify_enabled: boolean; assign_remind_hours: number;
  deadline_notify_enabled: boolean; deadline_notify_time: string; deadline_lead_days: number;
  show_delegated_tab: boolean;
  quickadd_layout: string;
}
export interface BriefingItem {
  id: string; name: string; project_id: string; project_identifier: string;
  priority: string; start_date: string | null; target_date: string | null;
  state_group: string;
}
export interface BriefingPlanEntry { item: BriefingItem; reason: string; }
export interface Briefing {
  date: string; generated_at: string; model: string;
  source: string; error: string | null; summary: string;
  plan: BriefingPlanEntry[]; rest: BriefingItem[];
}
export interface PendingAssignment {
  item_id: string; project_id: string; name: string;
  priority: string; target_date: string | null;
  assigner_name: string; detected_at_ms: number;
}
export interface ConflictFields {
  name: string | null;
  description: string | null;
  assignee_ids: string[] | null;
  start_date: string | null;
  target_date: string | null;
  priority: string | null;
  state_group: string | null;
}
export type ConflictKind = "CreateIssue" | "UpdatePriority" | "UpdateState" | "UpdateFields" | "Delete";
export type ConflictReason = "ServerUpdated" | "TargetDeleted";
export interface Conflict {
  id: string;
  kind: ConflictKind;
  project_id: string;
  target_id: string;
  item_name: string;
  reason: ConflictReason;
  local_fields: ConflictFields;
  server_fields: ConflictFields | null;
  detected_at_ms: number;
}
export interface Cycle {
  id: string; name: string; project_id: string;
  /** "YYYY-MM-DD" 또는 UTC 타임스탬프. 초안 사이클은 둘 다 null일 수 있다. */
  start_date: string | null; end_date: string | null;
}
export interface CycleData {
  cycles: Cycle[];
  /** 작업 id → 사이클 id. 사이클은 작업당 최대 1개라 맵으로 충분하다. */
  item_cycle: Record<string, string>;
  /** 사이클 조회가 실패해 통째로 건너뛴 프로젝트가 하나라도 있으면 true.
   *  이 결과는 캐시에 저장하지 않고, 다음 렌더에서 더 빨리 다시 시도한다. */
  is_partial: boolean;
}

/** mng 업무일지 내용 조립에 필요한 최소 필드. Rust `mng_report::classify_groups`가
 *  이미 상태 그룹별로 나눠 보낸 것이라 여기엔 `state_group`이 없다. */
export interface MngReportItem {
  id: string;
  name: string;
  sequence_id: number;
  priority: string;
  completed_at: string | null;
  target_date: string | null;
  start_date: string | null;
}

export interface MngDailyRow {
  seq: string;
  project_id: string | null;
  mng_project_name: string;
  state: string;
  state_name: string;
  client_name: string;
  content_html: string;
  spent_hours: string;
  spent_minutes: string;
  editable: boolean;
}

export type MngTargetStatus = "pending" | "sent" | "unknown";

export interface MngTarget {
  project_id: string;
  project_name: string;
  project_identifier: string;
  client_name: string;
  completed: MngReportItem[];
  in_progress: MngReportItem[];
  upcoming: MngReportItem[];
  default_content: string;
  status: MngTargetStatus;
  existing_row: MngDailyRow | null;
}

export interface MngTargets {
  report_date: string;
  mng_available: boolean;
  employee_no: string;
  targets: MngTarget[];
}

export interface MngApiError {
  error_code: string;
  message: string;
}
