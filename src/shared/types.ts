export interface Project { id: string; name: string; identifier: string; }
export interface Member { id: string; display_name: string; }
export interface ProjectState { id: string; group: string; project_id: string; default: boolean; }
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; state_group: string; project_id: string;
  completed_at: string | null;
}
export interface WorkItemDetail {
  id: string; name: string; description: string;
  assignee_ids: string[];
  start_date: string | null; target_date: string | null;
  priority: string; state_group: string; project_id: string;
}
export interface SidebarData { projects: Project[]; assigned: WorkItem[]; states: ProjectState[]; }
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
  theme: string; display_index: number;
}
