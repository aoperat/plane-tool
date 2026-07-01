# QuickAdd Dropdown Keyboard Navigation

## Goal

QuickAdd's field chips (담당자/시작일/마감일/상태/우선순위) and the project-select button already open their dropdown via Enter (native `<button>` behavior), but selecting an item inside the opened dropdown currently requires a mouse click — there is no keyboard way to move between items or select one. Add arrow-key navigation and Enter-to-select to every dropdown that uses the existing `.dd-item` pattern, including the project selector for consistency.

## Interaction model

Three small helper functions in `src/quickadd/main.ts`, operating on any container that holds `.dd-item` children:

- `initKeyboardFocus(container: HTMLElement)` — clears any existing `.kbd-focus`, then adds it to the container's current `.sel` item if one exists, else its first `.dd-item`. Called whenever a dropdown's contents are (re)rendered while opening or updating.
- `moveKeyboardFocus(container: HTMLElement, delta: 1 | -1)` — moves `.kbd-focus` to the next/previous `.dd-item`, wrapping at either end. Calls `scrollIntoView({ block: "nearest" })` on the newly focused item (relevant for `#fieldPopover`, which scrolls when long — e.g. many project members).
- `selectKeyboardFocus(container: HTMLElement)` — calls `.click()` on the current `.kbd-focus` item, reusing that item's existing `onclick` handler exactly as a mouse click would (so per-dropdown behavior — e.g. assignee toggling without closing vs. date/priority/state closing on pick — is preserved automatically, with no special-casing).

A shared keydown handler factory wraps these:

```ts
function handleDropdownKeydown(container: HTMLElement, isOpen: () => boolean, onClose: () => void) {
  return (e: KeyboardEvent) => {
    if (!isOpen()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveKeyboardFocus(container, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectKeyboardFocus(container);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
}
```

This is attached as a `keydown` listener on each trigger button (the 5 chips, plus `projBtn`) — not on the popover/dropdown container itself, since focus stays on the trigger button the entire time the dropdown is open (nothing inside it is ever given focus). When the dropdown is closed, `isOpen()` is false and the handler returns immediately without calling `preventDefault()`, so the existing native behavior (Enter opens it via the button's own `onclick`) is completely untouched.

**Why `preventDefault()` on Enter doesn't double-fire:** pressing Enter on a focused `<button>` triggers a `click` as that keypress's default action. Calling `preventDefault()` in the `keydown` handler cancels that default action, so the button's own `onclick` (which would otherwise re-toggle the dropdown) does not run a second time — only `selectKeyboardFocus`'s manual `.click()` on the target `.dd-item` fires.

## Integration points

| Trigger | Container | `initKeyboardFocus` call site |
|---|---|---|
| 담당자 chip | `#fieldPopover` | End of `renderAssigneePopoverItems()` (covers both the initial open and every re-render from toggling an assignee) |
| 시작일/마감일 chip | `#fieldPopover` | End of `openDatePopover()`, after all `.dd-item`s are appended |
| 우선순위 chip | `#fieldPopover` | End of `openPriorityPopover()` |
| 상태 chip | `#fieldPopover` | End of `openStatePopover()` |
| Project select button (`projBtn`) | `#dropdown` | Inside `projBtn.onclick`, only on the transition to open (`!dropdown.hidden`) |

The date popover's trailing custom `<input type="date">` (after the divider) is **not** part of the arrow-key cycle — it stays reachable only via Tab, as today. Native `<input type="date">` already uses arrow keys to adjust its own value, so folding it into the same list-navigation cycle would conflict with that.

**Escape while a trigger button has focus:** currently has no handling at all on these buttons (only `titleEl`'s own `keydown` listener handles Escape, and it isn't focused while a chip/project button is). This task adds Escape handling as part of the same `handleDropdownKeydown` wiring — pressing Escape while a dropdown is open now closes it (`closePopover()` for `#fieldPopover`, `dropdown.hidden = true` for `#dropdown`) regardless of which trigger button holds focus.

## CSS

One new rule in `src/shared/app.css`, alongside the existing `.dd-item` rules:

```css
.dd-item.kbd-focus { outline: 1px solid var(--accent); outline-offset: -1px; }
```

`.kbd-focus` marks "where the arrow-key cursor currently is" and is independent of `.sel` ("this is the current value," shown via background + checkmark). The two commonly coincide (e.g. right when a dropdown opens, per `initKeyboardFocus`'s fallback to `.sel`) and layer without conflict — the checkmark and the outline are visually distinct affordances.

## Out of scope

- Home/End keys, type-ahead (typing a letter to jump to a matching item) — not requested.
- Any change to the date popover's `<input type="date">` keyboard handling.
