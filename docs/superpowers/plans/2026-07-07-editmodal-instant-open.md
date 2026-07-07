# 수정 모달 즉시 열기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바에서 수정 모달을 열 때, 이미 동기화된 데이터로 즉시 폼을 표시하고 바로 편집 가능하게 하며, 설명(description)과 최신 서버 상태만 백그라운드로 확인하고 저장 시점에만 충돌을 검사한다.

**Architecture:** 사이드바 클릭 시점에 이미 메모리에 있는 항목(`WorkItem`) 스냅샷을 `open_edit_modal` IPC를 통해 editmodal 창으로 함께 전달한다. editmodal은 스냅샷이 있으면 즉시 폼을 채우고, 동시에 기존 `getWorkItem()`으로 최신 전체 데이터(설명 포함)를 백그라운드에서 가져온다. Save 시점에 스냅샷과 최신 데이터를 비교해 그 사이 변경이 있었으면 확인창을 띄운다.

**Tech Stack:** Rust(Tauri, serde) 백엔드, TypeScript(Vite, 순수 DOM) 프론트엔드, vitest(Rust 쪽은 `cargo test`).

## Global Constraints

- `WorkItemDto`/`WorkItem` 필드 이름은 기존 snake_case를 그대로 따른다(`assignee_ids` 등) — camelCase로 바꾸지 않는다.
- description을 제외한 필드는 스냅샷을 신뢰하고 즉시 편집 가능하게 둔다 — 백그라운드 fetch 완료 전까지 그 필드들에 "불러오는 중" 표시를 하지 않는다.
- 저장 시 충돌 확인은 단순 예/아니오 확인창 하나로만 처리한다 — 필드별 세밀한 diff UI는 만들지 않는다.
- 사용자에게 보이는 변경이므로 `CHANGELOG.md`의 `[Unreleased]` → `### 변경`에 한 줄을 반드시 같은 커밋에 추가한다(프로젝트 `CLAUDE.md` 규칙).
- 프론트엔드(`src/`)는 이 저장소 컨벤션상 DOM 로직에 자동 테스트를 추가하지 않는다 — `pnpm exec tsc --noEmit`(타입 체크)와 수동 실행으로 검증한다. Rust(`src-tauri/`) 변경은 기존처럼 `cargo test`로 검증한다.

---

### Task 1: 동기화 데이터에 assignee_ids 포함시키기 (Rust)

**Files:**
- Modify: `src-tauri/src/commands.rs:34-45` (`WorkItemDto` struct)
- Modify: `src-tauri/src/commands.rs:78-104` (`assemble_sidebar`)
- Test: `src-tauri/src/commands.rs` 내 `mod tests` (약 1021번째 줄 부근, 기존 `assemble_sidebar_carries_updated_at_into_work_item_dto` 바로 아래)

**Interfaces:**
- Produces: `WorkItemDto.assignee_ids: Vec<String>` — Task 2에서 `open_edit_modal`이 이 DTO를 그대로 프론트엔드로 넘길 때 쓰고, Task 3에서 프론트엔드 `WorkItem.assignee_ids: string[]`로 대응된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/commands.rs`의 `assemble_sidebar_carries_updated_at_into_work_item_dto` 테스트(약 1022번째 줄) 바로 아래에 추가:

```rust
    #[test]
    fn assemble_sidebar_carries_assignee_ids_into_work_item_dto() {
        let projects = vec![Project { id: "p1".into(), name: "Web".into(), identifier: "WEB".into() }];
        let item = wi("a", "started", &["me", "other"], "p1");
        let data = assemble_sidebar("me", projects, vec![item], vec![], "2026-06-30", "2026-07-02");
        assert_eq!(data.assigned[0].assignee_ids, vec!["me".to_string(), "other".to_string()]);
    }
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd src-tauri && cargo test assemble_sidebar_carries_assignee_ids_into_work_item_dto`
Expected: 컴파일 실패 — `WorkItemDto`에 `assignee_ids` 필드가 없다는 에러(`no field \`assignee_ids\` on type \`WorkItemDto\`` 또는 유사한 E0609/E0560 에러).

- [ ] **Step 3: WorkItemDto에 필드 추가 + assemble_sidebar에서 채우기**

