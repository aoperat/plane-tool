import { describe, it, expect } from "vitest";
import { resolveDatePreset, shiftIsoDate } from "./datePresets";

describe("resolveDatePreset", () => {
  it("returns the same date for today", () => {
    expect(resolveDatePreset("today", new Date(2026, 0, 15))).toBe("2026-01-15");
  });
  it("adds one day for tomorrow", () => {
    expect(resolveDatePreset("tomorrow", new Date(2026, 0, 15))).toBe("2026-01-16");
  });
  it("adds seven days for next_week", () => {
    expect(resolveDatePreset("next_week", new Date(2026, 0, 15))).toBe("2026-01-22");
  });
  it("rolls over month boundaries", () => {
    expect(resolveDatePreset("next_week", new Date(2026, 0, 28))).toBe("2026-02-04");
  });
});

describe("shiftIsoDate", () => {
  it("adds a day", () => {
    expect(shiftIsoDate("2026-01-15", 1)).toBe("2026-01-16");
  });
  it("subtracts a day", () => {
    expect(shiftIsoDate("2026-01-15", -1)).toBe("2026-01-14");
  });
  it("rolls forward over a month boundary", () => {
    expect(shiftIsoDate("2026-01-31", 1)).toBe("2026-02-01");
  });
  it("rolls backward over a month boundary", () => {
    expect(shiftIsoDate("2026-02-01", -1)).toBe("2026-01-31");
  });
});
