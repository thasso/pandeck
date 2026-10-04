//! Pending outside navigation, independent of Tauri so the handoff is testable.

use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct PendingTargets {
    windows: HashMap<String, String>,
    before_window: Option<String>,
}

impl PendingTargets {
    pub(crate) fn park(&mut self, window: Option<&str>, target: String) {
        if let Some(label) = window {
            // A newer addressed navigation supersedes one from before startup.
            self.before_window = None;
            self.windows.insert(label.to_string(), target);
        } else {
            self.before_window = Some(target);
        }
    }

    pub(crate) fn peek(&mut self, window: &str) -> Option<String> {
        if let Some(target) = self.before_window.take() {
            self.windows.entry(window.to_string()).or_insert(target);
        }
        self.windows.get(window).cloned()
    }

    pub(crate) fn acknowledge(&mut self, window: &str, target: &str) {
        if self.windows.get(window).map(String::as_str) == Some(target) {
            self.windows.remove(window);
        }
    }

    #[cfg(any(desktop, test))]
    pub(crate) fn forget(&mut self, window: &str) {
        self.windows.remove(window);
    }
}

#[cfg(test)]
mod tests {
    use super::PendingTargets;

    #[test]
    fn cold_start_waits_for_a_window_and_is_cleared_only_on_acknowledgement() {
        let mut pending = PendingTargets::default();
        pending.park(None, "/sessions/cold".into());
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/cold"));
        assert_eq!(pending.peek("window1"), None);
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/cold"));
        pending.acknowledge("main", "/sessions/cold");
        assert_eq!(pending.peek("main"), None);
    }

    #[test]
    fn targets_are_scoped_to_one_window() {
        let mut pending = PendingTargets::default();
        pending.park(Some("main"), "/sessions/a".into());
        assert_eq!(pending.peek("window1"), None);
        pending.park(Some("window1"), "/sessions/b".into());
        pending.acknowledge("window1", "/sessions/a");
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/a"));
        assert_eq!(pending.peek("window1").as_deref(), Some("/sessions/b"));
    }

    #[test]
    fn newest_tap_wins_even_before_the_first_window_is_ready() {
        let mut pending = PendingTargets::default();
        pending.park(None, "/sessions/old".into());
        pending.park(Some("main"), "/sessions/new".into());
        pending.park(Some("main"), "/sessions/newest".into());
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/newest"));
        pending.acknowledge("main", "/sessions/newest");
        assert_eq!(pending.peek("main"), None);
    }

    #[test]
    fn a_missed_event_or_abandoned_peek_keeps_the_target_for_the_next_page() {
        let mut pending = PendingTargets::default();
        assert_eq!(pending.peek("main"), None);
        pending.park(Some("main"), "/sessions/reload".into());
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/reload"));
        // The page can disappear while the IPC reply is in flight. Only its
        // acknowledgement after navigation may clear the target.
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/reload"));
    }

    #[test]
    fn acknowledging_an_old_target_does_not_clear_a_newer_tap() {
        let mut pending = PendingTargets::default();
        pending.park(Some("main"), "/sessions/old".into());
        let old = pending.peek("main").unwrap();
        pending.park(Some("main"), "/sessions/new".into());
        pending.acknowledge("main", &old);
        assert_eq!(pending.peek("main").as_deref(), Some("/sessions/new"));
    }

    #[test]
    fn closing_a_window_discards_only_its_pending_target() {
        let mut pending = PendingTargets::default();
        pending.park(Some("main"), "/sessions/a".into());
        pending.park(Some("window1"), "/sessions/b".into());
        pending.forget("main");
        assert_eq!(pending.peek("main"), None);
        assert_eq!(pending.peek("window1").as_deref(), Some("/sessions/b"));
    }
}
