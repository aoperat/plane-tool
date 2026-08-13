import type { MngReportItem, MngTargetStatus, MngApiError } from "../shared/types";

/** Plane 웹의 실제 업무보고서 텍스트 포맷(`apps/web/.../work-report/report-text.ts`의
 *  `projectToText`, `report-body.tsx`의 `badgeFor`/`priorityLabel`)을 그대로 이식한다 —
 *  `src-tauri/src/mng_report.rs`와 정확히 같은 규칙이어야 한다("포함 항목" 토글을 바꿀
 *  때 여기서 즉시 재조립하고, 실제 제출 시점의 원문은 Rust가 만든 `default_content`를
 *  기준으로 시작하므로 두 구현이 어긋나면 화면과 실제 전송 내용이 달라진다).
 *  부모-자식 클러스터링(`└` 들여쓰기)은 Rust 쪽과 마찬가지로 이번 범위에서 제외했다. */

export type MngReportGroup = "completed" | "in_progress" | "upcoming";

export interface MngContentOptions {
  includeProjectName: boolean;
  includeCode: boolean;
  includePriority: boolean;
  includeDates: boolean;
}

/** 기본은 전부 끔 — 일지 본문은 작업 제목만 나열하는 게 읽기 좋고, 프로젝트명·
 *  작업 번호·우선순위·기한은 필요한 사람만 켜서 쓴다. mng에 올라간 글을 나중에
 *  읽는 사람에게는 대부분 군더더기다. Plane 웹의 업무보고서 복사 설정
 *  (`work-report/settings.ts`)도 같은 기본값을 쓴다. */
export const DEFAULT_MNG_CONTENT_OPTIONS: MngContentOptions = {
  includeProjectName: false,
  includeCode: false,
  includePriority: false,
  includeDates: false,
};

const FORMAT_STORAGE_KEY = "plane-quick-dock-mngdaily-format";

/** 저장된 값이 없거나 손상됐으면 기본값(전부 꺼짐) — Plane 웹 업무보고서 설정의
 *  기본값과 동일하다. */
export function loadMngContentOptions(): MngContentOptions {
  if (typeof window === "undefined") return DEFAULT_MNG_CONTENT_OPTIONS;
  try {
    const raw = window.localStorage.getItem(FORMAT_STORAGE_KEY);
    if (!raw) return DEFAULT_MNG_CONTENT_OPTIONS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_MNG_CONTENT_OPTIONS, ...parsed };
  } catch {
    return DEFAULT_MNG_CONTENT_OPTIONS;
  }
}

export function saveMngContentOptions(opts: MngContentOptions): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORMAT_STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // storage unavailable — no-op
  }
}

export function groupLabel(group: MngReportGroup): string {
  switch (group) {
    case "completed":
      return "✅ 완료된 일";
    case "in_progress":
      return "🔄 진행 중인 일";
    case "upcoming":
      return "📌 진행 예정인 일";
  }
}

/** `report-body.tsx`의 `priorityLabel` — "none"/미인식 값은 빈 문자열(표시 생략).
 *  `shared/planeIcons.ts`의 `priorityLabel`(항상 라벨을 주는, "우선순위 없음" 포함)과는
 *  용도가 달라 일부러 재사용하지 않는다. */
export function mngPriorityLabel(priority: string): string {
  switch (priority) {
    case "urgent":
      return "긴급";
    case "high":
      return "높음";
    case "medium":
      return "보통";
    case "low":
      return "낮음";
    default:
      return "";
  }
}

/** "YYYY-MM-DD" 또는 그 앞부분을 담은 UTC 타임스탬프에서 "MM-DD"만 뽑는다.
 *  `deadline_watch.rs`의 `md()`("M/D", 패딩 없음)와는 다른 포맷 — 업무보고서는
 *  2자리 고정이다. */