`src-tauri/src/commands.rs:34-45`의 `WorkItemDto` 정의를 다음으로 교체:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub assignee_ids: Vec<String>,
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
```

`src-tauri/src/commands.rs:86-94`의 `assemble_sidebar` 내부 매핑을 다음으로 교체:

```rust
    let assigned = filter_assigned_visible(items, user_id, completed_after, completed_before)
        .into_iter()
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            start_date: w.start_date,
            state_group: w.state_group, project_id: w.project_id,
            assignee_ids: w.assignee_ids,
            completed_at: w.completed_at,
            created_at: w.created_at, updated_at: w.updated_at,
        })
        .collect();
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd src-tauri && cargo test assemble_sidebar`
Expected: `assemble_sidebar_carries_assignee_ids_into_work_item_dto`를 포함해 `assemble_sidebar`로 시작하는 모든 테스트 PASS.

- [ ] **Step 5: 전체 Rust 테스트 스위트로 회귀 확인**

Run: `cd src-tauri && cargo test`
Expected: 기존 테스트 전부 PASS (특히 `assemble_filters_to_my_open_items_across_projects`, `assemble_includes_items_completed_within_the_window`).

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(sync): carry assignee_ids into synced WorkItemDto"
```

---

### Task 2: open_edit_modal이 스냅샷을 함께 전달하도록 확장 (Rust)

**Files:**
- Modify: `src-tauri/src/commands.rs:601-612` (`open_edit_modal`)

**Interfaces:**
- Consumes: `WorkItemDto`(Task 1에서 `assignee_ids` 추가됨, 이미 `Serialize + Deserialize` derive됨).
- Produces: `load-item` 이벤트 payload에 `snapshot: Option<WorkItemDto>` 필드 추가. Task 4에서 프론트엔드가 이 payload의 `snapshot`을 읽는다.

- [ ] **Step 1: 커맨드 시그니처 확장**

`src-tauri/src/commands.rs:601-612`를 다음으로 교체:

```rust
#[tauri::command]
pub fn open_edit_modal(
    app: tauri::AppHandle,
    project_id: String,
    item_id: String,
    snapshot: Option<WorkItemDto>,
) {
    if let Some(win) = app.get_webview_window("editmodal") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to(
        "editmodal",
        "load-item",
        serde_json::json!({ "projectId": project_id, "itemId": item_id, "snapshot": snapshot }),
    );
}
```

이 커맨드는 `tauri::AppHandle`이 필요해 기존에도(다른 `open_*` 커맨드들과 마찬가지로) 유닛 테스트가 없다 — 컴파일 확인과 Task 6의 수동 검증으로 대신한다.

- [ ] **Step 2: 컴파일 확인**

Run: `cd src-tauri && cargo check`
Expected: 에러 없음. (이 시점에는 프론트엔드가 아직 `snapshot` 인자를 안 보내므로 Tauri IPC 호출 자체는 Task 3까지는 실제로 실행되지 않는다 — 타입만 맞으면 됨.)

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(editmodal): forward an optional item snapshot through open_edit_modal"
```

---

### Task 3: 프론트엔드 타입/IPC 확장 + 사이드바 호출부 수정

**Files:**
- Modify: `src/shared/types.ts:4-10` (`WorkItem` 인터페이스)
- Modify: `src/shared/ipc.ts:2, 97-98` (`openEditModal`)
- Modify: `src/sidebar/main.ts:577` (일반 작업 목록 클릭)

**Interfaces:**
- Consumes: 없음(Task 1/2와 독립적으로 타입만 맞추면 됨).
- Produces: `openEditModal(project_id: string, item_id: string, snapshot?: WorkItem): Promise<void>`. Task 4에서 editmodal이 받는 `load-item` 이벤트의 `snapshot` 필드가 여기서 보낸 값과 대응.

- [ ] **Step 1: WorkItem에 assignee_ids 추가**

`src/shared/types.ts:4-10`을 다음으로 교체:

```ts
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; start_date: string | null;
  state_group: string; project_id: string;
  assignee_ids: string[];
  completed_at: string | null;
  created_at: string | null;
}
```

- [ ] **Step 2: ipc.ts의 openEditModal 확장**

`src/shared/ipc.ts:2`의 import에 `WorkItem` 추가:

```ts
import type { SidebarData, SettingsDto, Project, Member, WorkItem, WorkItemDetail, ReleaseNote, Briefing, PendingAssignment, OfflineStatus, Conflict, ConflictFields } from "./types";
```

`src/shared/ipc.ts:97-98`을 다음으로 교체:

```ts
export const openEditModal = (project_id: string, item_id: string, snapshot?: WorkItem) =>
  invoke<void>("open_edit_modal", { projectId: project_id, itemId: item_id, snapshot });
