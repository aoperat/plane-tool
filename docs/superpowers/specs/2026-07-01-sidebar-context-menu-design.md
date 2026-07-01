# Sidebar Right-Click Context Menu

## Goal

Add a right-click context menu to issue rows in the sidebar (`src/sidebar/main.ts`), matching the item set from the Plane web app's row context menu, minus "편집" (Edit) which has no corresponding UI in this app.

## Menu items

In order, matching the reference screenshot (minus Edit), with a divider before 아카이브 and before 삭제:

1. **복사본 만들기** (Duplicate) — always shown
2. **새 탭에서 열기** (Open in browser) — always shown
3. **링크 복사** (Copy link) — always shown
4. **아카이브** (Archive) — shown only when `it.state_group` is `"completed"` or `"cancelled"`
5. **삭제** (Delete) — always shown

## Trigger & placement

- Add a `contextmenu` listener to each row in `renderTaskRow()`, calling `e.preventDefault()` and `e.stopPropagation()`.
- Reuse the existing single-popover pattern: module-level `openPopover` / `closePopover()`, and the `.pop` / `.pop-item` CSS classes already used by `openStatePopover()` and `openPriorityPopover()` (`src/sidebar/main.ts`).
- New `openContextMenu(rowEl, it, offsetX, offsetY, callbacks)` builder function, following the same shape as the existing popover builders: anchor the `.pop` to the row element (`position: relative` already implied by existing pattern) and position it via inline `top`/`left` computed from the right-click coordinates relative to the row.
- Existing global dismissal (outside click, Escape key) applies unchanged — no new dismissal logic needed.

## Actions

### 복사본 만들기 (Duplicate)

- Uses only fields already present on the loaded `WorkItem`: `name`, `priority`, `assignee_ids`, `target_date`, `project_id`, `state_group`. Description is **not** copied (the sidebar's list-fetch API doesn't return it, and re-fetching full issue detail before duplicating is out of scope).
- Calls the existing `createIssue(project_id, name, assignee_ids, undefined, target_date, priority, state_group)` IPC wrapper (`src/shared/ipc.ts`) — backed by the existing `create_issue` Tauri command, no backend changes needed.
- On success, calls the existing `refresh()` function to reload the full sidebar dataset (simplest way to pick up the new item's server-assigned id, consistent with the manual refresh button's behavior).
- On failure, set `synced.textContent` to an error message, matching the existing error-handling convention for priority/state updates.

### 새 탭에서 열기 (Open in browser)

- Extract the existing row `onclick` logic (`win.setAlwaysOnTop(false)` then `openUrl(url)`, `src/sidebar/main.ts:190-201`) into a shared helper function, and call it from both the row click handler and this menu item — no behavior change, just de-duplication.

### 링크 복사 (Copy link)

- Add `@tauri-apps/plugin-clipboard-manager` (JS) and the matching `tauri-plugin-clipboard-manager` (Rust crate) as new dependencies, plus a `clipboard-manager:allow-write-text` (or equivalent) permission in `src-tauri/capabilities/default.json`.
- Build the same issue URL used for "새 탭에서 열기" (`${baseUrl}/${workspace}/projects/${it.project_id}/issues/${it.id}`) and write it via the plugin's `writeText`.

### 아카이브 (Archive)

- Plane's REST API has no dedicated archive endpoint for work items (confirmed against developers.plane.so — only modules have one). Archiving is a PATCH to the work-item with `archived_at` set.
- Add a new Tauri command `archive_work_item(project_id, item_id)` in `src-tauri/src/commands.rs`, reusing the existing generic `PlaneClient::update_work_item` with body `{"archived_at": <current UTC ISO-8601 timestamp>}`.
- Add a matching `archiveWorkItem` wrapper in `src/shared/ipc.ts`.
- Only rendered/clickable when `it.state_group` is `completed` or `cancelled`.
- On success, call `refresh()`. On failure, set `synced.textContent`.

### 삭제 (Delete)

- Add `delete_work_item` to `PlaneClient` in `src-tauri/src/plane_api.rs`: `DELETE /workspaces/{slug}/projects/{project_id}/work-items/{id}/`, expecting `204 No Content`.
- Add a new Tauri command `delete_work_item(project_id, item_id)` in `commands.rs`, and a matching `deleteWorkItem` wrapper in `ipc.ts`.
- Clicking 삭제 opens a second, small custom confirm popover (same `.pop`/`.pop-item` styling) with a "정말 삭제하시겠습니까?" message and 삭제/취소 buttons, replacing the context menu (not stacked on top of it).
- Confirming calls `deleteWorkItem`; on success, call `refresh()`. On failure, set `synced.textContent`.

## Error handling & refresh strategy

All four mutating actions (duplicate, archive, delete — open-in-browser and copy-link are non-mutating) follow the existing convention: on failure, log to console and show a short error in the `synced` status element. On success, call the existing `refresh()` function to reload the full sidebar dataset from the server, rather than attempting fine-grained local list surgery (simpler, and consistent with how the manual refresh button already works).

## Out of scope

- 편집 (Edit) — no edit UI exists in this app; excluded from this feature.
- Preserving `description` when duplicating.
- Un-archiving from the sidebar.
