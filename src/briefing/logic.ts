import type { Briefing } from "../shared/types";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-07-03" -> "7월 3일 (금)". new Date(iso)의 UTC 해석을 피해 직접 분해한다. */
export function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return `${m}월 ${d}일 (${WEEKDAYS[day]})`;
}

/** 마감 칩 문구: 지남 "D+n", 오늘 "오늘", 미래 "M/D", 없음 "". */
export function dueLabel(target: string | null, today: string): string {
  if (!target) return "";
  if (target === today) return "오늘";
  if (target < today) {
    const days = Math.round((toUtc(today) - toUtc(target)) / 86400000);
    return `D+${days}`;
  }
  const [, m, d] = target.split("-").map(Number);
  return `${m}/${d}`;
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 클립보드 복사용 플레인 텍스트 (일일 스크럼 공유 형식). */
export function briefingToText(b: Briefing): string {
  const lines: string[] = [`[AI 브리핑] ${formatDateLabel(b.date)}`, b.summary, ""];
  if (b.plan.length > 0) {
    lines.push("오늘의 플랜");
    b.plan.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.item.name} (${e.item.project_identifier}) — ${e.reason}`);
    });
  }
  if (b.rest.length > 0) {
    lines.push("", "나머지 작업");
    for (const it of b.rest) {
      const due = dueLabel(it.target_date, b.date);
      lines.push(`- ${it.name} (${it.project_identifier})${due ? ` — ${due}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** 로컬 기준 오늘 (YYYY-MM-DD). */
export function localToday(): string {
  const n = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
