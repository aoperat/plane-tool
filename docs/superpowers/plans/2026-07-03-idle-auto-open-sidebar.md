# PC 유휴 시 사이드바 자동 열기 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PC에 키보드/마우스 입력이 일정 시간(기본 3분, 설정 가능) 없으면 사이드바를 자동으로 연다.

**Architecture:** Rust 백엔드의 tokio 태스크가 5초마다 Windows `GetLastInputInfo`로 유휴 시간을 폴링하고, 순수 상태 머신(`IdleOpenGate`)이 "이번 tick에 열어야 하는가"를 판정한다. 열어야 하면 `sidebar` 창에 열기 전용 이벤트 `open-sidebar`를 emit하고, 프런트엔드는 닫혀 있을 때만 기존 `showSidebar()` 경로로 연다. 켬/끔과 기준 시간(분)은 기존 `Settings` 저장소에 필드 2개를 추가해 설정 화면에서 조절한다.

**Tech Stack:** Tauri 2 (Rust backend + TypeScript frontend), `windows` crate (Win32 API), tokio, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-idle-auto-open-sidebar-design.md`

## Global Constraints

- 새 설정 필드 기본값: `idle_open_enabled = true`, `idle_open_minutes = 3` (스펙 확정값 — 변경 금지)
- 폴링 간격 5초, 유휴 세션당 자동 열림 1회
- 기존 `toggle-sidebar` 이벤트를 재사용하지 않는다 — 열기 전용 `open-sidebar` 이벤트를 새로 만든다
- 비 Windows 빌드에서 컴파일이 깨지면 안 된다 (`#[cfg(windows)]` 분리)
- Rust 테스트: `cargo test --manifest-path src-tauri/Cargo.toml` / 프런트 테스트: `pnpm test` / 빌드: `pnpm build`
- 커밋 메시지는 conventional commits (`feat:`, `test:` 등), 본문 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- CHANGELOG는 마지막 태스크(기능이 실제로 사용자에게 보이게 되는 커밋)에서만 기록한다

---

### Task 1: `IdleOpenGate` 상태 머신 (순수 Rust, TDD)

유휴 시간·기준·1회성 플래그를 받아 "이번 tick에 열어야 하는가"를 판정하는 OS 독립 로직.

**Files:**
- Create: `src-tauri/src/idle.rs`
- Modify: `src-tauri/src/lib.rs:1-4` (모듈 등록)

**Interfaces:**
- Produces: `idle::IdleOpenGate` — `IdleOpenGate::new() -> Self`, `tick(&mut self, enabled: bool, idle_ms: u64, threshold_ms: u64) -> bool` (Task 4가 사용)

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/idle.rs` 생성 (테스트 먼저, 구현은 컴파일만 되는 빈 껍데기):

```rust
//! PC 유휴 시 사이드바 자동 열기 판정.
//!
//! OS 호출(`system_idle_ms`)과 판정 로직(`IdleOpenGate`)을 분리해 판정
//! 로직을 단위 테스트할 수 있게 한다.

/// 유휴 세션당 한 번만 자동 열림을 발화시키는 게이트.
///
/// "유휴 세션"은 유휴 시간이 기준을 넘은 시점부터 입력 재개로 기준
/// 아래로 떨어질 때까지다. 한 세션에서 이미 열었으면 사용자가 닫아도
/// 다시 열지 않는다 — 닫자마자 또 열리는 짜증을 막기 위해.
pub struct IdleOpenGate {
    fired: bool,
}

impl IdleOpenGate {
    pub fn new() -> Self {
        Self { fired: false }
    }

