import { describe, it, expect } from "vitest";
import { isWithinCooldown } from "./cooldown";

describe("isWithinCooldown", () => {
  it("is true right after the last attempt", () => {
    expect(isWithinCooldown(1000, 1000, 3000)).toBe(true);
  });

  it("is true while still inside the cooldown window", () => {
    expect(isWithinCooldown(1000, 2999, 3000)).toBe(true);
  });

  it("is false once the cooldown window has elapsed", () => {
    expect(isWithinCooldown(1000, 4000, 3000)).toBe(false);
  });

  it("is false when there was no prior attempt (lastAt = 0)", () => {
    expect(isWithinCooldown(0, 100, 3000)).toBe(false);
  });
});
