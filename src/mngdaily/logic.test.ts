import { describe, expect, it } from "vitest";
import {
  DEFAULT_MNG_CONTENT_OPTIONS,
  badgeFor,
  defaultSelectedItemIds,
  isEmployeeNoMissing,
  isSelectable,
  isSelectedByDefault,
  itemLine,
  lockedReason,
  projectCheckState,
  projectToText,
  reportGroupFor,
  selectedGroups,
  withItemStateChanged,
  mngBadge,
  mngPriorityLabel,
  mngErrorMessage,
  mngWarningMessage,
  type MngTargetLike,
  textToHtml,
  htmlToText,
  toSpentNumber,
} from "./logic";
import type { MngReportItem } from "../shared/types";

/** 서식 규칙을 검증하는 테스트는 모든 항목을 켜 놓고 본다 — 기본값(전부 꺼짐)과
 *  무관하게 "켰을 때 이렇게 나온다"를 확인하는 것이 목적이다. */
const ALL_ON = {
  includeProjectName: true,
  includeCode: true,
  includePriority: true,
  includeDates: true,
};

function item(overrides: Partial<MngReportItem> = {}): MngReportItem {
  return {
    id: "i1",
    name: "작업",
    sequence_id: 1,
    priority: "none",
    state_group: "started",
    completed_at: null,
    target_date: null,
    start_date: null,
    ...overrides,
  };
}

const TODAY = "2026-08-12";

describe("projectToText", () => {
  // docs/mockups/mng-daily-quick-submit-mockup.html 3번 섹션과 정확히 일치해야
  // 한다 — src-tauri/src/mng_report.rs의 같은 이름 테스트와 짝을 이룬다.
  it("matches the mockup example with all options on", () => {
    const items = [
      item({ id: "i1", name: "사이드바 폭 조절 버그 수정", sequence_id: 142, priority: "medium", completed_at: "2026-08-12T09:00:00Z" }),
      item({ id: "i2", name: "전광판 색상 테마 통일", sequence_id: 139, priority: "high", completed_at: "2026-08-12T10:00:00Z" }),
    ];
    const text = projectToText(
      "Plane Quick Dock",
      "PQD",
      "",
      { completed: items, in_progress: [], upcoming: [] },
      ALL_ON,
      TODAY,
    );
    expect(text).toBe(
      "[Plane Quick Dock / PQD]\n\n✅ 완료된 일\n  • PQD-142 사이드바 폭 조절 버그 수정 (보통) — 08-12 완료\n  • PQD-139 전광판 색상 테마 통일 (높음) — 08-12 완료",
    );
  });

  // 3-1번 섹션: 우선순위·기한 토글을 끄면 그 두 필드만 빠져야 한다.
  it("matches the mockup example with priority and dates off", () => {
    const items = [
      item({ id: "i1", name: "사이드바 폭 조절 버그 수정", sequence_id: 142, priority: "medium", completed_at: "2026-08-12T09:00:00Z" }),
      item({ id: "i2", name: "전광판 색상 테마 통일", sequence_id: 139, priority: "high", completed_at: "2026-08-12T10:00:00Z" }),
    ];
    const text = projectToText(
      "Plane Quick Dock",
      "PQD",
      "",
      { completed: items, in_progress: [], upcoming: [] },
      { ...ALL_ON, includePriority: false, includeDates: false },
      TODAY,
    );
    expect(text).toBe(
      "[Plane Quick Dock / PQD]\n\n✅ 완료된 일\n  • PQD-142 사이드바 폭 조절 버그 수정\n  • PQD-139 전광판 색상 테마 통일",
    );
  });

  it("omits the header when project name is excluded", () => {
    const text = projectToText(
      "아무 프로젝트",
      "ANY",
      "",
      { completed: [item({ completed_at: "2026-08-12T09:00:00Z" })], in_progress: [], upcoming: [] },
      { ...ALL_ON, includeProjectName: false },
      TODAY,
    );
    expect(text.startsWith("[")).toBe(false);
    expect(text.startsWith("✅ 완료된 일")).toBe(true);
  });

  it("appends the client suffix when present", () => {
    const text = projectToText(
      "프로젝트",
      "PRJ",
      "고객사 A",
      { completed: [item({ completed_at: "2026-08-12T09:00:00Z" })], in_progress: [], upcoming: [] },
      ALL_ON,
      TODAY,
    );
    expect(text.startsWith("[프로젝트 / PRJ] (고객사 A)")).toBe(true);
  });

  it("skips empty groups and joins non-empty ones with a blank line", () => {
    const completed = [item({ id: "i1", name: "완료작업", sequence_id: 1, completed_at: "2026-08-12T09:00:00Z" })];
    const inProgress = [item({ id: "i2", name: "진행작업", sequence_id: 2, target_date: "2026-08-15" })];
    const text = projectToText(
      "P",
      "P",
      "",
      { completed, in_progress: inProgress, upcoming: [] },
      ALL_ON,
      TODAY,
    );
    expect(text).toBe(
      "[P / P]\n\n✅ 완료된 일\n  • P-1 완료작업 — 08-12 완료\n\n🔄 진행 중인 일\n  • P-2 진행작업 — D-3 · 08-15 마감",
    );
  });
});