function monthDay(dateStr: string): string {
  const d = dateStr.slice(0, 10);
  const [, m, day] = d.split("-");
  return `${m}-${day}`;
}

function toUtcDays(dateStr: string): number {
  const d = dateStr.slice(0, 10);
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day) / 86400000;
}

/** `report-body.tsx:237-279`의 `badgeFor` 이식. */
export function badgeFor(item: MngReportItem, group: MngReportGroup, today: string): string | null {
  if (group === "completed") {
    if (!item.completed_at) return null;
    return `${monthDay(item.completed_at)} 완료`;
  }
  if (group === "in_progress") {
    if (!item.target_date) return null;
    const diff = toUtcDays(item.target_date) - toUtcDays(today);
    if (diff < 0) return `${-diff}일 지연 · ${monthDay(item.target_date)} 마감`;
    return `D-${diff} · ${monthDay(item.target_date)} 마감`;
  }
  // upcoming
  if (item.start_date && toUtcDays(item.start_date) - toUtcDays(today) > 0) {
    return `${monthDay(item.start_date)} 시작 예정`;
  }
  if (item.target_date) return `${monthDay(item.target_date)} 마감`;
  return null;
}

/** `report-text.ts:85-93`의 `itemToLine` 이식(깊이 0 고정 — 클러스터링 없음). */
export function itemLine(
  item: MngReportItem,
  identifier: string,
  group: MngReportGroup,
  opts: MngContentOptions,
  today: string,
): string {
  const code = opts.includeCode ? `${identifier}-${item.sequence_id} ` : "";
  const label = opts.includePriority ? mngPriorityLabel(item.priority) : "";
  const prio = label ? ` (${label})` : "";
  const badge = opts.includeDates ? badgeFor(item, group, today) : null;
  const suffix = badge ? ` — ${badge}` : "";
  return `  • ${code}${item.name}${prio}${suffix}`;
}

/** `report-text.ts:68-123`의 `projectToText` 이식. */
export function projectToText(
  projectName: string,
  identifier: string,
  client: string,
  groups: { completed: MngReportItem[]; in_progress: MngReportItem[]; upcoming: MngReportItem[] },
  opts: MngContentOptions,
  today: string,
): string {
  const lines: string[] = [];
  if (opts.includeProjectName) {
    const suffix = client ? ` (${client})` : "";
    lines.push(`[${projectName} / ${identifier}]${suffix}`);
  }
  (["completed", "in_progress", "upcoming"] as MngReportGroup[]).forEach((group) => {
    const items = groups[group];
    if (!items.length) return;
    if (lines.length) lines.push("");
    lines.push(groupLabel(group));
    items.forEach((item) => lines.push(itemLine(item, identifier, group, opts, today)));
  });
  return lines.join("\n");
}

/** mng 진행상태 코드(01~04) — `apps/web/.../project/mng/constants.ts`의
 *  `MNG_DAILY_STATES`와 동일. 완료 항목을 다루므로 기본값은 "완료"(02)로 둔다
 *  (Plane 웹은 항상 첫 번째 값 "01 진행중"을 기본값으로 쓰지만, 이 창은 "오늘 완료한
 *  일"만 다루는 좁은 화면이라 실제로 고를 값에 더 가까운 쪽을 기본으로 둔다). */
export const MNG_DAILY_STATES: { value: string; label: string }[] = [
  { value: "01", label: "진행중" },
  { value: "02", label: "완료" },
  { value: "03", label: "지연" },
  { value: "04", label: "대기" },
];

export function mngStatusLabel(status: MngTargetStatus): string {
  switch (status) {
    case "pending":
      return "제출 대기";
    case "sent":
      return "제출됨";
    case "unknown":
      return "확인 불가";
    case "not_linked":
      return "mng 미연동";
  }
}

/** 카드 헤더 배지의 문구와 색 계열. "담을 작업 없음"은 서버 status가 아니라
 *  세 그룹이 모두 비었다는 사실에서 나온다 — 그 하나를 위해 새 status 값을
 *  만들지 않는다. */
