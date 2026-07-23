import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSettings, saveSettings, verifyDelegatedTabPassword } from "../shared/ipc";
import { captureFromKeyEvent } from "../shared/hotkey";
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
const openaiKey = document.getElementById("openaiKey") as HTMLInputElement;
const oaSaved = document.getElementById("oaSaved")!;
const oaChange = document.getElementById("oaChange")!;
const briefingModel = document.getElementById("briefingModel") as HTMLInputElement;
const morningEnabled = document.getElementById("morningEnabled") as HTMLInputElement;
const morningTime = document.getElementById("morningTime") as HTMLInputElement;

// Plane 토큰 카드와 같은 규칙: 저장된 키는 카드로만 보이고 값은 절대
// 페이지로 로드하지 않는다. 입력창의 값은 언제나 '새 키'다.
let hasOpenaiKey = false;
function renderOpenaiKeyField(editing: boolean) {
  const showCard = hasOpenaiKey && !editing;
  oaSaved.hidden = !showCard;
  openaiKey.hidden = showCard;
}
oaChange.onclick = (e) => {
  e.preventDefault();
  renderOpenaiKeyField(true);
  openaiKey.focus();
};

const qaShortcut = document.getElementById("qaShortcut") as HTMLInputElement;
const sbShortcut = document.getElementById("sbShortcut") as HTMLInputElement;

// 단축키 입력은 텍스트 타이핑이 아니라 키 캡처로 받는다: 입력창에 포커스를
// 두고 원하는 조합을 누르면 가속기 문자열이 기록된다. Esc는 취소, 수식키만
// 누르고 있는 동안은 미완성 상태("Ctrl+…")로 보여준다.
function attachShortcutCapture(input: HTMLInputElement) {
  let committed = "";
  const restore = () => {
    input.value = committed;
    delete input.dataset.pending;
  };
  input.addEventListener("focus", () => {
    committed = input.value;
  });
  input.addEventListener("blur", () => {
    if (input.dataset.pending) restore();
  });
  input.addEventListener("keydown", (e) => {
    // Tab만은 포커스 이동용으로 남겨둔다.
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    if (e.key === "Escape") {
      // 창 전역 Esc(닫기)로 번지지 않게 막는다 — 여기서는 캡처 취소만 한다.
      e.stopPropagation();
      restore();
      input.blur();
      return;
    }
    const r = captureFromKeyEvent(e);
    if (r.kind === "commit") {
      input.value = r.accelerator;
      committed = r.accelerator;
      delete input.dataset.pending;
      status.textContent = "";
    } else if (r.kind === "pending") {
      input.value = r.display;
      input.dataset.pending = "1";
    } else if (r.kind === "invalid") {
      restore();
      status.textContent = r.reason;
    }
  });
  input.addEventListener("keyup", (e) => {
    // 수식키만 눌렀다 뗀 경우 미완성 표시를 원래 값으로 되돌린다.
    if (input.dataset.pending && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) restore();
  });
}
attachShortcutCapture(qaShortcut);
attachShortcutCapture(sbShortcut);
const theme = document.getElementById("theme") as HTMLSelectElement;
const displaySelect = document.getElementById("displaySelect") as HTMLSelectElement;
const idleOpenEnabled = document.getElementById("idleOpenEnabled") as HTMLInputElement;
const idleOpenMinutes = document.getElementById("idleOpenMinutes") as HTMLInputElement;
const assignNotifyEnabled = document.getElementById("assignNotifyEnabled") as HTMLInputElement;
const assignRemindHours = document.getElementById("assignRemindHours") as HTMLInputElement;
const deadlineNotifyEnabled = document.getElementById("deadlineNotifyEnabled") as HTMLInputElement;
const deadlineNotifyTime = document.getElementById("deadlineNotifyTime") as HTMLInputElement;
const deadlineLeadDays = document.getElementById("deadlineLeadDays") as HTMLInputElement;
const showDelegatedTab = document.getElementById("showDelegatedTab") as HTMLInputElement;

let pwPopover: HTMLElement | null = null;

function closePwPopover() {
  if (pwPopover) {
    pwPopover.remove();
    pwPopover = null;
  }
}

