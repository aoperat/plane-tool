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
}
