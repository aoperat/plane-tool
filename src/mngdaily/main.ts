import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  getSettings,
  listMngTargets,
  submitMngDailyReport,
  updateMngDailyReport,
  deleteMngDailyReport,
} from "../shared/ipc";
import { applyTheme } from "../shared/theme";
import { colorForId } from "../shared/color";
import type { MngApiError, MngTarget, MngTargets } from "../shared/types";
import {
  DEFAULT_MNG_CONTENT_OPTIONS,
  MNG_DAILY_STATES,
  loadMngContentOptions,
  saveMngContentOptions,
  mngErrorMessage,
  mngStatusLabel,
  projectToText,
  textToHtml,
  htmlToText,
  toSpentNumber,
  type MngContentOptions,
} from "./logic";
import "../shared/app.css";

const win = getCurrentWindow();
const bodyEl = document.getElementById("mngBody")!;
const dateEl = document.getElementById("mngDate")!;
const warnEl = document.getElementById("mngWarn")!;
const refreshBtn = document.getElementById("mngRefresh") as HTMLButtonElement;
const fmtBtn = document.getElementById("mngFmtBtn") as HTMLButtonElement;
const fmtPop = document.getElementById("mngFmtPop")!;

let current: MngTargets | null = null;
let contentOptions: MngContentOptions = loadMngContentOptions();
/** 프로젝트 id -> 펼침 여부 + 편집 중인 값. 새로고침 때마다 만들어지므로,
 * 새로고침 중에 열려 있던 카드는 (의도적으로) 닫힌 채로 다시 시작한다 —
 * 그 사이 서버 상태가 바뀌었을 수 있어 새 값으로 다시 채우는 편이 안전하다. */
interface Draft {
  open: boolean;
  isEditing: boolean;
  state: string;
  spentHours: number;
  spentMinutes: number;
  content: string;
  submitting: boolean;
  error: string | null;
  confirmingDelete: boolean;
}
const drafts = new Map<string, Draft>();

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function draftFor(t: MngTarget): Draft {
  let d = drafts.get(t.project_id);
  if (d) return d;
  const row = t.existing_row;
  d = row
    ? {
        open: false,
        isEditing: true,
        state: row.state,
        spentHours: toSpentNumber(row.spent_hours),
        spentMinutes: toSpentNumber(row.spent_minutes),
        content: htmlToText(row.content_html),
        submitting: false,
        error: null,
        confirmingDelete: false,
      }
    : {
        open: false,
        isEditing: false,
        state: "02", // "완료" — 이 창은 오늘 완료한 일만 다루므로 기본값을 그쪽으로 둔다.
        spentHours: 0,
        spentMinutes: 0,
        content: t.default_content,
        submitting: false,
        error: null,
        confirmingDelete: false,
      };
  drafts.set(t.project_id, d);
  return d;
}

function regenerateDraftContent(t: MngTarget, d: Draft) {
  // 사용자가 이미 편집한 내용을 덮어쓰지 않는다 — 자동 생성 원문(신규) 또는
  // mng에 실제 저장된 원문(수정)과 여전히 같을 때만 재조립한다.
  const source = d.isEditing && t.existing_row ? htmlToText(t.existing_row.content_html) : t.default_content;
  if (d.content !== source) return;
  const regenerated = projectToText(
    t.project_name,
    t.project_identifier,
    t.client_name,
    { completed: t.completed, in_progress: t.in_progress, upcoming: t.upcoming },
    contentOptions,
    current?.report_date ?? localDate(),
  );
  // 수정 모드에서는 mng에 실제 저장된 원문이 "소스"이므로 재조립 대상이 아니다 —
  // 신규 제출일 때만 옵션 변경이 내용에 반영된다.
  if (!d.isEditing) d.content = regenerated;
}

