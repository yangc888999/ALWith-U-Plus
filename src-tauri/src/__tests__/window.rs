use super::*;

fn record(ww: f64, wh: f64, w: f64, h: f64) -> DisplayRecord {
    DisplayRecord { work_width: ww, work_height: wh, width: w, height: h }
}

#[test]
fn display_key_distinguishes_identically_sized_monitors() {
    // Two 1440x2560 panels: identical size but a different origin -> distinct keys. Comparing
    // only width/height (the old `same_display` logic) would treat these as the same display.
    let a = display_key(Some("Built-in"), 0.0, 0.0, 1440.0, 2560.0);
    let b = display_key(Some("Built-in"), 1440.0, 0.0, 1440.0, 2560.0);
    assert_ne!(a, b);

    // Same size, same origin, but a different name is still a different display.
    let c = display_key(Some("External"), 0.0, 0.0, 1440.0, 2560.0);
    assert_ne!(a, c);
}

#[test]
fn display_key_is_stable_under_sub_point_jitter() {
    let a = display_key(Some("Panel"), 0.0, 0.0, 2880.0, 1620.0);
    let b = display_key(Some("Panel"), 0.2, -0.1, 2879.8, 1620.4);
    assert_eq!(a, b, "rounding should absorb sub-point jitter");

    // A genuinely different size still changes the key.
    let c = display_key(Some("Panel"), 0.0, 0.0, 1440.0, 2560.0);
    assert_ne!(a, c);
}

#[test]
fn display_key_handles_missing_name() {
    let a = display_key(None, 0.0, 0.0, 1920.0, 1080.0);
    let b = display_key(None, 0.0, 0.0, 1920.0, 1080.0);
    assert_eq!(a, b);
    assert!(a.starts_with("?|"));
}

#[test]
fn footprint_defaults_and_clamps() {
    // No record -> designed defaults.
    assert_eq!(footprint(None), (DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION));

    // A normal record preserves the share it was sized at.
    let r = record(2880.0, 1620.0, 2400.0, 1400.0);
    let (fw, fh) = footprint(Some(r));
    assert!((fw - 2400.0 / 2880.0).abs() < 1e-9);
    assert!((fh - 1400.0 / 1620.0).abs() < 1e-9);

    // A polluted record (old big-panel size written against a smaller work area) is clamped to
    // 1.0 rather than yielding a >1 share — exactly the legacy single-record failure mode.
    let polluted = record(1440.0, 2560.0, 2400.0, 1400.0);
    assert_eq!(footprint(Some(polluted)).0, 1.0);

    // A too-small share is raised to the minimum.
    let tiny = record(2880.0, 1620.0, 400.0, 300.0);
    assert_eq!(footprint(Some(tiny)).0, MIN_WIDTH_FRACTION);
    assert_eq!(footprint(Some(tiny)).1, MIN_HEIGHT_FRACTION);
}

#[test]
fn footprint_ignores_degenerate_work_area() {
    let zero = record(0.0, 0.0, 100.0, 100.0);
    assert_eq!(footprint(Some(zero)), (DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION));
    let one = record(1.0, 1.0, 1.0, 1.0);
    assert_eq!(footprint(Some(one)), (DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION));
}

#[test]
fn sized_respects_shares_minimum_and_work_area() {
    let (w, h) = sized((0.5, 0.5), 2880.0, 1620.0);
    assert_eq!(w, 1440.0);
    assert_eq!(h, 810.0);

    // Never smaller than the designed minimum.
    let (w, h) = sized((0.1, 0.1), 2880.0, 1620.0);
    assert_eq!(w, MAIN_MIN_WIDTH);
    assert_eq!(h, MAIN_MIN_HEIGHT);

    // Never larger than the work area; the minimum itself is capped by a tiny work area.
    let (w, h) = sized((1.0, 1.0), 1000.0, 600.0);
    assert_eq!(w, 1000.0);
    assert_eq!(h, 600.0);
}

#[test]
fn parse_new_format_roundtrip() {
    let mut records = DisplayRecords::default();
    records.by_display.insert("A".into(), record(2880.0, 1620.0, 2400.0, 1400.0));
    records.by_display.insert("B".into(), record(1440.0, 2560.0, 1200.0, 2000.0));
    records.last = Some("B".into());

    let text = serde_json::to_string(&records).unwrap();
    let parsed = parse_display_records(&text);
    assert_eq!(parsed.last.as_deref(), Some("B"));
    assert_eq!(parsed.by_display.len(), 2);
    assert_eq!(parsed.by_display["A"].width, 2400.0);
    assert_eq!(parsed.by_display["B"].work_height, 2560.0);
}

#[test]
fn parse_legacy_single_record_as_fallback() {
    let legacy = r#"{"work_width":2880.0,"work_height":1620.0,"width":2400.0,"height":1400.0}"#;
    let parsed = parse_display_records(legacy);
    assert!(parsed.last.is_none());
    assert_eq!(parsed.by_display.len(), 1);
    let saved = parsed.by_display.get(LEGACY_KEY).expect("legacy record kept as fallback");
    assert_eq!(saved.width, 2400.0);
    assert_eq!(saved.work_height, 1620.0);
    // The upgraded legacy record is still usable as a footprint source for any (unseen) key.
    assert_eq!(footprint_record_for(&parsed, "A").map(|r| r.width), Some(2400.0));
}

#[test]
fn parse_legacy_with_integer_values() {
    let legacy = r#"{"work_width":2880,"work_height":1620,"width":2400,"height":1400}"#;
    let parsed = parse_display_records(legacy);
    assert_eq!(parsed.by_display.get(LEGACY_KEY).unwrap().width, 2400.0);
}

#[test]
fn parse_corrupt_or_empty_is_safe_default() {
    for text in ["not json", "{}", "", "null", "[]", "123"] {
        assert!(parse_display_records(text).by_display.is_empty(), "{text}");
        assert!(parse_display_records(text).last.is_none(), "{text}");
    }
}

#[test]
fn footprint_record_prefers_target_then_last_then_legacy() {
    let mut records = DisplayRecords::default();
    records.by_display.insert("A".into(), record(2880.0, 1620.0, 2400.0, 1400.0));
    records.by_display.insert("B".into(), record(1440.0, 2560.0, 1200.0, 2000.0));
    records.by_display.insert(LEGACY_KEY.into(), record(1920.0, 1080.0, 1600.0, 900.0));
    records.last = Some("A".into());

    // Target has its own record -> it wins even though `last` points elsewhere (return visit).
    assert_eq!(footprint_record_for(&records, "B").unwrap().width, 1200.0);
    // Target unseen -> carry over the share from `last` (first arrival on a new display).
    assert_eq!(footprint_record_for(&records, "C").unwrap().width, 2400.0);

    // No target, no `last` -> legacy fallback.
    records.last = None;
    assert_eq!(footprint_record_for(&records, "C").unwrap().width, 1600.0);

    // Nothing anywhere -> None (caller falls back to default fractions).
    records.by_display.remove(LEGACY_KEY);
    assert!(footprint_record_for(&records, "C").is_none());
}

#[test]
fn fullscreen_exit_delay_is_one_shot() {
    // A normal exit must never be held open by this flag.
    assert!(!take_fullscreen_exit_delay());
    mark_fullscreen_exit();
    // The first final ExitRequested waits for the animation; the one we schedule afterwards
    // must exit immediately instead of looping forever.
    assert!(take_fullscreen_exit_delay());
    assert!(!take_fullscreen_exit_delay());
}
