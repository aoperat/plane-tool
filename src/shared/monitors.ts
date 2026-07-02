export interface MonitorLike {
  position: { x: number; y: number };
}

/** Sorts monitors left-to-right by x position (ties broken by y), giving a stable, predictable
 *  numbering — "Display 1" is always the leftmost monitor — independent of OS enumeration order. */
export function sortMonitorsByPosition<T extends MonitorLike>(monitors: T[]): T[] {
  return [...monitors].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
}

/** Picks the monitor at the given 1-based `displayIndex` from an already-sorted list. Falls back to
 *  the first monitor when the index is out of range (including 0/negative), and to `undefined` when
 *  the list is empty. */
export function pickMonitor<T>(sortedMonitors: T[], displayIndex: number): T | undefined {
  return sortedMonitors[displayIndex - 1] ?? sortedMonitors[0];
}