function localDate(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function statBadge(t: MngTarget): HTMLElement {
  const badge = el("span", `mng-badge ${t.status}`);
  if (t.status === "sent" && t.existing_row) {
    badge.textContent = `${mngStatusLabel(t.status)} · ${t.existing_row.state_name}`;
  } else {
    badge.textContent = mngStatusLabel(t.status);
  }
  return badge;
}

function renderForm(t: MngTarget, formEl: HTMLElement, d: Draft) {
  formEl.innerHTML = "";
  formEl.hidden = !d.open;
  if (!d.open) return;

  // 진행상태
  const stateRow = el("div", "mng-row");
  stateRow.appendChild(el("span", "mng-label", "진행상태"));
  const track = el("div", "seg-track");
  MNG_DAILY_STATES.forEach((s) => {
    const seg = el("button", "seg") as HTMLButtonElement;
    seg.type = "button";
    seg.textContent = s.label;
    const on = s.value === d.state;
    if (on) seg.classList.add("on", s.value === "02" ? "done" : s.value === "03" ? "delay" : "");
    seg.onclick = () => {
      d.state = s.value;
      renderForm(t, formEl, d);
    };
    track.appendChild(seg);
  });
  stateRow.appendChild(track);
  formEl.appendChild(stateRow);

  // 소요시간
  const timeRow = el("div", "mng-row");
  timeRow.appendChild(el("span", "mng-label", "소요시간"));
  timeRow.appendChild(timeStepper(d.spentHours, "시간", (v) => {
    d.spentHours = v;
    renderForm(t, formEl, d);
  }));
  timeRow.appendChild(timeStepper(d.spentMinutes, "분", (v) => {
    d.spentMinutes = v;
    renderForm(t, formEl, d);
  }));
  formEl.appendChild(timeRow);

  // 내용
  const contentRow = el("div", "mng-row");
  contentRow.style.alignItems = "flex-start";
  const label = el("span", "mng-label", "내용");
  (label as HTMLElement).style.paddingTop = "8px";
  contentRow.appendChild(label);
  const textarea = document.createElement("textarea");
  textarea.className = "mng-content";
  textarea.style.flex = "1";
  textarea.value = d.content;
  textarea.oninput = () => {
    d.content = textarea.value;
  };
  contentRow.appendChild(textarea);
  formEl.appendChild(contentRow);

  if (d.isEditing) {
    formEl.appendChild(
      el(
        "p",
        "mng-edit-note",
        "mng는 항목 일부만 고치는 걸 지원하지 않아, 화면에 없는 값(사이트명 등)은 서버가 기존 값을 그대로 유지해 함께 보냅니다. 서식은 유지되지 않습니다.",
      ),
    );
  }
  if (!current?.mng_available) {
    const warn = el(
      "p",
      "mng-edit-note",
      "mng 서버에 연결하지 못해 오늘 이미 등록된 내역이 있는지 확인할 수 없습니다. 이미 보냈다면 중복 등록될 수 있습니다.",
    );
    (warn as HTMLElement).style.color = "var(--amber)";
    formEl.appendChild(warn);
  }
  if (d.error) {
    const err = el("p", "mng-edit-note", d.error);
    (err as HTMLElement).style.color = "var(--red)";
    formEl.appendChild(err);
  }

  // 제출/취소/삭제
  const footRow = el("div", "mng-foot-row");
  const submitBtn = el("button", "qa-submit") as HTMLButtonElement;
  submitBtn.type = "button";
  const canEdit = !d.isEditing || (t.existing_row?.editable ?? true);
  submitBtn.disabled = d.submitting || !current?.employee_no || !canEdit;
  submitBtn.textContent = d.submitting
    ? d.isEditing
      ? "저장 중…"
      : "전송 중…"
    : !current?.mng_available && !d.isEditing
      ? "그래도 제출"
      : d.isEditing
        ? "저장"
        : "mng로 제출";
  submitBtn.onclick = () => void submit(t, formEl, d);
  footRow.appendChild(submitBtn);

  const cancelBtn = el("button", "em-btn em-btn-ghost") as HTMLButtonElement;
  cancelBtn.type = "button";
  cancelBtn.textContent = "취소";
  cancelBtn.onclick = () => {
    d.open = false;
    renderAll();
  };
  footRow.appendChild(cancelBtn);

  if (d.isEditing && t.existing_row?.editable) {
    const delBtn = el("button", "em-delete") as HTMLButtonElement;
    delBtn.type = "button";
    delBtn.style.marginLeft = "auto";
    delBtn.textContent = d.confirmingDelete ? "정말 삭제할까요? 다시 클릭" : "이 제출 삭제";
    delBtn.onclick = () => {
      if (!d.confirmingDelete) {
        d.confirmingDelete = true;
        renderForm(t, formEl, d);
        setTimeout(() => {
          if (d.confirmingDelete) {
            d.confirmingDelete = false;
            renderForm(t, formEl, d);
          }
        }, 3000);
        return;
      }
      void remove(t, formEl, d);
    };
    footRow.appendChild(delBtn);
  }
  formEl.appendChild(footRow);
}

function timeStepper(value: number, unit: string, onChange: (v: number) => void): HTMLElement {
  const wrap = el("div", "date-stepper");
  const minus = el("button", "step", "−") as HTMLButtonElement;
  minus.type = "button";
  minus.onclick = () => onChange(Math.max(0, value - 1));
  const val = el("span", "val", `${value}${unit}`);
  const plus = el("button", "step", "+") as HTMLButtonElement;
  plus.type = "button";
  plus.onclick = () => onChange(value + 1);
  wrap.append(minus, val, plus);
  return wrap;
}

async function submit(t: MngTarget, formEl: HTMLElement, d: Draft) {
  d.submitting = true;
  d.error = null;
  renderForm(t, formEl, d);
  try {
    if (d.isEditing && t.existing_row) {
      await updateMngDailyReport(
        current!.report_date,
        t.existing_row.seq,
        d.state,
        textToHtml(d.content),
        d.spentHours,
        d.spentMinutes,
      );
    } else {
      await submitMngDailyReport(
        t.project_id,
        d.state,
        textToHtml(d.content),
        current!.report_date,
        d.spentHours,
        d.spentMinutes,
      );
    }
    drafts.delete(t.project_id);
    await refresh();
  } catch (e) {
    d.submitting = false;
    d.error = mngErrorMessage(e as MngApiError);
    renderForm(t, formEl, d);
  }
}

async function remove(t: MngTarget, formEl: HTMLElement, d: Draft) {
  if (!t.existing_row) return;
  d.submitting = true;
  d.error = null;
  renderForm(t, formEl, d);
  try {
    await deleteMngDailyReport(current!.report_date, t.existing_row.seq);
    drafts.delete(t.project_id);
    await refresh();
  } catch (e) {
    d.submitting = false;
    d.confirmingDelete = false;
    d.error = mngErrorMessage(e as MngApiError);
    renderForm(t, formEl, d);
  }
}

function projectCard(t: MngTarget): HTMLElement {
  const d = draftFor(t);
  const card = el("div", "mng-proj" + (d.open ? " open" : ""));
  card.dataset.projectId = t.project_id;

  const head = el("div", "mng-proj-head");
  const dot = el("span", "dot");
  dot.style.background = colorForId(t.project_id);
  head.appendChild(dot);
  head.appendChild(el("span", "name", t.project_name));
  head.appendChild(el("span", "ident", t.project_identifier));
  head.appendChild(statBadge(t));
  head.appendChild(el("span", "chev", "▾"));
  head.onclick = () => {
    d.open = !d.open;
    if (d.open) regenerateDraftContent(t, d);
    renderAll();
  };
  card.appendChild(head);

  const items = el("div", "mng-items");
  for (const it of t.completed) items.appendChild(el("div", "it", it.name));
  card.appendChild(items);

  const form = el("div", "mng-form");
  form.hidden = !d.open;
  card.appendChild(form);
  renderForm(t, form, d);

  return card;
}

function renderAll() {
  if (!current) return;
  dateEl.textContent = current.report_date;
  warnEl.hidden = !!current.employee_no;
  if (!current.employee_no) {
    warnEl.innerHTML = "";
    warnEl.appendChild(
      el(
        "span",
        "",
        "사번이 등록돼 있지 않아 mng에 제출할 수 없습니다. Plane 프로필 설정에서 등록해주세요.",
      ),
    );
  }

  bodyEl.innerHTML = "";
  if (current.targets.length === 0) {
    bodyEl.appendChild(el("p", "mng-empty", "오늘 mng 연동 프로젝트에 완료한 항목이 없습니다."));
    return;
  }
  for (const t of current.targets) bodyEl.appendChild(projectCard(t));
}

function renderLoading() {
  bodyEl.innerHTML = "";
  warnEl.hidden = true;
  bodyEl.appendChild(el("p", "mng-loading", "불러오는 중…"));
}

function renderError(err: unknown) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(el("p", "mng-empty", "불러오지 못했어요: " + err));
}

