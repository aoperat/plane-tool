import { describe, it, expect } from "vitest";
import { colorForId } from "./color";

describe("colorForId", () => {
  it("is deterministic for the same id", () => {
    expect(colorForId("p1")).toBe(colorForId("p1"));
  });
  it("returns an hsl string", () => {
    expect(colorForId("p1")).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
  it("differs for different ids (usually)", () => {
    expect(colorForId("p1")).not.toBe(colorForId("totally-different"));
  });
});
