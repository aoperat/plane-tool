# Sidebar Right-Click Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click context menu to sidebar issue rows with four actions: 복사본 만들기 (duplicate), 새 탭에서 열기 (open in browser), 링크 복사 (copy link), 삭제 (delete, with a confirm step).

**Architecture:** Reuse the sidebar's existing single-popover pattern (`openPopover`/`closePopover`, `.pop`/`.pop-item` CSS) for both the context menu itself and a follow-up delete-confirm popover. Duplicate and delete are new remote mutations; both refresh the full list via the existing `refresh()` function afterward rather than doing local list surgery. Delete needs one new backend method (`DELETE .../work-items/{id}/`) and one new Tauri command; duplicate reuses the existing `create_issue` command. Copy-link needs a new `tauri-plugin-clipboard-manager` dependency.

**Tech Stack:** TypeScript (Vite, vitest), Rust (Tauri 2, reqwest, wiremock for HTTP mocking), pnpm.

## Global Constraints

- No new UI framework or state library — keep the existing plain `let`/module-state + imperative DOM rebuild pattern in `src/sidebar/main.ts`.
- `src/sidebar/main.ts` has no automated tests (no jsdom in `vite.config.ts`) — only pure helpers in `src/sidebar/logic.ts` are unit-tested. New pure logic goes in `logic.ts` with tests; DOM wiring in `main.ts` is verified by `pnpm exec tsc --noEmit` plus a manual run-through (stated explicitly per task, not skipped).
- Rust command wrappers that just build a client and delegate to a `PlaneClient` method (e.g. `update_work_item_priority`) are untested by existing convention — only `PlaneClient` methods themselves get wiremock tests. Follow this: `delete_work_item` gets a wiremock test on the `PlaneClient` method; the thin `delete_work_item` Tauri command does not get its own test.
- Archive is explicitly out of scope (see spec) — do not add it.
- Spec: `docs/superpowers/specs/2026-07-01-sidebar-context-menu-design.md`.

---

### Task 1: Add `buildIssueUrl` pure helper to `logic.ts`

**Files:**
- Modify: `src/sidebar/logic.ts`
- Test: `src/sidebar/logic.test.ts`

**Interfaces:**
- Produces: `buildIssueUrl(baseUrl: string, workspace: string, projectId: string, itemId: string): string` — used by Task 2 (row click / open-in-browser) and Task 4 (copy link).

- [ ] **Step 1: Write the failing test**

Add to `src/sidebar/logic.test.ts`, after the `resolveStateId` import line update:

```ts
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, groupItemsByProject, resolveStateId } from "./logic";
```

(replace the existing import line that lists `computeSidebarGeometry, easeOutCubic, groupItemsByProject, resolveStateId`)

Then append at the end of the file:

```ts
describe("buildIssueUrl", () => {
  it("joins base url, workspace, project id and item id into a Plane issue url", () => {
    expect(buildIssueUrl("https://plane.example.com", "acme", "p1", "i1")).toBe(
      "https://plane.example.com/acme/projects/p1/issues/i1",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `buildIssueUrl` is not exported from `./logic`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/sidebar/logic.ts` (anywhere after the existing exports, e.g. after `resolveStateId`):

```ts
/** Builds the web URL for a Plane issue, matching the format used to open issues in the browser. */
export function buildIssueUrl(baseUrl: string, workspace: string, projectId: string, itemId: string): string {
  return `${baseUrl}/${workspace}/projects/${projectId}/issues/${itemId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (all existing `logic.test.ts` tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "feat(sidebar): add buildIssueUrl helper for issue URL construction"
```

---

### Task 2: Extract `openInBrowser` helper in `main.ts` (dedupe row click)

**Files:**
- Modify: `src/sidebar/main.ts:1-9` (imports), `src/sidebar/main.ts` (new function + row click site, currently lines 169-180)

**Interfaces:**
- Consumes: `buildIssueUrl` from Task 1.
- Produces: `openInBrowser(it: WorkItem): Promise<void>` — called by the row's own click handler here, and by the "새 탭에서 열기" menu item in Task 4.

This is a behavior-preserving refactor (no new logic), so there's no new automated test — verify via type-check and a manual smoke test.

- [ ] **Step 1: Update the logic.ts import**

In `src/sidebar/main.ts`, change:

```ts
import { computeSidebarGeometry, easeOutCubic, groupItemsByProject, resolveStateId } from "./logic";
```

to:

```ts
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, groupItemsByProject, resolveStateId } from "./logic";
```

- [ ] **Step 2: Add the `openInBrowser` helper**

Add this function above `renderTaskRow` (e.g. right after `openPriorityPopover`):

```ts
async function openInBrowser(it: WorkItem) {
  const url = buildIssueUrl(baseUrl, workspace, it.project_id, it.id);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the sidebar instead of behind it.
    await win.setAlwaysOnTop(false);
    await openUrl(url);
  } catch (err) {
    synced.textContent = "열기 실패: " + err;
    console.error("openUrl failed:", url, err);
  }
}
```

- [ ] **Step 3: Replace the row's inline click handler**

In `renderTaskRow`, replace:

```ts
  el.onclick = async () => {
    const url = `${baseUrl}/${workspace}/projects/${it.project_id}/issues/${it.id}`;
    try {
      // Drop always-on-top so the browser window we're about to open can
      // appear above the sidebar instead of behind it.
      await win.setAlwaysOnTop(false);
      await openUrl(url);
    } catch (err) {
      synced.textContent = "열기 실패: " + err;
      console.error("openUrl failed:", url, err);
    }
  };
