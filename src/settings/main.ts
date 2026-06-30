import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, saveSettings } from "../shared/ipc";
import "../shared/app.css";

const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

async function load() {
  const s = await getSettings();
  baseUrl.value = s.base_url;
  workspace.value = s.workspace;
  token.placeholder = s.has_token ? "(저장됨 — 변경 시에만 입력)" : "API 토큰 입력";
}

document.getElementById("save")!.onclick = async () => {
  status.textContent = "저장 중…";
  try {
    await saveSettings(baseUrl.value.trim(), workspace.value.trim(), token.value || undefined);
    token.value = "";
    status.textContent = "저장됨 ✓ (단축키 변경은 재시작 후 적용)";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};

load();
