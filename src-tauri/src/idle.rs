//! PC 유휴 시 사이드바 자동 열기 판정.
//!
//! OS 호출(`system_idle_ms`)과 판정 로직(`IdleOpenGate`)을 분리해 판정
//! 로직을 단위 테스트할 수 있게 한다.

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
