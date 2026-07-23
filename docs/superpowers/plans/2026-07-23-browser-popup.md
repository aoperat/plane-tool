# 작업 항목 브라우저 팝업 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `editmodal`의 🌐 버튼과 사이드바의 "브라우저에서 열기"가 작업 항목 URL을 여는 방식을, 시스템 기본 브라우저의 일반 창 대신 탭 없는 앱 모드(`--app=<url>`) 팝업 창으로 바꾼다. 기본 브라우저가 Chromium 계열이 아니거나 감지에 실패하면 기존 방식(`openUrl`)으로 조용히 폴백한다.

**Architecture:** 새 Rust 모듈 `src-tauri/src/browser_popup.rs`가 레지스트리에서 기본 브라우저 exe 경로를 읽고 Chromium 계열인지 판별한다. 새 Tauri 커맨드 `open_issue_popup`(`commands.rs`)이 이 판별 결과로 `--app` 팝업을 `std::process::Command`로 띄우거나, 실패 시 기존 `tauri-plugin-opener`로 폴백한다. 프론트엔드는 `editmodal`/`sidebar`의 기존 `openUrl(url)` 호출 두 곳을 `invoke("open_issue_popup", { url })`로 교체한다.

**Tech Stack:** Rust (Tauri 2), `winreg` 크레이트(신규), TypeScript, vitest, cargo test.

## Global Constraints

- 새 의존성은 `winreg`만 추가한다 (스펙 §핵심 설계 결정 3).
- 팝업 대상은 작업 항목 URL을 여는 두 지점만 — `editmodal`의 `emBrowserBtn`, 사이드바의 `openInBrowser`(스펙 §목적 "범위"). `settings`의 API 토큰 페이지 `openUrl`은 건드리지 않는다.
- 팝업 창 크기는 `1100x800` 고정, 위치는 사용자가 설정에서 고른 디스플레이(`display_index`) 중앙 (스펙 §2).
- Chromium 판별 목록: `chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe`, `opera.exe` (대소문자 무시, 파일명만 비교) (스펙 §1).
- 감지·spawn 실패는 전부 조용히 `openUrl` 폴백으로 이어진다 — 프론트엔드에 별도 에러를 노출하지 않는다 (스펙 §핵심 설계 결정 2, §3).
- 사용자에게 보이는 변경이므로 CHANGELOG.md `[Unreleased]` → `### 변경`에 한 줄 추가한다 (프로젝트 CLAUDE.md 규칙, 스펙 §CHANGELOG에 문구 확정됨).

참고 스펙: `docs/superpowers/specs/2026-07-23-browser-popup-design.md`

---

### Task 1: `browser_popup.rs` — 순수 판별 함수 + 기본 브라우저 감지

**Files:**
- Create: `src-tauri/src/browser_popup.rs`
- Modify: `src-tauri/src/lib.rs:2` (mod 목록에 `pub mod browser_popup;` 추가, `briefing` 다음·`commands` 앞 — 알파벳 순서 유지)
- Modify: `src-tauri/Cargo.toml:27` (`keyring` 다음 줄에 `winreg = "0.56"` 추가)

**Interfaces:**
- Produces:
  - `pub fn parse_open_command(cmd: &str) -> Option<String>`
  - `pub fn is_chromium_browser(exe_path: &str) -> bool`
  - `pub fn default_browser_exe() -> Option<String>`

- [ ] **Step 1: Cargo.toml에 winreg 추가**

`src-tauri/Cargo.toml`의 `keyring = { version = "3", features = ["windows-native"] }` 줄 바로 아래에 추가:

```toml
winreg = "0.56"
```

- [ ] **Step 2: `parse_open_command`, `is_chromium_browser`의 실패하는 테스트 작성**

`src-tauri/src/browser_popup.rs` 새로 생성:

