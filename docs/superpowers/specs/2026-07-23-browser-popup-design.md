# 작업 항목을 브라우저 앱 모드 팝업으로 열기 — 설계 스펙

- 날짜: 2026-07-23
- 상태: 사용자 승인 대기

## 목적

`editmodal`의 🌐 버튼과 사이드바 컨텍스트 메뉴의 "브라우저에서 열기"는 지금
`openUrl()`(tauri-plugin-opener)로 시스템 기본 브라우저를 **일반 창**으로 연다 —
탭·주소창·즐겨찾기 바가 그대로 딸려 나와 "이 작업 하나"를 보려는 목적에 비해
무겁다.

같은 URL을 Chromium 계열 브라우저의 **앱 모드**(`--app=<url>`)로 열면 탭·주소창
없이 고정 크기의 독립 창만 뜬다. 이 스펙은 그 전환을 다룬다.

**범위**: 작업 항목 URL(`buildIssueUrl`)을 여는 두 지점만 — `editmodal`의
`emBrowserBtn`, 사이드바의 `openInBrowser`(컨텍스트 메뉴). `settings`의 API 토큰
페이지 등 다른 `openUrl` 호출은 그대로 둔다.

## 핵심 설계 결정

1. **판별은 Rust 쪽에서, 프론트엔드는 커맨드 호출 하나로 끝.** 브라우저 감지·
   폴백 로직을 프론트엔드에 노출하지 않는다 — 실패 시 프런트가 알아야 할 건
   "성공했다" 또는 "에러 메시지" 뿐이다.
2. **감지 실패 시 조용히 폴백한다.** 레지스트리 구조가 다르거나(비표준 설치,
   그룹 정책 등) 기본 브라우저가 Chromium이 아니면(Firefox 등) 기존
   `openUrl()`과 동일하게 일반 창으로 연다. 사용자에게 "왜 안 되지"를 안겨주지
   않는다.
3. **새 의존성은 `winreg` 하나만.** 레지스트리 두 단계(`UserChoice` →
   `shell\open\command`)를 읽는 데는 기존 `windows` 크레이트의 raw Win32 API보다
   훨씬 간결하다.
4. **창 위치는 기존 `monitors::centered_position()`을 재사용한다.** 좌표 계산
   로직을 새로 만들지 않는다.

## 1. 브라우저 감지 (`src-tauri/src/browser_popup.rs`, 새 모듈)

```rust
/// `HKCU\...\UrlAssociations\https\UserChoice`의 ProgId → `HKCR\<ProgId>\shell\open\command`
/// 순으로 읽어 기본 브라우저의 실행 파일 경로를 반환한다. 각 단계 실패는 `None`.
fn default_browser_exe() -> Option<String> { ... }

/// `"C:\...\chrome.exe" -- "%1"` 형태의 명령 문자열에서 exe 경로만 뽑아낸다.
/// 따옴표로 감싸져 있으면 그 안쪽을, 아니면 첫 토큰(공백 전까지)을 반환한다.
pub fn parse_open_command(cmd: &str) -> Option<String> { ... }

/// exe 파일명(대소문자 무시)이 알려진 Chromium 계열이면 true.
pub fn is_chromium_browser(exe_path: &str) -> bool {
    let known = ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe"];
    // Path::file_name()으로 파일명만 뽑아 소문자 비교
}
```

`parse_open_command`/`is_chromium_browser`는 순수 함수라 레지스트리 없이
`cargo test`로 검증한다 (`monitors.rs`, `config.rs`와 같은 패턴).

## 2. 창 크기 · 위치

- 크기 고정: `1100x800`
- 위치: 커맨드를 호출한 창(`editmodal` 또는 `sidebar`)의 `available_monitors()`로
  주 모니터를 찾고, `monitors::centered_position((1100, 800), monitor_pos,
  monitor_size)`로 좌표 계산
- 브라우저 인자: `--app=<url> --window-size=1100,800 --window-position=<x>,<y>`

## 3. 커맨드 (`commands.rs`)

```rust
#[tauri::command]
pub async fn open_issue_popup(app: tauri::AppHandle, window: tauri::Window, url: String) -> Result<(), String> {
    if let Some(exe) = browser_popup::default_browser_exe()
        .filter(|p| browser_popup::is_chromium_browser(p))
    {
        if let Some((x, y)) = popup_position(&window) {
            let spawned = std::process::Command::new(&exe)
                .arg(format!("--app={url}"))
                .arg("--window-size=1100,800")
                .arg(format!("--window-position={x},{y}"))
                .spawn();
            if spawned.is_ok() {
                return Ok(());
            }
        }
    }
    // 감지 실패 / Chromium 아님 / 프로세스 spawn 실패 → 기존 방식으로 폴백
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}
```

`popup_position`은 `window.available_monitors()` + `monitors::centered_position()`을
감싼 작은 헬퍼. 모니터 조회가 실패해도(드물게) 폴백 경로로 빠진다.

`app.opener()`는 `tauri_plugin_opener::OpenerExt` 트레이트가 제공한다(`use
tauri_plugin_opener::OpenerExt;` 필요) — 이미 `lib.rs`에 플러그인이 등록돼 있으니
(`.plugin(tauri_plugin_opener::init())`) 별도 설정 없이 바로 쓸 수 있다.

## 4. 프론트엔드 연결

- `editmodal/main.ts`의 `openInBrowser()` — `openUrl(url)` → `invoke("open_issue_popup", { url })`
- `sidebar/main.ts`의 `openExternal()` — 동일 교체. `win.setAlwaysOnTop(false)` 호출은
  그대로 유지(팝업이 사이드바 뒤에 가리지 않도록 하는 기존 목적 그대로 적용됨).
- 에러 처리: 기존 `catch` 블록의 "열기 실패: …" 문구를 그대로 재사용. 커맨드가
  내부 폴백까지 실패했을 때만(즉 `openUrl`조차 실패) 여기 도달한다.
- `settings/main.ts`의 API 토큰 페이지 `openUrl` 호출은 변경하지 않는다.

## 5. 테스트

Rust:
- `parse_open_command` — 따옴표 있는/없는 경로, `-- "%1"` 접미사 유무
- `is_chromium_browser` — 대소문자 섞인 파일명, 알려지지 않은 브라우저(false),
  경로에 `chrome`이 포함되지만 파일명은 다른 경우(false — 파일명만 비교)

기존 `monitors::centered_position` 테스트는 그대로 재사용(로직 변경 없음).

프론트엔드 단위 테스트는 추가하지 않는다 — `invoke` 호출 교체 외 로직 변화가
없다.

## 구현 순서

1. `winreg` 의존성 추가, `browser_popup.rs` 작성 + 단위 테스트
2. `commands.rs`에 `open_issue_popup` 커맨드 + `lib.rs`에 등록
3. `editmodal/main.ts`, `sidebar/main.ts` 호출부 교체
4. 수동 확인: 기본 브라우저가 Edge/Chrome일 때 팝업 동작, Firefox로 바꿔서
   폴백 동작 확인

## CHANGELOG

```
### 변경
- 작업 항목을 브라우저에서 열면 탭 없는 작은 팝업 창으로 뜹니다
```
