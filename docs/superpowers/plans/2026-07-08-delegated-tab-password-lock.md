# "내가 할당한 작업" 탭 비밀번호 잠금 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드바의 "내가 할당한 작업" 탭을 설정에서 체크박스로 켜야만
보이게 하고, 그 체크박스를 켤 때는 비밀번호 확인을 거치게 한다.

**Architecture:** 새 bool 설정 `show_delegated_tab`(기본 꺼짐)을 기존
설정 파이프라인(`config.rs` → `SettingsDto` → `save_settings`/`get_settings`)에
추가한다. 비밀번호 검증은 새 Tauri 커맨드로 백엔드에서 수행해 평문이
프론트엔드 번들에 노출되지 않게 한다. 설정 화면은 체크박스 클릭을
가로채 앱 스타일의 작은 팝업으로 비밀번호를 받는다. 사이드바는 설정값을
읽어 탭 바 표시 여부를 결정한다.

**Tech Stack:** Rust(Tauri 커맨드) + TypeScript(Vite), 테스트는 `cargo test`
(src-tauri) / `pnpm test`(vitest).

## Global Constraints

- 이건 실제 보안 기능이 아니라 가벼운 프라이버시 잠금이다 — 비밀번호는
  Rust 소스 상수(`"16006937"`)이고 앱 바이너리를 디컴파일하면 누구나
  알아낼 수 있다. 코드 주석에 이 사실을 명시한다.
- 비밀번호 검증은 백엔드(Rust) 커맨드에서 한다 — 프론트엔드 JS 번들에
  평문이 그대로 보이는 것만 막는다.
- 체크박스를 **켜려는** 클릭에서만 비밀번호 팝업이 뜬다. **끄는** 클릭은
  비밀번호 없이 즉시 통과된다.
- 설정이 꺼져 있으면(`show_delegated_tab === false`) 사이드바는 탭 바
  (`#sbTabs`) 전체를 숨기고 `activeTab`을 무조건 `"assigned"`로
  강제한다 — `localStorage`에 예전에 `"delegated"`가 남아있어도 무시한다.
- 새 설정 필드는 기존 bool 설정과 동일하게 `#[serde(default)]`를 붙여
  구버전 설정 파일과 호환된다(직접 지정한 `default_*` 함수 불필요 —
  `bool`의 기본값은 이미 `false`).
- CHANGELOG 규칙(`CLAUDE.md`): 마지막 태스크에서만 `## [Unreleased]` →
  `### 추가`에 한 줄 추가한다.

---

## File Structure

- `src-tauri/src/config.rs` — `Settings`에 `show_delegated_tab: bool` 필드 추가
- `src-tauri/src/commands.rs` — `SettingsDto` 필드, `get_settings`/`save_settings`
  확장, 신규 `verify_delegated_tab_password` 커맨드
- `src-tauri/src/lib.rs` — 신규 커맨드를 `invoke_handler`에 등록
- `src/shared/types.ts` — `SettingsDto`에 필드 추가
- `src/shared/ipc.ts` — `saveSettings` 파라미터 추가, `verifyDelegatedTabPassword` 추가
- `src/settings/index.html` — 체크박스 마크업
- `src/settings/main.ts` — 체크박스 로드/저장, 클릭 가로채기 + 비밀번호 팝업
- `src/shared/app.css` — 비밀번호 팝업 스타일
- `src/sidebar/main.ts` — 설정값에 따라 탭 바 숨김
- `CHANGELOG.md` — Unreleased 항목 추가

---

### Task 1: 백엔드 — `Settings`에 `show_delegated_tab` 필드 추가

**Files:**
- Modify: `src-tauri/src/config.rs:10-48` (`Settings` 구조체)
- Modify: `src-tauri/src/config.rs:61-83` (`impl Default for Settings`)
- Modify: `src-tauri/src/config.rs:179-199` (`settings_round_trip_preserves_fields` 테스트 — 새 필드 값 추가)
- Modify: `src-tauri/src/config.rs:174-298` (`mod tests` — 신규 테스트 추가)

