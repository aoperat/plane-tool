import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  getSettings,
  listMngTargets,
  linkMngProject,
  searchMngProjects,
  updateWorkItemState,
  submitMngDailyReport,
  submitMngDailyReports,
  updateMngDailyReport,
  deleteMngDailyReport,
} from "../shared/ipc";

/** `MNG_SEARCH_PER_PAGE`(commands.rs)와 같은 값이어야 페이지 수 계산이 맞다. */
const MNG_LINK_PER_PAGE = 20;
import { applyTheme } from "../shared/theme";
import { colorForId } from "../shared/color";
import { stateIcon, type StateGroup } from "../shared/planeIcons";
import type {
  MngApiError,
  MngBulkResult,
  MngProjectRow,
  MngReportItem,
  MngTarget,
  MngTargets,
} from "../shared/types";
import {
  DEFAULT_MNG_CONTENT_OPTIONS,
  MNG_DAILY_STATES,
  MNG_GROUPS,
  loadMngContentOptions,
  saveMngContentOptions,
  defaultSelectedItemIds,
  hasReportableItems,
  isEmployeeNoMissing,
  isSelectable,
  isSelectedByDefault,
  lockedReason,
  mngBadge,
  mngErrorMessage,
  mngPriorityLabel,
  mngWarningMessage,
  projectCheckState,
  projectToText,
  reportGroupFor,
  selectedGroups,
  withItemStateChanged,
  textToHtml,
  htmlToText,
  toSpentNumber,
  type MngContentOptions,
  type MngReportGroup,
} from "./logic";
import "../shared/app.css";

const win = getCurrentWindow();
const listEl = document.getElementById("mngList")!;
const detailEl = document.getElementById("mngDetail")!;
const dateEl = document.getElementById("mngDate")!;
const warnEl = document.getElementById("mngWarn")!;
const bulkEl = document.getElementById("mngBulk")!;
const refreshBtn = document.getElementById("mngRefresh") as HTMLButtonElement;
const fmtBtn = document.getElementById("mngFmtBtn") as HTMLButtonElement;
const fmtPop = document.getElementById("mngFmtPop")!;

let current: MngTargets | null = null;
let contentOptions: MngContentOptions = loadMngContentOptions();
/** 프로젝트 id -> 편집 중인 값. 새로고침 때마다 만들어지므로,
 * 새로고침 중에 열려 있던 카드는 (의도적으로) 닫힌 채로 다시 시작한다 —
 * 그 사이 서버 상태가 바뀌었을 수 있어 새 값으로 다시 채우는 편이 안전하다. */
interface Draft {
  isEditing: boolean;
  state: string;
  spentHours: number;
  spentMinutes: number;
  content: string;
  submitting: boolean;
  error: string | null;
  confirmingDelete: boolean;
  /** 일지 내용에 넣을 항목 id. 여기서 빼면 내용이 자동으로 다시 조립되므로,
   *  textarea를 손으로 고쳐 "사용자 편집" 상태가 되는 걸 피할 수 있다.
   *
   *  프로젝트 선택 여부를 따로 들고 있지 않는 이유: 두 값을 각각 두면 "프로젝트는
   *  체크됐는데 항목은 전부 꺼짐" 같은 서로 어긋난 상태가 생긴다. 제출 대상인지는
   *  이 집합이 비었는지로만 판단한다. */
  selectedItems: Set<string>;
  /** 마지막으로 자동 조립한 내용. `content`가 이것과 다르면 사용자가 직접
   *  고친 것이므로 재조립하지 않는다. */
  autoContent: string;
}
const drafts = new Map<string, Draft>();
/** 직전 일괄 제출 결과. 다음 새로고침 전까지 목록 위에 남는다. */
let lastBulk: { results: MngBulkResult[]; names: Map<string, string> } | null = null;
/** 우측에 펼쳐 볼 프로젝트. 접었다 폈다 하는 대신 한 번에 하나만 크게 본다 —
 *  좁은 폭에서 항목 줄이 잘려 읽히지 않던 문제를 이 분할이 없앤다. */
