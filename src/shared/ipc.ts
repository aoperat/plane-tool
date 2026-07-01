import { invoke } from "@tauri-apps/api/core";
import type { SidebarData, SettingsDto, Project, Member, WorkItemDetail } from "./types";

export const getSettings = () => invoke<SettingsDto>("get_settings");
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
  });
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string | undefined,
  target_date: string | undefined,
  priority: string,
  state_group: string,
  description: string,
) =>
  invoke<void>("create_issue", {
    projectId: project_id,
    name,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
    description,
  });
export const listMembers = (project_id: string) =>
  invoke<Member[]>("list_members", { projectId: project_id });
export const fetchSidebarData = (completedAfter: string, completedBefore: string) =>
  invoke<SidebarData>("fetch_sidebar_data", { completedAfter, completedBefore });
export const listProjects = () => invoke<Project[]>("list_projects");
export const updateWorkItemPriority = (project_id: string, item_id: string, priority: string) =>
  invoke<void>("update_work_item_priority", { projectId: project_id, itemId: item_id, priority });
export const updateWorkItemState = (project_id: string, item_id: string, state_id: string) =>
  invoke<void>("update_work_item_state", { projectId: project_id, itemId: item_id, stateId: state_id });
export const deleteWorkItem = (project_id: string, item_id: string) =>
  invoke<void>("delete_work_item", { projectId: project_id, itemId: item_id });

export const getWorkItem = (project_id: string, item_id: string) =>
  invoke<WorkItemDetail>("get_work_item", { projectId: project_id, itemId: item_id });

export interface UpdateWorkItemFields {
  name?: string;
  description?: string;
  assignee_ids?: string[];
  start_date?: string;
  target_date?: string;
  priority?: string;
  state_group?: string;
}

export const updateWorkItemFields = (project_id: string, item_id: string, fields: UpdateWorkItemFields) =>
  invoke<void>("update_work_item_fields", {
    projectId: project_id,
    itemId: item_id,
    name: fields.name,
    description: fields.description,
    assigneeIds: fields.assignee_ids,
    startDate: fields.start_date,
    targetDate: fields.target_date,
    priority: fields.priority,
    stateGroup: fields.state_group,
  });

export const openEditModal = (project_id: string, item_id: string) =>
  invoke<void>("open_edit_modal", { projectId: project_id, itemId: item_id });