**Interfaces:**
- Produces: `Settings.show_delegated_tab: bool` — Task 2가 `SettingsDto`/
  `get_settings`/`save_settings`에서 이 필드를 읽고 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/config.rs`의 `mod tests` 블록(`settings_default_has_fixed_base_url_and_no_project` 테스트 근처, 아무 위치나 `mod tests` 안이면 됨)에 추가:

```rust
    #[test]
    fn settings_default_hides_delegated_tab() {
        let s = Settings::default();
        assert!(!s.show_delegated_tab);
    }

    #[test]
    fn settings_without_show_delegated_tab_field_gets_default_false() {
        // 이 기능 이전에 저장된 설정 파일 — 기본값(꺼짐)으로 채워져야 한다.
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert!(!s.show_delegated_tab);
    }
```

기존 `settings_round_trip_preserves_fields` 테스트(179-199번 줄 근처)의
`Settings { ... }` 리터럴 끝, `assign_remind_hours: 6,` 다음 줄에
`show_delegated_tab: true,`를 추가한다(이 필드를 struct에 추가하는 순간
이 테스트가 컴파일 에러가 나므로, 같은 커밋에서 함께 고친다).

- [ ] **Step 2: 테스트 실행해서 실패(컴파일 에러) 확인**

Run: `cd src-tauri && cargo test settings_default_hides_delegated_tab -- --nocapture`
Expected: FAIL — `no field \`show_delegated_tab\` on type \`Settings\`` 컴파일 에러
(그리고 `settings_round_trip_preserves_fields`도 `missing field` 컴파일
에러로 함께 실패한다 — 필드 추가 전이므로 정상)

- [ ] **Step 3: 최소 구현 작성**

`Settings` 구조체(`src-tauri/src/config.rs:44-47` 근처, `assign_remind_hours`
필드 바로 다음)에 추가:

```rust
    /// "내가 할당한 작업" 탭을 사이드바에 보여줄지 (기본 꺼짐). 켤 때는
    /// `commands::verify_delegated_tab_password`로 비밀번호를 확인한다.
    /// 진짜 보안 기능이 아니라 가벼운 프라이버시 잠금이다 — 비밀번호는
    /// 앱 바이너리에 상수로 박혀 있어 디컴파일하면 알아낼 수 있다.
    #[serde(default)]
    pub show_delegated_tab: bool,
```

`impl Default for Settings`(`src-tauri/src/config.rs:61-83`)의 구조체
리터럴 끝, `assign_remind_hours: default_assign_remind_hours(),` 다음
줄에 추가:

```rust
            show_delegated_tab: false,
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd src-tauri && cargo test config:: -- --nocapture`
Expected: PASS (기존 `config` 모듈 테스트 전부 + 신규 2개)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: add show_delegated_tab setting field (default off)"
```

---

### Task 2: 백엔드 — `SettingsDto`/`get_settings`/`save_settings` 확장 + 비밀번호 검증 커맨드

**Files:**
- Modify: `src-tauri/src/commands.rs:8-26` (`SettingsDto`)
- Modify: `src-tauri/src/commands.rs:182-202` (`get_settings`)
- Modify: `src-tauri/src/commands.rs:204-260` (`save_settings`)
- Modify: `src-tauri/src/commands.rs` (새 커맨드 `verify_delegated_tab_password` 추가 — `save_settings` 함수 바로 다음)
- Modify: `src-tauri/src/commands.rs:979-` (`mod tests` — 신규 테스트 추가)
- Modify: `src-tauri/src/lib.rs:760-765` (`invoke_handler` 등록)

**Interfaces:**
- Consumes: `Settings.show_delegated_tab: bool` (Task 1)
- Produces: `SettingsDto.show_delegated_tab: bool`, `save_settings(..., show_delegated_tab: Option<bool>)`,
  `verify_delegated_tab_password(password: String) -> bool` — Task 3(프론트엔드
  타입/IPC)가 이 이름·타입을 그대로 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/commands.rs`의 `mod tests` 블록 끝에 추가:

```rust
    #[test]
    fn verify_delegated_tab_password_accepts_only_the_exact_password() {
        assert!(verify_delegated_tab_password("16006937".to_string()));
        assert!(!verify_delegated_tab_password("".to_string()));
        assert!(!verify_delegated_tab_password("16006938".to_string()));
        assert!(!verify_delegated_tab_password(" 16006937".to_string()));
        assert!(!verify_delegated_tab_password("16006937 ".to_string()));
    }
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd src-tauri && cargo test verify_delegated_tab_password -- --nocapture`
Expected: FAIL — `cannot find function \`verify_delegated_tab_password\`` 컴파일 에러