```

with:

```ts
  el.onclick = () => openInBrowser(it);
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Run the app in dev mode (`pnpm tauri dev`), open the sidebar, click an issue row. Expected: browser opens to the same issue URL as before this change (unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/main.ts
git commit -m "refactor(sidebar): extract openInBrowser helper from row click handler"
```

---

### Task 3: Add `tauri-plugin-clipboard-manager` dependency

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`

No new logic yet — this task only wires up the dependency so Task 4 can import `writeText`.

- [ ] **Step 1: Add the JS package**

Run: `pnpm add @tauri-apps/plugin-clipboard-manager`
Expected: `package.json`'s `dependencies` gains an entry for `@tauri-apps/plugin-clipboard-manager`, and the lockfile updates.

- [ ] **Step 2: Add the Rust crate**

In `src-tauri/Cargo.toml`, add this line under `[dependencies]`, next to the other `tauri-plugin-*` entries:

```toml
tauri-plugin-clipboard-manager = "2"
```

- [ ] **Step 3: Register the plugin**

In `src-tauri/src/lib.rs`, change:

```rust
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
```

to:

```rust
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
```

- [ ] **Step 4: Grant the permission**

In `src-tauri/capabilities/default.json`, add `"clipboard-manager:allow-write-text"` to the `permissions` array, after the `opener:*` entries:

```json
    "opener:allow-open-url",
    "opener:allow-default-urls",
    "clipboard-manager:allow-write-text"
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors (may take a while on first run while it fetches the new crate).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "feat: add clipboard-manager plugin for copy-link support"
```

---

### Task 4: Context menu skeleton — 복사본 만들기, 새 탭에서 열기, 링크 복사

**Files:**
- Modify: `src/shared/ipc.ts`, `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `buildIssueUrl` (Task 1), `openInBrowser` (Task 2), `writeText` from `@tauri-apps/plugin-clipboard-manager` (Task 3).
- Produces: `openContextMenu(rowEl: HTMLElement, it: WorkItem, offsetX: number, offsetY: number): void` in `main.ts` — Task 7 (삭제 item) extends this same function.

No jsdom in this project, so this task has no automated UI test. Verify via `tsc` plus a manual run-through (explicitly required, not optional).

- [ ] **Step 1: Widen `createIssue`'s date parameters to optional**

In `src/shared/ipc.ts`, change:

```ts
export const createIssue = (
  project_id: string,
  name: string,
  assignee_ids: string[],
  start_date: string,
  target_date: string,
  priority: string,
  state_group: string,
) =>
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
) =>
```

(the body of the function is unchanged — QuickAdd's existing call site always passes concrete strings, which still satisfy `string | undefined`.)

- [ ] **Step 2: Import what's needed in `main.ts`**

Change:

```ts
import { fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

to:

```ts
import { createIssue, fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

Add a new import line right after the `openUrl` import:

```ts
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
```

- [ ] **Step 3: Add the action helpers**

Add these functions right after `openInBrowser` (from Task 2):

```ts
async function duplicateWorkItem(it: WorkItem) {
  try {
    // No assignee_ids on the frontend WorkItem type — an empty list makes
    // create_issue default to the current user, which is correct here since
    // the sidebar only ever lists items already assigned to the current user.
    await createIssue(it.project_id, it.name, [], undefined, it.target_date ?? undefined, it.priority, it.state_group);
    await refresh();
  } catch (err) {
    synced.textContent = "복사본 생성 실패: " + err;
    console.error("createIssue (duplicate) failed:", err);
  }
}

async function copyIssueLink(it: WorkItem) {
  const url = buildIssueUrl(baseUrl, workspace, it.project_id, it.id);
  try {
    await writeText(url);
    synced.textContent = "링크 복사됨";
  } catch (err) {
    synced.textContent = "링크 복사 실패: " + err;
    console.error("writeText failed:", err);
  }
}
```

- [ ] **Step 4: Add the context menu builder**

Add this function after `copyIssueLink`:

```ts
const CONTEXT_MENU_WIDTH = 180;

function openContextMenu(rowEl: HTMLElement, it: WorkItem, offsetX: number, offsetY: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";
  pop.style.left = Math.min(offsetX, rowEl.clientWidth - CONTEXT_MENU_WIDTH) + "px";
  pop.style.top = offsetY + "px";

  const addItem = (label: string, onClick: () => void) => {
    const opt = document.createElement("div");
    opt.className = "pop-item";
    opt.textContent = label;
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      onClick();
    };
    pop.appendChild(opt);
  };

  addItem("복사본 만들기", () => duplicateWorkItem(it));
  addItem("새 탭에서 열기", () => openInBrowser(it));
  addItem("링크 복사", () => copyIssueLink(it));

  rowEl.appendChild(pop);
  openPopover = pop;
}
```

- [ ] **Step 5: Wire the `contextmenu` event on rows**

In `renderTaskRow`, right after the `el.onclick = () => openInBrowser(it);` line, add:

```ts
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    openContextMenu(el, it, e.clientX - rect.left, e.clientY - rect.top);
  };
