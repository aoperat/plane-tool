import { describe, it, expect } from "vitest";
import {
  priorityIcon, priorityLabel, stateIcon, stateLabel,
  PRIORITY_ORDER, STATE_ORDER, CALENDAR_ICON, FLAG_ICON,
} from "./planeIcons";

describe("planeIcons", () => {
  it("has 5 priority levels in none→urgent order", () => {
    expect(PRIORITY_ORDER).toEqual(["none", "low", "medium", "high", "urgent"]);
  });
  it("has 5 state groups in backlog→cancelled order", () => {
    expect(STATE_ORDER).toEqual(["backlog", "unstarted", "started", "completed", "cancelled"]);
  });
  it("returns an svg string for every priority", () => {
    for (const p of PRIORITY_ORDER) expect(priorityIcon(p)).toContain("<svg");
  });
  it("returns an svg string for every state group", () => {
    for (const g of STATE_ORDER) expect(stateIcon(g)).toContain("<svg");
  });
  it("labels none as '우선순위 없음'", () => {
    expect(priorityLabel("none")).toBe("우선순위 없음");
  });
  it("labels backlog as 'Backlog'", () => {
    expect(stateLabel("backlog")).toBe("Backlog");
  });
  it("exposes calendar and flag icon markup", () => {
    expect(CALENDAR_ICON).toContain("<svg");
    expect(FLAG_ICON).toContain("<svg");
  });
});
