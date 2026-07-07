# QuickAdd/EditModal Chip Wheel Cycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mouse-wheel scrolling over a QuickAdd/EditModal field chip (담당자/시작일/마감일/우선순위/진행상태) cycle that field's value directly, without opening its dropdown.

**Architecture:** A new pure/testable stepping function plus a thin DOM-wiring wrapper live in `src/shared/wheelCycle.ts`. `src/quickadd/main.ts` and `src/editmodal/main.ts` each call the wrapper once per chip, reusing their own existing local state variables and `renderChips()`.

**Tech Stack:** Vanilla TypeScript, Vite, vitest (`pnpm test` runs `vitest run`).

Spec: [[2026-07-07-quickadd-wheel-cycle-design]] (`docs/superpowers/specs/2026-07-07-quickadd-wheel-cycle-design.md`)

## Global Constraints

- Wheel-cycling only applies to QuickAdd and EditModal — sidebar task rows are explicitly out of scope (user declined, to avoid firing live update requests on every wheel notch).
- Direction: wheel up (net negative `deltaY`) steps the value forward (우선순위 없음→긴급, 상태 backlog→cancelled, date → later day); wheel down steps backward. Wraps at both ends.
- Threshold: only step once accumulated `|Σ deltaY| >= 50`, then reset the accumulator to 0.
- `getLength() <= 1` must make the wheel handler a no-op (no `preventDefault`, no step) — used both for "nothing to cycle through" (e.g. one project member) and EditModal's multi-assignee guard.
- Every wheel event that *does* act must call `e.preventDefault()` so the popup/modal body never scrolls.
- Priority/state direction is always computed from the canonical `PRIORITY_ORDER` / `STATE_ORDER` arrays in `src/shared/planeIcons.ts` — never from a per-file popover rendering order.
- An open popover is never closed by a wheel event; only its `.sel` class and the chip's own re-render need to reflect the new value.

---

### Task 1: Shared wheel-cycle helper

**Files:**
- Create: `src/shared/wheelCycle.ts`
- Test: `src/shared/wheelCycle.test.ts`

**Interfaces:**
- Produces: `accumulateWheelStep(acc: number, deltaY: number, threshold?: number): { step: -1 | 0 | 1; acc: number }` — pure function, no DOM. `step` is `1` (forward) or `-1` (backward) once the accumulated magnitude crosses `threshold` (default `50`); otherwise `0` and `acc` carries over.
- Produces: `attachWheelCycle(el: HTMLElement, getLength: () => number, onStep: (delta: 1 | -1) => void): void` — attaches a non-passive `wheel` listener to `el` that no-ops while `getLength() <= 1`, otherwise calls `e.preventDefault()` and feeds `e.deltaY` through an internal accumulator (via `accumulateWheelStep`), invoking `onStep` on each completed step.

- [ ] **Step 1: Write the failing tests for `accumulateWheelStep`**

Create `src/shared/wheelCycle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accumulateWheelStep } from "./wheelCycle";

describe("accumulateWheelStep", () => {
  it("steps forward on a single large upward scroll (negative deltaY)", () => {
    expect(accumulateWheelStep(0, -60)).toEqual({ step: 1, acc: 0 });
  });

  it("steps backward on a single large downward scroll (positive deltaY)", () => {
    expect(accumulateWheelStep(0, 60)).toEqual({ step: -1, acc: 0 });
  });

  it("does not step below threshold, and carries the accumulator forward", () => {
    expect(accumulateWheelStep(0, -20)).toEqual({ step: 0, acc: -20 });
  });

  it("crosses the threshold across multiple small calls", () => {
    const first = accumulateWheelStep(0, -20);
    expect(first).toEqual({ step: 0, acc: -20 });
    const second = accumulateWheelStep(first.acc, -20);
    expect(second).toEqual({ step: 0, acc: -40 });
    const third = accumulateWheelStep(second.acc, -20);
    expect(third).toEqual({ step: 1, acc: 0 });
  });

  it("resets the accumulator to 0 immediately after stepping", () => {
    const result = accumulateWheelStep(0, -80);
    expect(result.acc).toBe(0);
  });

  it("respects a custom threshold", () => {
    expect(accumulateWheelStep(0, -15, 10)).toEqual({ step: 1, acc: 0 });
    expect(accumulateWheelStep(0, -5, 10)).toEqual({ step: 0, acc: -5 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- wheelCycle`
Expected: FAIL — `Cannot find module './wheelCycle'` (or similar resolution error), since `src/shared/wheelCycle.ts` doesn't exist yet.