function openPwPopover(anchor: HTMLElement) {
  closePwPopover();
  const pop = document.createElement("div");
  pop.className = "pop pw-pop";
  pop.onclick = (e) => e.stopPropagation();

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "비밀번호";
  input.className = "pw-pop-input";
  pop.appendChild(input);

  const error = document.createElement("div");
  error.className = "pw-pop-error";
  pop.appendChild(error);

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "token-change-btn pw-pop-confirm";
  confirm.textContent = "확인";
  const submit = async () => {
    let ok = false;
    try {
      ok = await verifyDelegatedTabPassword(input.value);
    } catch {
      ok = false;
    }
    if (ok) {
      showDelegatedTab.checked = true;
      closePwPopover();
    } else {
      error.textContent = "비밀번호가 올바르지 않습니다";
      input.value = "";
      input.focus();
    }
  };
  confirm.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  pop.appendChild(confirm);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = rect.left + "px";
  pop.style.top = rect.bottom + 4 + "px";
  pwPopover = pop;
  input.focus();
}

// 체크박스의 click 이벤트는 브라우저가 이미 .checked를 새 값으로 뒤집은
// 뒤에 발생한다. 그래서 여기서 .checked === true면 "꺼짐→켜짐" 전환
// 시도라는 뜻이다. preventDefault()를 부르면 체크박스는 특수 동작으로
// .checked를 자동으로 원래 값(false)으로 되돌린다 — 그 다음 비밀번호
// 팝업을 띄우고, 검증에 성공하면 그때 코드에서 직접 checked = true로
// 설정한다. .checked === false(켜짐→꺼짐)면 막지 않고 그대로 통과시킨다
// — 끄는 데는 비밀번호가 필요 없다.
showDelegatedTab.addEventListener("click", (e) => {
  if (showDelegatedTab.checked) {
    e.preventDefault();
    // 이 click 이벤트는 document까지 버블링되는데, 아래 document 리스너가
    // 열려 있는 팝오버를 닫는다 — stopPropagation 없이는 방금 연 팝오버가
    // 같은 이벤트 처리 중에 바로 닫혀버려 화면에 보이지도 않는다.
    e.stopPropagation();
    openPwPopover(showDelegatedTab);
  }
});

document.addEventListener("click", () => closePwPopover());

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
  hasOpenaiKey = s.has_openai_key;
  renderOpenaiKeyField(false);
  briefingModel.value = s.briefing_model;
  morningEnabled.checked = s.morning_briefing_enabled;
  morningTime.value = s.morning_briefing_time;
  assignNotifyEnabled.checked = s.assign_notify_enabled;
  assignRemindHours.value = String(s.assign_remind_hours);
  deadlineNotifyEnabled.checked = s.deadline_notify_enabled;
  deadlineNotifyTime.value = s.deadline_notify_time;
  deadlineLeadDays.value = String(s.deadline_lead_days);
  showDelegatedTab.checked = s.show_delegated_tab;

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
      openaiKey.value || undefined,
      briefingModel.value.trim() || undefined,
      morningEnabled.checked,
      morningTime.value || undefined,
      assignNotifyEnabled.checked,
      Math.max(1, Math.floor(Number(assignRemindHours.value) || 2)),
      deadlineNotifyEnabled.checked,
      deadlineNotifyTime.value || undefined,
      Math.max(1, Math.floor(Number(deadlineLeadDays.value) || 3)),
      showDelegatedTab.checked,
    );
    if (token.value) hasToken = true;
    token.value = "";
    renderTokenField(false);
    if (openaiKey.value) hasOpenaiKey = true;
    openaiKey.value = "";
    renderOpenaiKeyField(false);
    status.textContent = "저장됨 ✓";
    setTimeout(() => getCurrentWindow().hide(), 800);
  } catch (e) {
    status.textContent = "저장 실패: " + e;
  }
};

const setTabs = [...document.querySelectorAll<HTMLButtonElement>(".set-tab")];
const setPanels = [...document.querySelectorAll<HTMLElement>(".set-panel")];
setTabs.forEach((tab) => {
  tab.onclick = () => {
    for (const t of setTabs) {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    }
    for (const panel of setPanels) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  };
});

document.getElementById("setClose")!.onclick = () => {
  getCurrentWindow().hide();
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pwPopover) {
    closePwPopover();
    return;
  }
  getCurrentWindow().hide();
});

load();
