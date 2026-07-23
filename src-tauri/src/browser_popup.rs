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

/// 마지막으로 연 팝업 창의 HWND(정수로 저장 — HWND 자체는 스레드 간 전달이
/// 안전하지 않은 raw pointer라 Tauri managed state에 그대로 둘 수 없다).
#[derive(Default)]
pub struct PopupWindow(pub std::sync::Mutex<Option<isize>>);

unsafe extern "system" fn collect_visible_window(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    let handles = unsafe { &mut *(lparam.0 as *mut std::collections::HashSet<isize>) };
    if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd) }.as_bool() {
        handles.insert(hwnd.0 as isize);
    }
    windows::core::BOOL(1)
}

fn visible_window_handles() -> std::collections::HashSet<isize> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut handles: std::collections::HashSet<isize> = std::collections::HashSet::new();
    let lparam = LPARAM(&mut handles as *mut std::collections::HashSet<isize> as isize);
    unsafe {
        let _ = EnumWindows(Some(collect_visible_window), lparam);
    }
    handles
}

fn window_class_name(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..len])
}

/// `before`에 없던 새 창 중 Chrome/Edge 최상위 창 클래스(`Chrome_WidgetWin_1`)인
/// 것을 최대 `timeout` 동안 짧은 간격으로 찾는다. 방금 띄운 팝업을 다음번에
/// 닫기 위해 추적하는 용도 — 못 찾으면 `None`(팝업 자체는 이미 열렸으니 실패로
/// 취급하지 않고, 다음 호출에서 자동으로 닫는 것만 포기한다).
///
/// 위치·크기로 대상을 좁히지 않는다 — Chrome은 같은 URL을 반복해서 `--app`으로
/// 열면 `--window-position`/`--window-size`를 무시하고 그 앱의 마지막 창
/// 위치를 그대로 복원하는 경우가 있어(직접 확인함), 요청한 좌표와 실제 창
/// 좌표가 안 맞을 수 있다. "방금 새로 생긴 Chrome 최상위 창"이라는 시점
/// 정보만으로 충분히 구분된다.
fn find_new_popup_window(before: &std::collections::HashSet<isize>, timeout: std::time::Duration) -> Option<isize> {
    use windows::Win32::Foundation::HWND;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        for &raw in visible_window_handles().difference(before) {
            let hwnd = HWND(raw as *mut std::ffi::c_void);
            if window_class_name(hwnd) == "Chrome_WidgetWin_1" {
                return Some(raw);
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// `hwnd`가 아직 유효한 창이면 닫는다(`WM_CLOSE`). 사용자가 이미 손으로 닫았으면
/// 조용히 무시한다.
fn close_window(hwnd: isize) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, PostMessageW, WM_CLOSE};

    let h = HWND(hwnd as *mut std::ffi::c_void);
    if unsafe { IsWindow(Some(h)) }.as_bool() {
        let _ = unsafe { PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    }
}

/// `exe`로 `url`을 앱 모드 팝업으로 연다. 이전에 이 함수로 연 팝업이 아직
/// 열려 있으면(사용자가 손으로 닫지 않았으면) 먼저 닫아, 항상 팝업이 하나만
/// 떠 있게 한다. `app`은 `PopupWindow` 상태가 등록돼 있어야 한다(`lib.rs`).
pub fn open_popup_window(
    app: &tauri::AppHandle,
    exe: &str,
    url: &str,
    position: (i32, i32),
    size: (i32, i32),
) -> Option<()> {
    use tauri::Manager;

    let state = app.state::<PopupWindow>();
    if let Some(prev) = state.0.lock().unwrap().take() {
        close_window(prev);
    }

    let before = visible_window_handles();
    let (x, y) = position;
    let (w, h) = size;
    std::process::Command::new(exe)
        .arg(format!("--app={url}"))
        .arg(format!("--window-size={w},{h}"))
        .arg(format!("--window-position={x},{y}"))
        .spawn()
        .ok()?;

    if let Some(hwnd) = find_new_popup_window(&before, std::time::Duration::from_secs(6)) {
        *state.0.lock().unwrap() = Some(hwnd);
    }
    Some(())
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

    #[test]
    #[ignore = "실제 Windows 레지스트리를 읽는다 — CI에서 돌리지 않음. 로컬에서 수동 확인용."]
    fn manual_check_default_browser_exe() {
        let exe = default_browser_exe();
        println!("detected default browser exe: {exe:?}");
        assert!(exe.is_some(), "레지스트리에서 기본 브라우저를 찾지 못했다");
    }

    /// `open_popup_window`이 하는 것과 같은 순서(spawn → 찾기 → 다음 번엔 닫기)를
    /// Tauri 앱 없이 직접 재현해, "이전 팝업이 실제로 닫히고 새 팝업만 남는지"를
    /// 검증한다. example.com/example.org는 IANA가 문서·테스트용으로 예약한
    /// 도메인이라 실제 서비스에 영향이 없다.
    #[test]
    #[ignore = "실제 브라우저 창을 띄우고 닫는다 — CI에서 돌리지 않음. 로컬에서 수동 확인용."]
    fn manual_check_single_popup_close_and_reopen() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::IsWindow;

        let exe = default_browser_exe().expect("기본 브라우저를 찾지 못했다");
        assert!(is_chromium_browser(&exe), "기본 브라우저가 Chromium 계열이 아니다: {exe}");

        let before1 = visible_window_handles();
        let mut child1 = std::process::Command::new(&exe)
            .arg("--app=https://example.com")
            .arg("--window-size=900,700")
            .arg("--window-position=100,100")
            .spawn()
            .expect("첫 팝업 spawn 실패");
        let hwnd1 = find_new_popup_window(&before1, std::time::Duration::from_secs(10))
            .expect("첫 팝업 창을 찾지 못했다");
        println!("popup 1 hwnd = {hwnd1}");

        let before2 = visible_window_handles();
        let mut child2 = std::process::Command::new(&exe)
            .arg("--app=https://example.org")
            .arg("--window-size=900,700")
            .arg("--window-position=300,300")
            .spawn()
            .expect("두 번째 팝업 spawn 실패");
        let hwnd2 = find_new_popup_window(&before2, std::time::Duration::from_secs(10))
            .expect("두 번째 팝업 창을 찾지 못했다");
        println!("popup 2 hwnd = {hwnd2}");

        // open_popup_window이 다음 호출 시 하는 일: 직전 팝업(hwnd1)만 닫는다.
        close_window(hwnd1);
        std::thread::sleep(std::time::Duration::from_millis(800));

        let hwnd1_still_open = unsafe { IsWindow(Some(HWND(hwnd1 as *mut std::ffi::c_void))) }.as_bool();
        let hwnd2_still_open = unsafe { IsWindow(Some(HWND(hwnd2 as *mut std::ffi::c_void))) }.as_bool();
        println!("after closing popup1: popup1 open = {hwnd1_still_open}, popup2 open = {hwnd2_still_open}");

        // 정리 — 검증 전에라도 반드시 닫는다.
        close_window(hwnd2);
        let _ = child1.kill();
        let _ = child2.kill();

        assert!(!hwnd1_still_open, "popup1이 안 닫혔다");
        assert!(hwnd2_still_open, "popup2가 실수로 같이 닫혔다");
    }
}