let openId: string | null = null;
let bulkRunning = false;
let bulkDone = 0;
let bulkTotal = 0;

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
  // 오늘 완료한 게 없는 프로젝트는 꺼진 채로 시작한다 — 항목 집합이 비어 있으면
  // 제출 대상이 아니라는 뜻이다(프로젝트 체크를 켜면 기본 선택으로 채워진다).
  const selectedItems = isSelectedByDefault(t) ? defaultSelectedItemIds(t) : new Set<string>();
  // 서버가 만든 default_content는 항목 전부로 렌더한 것이라 기본 선택(예정 제외)과
  // 어긋난다 — 처음부터 선택 기준으로 다시 조립해 둔다.
  const auto = contentFor(t, selectedItems);
  d = row
    ? {
        isEditing: true,
        state: row.state,
        spentHours: toSpentNumber(row.spent_hours),
        spentMinutes: toSpentNumber(row.spent_minutes),
        content: htmlToText(row.content_html),
        submitting: false,
        error: null,
        confirmingDelete: false,
        selectedItems,
        autoContent: "", // 수정 모드는 재조립하지 않으므로 쓰이지 않는다.
      }
    : {
        isEditing: false,
        state: "02", // "완료" — 이 창은 오늘 완료한 일만 다루므로 기본값을 그쪽으로 둔다.
        spentHours: 0,
        spentMinutes: 0,
        content: auto,
        submitting: false,
        error: null,
        confirmingDelete: false,
        selectedItems,
        autoContent: auto,
      };
  drafts.set(t.project_id, d);
  return d;
}

/** 선택된 항목만으로 조립한 일지 내용. */
function contentFor(t: MngTarget, selected: ReadonlySet<string>): string {
  return projectToText(
    t.project_name,
    t.project_identifier,
    t.client_name,
    selectedGroups(t, selected),
    contentOptions,
    current?.report_date ?? localDate(),
  );
}

/** 항목 체크나 포함 옵션이 바뀌었을 때 내용을 다시 조립한다.
 *
 *  사용자가 textarea를 직접 고쳤으면(= `content`가 마지막 자동 조립 결과와
 *  다르면) 덮어쓰지 않는다. 판정 기준을 `autoContent`로 따로 들고 있는 이유는,
 *  체크와 옵션 두 축이 각각 내용을 바꾸기 때문이다 — 옛 옵션으로 다시 계산해
 *  비교하는 방식은 축이 하나일 때만 성립한다.
 *
 *  수정 모드에서는 mng에 실제 저장된 원문이 소스이므로 재조립하지 않는다. */
function regenerateDraftContent(t: MngTarget, d: Draft) {
  if (d.isEditing) return;
  if (d.content !== d.autoContent) return;
  d.autoContent = contentFor(t, d.selectedItems);
  d.content = d.autoContent;
}