```

- [ ] **Step 3: 사이드바 일반 목록 클릭에서 스냅샷 전달**

`src/sidebar/main.ts:577`을 다음으로 교체:

```ts
  el.onclick = () => openEditModal(it.project_id, it.id, it);
```

("맡긴 작업" 목록의 `src/sidebar/main.ts:796` 호출부(`openEditModal(p.project_id, p.item_id)`)는 `PendingAssignment`에 `state_group`/`assignee_ids`가 없어 스냅샷을 만들 수 없으므로 그대로 둔다 — `snapshot` 인자 생략은 폴백 경로로 처리된다.)

- [ ] **Step 4: 타입 체크**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/sidebar/main.ts
git commit -m "feat(sidebar): pass the synced item snapshot when opening the edit modal"
```

---

### Task 4: editmodal — 스냅샷으로 즉시 표시 + 백그라운드 상세 fetch

**Files:**
- Modify: `src/editmodal/main.ts` (여러 구간, 아래 각 스텝에 정확한 위치 명시)
- Modify: `src/shared/app.css` (`.chip:disabled`, `.em-btn:disabled` 규칙 추가)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### 변경`)

**Interfaces:**
- Consumes: `WorkItem`(Task 3), `WorkItemDetail`(기존), `load-item` 이벤트의 `snapshot?: WorkItem`(Task 2에서 emit).
- Produces: 모듈 전역 `snapshotOriginal: WorkItem | null`, `detailFetchPromise: Promise<WorkItemDetail> | null` — Task 5의 `save()`가 이 둘을 사용해 충돌을 검사한다.

- [ ] **Step 1: import에 WorkItem 추가**

`src/editmodal/main.ts:11`을 다음으로 교체:

```ts
import type { Member, WorkItem, WorkItemDetail } from "../shared/types";
```

- [ ] **Step 2: emChipDesc/emSave를 버튼 타입으로 캐스팅 (disabled 속성 사용을 위해)**

`src/editmodal/main.ts:27`을 다음으로 교체:

```ts
const emChipDesc = document.getElementById("emChipDesc") as HTMLButtonElement;
```

`src/editmodal/main.ts:35`을 다음으로 교체:

```ts
const emSave = document.getElementById("emSave") as HTMLButtonElement;
```

- [ ] **Step 3: 모듈 상태 추가**

`src/editmodal/main.ts:41`(`let original: WorkItemDetail | null = null;`) 바로 아래에 추가:

```ts
let snapshotOriginal: WorkItem | null = null;
let detailFetchPromise: Promise<WorkItemDetail> | null = null;
```

- [ ] **Step 4: 헬퍼 함수 추가**

`src/editmodal/main.ts:266`(`async function loadItem(...)`) 바로 위에 추가:

```ts
function snapshotToDetail(snapshot: WorkItem): WorkItemDetail {
  return {
    id: snapshot.id, name: snapshot.name, description: "",
    assignee_ids: snapshot.assignee_ids,
    start_date: snapshot.start_date, target_date: snapshot.target_date,
    priority: snapshot.priority, state_group: snapshot.state_group,
    project_id: snapshot.project_id,
  };
}

// description을 제외한 필드만 폼에 채운다 — description은 호출부에서 별도로 다룬다.
function applyFieldsToForm(fields: Pick<WorkItemDetail,
  "name" | "assignee_ids" | "start_date" | "target_date" | "priority" | "state_group">) {
  emTitleInput.value = fields.name;
  assigneeIds = [...fields.assignee_ids];
  startChoice = "custom";
  startCustomDate = fields.start_date ?? "";
  dueChoice = "custom";
  dueCustomDate = fields.target_date ?? "";
  priority = fields.priority as Priority;
  stateGroup = fields.state_group as StateGroup;
  renderChips();
}

function setDescriptionLoading(loading: boolean) {
  emChipDesc.disabled = loading;
  if (loading) emChipDesc.title = "설명 불러오는 중…";
}
```

- [ ] **Step 5: loadItem을 스냅샷 인자를 받도록 재작성**

