import { describe, expect, it } from "vitest";
import {
  DEFAULT_MNG_CONTENT_OPTIONS,
  badgeFor,
  itemLine,
  projectToText,
  mngPriorityLabel,
  mngErrorMessage,
  textToHtml,
  htmlToText,
  toSpentNumber,
} from "./logic";
import type { MngReportItem } from "../shared/types";

function item(overrides: Partial<MngReportItem> = {}): MngReportItem {
  return {
    id: "i1",
    name: "작업",
    sequence_id: 1,
    priority: "none",
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
      DEFAULT_MNG_CONTENT_OPTIONS,
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
      { ...DEFAULT_MNG_CONTENT_OPTIONS, includePriority: false, includeDates: false },
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
      { ...DEFAULT_MNG_CONTENT_OPTIONS, includeProjectName: false },
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
      DEFAULT_MNG_CONTENT_OPTIONS,
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
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe(
      "[P / P]\n\n✅ 완료된 일\n  • P-1 완료작업 — 08-12 완료\n\n🔄 진행 중인 일\n  • P-2 진행작업 — D-3 · 08-15 마감",
    );
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
