import { describe, expect, it } from "vitest";
import { briefingToText, dueLabel, formatDateLabel } from "./logic";
import type { Briefing, BriefingItem } from "../shared/types";

const item = (id: string, name: string, target: string | null): BriefingItem => ({
  id, name, project_id: "p1", project_identifier: "WEB",
  priority: "none", start_date: null, target_date: target, state_group: "unstarted",
});

describe("formatDateLabel", () => {
  it("formats an ISO date as Korean month/day with weekday", () => {
    expect(formatDateLabel("2026-07-03")).toBe("7월 3일 (금)");
  });
});

describe("dueLabel", () => {
  it("labels overdue, today, and future dates", () => {
    expect(dueLabel("2026-07-01", "2026-07-03")).toBe("D+2");
    expect(dueLabel("2026-07-03", "2026-07-03")).toBe("오늘");
    expect(dueLabel("2026-07-05", "2026-07-03")).toBe("7/5");
    expect(dueLabel(null, "2026-07-03")).toBe("");
  });
});

describe("briefingToText", () => {
  it("renders summary, numbered plan, and rest as plain text", () => {
    const b: Briefing = {
      date: "2026-07-03", generated_at: "09:00", model: "gpt-4o-mini",
      source: "openai", error: null, summary: "요약입니다.",
      plan: [{ item: item("a", "인증서 갱신", "2026-07-01"), reason: "마감 2일 초과" }],
      rest: [item("b", "보고서 초안", "2026-07-08")],
    };
    const text = briefingToText(b);
    expect(text).toContain("[AI 브리핑] 7월 3일 (금)");
    expect(text).toContain("요약입니다.");
    expect(text).toContain("1. 인증서 갱신 (WEB) — 마감 2일 초과");
    expect(text).toContain("- 보고서 초안 (WEB) — 7/8");
  });
});
