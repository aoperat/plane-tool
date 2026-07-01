export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export const PRIORITY_ORDER: Priority[] = ["none", "low", "medium", "high", "urgent"];
export const STATE_ORDER: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

export const CALENDAR_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

export const FLAG_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2"><path d="M5 21V4h13l-3 4 3 4H5"/></svg>`;

export const DESCRIPTION_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="3" y1="18" x2="13" y2="18"/></svg>`;

// Priority icon shapes: lucide-static v1.22.0 (ISC license) — AlertCircle, SignalHigh,
// SignalMedium, SignalLow, Ban. https://lucide.dev — colors approximate Plane's
// packages/tailwind-config/variables.css --priority-* oklch tokens.
const PRIORITY_COLORS: Record<Priority, string> = {
  urgent: "#D7443E", high: "#DB7A2A", medium: "#D9A916", low: "#3D6FD9", none: "#8C9199",
};

const PRIORITY_PATHS: Record<Priority, string> = {
  urgent: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  high: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
  medium: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/>',
  low: '<path d="M2 20h.01"/><path d="M7 20v-4"/>',
  none: '<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>',
};

function buildPriorityIcon(p: Priority): string {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${PRIORITY_COLORS[p]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PRIORITY_PATHS[p]}</svg>`;
}

const PRIORITY_ICONS: Record<Priority, string> = {
  urgent: buildPriorityIcon("urgent"),
  high: buildPriorityIcon("high"),
  medium: buildPriorityIcon("medium"),
  low: buildPriorityIcon("low"),
  none: buildPriorityIcon("none"),
};

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "긴급", high: "높음", medium: "보통", low: "낮음", none: "우선순위 없음",
};

// State group icon shapes ported from Plane packages/propel/src/icons/state/{dashed-circle,
// progress-circle,backlog-group-icon,unstarted-group-icon,started-group-icon,
// completed-group-icon,cancelled-group-icon}.tsx
// Source: C:\WorkSpaces\plane\packages\propel\src\icons\state\
// SPDX-License-Identifier: AGPL-3.0-only (Copyright Plane Software, Inc. and contributors).
// Kept for personal, non-distributed use of plane-tool; revisit AGPL obligations if this
// app is ever shared or distributed. See docs/superpowers/specs/2026-07-01-sidebar-inline-edit-design.md#31.
const STATE_COLORS: Record<StateGroup, string> = {
  backlog: "#60646C", unstarted: "#60646C", started: "#F59E0B", completed: "#46A758", cancelled: "#9AA4BC",
};

const CENTER = 8;
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function dashedCircleSegments(color: string, percentage: number, totalSegments = 15): string {
  const angleIncrement = 360 / totalSegments;
  let segments = "";
  for (let i = 0; i < totalSegments; i++) {
    const angle = i * angleIncrement - 90;
    const segmentStartPercentage = (i / totalSegments) * 100;
    if (segmentStartPercentage >= percentage) {
      segments += `<g transform="translate(${CENTER} ${CENTER}) rotate(${angle})"><line x1="5.75" y1="0" x2="6.5" y2="0" stroke="${color}" stroke-width="1.21" stroke-linecap="round"/></g>`;
    }
  }
  return segments;
}

function progressCircle(color: string, strokeWidth: number, dashOffset: number): string {
  return `<circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${dashOffset}" stroke-linecap="round" transform="rotate(-90 ${CENTER} ${CENTER})"/>`;
}

const COMPLETED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.3587 6.18828C11.6007 5.85214 11.5244 5.38343 11.1882 5.14141C10.8521 4.89938 10.3834 4.97568 10.1414 5.31183L7.03706 9.62335L5.25956 7.97751C4.95563 7.69609 4.4811 7.71434 4.19968 8.01828C3.91826 8.32221 3.93651 8.79673 4.24045 9.07815L6.64045 11.3004C6.79816 11.4464 7.01095 11.5178 7.22481 11.4963C7.43868 11.4749 7.63307 11.3627 7.75865 11.1883L11.3587 6.18828Z"';

const CANCELLED_PATH =
  'fill-rule="evenodd" d="M8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15ZM11.1018 4.89826C11.3947 5.19115 11.3947 5.66603 11.1018 5.95892L9.06068 8.00002L11.1018 10.0411C11.3947 10.334 11.3947 10.8089 11.1018 11.1018C10.8089 11.3947 10.334 11.3947 10.0411 11.1018L8.00002 9.06068L5.95892 11.1018C5.66603 11.3947 5.19115 11.3947 4.89826 11.1018C4.60537 10.8089 4.60537 10.334 4.89826 10.0411L6.93936 8.00002L4.89826 5.95892C4.60537 5.66603 4.60537 5.19115 4.89826 4.89826C5.19115 4.60537 5.66603 4.60537 5.95892 4.89826L8.00002 6.93936L10.0411 4.89826C10.334 4.60537 10.8089 4.60537 11.1018 4.89826Z"';

function buildStateIcon(group: StateGroup): string {
  const color = STATE_COLORS[group];
  let inner: string;
  switch (group) {
    case "backlog":
      inner = dashedCircleSegments(color, 0);
      break;
    case "started":
      inner =
        dashedCircleSegments(color, 100) +
        `<circle cx="6" cy="6" r="3" stroke-width="1.5" stroke-linecap="round" fill="none" transform="rotate(-90 8 6)" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="0" stroke="${color}"/>` +
        progressCircle(color, 1.5, 0);
      break;
    case "completed":
      inner = `<path fill="${color}" ${COMPLETED_PATH}/>`;
      break;
    case "cancelled":
      inner = `<path fill="${color}" ${CANCELLED_PATH}/>`;
      break;
    case "unstarted":
    default:
      inner = dashedCircleSegments(color, 100) + progressCircle(color, 1.5, 0);
      break;
  }
  return `<svg width="13" height="13" viewBox="0 0 16 16">${inner}</svg>`;
}

const STATE_ICONS: Record<StateGroup, string> = {
  backlog: buildStateIcon("backlog"),
  unstarted: buildStateIcon("unstarted"),
  started: buildStateIcon("started"),
  completed: buildStateIcon("completed"),
  cancelled: buildStateIcon("cancelled"),
};

const STATE_LABELS: Record<StateGroup, string> = {
  backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", cancelled: "Cancelled",
};

export function priorityIcon(p: Priority): string { return PRIORITY_ICONS[p]; }
export function priorityColor(p: Priority): string { return PRIORITY_COLORS[p]; }
export function priorityLabel(p: Priority): string { return PRIORITY_LABELS[p]; }
export function stateIcon(g: StateGroup): string { return STATE_ICONS[g]; }
export function stateColor(g: StateGroup): string { return STATE_COLORS[g]; }
export function stateLabel(g: StateGroup): string { return STATE_LABELS[g]; }