```rust
pub fn parse_open_command(cmd: &str) -> Option<String> {
    unimplemented!()
}

pub fn is_chromium_browser(exe_path: &str) -> bool {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_open_command_extracts_quoted_path() {
        let cmd = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" -- "%1""#;
        assert_eq!(
            parse_open_command(cmd),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string())
        );
    }

    #[test]
    fn parse_open_command_extracts_unquoted_path() {
        let cmd = r"C:\Browser\browser.exe %1";
        assert_eq!(parse_open_command(cmd), Some(r"C:\Browser\browser.exe".to_string()));
    }

    #[test]
    fn parse_open_command_empty_string_returns_none() {
        assert_eq!(parse_open_command(""), None);
    }

    #[test]
    fn is_chromium_browser_matches_known_browsers_case_insensitive() {
        assert!(is_chromium_browser(r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
        assert!(is_chromium_browser(r"C:\Program Files (x86)\Microsoft\Edge\Application\MSEDGE.EXE"));
        assert!(is_chromium_browser(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"));
    }

    #[test]
    fn is_chromium_browser_rejects_firefox() {
        assert!(!is_chromium_browser(r"C:\Program Files\Mozilla Firefox\firefox.exe"));
    }

    #[test]
    fn is_chromium_browser_only_matches_file_name_not_path_substring() {
        // "chrome"이 경로에 들어 있어도 파일명 자체가 알려진 값이 아니면 false.
        assert!(!is_chromium_browser(r"C:\chrome-tools\launcher.exe"));
    }
}
```

- [ ] **Step 3: `lib.rs`에 모듈 등록**

`src-tauri/src/lib.rs`의 mod 목록(`pub mod assign_watch;` ~ `pub mod plane_api;`)에서 `pub mod briefing;` 다음 줄에 추가:

```rust
pub mod browser_popup;
```

- [ ] **Step 4: 테스트 실행 → 컴파일 실패 확인**

Run: `cd src-tauri; cargo test browser_popup`
Expected: `unimplemented!()`로 인한 패닉으로 6개 테스트 모두 FAIL (컴파일은 성공)

- [ ] **Step 5: `parse_open_command`, `is_chromium_browser` 구현**

`unimplemented!()` 대신 실제 구현으로 교체:

```rust
/// `"C:\...\chrome.exe" -- "%1"` 형태의 레지스트리 open 커맨드 문자열에서
/// exe 경로만 뽑아낸다. 따옴표로 감싸져 있으면 그 안쪽을, 아니면 첫 토큰을 반환한다.
pub fn parse_open_command(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    if let Some(rest) = cmd.strip_prefix('"') {
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    } else {
        cmd.split_whitespace().next().map(|s| s.to_string())
    }
}

/// exe 파일명(대소문자 무시, 파일명만 비교 — 디렉터리 이름은 보지 않음)이
/// 알려진 Chromium 계열 브라우저면 true.
pub fn is_chromium_browser(exe_path: &str) -> bool {
    const KNOWN: [&str; 5] = ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe"];
    std::path::Path::new(exe_path)
        .file_name()
        .and_then(|f| f.to_str())
        .map(|f| KNOWN.contains(&f.to_lowercase().as_str()))
        .unwrap_or(false)
}
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `cd src-tauri; cargo test browser_popup`
Expected: 6개 테스트 모두 PASS

- [ ] **Step 7: `default_browser_exe` 구현 (레지스트리 I/O — 순수 함수 아님, 자동 테스트 대상 아님)**

같은 파일에 추가:

```rust
/// `HKCU\...\UrlAssociations\https\UserChoice`의 ProgId를 읽고,
/// `HKCR\<ProgId>\shell\open\command`의 기본값에서 exe 경로를 뽑는다.
/// 레지스트리 구조가 다르거나 값이 없으면 `None` — 호출부가 폴백한다.
pub fn default_browser_exe() -> Option<String> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let user_choice = hkcu
        .open_subkey(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice")
        .ok()?;
    let prog_id: String = user_choice.get_value("ProgId").ok()?;

    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    let command_key = hkcr.open_subkey(format!(r"{prog_id}\shell\open\command")).ok()?;
    let command: String = command_key.get_value("").ok()?;

    parse_open_command(&command)
}
```

레지스트리 값은 개발자 PC 상태에 따라 달라 unit test로 고정할 수 없다. 대신 실제 레지스트리를 읽어 눈으로 확인하는 무시된(`#[ignore]`) 테스트를 하나 남긴다 — CI에서는 안 돌고, 개발자가 로컬에서 수동으로 돌려본다:

```rust
    #[test]
    #[ignore = "실제 Windows 레지스트리를 읽는다 — CI에서 돌리지 않음. 로컬에서 수동 확인용."]
    fn manual_check_default_browser_exe() {
        let exe = default_browser_exe();
        println!("detected default browser exe: {exe:?}");
        assert!(exe.is_some(), "레지스트리에서 기본 브라우저를 찾지 못했다");
    }
```

- [ ] **Step 8: 수동 확인 테스트 실행**

Run: `cd src-tauri; cargo test manual_check_default_browser_exe -- --ignored --nocapture`
Expected: 현재 개발 PC의 기본 브라우저 exe 경로가 출력되고 PASS (예: `detected default browser exe: Some("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")`)

- [ ] **Step 9: 전체 Rust 테스트 실행**

Run: `cd src-tauri; cargo test`
Expected: 기존 테스트 전부 PASS, `manual_check_default_browser_exe`는 `--ignored` 없이는 실행되지 않으므로 이번엔 스킵으로 표시됨

- [ ] **Step 10: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/browser_popup.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat: 기본 브라우저 감지 + Chromium 판별 추가

작업 항목 팝업 기능의 기반 — 레지스트리에서 기본 브라우저 exe를 찾고
Chromium 계열인지 판별하는 순수 함수를 추가한다.
EOF
)"
```

---

### Task 2: `popup_position` — 팝업 창 좌표 계산

**Files:**
- Modify: `src-tauri/src/browser_popup.rs`

**Interfaces:**
- Consumes:
  - `crate::monitors::sorted_indices_by_position(positions: &[(i32, i32)]) -> Vec<usize>`
  - `crate::monitors::pick_index(sorted_indices: &[usize], display_index: u32) -> Option<usize>`
  - `crate::monitors::centered_position(window_size: (i32, i32), monitor_position: (i32, i32), monitor_size: (i32, i32)) -> (i32, i32)`
  - `crate::config::load_settings(app: &tauri::AppHandle) -> crate::config::Settings` (`.display_index: u32` 필드)
- Produces:
  - `pub fn popup_position(app: &tauri::AppHandle, window_size: (i32, i32)) -> Option<(i32, i32)>`

이 함수는 실행 중인 `tauri::AppHandle`과 실제 모니터 목록이 있어야 동작하므로 unit test 대상이 아니다 (좌표 계산 자체는 이미 `monitors::centered_position`에서 테스트됨). Task 4의 수동 E2E 확인에서 함께 검증한다.

- [ ] **Step 1: `popup_position` 구현**

`src-tauri/src/browser_popup.rs`에 추가:

```rust
/// `sidebar` 창(항상 떠 있는 메인 창)의 모니터 목록에서 사용자가 설정한
/// `display_index` 디스플레이를 찾아, 그 중앙에 `window_size` 크기 창을 놓을
/// 좌표를 반환한다. `lib.rs`의 `show_centered`와 같은 계산을 쓴다.
pub fn popup_position(app: &tauri::AppHandle, window_size: (i32, i32)) -> Option<(i32, i32)> {
    use tauri::Manager;

    let win = app.get_webview_window("sidebar")?;
    let mons = win.available_monitors().ok()?;
    let positions: Vec<(i32, i32)> = mons.iter().map(|m| (m.position().x, m.position().y)).collect();
    let sorted = crate::monitors::sorted_indices_by_position(&positions);
    let display_index = crate::config::load_settings(app).display_index;
    let i = crate::monitors::pick_index(&sorted, display_index)?;
    let m = &mons[i];
    Some(crate::monitors::centered_position(
        window_size,
        (m.position().x, m.position().y),
        (m.size().width as i32, m.size().height as i32),
    ))
}
```

- [ ] **Step 2: 컴파일 확인**

Run: `cd src-tauri; cargo check`
Expected: 에러 없이 컴파일 성공

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/browser_popup.rs
git commit -m "feat: 팝업 창 좌표 계산 추가 (사용자가 설정한 디스플레이 중앙)"
```

