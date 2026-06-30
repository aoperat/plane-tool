import { invoke } from "@tauri-apps/api/core";
import type { SidebarData, SettingsDto } from "./types";

export const getSettings = () => invoke<SettingsDto>("get_settings");
export const saveSettings = (base_url: string, workspace: string, token?: string) =>
  invoke<void>("save_settings", { baseUrl: base_url, workspace, token });
export const createIssue = (project_id: string, name: string) =>
  invoke<void>("create_issue", { projectId: project_id, name });
export const fetchSidebarData = () => invoke<SidebarData>("fetch_sidebar_data");
