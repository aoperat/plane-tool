/** Pure step logic: accumulates wheel deltaY until it crosses `threshold`, then reports
 *  a direction and resets. Kept DOM-free (mirrors shared/hotkey.ts's captureFromKeyEvent
 *  split) so it's directly unit-testable. Wheel-up (negative deltaY) is "forward" (+1) —
 *  the same convention as native number-input spinners. */
export function accumulateWheelStep(
  acc: number,
  deltaY: number,
  threshold = 50,
): { step: -1 | 0 | 1; acc: number } {
  const next = acc + deltaY;
  if (Math.abs(next) < threshold) return { step: 0, acc: next };
  return { step: next < 0 ? 1 : -1, acc: 0 };
}

/** Attaches a wheel listener to `el` that cycles a value forward/backward one step at a
 *  time. `getLength()` is checked on every event (not just once at attach time) since the
 *  cyclable set can change later (e.g. project member count, or EditModal's assignee-count
 *  guard) — `<= 1` disables the listener's effect entirely (no preventDefault, no step),
 *  so page/popup scroll behaves normally when there's nothing to cycle through. */
export function attachWheelCycle(
  el: HTMLElement,
  getLength: () => number,
  onStep: (delta: 1 | -1) => void,
): void {
  let acc = 0;
  el.addEventListener(
    "wheel",
    (e) => {
      if (getLength() <= 1) return;
      e.preventDefault();
      const result = accumulateWheelStep(acc, e.deltaY);
      acc = result.acc;
      if (result.step !== 0) onStep(result.step);
    },
    { passive: false },
  );
}