`src/editmodal/main.ts:266-323`(기존 `loadItem` 전체)을 다음으로 교체:

```ts
async function loadItem(pid: string, iid: string, snapshot?: WorkItem) {
  // Re-assert always-on-top every time an item is loaded, mirroring the
  // sidebar's showSidebar() — openInBrowser() drops it so the browser window can
  // surface above the modal, and nothing else restores it afterward.
  win.setAlwaysOnTop(true).catch((err) => {
    console.error("setAlwaysOnTop failed:", err);
  });
  closePopover();
  emDeleteConfirm.hidden = true;
  // closeModal()은 창을 숨기기만 해서 같은 항목을 다시 열 때 원본 데이터가 메모리에
  // 그대로 남아있다 — 재요청 없이 그대로 보여준다.
  if (original && pid === projectId && iid === itemId) {
    emTitleInput.focus();
    resizeToFit();
    return;
  }
  const requestId = ++loadRequestId;
  projectId = pid;
  itemId = iid;
  original = null;
  snapshotOriginal = snapshot ?? null;
  detailFetchPromise = null;
  members = [];
  membersLoadedForProject = null;
  emError.hidden = true;
  emTitleInput.classList.remove("error");

  if (snapshot) {
    // 이미 동기화로 받아둔 값이 있다 — 전체 스피너 없이 즉시 편집 가능한 폼을 보여준다.
    applyFieldsToForm(snapshot);
    emDescription.value = "";
    setDescVisible(false, false);
    setDescriptionLoading(true);
    emForm.hidden = false;
    emLoading.hidden = true;
    resizeToFit();
    emTitleInput.focus();
  } else {
    emForm.hidden = true;
    emLoading.hidden = false;
    emLoading.textContent = "불러오는 중…";
    resizeToFit();
  }

  const fetchPromise = getWorkItem(pid, iid);
  if (snapshot) detailFetchPromise = fetchPromise;

  try {
    const detail = await fetchPromise;
    if (requestId !== loadRequestId) return;
    original = detail;
    if (!snapshot) {
      // 스냅샷이 있었다면 이미 채워둔 폼 값(사용자가 편집 중일 수 있음)은 덮어쓰지
      // 않는다 — description만 이 fetch로 채운다.
      applyFieldsToForm(detail);
    }
    emDescription.value = detail.description;
    setDescriptionLoading(false);
    // Auto-show an existing description — hiding it would read as "deleted".
    setDescVisible(detail.description !== "", false);
    emLoading.hidden = true;
    emForm.hidden = false;
    resizeToFit();
    if (!snapshot) emTitleInput.focus();
  } catch (err) {
    if (requestId !== loadRequestId) return;
    if (snapshot) {
      // 오프라인 등으로 최신 데이터를 못 가져왔다 — 스냅샷을 기준값으로 확정하고
      // 계속 편집 가능하게 둔다(설명은 빈 값으로 취급).
      original = snapshotToDetail(snapshot);
      setDescriptionLoading(false);
      console.error("getWorkItem background refresh failed:", err);
    } else {
      emLoading.textContent = "불러오기 실패: " + err;
      console.error("getWorkItem failed:", err);
      resizeToFit();
    }
  }
}
```

- [ ] **Step 6: load-item 이벤트 리스너가 snapshot을 함께 받도록 수정**

`src/editmodal/main.ts:431-433`을 다음으로 교체:

```ts
win.listen<{ projectId: string; itemId: string; snapshot?: WorkItem }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId, event.payload.snapshot);
});
```

- [ ] **Step 7: disabled 상태 CSS 추가**

`src/shared/app.css`의 `.chip-desc-toggle.active { ... }` 규칙(약 96번째 줄) 바로 아래에 추가:

```css
.chip:disabled { opacity: .5; cursor: default; }
```

`src/shared/app.css`의 `.em-btn-ghost { ... }` 규칙(약 541번째 줄) 바로 아래에 추가:

```css
.em-btn:disabled { opacity: .55; cursor: default; }
```

- [ ] **Step 8: CHANGELOG 기록**

`CHANGELOG.md`의 `## [Unreleased]` → `### 변경` 섹션(6-19번째 줄)에 항목 추가 — 기존 "QuickAdd에서 새 이슈를 만들 때..." 항목 바로 아래에:

