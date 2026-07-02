import { describe, it, expect } from "vitest";
import { sortMonitorsByPosition, pickMonitor } from "./monitors";

function mon(x: number, y: number) {
  return { position: { x, y } };
}

describe("sortMonitorsByPosition", () => {
  it("orders monitors left-to-right by x position", () => {
    const monitors = [mon(1920, 0), mon(0, 0)];
    expect(sortMonitorsByPosition(monitors)).toEqual([mon(0, 0), mon(1920, 0)]);
  });

  it("breaks ties on x using y position", () => {
    const monitors = [mon(0, 1080), mon(0, 0)];
    expect(sortMonitorsByPosition(monitors)).toEqual([mon(0, 0), mon(0, 1080)]);
  });

  it("does not mutate the input array", () => {
    const monitors = [mon(1920, 0), mon(0, 0)];
    const copy = [...monitors];
    sortMonitorsByPosition(monitors);
    expect(monitors).toEqual(copy);
  });
});

describe("pickMonitor", () => {
  const sorted = [mon(0, 0), mon(1920, 0), mon(3840, 0)];

  it("returns the monitor at the 1-based displayIndex", () => {
    expect(pickMonitor(sorted, 2)).toEqual(mon(1920, 0));
  });

  it("falls back to the first monitor when the index is out of range", () => {
    expect(pickMonitor(sorted, 5)).toEqual(mon(0, 0));
  });

  it("falls back to the first monitor when the index is 0 or negative", () => {
    expect(pickMonitor(sorted, 0)).toEqual(mon(0, 0));
  });

  it("returns undefined when there are no monitors", () => {
    expect(pickMonitor([], 1)).toBeUndefined();
  });
});
