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

/// 한 폴링 tick의 판정 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleAction {
    /// 아무 일도 하지 않는다.
    None,
    /// 사이드바를 자동으로 연다 (유휴 세션당 1회).
    OpenSidebar,
    /// 입력이 재개되어 유휴 세션이 끝났다 — 자동 열림 보호를 해제한다.
    IdleEnded,
}

/// 유휴 세션당 한 번만 자동 열림을 발화시키는 게이트.
///
/// "유휴 세션"은 유휴 시간이 기준을 넘은 시점부터 입력 재개로 기준
/// 아래로 떨어질 때까지다. 한 세션에서 이미 열었으면 사용자가 닫아도
/// 다시 열지 않는다 — 닫자마자 또 열리는 짜증을 막기 위해.
///
/// 유휴 세션이 끝나는 tick에는 `IdleEnded`를 정확히 한 번 보고한다.
/// 프런트엔드는 이 신호로 "자동 열림 상태(입력 없이는 닫히지 않음)"를
/// 해제하고 평소 blur 자동 숨김 규칙으로 복귀한다.
pub struct IdleOpenGate {
    fired: bool,
    was_idle: bool,
}

impl IdleOpenGate {
    pub fn new() -> Self {
        Self { fired: false, was_idle: false }
    }

    /// 매 폴링 tick마다 호출.
    pub fn tick(&mut self, enabled: bool, idle_ms: u64, threshold_ms: u64) -> IdleAction {
        if idle_ms < threshold_ms {
            let ended = self.was_idle;
            self.was_idle = false;
            self.fired = false;
            return if ended { IdleAction::IdleEnded } else { IdleAction::None };
        }
        self.was_idle = true;
        if !enabled || self.fired {
            return IdleAction::None;
        }
        self.fired = true;
        IdleAction::OpenSidebar
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use IdleAction::*;

    const THRESHOLD: u64 = 180_000; // 3분

    #[test]
    fn below_threshold_never_opens() {
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(true, 0, THRESHOLD), None);
        assert_eq!(g.tick(true, THRESHOLD - 1, THRESHOLD), None);
    }

    #[test]
    fn crossing_threshold_opens_once() {
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(true, 10_000, THRESHOLD), None);
        assert_eq!(g.tick(true, THRESHOLD, THRESHOLD), OpenSidebar);
    }

    #[test]
    fn staying_idle_does_not_reopen() {
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(true, THRESHOLD, THRESHOLD), OpenSidebar);
        assert_eq!(g.tick(true, THRESHOLD + 5_000, THRESHOLD), None);
        assert_eq!(g.tick(true, THRESHOLD + 300_000, THRESHOLD), None);
    }

    #[test]
    fn input_resume_reports_idle_ended_once_then_rearms() {
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(true, THRESHOLD, THRESHOLD), OpenSidebar);
        // 입력 재개 → 유휴 세션 종료를 정확히 한 번 보고
        assert_eq!(g.tick(true, 2_000, THRESHOLD), IdleEnded);
        assert_eq!(g.tick(true, 3_000, THRESHOLD), None);
        // 다시 유휴 기준 초과 → 새 세션이므로 다시 열림
        assert_eq!(g.tick(true, THRESHOLD + 1, THRESHOLD), OpenSidebar);
    }

    #[test]
    fn idle_ended_reported_even_when_disabled() {
        // 자동 열기가 꺼져 있어도 유휴 종료 전환은 보고한다 — 프런트 상태
        // 해제는 열림 여부와 무관하게 항상 안전해야 한다.
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(false, THRESHOLD + 1, THRESHOLD), None);
        assert_eq!(g.tick(false, 1_000, THRESHOLD), IdleEnded);
    }

    #[test]
    fn disabled_never_opens() {
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(false, THRESHOLD * 10, THRESHOLD), None);
        assert_eq!(g.tick(false, THRESHOLD * 20, THRESHOLD), None);
    }

    #[test]
    fn enabling_mid_idle_session_opens() {
        // 꺼진 상태로 유휴 기준을 넘긴 뒤 설정을 켜면, 그 세션에서도 열린다
        // (꺼져 있던 tick은 발화를 소모하지 않는다).
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(false, THRESHOLD + 1, THRESHOLD), None);
        assert_eq!(g.tick(true, THRESHOLD + 2, THRESHOLD), OpenSidebar);
    }

    #[test]
    fn first_tick_below_threshold_is_not_idle_ended() {
        // 앱 시작 직후(유휴였던 적 없음)에는 IdleEnded가 나오면 안 된다.
        let mut g = IdleOpenGate::new();
        assert_eq!(g.tick(true, 1_000, THRESHOLD), None);
    }
}
