use tauri::{PhysicalPosition, PhysicalSize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

pub fn bottom_right_position(
    work_area: PhysicalRect,
    window: PhysicalSize<u32>,
    margin: i32,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        work_area.right - window.width as i32 - margin,
        work_area.bottom - window.height as i32 - margin,
    )
}

/// Returns the usable desktop rectangle for `monitor` in physical pixels.
/// Windows is queried directly because its work area excludes taskbars and
/// app bars; any lookup failure falls back to the full Tauri monitor bounds.
pub fn work_area_for_monitor(monitor: &tauri::Monitor) -> PhysicalRect {
    let fallback = PhysicalRect {
        left: monitor.position().x,
        top: monitor.position().y,
        right: monitor.position().x + monitor.size().width as i32,
        bottom: monitor.position().y + monitor.size().height as i32,
    };

    #[cfg(windows)]
    {
        windows_work_area(monitor).unwrap_or(fallback)
    }

    #[cfg(not(windows))]
    {
        fallback
    }
}

#[cfg(windows)]
fn windows_work_area(monitor: &tauri::Monitor) -> Option<PhysicalRect> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let half_width = i32::try_from(monitor.size().width / 2).ok()?;
    let half_height = i32::try_from(monitor.size().height / 2).ok()?;
    let center = POINT {
        x: monitor.position().x.checked_add(half_width)?,
        y: monitor.position().y.checked_add(half_height)?,
    };
    // SAFETY: `center` is a physical desktop coordinate. The nearest-monitor
    // flag guarantees the API may select a monitor even if the point is not
    // contained by one.
    let handle = unsafe { MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` has the required cbSize and is a valid writable out pointer.
    if !unsafe { GetMonitorInfoW(handle, &mut info) }.as_bool() {
        return None;
    }

    Some(PhysicalRect {
        left: info.rcWork.left,
        top: info.rcWork.top,
        right: info.rcWork.right,
        bottom: info.rcWork.bottom,
    })
}

/// Returns the original indices of `positions`, ordered left-to-right by x
/// (ties broken by y) — mirrors `sortMonitorsByPosition` in
/// src/shared/monitors.ts.
pub fn sorted_indices_by_position(positions: &[(i32, i32)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..positions.len()).collect();
    idx.sort_by(|&a, &b| {
        positions[a].0.cmp(&positions[b].0).then(positions[a].1.cmp(&positions[b].1))
    });
    idx
}

/// 1-based `display_index` into `sorted_indices`. Falls back to the first
/// entry if out of range; `None` if `sorted_indices` is empty. Mirrors
/// `pickMonitor` in src/shared/monitors.ts.
pub fn pick_index(sorted_indices: &[usize], display_index: u32) -> Option<usize> {
    let wanted = (display_index as usize).checked_sub(1).and_then(|i| sorted_indices.get(i));
    wanted.or_else(|| sorted_indices.first()).copied()
}

/// Top-left position that centers a `window_size` window within a monitor
/// occupying `monitor_position` + `monitor_size` (all in physical pixels).
pub fn centered_position(
    window_size: (i32, i32),
    monitor_position: (i32, i32),
    monitor_size: (i32, i32),
) -> (i32, i32) {
    (
        monitor_position.0 + (monitor_size.0 - window_size.0) / 2,
        monitor_position.1 + (monitor_size.1 - window_size.1) / 2,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn sorted_indices_orders_left_to_right() {
        let positions = [(1920, 0), (0, 0)];
        assert_eq!(sorted_indices_by_position(&positions), vec![1, 0]);
    }

    #[test]
    fn sorted_indices_breaks_ties_on_y() {
        let positions = [(0, 1080), (0, 0)];
        assert_eq!(sorted_indices_by_position(&positions), vec![1, 0]);
    }

    #[test]
    fn sorted_indices_empty_input() {
        let positions: [(i32, i32); 0] = [];
        assert_eq!(sorted_indices_by_position(&positions), Vec::<usize>::new());
    }

    #[test]
    fn pick_index_returns_the_1_based_entry() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 2), Some(1));
    }

    #[test]
    fn pick_index_falls_back_to_first_when_out_of_range() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 5), Some(0));
    }

    #[test]
    fn pick_index_falls_back_to_first_when_zero() {
        let sorted = vec![0, 1, 2];
        assert_eq!(pick_index(&sorted, 0), Some(0));
    }

    #[test]
    fn pick_index_returns_none_when_empty() {
        let sorted: Vec<usize> = vec![];
        assert_eq!(pick_index(&sorted, 1), None);
    }

    #[test]
    fn centered_position_centers_with_equal_margins() {
        // 1920x1080 monitor at the origin, 540x175 window.
        let pos = centered_position((540, 175), (0, 0), (1920, 1080));
        assert_eq!(pos, (690, 452));
    }

    #[test]
    fn centered_position_honors_a_non_zero_monitor_origin() {
        // Same-size monitor, placed to the right of a 1920-wide primary monitor.
        let pos = centered_position((540, 175), (1920, 0), (1920, 1080));
        assert_eq!(pos, (2610, 452));
    }

    #[test]
    fn bottom_right_uses_work_area_and_margin() {
        let p = bottom_right_position(
            PhysicalRect { left: 0, top: 0, right: 1920, bottom: 1040 },
            PhysicalSize::new(540, 64),
            16,
        );
        assert_eq!(p, PhysicalPosition::new(1364, 960));
    }

    #[test]
    fn bottom_right_supports_negative_monitor_origins() {
        let p = bottom_right_position(
            PhysicalRect { left: -1920, top: 0, right: 0, bottom: 1040 },
            PhysicalSize::new(675, 80),
            20,
        );
        assert_eq!(p, PhysicalPosition::new(-695, 940));
    }

    #[test]
    fn bottom_right_uses_work_area_reduced_by_left_and_top_taskbars() {
        let p = bottom_right_position(
            PhysicalRect { left: 48, top: 24, right: 1920, bottom: 1080 },
            PhysicalSize::new(540, 64),
            16,
        );
        assert_eq!(p, PhysicalPosition::new(1364, 1000));
    }

    #[test]
    fn bottom_right_small_work_area_returns_negative_coordinates_without_panicking() {
        let p = bottom_right_position(
            PhysicalRect { left: 0, top: 0, right: 100, bottom: 50 },
            PhysicalSize::new(540, 64),
            16,
        );
        assert_eq!(p, PhysicalPosition::new(-456, -30));
    }
}
