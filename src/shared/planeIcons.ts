export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export const PRIORITY_ORDER: Priority[] = ["none", "low", "medium", "high", "urgent"];
export const STATE_ORDER: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

export const CALENDAR_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

export const FLAG_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><path d="M5 21V4h13l-3 4 3 4H5"/></svg>`;

const PRIORITY_ICONS: Record<Priority, string> = {
  urgent: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="17" width="20" height="4" rx="1" fill="#ef4d56"/></svg>`,
  high: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#ef4d56"/><rect x="9" y="11" width="4" height="10" fill="#ef4d56"/><rect x="16" y="6" width="4" height="15" fill="#ef4d56"/></svg>`,
  medium: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#f5a623"/><rect x="9" y="11" width="4" height="10" fill="#f5a623"/><rect x="16" y="6" width="4" height="15" fill="#5c626d" opacity="0.4"/></svg>`,
  low: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2" y="16" width="4" height="5" fill="#8a909c"/><rect x="9" y="11" width="4" height="10" fill="#5c626d" opacity="0.4"/><rect x="16" y="6" width="4" height="15" fill="#5c626d" opacity="0.4"/></svg>`,
  none: `<svg width="13" height="13" viewBox="0 0 24 24"><rect x="4" y="16" width="3" height="4" rx="0.5" fill="#5c626d"/><rect x="10.5" y="12" width="3" height="8" rx="0.5" fill="#5c626d"/><rect x="17" y="8" width="3" height="12" rx="0.5" fill="#5c626d"/></svg>`,
};

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "우선순위 없음",
};

const STATE_ICONS: Record<StateGroup, string> = {
  backlog: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-dasharray="3 3"><circle cx="12" cy="12" r="9"/></svg>`,
  unstarted: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`,
  started: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="#f5a623" stroke="none"/></svg>`,
  completed: `<svg width="13" height="13" viewBox="0 0 24 24" fill="#2ecc71" stroke="#2ecc71"><circle cx="12" cy="12" r="9" fill="#2ecc71"/><path d="M8 12l3 3 5-6" stroke="#16181d" stroke-width="2" fill="none"/></svg>`,
  cancelled: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`,
};

const STATE_LABELS: Record<StateGroup, string> = {
  backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", cancelled: "Cancelled",
};

export function priorityIcon(p: Priority): string { return PRIORITY_ICONS[p]; }
export function priorityLabel(p: Priority): string { return PRIORITY_LABELS[p]; }
export function stateIcon(g: StateGroup): string { return STATE_ICONS[g]; }
export function stateLabel(g: StateGroup): string { return STATE_LABELS[g]; }
