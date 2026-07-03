import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSettings, saveSettings } from "../shared/ipc";
import { sortMonitorsByPosition } from "../shared/monitors";
import { applyTheme } from "../shared/theme";
import "../shared/app.css";

const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
const workspace = document.getElementById("workspace") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const tokenSaved = document.getElementById("tokenSaved")!;
const tokenChange = document.getElementById("tokenChange")!;
const tokenLink = document.getElementById("tokenLink")!;

// A stored token renders as a "저장됨" card in place of the input; [변경]
// switches back to the input. The input's value is only ever a NEW token —
// the stored one is never loaded into the page.
let hasToken = false;
function renderTokenField(editing: boolean) {
  const showCard = hasToken && !editing;
  tokenSaved.hidden = !showCard;
  token.hidden = showCard;
}

tokenChange.onclick = (e) => {
  // A button inside <label> would also activate the label's input — block that
  // and manage focus ourselves after the swap.
  e.preventDefault();
  renderTokenField(true);
  token.focus();
};
const qaShortcut = document.getElementById("qaShortcut") as HTMLInputElement;
const sbShortcut = document.getElementById("sbShortcut") as HTMLInputElement;
const theme = document.getElementById("theme") as HTMLSelectElement;
const displaySelect = document.getElementById("displaySelect") as HTMLSelectElement;
const idleOpenEnabled = document.getElementById("idleOpenEnabled") as HTMLInputElement;
const idleOpenMinutes = document.getElementById("idleOpenMinutes") as HTMLInputElement;
const status = document.getElementById("status")!;

tokenLink.onclick = (e) => {
  e.preventDefault();
  const url = baseUrl.value.trim();
  if (!url) {
    status.textContent = "Base URL을 먼저 입력하세요";
    baseUrl.focus();
    return;
  }
  openUrl(`${url}/settings/profile/api-tokens/`).catch((err) => {
    status.textContent = "링크 열기 실패: " + err;
    console.error("openUrl failed:", err);
  });
};

async function load() {
  const s = await getSettings();
  baseUrl.value = s.base_url;
  workspace.value = s.workspace;
  hasToken = s.has_token;
  renderTokenField(false);
  qaShortcut.value = s.quickadd_shortcut;
  sbShortcut.value = s.sidebar_shortcut;
  theme.value = s.theme;
  applyTheme(s.theme);
  idleOpenEnabled.checked = s.idle_open_enabled;
  idleOpenMinutes.value = String(s.idle_open_minutes);

  const monitors = sortMonitorsByPosition(await availableMonitors());
  displaySelect.innerHTML = "";
  monitors.forEach((m, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = `디스플레이 ${i + 1} (${Math.round(m.size.width / m.scaleFactor)}×${Math.round(m.size.height / m.scaleFactor)})`;
    displaySelect.appendChild(opt);
  });
  const wanted = String(s.display_index);
  displaySelect.value = [...displaySelect.options].some((o) => o.value === wanted) ? wanted : "1";
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
      Number(displaySelect.value),
      idleOpenEnabled.checked,
      Math.max(1, Math.floor(Number(idleOpenMinutes.value) || 3)),
    );
    if (token.value) hasToken = true;
    token.value = "";
    renderTokenField(false);
    status.textContent = "저장됨 ✓ (단축키 변경은 재시작 후 적용)";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};

load();
