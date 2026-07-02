# 사이드바 디자인 개선 (칩 방식 + 프로젝트 헤더) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바의 편집 가능한 필드(상태·우선순위·기간)를 항상 버튼처럼 보이는 칩 UI로 바꾸고, 프로젝트 헤더에 식별자·진행률·빠른추가를 더한다.

**Architecture:** 프론트는 `src/sidebar/main.ts`의 DOM 렌더 함수와 `src/shared/app.css`만 변경, 순수 로직(`formatDateRange`, `groupProgress`)은 `src/sidebar/logic.ts`에 TDD로 추가. 백엔드는 `start_date`를 사이드바 DTO에 통과시키고, 날짜 지우기용 빈 문자열→null 규약과 `show_quickadd_for_project` 커맨드를 추가한다.

**Tech Stack:** Tauri 2 (Rust), TypeScript (Vite), vitest, cargo test (wiremock)

**Spec:** `docs/superpowers/specs/2026-07-02-sidebar-redesign-design.md`
**Mockup:** `docs/superpowers/mockups/2026-07-02-sidebar-redesign-mockup.html` (A안 최종 패널)

## Global Constraints

- UI 문구는 한국어 (기존 파일들과 동일한 톤).
- 새 의존성 추가 금지. 기존 패턴(`.chip`, `.pop`, `attachPopover`, 낙관적 갱신+롤백) 재사용.
- 사이드바 폭 320px, 슬라이드 애니메이션, 새로고침 쿨다운, 편집 모달, 컨텍스트 메뉴는 변경하지 않는다.
- 각 태스크 끝마다 커밋. 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- 검증 명령: `pnpm exec tsc --noEmit` / `pnpm exec vitest run` (repo 루트), `cargo test` (`src-tauri/`).

---

### Task 1: `start_date`를 사이드바 데이터 파이프라인에 추가

**Files:**
- Modify: `src-tauri/src/plane_api.rs` (WorkItem 구조체, map_work_item, 테스트 헬퍼/픽스처)
- Modify: `src-tauri/src/commands.rs` (WorkItemDto, assemble_sidebar, 테스트 헬퍼)
- Modify: `src/shared/types.ts` (WorkItem 인터페이스)
- Modify: `src/sidebar/logic.test.ts` (헬퍼 컴파일 수정)

**Interfaces:**
- Produces: Rust `WorkItem.start_date: Option<String>`, `WorkItemDto.start_date: Option<String>`, TS `WorkItem.start_date: string | null` — Task 3, 5, 6이 사용.

- [ ] **Step 1: Rust `WorkItem`에 `start_date` 추가**

`src-tauri/src/plane_api.rs`의 `WorkItem` 구조체(4~16행 부근)에 필드 추가:

```rust
#[derive(Debug, Clone)]
pub struct WorkItem {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub assignee_ids: Vec<String>,
    pub completed_at: Option<String>,
}
```

`map_work_item`(364행 부근)에 매핑 추가 — `RawWorkItem`에는 `start_date`가 이미 있음:

```rust
        target_date: w.target_date,
        start_date: w.start_date,
```

- [ ] **Step 2: 컴파일 에러 나는 곳 모두 수정**

`cargo build` 기준으로 `WorkItem { ... }` 리터럴 생성부를 모두 고친다:
- `plane_api.rs` 테스트 헬퍼 `wi_completed`(399행 부근): `start_date: None,` 추가
- `commands.rs` 테스트 헬퍼 `wi_completed`(371행 부근 `wi`가 위임하는 함수): `start_date: None,` 추가

- [ ] **Step 3: wiremock 테스트로 파싱 검증**

`plane_api.rs`의 `list_work_items_parses_expanded_state_and_assignees` 테스트 픽스처 JSON에 `"start_date": "2026-07-01",` 필드를 추가하고, 단언 추가:

```rust
        assert_eq!(items[0].start_date.as_deref(), Some("2026-07-01"));
```

- [ ] **Step 4: DTO에 통과시키기**

`src-tauri/src/commands.rs`:

```rust
#[derive(Serialize)]
pub struct WorkItemDto {
    pub id: String,
    pub name: String,
    pub priority: String,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub state_group: String,
    pub project_id: String,
    pub completed_at: Option<String>,
}
```

`assemble_sidebar`의 매핑(68행 부근):

