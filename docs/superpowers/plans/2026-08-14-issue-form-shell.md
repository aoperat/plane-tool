# 빠른 추가 · 할 일 수정 폼 공통화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빠른 추가와 할 일 수정이 같은 카드 셸·같은 필드 UI를 쓰게 만들고, 할 일 수정에만 "브라우저에서 열기"를 더한다.

**Architecture:** 폼 관련 모듈을 `src/shared/issueForm/`으로 모으고, 그 위에 카드 셸(`card.ts`)을 새로 만든다. 셸은 헤더·제목·설명·필드·에러 줄을 그리고 레이아웃 교체와 키보드를 맡는다. 두 창은 헤더 추가 버튼과 푸터를 DOM으로 만들어 주입하고, 창 크기·표시/숨김·저장 로직만 자기 `main.ts`에 남긴다. 두 창의 유일한 필드 동작 차이(담당자가 비었을 때의 뜻)는 `emptyAssignee: "me" | "none"` 옵션으로 흡수한다.

**Tech Stack:** TypeScript, Vite, Vitest, Tauri 2 (Rust), 프레임워크 없는 순수 DOM

**설계 스펙:** `docs/superpowers/specs/2026-08-14-issue-form-shell-design.md`

---

## 파일 구조

| 경로 | 책임 |
|---|---|
| `src/shared/issueForm/card.ts` | **신규.** 카드 셸 — 헤더/제목/설명/필드/에러 DOM, 레이아웃 교체, 키보드, 크기 통지 |
| `src/shared/issueForm/assigneeDisplay.ts` | **신규.** `emptyAssignee` 모드에 따른 담당자 표시 규칙 (순수 함수) |
| `src/shared/issueForm/layout.ts` | 이동. 레이아웃 계약 (`LayoutHosts` / `LayoutContext` / `LayoutHandle`) |
| `src/shared/issueForm/layoutCompact.ts` | 이동. 칩 한 줄 레이아웃 |
| `src/shared/issueForm/layoutExpanded.ts` | 이동. 한눈에 보기 레이아웃 |
| `src/shared/issueForm/state.ts` | 이동. DOM을 모르는 폼 상태 |
| `src/shared/issueForm/assigneeSlots.ts` | 이동. 담당자 인라인/오버플로 분배 |
| `src/quickadd/main.ts` | 프로젝트 선택, 등록, 코치마크, 창 크기 |
| `src/quickadd/index.html` | 카드 자리 + 푸터/코치마크 `<template>` |
| `src/editmodal/main.ts` | 불러오기, 저장 diff, 삭제, 저장 충돌, 브라우저 열기, 창 크기 |
| `src/editmodal/index.html` | 카드 자리 + 로딩/푸터 `<template>` |

---

## Task 1: 폼 모듈을 `src/shared/issueForm/`으로 옮긴다

동작은 하나도 바뀌지 않는다. 경로만 옮기고 임포트를 고친다.

**Files:**
- Move: `src/quickadd/layout.ts` → `src/shared/issueForm/layout.ts`
- Move: `src/quickadd/layoutCompact.ts` → `src/shared/issueForm/layoutCompact.ts`
- Move: `src/quickadd/layoutExpanded.ts` → `src/shared/issueForm/layoutExpanded.ts`
- Move: `src/quickadd/state.ts` → `src/shared/issueForm/state.ts`
- Move: `src/quickadd/state.test.ts` → `src/shared/issueForm/state.test.ts`
- Move: `src/quickadd/assigneeSlots.ts` → `src/shared/issueForm/assigneeSlots.ts`
- Move: `src/quickadd/assigneeSlots.test.ts` → `src/shared/issueForm/assigneeSlots.test.ts`
- Modify: `src/quickadd/main.ts` (임포트 4줄)

- [ ] **Step 1: 디렉터리를 만들고 파일을 옮긴다**

```bash
mkdir -p src/shared/issueForm
git mv src/quickadd/layout.ts src/shared/issueForm/layout.ts
git mv src/quickadd/layoutCompact.ts src/shared/issueForm/layoutCompact.ts
git mv src/quickadd/layoutExpanded.ts src/shared/issueForm/layoutExpanded.ts
git mv src/quickadd/state.ts src/shared/issueForm/state.ts
git mv src/quickadd/state.test.ts src/shared/issueForm/state.test.ts
git mv src/quickadd/assigneeSlots.ts src/shared/issueForm/assigneeSlots.ts
git mv src/quickadd/assigneeSlots.test.ts src/shared/issueForm/assigneeSlots.test.ts
```

- [ ] **Step 2: 옮긴 파일들의 `../shared/` 임포트를 `../`로 고친다**

`src/shared/issueForm/` 안에서 `shared`는 한 단계 위다. 아래 다섯 파일의 임포트 경로에서 `../shared/` 를 `../` 로 바꾼다. 같은 디렉터리를 가리키는 `./state`, `./layout`, `./assigneeSlots` 는 그대로 둔다.

`layoutCompact.ts` (1~14줄):

```ts
import { DATE_PRESETS } from "../datePresets";
import { attachWheelCycle } from "../wheelCycle";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  CALENDAR_ICON, FLAG_ICON, DESCRIPTION_ICON,
} from "../planeIcons";
import { bindTip } from "../tooltip";
import {
  initKeyboardFocus, moveKeyboardFocus, keyboardFocusIndex, setKeyboardFocusIndex,
  handleDropdownKeydown,
} from "../dropdownKeyboard";
import type { Member } from "../types";
import { dateChoiceLabel, shiftDateField, toggleAssignee, setSingleAssignee } from "./state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";
```

`layoutExpanded.ts` (1~12줄):

```ts
import { splitAssigneeSlots } from "./assigneeSlots";
import { resolveDateChoice, shiftDateField, toggleAssignee, setSingleAssignee } from "./state";
import type { LayoutHandle, LayoutContext, LayoutHosts } from "./layout";
import { DATE_PRESETS, type DatePresetKey } from "../datePresets";
import { attachWheelCycle } from "../wheelCycle";
import { colorForId } from "../color";
import { initKeyboardFocus, moveKeyboardFocus, selectKeyboardFocus } from "../dropdownKeyboard";
import {
  PRIORITY_ORDER, STATE_ORDER, priorityIcon, priorityLabel, stateIcon, stateLabel,
  DESCRIPTION_ICON, type Priority, type StateGroup,
} from "../planeIcons";
import type { Member } from "../types";
```

`state.ts` (1~3줄):

```ts
import { DATE_PRESETS, resolveDatePreset, shiftIsoDate, type DatePresetKey } from "../datePresets";
import type { Priority, StateGroup } from "../planeIcons";
import type { Member } from "../types";
```

`state.test.ts` (6줄) 과 `assigneeSlots.ts` (1줄) 과 `assigneeSlots.test.ts` (3줄):

```ts
import type { Member } from "../types";
```

- [ ] **Step 3: `src/quickadd/main.ts`의 임포트를 새 경로로 고친다**

9~12줄을 아래로 바꾼다.

```ts
import { createFormState, resolveDateChoice, shiftDateField, resetFormFields } from "../shared/issueForm/state";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "../shared/issueForm/layout";
import { mountCompact } from "../shared/issueForm/layoutCompact";
import { mountExpanded } from "../shared/issueForm/layoutExpanded";
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS — `state.test.ts`, `assigneeSlots.test.ts`를 포함해 전부 통과. 파일 경로만 새 위치로 표시된다.

- [ ] **Step 5: 빌드가 통과하는지 확인한다**

Run: `pnpm build`
Expected: 에러 없이 `dist/` 생성. 타입 에러가 나면 임포트 경로가 남아 있는 것이다.

- [ ] **Step 6: 커밋**

```bash
git add -A src/quickadd src/shared/issueForm
git commit -m "refactor: 빠른 추가 폼 모듈을 shared/issueForm으로 옮긴다"
```

---

## Task 2: `emptyAssignee` 표시 규칙을 순수 함수로 만든다

두 창의 담당자 표시 차이를 한 파일에 모은다. DOM을 모르므로 단위 테스트가 된다.

**Files:**
- Create: `src/shared/issueForm/assigneeDisplay.ts`
- Test: `src/shared/issueForm/assigneeDisplay.test.ts`
- Modify: `src/shared/issueForm/state.ts` (`setSingleAssignee`)
- Modify: `src/shared/issueForm/state.test.ts` (`setSingleAssignee` 테스트)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/shared/issueForm/assigneeDisplay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assigneeChip, isAssigned, memberRowLabel, personChipLabel } from "./assigneeDisplay";
import type { Member } from "../types";

const M = (id: string, is_me = false): Member => ({ id, display_name: id, is_me });
const ME = M("me", true);
const A = M("alice");
const MEMBERS = [ME, A, M("bob")];

describe("assigneeChip — 담당자 칩에 적을 글자", () => {
  it('"me" 모드에서 비어 있으면 "나"다 — 서버가 호출자에게 할당한다', () => {
    expect(assigneeChip("me", [], MEMBERS)).toEqual({ avatar: "나", label: "나" });
  });

  it('"none" 모드에서 비어 있으면 "담당자 없음"이다 — 고칠 때는 진짜 아무도 없을 수 있다', () => {
    expect(assigneeChip("none", [], MEMBERS)).toEqual({ avatar: "-", label: "담당자 없음" });
  });

  it("한 명이면 이름을 쓰고 아바타는 첫 글자다", () => {
    expect(assigneeChip("none", ["alice"], MEMBERS)).toEqual({ avatar: "a", label: "alice" });
  });

  it("멤버 목록에 없는 id면 이름 대신 인원수로 적는다", () => {
    expect(assigneeChip("me", ["ghost"], MEMBERS)).toEqual({ avatar: "1", label: "1명" });
  });

  it("여러 명이면 인원수를 쓴다", () => {
    expect(assigneeChip("me", ["alice", "bob"], MEMBERS)).toEqual({ avatar: "2", label: "2명" });
  });
});

describe("isAssigned — 이 사람이 지정된 것으로 보여야 하는가", () => {
  it('"me" 모드에서 아무도 안 골랐으면 본인이 켜져 보인다', () => {
    expect(isAssigned("me", ME, [])).toBe(true);
  });

  it('"none" 모드에서는 아무도 안 골랐을 때 본인도 꺼져 있다', () => {
    expect(isAssigned("none", ME, [])).toBe(false);
  });

  it("명시적으로 골랐으면 모드와 상관없이 켜진다", () => {
    expect(isAssigned("me", A, ["alice"])).toBe(true);
    expect(isAssigned("none", A, ["alice"])).toBe(true);
  });

  it('"me" 모드라도 다른 사람을 골랐으면 본인은 꺼진다', () => {
    expect(isAssigned("me", ME, ["alice"])).toBe(false);
  });
});

describe("이름 표기", () => {
  it('"me" 모드에서만 본인 행에 "(나)"를 붙인다', () => {
    expect(memberRowLabel("me", ME)).toBe("me (나)");
    expect(memberRowLabel("none", ME)).toBe("me");
  });

  it('"me" 모드에서만 본인 칩을 "나"로 줄인다', () => {
    expect(personChipLabel("me", ME)).toBe("나");
    expect(personChipLabel("none", ME)).toBe("me");
  });

  it("본인이 아니면 두 모드 모두 이름 그대로다", () => {
    expect(memberRowLabel("me", A)).toBe("alice");
    expect(personChipLabel("me", A)).toBe("alice");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/shared/issueForm/assigneeDisplay.test.ts`
