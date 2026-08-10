// Keyboard-cursor helpers for `.dd-item` dropdowns. They read and write only the DOM they
// are handed, so both QuickAdd layouts (and the expanded layout's "+N" popover) share one
// copy instead of each closing over its own — same reasoning as shared/tooltip.ts.

/** Puts the keyboard cursor on `container`'s current `.sel` item, or its first item if none is selected. */
export function initKeyboardFocus(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  items.forEach((el) => el.classList.remove("kbd-focus"));
  const current = items.find((el) => el.classList.contains("sel")) ?? items[0];
  current?.classList.add("kbd-focus");
}

/** Moves the keyboard cursor to the next/previous `.dd-item` in `container`, wrapping at either end. */
export function moveKeyboardFocus(container: HTMLElement, delta: 1 | -1) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  if (items.length === 0) return;
  const currentIndex = items.findIndex((el) => el.classList.contains("kbd-focus"));
  const nextIndex =
    currentIndex === -1 ? (delta > 0 ? 0 : items.length - 1) : (currentIndex + delta + items.length) % items.length;
  items.forEach((el) => el.classList.remove("kbd-focus"));
  items[nextIndex].classList.add("kbd-focus");
  items[nextIndex].scrollIntoView({ block: "nearest" });
}

/** Clicks `container`'s current keyboard-cursor item, reusing its existing onclick handler. */
export function selectKeyboardFocus(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  items.find((el) => el.classList.contains("kbd-focus"))?.click();
}

export function keyboardFocusIndex(container: HTMLElement): number {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  return items.findIndex((el) => el.classList.contains("kbd-focus"));
}

/** Puts the keyboard cursor on the `index`-th `.dd-item` (clamped to the last item), bypassing
 *  `initKeyboardFocus`'s jump-to-selection default — keeps the cursor in place across a re-render. */
export function setKeyboardFocusIndex(container: HTMLElement, index: number) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  if (items.length === 0 || index < 0) return;
  items.forEach((el) => el.classList.remove("kbd-focus"));
  items[Math.min(index, items.length - 1)].classList.add("kbd-focus");
}

/** Builds a keydown handler for a dropdown trigger button: arrow keys move, Enter selects, Escape closes.
 *  Does nothing (and doesn't call preventDefault) while `isOpen()` is false, so the trigger button's own
 *  native Enter-activates-click behavior still opens the dropdown as before. */
export function handleDropdownKeydown(container: HTMLElement, isOpen: () => boolean, onClose: () => void) {
  return (e: KeyboardEvent) => {
    if (!isOpen()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveKeyboardFocus(container, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const trigger = e.currentTarget as HTMLElement;
      selectKeyboardFocus(container);
      // The selected item's own onclick moves focus to titleEl (matching mouse-click
      // behavior) — pull it back to the trigger chip so ArrowLeft/ArrowRight chip
      // navigation can continue right after a keyboard selection.
      trigger.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
}