```rust
        .map(|w| WorkItemDto {
            id: w.id, name: w.name, priority: w.priority, target_date: w.target_date,
            start_date: w.start_date,
            state_group: w.state_group, project_id: w.project_id, completed_at: w.completed_at,
        })
```

- [ ] **Step 5: TS 타입 + 테스트 헬퍼**

`src/shared/types.ts`:

```ts
export interface WorkItem {
  id: string; name: string; priority: string;
  target_date: string | null; start_date: string | null;
  state_group: string; project_id: string;
  completed_at: string | null;
}
```

`src/sidebar/logic.test.ts`의 헬퍼 두 개에 `start_date: null` 추가:

```ts
function wi(id: string, project_id: string, state_group = "started"): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, start_date: null, state_group, project_id, completed_at: null };
}
function wiCompleted(id: string, project_id: string, completed_at: string | null): WorkItem {
  return { id, name: "n" + id, priority: "none", target_date: null, start_date: null, state_group: "completed", project_id, completed_at };
}
```

- [ ] **Step 6: 전체 검증**

```
cd src-tauri && cargo test        # 전부 PASS (start_date 단언 포함)
pnpm exec tsc --noEmit            # TSC_OK
pnpm exec vitest run              # 전부 PASS
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/plane_api.rs src-tauri/src/commands.rs src/shared/types.ts src/sidebar/logic.test.ts
git commit -m "feat(sidebar): pipe start_date through the sidebar data path"
```

---

### Task 2: `build_update_body` — 빈 날짜 문자열을 JSON null로

**Files:**
- Modify: `src-tauri/src/commands.rs:103-108` (build_update_body), 테스트 모듈

**Interfaces:**
- Produces: IPC `update_work_item_fields`에 `start_date: ""` / `target_date: ""`를 보내면 서버에 `null`이 전송됨 (날짜 지우기). `None`은 기존대로 "변경 없음". Task 6이 사용.

- [ ] **Step 1: 실패하는 테스트 작성**

`commands.rs` 테스트 모듈에 추가:

```rust
    #[test]
    fn build_update_body_turns_empty_date_strings_into_null() {
        // The sidebar's date popover sends "" to clear a date; Plane expects null.
        let body = build_update_body(None, None, None, Some(""), Some(""), None, None);
        assert_eq!(body, serde_json::json!({ "start_date": null, "target_date": null }));
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri && cargo test build_update_body_turns_empty`
Expected: FAIL — `"start_date": ""`가 들어있음.

- [ ] **Step 3: 최소 구현**

`build_update_body`의 날짜 두 분기를 교체:

```rust
    if let Some(sd) = start_date {
        let v = if sd.is_empty() { serde_json::Value::Null } else { serde_json::json!(sd) };
        body.insert("start_date".into(), v);
    }
    if let Some(td) = target_date {
        let v = if td.is_empty() { serde_json::Value::Null } else { serde_json::json!(td) };
        body.insert("target_date".into(), v);
    }
```

- [ ] **Step 4: 통과 확인 (전체 회귀 포함)**

Run: `cd src-tauri && cargo test`
Expected: 전부 PASS (기존 `build_update_body_*` 4개 포함).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(api): clear start/target date by mapping empty string to JSON null"
```

---

### Task 3: 순수 함수 `formatDateRange` / `groupProgress` (TDD)

**Files:**
- Modify: `src/sidebar/logic.ts`, `src/sidebar/logic.test.ts`

**Interfaces:**
- Consumes: TS `WorkItem.start_date` (Task 1)
- Produces: `formatDateRange(start: string | null, target: string | null): string`, `groupProgress(items: WorkItem[]): { done: number; total: number }` — Task 5, 7이 import.

- [ ] **Step 1: 실패하는 테스트 작성**

`logic.test.ts`에 추가 (import에 `formatDateRange, groupProgress` 추가):

```ts
describe("formatDateRange", () => {
  it("formats both dates as M/D → M/D", () => {
    expect(formatDateRange("2026-07-01", "2026-07-04")).toBe("7/1 → 7/4");
  });
  it("formats target-only as ~ M/D", () => {
    expect(formatDateRange(null, "2026-07-08")).toBe("~ 7/8");
  });
  it("formats start-only as M/D →", () => {
    expect(formatDateRange("2026-07-01", null)).toBe("7/1 →");
  });
  it("returns empty string when both are missing", () => {
    expect(formatDateRange(null, null)).toBe("");
  });
  it("strips leading zeros", () => {
    expect(formatDateRange("2026-01-05", "2026-12-31")).toBe("1/5 → 12/31");
  });
});