describe("DEFAULT_MNG_CONTENT_OPTIONS", () => {
  it("starts with every extra turned off", () => {
    // Rust의 `MngContentOptions::default()`와 같은 값이어야 한다 — 어긋나면
    // 창을 열자마자 보이는 내용과 서버가 만든 default_content가 달라진다.
    expect(DEFAULT_MNG_CONTENT_OPTIONS).toEqual({
      includeProjectName: false,
      includeCode: false,
      includePriority: false,
      includeDates: false,
    });
  });

  it("renders bare task titles by default", () => {
    const text = projectToText(
      "프로젝트",
      "PRJ",
      "고객사",
      { completed: [item({ name: "화면 수정", sequence_id: 7, priority: "high", completed_at: "2026-08-12T09:00:00Z" })], in_progress: [], upcoming: [] },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe("✅ 완료된 일\n  • 화면 수정");
  });
});

describe("badgeFor", () => {
  it("marks overdue in_progress items", () => {
    const it_ = item({ target_date: "2026-08-10" });
    expect(badgeFor(it_, "in_progress", TODAY)).toBe("2일 지연 · 08-10 마감");
  });

  it("prefers a future start date over the target date for upcoming items", () => {
    const it_ = item({ start_date: "2026-08-20", target_date: "2026-08-25" });
    expect(badgeFor(it_, "upcoming", TODAY)).toBe("08-20 시작 예정");
  });

  it("falls back to the target date when the start date is not in the future", () => {
    const it_ = item({ start_date: "2026-08-01", target_date: "2026-08-25" });
    expect(badgeFor(it_, "upcoming", TODAY)).toBe("08-25 마감");
  });

  it("returns null when there is no relevant date", () => {
    expect(badgeFor(item(), "in_progress", TODAY)).toBeNull();
    expect(badgeFor(item(), "upcoming", TODAY)).toBeNull();
  });
});

describe("itemLine", () => {
  it("omits code/priority/badge when their options are off", () => {
    const it_ = item({ name: "이름", sequence_id: 7, priority: "urgent", completed_at: "2026-08-12T09:00:00Z" });
    const line = itemLine(it_, "PRJ", "completed", {
      includeProjectName: true,
      includeCode: false,
      includePriority: false,
      includeDates: false,
    }, TODAY);
    expect(line).toBe("  • 이름");
  });
});

describe("mngPriorityLabel", () => {
  it("returns an empty string for none/unrecognized priorities", () => {
    expect(mngPriorityLabel("none")).toBe("");
    expect(mngPriorityLabel("bogus")).toBe("");
  });
  it("labels the four real priorities", () => {
    expect(mngPriorityLabel("urgent")).toBe("긴급");
    expect(mngPriorityLabel("high")).toBe("높음");
    expect(mngPriorityLabel("medium")).toBe("보통");
    expect(mngPriorityLabel("low")).toBe("낮음");
  });
});

describe("mngErrorMessage", () => {
  it("maps known error codes to Korean guidance", () => {
    expect(mngErrorMessage({ error_code: "EMPLOYEE_NO_MISSING", message: "" })).toContain("사번");
    expect(mngErrorMessage({ error_code: "MNG_TIMEOUT", message: "" })).toContain("중복 등록");
  });
  it("falls back to the raw message for unknown codes", () => {
    expect(mngErrorMessage({ error_code: "SOMETHING_NEW", message: "raw detail" })).toBe("raw detail");
  });
});

describe("textToHtml / htmlToText", () => {
  it("round-trips plain multi-line text", () => {
    const text = "첫 줄\n둘째 줄";
    expect(htmlToText(textToHtml(text))).toBe(text);
  });
  it("escapes special characters", () => {
    expect(textToHtml("<b>&\"'</b>")).toBe("<p>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</p>");
  });
});

function target(overrides: Partial<MngTargetLike> = {}): MngTargetLike {
  return {
    mng_linked: true,
    status: "pending",
    completed: [],
    in_progress: [],
    upcoming: [],
    ...overrides,
  };
}

describe("제출 대상 선택 규칙", () => {
  it("only treats a project with reportable items as selectable", () => {
    expect(isSelectable(target({ completed: [item({ id: "a" })] }))).toBe(true);
    expect(isSelectable(target({ in_progress: [item({ id: "b" })] }))).toBe(true);
    // 백로그만 있는 프로젝트 — 서버가 세 그룹을 모두 비워 보낸다.
    expect(isSelectable(target())).toBe(false);
  });

  it("locks projects that cannot be submitted", () => {
    expect(isSelectable(target({ mng_linked: false, status: "not_linked", completed: [item()] }))).toBe(false);
    expect(isSelectable(target({ status: "sent", completed: [item()] }))).toBe(false);
  });

  it("keeps an unreachable-mng project selectable", () => {
    // 등록 여부를 모를 뿐이라 "그래도 제출"을 허용한다.
    expect(isSelectable(target({ status: "unknown", completed: [item()] }))).toBe(true);
  });

  it("checks only projects that completed something today", () => {
    expect(isSelectedByDefault(target({ completed: [item()] }))).toBe(true);
    expect(isSelectedByDefault(target({ in_progress: [item()] }))).toBe(false);
  });

  it("selects completed and in-progress items but not upcoming ones", () => {
    const t = target({
      completed: [item({ id: "c1" })],
      in_progress: [item({ id: "p1" })],
      upcoming: [item({ id: "u1" })],
    });
    expect([...defaultSelectedItemIds(t)].sort()).toEqual(["c1", "p1"]);
  });

  it("narrows the groups handed to projectToText to the checked items", () => {
    const t = target({
      completed: [item({ id: "c1" }), item({ id: "c2" })],
      in_progress: [item({ id: "p1" })],
      upcoming: [item({ id: "u1" })],
    });
    const groups = selectedGroups(t, new Set(["c2", "u1"]));
    expect(groups.completed.map((i) => i.id)).toEqual(["c2"]);
    expect(groups.in_progress).toEqual([]);
    expect(groups.upcoming.map((i) => i.id)).toEqual(["u1"]);
  });

  it("reports a partial project checkbox when some items are off", () => {
    const t = target({ completed: [item({ id: "a" })], in_progress: [item({ id: "b" })] });
    expect(projectCheckState(t, new Set(["a", "b"]))).toBe("on");
    expect(projectCheckState(t, new Set(["a"]))).toBe("partial");
    expect(projectCheckState(t, new Set())).toBe("off");
  });

  it("explains why a card is locked, and stays silent for submitted ones", () => {
    expect(lockedReason(target({ mng_linked: false, status: "not_linked" }))).toContain("연결돼 있지 않아");
    expect(lockedReason(target())).toContain("담을 작업이 없습니다");
    // 등록 완료는 잠기지만 수정·삭제가 가능해 별도 안내를 쓴다.
    expect(lockedReason(target({ status: "sent", completed: [item()] }))).toBeNull();
    expect(lockedReason(target({ completed: [item()] }))).toBeNull();
  });

  it("labels an empty linked project without inventing a new status", () => {
    expect(mngBadge(target())).toEqual({ label: "담을 작업 없음", kind: "not_linked" });
    expect(mngBadge(target({ completed: [item()] }))).toEqual({ label: "제출 대기", kind: "pending" });
    expect(mngBadge(target({ mng_linked: false, status: "not_linked" })).label).toBe("mng 미연동");
  });
});

describe("withItemStateChanged", () => {
  const t = () =>
    target({
      completed: [item({ id: "c1", state_group: "completed", completed_at: "2026-08-13T00:00:00Z" })],
      in_progress: [item({ id: "p1", state_group: "started" })],
      upcoming: [item({ id: "u1", state_group: "unstarted" })],
    });
  const NOW = "2026-08-13T09:30:00Z";

  it("moves a started item into the completed group and stamps the time", () => {
    const r = withItemStateChanged(t(), "p1", "completed", NOW);
    expect(r.in_progress).toEqual([]);
    expect(r.completed.map((i) => i.id)).toEqual(["c1", "p1"]);
    expect(r.completed.find((i) => i.id === "p1")?.completed_at).toBe(NOW);
  });

  it("clears the completion time when a completed item goes back to started", () => {
    const r = withItemStateChanged(t(), "c1", "started", NOW);
    expect(r.completed).toEqual([]);
    const moved = r.in_progress.find((i) => i.id === "c1");
    expect(moved?.completed_at).toBeNull();
    expect(moved?.state_group).toBe("started");
  });

  it("drops the item entirely for backlog and cancelled", () => {
    for (const g of ["backlog", "cancelled"]) {
      const r = withItemStateChanged(t(), "p1", g, NOW);
      expect([...r.completed, ...r.in_progress, ...r.upcoming].map((i) => i.id)).toEqual(["c1", "u1"]);
    }
  });

  it("keeps an existing completion time instead of overwriting it", () => {
    const r = withItemStateChanged(t(), "c1", "completed", NOW);
    expect(r.completed.find((i) => i.id === "c1")?.completed_at).toBe("2026-08-13T00:00:00Z");
  });

  it("leaves the groups untouched for an unknown item", () => {
    const before = t();
    const r = withItemStateChanged(before, "nope", "completed", NOW);
    expect(r.completed).toBe(before.completed);
    expect(r.in_progress).toBe(before.in_progress);
  });
});

describe("reportGroupFor", () => {
  it("maps only the three reportable state groups", () => {
    expect(reportGroupFor("completed")).toBe("completed");
    expect(reportGroupFor("started")).toBe("in_progress");
    expect(reportGroupFor("unstarted")).toBe("upcoming");
    expect(reportGroupFor("backlog")).toBeNull();
    expect(reportGroupFor("cancelled")).toBeNull();
  });
});

describe("isEmployeeNoMissing / mngWarningMessage", () => {
  it("reports a missing employee number only when mng answered", () => {
    expect(isEmployeeNoMissing({ mng_available: true, employee_no: "" })).toBe(true);
    expect(mngWarningMessage({ mng_available: true, employee_no: "" })).toContain("사번이 등록돼");
  });

  it("treats an empty employee number as unknown when mng is unreachable", () => {
    // 연결 실패 시 서버 응답이 없어 employee_no가 빈 문자열로 온다. 이걸
    // 미등록으로 오인해 "사번을 등록하세요"라고 안내하면 안 된다.
    const unreachable = { mng_available: false, employee_no: "" };
    expect(isEmployeeNoMissing(unreachable)).toBe(false);
    expect(mngWarningMessage(unreachable)).toContain("연결하지 못해");
  });

  it("stays silent when the employee number is known", () => {
    expect(isEmployeeNoMissing({ mng_available: true, employee_no: "12345" })).toBe(false);
    expect(mngWarningMessage({ mng_available: true, employee_no: "12345" })).toBeNull();
  });
});

describe("toSpentNumber", () => {
  it("parses mng's decimal-string spent time and floors it", () => {
    expect(toSpentNumber("1.0")).toBe(1);
    expect(toSpentNumber("2.9")).toBe(2);
  });
  it("returns 0 for empty, zero, or unparseable values", () => {
    expect(toSpentNumber("")).toBe(0);
    expect(toSpentNumber("0")).toBe(0);
    expect(toSpentNumber("abc")).toBe(0);
  });
});
