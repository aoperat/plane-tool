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
export interface SidebarData {
  projects: Project[]; assigned: WorkItem[]; states: ProjectState[];
  is_cached: boolean; cached_at_ms: number | null;
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