```

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

Run `pnpm tauri dev`, open the sidebar, right-click a row. Expected:
- A menu with "복사본 만들기", "새 탭에서 열기", "링크 복사" appears at the cursor.
- Clicking outside or pressing Escape closes it (existing global dismissal).
- "새 탭에서 열기" opens the same issue in the browser.
- "링크 복사" sets `synced` to "링크 복사됨"; paste somewhere to confirm the clipboard holds the issue URL.
- "복사본 만들기" creates a new issue with the same title/priority/state in the same project, then the list refreshes and shows it.

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/sidebar/main.ts
git commit -m "feat(sidebar): add right-click context menu with duplicate/open/copy-link"
```

---

### Task 5: `PlaneClient::delete_work_item` (Rust)

**Files:**
- Modify: `src-tauri/src/plane_api.rs`

**Interfaces:**
- Produces: `PlaneClient::delete_work_item(&self, project_id: &str, item_id: &str) -> Result<(), String>` — used by Task 6's `delete_work_item` Tauri command.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/plane_api.rs`, near `update_work_item_sends_patch_with_body`:

```rust
    #[tokio::test]
    async fn delete_work_item_sends_delete_request() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/workspaces/acme/projects/p1/work-items/i1/"))
            .and(header("X-Api-Key", "secret-key"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        client_for(&server).await.delete_work_item("p1", "i1").await.unwrap();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test delete_work_item_sends_delete_request`
Expected: FAIL to compile — `delete_work_item` doesn't exist on `PlaneClient`.

- [ ] **Step 3: Implement `delete_work_item`**

Add this method to `impl PlaneClient` in `src-tauri/src/plane_api.rs`, right after `update_work_item`:

```rust
    pub async fn delete_work_item(&self, project_id: &str, item_id: &str) -> Result<(), String> {
        let url = format!("{}/projects/{}/work-items/{}/", self.ws_base(), project_id, item_id);
        self.http
            .delete(&url)
            .header("X-Api-Key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test`
Expected: PASS — full suite, including the new test.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plane_api.rs
git commit -m "feat(plane_api): add delete_work_item client method"
```

---

### Task 6: `delete_work_item` Tauri command + ipc.ts wrapper

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/shared/ipc.ts`

**Interfaces:**
- Consumes: `PlaneClient::delete_work_item` (Task 5).
- Produces: `deleteWorkItem(project_id: string, item_id: string): Promise<void>` in `src/shared/ipc.ts` — used by Task 7.

Per the Global Constraints, this thin command wrapper follows the existing convention of `update_work_item_priority`/`update_work_item_state` and isn't separately unit-tested (the underlying client method already is, in Task 5).

- [ ] **Step 1: Add the Tauri command**

Add to `src-tauri/src/commands.rs`, right after `update_work_item_state`:

```rust
#[tauri::command]
pub async fn delete_work_item(app: tauri::AppHandle, project_id: String, item_id: String) -> Result<(), String> {
    let (client, _s) = client(&app)?;
    client.delete_work_item(&project_id, &item_id).await
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, change:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
            commands::update_work_item_priority,
            commands::update_work_item_state
        ])
```

to:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::create_issue,
            commands::fetch_sidebar_data,
            commands::list_projects,
            commands::list_members,
            commands::update_work_item_priority,
            commands::update_work_item_state,
            commands::delete_work_item
        ])
```

- [ ] **Step 3: Add the ipc.ts wrapper**

Add to `src/shared/ipc.ts`, after `updateWorkItemState`:

```ts
export const deleteWorkItem = (project_id: string, item_id: string) =>
  invoke<void>("delete_work_item", { projectId: project_id, itemId: item_id });
```

- [ ] **Step 4: Verify everything still builds**

Run: `cd src-tauri && cargo test` — expect PASS (no new Rust tests added in this task, just checking nothing broke).
Run: `pnpm exec tsc --noEmit` — expect no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/shared/ipc.ts
git commit -m "feat: add delete_work_item Tauri command and ipc wrapper"
```

---

### Task 7: Context menu — 삭제 with confirm popover

**Files:**
- Modify: `src/sidebar/main.ts`

**Interfaces:**
- Consumes: `deleteWorkItem` (Task 6), `openContextMenu`/`closePopover`/`openPopover` (Task 4 / existing).

No automated UI test (same reasoning as Task 4) — verify via `tsc` plus a manual run-through.

- [ ] **Step 1: Import `deleteWorkItem`**

Change:

```ts
import { createIssue, fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

to:

```ts
import { createIssue, deleteWorkItem, fetchSidebarData, getSettings, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

- [ ] **Step 2: Add the delete action helper**

Add after `duplicateWorkItem` (from Task 4):

```ts
async function deleteWorkItemAction(it: WorkItem) {
  try {
    await deleteWorkItem(it.project_id, it.id);
    await refresh();
  } catch (err) {
    synced.textContent = "삭제 실패: " + err;
    console.error("deleteWorkItem failed:", err);
  }
}
```

- [ ] **Step 3: Add the confirm popover**

Add after `openContextMenu` (from Task 4):

```ts
function openDeleteConfirm(rowEl: HTMLElement, it: WorkItem, offsetX: number, offsetY: number) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.width = CONTEXT_MENU_WIDTH + "px";
  pop.style.left = Math.min(offsetX, rowEl.clientWidth - CONTEXT_MENU_WIDTH) + "px";
  pop.style.top = offsetY + "px";

  const msg = document.createElement("div");
  msg.className = "pop-item";
  msg.style.cursor = "default";
  msg.textContent = "정말 삭제하시겠습니까?";
  pop.appendChild(msg);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  const del = document.createElement("div");
  del.className = "pop-item";
  del.textContent = "삭제";
  del.onclick = (e) => {
    e.stopPropagation();
    closePopover();
    deleteWorkItemAction(it);
  };
  pop.appendChild(del);

  const cancel = document.createElement("div");
  cancel.className = "pop-item";
  cancel.textContent = "취소";
  cancel.onclick = (e) => {
    e.stopPropagation();
    closePopover();
  };
  pop.appendChild(cancel);

  rowEl.appendChild(pop);
  openPopover = pop;
}
```

- [ ] **Step 4: Add 삭제 to the context menu, opening the confirm popover in the same spot**

In `openContextMenu` (Task 4), change:

```ts
  addItem("복사본 만들기", () => duplicateWorkItem(it));
  addItem("새 탭에서 열기", () => openInBrowser(it));
  addItem("링크 복사", () => copyIssueLink(it));

  rowEl.appendChild(pop);
  openPopover = pop;
}
```

to:

```ts
  addItem("복사본 만들기", () => duplicateWorkItem(it));
  addItem("새 탭에서 열기", () => openInBrowser(it));
  addItem("링크 복사", () => copyIssueLink(it));

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  addItem("삭제", () => openDeleteConfirm(rowEl, it, offsetX, offsetY));

  rowEl.appendChild(pop);
  openPopover = pop;
}
```

(`addItem`'s `onClick` already runs after `closePopover()`, so calling `openDeleteConfirm` there correctly replaces the context menu with the confirm popover rather than stacking on top of it.)

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run `pnpm tauri dev`, open the sidebar, right-click a row, click "삭제". Expected:
- The menu is replaced by a "정말 삭제하시겠습니까?" popover with 삭제/취소 buttons.
- Clicking "취소" closes the popover with no request sent.
- Clicking outside or Escape also closes it with no request sent.
- Clicking "삭제" deletes the issue and the list refreshes without it.

- [ ] **Step 7: Commit**

```bash
git add src/sidebar/main.ts
git commit -m "feat(sidebar): add delete action with confirm popover to context menu"
```