- [ ] **Step 3: 최소 구현 작성**

`SettingsDto`(`src-tauri/src/commands.rs:8-26`)의 마지막 필드
`pub assign_remind_hours: u32,` 다음 줄에 추가:

```rust
    pub show_delegated_tab: bool,
```

`get_settings`(`src-tauri/src/commands.rs:182-202`)의 구조체 리터럴 마지막
필드 `assign_remind_hours: s.assign_remind_hours,` 다음 줄에 추가:

```rust
        show_delegated_tab: s.show_delegated_tab,
```

`save_settings`(`src-tauri/src/commands.rs:205-221`)의 파라미터 목록
마지막 `assign_remind_hours: Option<u32>,` 다음 줄에 추가:

```rust
    show_delegated_tab: Option<bool>,
```

같은 함수 본문(`src-tauri/src/commands.rs:247` 근처,
`if let Some(v) = assign_remind_hours { if v >= 1 { s.assign_remind_hours = v; } }`
다음 줄)에 추가:

```rust
    if let Some(v) = show_delegated_tab { s.show_delegated_tab = v; }
```

`save_settings` 함수가 끝나는 지점(반환 타입 `Result<(), String>`의
닫는 `}`) 바로 다음에 새 상수와 커맨드를 추가:

```rust
/// "내가 할당한 작업" 탭을 켤 때 요구하는 비밀번호. 진짜 보안이 아니라
/// 가벼운 프라이버시 잠금이다 — 이 상수는 앱 바이너리를 디컴파일하면
/// 누구나 알아낼 수 있다. 목적은 즉흥적으로 체크박스를 켜는 것을 막는
/// 정도.
const DELEGATED_TAB_PASSWORD: &str = "16006937";

#[tauri::command]
pub fn verify_delegated_tab_password(password: String) -> bool {
    password == DELEGATED_TAB_PASSWORD
}
```

`src-tauri/src/lib.rs:762`(`commands::save_settings,` 다음 줄)에 추가:

```rust
            commands::verify_delegated_tab_password,
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd src-tauri && cargo test`
Expected: PASS (전체 테스트, Task 1 신규분 포함)

- [ ] **Step 5: 빌드 확인**

Run: `cd src-tauri && cargo build`
Expected: 성공 — `lib.rs`의 커맨드 등록 누락 시 나는 런타임 문제는
컴파일로는 안 잡히므로, 이름 오타가 없는지 `cargo build` 출력에
경고가 없는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add verify_delegated_tab_password command and settings wiring"
```

---

### Task 3: 프론트엔드 — 공유 타입/IPC 확장

**Files:**
- Modify: `src/shared/types.ts` (`SettingsDto` 인터페이스)
- Modify: `src/shared/ipc.ts` (`saveSettings`, 신규 `verifyDelegatedTabPassword`)

**Interfaces:**
- Consumes: `verify_delegated_tab_password(password: String) -> bool`,
  `save_settings(..., show_delegated_tab: Option<bool>)` (Task 2)
- Produces: `SettingsDto.show_delegated_tab: boolean`,
  `saveSettings(..., showDelegatedTab?: boolean)`,
  `verifyDelegatedTabPassword(password: string): Promise<boolean>` — Task 4(설정
  화면)와 Task 5(사이드바)가 이 이름·타입을 그대로 사용한다.

- [ ] **Step 1: `SettingsDto`에 필드 추가**

`src/shared/types.ts`의 `SettingsDto` 인터페이스 마지막 줄
(`assign_notify_enabled: boolean; assign_remind_hours: number;`) 다음에
추가:

```typescript
  show_delegated_tab: boolean;
```

- [ ] **Step 2: `saveSettings`에 파라미터 추가**

`src/shared/ipc.ts`의 `saveSettings` 함수 시그니처
(`assignRemindHours?: number,` 다음 줄)에 추가:

```typescript
  showDelegatedTab?: boolean,
