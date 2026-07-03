import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { generateBriefing, getSettings, openEditModal } from "../shared/ipc";
import { applyTheme } from "../shared/theme";
import { briefingToText, dueLabel, formatDateLabel, localToday } from "./logic";
import type { Briefing, BriefingItem } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const cardEl = document.querySelector(".bf-card") as HTMLElement;
const bodyEl = document.getElementById("bfBody")!;
const dateEl = document.getElementById("bfDate")!;
const metaEl = document.getElementById("bfMeta")!;
const copyBtn = document.getElementById("bfCopy") as HTMLButtonElement;
const regenBtn = document.getElementById("bfRegen") as HTMLButtonElement;
const regenFootBtn = document.getElementById("bfRegenFoot") as HTMLButtonElement;

let current: Briefing | null = null;
let generating = false;

function resizeToFit() {
  const height = Math.ceil(cardEl.getBoundingClientRect().height) + 4;
  win.setSize(new LogicalSize(560, height)).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function itemRow(it: BriefingItem, today: string): HTMLElement {
  const row = el("div", "bf-rest-row");
  row.appendChild(el("span", "name", it.name));
  row.appendChild(el("span", "proj", it.project_identifier));
  const due = dueLabel(it.target_date, today);
  if (due) {
    const cls = due.startsWith("D+") ? "bf-chip red" : due === "오늘" ? "bf-chip amber" : "bf-chip";
    row.appendChild(el("span", cls, due));
  }
  row.onclick = () => openEditModal(it.project_id, it.id);
  return row;
}

function render(b: Briefing) {
  current = b;
  dateEl.textContent = formatDateLabel(b.date);
  metaEl.textContent = `${b.generated_at} 생성 · ${b.source === "openai" ? b.model : "규칙 기반"}`;
  bodyEl.innerHTML = "";

  const summary = el("div", "bf-summary");
  summary.appendChild(el("span", "spark", "✦"));
  const p = document.createElement("p");
  p.textContent = b.summary;
  summary.appendChild(p);
  bodyEl.appendChild(summary);

  if (b.error === "no_key") {
    bodyEl.appendChild(el("p", "bf-note", "OpenAI API 키가 없어 규칙 기반으로 생성했어요 — 설정에서 등록할 수 있어요."));
  } else if (b.error) {
    bodyEl.appendChild(el("p", "bf-note", "AI 호출에 실패해 규칙 기반으로 생성했어요."));
  }

  if (b.plan.length === 0 && b.rest.length === 0) {
    bodyEl.appendChild(el("p", "bf-empty", "남은 작업이 없습니다 🎉"));
  }

  const plan = el("div", "bf-plan");
  b.plan.forEach((e, i) => {
    const overdue = dueLabel(e.item.target_date, b.date).startsWith("D+");
    const row = el("div", "bf-plan-row" + (i === 0 && overdue ? " hot" : ""));
    row.appendChild(el("span", "num", String(i + 1)));
    const body = el("div", "bf-plan-body");
    const t = el("div", "t");
    t.appendChild(el("span", "name", e.item.name));
    t.appendChild(el("span", "proj", e.item.project_identifier));
    body.appendChild(t);
    body.appendChild(el("div", "why", e.reason));
    row.appendChild(body);
    row.onclick = () => openEditModal(e.item.project_id, e.item.id);
    plan.appendChild(row);
  });
  if (b.plan.length > 0) bodyEl.appendChild(plan);

  if (b.rest.length > 0) {
    const rest = el("div", "bf-rest");
    const head = el("div", "bf-rest-head", "나머지 작업 ");
    head.appendChild(el("span", "cnt", String(b.rest.length)));
    rest.appendChild(head);
    for (const it of b.rest) rest.appendChild(itemRow(it, b.date));
    bodyEl.appendChild(rest);
  }
  resizeToFit();
}

function renderLoading() {
  bodyEl.innerHTML = "";
  dateEl.textContent = formatDateLabel(localToday());
  metaEl.textContent = "";
  bodyEl.appendChild(el("p", "bf-loading", "브리핑 생성 중…"));
  resizeToFit();
}

function renderError(err: unknown) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "bf-empty", "브리핑을 불러오지 못했어요: " + err));
  resizeToFit();
}

async function generate(force: boolean) {
  if (generating) return;
  generating = true;
  regenBtn.disabled = true;
  regenFootBtn.disabled = true;
  renderLoading();
  try {
    render(await generateBriefing(force));
  } catch (e) {
    console.error("generateBriefing failed:", e);
    renderError(e);
  } finally {
    generating = false;
    regenBtn.disabled = false;
    regenFootBtn.disabled = false;
  }
}

/** 창이 열릴 때: 오늘 것을 이미 들고 있으면 그대로, 아니면 (캐시 우선) 생성. */
function ensureToday() {
  if (current && current.date === localToday()) return;
  generate(false);
}

regenBtn.onclick = () => generate(true);
regenFootBtn.onclick = () => generate(true);
copyBtn.onclick = async () => {
  if (!current) return;
  try {
    await writeText(briefingToText(current));
    copyBtn.textContent = "복사됨 ✓";
    setTimeout(() => (copyBtn.textContent = "복사"), 1200);
  } catch (e) {
    console.error("clipboard write failed:", e);
  }
};
document.getElementById("bfClose")!.onclick = () => win.hide();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});

// 앱 시작 직후 아침 브리핑은 이 웹뷰의 listen() 등록보다 먼저 창을 띄우고
// 이벤트를 보낼 수 있다 — Tauri는 리스너 없는 이벤트를 버리므로, 등록을 마친 뒤
// 창이 이미 보이는 상태면 유실된 열림 신호로 간주하고 직접 생성한다.
listen("briefing-open", ensureToday)
  .then(() => win.isVisible())
  .then((visible) => {
    if (visible) ensureToday();
  })
  .catch((err) => console.error("briefing-open listener setup failed:", err));
getSettings().then((s) => applyTheme(s.theme)).catch(() => {});
resizeToFit();