    /// 매 폴링 tick마다 호출. 이번 tick에 사이드바를 열어야 하면 true.
    pub fn tick(&mut self, _enabled: bool, _idle_ms: u64, _threshold_ms: u64) -> bool {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THRESHOLD: u64 = 180_000; // 3분

    #[test]
    fn below_threshold_never_opens() {
        let mut g = IdleOpenGate::new();
        assert!(!g.tick(true, 0, THRESHOLD));
        assert!(!g.tick(true, THRESHOLD - 1, THRESHOLD));
    }

    #[test]
    fn crossing_threshold_opens_once() {
        let mut g = IdleOpenGate::new();
        assert!(!g.tick(true, 10_000, THRESHOLD));
        assert!(g.tick(true, THRESHOLD, THRESHOLD));
    }

    #[test]
    fn staying_idle_does_not_reopen() {
        let mut g = IdleOpenGate::new();
        assert!(g.tick(true, THRESHOLD, THRESHOLD));
        assert!(!g.tick(true, THRESHOLD + 5_000, THRESHOLD));
        assert!(!g.tick(true, THRESHOLD + 300_000, THRESHOLD));
    }

    #[test]
    fn input_resume_resets_gate() {
        let mut g = IdleOpenGate::new();
        assert!(g.tick(true, THRESHOLD, THRESHOLD));
        // 입력 재개 → 유휴 시간이 기준 아래로 떨어짐 → 게이트 리셋
        assert!(!g.tick(true, 2_000, THRESHOLD));
        // 다시 유휴 기준 초과 → 새 세션이므로 다시 열림
        assert!(g.tick(true, THRESHOLD + 1, THRESHOLD));
    }

    #[test]
    fn disabled_never_opens() {
        let mut g = IdleOpenGate::new();
        assert!(!g.tick(false, THRESHOLD * 10, THRESHOLD));
        assert!(!g.tick(false, THRESHOLD * 20, THRESHOLD));
    }

    #[test]
    fn enabling_mid_idle_session_opens() {
        // 꺼진 상태로 유휴 기준을 넘긴 뒤 설정을 켜면, 그 세션에서도 열린다
        // (꺼져 있던 tick은 발화를 소모하지 않는다).
        let mut g = IdleOpenGate::new();
        assert!(!g.tick(false, THRESHOLD + 1, THRESHOLD));
        assert!(g.tick(true, THRESHOLD + 2, THRESHOLD));
    }
}
```

`src-tauri/src/lib.rs` 최상단 모듈 목록에 추가:

```rust
pub mod commands;
pub mod config;
pub mod idle;
pub mod monitors;
pub mod plane_api;
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml idle`
Expected: FAIL — `unimplemented!()` panic으로 6개 테스트 대부분 실패

- [ ] **Step 3: 최소 구현**

`tick`의 `unimplemented!()` 본문을 다음으로 교체 (파라미터 이름의 `_` 접두사 제거):

```rust
    /// 매 폴링 tick마다 호출. 이번 tick에 사이드바를 열어야 하면 true.
    pub fn tick(&mut self, enabled: bool, idle_ms: u64, threshold_ms: u64) -> bool {
        if idle_ms < threshold_ms {
            self.fired = false;
            return false;
        }
        if !enabled || self.fired {
            return false;
        }
        self.fired = true;
        true
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml idle`
Expected: `test result: ok. 6 passed`

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/idle.rs src-tauri/src/lib.rs
git commit -m "feat: add idle-open gate state machine"
```

---

### Task 2: 설정 필드 추가 (Rust 백엔드)

`Settings`에 `idle_open_enabled`/`idle_open_minutes` 추가, DTO와 save 커맨드에 배선.

**Files:**
- Modify: `src-tauri/src/config.rs` (struct, defaults, tests)
- Modify: `src-tauri/src/commands.rs:6-16` (`SettingsDto`), `commands.rs:132-171` (`get_settings`, `save_settings`)

**Interfaces:**
- Produces: `Settings.idle_open_enabled: bool`, `Settings.idle_open_minutes: u32` (Task 4가 읽음); `save_settings` 커맨드의 새 파라미터 `idle_open_enabled: Option<bool>`, `idle_open_minutes: Option<u32>` — 프런트에서는 camelCase `idleOpenEnabled`/`idleOpenMinutes`로 invoke (Task 3이 사용)

- [ ] **Step 1: 실패하는 테스트 작성**

`src-tauri/src/config.rs`의 `tests` 모듈에 추가:

```rust
    #[test]
    fn settings_default_enables_idle_open_at_3_minutes() {
        let s = Settings::default();
        assert!(s.idle_open_enabled);
        assert_eq!(s.idle_open_minutes, 3);
    }

    #[test]
    fn settings_without_idle_fields_gets_defaults() {
        // 이 기능 이전에 저장된 설정 파일에는 idle 필드가 없다 — 기본값으로
        // 채워져야 한다 (켬 / 3분).
        let old_json = r#"{
            "base_url": "https://plane.example.com",
            "workspace": "acme",
            "last_project_id": null
        }"#;
        let s: Settings = serde_json::from_str(old_json).unwrap();
        assert!(s.idle_open_enabled);
        assert_eq!(s.idle_open_minutes, 3);
    }
```

기존 `settings_round_trip_preserves_fields` 테스트의 struct 리터럴에 두 필드 추가:

```rust
            theme: "light".into(),
            display_index: 2,
            idle_open_enabled: false,
            idle_open_minutes: 10,
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml config`
Expected: COMPILE ERROR — `idle_open_enabled` 필드 없음

- [ ] **Step 3: 최소 구현**

`config.rs`의 `Settings` struct에 (`display_index` 필드 아래) 추가:

```rust
    /// PC 유휴 시 사이드바 자동 열기 (기본 켬).
    #[serde(default = "default_idle_open_enabled")]
    pub idle_open_enabled: bool,
    /// 자동 열기까지의 유휴 기준 시간(분).
    #[serde(default = "default_idle_open_minutes")]
    pub idle_open_minutes: u32,
```

default 함수들 근처(`default_display_index` 아래)에 추가:

```rust
fn default_idle_open_enabled() -> bool { true }
fn default_idle_open_minutes() -> u32 { 3 }
```

`impl Default for Settings`의 `Self { ... }`에 추가:

```rust
            idle_open_enabled: default_idle_open_enabled(),
            idle_open_minutes: default_idle_open_minutes(),
```

`commands.rs`의 `SettingsDto`에 추가:

```rust
    pub idle_open_enabled: bool,
    pub idle_open_minutes: u32,
```

`get_settings`의 `SettingsDto { ... }` 리터럴에 추가:

```rust
        idle_open_enabled: s.idle_open_enabled,
        idle_open_minutes: s.idle_open_minutes,
```

`save_settings` 시그니처에 파라미터 추가 (`display_index: Option<u32>,` 뒤):

```rust
    idle_open_enabled: Option<bool>,
    idle_open_minutes: Option<u32>,
```

`save_settings` 본문의 `if let Some(v) = display_index ...` 줄 뒤에 추가:

```rust
    if let Some(v) = idle_open_enabled { s.idle_open_enabled = v; }
    if let Some(v) = idle_open_minutes { if v >= 1 { s.idle_open_minutes = v; } }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 전체 `test result: ok` (config 신규 2개 + 기존 전체 통과)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/config.rs src-tauri/src/commands.rs
git commit -m "feat: add idle auto-open settings fields"
```

---

### Task 3: 설정 화면 UI (TypeScript 프런트엔드)

설정 창에 체크박스 + 분 입력을 추가하고 IPC에 배선.

**Files:**
- Modify: `src/shared/types.ts:18-23` (`SettingsDto`)
- Modify: `src/shared/ipc.ts:5-22` (`saveSettings`)
- Modify: `src/settings/index.html` (필드 추가)
- Modify: `src/settings/main.ts` (load/save 배선)
- Modify: `src/shared/app.css` (체크박스 행 스타일)

**Interfaces:**
- Consumes: Task 2의 `save_settings` 파라미터 (camelCase: `idleOpenEnabled`, `idleOpenMinutes`), `SettingsDto.idle_open_enabled`/`idle_open_minutes`
- Produces: 없음 (말단 UI)

- [ ] **Step 1: 타입/IPC 수정**

`src/shared/types.ts`의 `SettingsDto`에 추가:

```ts
export interface SettingsDto {
  base_url: string; workspace: string;
  last_project_id: string | null; has_token: boolean;
  quickadd_shortcut: string; sidebar_shortcut: string;
  theme: string; display_index: number;
  idle_open_enabled: boolean; idle_open_minutes: number;
}
```

`src/shared/ipc.ts`의 `saveSettings`를 다음으로 교체:

```ts
export const saveSettings = (
  base_url: string,
  workspace: string,
  token?: string,
  quickaddShortcut?: string,
  sidebarShortcut?: string,
  theme?: string,
  displayIndex?: number,
  idleOpenEnabled?: boolean,
  idleOpenMinutes?: number,
) =>
  invoke<void>("save_settings", {
    baseUrl: base_url,
    workspace,
    token,
    quickaddShortcut,
    sidebarShortcut,
    theme,
    displayIndex,
    idleOpenEnabled,
    idleOpenMinutes,
  });
```

- [ ] **Step 2: 설정 화면 마크업**

`src/settings/index.html`의 `<h2>화면</h2>` 섹션(테마 label 닫힌 뒤, `<p id="status"` 앞)에 추가:

```html
      <h2>사이드바 자동 열기</h2>
      <label class="check-row"><input id="idleOpenEnabled" type="checkbox" />유휴 시 사이드바 자동 열기</label>
      <label>유휴 기준 시간(분)<input id="idleOpenMinutes" type="number" min="1" /></label>
```

`src/shared/app.css`의 `.settings input::placeholder` 규칙 아래에 추가 (기존 `.settings label`은 세로 flex + input 100% 폭이라 체크박스가 어색해지는 것을 막는다):

```css
.settings label.check-row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.settings label.check-row input { width: auto; margin: 0; }
```

- [ ] **Step 3: main.ts 배선**

`src/settings/main.ts`의 엘리먼트 선언부(`const displaySelect = ...` 아래)에 추가:

```ts
const idleOpenEnabled = document.getElementById("idleOpenEnabled") as HTMLInputElement;
const idleOpenMinutes = document.getElementById("idleOpenMinutes") as HTMLInputElement;
```

`load()` 안 `theme.value = s.theme;` 근처에 추가:

```ts
  idleOpenEnabled.checked = s.idle_open_enabled;
  idleOpenMinutes.value = String(s.idle_open_minutes);
```

save 핸들러의 `saveSettings(...)` 호출을 다음으로 교체 (인자 2개 추가):

```ts
    await saveSettings(
      baseUrl.value.trim(),
      workspace.value.trim(),
      token.value || undefined,
      qaShortcut.value.trim() || undefined,
      sbShortcut.value.trim() || undefined,
      theme.value,
      Number(displaySelect.value),
      idleOpenEnabled.checked,
      Math.max(1, Math.floor(Number(idleOpenMinutes.value) || 3)),
    );
```

- [ ] **Step 4: 빌드/테스트 확인**

Run: `pnpm build && pnpm test`
Expected: 빌드 성공, vitest 전체 PASS (이 태스크는 새 프런트 테스트 없음 — 순수 배선)

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/settings/index.html src/settings/main.ts src/shared/app.css
git commit -m "feat: add idle auto-open options to settings UI"
```

---

### Task 4: Windows 유휴 시간 조회 + 폴링 워처

`GetLastInputInfo` 래퍼와 5초 폴링 tokio 태스크. 게이트가 열라고 하면 `open-sidebar` emit.

**Files:**
- Modify: `src-tauri/Cargo.toml` (windows crate 의존성)
- Modify: `src-tauri/src/idle.rs` (`system_idle_ms` 추가)
- Modify: `src-tauri/src/lib.rs` (워처 spawn)

**Interfaces:**
- Consumes: Task 1의 `IdleOpenGate`, Task 2의 `Settings.idle_open_enabled`/`idle_open_minutes`
- Produces: `sidebar` 창으로 `open-sidebar` 이벤트 (payload 없음) — Task 5가 수신

- [ ] **Step 1: 의존성 추가**

`src-tauri/Cargo.toml`의 `[dependencies]` 섹션 아래에 추가:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
    "Win32_Foundation",
    "Win32_System_SystemInformation",
    "Win32_UI_Input_KeyboardAndMouse",
] }
```

- [ ] **Step 2: `system_idle_ms` 구현**

`src-tauri/src/idle.rs`의 `IdleOpenGate` 위에 추가:

```rust
/// 마지막 키보드/마우스 입력 이후 경과 시간(ms). 조회 실패 시 None.
///
/// `GetTickCount`는 32비트라 49.7일마다 되돌지만, `wrapping_sub`으로 뺀
/// 차이값은 그 경계를 넘어도 올바르다.
#[cfg(windows)]
pub fn system_idle_ms() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: info는 cbSize가 채워진 유효한 out-파라미터다.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.dwTime)))
}

/// 배포 대상은 Windows뿐 — 다른 플랫폼에서는 유휴 감지가 꺼진 것처럼 동작한다.
#[cfg(not(windows))]
pub fn system_idle_ms() -> Option<u64> {
    None
}
```

참고: `windows` 0.61에서 `GetLastInputInfo`가 `BOOL`이 아닌 다른 반환형이면(버전에 따라 `windows_core::BOOL`) `.as_bool()` 호출은 동일하게 동작한다. 컴파일 에러가 나면 `cargo doc` 대신 에러 메시지의 실제 반환형에 맞춰 `if unsafe { ... } == false` 형태로 조정한다.

- [ ] **Step 3: 워처 spawn**

`src-tauri/src/lib.rs`에서 `use` 블록 아래 상수 영역(`UPDATE_CHECK_INTERVAL` 근처)에 추가:

```rust
/// 유휴 시간 폴링 간격. GetLastInputInfo는 시스템이 이미 기록해 둔
/// 타임스탬프를 읽을 뿐이라 이 주기로 돌려도 부담이 없다.
const IDLE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
```

`check_for_updates` 함수 근처(위나 아래)에 추가:

```rust
/// PC 유휴 시간을 폴링하다가 설정 기준(idle_open_minutes)을 넘으면
/// 사이드바에 열기 전용 이벤트를 보낸다. 설정은 매 tick 다시 읽어
/// 재시작 없이 반영된다. 유휴 세션당 1회 발화는 IdleOpenGate가 보장.
fn spawn_idle_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut gate = idle::IdleOpenGate::new();
        loop {
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
            let Some(idle_ms) = idle::system_idle_ms() else { continue };
            let s = config::load_settings(&app);
            let threshold_ms = u64::from(s.idle_open_minutes) * 60_000;
            if gate.tick(s.idle_open_enabled, idle_ms, threshold_ms) {
                let _ = app.emit_to("sidebar", "open-sidebar", ());
            }
        }
    });
}
```

`setup` 클로저 안 `check_for_updates(app.handle().clone());` 바로 아래에 추가:

```rust
            spawn_idle_watcher(app.handle().clone());
```

- [ ] **Step 4: 빌드/테스트 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 전체 `test result: ok`, 컴파일 경고 없음

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/idle.rs src-tauri/src/lib.rs
git commit -m "feat: poll system idle time and emit open-sidebar event"
```

---

### Task 5: 사이드바 `open-sidebar` 수신 + CHANGELOG

프런트엔드가 이벤트를 받아 닫혀 있을 때만 연다. 기능이 이 커밋에서 사용자에게 보이게 되므로 CHANGELOG도 여기서 기록.

**Files:**
- Modify: `src/sidebar/main.ts:787-795` (리스너 등록부)
- Modify: `CHANGELOG.md` (`## [Unreleased]` 섹션)

**Interfaces:**
- Consumes: Task 4의 `open-sidebar` 이벤트, 기존 `showSidebar()` (`src/sidebar/main.ts:559`)

- [ ] **Step 1: 리스너 추가**

`src/sidebar/main.ts`의 `win.listen("toggle-sidebar", ...)` 등록부 아래에 추가:

```ts
// 백엔드 유휴 워처(spawn_idle_watcher)가 보내는 열기 전용 이벤트.
// toggle과 달리 이미 열려 있으면 아무것도 하지 않는다 — 폴링이 토글로
// 이어지면 열려 있던 사이드바를 닫아 버릴 수 있어서 이벤트를 분리했다.
win.listen("open-sidebar", async () => {
  if (!(await win.isVisible())) await showSidebar();
});
```

- [ ] **Step 2: CHANGELOG 기록**

`CHANGELOG.md`의 `## [Unreleased]` 섹션에 (없으면 `### 추가` 헤더 생성 후):

```markdown
### 추가

- PC를 일정 시간(기본 3분, 설정에서 조절 가능) 사용하지 않으면 사이드바가 자동으로 열립니다. 설정에서 끌 수 있습니다.
```

- [ ] **Step 3: 전체 빌드/테스트 확인**

Run: `pnpm build && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 빌드 성공, vitest 전체 PASS, cargo 전체 `test result: ok`

- [ ] **Step 4: 커밋**

```bash
git add src/sidebar/main.ts CHANGELOG.md
git commit -m "feat: auto-open sidebar when the PC goes idle"
```

- [ ] **Step 5: 수동 검증 (개발 실행)**

Run: `pnpm tauri dev` (백그라운드)
확인 절차:
1. 설정 창에 "사이드바 자동 열기" 섹션이 보이고 체크박스 켬 / 3분이 기본인지
2. 유휴 기준을 1분으로 저장 → 1분간 입력 없이 대기 → 사이드바가 슬라이드 인으로 열리는지
3. 사이드바를 닫고 계속 입력 없이 대기 → 다시 열리지 **않는지** (세션당 1회)
4. 마우스를 움직였다가 다시 1분 대기 → 다시 열리는지
5. 설정에서 끄고 1분 대기 → 열리지 않는지
