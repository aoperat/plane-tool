export interface Project { id: string; name: string; identifier: string; }
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; state_group: string; project_id: string;
}
export interface SidebarData { projects: Project[]; assigned: WorkItem[]; }
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
}