async function refresh() {
  refreshBtn.disabled = true;
  renderLoading();
  try {
    current = await listMngTargets();
    drafts.clear();
    renderAll();
  } catch (e) {
    console.error("listMngTargets failed:", e);
    renderError(e);
  } finally {
    refreshBtn.disabled = false;
  }
}

// ── 포함 항목 설정 팝오버 ──
function renderFmtPop() {
  fmtPop.querySelectorAll<HTMLButtonElement>("[data-fmt-key]").forEach((btn) => {
    const key = btn.dataset.fmtKey as keyof MngContentOptions;
    const on = contentOptions[key];
    btn.classList.toggle("on", on);
    btn.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : "";
    btn.onclick = () => {
      contentOptions = { ...contentOptions, [key]: !on };
      saveMngContentOptions(contentOptions);
      renderFmtPop();
      // 열려 있는 신규 제출 폼(수정 아님)의 내용을 새 옵션으로 다시 조립한다.
      if (current) {
        for (const t of current.targets) {
          const d = drafts.get(t.project_id);
          if (d?.open) regenerateDraftContent(t, d);
        }
        renderAll();
      }
    };
  });
}

fmtBtn.onclick = () => {
  if (fmtPop.hidden) {
    const r = fmtBtn.getBoundingClientRect();
    fmtPop.style.position = "fixed";
    fmtPop.style.top = `${r.bottom + 6}px`;
    fmtPop.style.right = `${window.innerWidth - r.right}px`;
    fmtPop.hidden = false;
  } else {
    fmtPop.hidden = true;
  }
};
document.addEventListener("click", (e) => {
  if (fmtPop.hidden) return;
  const target = e.target as Node;
  if (!fmtPop.contains(target) && target !== fmtBtn && !fmtBtn.contains(target)) fmtPop.hidden = true;
});
renderFmtPop();

refreshBtn.onclick = () => void refresh();
document.getElementById("mngClose")!.onclick = () => win.hide();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});

// 창이 열릴 때: briefing과 같은 이유로 "이미 보이는 상태" 폴백도 같이 둔다 —
// 리스너 등록 전에 열림 신호가 먼저 발생하면 Tauri가 그 이벤트를 버린다.
listen("mngdaily-open", () => void refresh())
  .then(() => win.isVisible())
  .then((visible) => {
    if (visible) void refresh();
  })
  .catch((err) => console.error("mngdaily-open listener setup failed:", err));
getSettings().then((s) => applyTheme(s.theme)).catch(() => {});