- [ ] **Step 3: Implement `accumulateWheelStep` and `attachWheelCycle`**

Create `src/shared/wheelCycle.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- wheelCycle`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/wheelCycle.ts src/shared/wheelCycle.test.ts
git commit -m "feat(shared): add wheel-cycle accumulator and DOM wiring helper"
```

---

### Task 2: Wire wheel cycling into QuickAdd

**Files:**
- Modify: `src/quickadd/main.ts:5-11` (imports), `src/quickadd/main.ts:525-528` (insertion point, immediately after the existing `chipState.addEventListener("keydown", fieldPopoverKeydown);` line and before the `const chips = [...]` line)

**Interfaces:**
- Consumes: `attachWheelCycle` from Task 1 (`src/shared/wheelCycle.ts`); `PRIORITY_ORDER`, `STATE_ORDER` from `src/shared/planeIcons.ts` (already imported in this file); the file's own existing `priority`, `stateGroup`, `startChoice`/`startCustomDate`, `dueChoice`/`dueCustomDate`, `assigneeIds`, `members` variables, `shiftDateField`, and `renderChips()`.

- [ ] **Step 1: Add the import**

In `src/quickadd/main.ts`, change:

```ts
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
```

to:

```ts
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import { attachWheelCycle } from "../shared/wheelCycle";
```

- [ ] **Step 2: Wire the five chips**

In `src/quickadd/main.ts`, immediately after:

```ts
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);
```

insert:

```ts
attachWheelCycle(chipPriority, () => PRIORITY_ORDER.length, (delta) => {
  const i = PRIORITY_ORDER.indexOf(priority);
  priority = PRIORITY_ORDER[(i + delta + PRIORITY_ORDER.length) % PRIORITY_ORDER.length];
  renderChips();
});

attachWheelCycle(chipState, () => STATE_ORDER.length, (delta) => {
  const i = STATE_ORDER.indexOf(stateGroup);
  stateGroup = STATE_ORDER[(i + delta + STATE_ORDER.length) % STATE_ORDER.length];
  renderChips();
});

attachWheelCycle(chipStart, () => 2, (delta) => shiftDateField("start", delta));
attachWheelCycle(chipDue, () => 2, (delta) => shiftDateField("due", delta));

