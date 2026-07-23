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
}
