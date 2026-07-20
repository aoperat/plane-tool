# Sidebar In-Progress Task Border Beam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sidebar task cards whose `state_group` is `"started"` (진행 중) a subtle traveling light effect along their border, so the user can spot in-progress work at a glance while scrolling the list.

**Architecture:** A CSS-only visual effect. `renderTaskRow()` in `src/sidebar/main.ts` adds an `in-progress` class to the task's root `<div class="task">` when `it.state_group === "started"`. `src/shared/app.css` defines `.task.in-progress::before` as a small blurred dot animated along the card's own rounded-rect border via `offset-path: border-box` / `offset-distance`, plus a static `prefers-reduced-motion` fallback.

**Tech Stack:** Vanilla TypeScript, Vite, plain CSS (no preprocessor, no CSS-in-JS). No test runner touches `src/sidebar/main.ts` or `src/shared/app.css` today (no jsdom harness) — verification for this plan is manual, in the running app.

Spec: [[2026-07-08-sidebar-in-progress-border-beam-design]] (`docs/superpowers/specs/2026-07-08-sidebar-in-progress-border-beam-design.md`)

## Global Constraints

- Effect applies only when `state_group === "started"` — no other condition (priority, due date, etc.) triggers it.
- Must use `offset-path` / `offset-distance` animation (compositor-only, no per-frame repaint), not an animated `conic-gradient` custom property — cost must stay flat regardless of how many in-progress cards are visible at once.
- Must respect `prefers-reduced-motion: reduce`: no animation, static `box-shadow: inset 0 0 0 1px var(--accent-soft)` highlight instead (mirrors the existing `qa-submit-pulse` convention in `src/shared/app.css:179-184`).
- Must not visually conflict with `.task:hover` or `.task.completed` — `state_group` values are mutually exclusive per item, so `.in-progress` and `.completed` never co-occur on the same element, but hover must still look correct while `.in-progress` is animating.
- `pointer-events: none` on the beam pseudo-element so it never intercepts clicks meant for the card, its state button, or its chips.
- Colors come from existing theme tokens (`--accent`, `--accent-soft`) only — no new hardcoded colors, so both dark and light themes (`src/shared/app.css:1-37`) work automatically.
- User-visible change → add one Korean bullet to `CHANGELOG.md`'s `## [Unreleased]` `### 추가` section in the same commit as the code change, per this repo's `CLAUDE.md`.

---

### Task 1: Add the in-progress border beam effect

**Files:**
- Modify: `src/sidebar/main.ts:483` (the `el.className` assignment inside `renderTaskRow`)
- Modify: `src/shared/app.css:294-298` (immediately after the existing `.task` / `.task.completed` rules)
- Modify: `CHANGELOG.md:6` (`## [Unreleased]` section)

**Interfaces:**
- Consumes: `it.state_group` (`StateGroup`, already typed and available in `renderTaskRow`, `src/sidebar/main.ts:481`); existing CSS tokens `--accent`, `--accent-soft` (`src/shared/app.css:10-11` dark, `:30-31` light).
- Produces: nothing consumed by later tasks — this is the only task in the plan.

- [ ] **Step 1: Add the `in-progress` class in `renderTaskRow`**

In `src/sidebar/main.ts`, change:

```ts
function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task" + (it.state_group === "completed" ? " completed" : "");
```

to:

```ts
function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task"
    + (it.state_group === "completed" ? " completed" : "")
    + (it.state_group === "started" ? " in-progress" : "");
```

- [ ] **Step 2: Add the CSS effect**

In `src/shared/app.css`, immediately after the existing block:

```css
.task { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 8px; cursor: pointer; position: relative; }
.task:hover { background: var(--panel-2); }
.task.completed { opacity: 0.45; }
.task.completed:hover { opacity: 0.75; }
.task.completed .name { text-decoration: line-through; color: var(--muted); }
```

insert:

```css
.task.in-progress::before {
  content: "";
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  filter: blur(2px);
  opacity: 0.85;
  offset-path: border-box;
  animation: beam-travel 3.6s linear infinite;
  pointer-events: none;
}
@keyframes beam-travel {
  to { offset-distance: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .task.in-progress::before { display: none; }
  .task.in-progress { box-shadow: inset 0 0 0 1px var(--accent-soft); }
}
```

Resulting file order at that point: `.task`, `.task:hover`, `.task.completed`, `.task.completed:hover`, `.task.completed .name`, then the new `.task.in-progress::before` block, `@keyframes beam-travel`, and the `@media (prefers-reduced-motion: reduce)` block, before the existing `.task-top` rule continues.

- [ ] **Step 3: Run the build**

Run: `pnpm build`
Expected: builds without TypeScript or CSS errors.

- [ ] **Step 4: Manual verification**

Run: `pnpm dev`, open the sidebar with a project that has at least one task in each state (진행 중, 시작 전, 완료).

- Task(s) with state 진행 중 show a small blurred dot slowly traveling around the card's rounded border, looping continuously.
- Tasks in other states (시작 전, 완료, 백로그, 취소) show no beam.
- Switch the app between dark and light theme (existing theme toggle) — the beam color still reads as a subtle accent glow in both.
- Hover a 진행 중 card — the hover background (`--panel-2`) applies normally and the beam keeps animating on top without visual glitches.
- With zero tasks in 진행 중 state, confirm nothing renders differently (no stray beam, no console errors).
- In Windows Settings → Accessibility → Visual effects, turn off animation effects (this maps to `prefers-reduced-motion: reduce` in WebView2); reopen/refresh the sidebar and confirm 진행 중 cards show a static thin accent-colored inset border instead of the moving dot.

- [ ] **Step 5: Add the CHANGELOG bullet**

`CHANGELOG.md:6-8` currently reads:

```markdown
## [Unreleased]

## [0.1.10] - 2026-07-07
```

Change to:

```markdown
## [Unreleased]

### 추가

- 사이드바에서 진행 중인 작업 카드 테두리에 은은하게 도는 빛 효과가 표시됩니다.

## [0.1.10] - 2026-07-07
```

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/main.ts src/shared/app.css CHANGELOG.md
git commit -m "feat(sidebar): add border beam effect to in-progress task cards"
```

---

## Self-Review Notes

- **Spec coverage:** trigger condition (`state_group === "started"`, Step 1), `offset-path`/`offset-distance` compositor-only technique (Step 2, matches spec's "Design" section verbatim), theme-token-only colors (Step 2 uses only `--accent`/`--accent-soft`), `prefers-reduced-motion` static fallback (Step 2's `@media` block), `pointer-events: none` (Step 2), non-conflict with hover/completed (Step 4 manual checks), CHANGELOG rule (Step 5) are all covered. Spec's "Non-goals" (no intensity toggle, no other trigger conditions, no dedicated section) are respected by not adding anything beyond the single `.in-progress` class.
- **Placeholder scan:** no TBD/TODO; every step has literal code, literal CSS, or a literal shell command; manual verification steps list concrete observable checks rather than "test appropriately."
- **Type consistency:** `it.state_group` is compared against the same string literals (`"completed"`, `"started"`) already used elsewhere in `renderTaskRow` and matching `StateGroup` / `STATE_GROUPS` (`src/sidebar/main.ts:91`) — no new type introduced.
