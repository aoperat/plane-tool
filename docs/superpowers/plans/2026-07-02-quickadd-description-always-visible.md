# QuickAdd Description Always-Visible Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove QuickAdd's description toggle button and make the description textarea always visible, starting at one row and auto-growing as the user types.

**Architecture:** Delete the toggle button, its icon, its CSS, and all `descriptionOpen`/toggle-related JS from `src/quickadd/main.ts` (Task 1) so the textarea is a plain always-rendered element with no open/closed state. Then add a small `autoResizeDescription()` helper that resizes the textarea to fit its content on every `input` event and reuse it in `resetFields()` and on startup (Task 2). No backend changes — `description_html` wiring from the prior QuickAdd description work is untouched.

**Tech Stack:** TypeScript (Vite), plain DOM manipulation matching existing `src/quickadd/main.ts` style (module-level `let`s, direct element refs, no reactivity), no jsdom test harness for this file.

## Global Constraints

- No new UI framework or state library — plain DOM manipulation matching the existing `src/quickadd/main.ts` style.
- `src/quickadd/main.ts` has no automated test harness (no jsdom in `vite.config.ts`) — verify via `pnpm exec tsc --noEmit` and a manual run-through, consistent with existing project convention. If you can't drive the real QuickAdd popup in this environment, say so explicitly rather than claiming you verified it.
- Description does **not** persist across popup close/reopen — it resets whenever the other fields reset (submit success, or `tauri://focus`), per the existing `resetFields()` policy. This plan does not change that policy.
- No backend/Rust changes in this plan — `NewWorkItem.description_html`, `plain_text_to_description_html`, and the `create_issue` command signature are unaffected.
- Spec: `docs/superpowers/specs/2026-07-02-quickadd-description-always-visible-design.md`.

---

### Task 1: Remove the description toggle — textarea always visible

**Files:**
- Modify: `src/quickadd/index.html`
- Modify: `src/shared/app.css`
- Modify: `src/shared/planeIcons.ts`
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Consumes: none (pure removal).
- Produces: `#description` textarea always present in the DOM with no `hidden` attribute and no `#descToggle` button. Task 2 builds on this by making the textarea auto-grow from one row.

No automated test for this task (pure markup/CSS/logic removal, no new behavior). Verify with `pnpm exec tsc --noEmit` and by visually confirming in a manual run-through that the description textarea is visible immediately when QuickAdd opens, with no toggle button next to the title.

- [ ] **Step 1: Remove the toggle button from the markup**

In `src/quickadd/index.html`, change:

```html
      <div class="popup-top">
        <div class="accent-bar"></div>
        <input id="title" class="title-input" placeholder="진행 중인 작업을 입력하고 Enter…" autofocus />
        <button type="button" class="icon-btn desc-toggle" id="descToggle" tabindex="-1" title="설명 추가"></button>
      </div>
      <textarea id="description" class="description-input" placeholder="설명을 입력하세요…" rows="3" hidden></textarea>
      <div class="chip-row" id="chipRow">
```

to:

```html
      <div class="popup-top">
        <div class="accent-bar"></div>
        <input id="title" class="title-input" placeholder="진행 중인 작업을 입력하고 Enter…" autofocus />
      </div>
      <textarea id="description" class="description-input" placeholder="설명을 입력하세요…" rows="3"></textarea>
      <div class="chip-row" id="chipRow">
```

- [ ] **Step 2: Remove the toggle button's CSS**

In `src/shared/app.css`, change:

```css
.desc-toggle { color: var(--muted-2); }
.desc-toggle:hover { color: var(--text); }
.desc-toggle.active { color: var(--accent); }
.description-input {
  display: block; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--text); font-size: 13px; font-family: inherit;
  padding: 0 18px 12px;
}
.description-input::placeholder { color: var(--muted-2); }
.description-input[hidden] { display: none; }
```

to:

```css
.description-input {
  display: block; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--text); font-size: 13px; font-family: inherit;
  padding: 0 18px 12px;
}
.description-input::placeholder { color: var(--muted-2); }
```

(`.icon-btn` itself is left untouched — `src/sidebar/main.ts` still uses that class for its own icon buttons.)

- [ ] **Step 3: Remove the now-unused icon**

In `src/shared/planeIcons.ts`, change:

```ts
export const EXTERNAL_LINK_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

export const DESCRIPTION_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="3" y1="18" x2="13" y2="18"/></svg>`;

// Priority icon shapes: lucide-static v1.22.0 (ISC license) — AlertCircle, SignalHigh,
```

to:

```ts
export const EXTERNAL_LINK_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a909c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

// Priority icon shapes: lucide-static v1.22.0 (ISC license) — AlertCircle, SignalHigh,
```

- [ ] **Step 4: Drop the `DESCRIPTION_ICON` import and the toggle element refs**

In `src/quickadd/main.ts`, change:

```ts
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
```

to:

```ts
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
```

Then change:

```ts
const fieldPopover = document.getElementById("fieldPopover")!;
const descToggle = document.getElementById("descToggle")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
descToggle.innerHTML = DESCRIPTION_ICON;
```

to:

```ts
const fieldPopover = document.getElementById("fieldPopover")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
```

- [ ] **Step 5: Drop the `descriptionOpen` state variable**

In `src/quickadd/main.ts`, change:

```ts
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";
let descriptionOpen = false;
```

to:

```ts
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";
```

- [ ] **Step 6: Remove the toggle open/close functions**

In `src/quickadd/main.ts`, change:

```ts
function updateDescToggleActive() {
  descToggle.classList.toggle("active", descriptionOpen || descriptionEl.value.trim().length > 0);
}