export function mngBadge(t: MngTargetLike): { label: string; kind: MngTargetStatus } {
  if (t.mng_linked && t.status !== "sent" && !hasReportableItems(t)) {
    return { label: "담을 작업 없음", kind: "not_linked" };
  }
  return { label: mngStatusLabel(t.status), kind: t.status };
}

/** Plane 서버가 돌려주는 `error_code`를 사용자 문구로. 서버 쪽
 *  `ko/translations.ts`의 `work_report.mng_daily.errors.*`와 같은 문구를 쓴다 —
 *  plane-tool에 별도 i18n 프레임워크가 없어 여기 그대로 하드코딩한다. */
export function mngErrorMessage(err: MngApiError): string {
  switch (err.error_code) {
    case "EMPLOYEE_NO_MISSING":
      return "계정 설정에서 사번을 먼저 등록하세요.";
    case "PROJECT_NOT_LINKED":
      return "이 프로젝트는 mng와 연결되어 있지 않습니다.";
    case "INVALID_STATE":
      return "진행상태 값이 올바르지 않습니다.";
    case "INVALID_DATE":
    case "FUTURE_REPORT_DATE":
      return "날짜가 올바르지 않습니다.";
    case "INVALID_SPENT_TIME":
      return "소요시간(시/분)은 숫자여야 합니다.";
    case "PROJECT_NOT_FOUND":
      return "이 워크스페이스에서 프로젝트를 찾을 수 없습니다.";
    case "SEQ_REQUIRED":
      return "대상 업무일지를 찾을 수 없습니다. 새로고침한 뒤 다시 시도하세요.";
    case "ROW_NOT_FOUND":
      return "mng에 해당 업무일지가 없습니다. 이미 삭제되었을 수 있습니다 — 새로고침해 확인하세요.";
    case "ROW_NOT_EDITABLE":
      return "mng 화면에서 사이트를 선택해 등록한 항목이라 여기서는 수정할 수 없습니다. mng에서 직접 수정하세요.";
    case "MNG_REJECTED":
      return "mng가 이 업무일지를 거부했습니다. 재시도해도 소용없습니다 — 내용을 확인한 뒤 다시 시도하세요.";
    case "MNG_UNAVAILABLE":
      return "mng에 연결할 수 없습니다. 다시 시도해 볼 수 있습니다.";
    case "MNG_TIMEOUT":
      return "mng가 시간 내에 응답하지 않아 처리 여부를 알 수 없습니다. 재시도하기 전에 mng에서 직접 확인하세요 — 그냥 다시 보내면 중복 등록될 수 있습니다.";
    case "NETWORK":
      return "네트워크 연결을 확인하세요.";
    default:
      return err.message || "mng 전송 중 문제가 발생했습니다.";
  }
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Plain text -> mng의 `내용_HTML` 필드용 최소 HTML. Plane 웹
 *  (`profile/work-report/mng-daily-modal.tsx`의 `textToHtml`)과 동일하게
 *  일부러 단순하다 — 이스케이프 후 줄마다 `<p>`로만 감싼다. */
export function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
}

/** `textToHtml`의 역방향(같은 파일의 `htmlToText`와 동일). mng 화면에서 직접
 *  작성된 행은 임의의 HTML일 수 있어 완전한 역변환은 아니다 — 태그를 지우고
 *  줄바꿈만 살린다. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // &amp;는 반드시 마지막에 — 먼저 풀면 &amp;lt;가 <로 잘못 복원된다.
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => (line.trim() ? line : ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** mng가 소요시간을 "1.0" 같은 실수 문자열로 준다. */
export function toSpentNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** 일지에 담을 수 있는 세 그룹. 백로그·취소는 서버가 애초에 담지 않는다
 *  (`classify_groups`가 버린다) — "오늘 한 일"과 무관하기 때문이다. */
