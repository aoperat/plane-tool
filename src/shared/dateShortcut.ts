/** Maps a keydown to the quick-add date-shift shortcut: PageUp/PageDown move the due date,
 *  Ctrl+PageUp/PageDown move the start date. PageDown pushes later (+1 day, "postpone"),
 *  PageUp pulls earlier (−1 day), following the calendar convention of PageDown = next. */
export function resolveDateShortcut(
  key: string,
  ctrl: boolean,
): { kind: "start" | "due"; delta: 1 | -1 } | null {
  if (key !== "PageUp" && key !== "PageDown") return null;
  return { kind: ctrl ? "start" : "due", delta: key === "PageDown" ? 1 : -1 };
}
