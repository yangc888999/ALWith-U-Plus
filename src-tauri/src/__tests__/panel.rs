use super::{is_overlay, should_restore, with_restored_responder};
use std::cell::Cell;

#[test]
fn only_the_chat_window_participates_in_the_panel_lifecycle() {
    assert!(is_overlay("chat"));
    assert!(should_restore("chat", true));
    assert!(!should_restore("chat", false));
    for label in ["main", "settings", ""] {
        assert!(!is_overlay(label));
        assert!(!should_restore(label, true));
    }
}

#[test]
fn rejected_style_changes_restore_input_and_return_the_system_error() {
    let restored = Cell::new(false);
    let error = tauri_nspanel::StyleMaskError::ObjectiveCException("rejected style".into()).to_string();
    let result = with_restored_responder(
        || Err(error.clone()),
        || {
            restored.set(true);
            true
        },
    );
    assert!(restored.get());
    assert_eq!(result, Err(error));
}

#[test]
fn responder_failure_is_returned_instead_of_panicking() {
    assert_eq!(with_restored_responder(|| Ok(()), || false), Err("Failed to restore overlay input responder".into()));
    assert_eq!(with_restored_responder(|| Ok(()), || true), Ok(()));
}