```

같은 함수의 `invoke<void>("save_settings", { ... })` 객체 리터럴
(`assignRemindHours,` 다음 줄)에 추가:

```typescript
    showDelegatedTab,
```

- [ ] **Step 3: `verifyDelegatedTabPassword` 추가**

`src/shared/ipc.ts`의 `saveSettings` 정의 바로 다음에 추가:

```typescript
export const verifyDelegatedTabPassword = (password: string) =>
  invoke<boolean>("verify_delegated_tab_password", { password });
```

- [ ] **Step 4: 타입 체크**

Run: `pnpm build`
Expected: 성공 — 이 시점에는 `src/settings/main.ts`와
`src/sidebar/main.ts`가 아직 새 필드/함수를 안 쓰므로, 기존 `saveSettings`
호출부(설정 화면)가 옵셔널 파라미터 누락으로 에러가 나지는 않는지만
확인한다(모두 옵셔널이므로 에러 없어야 함).

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat: add show_delegated_tab to shared types and IPC layer"
```

---

### Task 4: 설정 화면 — 체크박스 + 비밀번호 팝업

**Files:**
- Modify: `src/settings/index.html:38-48` (일반 탭 패널)
- Modify: `src/settings/main.ts` (로드/저장 바인딩, 클릭 가로채기, 팝업)
- Modify: `src/shared/app.css` (팝업 스타일 — `.pop`/`.token-change-btn` 근처에 추가)

**Interfaces:**
- Consumes: `SettingsDto.show_delegated_tab`, `saveSettings(..., showDelegatedTab)`,
  `verifyDelegatedTabPassword(password)` (Task 3)

이 태스크는 DOM 배선 위주라 이 코드베이스의 기존 관례상(`settings/main.ts`는
단위 테스트 대상이 아님 — `sidebar/logic.ts`만 순수 함수를 뽑아 테스트함)
자동 테스트를 추가하지 않는다. `pnpm build`로 타입 체크만 확인한다.

- [ ] **Step 1: 체크박스 마크업 추가**

`src/settings/index.html`의 일반 패널(`<section class="set-panel" data-panel="general" ...>`)
안, `<h2>디스플레이</h2>` 섹션(46-47번 줄 근처) 다음, `</section>`
(48번 줄) 이전에 추가:

```html
        <h2>개인정보</h2>
        <label class="check-row"><input id="showDelegatedTab" type="checkbox" />할당한 작업 보기</label>
```

- [ ] **Step 2: 로드/저장 바인딩**

`src/settings/main.ts`의 다른 체크박스 상수 선언부
(`const assignRemindHours = document.getElementById("assignRemindHours") as HTMLInputElement;`
다음 줄)에 추가:

```typescript
const showDelegatedTab = document.getElementById("showDelegatedTab") as HTMLInputElement;
```

`load()` 함수의 `assignRemindHours.value = String(s.assign_remind_hours);`
다음 줄에 추가:

```typescript
  showDelegatedTab.checked = s.show_delegated_tab;
```

`save` 버튼 핸들러 안, `saveSettings(...)` 호출의 마지막 인자
`Math.max(1, Math.floor(Number(assignRemindHours.value) || 2)),` 다음 줄에
추가:

```typescript
      showDelegatedTab.checked,
```

- [ ] **Step 3: 비밀번호 팝업 + 클릭 가로채기**

`import` 줄(`src/settings/main.ts:3`)을 다음으로 교체:

```typescript
import { getSettings, saveSettings, verifyDelegatedTabPassword } from "../shared/ipc";
```

`showDelegatedTab` 상수 선언 바로 다음에 추가:

```typescript
let pwPopover: HTMLElement | null = null;

function closePwPopover() {
  if (pwPopover) {
    pwPopover.remove();
    pwPopover = null;
  }
}

function openPwPopover(anchor: HTMLElement) {
  closePwPopover();
  const pop = document.createElement("div");
  pop.className = "pop pw-pop";
  pop.onclick = (e) => e.stopPropagation();

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "비밀번호";
  input.className = "pw-pop-input";
  pop.appendChild(input);

  const error = document.createElement("div");
  error.className = "pw-pop-error";
  pop.appendChild(error);

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "token-change-btn pw-pop-confirm";
  confirm.textContent = "확인";
  const submit = async () => {
    let ok = false;
    try {
      ok = await verifyDelegatedTabPassword(input.value);
    } catch {
      ok = false;
    }
    if (ok) {
      showDelegatedTab.checked = true;
      closePwPopover();
    } else {
      error.textContent = "비밀번호가 올바르지 않습니다";
      input.value = "";
      input.focus();
    }
  };
  confirm.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  pop.appendChild(confirm);

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = rect.left + "px";
  pop.style.top = rect.bottom + 4 + "px";
  pwPopover = pop;
  input.focus();
}

// 체크박스의 click 이벤트는 브라우저가 이미 .checked를 새 값으로 뒤집은
// 뒤에 발생한다. 그래서 여기서 .checked === true면 "꺼짐→켜짐" 전환
// 시도라는 뜻이다. preventDefault()를 부르면 체크박스는 특수 동작으로
// .checked를 자동으로 원래 값(false)으로 되돌린다 — 그 다음 비밀번호
// 팝업을 띄우고, 검증에 성공하면 그때 코드에서 직접 checked = true로
// 설정한다. .checked === false(켜짐→꺼짐)면 막지 않고 그대로 통과시킨다
// — 끄는 데는 비밀번호가 필요 없다.
showDelegatedTab.addEventListener("click", (e) => {
  if (showDelegatedTab.checked) {
    e.preventDefault();
    openPwPopover(showDelegatedTab);
  }
});

document.addEventListener("click", () => closePwPopover());
```

`src/settings/main.ts`의 기존 전역 Escape 핸들러(파일 끝 근처,
`document.addEventListener("keydown", (e) => { if (e.key === "Escape") getCurrentWindow().hide(); });`)를
다음으로 교체 — 팝업이 열려 있으면 팝업만 닫고, 없으면 기존대로 창을
닫는다:

```typescript
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pwPopover) {
    closePwPopover();
    return;
  }
  getCurrentWindow().hide();
});
```

- [ ] **Step 4: 팝업 스타일 추가**

`src/shared/app.css`의 `.token-change-btn:hover { ... }` 규칙(490번 줄
근처) 다음에 추가:

```css
.pop.pw-pop { width: 220px; display: flex; flex-direction: column; gap: 6px; }
.pw-pop-input {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  color: var(--text); font-size: 12.5px; padding: 6px 8px; outline: none;
  font-family: inherit; width: 100%;
}
.pw-pop-input:focus { border-color: var(--accent); }
.pw-pop-error { color: var(--red); font-size: 11px; min-height: 14px; }
.pw-pop-confirm { align-self: flex-end; }
```

- [ ] **Step 5: 빌드 확인**

Run: `pnpm build`
Expected: 성공, 타입 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/settings/index.html src/settings/main.ts src/shared/app.css
git commit -m "feat: gate delegated-tab checkbox behind a password popup in settings"
```

---

### Task 5: 사이드바 — 설정값에 따라 탭 바 숨김

**Files:**
- Modify: `src/sidebar/main.ts:104` (DOM 상수 선언부 — `sbTabsEl` 추가)
- Modify: `src/sidebar/main.ts:908-933` (`runRefresh`)

**Interfaces:**
- Consumes: `SettingsDto.show_delegated_tab` (Task 3), 기존 module-level
  `activeTab` 변수(값 `"assigned" | "delegated"`, 2026-07-08 델리게이티드
  탭 구현에서 이미 존재)

이 태스크도 `main.ts` DOM 배선이라 자동 테스트를 추가하지 않는다
(기존 관례). `pnpm build` + 수동 확인으로 검증한다.

- [ ] **Step 1: `sbTabsEl` 상수 추가, 기본값은 숨김**

`src/sidebar/main.ts:104`(`const tabEls = Array.from(...)` 다음 줄)에
추가:

```typescript
const sbTabsEl = document.getElementById("sbTabs")!;
// 설정 확인 전까지는 기본으로 숨긴다 — show_delegated_tab의 기본값이
// 꺼짐이므로, 첫 로드 시 탭 바가 잠깐 보였다 사라지는 깜빡임을 막는다.
sbTabsEl.hidden = true;
```

- [ ] **Step 2: `runRefresh`에서 설정값 반영**

`src/sidebar/main.ts:912`(`const s = await getSettings();`) 다음 줄에
추가:

```typescript
    sbTabsEl.hidden = !s.show_delegated_tab;
    if (!s.show_delegated_tab) activeTab = "assigned";
