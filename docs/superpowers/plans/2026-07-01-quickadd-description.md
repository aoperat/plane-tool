# QuickAdd Description Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, toggleable plain-text description field to QuickAdd, sent to Plane as `description_html` when creating an issue.

**Architecture:** A small toggle icon button next to the title input expands/collapses a 3-row `<textarea>` between the title row and the chip toolbar. The typed plain text is escaped and wrapped into `<p>` paragraphs on the Rust side (`plain_text_to_description_html`) and sent as `description_html` on the existing create-work-item POST. No rich text, no persistence across popup close/reopen.

**Tech Stack:** TypeScript (Vite, vitest), Rust (Tauri 2, reqwest, wiremock), pnpm.

## Global Constraints

- No new UI framework or state library — plain DOM manipulation matching the existing `src/quickadd/main.ts` style (module-level `let`s, direct element refs, no reactivity).
- Plain text only — no rich text editing (bold/lists/links). Line breaks become separate `<p>` paragraphs; that's the only formatting.
- Description does **not** persist across popup close/reopen — it resets whenever the other fields reset (submit success, or `tauri://focus`), per the existing `resetFields()` policy.
- `src/quickadd/main.ts` has no automated test harness (no jsdom in `vite.config.ts`) — verify via `pnpm exec tsc --noEmit` and a manual run-through, consistent with existing project convention.
- Rust: `NewWorkItem` is a plain struct with borrowed `&str` fields (no `Default`) — every existing struct-literal construction of it must be updated in the same commit that adds a field, or the crate won't compile. Task 2 does this atomically.
- Spec: `docs/superpowers/specs/2026-07-01-quickadd-description-design.md`.

---

### Task 1: `plain_text_to_description_html` pure function (Rust)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces: `plain_text_to_description_html(text: &str) -> String` — used by Task 2's `create_issue` command.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/plane_api.rs` (anywhere among the other `#[test]` functions, e.g. right after `resolve_state_id_finds_id_for_group`):

```rust
    #[test]
    fn plain_text_to_html_escapes_special_characters() {
        assert_eq!(
            plain_text_to_description_html("A & B <tag>"),
            "<p>A &amp; B &lt;tag&gt;</p>"
        );
    }

    #[test]
    fn plain_text_to_html_splits_multiline_input_into_paragraphs() {
        assert_eq!(
            plain_text_to_description_html("Line one\nLine two"),
            "<p>Line one</p><p>Line two</p>"
        );
    }

    #[test]
    fn plain_text_to_html_returns_empty_string_for_empty_input() {
        assert_eq!(plain_text_to_description_html(""), "");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test plain_text_to_html`
Expected: FAIL to compile — `plain_text_to_description_html` doesn't exist.

- [ ] **Step 3: Implement the function**

Add this to `src-tauri/src/plane_api.rs`, right after `resolve_state_id`:

```rust
/// Converts plain text (as typed into QuickAdd's description textarea) into the
/// minimal HTML Plane's `description_html` field expects: HTML-escape special
/// characters, then wrap each line in its own `<p>` paragraph. No rich text
/// (bold/lists/links) is supported — this is intentionally the only formatting.
pub fn plain_text_to_description_html(text: &str) -> String {
    text.lines()
        .map(|line| format!("<p>{}</p>", escape_html(line)))
        .collect::<Vec<_>>()
        .join("")
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test plain_text_to_html`
Expected: PASS — 3/3 new tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add plain_text_to_description_html converter"
```

---

### Task 2: Wire `description_html` through `NewWorkItem`, `create_work_item`, and the `create_issue` command (Rust)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `plain_text_to_description_html` (Task 1).
- Produces: `create_issue` Tauri command gains a new trailing parameter `description: Option<String>`. Frontend callers (Task 4) must pass this as their 8th argument.

This task must land as a single commit: adding a field to `NewWorkItem` breaks every existing struct-literal construction of it until each is updated, so the struct change and both call-site updates (the existing test, and the real `create_issue` caller) can't be split across commits without an intermediate non-compiling state.

- [ ] **Step 1: Add `description_html` to `NewWorkItem`**

In `src-tauri/src/plane_api.rs`, change:

```rust
pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
}
```

to:

```rust
pub struct NewWorkItem<'a> {
    pub name: &'a str,
    pub assignee_ids: &'a [String],
    pub start_date: Option<&'a str>,
    pub target_date: Option<&'a str>,
    pub priority: &'a str,
    pub state_id: &'a str,
    pub description_html: Option<&'a str>,
}
```

- [ ] **Step 2: Send it in `create_work_item`'s request body**

In `src-tauri/src/plane_api.rs`, change:

```rust
            .json(&serde_json::json!({
                "name": item.name,
                "assignees": item.assignee_ids,
                "start_date": item.start_date,
                "target_date": item.target_date,
                "priority": item.priority,
                "state": item.state_id,
            }))