// Single-select cycle — matches a plain (non-Ctrl) click. Empty assigneeIds means
// "defaults to me", so start the cycle from the "me" row when nothing is picked yet.
attachWheelCycle(chipAssignee, () => members.length, (delta) => {
  const meIndex = members.findIndex((m) => m.is_me);
  const currentId = assigneeIds[0] ?? members[meIndex]?.id;
  const i = members.findIndex((m) => m.id === currentId);
  const next = members[((i === -1 ? meIndex : i) + delta + members.length) % members.length];
  assigneeIds = next.is_me ? [] : [next.id];
  renderChips();
});
```

- [ ] **Step 3: Run the existing test suite and the build**

Run: `pnpm test`
Expected: PASS (all existing suites still pass — this task adds no new test file, only DOM wiring)

Run: `pnpm build`
Expected: builds without TypeScript errors

- [ ] **Step 4: Manual verification**

Run: `pnpm dev`, open the QuickAdd window (via its shortcut), select a project with 2+ members.
- Hover the 우선순위 chip (popover closed) and scroll: label should step through 없음→낮음→보통→높음→긴급→(wraps to 없음) on scroll-up, reverse on scroll-down.
- Repeat for the 진행상태 chip against Backlog→Todo→In Progress→Done→Cancelled.
- Hover 시작일/마감일 and scroll: the displayed date advances/recedes by one day per step; pushing 시작일 past 마감일 (or vice versa) should carry the other date along (existing `shiftDateField` guard).
- Hover 담당자 and scroll: cycles through project members one at a time; label matches what clicking that member would show.
- Click a chip to open its popover, then scroll while still hovering it: the popover should stay open and its highlighted (`.sel`) row should track the new value instead of closing.
- Confirm the background popup does not itself scroll/jump while wheeling over a chip.

- [ ] **Step 5: Commit (includes the Task 4 changelog bullet)**

Do Task 4's Step 1 (add the `CHANGELOG.md` bullet) before running this commit, then:

```bash
git add src/quickadd/main.ts CHANGELOG.md
git commit -m "feat(quickadd): cycle chip values on mouse wheel"
```

---

### Task 3: Add `shiftDateField` to EditModal and wire wheel cycling (with assignee guard)

**Files:**
- Modify: `src/editmodal/main.ts:5` (imports), `src/editmodal/main.ts:92` (insertion point for the new `shiftDateField` function, right after the existing `resolveDateChoice` function), `src/editmodal/main.ts:259` (insertion point for wheel wiring, immediately after the existing `emChipState.onclick = ...` line)

**Interfaces:**
- Consumes: `attachWheelCycle` from Task 1; `PRIORITY_ORDER`, `STATE_ORDER` (already imported); `shiftIsoDate` (newly imported from `../shared/datePresets`, exported there per `src/shared/datePresets.ts:23`); the file's own `priority`, `stateGroup`, `startChoice`/`startCustomDate`, `dueChoice`/`dueCustomDate`, `assigneeIds`, `members`, `resolveDateChoice`, `renderChips()`.
- Produces: `shiftDateField(kind: "start" | "due", delta: number): void` (new to this file — copied from `src/quickadd/main.ts:96-123`, same behavior including the start/due crossing guard).

- [ ] **Step 1: Add the `shiftIsoDate` import**

In `src/editmodal/main.ts`, change:

```ts
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from "../shared/datePresets";
```

to:

```ts
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../shared/datePresets";
import { attachWheelCycle } from "../shared/wheelCycle";
```

- [ ] **Step 2: Add `shiftDateField`**

In `src/editmodal/main.ts`, immediately after:

```ts
function resolveDateChoice(choice: DateChoice, custom: string): string {
  return choice === "custom" ? custom : resolveDatePreset(choice);
}
```

insert (identical to QuickAdd's, per `src/quickadd/main.ts:96-123`):

```ts
// ISO yyyy-mm-dd strings compare correctly with plain string ordering, so the
// clamps below don't need Date parsing.
function shiftDateField(kind: "start" | "due", delta: number) {
  if (kind === "start") {
    const current = resolveDateChoice(startChoice, startCustomDate);
    const next = shiftIsoDate(current, delta);
    startCustomDate = next;
    startChoice = "custom";
    const due = resolveDateChoice(dueChoice, dueCustomDate);
    if (next > due) {
      dueCustomDate = next;
      dueChoice = "custom";
    }
  } else {
    const current = resolveDateChoice(dueChoice, dueCustomDate);
    const next = shiftIsoDate(current, delta);
    dueCustomDate = next;
    dueChoice = "custom";
    const start = resolveDateChoice(startChoice, startCustomDate);
    if (start > next) {
      startCustomDate = next;
      startChoice = "custom";
    }
  }
  renderChips();
}
```

- [ ] **Step 3: Wire the five chips**

In `src/editmodal/main.ts`, immediately after:

```ts
emChipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };
```

insert:

```ts
attachWheelCycle(emChipPriority, () => PRIORITY_ORDER.length, (delta) => {
  const i = PRIORITY_ORDER.indexOf(priority);
  priority = PRIORITY_ORDER[(i + delta + PRIORITY_ORDER.length) % PRIORITY_ORDER.length];
  renderChips();
});

attachWheelCycle(emChipState, () => STATE_ORDER.length, (delta) => {
  const i = STATE_ORDER.indexOf(stateGroup);
  stateGroup = STATE_ORDER[(i + delta + STATE_ORDER.length) % STATE_ORDER.length];
  renderChips();
});

attachWheelCycle(emChipStart, () => 2, (delta) => shiftDateField("start", delta));
attachWheelCycle(emChipDue, () => 2, (delta) => shiftDateField("due", delta));

