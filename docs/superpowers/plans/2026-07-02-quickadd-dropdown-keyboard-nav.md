# QuickAdd Dropdown Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every `.dd-item`-based dropdown in QuickAdd (5 field chips + project selector) be fully keyboard-operable: arrow keys move between items, Enter selects the highlighted one, Escape closes.

**Architecture:** Three small container-agnostic helper functions (`initKeyboardFocus`, `moveKeyboardFocus`, `selectKeyboardFocus`) plus a keydown-handler factory (`handleDropdownKeydown`) that wraps them. Attached as a `keydown` listener on each trigger button (not the popover itself, since focus never leaves the trigger button). Selection reuses each item's existing `onclick` via a synthetic `.click()` — no per-dropdown select logic duplicated.

**Tech Stack:** TypeScript (Vite, vitest), plain DOM (no framework).

## Global Constraints

- No new UI framework or state library — plain DOM manipulation matching the existing `src/quickadd/main.ts` style.
- The date popover's trailing `<input type="date">` is excluded from the arrow-key cycle — only reachable via Tab, as today (native date inputs already use arrow keys to adjust their own value).
- `src/quickadd/main.ts` has no automated test harness (no jsdom in `vite.config.ts`) — verify via `pnpm exec tsc --noEmit` and a manual run-through, consistent with existing project convention.
- Spec: `docs/superpowers/specs/2026-07-02-quickadd-dropdown-keyboard-nav-design.md`.

---

### Task 1: Keyboard-navigation helpers, CSS, and the 5 field-chip dropdowns

**Files:**
- Modify: `src/shared/app.css`
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Produces: `initKeyboardFocus(container: HTMLElement)`, `moveKeyboardFocus(container: HTMLElement, delta: 1 | -1)`, `selectKeyboardFocus(container: HTMLElement)`, `handleDropdownKeydown(container: HTMLElement, isOpen: () => boolean, onClose: () => void): (e: KeyboardEvent) => void` — Task 2 reuses `handleDropdownKeydown` for the project dropdown.

No automated test for this task (no jsdom harness for `main.ts`, confirmed existing convention). Verify via `pnpm exec tsc --noEmit` plus a manual run-through — state explicitly if you can't drive the real QuickAdd popup in this environment, don't claim you verified it.

- [ ] **Step 1: Add the `.kbd-focus` CSS rule**

In `src/shared/app.css`, change:

```css
.dd-item .dot { width: 9px; height: 9px; border-radius: 50%; }
```

to:

```css
.dd-item .dot { width: 9px; height: 9px; border-radius: 50%; }
.dd-item.kbd-focus { outline: 1px solid var(--accent); outline-offset: -1px; }
```

- [ ] **Step 2: Add the keyboard-navigation helpers**

In `src/quickadd/main.ts`, change:

```ts
function closePopover() {
  openPopover = null;
  fieldPopover.hidden = true;
  fieldPopover.innerHTML = "";
  resizeToFit();
}

function toggleAssignee(id: string | null) {
```

to:

```ts
function closePopover() {
  openPopover = null;
  fieldPopover.hidden = true;
  fieldPopover.innerHTML = "";
  resizeToFit();
}

/** Puts the keyboard cursor on `container`'s current `.sel` item, or its first item if none is selected. */
function initKeyboardFocus(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  items.forEach((el) => el.classList.remove("kbd-focus"));
  const current = items.find((el) => el.classList.contains("sel")) ?? items[0];
  current?.classList.add("kbd-focus");
}

/** Moves the keyboard cursor to the next/previous `.dd-item` in `container`, wrapping at either end. */
function moveKeyboardFocus(container: HTMLElement, delta: 1 | -1) {
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
function selectKeyboardFocus(container: HTMLElement) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(".dd-item"));
  items.find((el) => el.classList.contains("kbd-focus"))?.click();
}

/** Builds a keydown handler for a dropdown trigger button: arrow keys move, Enter selects, Escape closes.
 *  Does nothing (and doesn't call preventDefault) while `isOpen()` is false, so the trigger button's own
 *  native Enter-activates-click behavior still opens the dropdown as before. */
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

function toggleAssignee(id: string | null) {
```

- [ ] **Step 3: Initialize keyboard focus in `renderAssigneePopoverItems`**

In `src/quickadd/main.ts`, change:

```ts
function renderAssigneePopoverItems() {
  fieldPopover.innerHTML = "";
  const selfItem = document.createElement("div");
  selfItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  selfItem.textContent = "나 (기본값)";
  selfItem.onclick = () => toggleAssignee(null);
  fieldPopover.appendChild(selfItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
    fieldPopover.appendChild(item);
  }
}
```

to:

```ts
function renderAssigneePopoverItems() {
  fieldPopover.innerHTML = "";
  const selfItem = document.createElement("div");
  selfItem.className = "dd-item" + (assigneeIds.length === 0 ? " sel" : "");
  selfItem.textContent = "나 (기본값)";
  selfItem.onclick = () => toggleAssignee(null);
  fieldPopover.appendChild(selfItem);
  for (const m of members) {
    const item = document.createElement("div");
    item.className = "dd-item" + (assigneeIds.includes(m.id) ? " sel" : "");
    item.textContent = m.display_name;
    item.onclick = () => toggleAssignee(m.id);
    fieldPopover.appendChild(item);
  }
  initKeyboardFocus(fieldPopover);
}
```