```

- [ ] **Step 3: 빌드 확인**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 4: 전체 테스트 확인 (회귀 없음)**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: 수동 확인**

Run: `pnpm tauri dev`
확인 항목:
- 첫 실행(설정 기본값, 꺼짐) 시 사이드바에 탭 바가 전혀 안 보이고
  기존처럼 "나에게 할당된 작업" 목록만 바로 보이는지
- 설정 → 일반 탭에서 "할당한 작업 보기"를 클릭하면 비밀번호 팝업이
  뜨는지, 틀린 비밀번호(`16006938` 등) 입력 시 에러가 뜨고 체크박스는
  꺼진 채로 남는지, 올바른 비밀번호(`16006937`) 입력 시 체크되고
  팝업이 닫히는지
- 저장 후 사이드바를 새로고침(또는 재실행)하면 탭 바가 나타나는지
- 설정에서 체크 해제는 비밀번호 없이 바로 되는지, 저장 후 사이드바에
  탭 바가 다시 사라지는지
- Esc 키로 팝업만 닫히고(설정 창은 안 닫힘), 팝업이 없을 때 Esc는
  기존처럼 설정 창을 닫는지

- [ ] **Step 6: 커밋**

```bash
git add src/sidebar/main.ts
git commit -m "feat: hide delegated tab bar in sidebar unless setting is enabled"
```

---

### Task 6: CHANGELOG + 최종 검증

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG 항목 추가**

`CHANGELOG.md`의 `## [Unreleased]` 아래 `### 추가` 섹션(없으면 새로
만든다)에 한 줄 추가:

```markdown
- 사이드바 "내가 할당한 작업" 탭을 설정에서 켜야만 볼 수 있도록 바꿨고, 켤 때는 비밀번호 확인을 거칩니다.
```

- [ ] **Step 2: 전체 Rust 테스트**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 3: 전체 TS 테스트**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: 빌드**

Run: `pnpm build`
Expected: 성공

- [ ] **Step 5: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog entry for delegated-tab password lock"
```

---

## Self-Review Notes

- **스펙 커버리지**: 핵심 설계 결정 1(설정 필드, 기본 꺼짐) → Task 1.
  결정 2(백엔드 검증, 프론트 번들에 평문 미노출) → Task 2. 결정
  3(켤 때만 검증, 끌 때는 자유) → Task 4 Step 3의 클릭 가로채기 로직.
  결정 4(탭 바 전체 숨김 + activeTab 강제 + 매번 담당 작업부터 시작) →
  Task 5. "진짜 보안 아님" 명시 → Task 2 코드 주석. 엣지 케이스(평문
  비밀번호 입력칸으로 충분) → Task 4에서 `type="password"`만 사용, 별도
  마스킹 처리 없음(스펙 그대로). CHANGELOG → Task 6.
- **플레이스홀더 스캔**: 없음 — 모든 스텝에 실제 코드/명령을 그대로 실었다.
- **타입 일관성**: `verify_delegated_tab_password(password: String) -> bool`
  (Task 2 정의) ↔ `verifyDelegatedTabPassword(password: string): Promise<boolean>`
  (Task 3 IPC 래퍼) ↔ Task 4에서의 호출부 `await verifyDelegatedTabPassword(input.value)`
  까지 일치. `show_delegated_tab`(스네이크 케이스, Rust/TS 양쪽에서
  필드명 그대로 — 이 코드베이스는 IPC 경계에서 camelCase 변환을 쓰지
  않는 기존 관례, `is_cached`/`delegated_members` 등과 동일)로 Task
  1(Rust `Settings`)·Task 2(`SettingsDto`)·Task 3(TS `SettingsDto`)이
  일치. `saveSettings`의 `showDelegatedTab`(camelCase, TS 함수
  파라미터명 — 기존 `assignRemindHours` 등과 동일 패턴)이 Task 3 정의부터
  Task 4 호출부까지 일치.
