import { describe, it, expect } from "vitest";
import {
  priorityIcon, priorityColor, priorityLabel, stateIcon, stateColor, stateLabel,
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
  it("exposes the Plane priority color for every priority", () => {
    expect(priorityColor("urgent")).toBe("#D7443E");
    expect(priorityColor("high")).toBe("#DB7A2A");
    expect(priorityColor("medium")).toBe("#D9A916");
    expect(priorityColor("low")).toBe("#3D6FD9");
    expect(priorityColor("none")).toBe("#8C9199");
  });
  it("exposes the Plane state color for every group", () => {
    expect(stateColor("backlog")).toBe("#60646C");
    expect(stateColor("unstarted")).toBe("#60646C");
    expect(stateColor("started")).toBe("#F59E0B");
    expect(stateColor("completed")).toBe("#46A758");
    expect(stateColor("cancelled")).toBe("#9AA4BC");
  });
  it("backlog icon renders all 15 dashed segments (percentage=0)", () => {
    const matches = stateIcon("backlog").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(15);
  });
  it("unstarted icon renders zero dashed segments (solid ring)", () => {
    const matches = stateIcon("unstarted").match(/<g transform=/g) ?? [];
    expect(matches.length).toBe(0);
  });
  it("completed and cancelled icons render a single filled path", () => {
    expect(stateIcon("completed")).toContain("<path fill=");
    expect(stateIcon("cancelled")).toContain("<path fill=");
  });
});