export const MNG_GROUPS = ["completed", "in_progress", "upcoming"] as const;

/** 선택·잠금 규칙이 실제로 보는 필드만 추린 형태. `MngTarget` 전체를 요구하지
 *  않아 테스트에서 최소한의 객체로 검증할 수 있다. */
export interface MngTargetLike {
  mng_linked: boolean;
  status: MngTargetStatus;
  completed: MngReportItem[];
  in_progress: MngReportItem[];
  upcoming: MngReportItem[];
}

/** 세 그룹을 통틀어 일지에 담을 수 있는 항목이 하나라도 있는지. 전부 비었으면
 *  백로그만 있는 프로젝트라 제출할 게 없다 — 카드는 남기되 잠근다. */
export function hasReportableItems(t: MngTargetLike): boolean {
  return MNG_GROUPS.some((g) => t[g].length > 0);
}

/** 지금 이 프로젝트를 제출 대상으로 고를 수 있는지. mng와 연동돼 있고, 오늘
 *  자로 이미 등록된 게 없고, 담을 항목이 있어야 한다. mng 연결 실패("unknown")는
 *  막지 않는다 — 등록 여부를 모를 뿐이라 "그래도 제출"을 허용한다. */
export function isSelectable(t: MngTargetLike): boolean {
  return t.mng_linked && t.status !== "sent" && hasReportableItems(t);
}

/** 창을 열었을 때 이 프로젝트가 체크돼 있어야 하는지. 오늘 완료한 항목이 있는
 *  프로젝트만 켠다 — 지금까지의 동작(완료가 있는 것만 목록에 올림)을 그대로
 *  기본값으로 보존해서, 늘 하던 사람은 열고 바로 제출하면 되게 한다. */
export function isSelectedByDefault(t: MngTargetLike): boolean {
  return isSelectable(t) && t.completed.length > 0;
}

/** 창을 열었을 때 켜져 있어야 할 항목 id 집합. 완료·진행중은 켜고 예정은 끈다 —
 *  예정은 "오늘 한 일"이 아니라서 일지에 늘 들어갈 성격이 아니다. */
export function defaultSelectedItemIds(t: MngTargetLike): Set<string> {
  return new Set([...t.completed, ...t.in_progress].map((i) => i.id));
}

/** 선택된 항목만 남긴 그룹. `projectToText`에 그대로 넘겨 내용을 재조립한다. */
export function selectedGroups(
  t: MngTargetLike,
  selected: ReadonlySet<string>,
): { completed: MngReportItem[]; in_progress: MngReportItem[]; upcoming: MngReportItem[] } {
  return {
    completed: t.completed.filter((i) => selected.has(i.id)),
    in_progress: t.in_progress.filter((i) => selected.has(i.id)),
    upcoming: t.upcoming.filter((i) => selected.has(i.id)),
  };
}

/** 프로젝트 체크박스의 3상태. 항목이 일부만 켜져 있으면 "partial"이다. */
export function projectCheckState(
  t: MngTargetLike,
  selected: ReadonlySet<string>,
): "on" | "partial" | "off" {
  const all = MNG_GROUPS.flatMap((g) => t[g]);
  if (!all.length) return "off";
  const on = all.filter((i) => selected.has(i.id)).length;
  if (on === 0) return "off";
  return on === all.length ? "on" : "partial";
}

/** 카드가 왜 잠겼는지. 잠기지 않았으면 null. */
export function lockedReason(t: MngTargetLike): string | null {
  if (!t.mng_linked) {
    return "이 프로젝트는 mng와 연결돼 있지 않아 업무일지를 제출할 수 없습니다. Plane 프로젝트 설정에서 mng 프로젝트를 연결하면 다음 새로고침부터 제출할 수 있습니다.";
  }
  if (t.status === "sent") return null; // 잠기지만 수정·삭제가 가능해 별도 안내를 쓴다.
  if (!hasReportableItems(t)) {
    return "오늘 일지에 담을 작업이 없습니다. 작업을 시작(진행중)하거나 완료하면 다음 새로고침부터 나타납니다.";
  }
  return null;
}