---

### Task 3: `open_issue_popup` Tauri 커맨드

**Files:**
- Modify: `src-tauri/src/commands.rs` (파일 끝에 추가)
- Modify: `src-tauri/src/lib.rs:768-796` (`invoke_handler` 목록에 등록)

**Interfaces:**
- Consumes:
  - `crate::browser_popup::default_browser_exe() -> Option<String>`
  - `crate::browser_popup::is_chromium_browser(exe_path: &str) -> bool`
  - `crate::browser_popup::popup_position(app: &tauri::AppHandle, window_size: (i32, i32)) -> Option<(i32, i32)>`
  - `tauri_plugin_opener::OpenerExt::opener(&self) -> &Opener` → `.open_url(url, with: Option<impl Into<String>>) -> Result<()>`
- Produces:
  - `#[tauri::command] pub fn open_issue_popup(app: tauri::AppHandle, url: String) -> Result<(), String>` — 프론트엔드가 `invoke("open_issue_popup", { url })`로 호출

- [ ] **Step 1: 커맨드 구현**

`src-tauri/src/commands.rs` 파일 끝에 추가:

```rust
/// 작업 항목 URL을 연다. 기본 브라우저가 Chromium 계열이면 탭 없는 앱 모드
/// 팝업으로, 아니면(감지 실패 포함) 기존 방식(`tauri-plugin-opener`)으로 연다.
#[tauri::command]
pub fn open_issue_popup(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let popup_launched = crate::browser_popup::default_browser_exe()
        .filter(|exe| crate::browser_popup::is_chromium_browser(exe))
        .and_then(|exe| {
            let (x, y) = crate::browser_popup::popup_position(&app, (1100, 800))?;
            std::process::Command::new(&exe)
                .arg(format!("--app={url}"))
                .arg("--window-size=1100,800")
                .arg(format!("--window-position={x},{y}"))
                .spawn()
                .ok()
        })
        .is_some();

    if popup_launched {
        return Ok(());
    }
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: `invoke_handler`에 등록**

`src-tauri/src/lib.rs`의 `.invoke_handler(tauri::generate_handler![...])` 목록에서 `commands::open_conflict_window` 다음 줄에 추가:

```rust
            commands::open_conflict_window,
            commands::open_issue_popup
```

(마지막 항목이던 `open_conflict_window` 뒤에 콤마를 붙이고 `open_issue_popup`을 새 마지막 항목으로)

- [ ] **Step 3: 빌드 확인**

Run: `cd src-tauri; cargo build`
Expected: 에러 없이 빌드 성공

- [ ] **Step 4: 전체 Rust 테스트 재확인**

Run: `cd src-tauri; cargo test`
Expected: 기존 테스트 전부 PASS (회귀 없음)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: open_issue_popup 커맨드 추가 및 등록"
```

---

### Task 4: 프론트엔드 연결 — `editmodal`, `sidebar`

**Files:**
- Modify: `src/shared/ipc.ts` (새 wrapper 추가)
- Modify: `src/editmodal/main.ts:2, 460-472`
- Modify: `src/sidebar/main.ts:2, 634-642`

**Interfaces:**
- Consumes: `open_issue_popup` 커맨드 (Task 3)
- Produces: `export const openIssuePopup = (url: string) => Promise<void>` — 다른 화면에서도 재사용 가능

- [ ] **Step 1: `shared/ipc.ts`에 wrapper 추가**

`src/shared/ipc.ts`의 `verifyDelegatedTabPassword` 정의 바로 아래에 추가:

```ts
export const openIssuePopup = (url: string) => invoke<void>("open_issue_popup", { url });
```

- [ ] **Step 2: `editmodal/main.ts` 수정**

`src/editmodal/main.ts:2`에서 제거:

```ts
import { openUrl } from "@tauri-apps/plugin-opener";
```

`src/editmodal/main.ts:3`의 기존 import에 `openIssuePopup` 추가:

```ts
import { deleteWorkItem, getSettings, getWorkItem, listMembers, openIssuePopup, updateWorkItemFields, type UpdateWorkItemFields } from "../shared/ipc";
```