// EditModal's assignee popover is toggle-based multi-select (every click adds/removes a
// member — there's no "single pick" click like QuickAdd's). Wheel-cycling would silently
// collapse a real multi-assignee issue down to one person, so it's only active while 0 or
// 1 assignees are currently set. Cycle order is [null ("담당자 없음"), ...members], matching
// renderAssigneePopoverItems (src/editmodal/main.ts:144-158).
attachWheelCycle(
  emChipAssignee,
  () => (assigneeIds.length <= 1 ? members.length + 1 : 0),
  (delta) => {
    const options: (string | null)[] = [null, ...members.map((m) => m.id)];
    const i = options.indexOf(assigneeIds[0] ?? null);
    const nextValue = options[(i + delta + options.length) % options.length];
    assigneeIds = nextValue === null ? [] : [nextValue];
    renderChips();
  },
);
```

- [ ] **Step 4: Run the existing test suite and the build**

Run: `pnpm test`
Expected: PASS (no new test file in this task — `shiftDateField`'s underlying date math is already covered by `src/shared/datePresets.test.ts`'s `shiftIsoDate` tests, and the wiring itself is DOM-only)

Run: `pnpm build`
Expected: builds without TypeScript errors

- [ ] **Step 5: Manual verification**

Run: `pnpm dev`, open an existing issue's EditModal (double-click a sidebar task row) for a project with 2+ members.
- With the issue's assignees at 0 or 1 people: hover 담당자 and scroll — cycles through "담당자 없음" then each member, one at a time.
- Now open an issue (or use 담당자 popover to Ctrl/toggle-select) that has 2+ assignees already set, close the popover, then hover 담당자 and scroll: nothing should change (guard active) — background modal also should not scroll, confirming the `getLength() <= 1` no-op path still calls no `preventDefault` issue in practice (native scroll of the surrounding page, if any, is harmless here since the modal itself doesn't scroll).
- Repeat the 우선순위/진행상태/시작일/마감일 checks from Task 2's manual verification — should behave identically here.
- Confirm 저장 still persists whatever value wheel-cycling left in place (i.e., wheel-only changes are picked up by `save()` the same as click-driven changes, since both go through the same local state variables).

- [ ] **Step 6: Commit**

```bash
git add src/editmodal/main.ts
git commit -m "feat(editmodal): cycle chip values on mouse wheel"
```

---

### Task 4: Changelog entry

Per this repo's `CLAUDE.md` rule, a user-visible feature/behavior change must add one Korean bullet to `CHANGELOG.md`'s `## [Unreleased]` section in the same commit as the change. Tasks 2 and 3 above are the user-visible change (QuickAdd and EditModal both gain wheel-cycling); fold the changelog edit into whichever of those two commits lands the feature for the user (recommend doing it once, in Task 2's commit, since QuickAdd is the surface named in the original request) rather than as a separate commit.

**Files:**
- Modify: `CHANGELOG.md` (top of the `## [Unreleased]` section, `### 추가` category — this is new capability, not a behavior change to something existing)

- [ ] **Step 1: Add the bullet**

`CHANGELOG.md:6-11` currently reads:

```markdown
## [Unreleased]

### 추가

- 사이드바 날짜 팝오버에서 시작일도 마감일처럼 오늘/내일/다음 주 버튼으로
  바로 지정할 수 있습니다.
```

The `### 추가` subheading already exists under `[Unreleased]` — append a new bullet directly below the existing one (same list, no new subheading):

```markdown
## [Unreleased]

### 추가

- 사이드바 날짜 팝오버에서 시작일도 마감일처럼 오늘/내일/다음 주 버튼으로
  바로 지정할 수 있습니다.
- QuickAdd/이슈 수정 창에서 담당자·기간·상태·우선순위 칩 위에 마우스 휠로 값을 바로 바꿀 수 있습니다.
```

- [ ] **Step 2: Confirm it landed in Task 2's commit**

This bullet is committed together with `src/quickadd/main.ts` in Task 2 Step 5 (`git add src/quickadd/main.ts CHANGELOG.md`) — do not create a separate commit for the changelog line alone. If Task 2 was already committed before this task ran, amend is not an option per the git safety protocol; instead make this a small follow-up commit `git add CHANGELOG.md && git commit -m "docs: note quickadd wheel-cycle in changelog"` instead.

---

## Self-Review Notes

- **Spec coverage:** interaction model (Task 1's threshold/direction + Tasks 2/3's `preventDefault`/wrap), scope table (Task 2 = QuickAdd all 5 fields, Task 3 = EditModal all 5 fields with the assignee guard, sidebar untouched), architecture (shared helper in Task 1, per-surface wiring in Tasks 2/3, `shiftDateField` ported to EditModal in Task 3), edge cases (date-range guard reused as-is, resize-on-render already implicit in `renderChips()`, EditModal multi-assignee guard) are all covered.
- **Placeholder scan:** no TBD/TODO; every step has literal code or literal shell commands.
- **Type consistency:** `attachWheelCycle(el: HTMLElement, getLength: () => number, onStep: (delta: 1 | -1) => void)` is the same signature used identically in Tasks 2 and 3. `PRIORITY_ORDER`/`STATE_ORDER` typed as `Priority[]`/`StateGroup[]` per `src/shared/planeIcons.ts:4-5`, matching the `priority`/`stateGroup` variable types already declared in both `quickadd/main.ts` and `editmodal/main.ts`.
