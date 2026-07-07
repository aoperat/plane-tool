# QuickAdd/EditModal Chip Wheel Cycling

## Goal

Let mouse wheel scrolling over a field chip (담당자/시작일/마감일/우선순위/진행상태) change its value directly, without opening the dropdown first. Applies to QuickAdd and EditModal only — the sidebar keeps click-only editing (wheel there risks firing too many live update requests, per user decision).

## Behavior

- A shared `attachWheelCycle(el, getLength, onStep)` helper (new `src/shared/wheelCycle.ts`) is attached to each of QuickAdd's and EditModal's 5 chips.
- Fires on `wheel` while the pointer is over the chip button itself, regardless of whether that chip's popover is currently open or closed. The popover's own scrollable list (`.field-popover`) is untouched — wheeling over open list items keeps native scroll, not cycling.
- Direction: scrolling up (`deltaY < 0`) steps the value "forward" (우선순위 없음→낮음→...→긴급, 상태 backlog→...→cancelled, date → later); scrolling down steps backward. Matches the common number-input-spinner convention (wheel up = increase).
- Wraps at either end of the array (no dead stop).
- `deltaY` magnitude accumulates in the helper; only fires `onStep` once accumulated `|Σ deltaY| >= 50`, then resets — prevents a single trackpad swipe from cycling through many values at once.
- `getLength() <= 1` (e.g., a project with only one member) makes the helper a no-op — no listener effect, nothing to cycle through.
- Calls `e.preventDefault()` so the popup/modal body never scrolls along with a chip-wheel gesture.
- Priority/state direction is computed from the canonical shared arrays (`PRIORITY_ORDER`, `STATE_ORDER` in `shared/planeIcons.ts`), not from any per-file popover rendering order.
- If the chip's popover happens to be open while the wheel fires, the popover is **not** closed — the newly selected value's row gets `.sel`, matching what a click would have produced, and the popover stays open.
- Saving semantics are unchanged: QuickAdd commits on 생성, EditModal commits on 저장. Wheel only mutates the same local state variables (`priority`, `stateGroup`, `startChoice`/`startCustomDate`, `dueChoice`/`dueCustomDate`, `assigneeIds`) that clicking an option already mutates, then calls the existing `renderChips()`.

### Per-field cycling source

| Chip | Cycle source | Notes |
|---|---|---|
| 우선순위 | `PRIORITY_ORDER` | wrap at both ends |
| 진행상태 | `STATE_ORDER` | wrap at both ends |
| 시작일/마감일 | `shiftIsoDate(current, ±1)` | reuses QuickAdd's existing `shiftDateField(kind, delta)` (already used by the PageUp/PageDown shortcut); the same function is added to EditModal, which doesn't have it yet. Keeps the existing start/due-date-crossing guard. |
| 담당자 | `members` array | single-select cycle only — matches a plain click, not the Ctrl+click multi-select behavior |

## Implementation sketch

```ts
// src/shared/wheelCycle.ts
export function attachWheelCycle(
  el: HTMLElement,
  getLength: () => number,
  onStep: (delta: 1 | -1) => void,
): void {
  let acc = 0;
  const THRESHOLD = 50;
  el.addEventListener("wheel", (e) => {
    if (getLength() <= 1) return;
    e.preventDefault();
    acc += e.deltaY;
    if (Math.abs(acc) < THRESHOLD) return;
    onStep(acc > 0 ? -1 : 1); // wheel down (positive deltaY) = backward
    acc = 0;
  }, { passive: false });
}
```

Each surface wires its own `onStep`:

```ts
// quickadd/main.ts, editmodal/main.ts (identical shape, own local state)
attachWheelCycle(chipPriority, () => PRIORITY_ORDER.length, (delta) => {
  const i = PRIORITY_ORDER.indexOf(priority);
  priority = PRIORITY_ORDER[(i + delta + PRIORITY_ORDER.length) % PRIORITY_ORDER.length];
  renderChips();
});

attachWheelCycle(chipStart, () => 2, (delta) => shiftDateField("start", delta));
attachWheelCycle(chipDue, () => 2, (delta) => shiftDateField("due", delta));

attachWheelCycle(chipAssignee, () => members.length, (delta) => {
  const meIndex = members.findIndex((m) => m.is_me);
  const currentId = assigneeIds[0] ?? members[meIndex]?.id;
  const i = members.findIndex((m) => m.id === currentId);
  const next = members[((i === -1 ? meIndex : i) + delta + members.length) % members.length];
  assigneeIds = next.is_me ? [] : [next.id];
  renderChips();
});
```

(Date chips pass a constant `2` for `getLength` — they always have "a next/previous day" to step to, so the no-op guard never needs to trigger for them.)

## Out of scope

- Sidebar task rows — explicitly excluded to avoid firing live update requests on every wheel notch.
- Multi-select assignee cycling (Ctrl+click semantics) via wheel.
- Any visual affordance beyond the existing `:hover` border-color change (no new "scrollable" icon/tooltip).