Expected: FAIL — `Failed to resolve import "./assigneeDisplay"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/shared/issueForm/assigneeDisplay.ts`:

```ts
import type { Member } from "../types";

/** 담당자가 비었을 때의 뜻. 만들 때(빠른 추가)는 "나에게", 고칠 때(할 일 수정)는
 *  "아무도 없음"이다 — 같은 빈 배열이 창마다 다른 것을 뜻한다. */
export type EmptyAssignee = "me" | "none";

export interface AssigneeChipText {
  /** 아바타 원 안에 넣을 짧은 글자. */
  avatar: string;
  label: string;
}

/** 컴팩트 레이아웃의 담당자 칩에 무엇을 적을지 정한다. */
export function assigneeChip(
  mode: EmptyAssignee,
  assigneeIds: string[],
  members: Member[],
): AssigneeChipText {
  if (assigneeIds.length === 0) {
    return mode === "me"
      ? { avatar: "나", label: "나" }
      : { avatar: "-", label: "담당자 없음" };
  }
  if (assigneeIds.length === 1) {
    // 멤버 목록을 아직 못 받았거나 그 사이 빠진 사람일 수 있다 — 이름 대신
    // 인원수로 적어야 "1명"이라도 맞는 말이 된다.
    const m = members.find((x) => x.id === assigneeIds[0]);
    const name = m ? m.display_name : "1명";
    return { avatar: name.slice(0, 1), label: name };
  }
  return { avatar: String(assigneeIds.length), label: `${assigneeIds.length}명` };
}

/** 이 멤버가 지금 지정된 것으로 보여야 하는가. "me" 모드에서는 아무도 안 골랐을 때
 *  본인이 켜져 보인다 — 서버가 그렇게 할당하기 때문이다. */
export function isAssigned(mode: EmptyAssignee, member: Member, assigneeIds: string[]): boolean {
  if (assigneeIds.includes(member.id)) return true;
  return mode === "me" && member.is_me && assigneeIds.length === 0;
}

/** 컴팩트 팝오버의 멤버 행에 적을 이름. */
export function memberRowLabel(mode: EmptyAssignee, member: Member): string {
  return mode === "me" && member.is_me ? `${member.display_name} (나)` : member.display_name;
}

/** 한눈에 보기의 인라인 칩에 적을 이름. 좁은 칸이라 본인은 줄여 쓴다. */
export function personChipLabel(mode: EmptyAssignee, member: Member): string {
  return mode === "me" && member.is_me ? "나" : member.display_name;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run src/shared/issueForm/assigneeDisplay.test.ts`
Expected: PASS — 12개 통과

- [ ] **Step 5: `setSingleAssignee`에 모드 인자를 더하는 실패 테스트를 쓴다**

`src/shared/issueForm/state.test.ts`의 기존 `setSingleAssignee` describe 블록을 찾아 그 안에 아래 세 케이스를 추가한다. 기존 케이스는 두 번째 인자로 `"me"`를 넘기도록 고친다 (모드는 필수 인자다 — 기본값을 두면 새 창에서 빠뜨려도 컴파일러가 잡아주지 못한다).

```ts
  it('"none" 모드에서는 본인을 골라도 명시적 id로 넣는다 — 고칠 때 "나"는 비우기가 아니다', () => {
    const s = createFormState();
    setSingleAssignee(s, M("me", true), "none");
    expect(s.assigneeIds).toEqual(["me"]);
  });

  it('"me" 모드에서 본인을 고르면 빈 배열로 되돌린다', () => {
    const s = createFormState();
    s.assigneeIds = ["alice"];
    setSingleAssignee(s, M("me", true), "me");
    expect(s.assigneeIds).toEqual([]);
  });

  it("본인이 아니면 두 모드 모두 그 한 사람으로 바꾼다", () => {
    const s = createFormState();
    s.assigneeIds = ["x", "y"];
    setSingleAssignee(s, M("alice"), "me");
    expect(s.assigneeIds).toEqual(["alice"]);
    setSingleAssignee(s, M("bob"), "none");
    expect(s.assigneeIds).toEqual(["bob"]);
  });
```

- [ ] **Step 6: 실패를 확인한다**

Run: `pnpm vitest run src/shared/issueForm/state.test.ts`
Expected: FAIL — `Expected 2 arguments, but got 3` 또는 `"none"` 케이스에서 `[]` 를 받아 `["me"]` 와 다르다는 실패

- [ ] **Step 7: `setSingleAssignee`를 고친다**

`src/shared/issueForm/state.ts`의 해당 함수를 통째로 바꾼다. 파일 위쪽 임포트에 `EmptyAssignee` 를 더한다.

```ts
import type { EmptyAssignee } from "./assigneeDisplay";
```

```ts
/** 선택을 이 한 사람으로 바꾼다. "me" 모드에서 본인을 고르면 빈 배열로 되돌린다 —
 *  명시적 id를 박아두는 것보다, 멤버 목록을 다시 받아도 "고르지 않음"으로 읽히는 게
 *  낫다. "none" 모드(할 일 수정)에서는 그 되돌림이 "담당자 지우기"로 읽히므로 하지
 *  않는다 — 거기서 "나"를 고르는 것은 나를 지정하겠다는 뜻이다. */
export function setSingleAssignee(s: FormState, member: Member, mode: EmptyAssignee): void {
  s.assigneeIds = mode === "me" && member.is_me ? [] : [member.id];
}
```

- [ ] **Step 8: 테스트가 통과하는지 확인한다**

Run: `pnpm test`
Expected: FAIL — `layoutCompact.ts` / `layoutExpanded.ts`가 아직 2개 인자로 부르고 있어 **타입 에러는 나지 않지만**(vitest는 타입 검사를 하지 않는다) 다음 태스크에서 고친다. 이 단계에서는 `state.test.ts`와 `assigneeDisplay.test.ts`가 PASS면 된다.

Run: `pnpm vitest run src/shared/issueForm`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add src/shared/issueForm/assigneeDisplay.ts src/shared/issueForm/assigneeDisplay.test.ts src/shared/issueForm/state.ts src/shared/issueForm/state.test.ts
git commit -m "feat: 담당자 표시 규칙에 emptyAssignee 모드를 더한다"
```

---

## Task 3: 컴팩트 레이아웃이 `emptyAssignee`를 따르게 한다

**Files:**
- Modify: `src/shared/issueForm/layout.ts` (`LayoutContext`, `LayoutHandle`)
- Modify: `src/shared/issueForm/layoutCompact.ts`

- [ ] **Step 1: 레이아웃 계약을 넓힌다**

`src/shared/issueForm/layout.ts`에서 임포트를 더하고 두 인터페이스에 항목을 넣는다.

```ts
import type { FormState } from "./state";
import type { EmptyAssignee } from "./assigneeDisplay";
```

`LayoutContext`에 추가:

```ts
  /** 담당자가 비었을 때의 뜻. 창마다 다르다 — assigneeDisplay.ts 참고. */
  emptyAssignee: EmptyAssignee;
```

`LayoutHandle`에 추가:

```ts
  /** 설명 입력을 펼치거나 접는다. 접어도 값은 남는다 — 셸이 기존 설명을 채운 뒤
   *  펼칠 때 쓴다. `focus`가 false면 커서를 옮기지 않는다(값만 채우는 경우). */
  setDescriptionVisible(visible: boolean, focus?: boolean): void;
  /** 설명 토글 버튼을 켜고 끈다. 상세를 받아오기 전까지 잠가둘 때 쓴다. */
  setDescriptionEnabled(enabled: boolean): void;
```

- [ ] **Step 2: 담당자 표시를 공통 함수로 바꾼다**

`layoutCompact.ts` 임포트에 추가:

```ts
import { assigneeChip, isAssigned, memberRowLabel } from "./assigneeDisplay";
```

`renderAssigneeChip`을 통째로 바꾼다:

```ts
  function renderAssigneeChip() {
    const { avatar: avatarText, label } = assigneeChip(ctx.emptyAssignee, state.assigneeIds, state.members);
    chipAssignee.textContent = "";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = avatarText;
    chipAssignee.appendChild(avatar);
    chipAssignee.appendChild(document.createTextNode(" " + label));
  }
```

- [ ] **Step 3: 팝오버에 "담당자 없음" 행을 더한다**

`renderAssigneePopoverItems`를 통째로 바꾼다. `"none"` 모드에서만 맨 위에 한 행이 붙는다.

```ts
  // 프로젝트 멤버 목록에는 본인도 들어 있으므로 "나 (기본값)" 같은 가짜 행은 없다 —
  // "me" 모드에서는 본인 행이 "(나)"로 적히고 assigneeIds가 비었을 때 선택 표시가 붙는다.
  // "none" 모드(할 일 수정)에서는 그 대신 맨 위에 "담당자 없음" 행이 생긴다 — 고칠 때는
  // 아무도 지정되지 않은 상태가 실제로 존재한다.
  function renderAssigneePopoverItems() {
    fieldPopover.innerHTML = "";
    if (ctx.emptyAssignee === "none") {
      const noneItem = document.createElement("div");
      noneItem.className = "dd-item" + (state.assigneeIds.length === 0 ? " sel" : "");
      noneItem.textContent = "담당자 없음";
      noneItem.dataset.none = "1";
      noneItem.onclick = () => {
        state.assigneeIds = [];
        renderChips();
        closePopover();
        ctx.focusTitle();
      };
      fieldPopover.appendChild(noneItem);
    }
    for (const m of state.members) {
      const item = document.createElement("div");
      item.className = "dd-item" + (isAssigned(ctx.emptyAssignee, m, state.assigneeIds) ? " sel" : "");
      item.textContent = memberRowLabel(ctx.emptyAssignee, m);
      item.dataset.id = m.id;
      if (ctx.emptyAssignee === "me" && m.is_me) item.dataset.self = "1";
      item.onclick = (e) => handleAssigneeItemClick(e, m);
      fieldPopover.appendChild(item);
    }
    initKeyboardFocus(fieldPopover);
  }
