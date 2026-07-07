import { describe, it, expect } from "vitest";
import { accumulateWheelStep } from "./wheelCycle";

describe("accumulateWheelStep", () => {
  it("steps forward on a single large upward scroll (negative deltaY)", () => {
    expect(accumulateWheelStep(0, -60)).toEqual({ step: 1, acc: 0 });
  });

  it("steps backward on a single large downward scroll (positive deltaY)", () => {
    expect(accumulateWheelStep(0, 60)).toEqual({ step: -1, acc: 0 });
  });

  it("does not step below threshold, and carries the accumulator forward", () => {
    expect(accumulateWheelStep(0, -20)).toEqual({ step: 0, acc: -20 });
  });

  it("crosses the threshold across multiple small calls", () => {
    const first = accumulateWheelStep(0, -20);
    expect(first).toEqual({ step: 0, acc: -20 });
    const second = accumulateWheelStep(first.acc, -20);
    expect(second).toEqual({ step: 0, acc: -40 });
    const third = accumulateWheelStep(second.acc, -20);
    expect(third).toEqual({ step: 1, acc: 0 });
  });

  it("resets the accumulator to 0 immediately after stepping", () => {
    const result = accumulateWheelStep(0, -80);
    expect(result.acc).toBe(0);
  });

  it("respects a custom threshold", () => {
    expect(accumulateWheelStep(0, -15, 10)).toEqual({ step: 1, acc: 0 });
    expect(accumulateWheelStep(0, -5, 10)).toEqual({ step: 0, acc: -5 });
  });
});