(This function is called both when the assignee dropdown first opens and every time an assignee is toggled, so the keyboard cursor stays in sync automatically in both cases.)

- [ ] **Step 4: Initialize keyboard focus in `openDatePopover`**

In `src/quickadd/main.ts`, change:

```ts
  fieldPopover.appendChild(dateInput);
  fieldPopover.hidden = false;
  openPopover = kind;
  resizeToFit();
}
```

to:

```ts
  fieldPopover.appendChild(dateInput);
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = kind;
  resizeToFit();
}
```

- [ ] **Step 5: Initialize keyboard focus in `openPriorityPopover`**

In `src/quickadd/main.ts`, change:

```ts
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = "priority";
  resizeToFit();
}
```

to:

```ts
    item.onclick = () => {
      priority = p;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = "priority";
  resizeToFit();
}
```

- [ ] **Step 6: Initialize keyboard focus in `openStatePopover`**

In `src/quickadd/main.ts`, change:

```ts
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  fieldPopover.hidden = false;
  openPopover = "state";
  resizeToFit();
}
```

to:

```ts
    item.onclick = () => {
      stateGroup = g;
      renderChips();
      closePopover();
      titleEl.focus();
    };
    fieldPopover.appendChild(item);
  }
  initKeyboardFocus(fieldPopover);
  fieldPopover.hidden = false;
  openPopover = "state";
  resizeToFit();
}
```

- [ ] **Step 7: Wire the keydown handler to the 5 chip buttons**

In `src/quickadd/main.ts`, change:

```ts
chipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
chipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
chipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
chipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
chipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };
```

to:

```ts
chipAssignee.onclick = () => { openPopover === "assignee" ? closePopover() : openAssigneePopover(); };
chipStart.onclick = () => { openPopover === "start" ? closePopover() : openDatePopover("start"); };
chipDue.onclick = () => { openPopover === "due" ? closePopover() : openDatePopover("due"); };
chipPriority.onclick = () => { openPopover === "priority" ? closePopover() : openPriorityPopover(); };
chipState.onclick = () => { openPopover === "state" ? closePopover() : openStatePopover(); };

const fieldPopoverKeydown = handleDropdownKeydown(fieldPopover, () => openPopover !== null, closePopover);
chipAssignee.addEventListener("keydown", fieldPopoverKeydown);
chipStart.addEventListener("keydown", fieldPopoverKeydown);
chipDue.addEventListener("keydown", fieldPopoverKeydown);
chipPriority.addEventListener("keydown", fieldPopoverKeydown);
chipState.addEventListener("keydown", fieldPopoverKeydown);
```

- [ ] **Step 8: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual verification**

Run `pnpm tauri dev`, open QuickAdd, select a project with at least one other member. For each of 담당자/시작일/마감일/우선순위/진행상태:
- Tab to the chip, press Enter to open it — the currently selected item should already show the accent outline (`.kbd-focus`).
- Press ArrowDown/ArrowUp repeatedly — the outline should move between items and wrap around at both ends.
- Press Enter — the highlighted item should be applied exactly as a mouse click would (assignee toggles and stays open; date/priority/state apply and close).
- Press Escape while open — it should close without applying anything.
- Confirm chip buttons still open via mouse click and Enter as before (no regression).

- [ ] **Step 10: Commit**

```bash
git add src/shared/app.css src/quickadd/main.ts
git commit -m "feat(quickadd): add keyboard navigation to field-chip dropdowns"
```

---

### Task 2: Wire keyboard navigation to the project-select dropdown

**Files:**
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Consumes: `handleDropdownKeydown` (Task 1).

Same verification approach as Task 1 (no automated test; `pnpm exec tsc --noEmit` + manual run-through).

- [ ] **Step 1: Initialize keyboard focus when the project dropdown opens**

In `src/quickadd/main.ts`, change:

```ts
projBtn.onclick = () => { dropdown.hidden = !dropdown.hidden; };
```

to:

```ts
projBtn.onclick = () => {
  dropdown.hidden = !dropdown.hidden;
  if (!dropdown.hidden) initKeyboardFocus(dropdown);
};
projBtn.addEventListener(
  "keydown",
  handleDropdownKeydown(dropdown, () => !dropdown.hidden, () => { dropdown.hidden = true; }),
);
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run `pnpm tauri dev`, open QuickAdd with more than one project configured. Tab to the project-select button, press Enter to open it, then ArrowDown/ArrowUp to move between projects, Enter to select one (should apply and close, matching a mouse click), and Escape to close without selecting.

- [ ] **Step 4: Commit**

```bash
git add src/quickadd/main.ts
git commit -m "feat(quickadd): add keyboard navigation to the project-select dropdown"
```