function localDate(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function statBadge(t: MngTarget): HTMLElement {
  const { label, kind } = mngBadge(t);
  const badge = el("span", `mng-badge ${kind}`);
  badge.textContent =
    t.status === "sent" && t.existing_row ? `${label} · ${t.existing_row.state_name}` : label;
  return badge;
}

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
const DASH_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M4 8h8"/></svg>';

function checkbox(
  state: "on" | "partial" | "off",
  opts: { small?: boolean; disabled?: boolean; title?: string },
): HTMLButtonElement {
  const b = el("button", `mng-check${opts.small ? " sm" : ""}${state === "off" ? "" : ` ${state}`}`) as HTMLButtonElement;
  b.type = "button";
  b.disabled = opts.disabled ?? false;
  if (opts.title) b.title = opts.title;
  b.innerHTML = state === "on" ? CHECK_SVG : state === "partial" ? DASH_SVG : "";
  return b;
}

/** 사이드바(`sidebar/main.ts`)와 같은 순서·문구를 쓴다 — 같은 작업을 두 창에서
 *  다르게 부르면 헷갈린다. */
const STATE_GROUPS: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
const STATE_LABELS: Record<string, string> = {
  backlog: "백로그",
  unstarted: "시작 전",
  started: "진행 중",
  completed: "완료",
  cancelled: "취소",
};

let statePop: HTMLElement | null = null;

function closeStatePop() {
  statePop?.remove();
  statePop = null;
}
document.addEventListener("click", closeStatePop);

/** 항목의 Plane 상태를 바꾼다. 화면에서 먼저 옮기고 서버에 보낸 뒤, 실패하면
 *  되돌린다 — 새로고침으로 처리하면 작성 중이던 내용이 날아간다. */
function changeItemState(t: MngTarget, item: MngReportItem, to: StateGroup) {
  const stateId = t.state_ids[to];
  if (!stateId) {
    // 프로젝트에 그 그룹의 상태가 아예 없는 경우(Plane에서 삭제 가능).
    alertLine(`이 프로젝트에는 "${STATE_LABELS[to]}" 상태가 없습니다.`);
    return;
  }
  const before = { completed: t.completed, in_progress: t.in_progress, upcoming: t.upcoming };
  const after = withItemStateChanged(t, item.id, to, new Date().toISOString());
  Object.assign(t, after);
  // 일지에서 빠지는 상태(백로그·취소)로 옮기면 선택도 함께 거둔다.
  if (reportGroupFor(to) === null) {
    const d = draftFor(t);
    d.selectedItems.delete(item.id);
  }
  const d = draftFor(t);
  regenerateDraftContent(t, d);
  renderAll();

  updateWorkItemState(t.project_id, item.id, stateId).catch((err) => {
    Object.assign(t, before);
    regenerateDraftContent(t, draftFor(t));
    renderAll();
    alertLine("상태 변경 실패: " + err);
    console.error("updateWorkItemState failed:", err);
  });
}

/** 상세 상단에 잠깐 띄우는 한 줄 알림. 이 창에는 토스트 체계가 없어 최소한으로 둔다. */
function alertLine(text: string) {
  const line = el("p", "mng-edit-note", text);
  line.style.color = "var(--red)";
  detailEl.prepend(line);
  setTimeout(() => line.remove(), 4000);
}

function openStatePop(anchor: HTMLElement, t: MngTarget, item: MngReportItem) {
  closeStatePop();
  const pop = el("div", "pop");
  pop.style.position = "fixed";
  for (const g of STATE_GROUPS) {
    const opt = el("div", "pop-item" + (g === item.state_group ? " sel" : ""));
    opt.innerHTML = stateIcon(g);
    opt.appendChild(document.createTextNode(STATE_LABELS[g]));
    opt.onclick = (e) => {
      e.stopPropagation();
      closeStatePop();
      if (g !== item.state_group) changeItemState(t, item, g);
    };
    pop.appendChild(opt);
  }
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(pop);
  statePop = pop;
}

const GROUP_LABELS: Record<MngReportGroup, string> = {
  completed: "완료",
  in_progress: "진행중",
  upcoming: "예정",
};
const GROUP_DOTS: Record<MngReportGroup, string> = {
  completed: "done",
  in_progress: "doing",
  upcoming: "todo",
};

/** 항목 한 줄의 오른쪽 부가정보 — 완료 시각 / 마감 / 시작일. */
function itemMeta(it: MngReportItem, group: MngReportGroup): string {
  if (group === "completed" && it.completed_at) {
    const d = new Date(it.completed_at);
    if (!Number.isNaN(d.getTime())) {
      const p = (v: number) => String(v).padStart(2, "0");
      return `완료 ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  if (group === "upcoming" && it.start_date) return `시작 ${it.start_date.slice(5)}`;
  if (it.target_date) return `마감 ${it.target_date.slice(5)}`;
  return "";
}

/** 좌측 목록에서 한눈에 읽히는 그룹 건수 요약. */
function groupCounts(t: MngTarget): HTMLElement {
  const counts = el("span", "mng-counts");
  for (const g of MNG_GROUPS) {
    const gc = el("span", `mng-gc ${GROUP_DOTS[g]}`);
    gc.append(`${GROUP_LABELS[g]} `);
    gc.appendChild(el("b", "", String(t[g].length)));
    counts.appendChild(gc);
  }
  return counts;
}

/** 한 그룹의 항목 목록 + 그룹 통째로 켜고 끄는 버튼. */
function groupSection(t: MngTarget, d: Draft, group: MngReportGroup, locked: boolean): HTMLElement | null {
  const items = t[group];
  const sec = el("div", "mng-grp");
  const head = el("div", "mng-grp-head");
  head.appendChild(el("span", "", GROUP_LABELS[group]));
  head.appendChild(el("span", "n", String(items.length)));
  head.appendChild(el("span", "rule"));

  if (group === "completed" && items.length === 0) {
    // 완료가 없다는 사실 자체가 정보다 — 그룹을 통째로 숨기면 "오늘 완료가
    // 없는데도 목록에 있다"는 상황을 사용자가 이해하지 못한다.
    sec.appendChild(head);
    sec.appendChild(
      el("p", "mng-edit-note", "오늘 완료한 항목이 없습니다 — 진행중 항목으로 일지를 만듭니다."),
    );
    return sec;
  }
  if (items.length === 0) return null;

  if (!locked) {
    const allOn = items.every((i) => d.selectedItems.has(i.id));
    const tog = el("button", "tog", allOn ? "그룹 해제" : "그룹 선택") as HTMLButtonElement;
    tog.type = "button";
    tog.onclick = (e) => {
      e.stopPropagation();
      for (const i of items) {
        if (allOn) d.selectedItems.delete(i.id);
        else d.selectedItems.add(i.id);
      }
      regenerateDraftContent(t, d);
      renderAll();
    };
    head.appendChild(tog);
  }
  sec.appendChild(head);

  for (const it of items) {
    const on = d.selectedItems.has(it.id);
    const row = el("label", `mng-item${on ? "" : " off"}`);
    const box = checkbox(on ? "on" : "off", { small: true, disabled: locked });
    box.onclick = (e) => {
      e.stopPropagation();
      if (on) d.selectedItems.delete(it.id);
      else d.selectedItems.add(it.id);
      regenerateDraftContent(t, d);
      renderAll();
    };
    row.appendChild(box);
    // 장식용 색 점 대신 상태 버튼 — 일지를 쓰다 "이건 오늘 끝냈지" 싶을 때
    // Plane으로 건너가지 않고 여기서 바로 완료로 옮길 수 있어야 한다.
    const st = el("span", "mng-state") as HTMLElement;
    st.innerHTML = stateIcon(it.state_group as StateGroup);
    st.title = `상태: ${STATE_LABELS[it.state_group] ?? it.state_group} (눌러서 변경)`;
    st.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStatePop(st, t, it);
    };
    row.appendChild(st);
    row.appendChild(el("span", "cd", `${t.project_identifier}-${it.sequence_id}`));
    row.appendChild(el("span", "tx", it.name));
    if (it.priority === "urgent" || it.priority === "high") {
      row.appendChild(el("span", `pri ${it.priority}`, mngPriorityLabel(it.priority)));
    }
    const meta = itemMeta(it, group);
    if (meta) row.appendChild(el("span", "mt", meta));
    sec.appendChild(row);
  }
  return sec;
}

function renderForm(t: MngTarget, formEl: HTMLElement, d: Draft) {
  formEl.innerHTML = "";

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

  // 내용 — 라벨을 위에 두고 폭을 통째로 쓴다. 항목이 늘면 높이가 알아서 자란다.
  const contentRow = el("div", "mng-field");
  contentRow.appendChild(el("span", "mng-field-label", "내용"));
  const textarea = document.createElement("textarea");
  textarea.className = "mng-content";
  textarea.value = d.content;
  textarea.oninput = () => {
    d.content = textarea.value;
    autoGrow(textarea);
  };
  contentRow.appendChild(textarea);
  formEl.appendChild(contentRow);
  // 폼이 DOM에 붙은 뒤라야 scrollHeight가 실제 값을 준다.
  requestAnimationFrame(() => autoGrow(textarea));

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
  // 사번 미등록이 확실할 때만 막는다 — mng 연결 실패로 사번을 모르는 것뿐이면
  // "그래도 제출"을 살려둔다(아래 라벨과 짝을 이룬다). 실제로 사번이 없으면
  // 서버가 POST 시점에 EMPLOYEE_NO_MISSING으로 거절한다.
  const employeeNoMissing = current !== null && isEmployeeNoMissing(current);
  submitBtn.disabled = d.submitting || employeeNoMissing || !canEdit;
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

  // 접기 버튼 대신 "내용 초기화" — 오른쪽 칸은 늘 열려 있으므로 접을 게 없고,
  // 손으로 고치다 망친 내용을 체크 상태 기준으로 되돌리는 쪽이 실제로 필요하다.
  const resetBtn = el("button", "em-btn em-btn-ghost") as HTMLButtonElement;
  resetBtn.type = "button";
  resetBtn.textContent = "내용 초기화";
  resetBtn.disabled = d.isEditing || d.content === d.autoContent;
  resetBtn.onclick = () => {
    d.autoContent = contentFor(t, d.selectedItems);
    d.content = d.autoContent;
    renderForm(t, formEl, d);
  };
  footRow.appendChild(resetBtn);

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

/** 스크롤바 없이 내용이 다 보이도록 높이를 내용에 맞춘다 — 직접 끌어 늘릴
 *  필요가 없어야 한다. 상한을 두는 이유는 항목이 많은 날 폼이 화면을 통째로
 *  밀어내지 않게 하기 위해서다(그 위로는 textarea가 스크롤한다). */
function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 420)}px`;
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

/** 좌측 목록의 프로젝트 한 줄. 체크는 제출 대상 고르기, 줄 클릭은 우측에 펼치기 —
 *  두 동작이 한 줄에 겹치므로 체크는 클릭을 삼킨다. */
function projectRow(t: MngTarget): HTMLElement {
  const d = draftFor(t);
  const selectable = isSelectable(t);
  const locked = !selectable;
  const row = el(
    "div",
    "mng-proj-row" +
      (t.project_id === openId ? " active" : "") +
      (lockedReason(t) ? " disabled" : ""),
  );
  row.dataset.projectId = t.project_id;

  const top = el("div", "top");
  const boxState = selectable ? projectCheckState(t, d.selectedItems) : "off";
  const box = checkbox(boxState, {
    disabled: locked,
    title: locked ? undefined : "제출 대상으로 선택",
  });
  box.onclick = (e) => {
    e.stopPropagation();
    // 켜면 기본 선택(완료·진행중)으로 채우고, 끄면 전부 비운다. 항목을 일부만
    // 켠 "중간" 상태에서 누르면 켜는 쪽으로 맞춘다.
    d.selectedItems = boxState === "on" ? new Set<string>() : defaultSelectedItemIds(t);
    regenerateDraftContent(t, d);
    renderAll();
  };
  top.appendChild(box);
  const dot = el("span", "dot");
  dot.style.background = colorForId(t.project_id);
  top.appendChild(dot);
  const nm = el("span", "nm", t.project_name);
  nm.title = t.project_name;
  top.appendChild(nm);
  // 배지는 윗줄 오른쪽에 둔다 — 아랫줄에서 건수와 폭을 다투면 둘 다 잘린다.
  top.appendChild(statBadge(t));
  row.appendChild(top);

  const bot = el("div", "bot");
  bot.appendChild(el("span", "ident", t.project_identifier));
  if (hasReportableItems(t)) bot.appendChild(groupCounts(t));
  row.appendChild(bot);

  row.onclick = () => {
    openId = t.project_id;
    renderAll();
  };
  return row;
}

/** 우측 상세 — 고른 프로젝트의 항목 목록과 작성 폼. */
function renderDetail() {
  detailEl.innerHTML = "";
  const t = current?.targets.find((x) => x.project_id === openId);
  if (!t) {
    detailEl.appendChild(
      el("div", "mng-detail-empty", "왼쪽에서 프로젝트를 고르면 작업 목록과 작성 폼이 여기 표시됩니다."),
    );
    return;
  }
  const d = draftFor(t);
  const locked = !isSelectable(t);
  const reason = lockedReason(t);

  const head = el("div", "mng-detail-head");
  const dot = el("span", "dot");
  dot.style.background = colorForId(t.project_id);
  head.appendChild(dot);
  head.appendChild(el("span", "nm", t.project_name));
  head.appendChild(el("span", "cl", t.client_name ? `${t.project_identifier} · ${t.client_name}` : t.project_identifier));
  head.appendChild(statBadge(t));
  detailEl.appendChild(head);

  for (const g of MNG_GROUPS) {
    const sec = groupSection(t, d, g, locked);
    if (sec) detailEl.appendChild(sec);
  }

  if (reason) {
    const note = el("div", "mng-form");
    note.appendChild(el("p", "mng-edit-note", reason));
    // 미연동은 여기서 바로 풀 수 있는 문제다 — 안내만 하고 끝내면 사용자는
    // 어디로 가야 할지 모른 채 창을 닫게 된다.
    if (!t.mng_linked) note.appendChild(linkPanel(t));
    detailEl.appendChild(note);
    return;
  }

  const form = el("div", "mng-form");
  detailEl.appendChild(form);
  renderForm(t, form, d);
}

/* ---- mng 연동 패널 ----------------------------------------------------- */
/* 프로젝트별 검색 상태. 카드를 옮겨 다녀도 방금 친 검색어가 남아 있도록 창이
   살아 있는 동안 유지한다. */
interface LinkState {
  q: string;
  page: number;
  total: number;
  rows: MngProjectRow[];
  loading: boolean;
  error: string | null;
  /** 연결 요청 중인 행의 seq. 두 번 눌러 두 번 보내는 것을 막는다. */
  linking: string | null;
}
const linkStates = new Map<string, LinkState>();

function linkStateFor(projectId: string): LinkState {
  let s = linkStates.get(projectId);
  if (!s) {
    s = { q: "", page: 1, total: 0, rows: [], loading: false, error: null, linking: null };
    linkStates.set(projectId, s);
  }
  return s;
}

async function runLinkSearch(t: MngTarget, page: number) {
  const s = linkStateFor(t.project_id);
  s.loading = true;
  s.error = null;
  s.page = page;
  renderDetail();
  try {
    const res = await searchMngProjects(s.q, page);
    s.rows = res.results;
    s.total = res.total;
  } catch (e) {
    s.rows = [];
    s.total = 0;
    // 검색 커맨드는 구조화된 mng 에러가 아니라 문자열을 올린다(서버가 503을
    // 주면 그 본문이 그대로 실린다) — 코드 기반 안내문을 쓸 수 없다.
    s.error = `검색에 실패했습니다: ${typeof e === "string" ? e : String((e as Error)?.message ?? e)}`;
  } finally {
    s.loading = false;
    renderDetail();
  }
}

async function doLink(t: MngTarget, row: MngProjectRow) {
  const s = linkStateFor(t.project_id);
  if (s.linking) return;
  s.linking = row.seq;
  s.error = null;
  renderDetail();
  try {
    await linkMngProject(t.project_id, row);
    // 연결되면 제출 가능 여부가 바뀌므로 목록 전체를 다시 읽는다. 여기서
    // t.mng_linked만 손으로 켜면 서버가 실제로 무엇을 저장했는지와 어긋난다.
    linkStates.delete(t.project_id);
    await refresh();
  } catch (e) {
    s.linking = null;
    s.error = mngErrorMessage(e as MngApiError);
    renderDetail();
  }
}

/** 미연동 카드 아래에 붙는 검색·연결 패널. */
function linkPanel(t: MngTarget): HTMLElement {
  const s = linkStateFor(t.project_id);
  const box = el("div", "mng-link");

  const searchRow = el("div", "mng-link-search");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mng-link-input";
  input.placeholder = "mng 프로젝트명으로 검색";
  input.value = s.q;
  const submit = () => {
    s.q = input.value.trim();
    void runLinkSearch(t, 1);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    // 창 전역 Esc(닫기)로 번지지 않게 막는다 — 여기서는 입력만 비운다.
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
    }
  };
  searchRow.appendChild(input);
  const btn = el("button", "mng-link-btn", "검색") as HTMLButtonElement;
  btn.type = "button";
  btn.onclick = submit;
  searchRow.appendChild(btn);
  box.appendChild(searchRow);

  if (s.loading) {
    box.appendChild(el("p", "mng-link-msg", "검색 중…"));
    return box;
  }
  if (s.error) {
    box.appendChild(el("p", "mng-link-msg err", s.error));
  }
  if (s.rows.length === 0) {
    box.appendChild(
      el("p", "mng-link-msg", s.q ? "검색 결과가 없습니다." : "프로젝트명을 넣고 검색하세요."),
    );
    return box;
  }

  const list = el("div", "mng-link-list");
  for (const row of s.rows) {
    const r = el("div", "mng-link-row");
    const main = el("div", "mn");
    main.appendChild(el("span", "nm", row.name));
    const meta = [row.client, row.state_name, row.period].filter(Boolean).join(" · ");
    if (meta) main.appendChild(el("span", "mt", meta));
    r.appendChild(main);
    const pick = el(
      "button",
      "mng-link-btn",
      s.linking === row.seq ? "연결 중…" : "연결",
    ) as HTMLButtonElement;
    pick.type = "button";
    pick.disabled = s.linking !== null;
    pick.onclick = () => void doLink(t, row);
    r.appendChild(pick);
    list.appendChild(r);
  }
  box.appendChild(list);

  const lastPage = Math.max(1, Math.ceil(s.total / MNG_LINK_PER_PAGE));
  if (lastPage > 1) {
    const pager = el("div", "mng-link-pager");
    const prev = el("button", "mng-link-btn", "‹") as HTMLButtonElement;
    prev.type = "button";
    prev.disabled = s.page <= 1;
    prev.onclick = () => void runLinkSearch(t, s.page - 1);
    const next = el("button", "mng-link-btn", "›") as HTMLButtonElement;
    next.type = "button";
    next.disabled = s.page >= lastPage;
    next.onclick = () => void runLinkSearch(t, s.page + 1);
    pager.appendChild(prev);
    pager.appendChild(el("span", "pg", `${s.page} / ${lastPage}`));
    pager.appendChild(next);
    box.appendChild(pager);
  }
  return box;
}

/** 일괄 제출 대상. 체크됐고, 담을 항목이 실제로 하나 이상 켜져 있는 것만. */
function pickedEntries(): { target: MngTarget; draft: Draft }[] {
  if (!current) return [];
  return current.targets
    .filter((t) => isSelectable(t))
    .map((t) => ({ target: t, draft: draftFor(t) }))
    .filter(({ target, draft }) => projectCheckState(target, draft.selectedItems) !== "off");
}

/** 직전 일괄 제출 결과 카드. */
function bulkResultCard(): HTMLElement {
  const wrap = el("div", "mng-result");
  wrap.appendChild(el("div", "hd", `제출 결과 · ${current?.report_date ?? ""}`));
  for (const r of lastBulk!.results) {
    const row = el("div", "mng-res");
    row.appendChild(el("span", r.ok ? "ok" : "fail", r.ok ? "✓" : "✕"));
    row.appendChild(el("span", "nm", lastBulk!.names.get(r.project_id) ?? r.project_id));
    row.appendChild(
      el("span", "why", r.ok ? "등록 완료" : r.error ? mngErrorMessage(r.error) : "제출하지 못했습니다"),
    );
    wrap.appendChild(row);
  }
  return wrap;
}

/** 하단 고정 바 — 선택 개수와 일괄 제출 버튼. */
function renderBulkBar() {
  const picked = pickedEntries();
  const failed = lastBulk?.results.filter((r) => !r.ok) ?? [];
  bulkEl.innerHTML = "";
  if (!current || (picked.length === 0 && failed.length === 0 && !bulkRunning)) {
    bulkEl.hidden = true;
    return;
  }
  bulkEl.hidden = false;

  const sum = el("span", "sum");
  if (bulkRunning) {
    sum.textContent = `제출 중… ${bulkDone} / ${bulkTotal}`;
  } else if (lastBulk) {
    const ok = lastBulk.results.length - failed.length;
    sum.innerHTML = failed.length
      ? `<b>${ok}건</b> 성공 · <b style="color:var(--red)">${failed.length}건</b> 실패`
      : `<b>${ok}건</b> 제출 완료`;
  } else {
    const items = picked.reduce(
      (n, { target, draft }) => n + MNG_GROUPS.reduce((m, g) => m + target[g].filter((i) => draft.selectedItems.has(i.id)).length, 0),
      0,
    );
    sum.innerHTML = `<b>${picked.length}개</b> 프로젝트 · 작업 <b>${items}건</b> 선택됨`;
  }
  bulkEl.appendChild(sum);

  const btn = el("button", "qa-submit") as HTMLButtonElement;
  btn.type = "button";
  btn.disabled = bulkRunning || picked.length === 0 || isEmployeeNoMissing(current);
  if (bulkRunning) {
    btn.textContent = "제출 중…";
  } else if (!current.mng_available) {
    btn.textContent = "그래도 제출";
    btn.style.background = "var(--amber)";
  } else {
    btn.textContent = failed.length ? `실패한 ${failed.length}건 다시 시도` : "선택 항목 제출";
  }
  btn.onclick = () => void submitBulk();
  bulkEl.appendChild(btn);
}

async function submitBulk() {
  const picked = pickedEntries();
  if (!current || !picked.length) return;
  lastBulk = null;
  bulkRunning = true;
  bulkDone = 0;
  bulkTotal = picked.length;
  renderAll();
  const names = new Map(picked.map(({ target }) => [target.project_id, target.project_name]));
  try {
    const results = await submitMngDailyReports(
      current.report_date,
      picked.map(({ target, draft }) => ({
        project_id: target.project_id,
        state: draft.state,
        content_html: textToHtml(draft.content),
        spent_hours: draft.spentHours,
        spent_minutes: draft.spentMinutes,
      })),
    );
    bulkRunning = false;
    lastBulk = { results, names };
    // 성공한 것만 초안을 버려 다음 새로고침에서 서버 상태로 다시 그린다.
    for (const r of results) if (r.ok) drafts.delete(r.project_id);
    await refresh();
  } catch (e) {
    bulkRunning = false;
    lastBulk = {
      results: picked.map(({ target }) => ({
        project_id: target.project_id,
        ok: false,
        error: { error_code: "NETWORK", message: String(e) },
      })),
      names,
    };
    renderAll();
  }
}

function renderAll() {
  if (!current) return;
  dateEl.textContent = current.report_date;
  const warning = mngWarningMessage(current);
  warnEl.hidden = warning === null;
  if (warning !== null) {
    warnEl.innerHTML = "";
    warnEl.appendChild(el("span", "", warning));
  }

  listEl.innerHTML = "";
  if (current.targets.length === 0) {
    listEl.appendChild(el("p", "mng-empty", "나에게 할당된 작업이 있는 프로젝트가 없습니다."));
    renderDetail();
    renderBulkBar();
    return;
  }

  const toolbar = el("div", "mng-toolbar");
  toolbar.appendChild(el("span", "lbl", `프로젝트 ${current.targets.length}개`));
  const selectable = current.targets.filter((t) => isSelectable(t));
  if (selectable.length) {
    const allPicked = selectable.every(
      (t) => projectCheckState(t, draftFor(t).selectedItems) !== "off",
    );
    const link = el("button", "link", allPicked ? "선택 해제" : "전체 선택") as HTMLButtonElement;
    link.type = "button";
    link.onclick = () => {
      for (const t of selectable) {
        const d = draftFor(t);
        d.selectedItems = allPicked ? new Set<string>() : defaultSelectedItemIds(t);
        regenerateDraftContent(t, d);
      }
      renderAll();
    };
    toolbar.appendChild(link);
  }
  listEl.appendChild(toolbar);

  if (lastBulk) listEl.appendChild(bulkResultCard());
  // 첫 렌더에서는 고를 수 있는 첫 프로젝트를 펼쳐 둔다 — 빈 오른쪽 칸을 보여주고
  // "뭘 눌러야 하지"를 겪게 할 이유가 없다.
  if (openId === null || !current.targets.some((t) => t.project_id === openId)) {
    openId = (selectable[0] ?? current.targets[0]).project_id;
  }
  for (const t of current.targets) listEl.appendChild(projectRow(t));

  renderDetail();
  renderBulkBar();
}

function renderLoading() {
  listEl.innerHTML = "";
  detailEl.innerHTML = "";
  warnEl.hidden = true;
  bulkEl.hidden = true;
  listEl.appendChild(el("p", "mng-loading", "불러오는 중…"));
}

function renderError(err: unknown) {
  listEl.innerHTML = "";
  detailEl.innerHTML = "";
  bulkEl.hidden = true;
  listEl.appendChild(el("p", "mng-empty", "불러오지 못했어요: " + err));
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
      // 신규 제출 초안 전부를 새 옵션으로 다시 조립한다 — 열린 것만 갱신하면
      // 접힌 카드가 옛 옵션으로 만든 내용을 그대로 들고 일괄 제출에 실린다.
      if (current) {
        for (const t of current.targets) {
          const d = drafts.get(t.project_id);
          if (d) regenerateDraftContent(t, d);
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

refreshBtn.onclick = () => {
  // 손으로 새로고침하면 직전 제출 결과는 치운다 — 목록이 이미 최신 상태를
  // 반영하고 있어 결과 카드가 남아 있으면 지난 이야기가 위에 붙어 있게 된다.
  lastBulk = null;
  void refresh();
};

// 일괄 제출 진행 표시 — 건별로 서버가 보내주는 신호를 받아 카운터만 올린다.
listen<MngBulkResult>("mngdaily-bulk-progress", () => {
  if (!bulkRunning) return;
  bulkDone += 1;
  renderBulkBar();
}).catch((err) => console.error("bulk progress listener setup failed:", err));

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