`openInBrowser` 함수(460~472번 줄) 안의 `await openUrl(url);`을 교체:

```ts
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
```

- [ ] **Step 3: `sidebar/main.ts` 수정**

`src/sidebar/main.ts:2`에서 제거:

```ts
import { openUrl } from "@tauri-apps/plugin-opener";
```

`src/sidebar/main.ts:5`의 기존 import 목록에 `openIssuePopup` 추가 (알파벳 순서 유지 — `openEditModal` 다음, `openSettings` 앞):

```ts
import { acknowledgeAssignment, checkUpdatesManual, createIssue, deleteWorkItem, fetchCycleData, fetchReleaseNotes, fetchSidebarData, getConflicts, getOfflineStatus, getPendingAssignments, getSettings, openBriefing, openConflictWindow, openEditModal, openIssuePopup, openSettings, saveSettings, showQuickaddForProject, updateWorkItemFields, updateWorkItemPriority, updateWorkItemState } from "../shared/ipc";
```

`openExternal` 함수(634~642번 줄)의 `await openUrl(url);`을 교체:

```ts
/** Opens `url` in the default browser, dropping always-on-top first so the
 *  browser window can appear above the sidebar instead of behind it. */
async function openExternal(url: string) {
  try {
    await win.setAlwaysOnTop(false);
    await openIssuePopup(url);
  } catch (err) {
    synced.textContent = "열기 실패: " + err;
    console.error("openIssuePopup failed:", url, err);
  }
}
```

- [ ] **Step 4: 타입체크**

Run: `pnpm exec tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 5: 프론트엔드 테스트 실행**

Run: `pnpm exec vitest run`
Expected: 기존 테스트 전부 PASS (이번 변경으로 추가된 pure-logic 테스트는 없음 — `invoke` 호출 교체만)

- [ ] **Step 6: CHANGELOG 업데이트**

`CHANGELOG.md`의 `## [Unreleased]` 섹션(6번 줄, 현재 비어 있음)을 아래로 교체:

```markdown
## [Unreleased]

### 변경

- 작업 항목을 브라우저에서 열면 탭 없는 작은 팝업 창으로 뜹니다
```

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/editmodal/main.ts src/sidebar/main.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat: 작업 항목을 브라우저 앱 모드 팝업으로 열기

editmodal과 사이드바의 "브라우저에서 열기"가 open_issue_popup 커맨드를
호출해, 기본 브라우저가 Chromium 계열이면 탭 없는 팝업 창으로 연다.
EOF
)"
```

---

### Task 5: 수동 End-to-End 확인

**Files:** 없음 (수동 확인만)

- [ ] **Step 1: 개발 모드로 앱 실행**

Run: `pnpm tauri dev`

- [ ] **Step 2: 기본 브라우저가 Chromium일 때 팝업 확인**

Windows 설정 → 앱 → 기본 앱에서 기본 브라우저가 Edge 또는 Chrome인지 확인(둘 중 하나면 그대로 진행). 사이드바에서 작업 항목을 우클릭 → "브라우저에서 열기" 클릭.
Expected: 탭·주소창 없는 작은 창(1100x800)이 설정된 디스플레이 중앙에 뜨고, Plane 로그인 세션이 유지된 채 해당 작업이 보인다.

- [ ] **Step 3: `editmodal`에서도 확인**

사이드바에서 작업 항목을 열어 `editmodal`을 띄운 뒤 🌐 버튼 클릭.
Expected: Step 2와 동일하게 팝업으로 열림.

- [ ] **Step 4: Firefox 폴백 확인 (Firefox가 설치돼 있는 경우)**

Windows 설정에서 기본 브라우저를 Firefox로 임시 변경 → 사이드바에서 작업 항목 "브라우저에서 열기" 클릭.
Expected: 팝업이 아니라 일반 Firefox 창(탭 포함)으로 열림 — 폴백 동작 확인. 확인 후 기본 브라우저를 원래대로 되돌린다.

- [ ] **Step 5: 최종 빌드 확인**

Run: `pnpm exec tsc --noEmit && cd src-tauri && cargo test && cargo build`
Expected: 전부 에러 없이 통과
