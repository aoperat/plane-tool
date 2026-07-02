# QuickAdd Chip Row Arrow-Key Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ArrowLeft/ArrowRight move focus between QuickAdd's 5 field chips when no dropdown is open, complementing the dropdown-item Up/Down navigation already shipped.

**Architecture:** A single shared keydown handler (`handleChipArrowNav`) attached to all 5 chip buttons. It's a no-op whenever a dropdown is open (`openPopover !== null`), since Up/Down already own navigation in that state.

**Tech Stack:** TypeScript (Vite, vitest), plain DOM (no framework).

## Global Constraints

- No new UI framework or state library — plain DOM manipulation matching the existing `src/quickadd/main.ts` style.
- No wrap-around at the ends (explicit user choice) — ArrowLeft on the first chip and ArrowRight on the last chip do nothing.
- Only acts while no dropdown is open (`openPopover === null`) — must not interfere with the existing ArrowUp/Down dropdown-item navigation.
- `src/quickadd/main.ts` has no automated test harness (no jsdom in `vite.config.ts`) — verify via `pnpm exec tsc --noEmit` and a manual run-through, consistent with existing project convention.
- Spec: `docs/superpowers/specs/2026-07-02-quickadd-chip-row-arrow-nav-design.md`.

---

### Task 1: Chip-to-chip ArrowLeft/ArrowRight navigation

**Files:**
- Modify: `src/quickadd/main.ts`

**Interfaces:** None — this is the only task in the plan; nothing else depends on it.

No automated test for this task (no jsdom harness for `main.ts`, confirmed existing convention). Verify via `pnpm exec tsc --noEmit` plus a manual run-through — state explicitly if you can't drive the real QuickAdd popup in this environment, don't claim you verified it.

- [ ] **Step 1: Add the chip array and arrow-nav handler, and wire it to the 5 chip buttons**

In `src/quickadd/main.ts`, change:

```ts
const fieldPopoverKeydown = handleDropdownKeydown(fieldPopover, () => openPopover !== null, () => {
  closePopover();
  titleEl.focus();
});
chipAssignee.addEventListener("keydown", fieldPopoverKeydown);
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);

function resetFields() {
```

to:

```ts
const fieldPopoverKeydown = handleDropdownKeydown(fieldPopover, () => openPopover !== null, () => {
  closePopover();
  titleEl.focus();
});
chipAssignee.addEventListener("keydown", fieldPopoverKeydown);
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);

// DOM order of the field chips, used for ArrowLeft/ArrowRight navigation between them.
const chips = [chipAssignee, chipStart, chipDue, chipState, chipPriority];

/** Moves focus to the previous/next chip in `chips` (no wrap). No-op while a dropdown is open,
 *  since ArrowUp/ArrowDown already own navigation there (see `handleDropdownKeydown`). */
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

function resetFields() {
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run `pnpm tauri dev`, open QuickAdd, select a project. Expected:
- Tab to the 담당자 chip, press ArrowRight repeatedly — focus should move through 시작일 → 마감일 → 진행상태 → 우선순위, then stop (ArrowRight on 우선순위 does nothing).
- Press ArrowLeft repeatedly from 우선순위 — focus should move back through the chips to 담당자, then stop (ArrowLeft on 담당자 does nothing).
- Tab/Shift+Tab between chips should still work exactly as before (no regression).
- Open a chip's dropdown (Enter), then press ArrowLeft/ArrowRight — nothing should happen to the dropdown or to chip focus (ArrowUp/ArrowDown should still be the only way to move within an open dropdown, per existing behavior).

- [ ] **Step 4: Commit**

```bash
git add src/quickadd/main.ts
git commit -m "feat(quickadd): add ArrowLeft/ArrowRight navigation between field chips"
```