describe("groupProgress", () => {
  it("counts completed items against the total", () => {
    const items = [wi("a", "p1"), wiCompleted("b", "p1", "2026-07-02T05:00:00Z"), wi("c", "p1")];
    expect(groupProgress(items)).toEqual({ done: 1, total: 3 });
  });
  it("returns zeros for an empty group", () => {
    expect(groupProgress([])).toEqual({ done: 0, total: 0 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run`
Expected: FAIL — `formatDateRange is not a function`.

- [ ] **Step 3: 구현**

`logic.ts`에 추가:

```ts
/** "2026-07-01" → "7/1". null/malformed → "". */
function monthDay(iso: string | null): string {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!m || !d) return "";
  return `${m}/${d}`;
}

/** Compact date-range label for a task chip: "7/1 → 7/4", "~ 7/8" (due only),
 *  "7/1 →" (start only), or "" when neither date is set. */
export function formatDateRange(start: string | null, target: string | null): string {
  const s = monthDay(start);
  const t = monthDay(target);
  if (s && t) return `${s} → ${t}`;
  if (t) return `~ ${t}`;
  if (s) return `${s} →`;
  return "";
}

/** Completed-vs-total counts for a project group's progress ring. */
export function groupProgress(items: WorkItem[]): { done: number; total: number } {
  const done = items.filter((i) => i.state_group === "completed").length;
  return { done, total: items.length };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run` → 전부 PASS. `pnpm exec tsc --noEmit` → TSC_OK.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/logic.ts src/sidebar/logic.test.ts
git commit -m "feat(sidebar): add formatDateRange and groupProgress helpers"
```

---

### Task 4: 헤더 버튼 — 이모지 → SVG + 28px 히트 영역

**Files:**
- Modify: `src/sidebar/index.html:14-16`
- Modify: `src/shared/app.css` (`.refresh`, `.settings-btn`, `.pin` 제거 → `.hbtn` 추가)

**Interfaces:**
- Consumes: `src/sidebar/main.ts`는 id(`pin`/`refresh`/`openSettings`)와 `.active` 클래스 토글만 사용 — 변경 불필요.

- [ ] **Step 1: index.html의 헤더 세 버튼 교체**

`src/sidebar/index.html`에서 📌/⟳/⚙ 세 span을 다음으로 교체 (id·title 유지):

```html
        <span id="pin" class="hbtn" title="고정 — 다른 창이 활성화돼도 사이드바를 열어둡니다"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 2l4.5 4.5-2.2.7-2.4 2.4.3 3.4-2.1-2.1L4 14.5 1.5 12l3.6-3.6L3 6.4l3.4.3 2.4-2.4z" stroke-linejoin="round"/></svg></span>
        <span id="refresh" class="hbtn" title="새로고침"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span id="openSettings" class="hbtn" title="설정"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/></svg></span>
```

- [ ] **Step 2: CSS 교체**

`app.css` 사이드바 섹션에서 `.refresh { ... }`, `.settings-btn { ... }`, `.settings-btn:hover { ... }`, `.pin { ... }`, `.pin:hover { ... }`, `.pin.active { ... }` 여섯 규칙을 삭제하고 다음으로 대체:

```css
.hbtn {
  width: 28px; height: 28px; border-radius: 7px; flex: none;
  display: grid; place-items: center; color: var(--muted); cursor: pointer;
}
.hbtn:hover { background: var(--panel-2); color: var(--text); }
.hbtn.active { color: var(--accent); background: var(--accent-soft); }
.hbtn svg { width: 15px; height: 15px; display: block; }
```

- [ ] **Step 3: 검증**

`pnpm exec tsc --noEmit` → TSC_OK. 앱 실행 시(`pnpm tauri dev`) 사이드바에서 세 버튼 호버 배경·핀 활성 색 확인 (수동 — 이 단계에서 실행이 어려우면 Task 9의 일괄 수동 확인으로 미룸).

- [ ] **Step 4: Commit**

```bash
git add src/sidebar/index.html src/shared/app.css
git commit -m "feat(sidebar): replace emoji header buttons with SVG icons and larger hit areas"
```

---

### Task 5: 작업 행 — 칩 레이아웃으로 재구성

**Files:**
- Modify: `src/shared/app.css` (`.task` 계열 재작성 + `.chip` 변형 추가)
- Modify: `src/sidebar/main.ts` (`renderTaskRow` 재작성)

**Interfaces:**
- Consumes: `formatDateRange` (Task 3), TS `WorkItem.start_date` (Task 1), 기존 `openStatePopover`/`openPriorityPopover`/`openEditModal`/컨텍스트 메뉴.
- Produces: 날짜 칩은 `openSidebarDatePopover(anchor, it, allItems, projects)`를 호출 — Task 6에서 구현. 이 태스크에서는 임시 no-op 함수로 선언해 컴파일만 되게 한다.

- [ ] **Step 1: CSS — 작업 행 스타일 교체**

`app.css`에서 기존 `.task`, `.task:hover`, `.task.completed`, `.task.completed:hover`, `.icon-btn`, `.icon-btn:hover`, `.task .body`, `.task .name`, `.task .meta`, `.prio`, `.due` 규칙을 삭제하고 다음으로 대체 (`.row-browser-btn` 규칙 2개는 유지):

```css
.task { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 8px; cursor: pointer; position: relative; }
.task:hover { background: var(--panel-2); }
.task.completed { opacity: 0.45; }
.task.completed:hover { opacity: 0.75; }
.task.completed .name { text-decoration: line-through; color: var(--muted); }
.task-top { display: flex; align-items: flex-start; gap: 9px; }
.task-state {
  width: 26px; height: 26px; border-radius: 7px; flex: none; position: relative;
  display: grid; place-items: center; cursor: pointer; border: 1px solid transparent;
}
.task:hover .task-state { border-color: var(--border); background: var(--bg); }
.task-state:hover { border-color: var(--accent) !important; }
.task .name { font-size: 13.5px; line-height: 1.4; padding-top: 4px; min-width: 0; flex: 1; }
.task-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-left: 35px; }
.icon-btn { display: flex; flex: none; cursor: pointer; border-radius: 6px; padding: 5px; }
.icon-btn:hover { background: var(--bg); }
```

그리고 QuickAdd `.chip` 규칙 아래에 변형 추가:

```css
/* sidebar-sized chip variants */
.chip.sm { height: 24px; padding: 0 9px; font-size: 11.5px; border-radius: 6px; gap: 5px; position: relative; }
.chip.empty { color: var(--muted-2); border-style: dashed; }
.chip.empty:hover { color: var(--accent); }
.chip.info { cursor: default; color: var(--muted); }
.chip.info:hover { border-color: var(--border); }
```

- [ ] **Step 2: `renderTaskRow` 재작성**

`src/sidebar/main.ts`에서:

import 추가/변경 (파일 상단):

```ts
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatDateRange, formatLocalTime, groupItemsByProject, resolveStateId } from "./logic";
import { priorityIcon, priorityColor, stateIcon, CALENDAR_ICON, EXTERNAL_LINK_ICON } from "../shared/planeIcons";
```

(`groupProgress`는 Task 7에서 사용할 때 import에 추가한다 — 미리 넣으면 미사용 import로 tsc가 실패할 수 있음.)

모듈 상단(STATE_GROUPS 선언 근처)에 추가:

```ts
const PLUS_ICON =
  `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`;

// Placeholder — implemented in the date-popover task.
function openSidebarDatePopover(_anchor: HTMLElement, _it: WorkItem, _allItems: WorkItem[], _projects: Project[]) {}
```

`renderTaskRow` 전체를 다음으로 교체 (상태/우선순위 팝오버 내부 로직·낙관적 갱신은 기존 코드 그대로 유지):

```ts
function renderTaskRow(it: WorkItem, allItems: WorkItem[], projects: Project[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "task" + (it.state_group === "completed" ? " completed" : "");

  const top = document.createElement("div");
  top.className = "task-top";

  const stateBtn = document.createElement("span");
  stateBtn.className = "task-state";
  stateBtn.title = "상태: " + STATE_LABELS[it.state_group];
  stateBtn.innerHTML = stateIcon(it.state_group as any);
  stateBtn.onclick = (e) => {
    e.stopPropagation();
    openStatePopover(stateBtn, it, (group) => {
      const stateId = resolveStateId(states, it.project_id, group);
      if (!stateId) {
        synced.textContent = "상태 변경 실패: 해당 그룹의 상태를 찾을 수 없음";
        return;
      }
      const prev = it.state_group;
      it.state_group = group;
      renderTasks(allItems, projects);
      updateWorkItemState(it.project_id, it.id, stateId).catch((err) => {
        it.state_group = prev;
        renderTasks(allItems, projects);
        synced.textContent = "상태 변경 실패: " + err;
        console.error("updateWorkItemState failed:", err);
      });
    });
  };
  top.appendChild(stateBtn);

  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = it.name;
  top.appendChild(nameEl);

  const browserBtn = document.createElement("span");
  browserBtn.className = "icon-btn row-browser-btn";
  browserBtn.title = "브라우저에서 열기";
  browserBtn.innerHTML = EXTERNAL_LINK_ICON;
  browserBtn.onclick = (e) => {
    e.stopPropagation();
    openInBrowser(it);
  };
  top.appendChild(browserBtn);
  el.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "task-chips";

  const prioChip = document.createElement("span");
  const noPriority = it.priority === "none";
  prioChip.className = "chip sm" + (noPriority ? " empty" : "");
  prioChip.title = "우선순위 변경";
  if (noPriority) {
    prioChip.innerHTML = `${PLUS_ICON} 우선순위`;
  } else {
    prioChip.style.color = priorityColor(it.priority as any);
    prioChip.innerHTML = `${priorityIcon(it.priority as any)} ${PRIORITY_LABELS[it.priority] ?? it.priority}`;
  }
  prioChip.onclick = (e) => {
    e.stopPropagation();
    openPriorityPopover(prioChip, it, (priority) => {
      const prev = it.priority;
      it.priority = priority;
      renderTasks(allItems, projects);
      updateWorkItemPriority(it.project_id, it.id, priority).catch((err) => {
        it.priority = prev;
        renderTasks(allItems, projects);
        synced.textContent = "우선순위 변경 실패: " + err;
        console.error("updateWorkItemPriority failed:", err);
      });
    });
  };
  chips.appendChild(prioChip);

  if (it.state_group === "completed" && it.completed_at) {
    const doneChip = document.createElement("span");
    doneChip.className = "chip sm info";
    doneChip.innerHTML = `${CALENDAR_ICON} 완료 ${formatLocalTime(it.completed_at)}`;
    chips.appendChild(doneChip);
  } else {
    const range = formatDateRange(it.start_date, it.target_date);
    const dateChip = document.createElement("span");
    dateChip.className = "chip sm" + (range ? "" : " empty");
    dateChip.title = "기간 변경";
    dateChip.innerHTML = range ? `${CALENDAR_ICON} ${range}` : `${PLUS_ICON} 마감일`;
    dateChip.onclick = (e) => {
      e.stopPropagation();
      openSidebarDatePopover(dateChip, it, allItems, projects);
    };
    chips.appendChild(dateChip);
  }
  el.appendChild(chips);

  el.onclick = () => openEditModal(it.project_id, it.id);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(it, e.clientX, e.clientY);
  };

  return el;
}
```

주의: `openStatePopover`의 `pop.style.top = "26px"`는 새 26px 버튼 높이에 맞으므로 그대로 두고, `openPriorityPopover`의 `pop.style.top`은 `"26px"`로 변경 (칩 높이 24px + 여백).

- [ ] **Step 3: 검증**

`pnpm exec tsc --noEmit` → TSC_OK. `pnpm exec vitest run` → PASS.
(placeholder 함수의 미사용 매개변수 경고가 나면 `_` 접두사가 이미 붙어 있는지 확인.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/app.css src/sidebar/main.ts
git commit -m "feat(sidebar): chip-style task rows with always-visible edit affordances"
```

---

### Task 6: 날짜 팝오버 — 프리셋 + 시작/마감 입력 + 지우기

**Files:**
- Modify: `src/sidebar/main.ts` (placeholder 교체 + 헬퍼 2개)
- Modify: `src/shared/app.css` (`.date-row` 계열 추가)

**Interfaces:**
- Consumes: `DATE_PRESETS`/`resolveDatePreset` (`shared/datePresets`), `updateWorkItemFields` (`shared/ipc`), `attachPopover`(기존), Task 2의 빈 문자열→null 규약.
- Produces: `openSidebarDatePopover(anchor, it, allItems, projects)` 실구현 (Task 5의 칩이 호출).

- [ ] **Step 1: import 추가**

`src/sidebar/main.ts`:

```ts
import { createIssue, deleteWorkItem, fetchSidebarData, getSettings, openEditModal, openSettings, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
```

- [ ] **Step 2: placeholder를 실구현으로 교체**

Task 5에서 넣은 `openSidebarDatePopover` no-op을 삭제하고 다음을 추가:

```ts
/** Optimistically applies a single date-field change and syncs it to the server.
 *  `value: null` clears the field (sent as "" — the backend maps it to JSON null). */
function applyDateChange(
  it: WorkItem,
  allItems: WorkItem[],
  projects: Project[],
  field: "start_date" | "target_date",
  value: string | null,
) {
  const prev = it[field];
  it[field] = value;
  renderTasks(allItems, projects);
  const payload = field === "start_date" ? { start_date: value ?? "" } : { target_date: value ?? "" };
  updateWorkItemFields(it.project_id, it.id, payload).catch((err) => {
    it[field] = prev;
    renderTasks(allItems, projects);
    synced.textContent = "기간 변경 실패: " + err;
    console.error("updateWorkItemFields failed:", err);
  });
}

function dateInputRow(label: string, value: string | null, onPick: (v: string | null) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "date-row";
  const lab = document.createElement("span");
  lab.className = "date-row-label";
  lab.textContent = label;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "date";
  input.className = "popover-date-input";
  input.value = value ?? "";
  input.onclick = (e) => e.stopPropagation();
  input.onchange = () => {
    if (input.value) onPick(input.value);
  };
  row.appendChild(input);
  const clear = document.createElement("span");
  clear.className = "date-row-clear";
  clear.textContent = "×";
  clear.title = "지우기";
  clear.onclick = (e) => {
    e.stopPropagation();
    onPick(null);
  };
  row.appendChild(clear);
  return row;
}

function openSidebarDatePopover(anchor: HTMLElement, it: WorkItem, allItems: WorkItem[], projects: Project[]) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.style.position = "fixed";
  pop.style.width = "200px";
  pop.onclick = (e) => e.stopPropagation();

  for (const preset of DATE_PRESETS) {
    const opt = document.createElement("div");
    opt.className = "pop-item";
    opt.textContent = "마감일: " + preset.label;
    opt.onclick = (e) => {
      e.stopPropagation();
      closePopover();
      applyDateChange(it, allItems, projects, "target_date", resolveDatePreset(preset.key));
    };
    pop.appendChild(opt);
  }

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  pop.appendChild(divider);

  pop.appendChild(dateInputRow("시작일", it.start_date, (v) => {
    closePopover();
    applyDateChange(it, allItems, projects, "start_date", v);
  }));
  pop.appendChild(dateInputRow("마감일", it.target_date, (v) => {
    closePopover();
    applyDateChange(it, allItems, projects, "target_date", v);
  }));

  const rect = anchor.getBoundingClientRect();
  attachPopover(pop, rect.left, rect.bottom + 4);
}
```

- [ ] **Step 3: CSS 추가**

`app.css`의 `.pop-msg` 규칙 아래에:

```css
.date-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; }
.date-row-label { font-size: 11px; color: var(--muted); flex: none; width: 38px; }
.date-row .popover-date-input { flex: 1; min-width: 0; }
.date-row-clear { color: var(--muted-2); cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 13px; line-height: 1; }
.date-row-clear:hover { color: var(--red); background: var(--panel-2); }
```

- [ ] **Step 4: 검증**

`pnpm exec tsc --noEmit` → TSC_OK. `pnpm exec vitest run` → PASS.
수동(가능하면): 날짜 칩 클릭 → 팝오버, 프리셋 클릭 → 칩 갱신, × → "마감일" 빈 칩으로 복귀, 실패 시 롤백 문구.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/main.ts src/shared/app.css
git commit -m "feat(sidebar): date popover with presets, start/due inputs, and clear"
```

---

### Task 7: 프로젝트 그룹 헤더 — 호버·식별자 배지·진행률 링

**Files:**
- Modify: `src/shared/app.css` (`.grp` 계열 교체)
- Modify: `src/sidebar/main.ts` (`renderTasks`의 그룹 헤더 생성부)

**Interfaces:**
- Consumes: `groupProgress` (Task 3), `Project.identifier` (기존 타입).
- Produces: `progressRingSvg(done, total): string` (main.ts 내부 헬퍼), `+` 버튼 자리는 Task 8에서 채움.

- [ ] **Step 1: CSS — `.grp` 계열 교체**

기존 `.grp`, `.grp.with-divider`, `.grp .dot`, `.grp .name`, `.grp .n`, `.grp .chev`, `.grp.collapsed .chev` 규칙을 다음으로 교체:

```css
.grp {
  display: flex; align-items: center; gap: 7px; margin: 2px 2px 0;
  padding: 6px 8px; border-radius: 7px; cursor: pointer; user-select: none;
  position: sticky; top: 0; background: var(--panel); z-index: 1;
}
.grp:hover { background: var(--panel-2); }
.grp.with-divider { margin-top: 8px; border-top: 1px solid var(--border); border-radius: 0 0 7px 7px; }
.grp .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.grp .name { font-size: 12px; font-weight: 700; color: var(--text); }
.grp .ident {
  font-size: 9.5px; font-weight: 700; color: var(--muted-2); letter-spacing: .05em;
  padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; flex: none;
}
.grp .chev { color: var(--muted); font-size: 10px; transition: transform .15s; flex: none; width: 10px; text-align: center; }
.grp.collapsed .chev { transform: rotate(-90deg); }
.grp .prog { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.grp .prog .txt { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.grp .prog .ring { width: 14px; height: 14px; display: block; }
```

- [ ] **Step 2: 진행률 링 헬퍼 + 헤더 렌더 수정**

`main.ts`의 `./logic` import에 `groupProgress` 추가:

```ts
import { buildIssueUrl, computeSidebarGeometry, easeOutCubic, filterVisibleToday, formatDateRange, formatLocalTime, groupItemsByProject, groupProgress, resolveStateId } from "./logic";
```

`main.ts`에 헬퍼 추가:

```ts
const RING_CIRCUMFERENCE = 2 * Math.PI * 6; // viewBox 16, r=6

function progressRingSvg(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0;
  const arc = frac > 0
    ? `<circle cx="8" cy="8" r="6" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-dasharray="${(frac * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 8 8)"/>`
    : "";
  return `<svg class="ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" stroke-width="2.4"/>${arc}</svg>`;
}
```

`renderTasks`의 그룹 헤더 생성부에서, 기존 `n`(카운트) span 생성 3줄을 삭제하고 `name` span 뒤에 다음을 추가:

```ts
    if (project.identifier) {
      const ident = document.createElement("span");
      ident.className = "ident";
      ident.textContent = project.identifier;
      grp.appendChild(ident);
    }

    const prog = groupProgress(groupItems);
    const progEl = document.createElement("span");
    progEl.className = "prog";
    progEl.innerHTML = progressRingSvg(prog.done, prog.total) + `<span class="txt">${prog.done}/${prog.total}</span>`;
    grp.appendChild(progEl);
```

- [ ] **Step 3: 검증**

`pnpm exec tsc --noEmit` → TSC_OK. `pnpm exec vitest run` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/app.css src/sidebar/main.ts
git commit -m "feat(sidebar): project headers with hover, identifier badge, and progress ring"
```

---

### Task 8: `+` 빠른 추가 — `show_quickadd_for_project` 커맨드

**Files:**
- Modify: `src-tauri/src/lib.rs` (`show_quickadd` 추출 + 커맨드 등록)
- Modify: `src-tauri/src/commands.rs` (커맨드 추가)
- Modify: `src/shared/ipc.ts` (바인딩)
- Modify: `src/sidebar/main.ts` (`+` 버튼)
- Modify: `src/quickadd/main.ts` (`select-project` 리스너)

**Interfaces:**
- Consumes: `config::set_last_project(&app, &str)` (기존), lib.rs의 창 배치 로직 (기존 `toggle_quickadd`).
- Produces: Tauri 커맨드 `show_quickadd_for_project(project_id: String)`, quickadd 창으로 가는 `select-project` 이벤트 (payload: project id 문자열), TS `showQuickaddForProject(project_id)`.

- [ ] **Step 1: lib.rs — `show_quickadd` 추출**

`toggle_quickadd`를 다음 두 함수로 분리:

```rust
pub(crate) fn show_quickadd(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
        if let (Ok(mons), Ok(size)) = (win.available_monitors(), win.outer_size()) {
            let positions: Vec<(i32, i32)> = mons.iter().map(|m| (m.position().x, m.position().y)).collect();
            let sorted = monitors::sorted_indices_by_position(&positions);
            let display_index = config::load_settings(app).display_index;
            if let Some(i) = monitors::pick_index(&sorted, display_index) {
                let m = &mons[i];
                let (x, y) = monitors::centered_position(
                    (size.width as i32, size.height as i32),
                    (m.position().x, m.position().y),
                    (m.size().width as i32, m.size().height as i32),
                );
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_quickadd(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("quickadd") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
    }
    show_quickadd(app);
}
```

`invoke_handler`의 `commands::open_settings` 뒤에 `commands::show_quickadd_for_project` 추가.

- [ ] **Step 2: commands.rs — 커맨드 추가**

```rust
#[tauri::command]
pub fn show_quickadd_for_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    // Persist first so QuickAdd's own load() (focus-triggered) resolves to the same project.
    config::set_last_project(&app, &project_id)?;
    let _ = app.emit_to("quickadd", "select-project", project_id);
    crate::show_quickadd(&app);
    Ok(())
}
```

- [ ] **Step 3: ipc.ts 바인딩**

```ts
export const showQuickaddForProject = (project_id: string) =>
  invoke<void>("show_quickadd_for_project", { projectId: project_id });
```

- [ ] **Step 4: quickadd main.ts — 이벤트 리스너**

`win.listen("tauri://focus", ...)` 근처에 추가:

```ts
// Sidebar's per-project "+" button: pre-select that project. The focus event that
// follows resets fields but not selectedId, and load() (if it runs) re-reads
// last_project_id which the command already persisted to the same value.
win.listen<string>("select-project", (e) => {
  selectedId = e.payload;
  members = [];
  membersLoadedForProject = null;
  assigneeIds = [];
  renderSelected();
  renderDropdown();
  renderChips();
});
```

- [ ] **Step 5: sidebar main.ts — `+` 버튼**

import에 `showQuickaddForProject` 추가. CSS 추가 (`.grp .prog` 규칙 아래):

```css
.grp .addbtn {
  width: 20px; height: 20px; border-radius: 5px; flex: none;
  display: grid; place-items: center; color: var(--muted-2); opacity: 0;
}
.grp:hover .addbtn { opacity: 1; }
.grp .addbtn:hover { background: var(--bg); color: var(--accent); }
```

`renderTasks`의 그룹 헤더에서 `progEl` 추가 직후:

```ts
    const addBtn = document.createElement("span");
    addBtn.className = "addbtn";
    addBtn.title = "이 프로젝트에 작업 추가";
    addBtn.innerHTML = PLUS_ICON;
    addBtn.onclick = (e) => {
      e.stopPropagation();
      showQuickaddForProject(project.id).catch((err) => {
        synced.textContent = "QuickAdd 열기 실패: " + err;
        console.error("showQuickaddForProject failed:", err);
      });
    };
    grp.appendChild(addBtn);
```

주의: `grp.onclick`(접기 토글)과의 분리는 `stopPropagation`으로 처리됨.

- [ ] **Step 6: 검증**

```
cd src-tauri && cargo test    # PASS (컴파일 확인 포함)
pnpm exec tsc --noEmit        # TSC_OK
pnpm exec vitest run          # PASS
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src/shared/ipc.ts src/sidebar/main.ts src/quickadd/main.ts
git commit -m "feat(sidebar): per-project quick-add button that opens QuickAdd pre-selected"
```

---

### Task 9: 통합 검증

**Files:** 없음 (검증만)

- [ ] **Step 1: 자동 검증 일괄 실행**

```
pnpm exec tsc --noEmit            # TSC_OK
pnpm exec vitest run              # 전부 PASS
cd src-tauri && cargo test        # 전부 PASS
```

- [ ] **Step 2: 수동 스모크 (pnpm tauri dev)**

- 사이드바 열기(단축키) → 헤더 3버튼 호버/핀 토글
- 상태 버튼 클릭 → 팝오버 → 변경 반영
- 우선순위 칩(값 있음/없음 둘 다) → 팝오버 → 변경 반영
- 날짜 칩 → 프리셋/직접입력/지우기 → 칩 표기(`7/1 → 7/4`, `~ 7/8`, 빈 칩) 확인
- 완료 작업: 취소선 + `완료 시각` 정보 칩, 클릭해도 팝오버 없음
- 그룹 헤더: 접기/펼치기, 식별자 배지, 진행률 링, 호버 `+` → QuickAdd가 해당 프로젝트로 열림
- 행 클릭 → 편집 모달, 우클릭 → 컨텍스트 메뉴 (기존 동작 회귀 없음)
- 라이트 테마 전환 후 대비 확인

- [ ] **Step 3: 이슈 없으면 종료 보고, 있으면 해당 태스크로 돌아가 수정**
