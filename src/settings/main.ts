import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSettings, saveSettings } from "../shared/ipc";
import { sortMonitorsByPosition } from "../shared/monitors";
import { applyTheme } from "../shared/theme";
import "../shared/app.css";

const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const tokenLink = document.getElementById("tokenLink")!;

tokenLink.onclick = (e) => {
  e.preventDefault();
  const url = baseUrl.value.trim();
  if (!url) return;
  openUrl(`${url}/settings/profile/api-tokens/`).catch((err) => {
    console.error("openUrl failed:", err);
  });
};
const qaShortcut = document.getElementById("qaShortcut") as HTMLInputElement;
const sbShortcut = document.getElementById("sbShortcut") as HTMLInputElement;
const theme = document.getElementById("theme") as HTMLSelectElement;
const sidebarDisplay = document.getElementById("sidebarDisplay") as HTMLSelectElement;
const status = document.getElementById("status")!;

async function load() {
  const s = await getSettings();
  baseUrl.value = s.base_url;
  workspace.value = s.workspace;
  token.placeholder = s.has_token ? "(저장됨 — 변경 시에만 입력)" : "API 토큰 입력";
  qaShortcut.value = s.quickadd_shortcut;
  sbShortcut.value = s.sidebar_shortcut;
  theme.value = s.theme;
  applyTheme(s.theme);

  const monitors = sortMonitorsByPosition(await availableMonitors());
  sidebarDisplay.innerHTML = "";
  monitors.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `디스플레이 ${i + 1} (${Math.round(m.size.width / m.scaleFactor)}×${Math.round(m.size.height / m.scaleFactor)})`;
    sidebarDisplay.appendChild(opt);
  });
  const wanted = String(s.sidebar_display_index);
  sidebarDisplay.value = [...sidebarDisplay.options].some((o) => o.value === wanted) ? wanted : "1";
}

theme.onchange = () => applyTheme(theme.value);

document.getElementById("save")!.onclick = async () => {
  status.textContent = "저장 중…";
  try {
    await saveSettings(
      baseUrl.value.trim(),
      workspace.value.trim(),
      token.value || undefined,
      qaShortcut.value.trim() || undefined,
      sbShortcut.value.trim() || undefined,
      theme.value,
      Number(sidebarDisplay.value),
    );
    token.value = "";
    status.textContent = "저장됨 ✓ (단축키 변경은 재시작 후 적용)";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};

load();