```

to:

```rust
            .json(&serde_json::json!({
                "name": item.name,
                "assignees": item.assignee_ids,
                "start_date": item.start_date,
                "target_date": item.target_date,
                "priority": item.priority,
                "state": item.state_id,
                "description_html": item.description_html,
            }))
```

- [ ] **Step 3: Update the existing wiremock test and add a null-description test**

In `src-tauri/src/plane_api.rs`, change the `create_work_item_sends_all_fields` test:

```rust
    #[tokio::test]
    async fn create_work_item_sends_all_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "start_date": "2026-07-01",
                "target_date": "2026-07-02",
                "priority": "high",
                "state": "state-1"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: Some("2026-07-01"),
            target_date: Some("2026-07-02"),
            priority: "high",
            state_id: "state-1",
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }
```

to:

```rust
    #[tokio::test]
    async fn create_work_item_sends_all_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "start_date": "2026-07-01",
                "target_date": "2026-07-02",
                "priority": "high",
                "state": "state-1",
                "description_html": "<p>World</p>"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: Some("2026-07-01"),
            target_date: Some("2026-07-02"),
            priority: "high",
            state_id: "state-1",
            description_html: Some("<p>World</p>"),
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }

    #[tokio::test]
    async fn create_work_item_sends_null_description_when_absent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/"))
            .and(header("X-Api-Key", "secret-key"))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "name": "Hello",
                "assignees": ["me"],
                "start_date": null,
                "target_date": null,
                "priority": "none",
                "state": "state-1",
                "description_html": null
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let item = NewWorkItem {
            name: "Hello",
            assignee_ids: &["me".to_string()],
            start_date: None,
            target_date: None,
            priority: "none",
            state_id: "state-1",
            description_html: None,
        };
        client_for(&server).await.create_work_item("p1", &item).await.unwrap();
    }