```

- [ ] **Step 4: 단독 선택 경로에 모드를 넘긴다**

`handleAssigneeItemClick` 안의 호출을 고친다:

```ts
    setSingleAssignee(state, m, ctx.emptyAssignee);
```

`chipAssignee`의 keydown 핸들러에서 Enter 분기를 아래로 바꾼다. `"none"` 모드의 "담당자 없음" 행도 Enter로 고를 수 있어야 한다.

```ts
    } else if (e.key === "Enter" && !e.ctrlKey) {
      // Ctrl+Enter(제출)는 여기서 가로채지 않는다 — document의 전역 핸들러가
      // 잡아야 하므로, 일반 Enter만 받는다.
      e.preventDefault();
      const focused = fieldPopover.querySelector<HTMLElement>(".dd-item.kbd-focus");
      if (focused?.dataset.none) {
        state.assigneeIds = [];
        renderChips();
      } else if (focused?.dataset.id) {
        state.assigneeIds = focused.dataset.self ? [] : [focused.dataset.id];
        renderChips();
      }
      closePopover();
      chipAssignee.focus();
    } else if (e.key === "Escape") {
```

Space(토글) 분기도 "담당자 없음" 행에서는 비우기로 동작해야 한다. `if (!focused?.dataset.id) return;` 앞에 한 줄을 넣는다:

```ts
    } else if (e.key === " ") {
      e.preventDefault();
      const index = keyboardFocusIndex(fieldPopover);
      const focused = fieldPopover.querySelector<HTMLElement>(".dd-item.kbd-focus");
      if (focused?.dataset.none) {
        state.assigneeIds = [];
        renderChips();
        renderAssigneePopoverItems();
        setKeyboardFocusIndex(fieldPopover, index);
        return;
      }
      if (!focused?.dataset.id) return;
      toggleAssignee(state, focused.dataset.id);
      renderChips();
      renderAssigneePopoverItems(); // re-renders the list, so restore the cursor
      setKeyboardFocusIndex(fieldPopover, index);
    } else if (e.key === "Enter" && !e.ctrlKey) {
```

- [ ] **Step 5: 담당자 휠 사이클에 "담당자 없음"을 넣는다**

`attachWheelCycle(chipAssignee, ...)` 블록을 통째로 바꾼다. `"none"` 모드에서는 `null`(담당자 없음)이 사이클의 첫 칸이다.

```ts
  // 단독 선택 사이클 — 일반(비-Ctrl) 클릭과 같은 계약이다. "me" 모드에서 빈
  // assigneeIds는 "나"를 뜻하므로 아무도 안 골랐으면 본인 자리에서 출발한다.
  // "none" 모드에서는 "담당자 없음"(null)이 사이클에 실제 한 칸으로 들어간다.
  attachWheelCycle(
    chipAssignee,
    () => (ctx.emptyAssignee === "none" ? state.members.length + 1 : state.members.length),
    (delta) => {
      if (ctx.emptyAssignee === "none") {
        const options: (Member | null)[] = [null, ...state.members];
        const currentId = state.assigneeIds[0] ?? null;
        const i = options.findIndex((m) => (m?.id ?? null) === currentId);
        const next = options[((i === -1 ? 0 : i) + delta + options.length) % options.length];
        state.assigneeIds = next ? [next.id] : [];
      } else {
        const meIndex = state.members.findIndex((m) => m.is_me);
        const currentId = state.assigneeIds[0] ?? state.members[meIndex]?.id;
        const i = state.members.findIndex((m) => m.id === currentId);
        const next = state.members[((i === -1 ? meIndex : i) + delta + state.members.length) % state.members.length];
        setSingleAssignee(state, next, ctx.emptyAssignee);
      }
      renderChips();
      if (openPopover === "assignee") openAssigneePopover();
    },
  );
```

- [ ] **Step 6: 설명 제어를 핸들에 노출한다**

`setDescVisible`을 `focus` 인자를 받도록 바꾼다:

```ts
  // Hiding only hides — typed text stays in the textarea and is still submitted,
  // so toggling off and back on never loses a draft.
  let descVisible = false;
  function setDescVisible(visible: boolean, focus = true) {
    descVisible = visible;
    descriptionEl.hidden = !visible;
    chipDesc.classList.toggle("active", visible);
    chipDesc.title = visible ? "설명 숨기기" : "설명 추가";
    autoResizeDescription();
    if (visible && focus) descriptionEl.focus();
  }
```

`chipDesc`는 `HTMLElement`로 잡혀 있어 `disabled`를 쓸 수 없다. 선언 줄을 고친다:

```ts
  const chipDesc = hosts.fields.querySelector("#chipDesc") as HTMLButtonElement;
```

반환 객체에 두 메서드를 더한다:

```ts
    setDescriptionVisible: (visible: boolean, focus = true) => setDescVisible(visible, focus),
    setDescriptionEnabled: (enabled: boolean) => {
      chipDesc.disabled = !enabled;
      if (!enabled) chipDesc.title = "설명 불러오는 중…";
      else chipDesc.title = descVisible ? "설명 숨기기" : "설명 추가";
    },
```

- [ ] **Step 7: 빌드로 타입을 확인한다**

Run: `pnpm build`
Expected: FAIL — `src/quickadd/main.ts`의 `ctx` 객체에 `emptyAssignee`가 없다는 에러. 다음 단계에서 채운다.

- [ ] **Step 8: 빠른 추가의 컨텍스트에 모드를 넣는다**

`src/quickadd/main.ts`의 `const ctx: LayoutContext = {` 블록에 한 줄 더한다 (Task 5에서 이 파일은 다시 쓰이지만, 지금 단계에서도 빌드가 통과해야 한다).

```ts
  emptyAssignee: "me",
```

- [ ] **Step 9: 빌드와 테스트를 확인한다**

Run: `pnpm build && pnpm test`
Expected: 둘 다 PASS

- [ ] **Step 10: 커밋**

```bash
git add src/shared/issueForm/layout.ts src/shared/issueForm/layoutCompact.ts src/quickadd/main.ts
git commit -m "feat: 컴팩트 레이아웃이 emptyAssignee 모드를 따른다"
```

---

## Task 4: 한눈에 보기 레이아웃이 `emptyAssignee`를 따르게 한다

**Files:**
- Modify: `src/shared/issueForm/layoutExpanded.ts`

- [ ] **Step 1: 담당자 표시를 공통 함수로 바꾼다**

임포트에 추가:

```ts
import { isAssigned as isAssignedIn, personChipLabel } from "./assigneeDisplay";
```

파일 안의 지역 함수 `isAssigned`(131~134줄)를 지우고, 쓰는 자리를 아래처럼 바꾼다. 이름이 겹치지 않도록 임포트에 별칭을 썼다.

```ts
  function isAssignedHere(m: Member): boolean {
    return isAssignedIn(ctx.emptyAssignee, m, state.assigneeIds);
  }
```

- [ ] **Step 2: 담당자 행에 "없음" 칩을 더한다**

`renderPeople`을 통째로 바꾼다. `"none"` 모드에서만 첫 칸에 "없음" 칩이 붙고, 그만큼 인라인 칸을 하나 줄여 폭을 맞춘다.

```ts
  function renderPeople() {
    requestMembers();
    // "없음" 칩이 한 칸을 먹으므로 인라인 칸을 하나 줄인다 — 그러지 않으면 660px에
    // 칩 다섯이 들어가 "+N"이 밀린다.
    const slots = ASSIGNEE_SLOTS - (ctx.emptyAssignee === "none" ? 1 : 0);
    const { inline, overflow } = splitAssigneeSlots(state.members, state.assigneeIds, slots);
    peopleEl.innerHTML = "";

    // 고칠 때는 "아무도 지정 안 됨"이 실제 상태다 — 팝오버를 열지 않고 이 칸 하나로
    // 되돌릴 수 있어야 한다. 만들 때(빠른 추가)는 비우면 나에게 가므로 이 칩이 없다.
    if (ctx.emptyAssignee === "none") {
      const noneChip = document.createElement("button");
      noneChip.type = "button";
      noneChip.className = "person" + (state.assigneeIds.length === 0 ? " on" : "");
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = "-";
      noneChip.appendChild(avatar);
      noneChip.appendChild(document.createTextNode(" 없음"));
      noneChip.addEventListener("click", () => {
        state.assigneeIds = [];
        render();
        ctx.focusTitle();
      });
      peopleEl.appendChild(noneChip);
    }

    for (const m of inline) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "person" + (isAssignedHere(m) ? " on" : "");
      chip.dataset.memberId = m.id;
      chip.appendChild(avatarOf(m));
      chip.appendChild(document.createTextNode(" " + personChipLabel(ctx.emptyAssignee, m)));
      chip.addEventListener("click", (e) => handlePersonClick(e, m));
      peopleEl.appendChild(chip);
    }

    let moreBtn: HTMLElement | null = null;
    if (overflow.length > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "person more";
      more.innerHTML = `<span class="cnt">+${overflow.length}</span>`;
      more.addEventListener("click", () => {
        if (peoplePop.hidden) {
          fillPeoplePop(more, overflow);
          initKeyboardFocus(peoplePop);
          peoplePop.hidden = false;
          ctx.onResize();
        } else {
          closePeoplePop();
        }
      });
      // "+N" 버튼에 포커스가 있는 동안만 반응한다 — dd-item은 실제 DOM 포커스를
      // 받지 않고 .kbd-focus 표시만 옮겨 다니므로(컴팩트 레이아웃의 담당자
      // 팝오버와 같은 방식), 키 이벤트는 이 버튼에서만 잡힌다.
      more.addEventListener("keydown", (e) => {
        if (peoplePop.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveKeyboardFocus(peoplePop, e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter" && !e.ctrlKey) {
          e.preventDefault();
          selectKeyboardFocus(peoplePop);
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePeoplePop();
          more.focus();
        }
      });
      peopleEl.appendChild(more);
      moreBtn = more;
    }

    // 팝오버를 열어둔 채 고르면 "+N" 버튼이 새로 만들어지므로 목록과 위치를 다시
    // 잡는다. 접힐 사람이 남지 않았으면 띄워둘 것도 없다.
    if (!peoplePop.hidden) {
      if (moreBtn) fillPeoplePop(moreBtn, overflow);
      else peoplePop.hidden = true;
      ctx.onResize();
    }

    assigneeHint.textContent =
      state.assigneeIds.length >= 2 ? `${state.assigneeIds.length}명 지정됨` : "Ctrl+클릭 다중";
  }
```

- [ ] **Step 3: 단독 선택 경로에 모드를 넘긴다**

`handlePersonClick` 안의 호출을 고친다:

```ts
    setSingleAssignee(state, m, ctx.emptyAssignee);
```

- [ ] **Step 4: 설명 제어를 핸들에 노출한다**

`descToggle` 선언을 `HTMLButtonElement`로 바꾼다:

```ts
  const descToggle = hosts.titleTrailing.querySelector<HTMLButtonElement>("[data-desc-toggle]")!;
```

`setDescVisible`에 `focus` 인자를 더한다:

```ts
  // 숨기기는 숨기기일 뿐이다 — 입력한 글은 textarea에 남아 그대로 등록된다.
  let descVisible = false;
  function setDescVisible(visible: boolean, focus = true) {
    descVisible = visible;
    descriptionEl.hidden = !visible;
    descToggle.classList.toggle("on", visible);
    autoResizeDescription();
    if (visible && focus) descriptionEl.focus();
  }
```

반환 객체에 두 메서드를 더한다:

```ts
    setDescriptionVisible: (visible: boolean, focus = true) => setDescVisible(visible, focus),
    setDescriptionEnabled: (enabled: boolean) => {
      descToggle.disabled = !enabled;
      descToggle.title = enabled ? "" : "설명 불러오는 중…";
    },
```

- [ ] **Step 5: 빌드와 테스트를 확인한다**

Run: `pnpm build && pnpm test`
Expected: 둘 다 PASS

- [ ] **Step 6: 빠른 추가를 실행해 회귀가 없는지 본다**

Run: `pnpm tauri dev`
확인:
- 빠른 추가에서 컴팩트/한눈에 보기 전환이 그대로다
- 담당자 칩이 "나"로 뜨고, 팝오버 본인 행에 "(나)"가 붙는다
- 담당자 휠 굴리기, Ctrl+클릭 다중, 팝오버 방향키·Space·Enter가 그대로다

- [ ] **Step 7: 커밋**

```bash
git add src/shared/issueForm/layoutExpanded.ts
git commit -m "feat: 한눈에 보기 레이아웃이 emptyAssignee 모드를 따른다"
```

---

## Task 5: 카드 셸을 만들고 빠른 추가를 그 위로 옮긴다

이 태스크의 성공 기준은 **"빠른 추가가 완전히 그대로"** 다. 새 기능은 없다.

**Files:**
- Create: `src/shared/issueForm/card.ts`
- Modify: `src/quickadd/index.html`
- Modify: `src/quickadd/main.ts`
- Modify: `src/shared/app.css`

- [ ] **Step 1: 카드 셸을 쓴다**

`src/shared/issueForm/card.ts`:

```ts
import { resolveDateShortcut } from "../dateShortcut";
import type { Priority, StateGroup } from "../planeIcons";
import { createFormState, shiftDateField, type FormState } from "./state";
import type { EmptyAssignee } from "./assigneeDisplay";
import type { LayoutHandle, LayoutHosts, LayoutContext } from "./layout";
import { mountCompact } from "./layoutCompact";
import { mountExpanded } from "./layoutExpanded";

export type LayoutKind = "compact" | "expanded";

/** 설정 문자열을 레이아웃 이름으로 좁힌다. 모르는 값은 컴팩트다. */
export function layoutKindOf(setting: string): LayoutKind {
  return setting === "expanded" ? "expanded" : "compact";
}

/** 폼에 한꺼번에 채워 넣을 값. 할 일 수정이 스냅샷·상세로 두 번 부른다. */
export interface IssueFormFields {
  name: string;
  assigneeIds: string[];
  /** ISO yyyy-mm-dd. 없으면 빈 값으로 둔다. */
  startDate: string | null;
  targetDate: string | null;
  priority: Priority;
  stateGroup: StateGroup;
}

export interface IssueCardOptions {
  /** 카드를 넣을 자리. */
  root: HTMLElement;
  /** 헤더 제목. */
  title: string;
  titlePlaceholder: string;
  /** 헤더를 Tauri 드래그 영역으로 쓸 것인가. */
  draggable: boolean;
  /** 담당자가 비었을 때의 뜻 — assigneeDisplay.ts 참고. */
  emptyAssignee: EmptyAssignee;
  /** 레이아웃 토글과 닫기 버튼 사이에 꽂을 버튼들. */
  headerExtra?: HTMLElement[];
  /** 창별 푸터. 셸은 자리만 내주고 내용은 만들지 않는다. */
  footer: HTMLElement;
  /** 담당자 목록을 받아 state.members를 채운다. 실패해도 resolve해야 한다. */
  loadMembers: () => Promise<void>;
  /** 사용자가 헤더 토글로 레이아웃을 바꿨다 — 설정에 저장할 기회.
   *  setLayout()으로 바꿀 때는 부르지 않는다(설정에서 온 값을 되쓰지 않기 위해서다). */
  onLayoutChange: (kind: LayoutKind) => void;
  /** 내용 크기가 바뀌었다. 창 크기는 창이 정한다 — 셸은 창을 모른다. */
  onResize: (width: number, height: number) => void;
  /** Ctrl+Enter. 빠른 추가는 등록, 할 일 수정은 저장. */
  onSubmit: () => void;
  /** 닫기 버튼, 또는 열린 팝오버가 없을 때의 Esc. */
  onClose: () => void;
}

export interface IssueCardHandle {
  /** 카드 요소(.popup). 창이 코치마크 같은 것을 얹을 때 쓴다. */
  readonly element: HTMLElement;
  /** 제목 입력. 창이 자기만의 키 처리를 붙일 때 쓴다. */
  readonly titleElement: HTMLInputElement;
  readonly state: FormState;
  readonly layoutKind: LayoutKind;
  readonly layoutWidth: number;

  render(): void;
  /** 레이아웃을 갈아끼운다. onLayoutChange는 부르지 않는다. */
  setLayout(kind: LayoutKind): void;

  titleValue: string;
  descriptionValue: string;
  /** 제목·담당자·날짜·상태·우선순위를 한꺼번에 채운다. 설명은 건드리지 않는다. */
  setValues(fields: IssueFormFields): void;
  setDescriptionVisible(visible: boolean, focus?: boolean): void;
  setDescriptionEnabled(enabled: boolean): void;
  /** 폼 본문(제목·설명·필드·에러)을 통째로 감춘다. 로딩 중에 쓴다. */
  setBodyVisible(visible: boolean): void;

  markTitleError(): void;
  clearTitleError(): void;
  showError(message: string): void;
  clearError(): void;

  closeOverlays(): void;
  hasOpenOverlay(): boolean;
  /** 등록 성공 후 화면만 되돌린다(설명 접기, 팝오버 닫기). 값은 state가 따로 되돌린다. */
  resetView(): void;
  /** 카드 밖으로 떠 있는 것까지 포함한 내용 높이. */
  contentHeight(): number;
}

const GRIP_SVG =
  `<svg class="qa-grip" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>` +
  `<circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>` +
  `<circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>`;

const COMPACT_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<rect x="1.5" y="9.5" width="8" height="5" rx="2"/><rect x="11" y="9.5" width="6" height="5" rx="2"/>` +
  `<rect x="18.5" y="9.5" width="4" height="5" rx="2"/></svg>`;

const EXPANDED_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<rect x="2" y="4" width="5" height="3.4" rx="1.2"/><rect x="9" y="4" width="13" height="3.4" rx="1.2"/>` +
  `<rect x="2" y="10.3" width="5" height="3.4" rx="1.2"/><rect x="9" y="10.3" width="13" height="3.4" rx="1.2"/>` +
  `<rect x="2" y="16.6" width="5" height="3.4" rx="1.2"/><rect x="9" y="16.6" width="13" height="3.4" rx="1.2"/></svg>`;

const CLOSE_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">` +
  `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;

/** 두 창이 함께 쓰는 카드. 헤더 액션과 푸터만 바깥에서 꽂는다. */
export function mountIssueCard(options: IssueCardOptions): IssueCardHandle {
  const drag = options.draggable ? " data-tauri-drag-region" : "";
  options.root.innerHTML =
    `<div class="popup">
      <div class="qa-header"${drag}>
        ${GRIP_SVG}
        <span class="qa-header-title">${options.title}</span>
        <div class="qa-layout-toggle" data-layout-toggle role="group" aria-label="화면 모양">
          <button type="button" data-layout="compact" aria-label="컴팩트">${COMPACT_ICON}</button>
          <button type="button" data-layout="expanded" aria-label="한눈에 보기">${EXPANDED_ICON}</button>
        </div>
        <span data-header-extra></span>
        <button type="button" class="qa-close" data-close aria-label="닫기 (Esc)">${CLOSE_SVG}</button>
      </div>
      <div data-body>
        <div class="popup-top"${drag}>
          <div class="accent-bar"${drag}></div>
          <input class="title-input" data-title />
          <span data-title-trailing></span>
        </div>
        <textarea class="description-input" data-description placeholder="설명을 입력하세요…" rows="1" hidden></textarea>
        <div data-fields></div>
        <p class="form-error" data-error hidden></p>
      </div>
    </div>`;

  const card = options.root.querySelector<HTMLElement>(".popup")!;
  const header = card.querySelector<HTMLElement>(".qa-header")!;
  const layoutToggle = card.querySelector<HTMLElement>("[data-layout-toggle]")!;
  const headerExtra = card.querySelector<HTMLElement>("[data-header-extra]")!;
  const closeBtn = card.querySelector<HTMLElement>("[data-close]")!;
  const bodyEl = card.querySelector<HTMLElement>("[data-body]")!;
  const titleEl = card.querySelector<HTMLInputElement>("[data-title]")!;
  const descriptionEl = card.querySelector<HTMLTextAreaElement>("[data-description]")!;
  const errorEl = card.querySelector<HTMLElement>("[data-error]")!;

  titleEl.placeholder = options.titlePlaceholder;
  for (const el of options.headerExtra ?? []) headerExtra.appendChild(el);
  // 헤더의 버튼들은 드래그 영역 위에 있다 — data-tauri-drag-region이 없는 자식은
  // 클릭이 그대로 먹으므로 따로 손댈 것이 없다(.qa-header CSS 주석 참고).
  card.appendChild(options.footer);

  const state = createFormState();

  const hosts: LayoutHosts = {
    titleTrailing: card.querySelector<HTMLElement>("[data-title-trailing]")!,
    fields: card.querySelector<HTMLElement>("[data-fields]")!,
    description: descriptionEl,
  };

  const ctx: LayoutContext = {
    state,
    emptyAssignee: options.emptyAssignee,
    onResize: () => emitResize(),
    loadMembers: options.loadMembers,
    focusTitle: () => titleEl.focus(),
  };

  let layoutKind: LayoutKind = "compact";
  let layout: LayoutHandle = mountCompact(hosts, ctx);

  function contentHeight(): number {
    return Math.max(Math.ceil(card.getBoundingClientRect().height), layout.overlayBottom());
  }

  function emitResize() {
    options.onResize(layout.width, contentHeight());
  }

  function renderToggle() {
    layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
      const on = btn.dataset.layout === layoutKind;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  /** 폼 상태는 state에 있고 제목·설명은 입력칸에 있으므로, 갈아끼워도 작성 중이던
   *  내용은 그대로 살아남는다. */
  function setLayout(kind: LayoutKind) {
    if (kind === layoutKind) {
      renderToggle();
      return;
    }
    layout.destroy();
    layoutKind = kind;
    layout = kind === "expanded" ? mountExpanded(hosts, ctx) : mountCompact(hosts, ctx);
    layout.render();
    renderToggle();
    emitResize();
  }

  layoutToggle.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = layoutKindOf(btn.dataset.layout ?? "");
      if (kind === layoutKind) return;
      setLayout(kind);
      options.onLayoutChange(kind);
      titleEl.focus();
    });
  });

  closeBtn.addEventListener("click", () => {
    if (layout.hasOpenOverlay()) layout.closeOverlays();
    options.onClose();
  });

  // 제출키는 어디에 커서가 있든 Ctrl+Enter다 — 항목을 넣거나 고치는 일이 포커스
  // 위치에 딸리지 않는다. 그냥 Enter는 각 컨트롤의 본래 역할(팝오버 선택, 버튼
  // 누르기, 줄바꿈)로 남는다. 날짜 단축키는 팝오버가 열려 있으면 비켜선다 —
  // 팝오버의 키보드 계약을 밟지 않기 위해서다.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      if (layout.hasOpenOverlay()) layout.closeOverlays();
      options.onSubmit();
      return;
    }
    if (e.key === "Escape") {
      if (layout.hasOpenOverlay()) {
        layout.closeOverlays();
        return;
      }
      options.onClose();
      return;
    }
    const shortcut = resolveDateShortcut(e.key, e.ctrlKey);
    if (shortcut && !layout.hasOpenOverlay()) {
      e.preventDefault();
      shiftDateField(state, shortcut.kind, shortcut.delta);
      layout.render();
    }
  });

  renderToggle();
  layout.render();

  return {
    element: card,
    titleElement: titleEl,
    state,
    get layoutKind() { return layoutKind; },
    get layoutWidth() { return layout.width; },

    render: () => layout.render(),
    setLayout,

    get titleValue() { return titleEl.value; },
    set titleValue(v: string) { titleEl.value = v; },
    get descriptionValue() { return descriptionEl.value; },
    set descriptionValue(v: string) { descriptionEl.value = v; },

    setValues: (fields: IssueFormFields) => {
      titleEl.value = fields.name;
      state.assigneeIds = [...fields.assigneeIds];
      // 고칠 때는 저장된 날짜를 그대로 보여야 한다 — 프리셋 이름("오늘")으로 바꾸면
      // 같은 날이라도 저장 시점의 값이 아니라 여는 시점의 값이 된다.
      state.startChoice = "custom";
      state.startCustomDate = fields.startDate ?? "";
      state.dueChoice = "custom";
      state.dueCustomDate = fields.targetDate ?? "";
      state.priority = fields.priority;
      state.stateGroup = fields.stateGroup;
      layout.render();
    },
    setDescriptionVisible: (visible, focus) => layout.setDescriptionVisible(visible, focus),
    setDescriptionEnabled: (enabled) => layout.setDescriptionEnabled(enabled),
    setBodyVisible: (visible: boolean) => {
      bodyEl.hidden = !visible;
      emitResize();
    },

    markTitleError: () => titleEl.classList.add("error"),
    clearTitleError: () => titleEl.classList.remove("error"),
    showError: (message: string) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
      emitResize();
    },
    clearError: () => {
      if (errorEl.hidden) return;
      errorEl.hidden = true;
      errorEl.textContent = "";
      emitResize();
    },

    closeOverlays: () => layout.closeOverlays(),
    hasOpenOverlay: () => layout.hasOpenOverlay(),
    resetView: () => layout.resetView(),
    contentHeight,
  };
}
```

- [ ] **Step 2: 빠른 추가 HTML을 카드 자리 + 템플릿으로 줄인다**

`src/quickadd/index.html`을 통째로 아래로 바꾼다.

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>빠른 추가</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <!-- 카드(헤더·제목·설명·필드·에러)는 shared/issueForm/card.ts가 그린다.
         이 파일에는 이 창에만 있는 것 — 푸터와 안내 말풍선 — 만 둔다. -->
    <div id="cardHost"></div>

    <template id="qaFooter">
      <div class="popup-bottom">
        <button id="projBtn" class="proj-select" type="button">
          <span id="projDot" class="dot"></span>
          <span data-proj-name id="projName">프로젝트 선택</span>
          <span class="chev">▾</span>
        </button>
        <button type="button" id="qaSubmit" class="qa-submit">추가 <span class="bk">Ctrl+↵</span></button>
      </div>
    </template>

    <!-- 업데이트 후 첫 안내. 제목 입력을 막지 않도록 카드 위에 겹쳐 뜨기만 하고
         포커스는 가져가지 않는다 (main.ts의 코치마크 로직 참고). -->
    <template id="qaCoach">
      <div class="qa-coach" hidden>
        <div class="qa-coach-head">✨ 새로워졌어요</div>
        <p>담당자·상태·우선순위·날짜를 <b>접지 않고 한 화면에</b> 펼쳐 보는 모양이 생겼습니다. 여기서 바로 바꿀 수 있어요.</p>
        <div class="qa-coach-foot">
          <button type="button" id="qaCoachOk" class="qa-coach-ok">알겠어요</button>
        </div>
      </div>
    </template>

    <div id="qaTip" class="qa-tip" hidden></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: 빠른 추가 `main.ts`를 셸 위로 옮긴다**

`src/quickadd/main.ts`를 통째로 아래로 바꾼다.

```ts
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { createIssue, listProjects, listMembers, getSettings, setQuickaddLayout } from "../shared/ipc";
import type { Project } from "../shared/types";
import { applyTheme } from "../shared/theme";
import { isWithinCooldown } from "../shared/cooldown";
import { bindTip } from "../shared/tooltip";
import { createProjectPicker } from "./projectPicker";
import { resolveDateChoice, resetFormFields } from "../shared/issueForm/state";
import { mountIssueCard, layoutKindOf, type LayoutKind } from "../shared/issueForm/card";
import "../shared/app.css";

// Every window focus reloads the project list from the Plane API; a cooldown keeps rapid
// re-focusing (alt-tab cycling) from adding to the sidebar's own request bursts against the
// same rate-limited server.
const LOAD_COOLDOWN_MS = 3000;
let lastLoadAt = 0;

const win = getCurrentWindow();

function cloneTemplate(id: string): HTMLElement {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
}

const footer = cloneTemplate("qaFooter");
const coachEl = cloneTemplate("qaCoach");
const projBtn = footer.querySelector<HTMLElement>("#projBtn")!;
const qaSubmit = footer.querySelector<HTMLElement>("#qaSubmit")!;
const coachOk = coachEl.querySelector<HTMLElement>("#qaCoachOk")!;

let projects: Project[] = [];

const card = mountIssueCard({
  root: document.getElementById("cardHost")!,
  title: "빠른 추가",
  titlePlaceholder: "진행 중인 작업을 입력하고 Ctrl+Enter…",
  draggable: true,
  emptyAssignee: "me",
  footer,
  loadMembers: async () => {
    // 어느 프로젝트에 대한 요청인지 await 전에 붙잡아 둔다. 응답이 오는 사이 사용자가
    // 프로젝트를 바꿨다면 늦게 온 목록은 버린다 — 그대로 넣으면 A의 담당자가 B의
    // 목록으로 둔갑하고, membersLoadedForProject까지 B로 찍혀 되돌릴 길이 없어진다.
    const id = card.state.selectedId;
    if (!id || card.state.membersLoadedForProject === id) return;
    try {
      const members = await listMembers(id);
      if (card.state.selectedId !== id) return;
      card.state.members = members;
      card.state.membersLoadedForProject = id;
    } catch (err) {
      if (card.state.selectedId !== id) return;
      card.state.members = [];
      console.error("listMembers failed:", err);
    }
  },
  onLayoutChange: (kind) => {
    dismissCoach(true); // 토글을 직접 만졌으면 안내는 제 역할을 다한 것이다
    // 설정 화면의 "빠른 추가 화면"과 같은 값이다 — 저장해 두지 않으면 다음에 열 때
    // 설정값으로 되돌아간다.
    setQuickaddLayout(kind).catch((err) => console.error("setQuickaddLayout failed:", err));
    // 창 폭이 540↔660으로 달라져 토글도 옮겨간다 — 안내가 떠 있으면 화살표가 엉뚱한
    // 곳을 가리키지 않게 다시 맞춘다.
    if (!coachEl.hidden) positionCoach();
  },
  onResize: (width, height) => {
    const h = Math.max(height, coachBottom()) + 4; // 테두리 한 픽셀이 잘리지 않게 여유
    win.setSize(new LogicalSize(width, h)).catch((err) => {
      console.error("setSize failed:", err);
    });
  },
  onSubmit: () => { submitIssue(); },
  onClose: () => {
    dismissCoach(false);
    win.hide();
  },
});

// 코치마크는 카드 기준으로 배치된다 — 카드가 위치 기준 조상이어야 한다.
card.element.appendChild(coachEl);

// 누르면 프로젝트 검색 창이 열린다. 고른 결과는 아래 `select-project` 리스너로 온다.
const projectPicker = createProjectPicker({
  button: projBtn,
  getProjects: () => projects,
  getSelectedId: () => card.state.selectedId,
});

bindTip(card.element.querySelector('[data-layout="compact"]')!, "컴팩트 — 칩을 눌러 값 바꾸기", "below");
bindTip(card.element.querySelector('[data-layout="expanded"]')!, "한눈에 보기 — 모든 항목 펼쳐 보기", "below");
bindTip(card.element.querySelector("[data-close]")!, "닫기 <kbd>Esc</kbd>", "below");

/* ---- 업데이트 후 첫 안내 ----
   헤더 토글이 새로 생겼다는 것을 알린다. 앱 실행당 최대 한 번, 통틀어 2번까지만 뜬다 —
   무시하고 지나간 사람에게 한 번 더 기회를 주되 계속 따라다니지는 않는다.
   본 횟수는 화면 취향이라 백엔드 설정이 아니라 이 창의 localStorage에 둔다
   (사이드바가 접힘 상태를 두는 방식과 같다). */
const COACH_KEY = "qa-layout-coach-shown";
const COACH_MAX = 2;
// 창은 트레이에 살아 있어 포커스가 여러 번 오간다 — 실행당 한 번만 세게 하는 빗장.
let coachShownThisRun = false;

function coachSeenCount(): number {
  return Number(localStorage.getItem(COACH_KEY)) || 0;
}

/** `done`이면 다시 뜨지 않게 잠근다(알겠어요·토글 조작). 창을 닫을 때처럼 그냥
 *  치우는 경우에는 false — 남은 횟수를 까먹지 않는다. */
function dismissCoach(done: boolean) {
  if (done) localStorage.setItem(COACH_KEY, String(COACH_MAX));
  if (coachEl.hidden) return;
  coachEl.hidden = true;
  card.element.querySelector("[data-layout-toggle]")!.classList.remove("spotlight");
  resizeWindow();
}

function maybeShowCoach() {
  if (coachShownThisRun || coachSeenCount() >= COACH_MAX) return;
  coachShownThisRun = true;
  localStorage.setItem(COACH_KEY, String(coachSeenCount() + 1));
  coachEl.hidden = false;
  card.element.querySelector("[data-layout-toggle]")!.classList.add("spotlight");
  positionCoach();
  resizeWindow();
}

/** 화살표가 토글 한가운데를 가리키게 맞춘다. 카드 폭이 레이아웃에 따라 달라지므로
 *  띄울 때마다 다시 잰다. 좌우로는 카드 안에 머물게 물린다. */
function positionCoach() {
  const toggle = card.element.querySelector<HTMLElement>("[data-layout-toggle]")!;
  const t = toggle.getBoundingClientRect();
  const p = card.element.getBoundingClientRect();
  const centre = t.left - p.left + t.width / 2;
  const left = Math.max(8, Math.min(centre - coachEl.offsetWidth / 2, p.width - coachEl.offsetWidth - 8));
  coachEl.style.left = `${left}px`;
  coachEl.style.top = `${t.bottom - p.top + 10}px`;
  coachEl.style.setProperty("--arrow", `${centre - left - 6}px`);
}

function coachBottom(): number {
  return coachEl.hidden ? 0 : Math.ceil(coachEl.getBoundingClientRect().bottom);
}

/** 코치마크를 넣고 뺄 때처럼 카드 밖 요소만 바뀐 경우에도 창 크기를 다시 잡는다. */
function resizeWindow() {
  const h = Math.max(card.contentHeight(), coachBottom()) + 4;
  win.setSize(new LogicalSize(card.layoutWidth, h)).catch((err) => {
    console.error("setSize failed:", err);
  });
}

coachOk.addEventListener("click", () => {
  dismissCoach(true);
  card.titleElement.focus();
});

// Ctrl+Enter and the submit button can fire while a create request is still in flight;
// without this guard each extra press files the same issue again.
let submitting = false;

async function submitIssue() {
  if (submitting) return;
  const name = card.titleValue.trim();
  if (!name) {
    card.markTitleError();
    card.showError("제목을 입력하세요");
    return;
  }
  if (!card.state.selectedId) {
    card.showError("프로젝트를 선택하세요");
    return;
  }
  submitting = true;
  try {
    await createIssue(
      card.state.selectedId,
      name,
      card.state.assigneeIds,
      resolveDateChoice(card.state.startChoice, card.state.startCustomDate),
      resolveDateChoice(card.state.dueChoice, card.state.dueCustomDate),
      card.state.priority,
      card.state.stateGroup,
      card.descriptionValue,
    );
    card.titleValue = "";
    resetFields();
    await win.hide();
  } catch (err) {
    card.markTitleError();
    card.showError("등록 실패: " + err);
    console.error(err);
  } finally {
    submitting = false;
  }
}

function resetFields() {
  resetFormFields(card.state);
  card.descriptionValue = "";
  dismissCoach(false); // 등록하고 창이 숨으므로 안내도 함께 치운다
  card.resetView();
  card.render();
  card.clearError();
}

async function load() {
  lastLoadAt = Date.now();
  // 설정은 로컬 파일이라 바로 온다. 프로젝트 목록(Plane API)과 한데 묶어 기다리면
  // 네트워크가 느릴 때 큰 창으로 쓰던 사용자에게 작은 창이 먼저 뜨고 뒤늦게 넓어진다
  // — 모양은 기다릴 이유가 없으므로 먼저 적용한다.
  const settings = await getSettings();
  applyTheme(settings.theme);
  card.setLayout(layoutKindOf(settings.quickadd_layout));

  const fetched = await listProjects().catch(() => []);
  projects = fetched;
  card.state.selectedId = settings.last_project_id ?? projects[0]?.id ?? null;
  projectPicker.render();
  // 프로젝트가 방금 정해졌다 — 한눈에 보기의 담당자 행은 이 값에 딸려 있으므로
  // 여기서 한 번 더 그려야 목록을 받아온다.
  card.render();
}

/** Flashes the submit button — plain Enter no longer submits, so this teaches Ctrl+Enter. */
function pulseSubmit() {
  qaSubmit.classList.remove("pulse");
  void (qaSubmit as HTMLElement).offsetWidth; // restart the animation on rapid presses
  qaSubmit.classList.add("pulse");
}

card.titleElement.addEventListener("keydown", (e) => {
  card.clearTitleError();
  if (e.key !== "Enter") card.clearError();
  if (e.key === "Enter" && !e.ctrlKey) {
    e.preventDefault();
    pulseSubmit();
  }
});

qaSubmit.addEventListener("click", () => { submitIssue(); });

// Focus fires both when the window is summoned and when the user merely clicks
// back into the still-open window, so it must never touch the draft — a draft
// is cleared only by a successful submit (see submitIssue). Focus just parks
// the cursor and refreshes the project list (cooldown-gated).
win.listen("tauri://focus", () => {
  card.titleElement.focus();
  if (!isWithinCooldown(lastLoadAt, Date.now(), LOAD_COOLDOWN_MS)) load();
  // 안내는 여기서만 띄운다 — 부팅 때 도는 load()는 창이 아직 숨어 있어서, 거기서
  // 띄우면 사용자가 못 본 채 남은 횟수만 깎인다.
  maybeShowCoach();
});

// 프로젝트가 이 창 밖에서 정해지는 두 경로가 같은 이벤트로 들어온다 — 사이드바의
// 프로젝트별 "+" 버튼(show_quickadd_for_project)과 프로젝트 검색 창(pick_project).
// 작성 중이던 초안은 그대로 살아남고, 프로젝트에 딸린 선택(담당자)만 리셋한다.
win.listen<string>("select-project", (e) => {
  card.state.selectedId = e.payload;
  card.state.members = [];
  card.state.membersLoadedForProject = null;
  card.state.assigneeIds = [];
  projectPicker.render();
  card.render();
});

// 설정 창이 저장하면 즉시 반영한다 — 이 창은 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
});

card.titleElement.focus();
resizeWindow();
load();
```

- [ ] **Step 4: CSS를 새 셀렉터에 맞춘다**

`src/shared/app.css`에서 세 곳을 고친다.

`#titleTrailing:empty` 규칙(90~92줄 근처)을 속성 셀렉터로 바꾼다 — id는 이제 셸이 붙이지 않는다.

```css
/* 제목 줄 오른쪽 자리는 레이아웃이 채운다 — 비어 있으면 flex gap까지 사라지게
   숨긴다. 안 그러면 아무것도 없는데 제목 입력이 12px 좁아진다. */
[data-title-trailing]:empty { display: none; }
```

`.popup` 규칙에서 화면 기준 좌표를 뺀다 — 카드가 창을 통째로 채우므로 의미가 없고, 빠른 추가가 인라인 스타일로 덮고 있던 것이다.

```css
.popup {
  width: 100%; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius);
  position: relative; z-index: 30; overflow: visible;
}
```

`.em-error` 규칙(894줄 근처)의 이름을 `.form-error`로 바꾼다 — 두 창이 함께 쓰는 것이 되었다.

```css
.form-error { color: var(--red); font-size: 12px; margin: 0; padding: 0 18px 12px; }
```

- [ ] **Step 5: 빌드와 테스트를 확인한다**

Run: `pnpm build && pnpm test`
Expected: 둘 다 PASS

- [ ] **Step 6: 빠른 추가가 그대로인지 손으로 확인한다**

Run: `pnpm tauri dev`
확인 항목 — 하나라도 어긋나면 다음 태스크로 넘어가지 않는다:
- 창이 열리면 제목에 커서가 있고, 카드 폭·높이가 예전과 같다
- 헤더를 끌면 창이 움직인다
- 레이아웃 토글 두 버튼, 각 툴팁, 전환 시 창 폭 540↔660
- 컴팩트: 칩 다섯 개 팝오버 열기/닫기, 방향키 이동, 휠 굴리기
- 한눈에 보기: 담당자 행, "+N" 팝오버, 날짜 스테퍼, PgUp/Dn
- 설명 토글 → 입력 → 접기 → 다시 펴면 글이 남아 있다
- 프로젝트 선택 창 열기 → 고르면 반영된다
- 제목 비우고 Ctrl+Enter → "제목을 입력하세요" 에러 줄
- 정상 등록 → 창이 닫히고 다시 열면 폼이 비어 있다
- Esc로 닫힌다. 팝오버가 열려 있으면 Esc가 팝오버부터 닫는다
- 그냥 Enter를 치면 추가 버튼이 두 번 깜빡인다

- [ ] **Step 7: 커밋**

```bash
git add src/shared/issueForm/card.ts src/quickadd src/shared/app.css
git commit -m "refactor: 빠른 추가를 공통 카드 셸 위로 옮긴다"
```

---

## Task 6: 할 일 수정을 카드 셸로 갈아끼운다

**Files:**
- Modify: `src/editmodal/index.html`
- Modify: `src/editmodal/main.ts`

- [ ] **Step 1: 수정 창 HTML을 카드 자리 + 템플릿으로 바꾼다**

`src/editmodal/index.html`을 통째로 아래로 바꾼다. 로딩 문구·헤더 버튼·푸터가 템플릿으로 빠지고, 카드는 셸이 그린다.

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>할 일 수정</title>
    <link rel="stylesheet" href="../shared/app.css" />
  </head>
  <body class="transparent-body">
    <!-- 카드(헤더·제목·설명·필드·에러)는 shared/issueForm/card.ts가 그린다.
         이 파일에는 이 창에만 있는 것 — 브라우저 열기 버튼, 로딩 문구, 푸터 — 만 둔다. -->
    <div id="cardHost"></div>

    <template id="emBrowser">
      <button type="button" class="em-browser-btn" id="emBrowserBtn" aria-label="브라우저에서 열기">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>
        </svg>
      </button>
    </template>

    <template id="emFooter">
      <div class="popup-bottom">
        <button type="button" class="em-delete" id="emDelete">삭제</button>
        <div class="pop em-delete-confirm" id="emDeleteConfirm" hidden>
          <div class="pop-msg">정말 삭제하시겠습니까?</div>
          <div class="popover-divider"></div>
          <div class="pop-item" id="emDeleteConfirmYes">삭제</div>
          <div class="pop-item" id="emDeleteConfirmNo">취소</div>
        </div>
        <div class="pop em-save-confirm" id="emSaveConfirm" hidden>
          <div class="pop-msg">이 항목이 그 사이 변경되었습니다. 그대로 저장하시겠습니까?</div>
          <div class="popover-divider"></div>
          <div class="pop-item" id="emSaveConfirmYes">그대로 저장</div>
          <div class="pop-item" id="emSaveConfirmNo">취소</div>
        </div>
        <div class="em-foot-right">
          <button type="button" class="em-btn em-btn-ghost" id="emCancel">취소</button>
          <button type="button" class="em-btn em-btn-primary" id="emSave">저장</button>
        </div>
      </div>
    </template>

    <template id="emLoading">
      <p class="em-loading" id="emLoadingText">불러오는 중…</p>
    </template>

    <div id="qaTip" class="qa-tip" hidden></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 수정 창 `main.ts`를 셸 위로 옮긴다**

`src/editmodal/main.ts`를 통째로 아래로 바꾼다. 필드 조작·팝오버·휠·단축키는 전부 셸과 레이아웃이 맡으므로 이 파일에는 **불러오기, 저장 diff, 삭제, 저장 충돌, 브라우저 열기, 창 크기**만 남는다.

```ts
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  deleteWorkItem, getSettings, getWorkItem, listMembers, openIssuePopup,
  setQuickaddLayout, updateWorkItemFields, type UpdateWorkItemFields,
} from "../shared/ipc";
import { buildIssueUrl } from "../sidebar/logic";
import { applyTheme } from "../shared/theme";
import { bindTip } from "../shared/tooltip";
import type { Priority, StateGroup } from "../shared/planeIcons";
import type { WorkItem, WorkItemDetail } from "../shared/types";
import { resolveDateChoice } from "../shared/issueForm/state";
import { mountIssueCard, layoutKindOf } from "../shared/issueForm/card";
import "../shared/app.css";

const win = getCurrentWindow();

function cloneTemplate(id: string): HTMLElement {
  const tpl = document.getElementById(id) as HTMLTemplateElement;
  return tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
}

const browserBtn = cloneTemplate("emBrowser");
const footer = cloneTemplate("emFooter");
const loadingEl = cloneTemplate("emLoading");

const emDelete = footer.querySelector<HTMLElement>("#emDelete")!;
const emDeleteConfirm = footer.querySelector<HTMLElement>("#emDeleteConfirm")!;
const emDeleteConfirmYes = footer.querySelector<HTMLElement>("#emDeleteConfirmYes")!;
const emDeleteConfirmNo = footer.querySelector<HTMLElement>("#emDeleteConfirmNo")!;
const emSaveConfirm = footer.querySelector<HTMLElement>("#emSaveConfirm")!;
const emSaveConfirmYes = footer.querySelector<HTMLElement>("#emSaveConfirmYes")!;
const emSaveConfirmNo = footer.querySelector<HTMLElement>("#emSaveConfirmNo")!;
const emCancel = footer.querySelector<HTMLElement>("#emCancel")!;
const emSave = footer.querySelector<HTMLButtonElement>("#emSave")!;

let baseUrl = "";
let workspace = "";
let projectId = "";
let itemId = "";
let original: WorkItemDetail | null = null;
let snapshotOriginal: WorkItem | null = null;
let detailFetchPromise: Promise<WorkItemDetail> | null = null;

let loadRequestId = 0;

const card = mountIssueCard({
  root: document.getElementById("cardHost")!,
  title: "할 일 수정",
  titlePlaceholder: "제목",
  draggable: true,
  emptyAssignee: "none",
  headerExtra: [browserBtn],
  footer,
  loadMembers: async () => {
    // 빠른 추가와 같은 계약이다 — 어느 프로젝트에 대한 요청인지 await 전에 붙잡아
    // 두고, 돌아왔을 때 항목이 바뀌었으면 늦게 온 목록은 버린다.
    const id = card.state.selectedId;
    if (!id || card.state.membersLoadedForProject === id) return;
    try {
      const members = await listMembers(id);
      if (card.state.selectedId !== id) return;
      card.state.members = members;
      card.state.membersLoadedForProject = id;
    } catch (err) {
      if (card.state.selectedId !== id) return;
      card.state.members = [];
      console.error("listMembers failed:", err);
    }
  },
  onLayoutChange: (kind) => {
    // 빠른 추가와 같은 설정값을 쓴다 — 한쪽에서 바꾸면 양쪽이 바뀐다.
    setQuickaddLayout(kind).catch((err) => console.error("setQuickaddLayout failed:", err));
  },
  onResize: (width, height) => {
    win.setSize(new LogicalSize(width, height + 4)).catch((err) => {
      console.error("setSize failed:", err);
    });
  },
  onSubmit: () => { save(); },
  onClose: () => {
    // Esc는 떠 있는 확인 팝업부터 걷는다 — 셸은 필드 팝오버까지만 알고, 이 둘은
    // 이 창의 것이라 여기서 순서를 정한다.
    if (!emDeleteConfirm.hidden) {
      emDeleteConfirm.hidden = true;
      resizeWindow();
      return;
    }
    if (!emSaveConfirm.hidden) {
      closeSaveConflict();
      resizeWindow();
      return;
    }
    closeModal();
  },
});

// 로딩 문구는 카드 안, 헤더 바로 아래에 놓는다.
card.element.insertBefore(loadingEl, card.element.children[1]);

bindTip(browserBtn, "브라우저에서 열기", "below");
bindTip(card.element.querySelector('[data-layout="compact"]')!, "컴팩트 — 칩을 눌러 값 바꾸기", "below");
bindTip(card.element.querySelector('[data-layout="expanded"]')!, "한눈에 보기 — 모든 항목 펼쳐 보기", "below");
bindTip(card.element.querySelector("[data-close]")!, "닫기 <kbd>Esc</kbd>", "below");
bindTip(emSave, "저장 <kbd>Ctrl+↵</kbd>", "above");

function resizeWindow() {
  win.setSize(new LogicalSize(card.layoutWidth, card.contentHeight() + 4)).catch((err) => {
    console.error("setSize failed:", err);
  });
}

function setLoading(visible: boolean, message = "불러오는 중…") {
  loadingEl.hidden = !visible;
  loadingEl.textContent = message;
  card.setBodyVisible(!visible);
}

function snapshotToDetail(snapshot: WorkItem): WorkItemDetail {
  return {
    id: snapshot.id, name: snapshot.name, description: "",
    assignee_ids: snapshot.assignee_ids,
    start_date: snapshot.start_date, target_date: snapshot.target_date,
    priority: snapshot.priority, state_group: snapshot.state_group,
    project_id: snapshot.project_id,
  };
}

function applyFields(fields: WorkItem | WorkItemDetail) {
  card.setValues({
    name: fields.name,
    assigneeIds: fields.assignee_ids,
    startDate: fields.start_date,
    targetDate: fields.target_date,
    priority: fields.priority as Priority,
    stateGroup: fields.state_group as StateGroup,
  });
}

async function loadItem(pid: string, iid: string, snapshot?: WorkItem) {
  // Re-assert always-on-top every time an item is loaded, mirroring the
  // sidebar's showSidebar() — openInBrowser() drops it so the browser window can
  // surface above the modal, and nothing else restores it afterward.
  win.setAlwaysOnTop(true).catch((err) => {
    console.error("setAlwaysOnTop failed:", err);
  });
  card.closeOverlays();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
  // closeModal()은 창을 숨기기만 해서 같은 항목을 다시 열 때 원본 데이터가 메모리에
  // 그대로 남아있다 — 재요청 없이 그대로 보여준다.
  if (original && pid === projectId && iid === itemId) {
    card.titleElement.focus();
    resizeWindow();
    return;
  }
  const requestId = ++loadRequestId;
  projectId = pid;
  itemId = iid;
  original = null;
  snapshotOriginal = snapshot ?? null;
  detailFetchPromise = null;
  // 담당자 목록은 프로젝트에 딸린다 — 셸의 state.selectedId가 그 열쇠다.
  card.state.selectedId = pid;
  card.state.members = [];
  card.state.membersLoadedForProject = null;
  card.clearError();
  card.clearTitleError();

  if (snapshot) {
    // 이미 동기화로 받아둔 값이 있다 — 전체 스피너 없이 즉시 편집 가능한 폼을 보여준다.
    applyFields(snapshot);
    card.descriptionValue = "";
    card.setDescriptionVisible(false, false);
    card.setDescriptionEnabled(false);
    setLoading(false);
    resizeWindow();
    card.titleElement.focus();
  } else {
    setLoading(true);
    resizeWindow();
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
      applyFields(detail);
    }
    card.descriptionValue = detail.description;
    card.setDescriptionEnabled(true);
    // Auto-show an existing description — hiding it would read as "deleted".
    card.setDescriptionVisible(detail.description !== "", false);
    setLoading(false);
    resizeWindow();
    if (!snapshot) card.titleElement.focus();
  } catch (err) {
    if (requestId !== loadRequestId) return;
    if (snapshot) {
      // 오프라인 등으로 최신 데이터를 못 가져왔다 — 스냅샷을 기준값으로 확정하고
      // 계속 편집 가능하게 둔다(설명은 빈 값으로 취급).
      original = snapshotToDetail(snapshot);
      card.setDescriptionEnabled(true);
      console.error("getWorkItem background refresh failed:", err);
    } else {
      setLoading(true, "불러오기 실패: " + err);
      console.error("getWorkItem failed:", err);
      resizeWindow();
    }
  }
}

function closeModal() {
  card.closeOverlays();
  emDeleteConfirm.hidden = true;
  closeSaveConflict();
  win.hide();
}

async function openInBrowser() {
  if (!projectId || !itemId) return;
  const url = buildIssueUrl(baseUrl, workspace, projectId, itemId);
  try {
    // Drop always-on-top so the browser window we're about to open can
    // appear above the modal instead of behind it — same fix as the
    // sidebar's openInBrowser.
    await win.setAlwaysOnTop(false);
    await openIssuePopup(url);
  } catch (err) {
    console.error("openIssuePopup failed:", url, err);
  }
}

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

// Set while a confirmSaveConflict() promise is pending, so a force-close (modal close,
// loadItem for a different item, or Escape) can still resolve it instead of leaking a
// forever-pending save() call — see closeSaveConflict().
let pendingSaveConflictResolve: ((proceed: boolean) => void) | null = null;

function confirmSaveConflict(): Promise<boolean> {
  return new Promise((resolve) => {
    emSaveConfirm.hidden = false;
    resizeWindow();
    pendingSaveConflictResolve = resolve;
    emSaveConfirmYes.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeWindow();
      resolve(true);
    };
    emSaveConfirmNo.onclick = () => {
      pendingSaveConflictResolve = null;
      emSaveConfirm.hidden = true;
      resizeWindow();
      resolve(false);
    };
  });
}

// Force-closes the save-conflict popup from anywhere other than its own Yes/No
// buttons (closeModal, loadItem, Escape) — treats an abandoned popup as "cancel"
// so any pending confirmSaveConflict() promise still resolves.
function closeSaveConflict() {
  if (pendingSaveConflictResolve) {
    const resolve = pendingSaveConflictResolve;
    pendingSaveConflictResolve = null;
    resolve(false);
  }
  emSaveConfirm.hidden = true;
}

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

  const name = card.titleValue.trim();
  if (!name) {
    card.markTitleError();
    card.titleElement.focus();
    return;
  }
  const description = card.descriptionValue;
  const s = card.state;
  const startDate = resolveDateChoice(s.startChoice, s.startCustomDate);
  const dueDate = resolveDateChoice(s.dueChoice, s.dueCustomDate);

  const fields: UpdateWorkItemFields = {};
  if (name !== original.name) fields.name = name;
  if (description !== original.description) fields.description = description;
  const sortedCurrent = [...s.assigneeIds].sort();
  const sortedOriginal = [...original.assignee_ids].sort();
  if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedOriginal)) fields.assignee_ids = s.assigneeIds;
  if (startDate && startDate !== (original.start_date ?? "")) fields.start_date = startDate;
  if (dueDate && dueDate !== (original.target_date ?? "")) fields.target_date = dueDate;
  if (s.priority !== original.priority) fields.priority = s.priority;
  if (s.stateGroup !== original.state_group) fields.state_group = s.stateGroup;

  if (Object.keys(fields).length === 0) {
    await win.hide();
    return;
  }

  card.clearError();
  try {
    await updateWorkItemFields(projectId, itemId, fields);
    await win.hide();
  } catch (err) {
    card.showError("저장 실패: " + err);
    console.error("updateWorkItemFields failed:", err);
  }
}

emCancel.onclick = closeModal;
emSave.onclick = () => { save(); };
browserBtn.onclick = openInBrowser;

emDelete.onclick = () => {
  emDeleteConfirm.hidden = false;
  resizeWindow();
};
emDeleteConfirmNo.onclick = () => {
  emDeleteConfirm.hidden = true;
  resizeWindow();
};
emDeleteConfirmYes.onclick = async () => {
  try {
    await deleteWorkItem(projectId, itemId);
    await win.hide();
  } catch (err) {
    emDeleteConfirm.hidden = true;
    card.showError("삭제 실패: " + err);
    console.error("deleteWorkItem failed:", err);
  }
};

win.listen<{ projectId: string; itemId: string; snapshot?: WorkItem }>("load-item", (event) => {
  loadItem(event.payload.projectId, event.payload.itemId, event.payload.snapshot);
});

// 설정 창이 저장하면 즉시 반영한다 — 이 창도 트레이에 살아 있어 재로드되지 않는다.
win.listen("settings-changed", async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
});

async function loadSettings() {
  const s = await getSettings();
  baseUrl = s.base_url;
  workspace = s.workspace;
  applyTheme(s.theme);
  card.setLayout(layoutKindOf(s.quickadd_layout));
}

setLoading(true);
resizeWindow();
loadSettings();
```

- [ ] **Step 3: 빌드와 테스트를 확인한다**

Run: `pnpm build && pnpm test`
Expected: 둘 다 PASS

- [ ] **Step 4: 커밋**

```bash
git add src/editmodal
git commit -m "feat: 할 일 수정 창을 공통 카드 셸로 갈아끼운다"
```

---

## Task 7: CSS를 한 벌로 정리한다

**Files:**
- Modify: `src/shared/app.css`

- [ ] **Step 1: 죽은 규칙을 지운다**

`app.css`의 `/* ============ SURFACE ... EDIT MODAL ... */` 근처(873~909줄)에서 아래 규칙을 **삭제**한다. 어느 HTML에도 남아 있지 않다.

- `.editmodal`
- `.em-head`
- `.em-title`
- `.em-close`, `.em-close:hover`
- `.em-foot`
- `.em-form .title-input`
- `.em-error` (Task 5에서 `.form-error`로 이름이 바뀌었다)

- [ ] **Step 2: 브라우저 열기 버튼을 아이콘 버튼으로 다시 쓴다**

`.em-browser-btn` / `.em-browser-btn:hover` 두 규칙을 아래로 바꾼다. 헤더의 닫기 버튼과 같은 크기·결이다.

```css
/* 헤더의 브라우저 열기. 닫기 버튼과 같은 24px 아이콘 버튼이다 — 컴팩트 540px
   헤더에 글자 버튼을 두면 제목이 설 자리가 없다. 이름은 툴팁이 밝힌다. */
.em-browser-btn {
  display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  background: transparent; border: none; border-radius: 5px;
  color: var(--muted-2); cursor: pointer; flex: none;
}
.em-browser-btn:hover { background: var(--panel); color: var(--text); }
.em-browser-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.em-browser-btn svg { width: 14px; height: 14px; }
```

- [ ] **Step 3: 푸터가 확인 팝업의 기준이 되게 한다**

`.popup-bottom` 규칙에 `position: relative;`를 더한다. 삭제 확인 팝업이 `bottom: 100%`로 푸터에 붙어 있는데, 지금까지 그 기준은 `.em-foot`이었다.

```css
.popup-bottom {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-top: 1px solid var(--border); background: var(--panel-2);
  border-radius: 0 0 var(--radius) var(--radius);
  /* 수정 창의 삭제·저장 확인 팝업이 이 상자를 기준으로 떠오른다. */
  position: relative;
}
```

- [ ] **Step 4: 남은 참조가 없는지 확인한다**

Run: `grep -rn "editmodal\"\|em-head\|em-title\|em-close\|em-foot\b\|em-error" src/ --include=*.html --include=*.ts`
Expected: 결과 없음 (`src-tauri`의 창 label `"editmodal"`은 대상이 아니다)

- [ ] **Step 5: 빌드를 확인한다**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/shared/app.css
git commit -m "refactor: 수정 창 전용 카드 CSS를 지우고 popup 한 벌로 모은다"
```

---

## Task 8: 창 설정을 맞추고 CHANGELOG를 쓴다

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `editmodal` 창의 크기 조절을 끈다**

`src-tauri/tauri.conf.json`의 `editmodal` 항목에서 `"resizable": true`를 `false`로 바꾼다. 셸이 내용에 맞춰 크기를 잡으므로 손잡이는 뜻이 없고, 사용자가 늘려둔 폭은 다음 `setSize`에 지워진다.

```json
      {
        "label": "editmodal",
        "url": "src/editmodal/index.html",
        "width": 540, "height": 320,
        "decorations": false, "transparent": true, "alwaysOnTop": true, "shadow": false,
        "skipTaskbar": true, "visible": false, "center": true, "resizable": false
      },
```

- [ ] **Step 2: CHANGELOG에 한 줄 쓴다**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 변경` 섹션에 넣는다. 섹션이 없으면 만든다.

```markdown
- 할 일 수정 창이 빠른 추가와 같은 모양이 되었습니다 — 컴팩트/한눈에 보기 전환, 담당자 아바타 색상과 Ctrl+클릭 다중 선택, PgUp/Dn 날짜 조정을 수정 창에서도 씁니다.
```

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "feat: 할 일 수정 창 크기 정책을 셸에 맡기고 변경 내역을 적는다"
```

---

## Task 9: 손으로 확인한다

자동 테스트가 닿지 않는 부분이다. `pnpm tauri dev`로 띄우고 아래를 순서대로 확인한다. 어긋나는 것이 있으면 고치고 다시 이 목록을 돈다.

- [ ] **빠른 추가 (회귀)**
  - 컴팩트/한눈에 보기 전환, 창 폭 540↔660
  - 담당자 칩이 "나", 팝오버 본인 행에 "(나)", Ctrl+클릭 다중
  - 설명 토글, 프로젝트 선택 창, 등록, Esc, 그냥 Enter의 버튼 깜빡임
  - 코치마크가 뜨는 경우 화살표가 토글을 가리키는지 (`localStorage`의 `qa-layout-coach-shown`을 지우면 다시 볼 수 있다)

- [ ] **할 일 수정 (새 모양)**
  - 사이드바에서 항목을 열면 값이 채워진 채 뜬다
  - 헤더를 끌면 창이 움직인다
  - 레이아웃 토글이 있고, 전환하면 창 폭이 바뀐다
  - 담당자 칩이 실제 담당자를 보여주고, 아무도 없으면 "담당자 없음"
  - 담당자 팝오버 맨 위 "담당자 없음" 행으로 되돌릴 수 있다
  - 한눈에 보기의 담당자 행 첫 칸이 "없음" 칩이고 눌러서 비울 수 있다
  - Ctrl+클릭으로 여러 명 지정, 그냥 클릭이면 한 명으로 줄어든다
  - PgUp/Dn으로 시작일, Ctrl+PgUp/Dn으로 마감일이 하루씩 움직인다
  - 브라우저 열기 아이콘에 호버하면 툴팁이 뜨고, 누르면 브라우저가 앞으로 나온다
  - 설명이 있는 항목은 펼쳐진 채로 열리고, 없으면 접혀 있다
  - Ctrl+Enter와 저장 버튼 둘 다 저장된다
  - 삭제 → 확인 팝업 → 삭제
  - Esc가 팝오버 → 확인 팝업 → 창 닫기 순으로 걷힌다

- [ ] **두 창의 연결**
  - 설정 창에서 "빠른 추가 화면"을 바꾸면 두 창 모두 즉시 반영된다
  - 수정 창에서 토글을 바꾸고 빠른 추가를 열면 같은 모양이다

- [ ] **깨지기 쉬운 경로**
  - 오프라인(네트워크 끊고)에서 사이드바 항목을 열면 스냅샷 값으로 편집 가능하다
  - 다른 기기에서 항목을 바꾼 뒤 저장하면 "그 사이 변경되었습니다" 팝업이 뜬다
  - 항목을 열어둔 채 사이드바에서 다른 항목을 열면 값이 갈아끼워진다

- [ ] **커밋** (손으로 고친 것이 있을 때만)

```bash
git add -A
git commit -m "fix: 손 확인에서 나온 문제를 고친다"
```
