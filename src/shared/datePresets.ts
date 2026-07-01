export type DatePresetKey = "today" | "tomorrow" | "next_week";

export const DATE_PRESETS: { key: DatePresetKey; label: string }[] = [
  { key: "today", label: "오늘" },
  { key: "tomorrow", label: "내일" },
  { key: "next_week", label: "다음 주" },
];

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveDatePreset(key: DatePresetKey, now: Date = new Date()): string {
  const d = new Date(now);
  if (key === "tomorrow") d.setDate(d.getDate() + 1);
  if (key === "next_week") d.setDate(d.getDate() + 7);
  return toIsoDate(d);
}