/** Plane 상태 그룹 -> 일지 그룹. 백로그·취소는 일지에 담을 대상이 아니라
 *  어느 그룹에도 들어가지 않는다(`classify_groups`의 규칙과 같다). */
export function reportGroupFor(stateGroup: string): MngReportGroup | null {
  switch (stateGroup) {
    case "completed":
      return "completed";
    case "started":
      return "in_progress";
    case "unstarted":
      return "upcoming";
    default:
      return null;
  }
}

/** 창에서 작업 상태를 바꿨을 때의 새 그룹 구성.
 *
 *  서버를 다시 부르지 않고 화면에서 바로 옮긴다 — 새로고침하면 작성 중이던
 *  내용이 날아가기 때문이다. 완료로 바꾸면 완료 시각이 없으므로 `now`를 넣어
 *  준다(다음 새로고침 때 서버 값으로 덮인다). 백로그·취소로 바꾸면 세 그룹
 *  어디에도 남지 않아 목록에서 사라진다. */
export function withItemStateChanged(
  t: MngTargetLike,
  itemId: string,
  toStateGroup: string,
  now: string,
): Pick<MngTargetLike, "completed" | "in_progress" | "upcoming"> {
  let moved: MngReportItem | null = null;
  const rest: Record<MngReportGroup, MngReportItem[]> = {
    completed: [],
    in_progress: [],
    upcoming: [],
  };
  for (const g of MNG_GROUPS) {
    for (const item of t[g]) {
      if (item.id === itemId) moved = item;
      else rest[g].push(item);
    }
  }
  if (!moved) return { completed: t.completed, in_progress: t.in_progress, upcoming: t.upcoming };

  const to = reportGroupFor(toStateGroup);
  if (to !== null) {
    rest[to].push({
      ...moved,
      state_group: toStateGroup,
      completed_at: toStateGroup === "completed" ? (moved.completed_at ?? now) : null,
    });
  }
  return rest;
}

/** 사번을 확실히 모른다고 단정할 수 있는지. `mng_available`가 false면 mng에
 *  연결하지 못해 `employee_no`가 빈 문자열로 오는 것뿐이라 "미등록"이 아니다 —
 *  이걸 구분하지 않으면 서버 장애나 엔드포인트 부재를 사용자에게 "사번을
 *  등록하세요"라고 잘못 안내하게 된다. */
export function isEmployeeNoMissing(t: {
  mng_available: boolean;
  employee_no: string;
}): boolean {
  return t.mng_available && !t.employee_no;
}

/** 상단 배너 문구. 보여줄 게 없으면 null.
 *
 *  - 사번 미등록(연결 성공 + 사번 없음): 제출 자체가 불가능하니 등록을 안내한다.
 *  - 연결 실패: 사번도 등록 내역도 확인할 수 없다는 사실만 알린다. 제출은
 *    막지 않는다 — 사번이 없으면 서버가 POST 시점에 `EMPLOYEE_NO_MISSING`으로
 *    다시 막는다. */
export function mngWarningMessage(t: {
  mng_available: boolean;
  employee_no: string;
}): string | null {
  if (isEmployeeNoMissing(t)) {
    return "사번이 등록돼 있지 않아 mng에 제출할 수 없습니다. Plane 프로필 설정에서 등록해주세요.";
  }
  if (!t.mng_available) {
    return "mng 서버에 연결하지 못해 사번 등록 여부와 오늘 등록 내역을 확인할 수 없습니다.";
  }
  return null;
}

/** 로컬 기준 오늘 (YYYY-MM-DD). `briefing/logic.ts`의 `localToday`와 동일. */
export function localToday(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
