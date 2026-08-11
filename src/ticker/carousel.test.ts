import { afterEach, describe, expect, it, vi } from "vitest";
import { createCarouselController } from "./carousel";

describe("createCarouselController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances at the requested 7,000 ms interval", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance });

    controller.start();
    vi.advanceTimersByTime(6_999);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(7_000);
    expect(onAdvance).toHaveBeenCalledTimes(2);
  });

  it("pauses on hover and starts a fresh interval when hover clears", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance });

    controller.start();
    vi.advanceTimersByTime(3_000);
    controller.setHovered(true);
    vi.advanceTimersByTime(20_000);
    expect(onAdvance).not.toHaveBeenCalled();

    controller.setHovered(false);
    vi.advanceTimersByTime(6_999);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("keeps focus and hover pause flags independent", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance });

    controller.start();
    controller.setHovered(true);
    controller.setFocused(true);
    controller.setHovered(false);
    vi.advanceTimersByTime(20_000);
    expect(onAdvance).not.toHaveBeenCalled();

    controller.setFocused(false);
    vi.advanceTimersByTime(6_999);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("stops and resets the timer after manual navigation", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const controller = createCarouselController({ intervalMs: 7_000, onAdvance });

    controller.start();
    vi.advanceTimersByTime(3_000);
    controller.stop();
    vi.advanceTimersByTime(7_000);
    expect(onAdvance).not.toHaveBeenCalled();

    controller.start();
    vi.advanceTimersByTime(3_000);
    controller.resetAfterManualNavigation();
    vi.advanceTimersByTime(6_999);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});