```markdown
- 사이드바에서 할 일을 클릭하면 수정 창이 대기 없이 바로 열리고 즉시 편집할 수 있습니다.
```

- [ ] **Step 9: 타입 체크**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 10: 수동 검증 — 스냅샷 즉시 표시**

1. `pnpm tauri dev`로 앱 실행.
2. 사이드바에서 담당자/날짜/우선순위/상태가 있는 일반 작업 로우를 클릭.
3. 확인: "불러오는 중…" 스피너 없이 즉시 폼이 뜨고, 제목/담당자/날짜/우선순위/상태가 사이드바에 보이던 값과 일치한다. 설명 칩은 흐리게(비활성) 보인다.
4. 잠시 후(수백 ms 이내) 설명 칩이 다시 진하게 바뀐다(클릭 가능해짐). 항목에 설명이 있었다면 자동으로 펼쳐져 내용이 보인다.
5. "맡긴 작업" 패널에서 "열기" 버튼으로 모달을 열면, 기존처럼 "불러오는 중…" 스피너가 잠깐 보인 뒤 폼이 뜨는지 확인(폴백 경로가 그대로 동작).

- [ ] **Step 11: 커밋**

```bash
git add src/editmodal/main.ts src/shared/app.css CHANGELOG.md
git commit -m "feat(editmodal): show the form instantly from the synced snapshot, load description in the background"
```

---

### Task 5: 저장 시 충돌 확인 UI 및 로직

**Files:**
- Modify: `src/editmodal/index.html` (충돌 확인 팝업 마크업)
- Modify: `src/shared/app.css` (`.em-save-confirm` 위치 스타일)
- Modify: `src/editmodal/main.ts` (`save()` 및 관련 헬퍼)

**Interfaces:**
- Consumes: Task 4의 `snapshotOriginal`, `detailFetchPromise`, `original`.
- Produces: 없음(최종 사용자 흐름의 끝).

- [ ] **Step 1: 충돌 확인 팝업 마크업 추가**

`src/editmodal/index.html:34-39`(기존 `.em-delete-confirm` 블록) 바로 아래, `<div class="em-foot-right">`(40번째 줄) 바로 위에 추가:

```html
        <div class="pop em-save-confirm" id="emSaveConfirm" hidden>
          <div class="pop-msg">이 항목이 그 사이 변경되었습니다. 그대로 저장하시겠습니까?</div>
          <div class="popover-divider"></div>
          <div class="pop-item" id="emSaveConfirmYes">그대로 저장</div>
          <div class="pop-item" id="emSaveConfirmNo">취소</div>
        </div>
```

- [ ] **Step 2: 위치 CSS 추가**

`src/shared/app.css`의 `.em-delete-confirm { ... }` 규칙(약 536번째 줄) 바로 아래에 추가:

```css
.em-save-confirm { position: absolute; bottom: 100%; right: 18px; margin-bottom: 6px; width: 210px; }
```

- [ ] **Step 3: DOM 참조 추가**

`src/editmodal/main.ts:33`(`const emDeleteConfirmNo = document.getElementById("emDeleteConfirmNo")!;`) 바로 아래에 추가:

```ts
const emSaveConfirm = document.getElementById("emSaveConfirm")!;
const emSaveConfirmYes = document.getElementById("emSaveConfirmYes")!;
const emSaveConfirmNo = document.getElementById("emSaveConfirmNo")!;
```

- [ ] **Step 4: 충돌 판정 + 확인창 헬퍼 추가**

`src/editmodal/main.ts`의 `async function save() {`(현재 345번째 줄) 바로 위에 추가:

```ts
function hasConflictWithSnapshot(fetched: WorkItemDetail, snapshot: WorkItem): boolean {
  if (fetched.name !== snapshot.name) return true;
  if ((fetched.start_date ?? "") !== (snapshot.start_date ?? "")) return true;
  if ((fetched.target_date ?? "") !== (snapshot.target_date ?? "")) return true;
  if (fetched.priority !== snapshot.priority) return true;
  if (fetched.state_group !== snapshot.state_group) return true;
  const fetchedAssignees = [...fetched.assignee_ids].sort();
  const snapshotAssignees = [...snapshot.assignee_ids].sort();
  return JSON.stringify(fetchedAssignees) !== JSON.stringify(snapshotAssignees);
}

function confirmSaveConflict(): Promise<boolean> {
  return new Promise((resolve) => {
    emSaveConfirm.hidden = false;
    resizeToFit();
    emSaveConfirmYes.onclick = () => {
      emSaveConfirm.hidden = true;
      resizeToFit();
      resolve(true);
    };
    emSaveConfirmNo.onclick = () => {
      emSaveConfirm.hidden = true;
      resizeToFit();
      resolve(false);
    };
  });
}
```

