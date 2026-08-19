import { describe, expect, it } from "vitest";
import {
  DEFAULT_MNG_CONTENT_OPTIONS,
  badgeFor,
  clusterByParent,
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
    parent: null,
    ...overrides,
  };
}

/** 하위 작업 — 부모는 `{ id, name, sequence_id }`만 온다(같은 프로젝트에서 찾은 것). */
function child(
  parent: { id: string; name: string; sequence_id: number },
  overrides: Partial<MngReportItem> = {},
): MngReportItem {
  return item({ parent, ...overrides });
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

/** Plane 웹 업무보고서(`report-text.ts`의 `clusterByParent`)와 같은 묶음 규칙이어야
 *  한다 — 사용자가 두 도구의 결과를 나란히 놓고 비교한다. */
describe("부모-자식 묶음", () => {
  const 취약점 = { id: "p-vuln", name: "홍익대 취약점 문서 확인 및 조치일정 담당자에게 메일 전달", sequence_id: 10 };

  it("사용자가 보고한 예시를 Plane과 같게 그린다", () => {
    const text = projectToText(
      "홍익대",
      "HIU",
      "",
      {
        // 부모는 진행 중 그룹에만 있다 — 완료·예정 그룹의 자식들은 캡션 줄로 묶인다.
        completed: [child(취약점, { id: "c1", name: "취약점 문서확인", sequence_id: 11 })],
        in_progress: [item({ id: 취약점.id, name: 취약점.name, sequence_id: 취약점.sequence_id })],
        upcoming: [
          child(취약점, { id: "u1", name: "담당자에게 메일 전달", sequence_id: 12 }),
          child(취약점, { id: "u2", name: "조치: 게시판 쿼리스트링으로 접근 가능한 문제 수정", sequence_id: 13 }),
          item({ id: "u3", name: "홍익대 게시판 모듈 생성 및 권한 기능 추가", sequence_id: 14 }),
        ],
      },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe(
      [
        "✅ 완료된 일",
        "  홍익대 취약점 문서 확인 및 조치일정 담당자에게 메일 전달",
        "    └ 취약점 문서확인",
        "",
        "🔄 진행 중인 일",
        "  • 홍익대 취약점 문서 확인 및 조치일정 담당자에게 메일 전달",
        "",
        "📌 진행 예정인 일",
        "  홍익대 취약점 문서 확인 및 조치일정 담당자에게 메일 전달",
        "    └ 담당자에게 메일 전달",
        "    └ 조치: 게시판 쿼리스트링으로 접근 가능한 문제 수정",
        "  • 홍익대 게시판 모듈 생성 및 권한 기능 추가",
      ].join("\n"),
    );
  });

  it("부모가 같은 그룹에 있으면 그 줄 아래로 자식을 넣는다", () => {
    const text = projectToText(
      "P",
      "PRJ",
      "",
      {
        completed: [],
        in_progress: [
          item({ id: 취약점.id, name: "부모작업", sequence_id: 10 }),
          child({ ...취약점, name: "부모작업" }, { id: "k1", name: "자식1", sequence_id: 11 }),
          child({ ...취약점, name: "부모작업" }, { id: "k2", name: "자식2", sequence_id: 12 }),
        ],
        upcoming: [],
      },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe("🔄 진행 중인 일\n  • 부모작업\n    └ 자식1\n    └ 자식2");
  });

  it("작업 번호를 켜면 캡션 줄에도 번호가 붙고, 불릿은 여전히 없다", () => {
    const text = projectToText(
      "P",
      "PRJ",
      "",
      {
        completed: [child(취약점, { id: "c1", name: "자식", sequence_id: 11, completed_at: "2026-08-12T09:00:00Z" })],
        in_progress: [],
        upcoming: [],
      },
      { ...ALL_ON, includeProjectName: false },
      TODAY,
    );
    expect(text).toBe(
      "✅ 완료된 일\n  PRJ-10 홍익대 취약점 문서 확인 및 조치일정 담당자에게 메일 전달\n    └ PRJ-11 자식 — 08-12 완료",
    );
  });

  it("부모를 못 찾은 자식은 독립 항목으로 그린다", () => {
    // 부모가 다른 프로젝트에 있거나 목록에 없으면 Rust가 parent를 null로
    // 내려준다 — 캡션 줄을 만들 이름이 없으니 평소처럼 한 줄로 그린다.
    const orphan = item({ id: "x", name: "고아 자식", sequence_id: 5, parent: null });
    expect(clusterByParent([orphan]).map((u) => u.type)).toEqual(["item"]);
    const text = projectToText(
      "P",
      "PRJ",
      "",
      { completed: [], in_progress: [orphan], upcoming: [] },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe("🔄 진행 중인 일\n  • 고아 자식");
  });

  it("자기 자신이 부모인 항목은 남의 아래로 들어가지 않는다", () => {
    // 조부모 - 부모 - 자식이 한 그룹에 다 있어도 중첩은 한 단계까지다.
    const units = clusterByParent([
      item({ id: "g", name: "조부모", sequence_id: 1 }),
      child({ id: "g", name: "조부모", sequence_id: 1 }, { id: "p", name: "부모", sequence_id: 2 }),
      child({ id: "p", name: "부모", sequence_id: 2 }, { id: "c", name: "자식", sequence_id: 3 }),
    ]);
    expect(units.map((u) => u.type)).toEqual(["item", "promoted"]);
    // "부모"는 자식을 거느리므로 조부모 아래로 접히지 않고 최상위에 남는다.
    expect(units[1]).toMatchObject({ type: "promoted", item: { id: "p" } });
  });

  it("묶음의 자리는 구성원 중 가장 앞선 것을 따른다", () => {
    // 자식이 목록 맨 앞이면 묶음 전체가 맨 앞으로 온다 — 서버가 정해 준 그룹 안
    // 정렬(완료는 최근순 등)을 깨지 않기 위해서다.
    const text = projectToText(
      "P",
      "PRJ",
      "",
      {
        completed: [],
        in_progress: [
          child(취약점, { id: "k1", name: "자식", sequence_id: 11 }),
          item({ id: "z", name: "다른 작업", sequence_id: 20 }),
          item({ id: 취약점.id, name: "부모작업", sequence_id: 10 }),
        ],
        upcoming: [],
      },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe("🔄 진행 중인 일\n  • 부모작업\n    └ 자식\n  • 다른 작업");
  });

  it("부모-자식이 없는 목록은 예전과 똑같이 나온다", () => {
    const flat = [
      item({ id: "a", name: "첫째", sequence_id: 1 }),
      item({ id: "b", name: "둘째", sequence_id: 2 }),
      item({ id: "c", name: "셋째", sequence_id: 3 }),
    ];
    const text = projectToText(
      "P",
      "PRJ",
      "",
      { completed: [], in_progress: flat, upcoming: [] },
      DEFAULT_MNG_CONTENT_OPTIONS,
      TODAY,
    );
    expect(text).toBe("🔄 진행 중인 일\n  • 첫째\n  • 둘째\n  • 셋째");
    expect(clusterByParent(flat).map((u) => u.type)).toEqual(["item", "item", "item"]);
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

  it("checks every submittable project, not just the ones with completed work", () => {
    expect(isSelectedByDefault(target({ completed: [item()] }))).toBe(true);
    expect(isSelectedByDefault(target({ in_progress: [item()] }))).toBe(true);
    expect(isSelectedByDefault(target({ upcoming: [item()] }))).toBe(true);
    // 담을 항목이 없거나 이미 제출된 프로젝트는 여전히 꺼진 채로 시작한다.
    expect(isSelectedByDefault(target({}))).toBe(false);
    expect(isSelectedByDefault(target({ status: "sent", completed: [item()] }))).toBe(false);
  });

  it("selects every reportable item, upcoming included", () => {
    const t = target({
      completed: [item({ id: "c1" })],
      in_progress: [item({ id: "p1" })],
      upcoming: [item({ id: "u1" })],
    });
    expect([...defaultSelectedItemIds(t)].sort()).toEqual(["c1", "p1", "u1"]);
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
    // 연동 실패는 "왜 안 되는지"가 사유마다 달라서, 하나로 뭉치면 사용자가
    // 다음에 뭘 해야 할지 알 수 없다.
    expect(mngErrorMessage({ error_code: "NOT_PROJECT_ADMIN", message: "" })).toContain("관리자");
    expect(mngErrorMessage({ error_code: "INVALID_MNG_LINK", message: "" })).toContain("연결 정보");
    expect(mngErrorMessage({ error_code: "MNG_LINK_REQUIRED", message: "" })).toContain("연결 정보");

    // 미연동은 이제 이 창에서 바로 연결할 수 있으므로, 다른 곳에서 하라고
    // 미루지 않는다.
    const notLinked = lockedReason(target({ mng_linked: false, status: "not_linked" }));
    expect(notLinked).toContain("연결돼 있지 않아");
    expect(notLinked).not.toContain("Plane 프로젝트 설정");
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