function setDescriptionOpen(open: boolean) {
  descriptionOpen = open;
  descriptionEl.hidden = !open;
  updateDescToggleActive();
  resizeToFit();
  if (open) descriptionEl.focus();
}

descToggle.onclick = () => setDescriptionOpen(!descriptionOpen);
descriptionEl.addEventListener("input", updateDescToggleActive);

function closePopover() {
```

to:

```ts
function closePopover() {
```

- [ ] **Step 7: Stop resetting the (now nonexistent) open/closed state**

In `src/quickadd/main.ts`, change:

```ts
  descriptionEl.value = "";
  setDescriptionOpen(false);
  closePopover();
  renderChips();
```

to:

```ts
  descriptionEl.value = "";
  resizeToFit();
  closePopover();
  renderChips();
```

- [ ] **Step 8: Remove the Tab-to-expand interception**

In `src/quickadd/main.ts`, change:

```ts
titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    await win.hide();
    return;
  }
  if (e.key === "Tab" && !e.shiftKey && !openPopover && !descriptionOpen) {
    e.preventDefault();
    setDescriptionOpen(true);
    return;
  }
  if (!openPopover && (e.key === "[" || e.key === "]")) {
```

to:

```ts
titleEl.addEventListener("keydown", async (e) => {
  titleEl.classList.remove("error");
  if (e.key === "Escape") {
    if (openPopover) { closePopover(); return; }
    if (!dropdown.hidden) { dropdown.hidden = true; return; }
    await win.hide();
    return;
  }
  if (!openPopover && (e.key === "[" || e.key === "]")) {
```

- [ ] **Step 9: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Manual verification**

Run `pnpm tauri dev`, open QuickAdd. Expected:
- The description textarea is visible immediately below the title, with no toggle button next to the title.
- Typing in the title and pressing Tab moves focus to the description textarea (native browser tab order, no custom interception).
- Ctrl+Enter from either the title or the description still submits the issue; Enter alone in the description still just inserts a newline.
- After a successful submit (or refocusing QuickAdd via its shortcut), the description textarea is empty again.

If you can't drive the real QuickAdd popup in this environment, say so explicitly rather than claiming you verified it.

- [ ] **Step 11: Commit**

```bash
git add src/quickadd/index.html src/shared/app.css src/shared/planeIcons.ts src/quickadd/main.ts
git commit -m "feat(quickadd): remove description toggle, textarea always visible"
```

---

### Task 2: Auto-grow the description textarea from one row

**Files:**
- Modify: `src/quickadd/index.html`
- Modify: `src/shared/app.css`
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Consumes: `#description` textarea and `resizeToFit()` (Task 1 / existing `main.ts`).
- Produces: none consumed by other tasks — this is the final task in this plan.

No automated test for this task (pure DOM sizing logic, no jsdom harness — confirmed existing convention). Verify via `pnpm exec tsc --noEmit` and a manual run-through; if you can't drive the real QuickAdd popup in this environment, say so explicitly rather than claiming you verified it.

- [ ] **Step 1: Start the textarea at one row**

In `src/quickadd/index.html`, change:

```html
      <textarea id="description" class="description-input" placeholder="설명을 입력하세요…" rows="3"></textarea>
```

to:

```html
      <textarea id="description" class="description-input" placeholder="설명을 입력하세요…" rows="1"></textarea>
```

- [ ] **Step 2: Hide the scrollbar flash during auto-grow**

In `src/shared/app.css`, change:

```css
.description-input {
  display: block; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--text); font-size: 13px; font-family: inherit;
  padding: 0 18px 12px;
}
```

to:

```css
.description-input {
  display: block; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--text); font-size: 13px; font-family: inherit;
  padding: 0 18px 12px; overflow: hidden;
}
```

- [ ] **Step 3: Add the auto-resize function and wire it to `input`**

In `src/quickadd/main.ts`, change:

```ts
function closePopover() {
```

to:

```ts
function autoResizeDescription() {
  descriptionEl.style.height = "auto";
  descriptionEl.style.height = `${descriptionEl.scrollHeight}px`;
  resizeToFit();
}

descriptionEl.addEventListener("input", autoResizeDescription);

function closePopover() {
```

- [ ] **Step 4: Reset the height along with the value**

In `src/quickadd/main.ts`, change:

```ts
  descriptionEl.value = "";
  resizeToFit();
  closePopover();
  renderChips();
```

to:

```ts
  descriptionEl.value = "";
  autoResizeDescription();
  closePopover();
  renderChips();
```

- [ ] **Step 5: Set the correct initial height on startup**

In `src/quickadd/main.ts`, change:

```ts
renderChips();
resizeToFit();
load();
```

to:

```ts
renderChips();
autoResizeDescription();
load();
```

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

Run `pnpm tauri dev`, open QuickAdd. Expected:
- The description textarea starts at a single line's height.
- Typing multiple lines into the description grows the textarea to fit, and the popup window itself grows to match (no internal scrollbar appears in the textarea).
- Deleting lines shrinks the textarea back down.
- After a successful submit (or refocusing QuickAdd via its shortcut), the description is cleared and its height returns to a single line.

If you can't drive the real QuickAdd popup in this environment, say so explicitly rather than claiming you verified it.

- [ ] **Step 8: Commit**

```bash
git add src/quickadd/index.html src/shared/app.css src/quickadd/main.ts
git commit -m "feat(quickadd): auto-grow description textarea from one row"
```