- [ ] **Step 5: save()에 대기/충돌 검사 붙이기**

`src/editmodal/main.ts:345-347`(현재 `async function save() {\n  if (!original) return;`)을 다음으로 교체:

```ts
async function save() {
  if (detailFetchPromise && !original) {
    emSave.disabled = true;
    try {
      await detailFetchPromise;
    } catch {
      // 실패 시 loadItem의 catch가 이미 original을 스냅샷 기준으로 채워둔다.
    } finally {
      emSave.disabled = false;
    }
  }
  if (!original) return;

  if (snapshotOriginal && hasConflictWithSnapshot(original, snapshotOriginal)) {
    const proceed = await confirmSaveConflict();
    if (!proceed) return;
  }
```

(이 블록 다음에 이어지는 기존 `const name = emTitleInput.value.trim();`부터 함수 끝까지는 그대로 둔다 — diff 기준값 `original`은 이미 최신 fetch 결과이므로 변경 없음.)

- [ ] **Step 6: 타입 체크**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 7: 수동 검증 — 저장 시 충돌 확인**

1. `pnpm tauri dev`로 앱 실행, 사이드바와 Plane 웹(또는 다른 클라이언트)을 동시에 연다.
2. 사이드바에서 작업 로우를 클릭해 수정 모달을 연다(스냅샷으로 즉시 표시됨).
3. 모달이 열려 있는 동안, Plane 웹에서 같은 이슈의 우선순위를 다른 값으로 바꾼다.
4. 모달로 돌아와 아무 필드나 하나 수정(예: 제목에 공백 추가)하고 저장을 누른다.
5. 확인: "이 항목이 그 사이 변경되었습니다. 그대로 저장하시겠습니까?" 확인창이 뜬다.
6. "취소"를 누르면 모달이 닫히지 않고 저장도 되지 않는지 확인.
7. 다시 저장을 눌러 "그대로 저장"을 선택하면 저장되고 모달이 닫히는지, Plane 웹에서 실제로 값이 반영됐는지 확인.
8. 외부 변경 없이 연 뒤 바로 저장하면 확인창 없이 즉시 저장되는지 확인(회귀 없음).

- [ ] **Step 8: 커밋**

```bash
git add src/editmodal/index.html src/shared/app.css src/editmodal/main.ts
git commit -m "feat(editmodal): confirm before saving over changes made elsewhere"
```

---

### Task 6: 최종 통합 확인

**Files:** 없음(검증 전용)

- [ ] **Step 1: 전체 Rust 테스트**

Run: `cd src-tauri && cargo test`
Expected: 전부 PASS.

- [ ] **Step 2: 전체 프론트엔드 테스트 + 타입 체크**

Run: `pnpm test`
Expected: 전부 PASS(이번 변경으로 추가된 자동 테스트는 없으므로 기존 테스트 회귀만 확인).

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: 빌드 확인**

Run: `pnpm build`
Expected: 에러 없이 빌드 성공.

- [ ] **Step 4: 오프라인 폴백 수동 확인**

1. `pnpm tauri dev`로 앱 실행 후 네트워크를 끊는다(또는 `base_url`을 잘못된 값으로 잠시 설정).
2. 사이드바에서 작업 로우 클릭 — 캐시된 스냅샷으로 폼은 즉시 뜨는지 확인.
3. 설명 칩이 계속 비활성 상태였다가 fetch 실패 후 다시 활성화되는지 확인(빈 설명으로 취급).
4. 아무 필드나 수정 후 저장 — 기존 오프라인 큐잉 동작(저장이 큐에 들어가고 나중에 재생됨)이 그대로 동작하는지 확인.
5. 네트워크를 복구하고 앱이 큐를 정상적으로 재생하는지 확인.

- [ ] **Step 5: git status로 정리 상태 확인**

Run: `git status`
Expected: 모든 변경사항이 Task 1~5의 커밋에 반영되어 있고, 남은 미커밋 변경이 없다.
