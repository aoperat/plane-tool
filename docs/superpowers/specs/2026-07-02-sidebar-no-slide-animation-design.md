# Sidebar No-Slide Animation — Design

## Problem

The sidebar currently slides in from the right edge of its target monitor
(and slides back out) using a 180ms `requestAnimationFrame` animation
(`animatePosition` in `src/sidebar/main.ts`). The user wants it to simply
appear/disappear instantly instead, with no animation in either direction.

## Goals

- Showing the sidebar sets its final position immediately and shows it — no
  animation.
- Hiding the sidebar hides it immediately — no animation.
- No functional change to which monitor/position the sidebar appears at
  (the existing `display_index` setting and geometry math are unaffected).
- No dead code left behind: the animation-only pieces that become unused
  (`animatePosition`, `SLIDE_MS`, `easeOutCubic`, `SidebarGeometry.hiddenX`)
  are removed rather than left unused.

## Non-goals

- Any change to which display the sidebar/QuickAdd appear on.
- Any change to the sidebar's width/height calculation.
- Any change to pin/auto-hide-on-blur/refresh behavior.

## Design

### 1. `src/sidebar/logic.ts`

`SidebarGeometry` drops `hiddenX` (no longer meaningful once there's no
off-screen starting point to animate from):

```ts
export interface SidebarGeometry {
  width: number;
  height: number;
  /** x position (physical px), anchored to the right edge. */
  visibleX: number;
  /** y position (physical px), anchored to the target monitor's own top edge. */
  y: number;
}

export function computeSidebarGeometry(
  screenWidth: number,
  screenHeight: number,
  scaleFactor: number,
  panelWidthLogical: number,
  originX = 0,
  originY = 0,
): SidebarGeometry {
  const width = Math.round(panelWidthLogical * scaleFactor);
  return {
    width,
    height: screenHeight,
    visibleX: originX + screenWidth - width,
    y: originY,
  };
}
```

`easeOutCubic` is deleted entirely — its only caller was the animation loop
being removed.

### 2. `src/sidebar/main.ts`

- `SLIDE_MS` constant and `animatePosition` function are deleted.
- `easeOutCubic` is dropped from the `./logic` import.
- `slideIn` is renamed `showSidebar` and simplified: compute geometry (as
  today, using `getTargetMonitor()`), `setSize`, `setPosition` directly to
  `(geo.visibleX, geo.y)`, `setAlwaysOnTop(true)`, `show()`, `setFocus()`.
  No animation call.
- `slideOut` is renamed `hideSidebar` and simplified to: if not visible,
  return; otherwise `hide()`. It no longer needs `getTargetMonitor()` or
  `computeSidebarGeometry` at all, since there's no off-screen position to
  animate to first.
- The three internal call sites (`toggleSidebar`, the Escape-key handler,
  the `tauri://blur` handler) are updated to call `showSidebar`/`hideSidebar`
  instead of `slideIn`/`slideOut`.

### 3. `src/sidebar/logic.test.ts`

- `computeSidebarGeometry` test cases drop their `hiddenX` assertions.
- The `easeOutCubic` `describe` block is deleted entirely.

## Testing

- `src/sidebar/logic.test.ts` covers the geometry math (unaffected fields:
  `width`, `height`, `visibleX`, `y`, including the absolute-offset cases).
- `src/sidebar/main.ts` has no automated test harness (no jsdom) — manual
  verification: toggle the sidebar shortcut and confirm it appears/disappears
  instantly with no slide, on both a single-monitor setup and (if available)
  a non-primary configured display.
