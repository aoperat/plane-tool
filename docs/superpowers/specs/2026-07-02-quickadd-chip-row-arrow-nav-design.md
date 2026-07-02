# QuickAdd Chip Row Arrow-Key Navigation

## Goal

QuickAdd's 5 field chips (담당자/시작일/마감일/진행상태/우선순위) are only reachable one at a time via Tab/Shift+Tab today. Add ArrowLeft/ArrowRight navigation between them, matching the horizontal "toolbar" keyboard pattern, as a companion to the dropdown-item arrow navigation added in [[2026-07-02-quickadd-dropdown-keyboard-nav-design]].

## Behavior

- A shared `handleChipArrowNav` keydown handler is attached to all 5 chip buttons.
- It only acts when no dropdown is open (`openPopover === null`) — while a dropdown is open, ArrowUp/Down already own item navigation (per the companion feature), so ArrowLeft/Right are left untouched in that state.
- ArrowRight moves focus to the next chip in DOM order (담당자 → 시작일 → 마감일 → 진행상태 → 우선순위); ArrowLeft moves to the previous one.
- No wrap-around: ArrowLeft on the first chip (담당자) and ArrowRight on the last chip (우선순위) do nothing.
- Does not open the target chip's dropdown — only moves focus, matching plain Tab's existing behavior (Tab already moves focus without opening anything; this is the same, just left/right instead of forward/backward-only).

## Implementation sketch

```ts
const chips = [chipAssignee, chipStart, chipDue, chipState, chipPriority];
function handleChipArrowNav(e: KeyboardEvent) {
  if (openPopover !== null) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const currentIndex = chips.indexOf(e.currentTarget as HTMLElement);
  const nextIndex = currentIndex + (e.key === "ArrowRight" ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= chips.length) return;
  e.preventDefault();
  chips[nextIndex].focus();
}
chips.forEach((chip) => chip.addEventListener("keydown", handleChipArrowNav));
```

Registered as an additional `keydown` listener alongside the existing `fieldPopoverKeydown` listener on each chip — the two never overlap (one only acts while closed, the other only while open), so no conflict.

## Out of scope

- Wrap-around at the ends (explicitly declined).
- Including `projBtn` or `descToggle` in this left/right cycle — they're outside the chip row.