```

- [ ] **Step 4: Run the plane_api tests**

Run: `cd src-tauri && cargo test --lib plane_api`
Expected: PASS, including the updated and new tests.

- [ ] **Step 5: Add `description` to the `create_issue` command**

In `src-tauri/src/commands.rs`, change the import line:

```rust
use crate::plane_api::{filter_assigned_visible, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
```

to:

```rust
use crate::plane_api::{filter_assigned_visible, plain_text_to_description_html, resolve_state_id, NewWorkItem, PlaneClient, Project, ProjectState, WorkItem};
```

Then change `create_issue`:

```rust
#[tauri::command]
pub async fn create_issue(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    assignee_ids: Vec<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: String,
    state_group: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids
    };
    let states = client.list_states(&project_id).await?;
    let state_id = resolve_state_id(&states, &state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let item = NewWorkItem {
        name: name.trim(),
        assignee_ids: &assignees,
        start_date: start_date.as_deref(),
        target_date: target_date.as_deref(),
        priority: &priority,
        state_id: &state_id,
    };
    client.create_work_item(&project_id, &item).await?;
    config::set_last_project(&app, &project_id)?;
    Ok(())
}
```

to:

```rust
#[tauri::command]
pub async fn create_issue(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    assignee_ids: Vec<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: String,
    state_group: String,
    description: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let assignees = if assignee_ids.is_empty() {
        let user = client.current_user().await?;
        vec![user.id]
    } else {
        assignee_ids
    };
    let states = client.list_states(&project_id).await?;
    let state_id = resolve_state_id(&states, &state_group)
        .ok_or_else(|| format!("no state found for group '{state_group}'"))?;
    let description_html = description
        .filter(|d| !d.is_empty())
        .map(|d| plain_text_to_description_html(&d));
    let item = NewWorkItem {
        name: name.trim(),
        assignee_ids: &assignees,
        start_date: start_date.as_deref(),
        target_date: target_date.as_deref(),
        priority: &priority,
        state_id: &state_id,
        description_html: description_html.as_deref(),
    };
    client.create_work_item(&project_id, &item).await?;
    config::set_last_project(&app, &project_id)?;
    Ok(())
}
```

- [ ] **Step 6: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests (no test exists for the thin `create_issue` command itself — consistent with the existing convention that only `PlaneClient` methods and pure functions get direct tests, not thin command wrappers).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs
git commit -m "feat: wire description_html through create_issue"
```

---

### Task 3: Description toggle UI scaffolding — icon, markup, styles

**Files:**
- Modify: `src/shared/planeIcons.ts`
- Modify: `src/quickadd/index.html`
- Modify: `src/shared/app.css`

**Interfaces:**
- Produces: a `#descToggle` button (left empty — no icon rendered yet) and a `#description` textarea in the DOM, both non-functional until Task 4 wires up behavior. `DESCRIPTION_ICON` exported from `planeIcons.ts` — Task 4 imports it and sets `descToggle.innerHTML` to actually render it.

No automated test for this task (pure markup/CSS/icon addition, no logic). Verify with `pnpm exec tsc --noEmit` (icons.ts still compiles) and by visually confirming in a manual run-through once Task 4 makes it interactive — this task alone won't do anything when clicked yet, so don't expect toggling to work until Task 4 lands.

- [ ] **Step 1: Add `DESCRIPTION_ICON` to `planeIcons.ts`**

In `src/shared/planeIcons.ts`, add this after the existing `FLAG_ICON` constant:

```ts
export const DESCRIPTION_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><line x1="3" y1="18" x2="13" y2="18"/></svg>`;
```

(Unlike `CALENDAR_ICON`/`FLAG_ICON`, which hardcode `stroke="#8a909c"`, this uses `stroke="currentColor"` so the toggle button's CSS `color` can drive its highlighted/active look — see Step 3.)

- [ ] **Step 2: Add the toggle button and textarea to `index.html`**

In `src/quickadd/index.html`, change:

```html
      <div class="popup-top">
        <div class="accent-bar"></div>
        <input id="title" class="title-input" placeholder="진행 중인 작업을 입력하고 Enter…" autofocus />
      </div>
      <div class="chip-row" id="chipRow">
```

to:

```html
      <div class="popup-top">
        <div class="accent-bar"></div>
        <input id="title" class="title-input" placeholder="진행 중인 작업을 입력하고 Enter…" autofocus />
        <button type="button" class="icon-btn desc-toggle" id="descToggle" tabindex="-1" title="설명 추가"></button>
      </div>
      <textarea id="description" class="description-input" placeholder="설명을 입력하세요…" rows="3" hidden></textarea>
      <div class="chip-row" id="chipRow">
```

- [ ] **Step 3: Add styles to `app.css`**

In `src/shared/app.css`, change:

```css
.title-input::placeholder { color: var(--muted-2); }
.title-input.error { color: var(--red); }
```

to:

```css
.title-input::placeholder { color: var(--muted-2); }
.title-input.error { color: var(--red); }
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

(The `[hidden]` rule is required: setting `display: block` in an author stylesheet on `.description-input` would otherwise override the browser's default `[hidden] { display: none }` UA rule, since author-origin rules beat UA-origin rules at equal specificity regardless of source order.)

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/planeIcons.ts src/quickadd/index.html src/shared/app.css
git commit -m "feat(quickadd): add description toggle button and textarea markup"
```

---

### Task 4: Wire up description behavior (toggle, keyboard, reset, submit)

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/quickadd/main.ts`

**Interfaces:**
- Consumes: `#descToggle`/`#description` elements (Task 3), `create_issue` command's new `description` param (Task 2).
- Produces: none consumed by other tasks — this is the final integration task.

No automated test for `main.ts` (no jsdom harness, confirmed existing convention). Verify via `pnpm exec tsc --noEmit` and, if possible, a manual run-through; if you can't drive the real QuickAdd popup in this environment, say so explicitly rather than claiming you verified it.

- [ ] **Step 1: Widen `createIssue` in `ipc.ts`**

In `src/shared/ipc.ts`, change:

```ts
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string | undefined,
  target_date: string | undefined,
  priority: string,
  state_group: string,
) =>
  invoke<void>("create_issue", {
    projectId: project_id,
    name,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
  });
```

to:

```ts
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string | undefined,
  target_date: string | undefined,
  priority: string,
  state_group: string,
  description: string,
) =>
  invoke<void>("create_issue", {
    projectId: project_id,
    name,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
    description,
  });
```

- [ ] **Step 2: Import the icon, add element refs, render the icon, and add state to `main.ts`**

In `src/quickadd/main.ts`, change:

```ts
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
```

to:

```ts
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../shared/planeIcons";
```

Then change:

```ts
const fieldPopover = document.getElementById("fieldPopover")!;
```

to:

```ts
const fieldPopover = document.getElementById("fieldPopover")!;
const descToggle = document.getElementById("descToggle")!;
const descriptionEl = document.getElementById("description") as HTMLTextAreaElement;
descToggle.innerHTML = DESCRIPTION_ICON;
```

(Task 3 left `#descToggle` as an empty `<button>` — this last line is what actually renders its icon, matching how `CALENDAR_ICON`/`FLAG_ICON` are rendered into chips via `innerHTML` elsewhere in this file rather than being inlined into the static HTML.)

Then change:

```ts
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";
```

to:

```ts
let priority: Priority = "none";
let stateGroup: StateGroup = "unstarted";
let descriptionOpen = false;
```

- [ ] **Step 3: Add the toggle open/close logic**

Add this after `renderChips()` (right before `function closePopover()`):

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
```

- [ ] **Step 4: Extract a shared `submitIssue()` function and pass description**

In `src/quickadd/main.ts`, change:

```ts
  if (e.key === "Enter") {
    if (openPopover) return;
    const name = titleEl.value.trim();
    if (!name || !selectedId) return;
    try {
      await createIssue(
        selectedId,
        name,
        assigneeIds,
        resolveDateChoice(startChoice, startCustomDate),
        resolveDateChoice(dueChoice, dueCustomDate),
        priority,
        stateGroup,
      );
      titleEl.value = "";
      resetFields();
      await win.hide();
    } catch (err) {
      titleEl.classList.add("error");
      console.error(err);
    }
  }
});
```

to:

```ts
  if (e.key === "Enter") {
    if (openPopover) return;
    await submitIssue();
  }
});

descriptionEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    await submitIssue();
  }
});
```

Then add the extracted function above `titleEl.addEventListener("keydown", ...)` (right after `shiftDateField`, before `renderSelected`):

```ts
async function submitIssue() {
  const name = titleEl.value.trim();
  if (!name || !selectedId) return;
  try {
    await createIssue(
      selectedId,
      name,
      assigneeIds,
      resolveDateChoice(startChoice, startCustomDate),
      resolveDateChoice(dueChoice, dueCustomDate),
      priority,
      stateGroup,
      descriptionEl.value,
    );
    titleEl.value = "";
    resetFields();
    await win.hide();
  } catch (err) {
    titleEl.classList.add("error");
    console.error(err);
  }
}
```

- [ ] **Step 5: Add the Tab-to-expand interception**

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
  if (e.key === "Tab" && !descriptionOpen) {
    e.preventDefault();
    setDescriptionOpen(true);
    return;
  }
  if (!openPopover && (e.key === "[" || e.key === "]")) {
```

- [ ] **Step 6: Reset description with the other fields**

In `src/quickadd/main.ts`, change:

```ts
function resetFields() {
  assigneeIds = [];
  startChoice = "today";
  startCustomDate = "";
  dueChoice = "today";
  dueCustomDate = "";
  priority = "none";
  stateGroup = "unstarted";
  closePopover();
  renderChips();
}
```

to:

```ts
function resetFields() {
  assigneeIds = [];
  startChoice = "today";
  startCustomDate = "";
  dueChoice = "today";
  dueCustomDate = "";
  priority = "none";
  stateGroup = "unstarted";
  descriptionEl.value = "";
  setDescriptionOpen(false);
  closePopover();
  renderChips();
}
```

- [ ] **Step 7: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Manual verification**

Run `pnpm tauri dev`, open QuickAdd. Expected:
- Clicking the toggle icon next to the title expands a 3-row description textarea below the title row, and the popup grows to fit; clicking again collapses it.
- Pressing Tab in the title field while the description is collapsed expands it and moves focus into it (instead of moving to the next chip).
- Typing in the description makes the toggle icon turn accent-colored even after collapsing it again.
- Ctrl+Enter from either the title or the description submits the issue; Enter alone in the description just inserts a newline.
- After a successful submit (or refocusing QuickAdd via its shortcut), the description is cleared and collapsed again.

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/quickadd/main.ts
git commit -m "feat(quickadd): wire up description toggle, keyboard handling, and submit"
```
