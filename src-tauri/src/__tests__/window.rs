use super::*;

fn record(ww: f64, wh: f64, w: f64, h: f64) -> DisplayRecord {
    DisplayRecord { work_width: ww, work_height: wh, width: w, height: h }
}

#[test]
fn display_key_distinguishes_identically_sized_monitors() {
    // Two 1440x2560 panels: identical size but a different origin -> distinct keys. Comparing
    // only width/height (the old `same_display` logic) would treat these as the same display.
    let a = display_key(Some("Built-in"), 0.0, 0.0);
    let b = display_key(Some("Built-in"), 1440.0, 0.0);
    assert_ne!(a, b);

    // Same origin, but a different name is still a different display.
    let c = display_key(Some("External"), 0.0, 0.0);
    assert_ne!(a, c);
}

#[test]
fn display_key_is_stable_under_sub_point_jitter() {
    let a = display_key(Some("Panel"), 0.0, 0.0);
    let b = display_key(Some("Panel"), 0.2, -0.1);
    assert_eq!(a, b, "rounding should absorb sub-point jitter");

    // A genuine rearrangement (another origin) does change the key.
    let c = display_key(Some("Panel"), 2560.0, 0.0);
    assert_ne!(a, c);
}

#[test]
fn a_work_area_change_alone_does_not_invent_a_new_display() {
    // The Dock appearing, the menu bar hiding or Stage Manager taking a strip changes the work
    // area — size *and* origin — but not the display itself. Keying on the work area turned each
    // of those into "a display the app has never sized on", so the window was rebuilt from a
    // carried-over footprint every single time: the "窗口尺寸乱跳 / 越换越小" report.
    let before = display_key(Some("HDP-V104"), 0.0, 0.0);
    let after = display_key(Some("HDP-V104"), 0.0, 0.0);
    assert_eq!(before, after);

    // The record is only ever read as a ratio, so a stale denominator cannot make the remembered
    // size drift: the share stays, and re-applying it to the work area actually in front of us
    // grows the window with the work area instead of snapping it to some other panel's size.
    let remembered = record(1920.0, 960.0, 1600.0, 860.0);
    let share = footprint(Some(remembered));
    assert_eq!(sized(share, 1920.0, 960.0), (1600.0, 860.0));
    let after_dock_gone = sized(share, 1920.0, 1050.0);
    assert_eq!(after_dock_gone.0, 1600.0, "the width share is untouched by a taller work area");
    assert!(after_dock_gone.1 > 860.0, "the same share of a taller work area is a taller window");
}

#[test]
fn display_key_handles_missing_name() {
    let a = display_key(None, 0.0, 0.0);
    let b = display_key(None, 0.0, 0.0);
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

// ── Display ownership and the share-based re-fit policy ──────────────────────────────────────
// The multi-display reports ("第2屏挤占", "最大化异常", "换屏后只占一块") all reduce to two
// questions this module now answers in one place: which display owns the window, and whether its
// current size could have been chosen for that display.

fn rect(x: f64, y: f64, w: f64, h: f64) -> RectPx {
    RectPx { x, y, w, h }
}

#[test]
fn overlap_area_counts_only_the_shared_region() {
    assert_eq!(overlap_area(rect(0.0, 0.0, 100.0, 100.0), rect(50.0, 50.0, 100.0, 100.0)), 2500.0);
    // Touching edges share nothing: a window parked on the seam belongs to neither display.
    assert_eq!(overlap_area(rect(0.0, 0.0, 100.0, 100.0), rect(100.0, 0.0, 100.0, 100.0)), 0.0);
    assert_eq!(overlap_area(rect(0.0, 0.0, 100.0, 100.0), rect(200.0, 0.0, 100.0, 100.0)), 0.0);
    // Fully contained is the whole inner rectangle.
    assert_eq!(overlap_area(rect(0.0, 0.0, 100.0, 100.0), rect(10.0, 10.0, 20.0, 20.0)), 400.0);
}

#[test]
fn owning_display_is_the_one_with_the_largest_overlap() {
    // Two landscape panels side by side, 1920 wide each.
    let areas = [rect(0.0, 0.0, 1920.0, 1050.0), rect(1920.0, 0.0, 2560.0, 1400.0)];
    // Entirely on the second.
    assert_eq!(owning_monitor_index(&areas, rect(2000.0, 100.0, 1200.0, 800.0)), Some(1));
    // Straddling, but 1400 of its 1920 columns are on the second display: it owns the window even
    // though a naive "current_monitor" answer could be the first.
    assert_eq!(owning_monitor_index(&areas, rect(1500.0, 100.0, 1920.0, 800.0)), Some(1));
    // Straddling the other way round: x 900..2820 puts 1020 columns on the first display and
    // 900 on the second, so the first one owns it.
    assert_eq!(owning_monitor_index(&areas, rect(900.0, 100.0, 1920.0, 800.0)), Some(0));
    // Off every display.
    assert_eq!(owning_monitor_index(&areas, rect(-5000.0, 0.0, 800.0, 600.0)), None);
}

#[test]
fn a_maximized_window_is_never_rebuilt() {
    // A maximised frame fills its work area, so its share is ~1.0 — above MAX_RESTORED_FRACTION.
    // Reading that as a corrupt saved geometry is what shrank every maximised window to 85%.
    let maximized = plan_geometry(GeometryInput {
        share: (1.0, 1.0),
        work: (2560.0, 1440.0),
        unseen_display: false,
        landed_here: false,
        maximized: true,
        fullscreen: false,
        validate_size: true,
        fractions: (0.85, 0.88),
    });
    assert_eq!(maximized, GeometryPlan::Keep);

    // Same frame, no longer maximised: an absurd size is still rejected at startup.
    let restored = plan_geometry(GeometryInput {
        share: (1.0, 1.0),
        work: (2560.0, 1440.0),
        unseen_display: false,
        landed_here: false,
        maximized: false,
        fullscreen: false,
        validate_size: true,
        fractions: (1.0, 1.0),
    });
    assert_eq!(
        restored,
        GeometryPlan::Rebuild {
            width: (2560.0f64 * DEFAULT_WIDTH_FRACTION).round(),
            height: (1440.0f64 * DEFAULT_HEIGHT_FRACTION).round()
        }
    );
}

#[test]
fn a_fullscreen_window_is_never_rebuilt() {
    let plan = plan_geometry(GeometryInput {
        share: (0.2, 0.2),
        work: (1920.0, 1050.0),
        unseen_display: true,
        landed_here: true,
        maximized: false,
        fullscreen: true,
        validate_size: true,
        fractions: (0.85, 0.88),
    });
    assert_eq!(plan, GeometryPlan::Keep);
}

#[test]
fn a_window_sized_for_a_smaller_panel_is_rebuilt_from_the_share() {
    // 1920x960 window on a 1920x960 work area = share 1.0; the panel is replaced by 2560x1440 and
    // the recorded share for it is 0.75 x 0.75 -> 1920x1080.
    let plan = plan_geometry(GeometryInput {
        share: (1920.0 / 2560.0, 960.0 / 1440.0),
        work: (2560.0, 1440.0),
        unseen_display: true,
        landed_here: false,
        maximized: false,
        fullscreen: false,
        validate_size: false,
        fractions: (0.75, 0.75),
    });
    assert_eq!(plan, GeometryPlan::Rebuild { width: 1920.0, height: 1080.0 });

    // A size that is too small for the panel it now sits on is rebuilt even without a new record:
    // this is the "从另一块屏过来，只占左边三分之一" case.
    let too_small = plan_geometry(GeometryInput {
        share: (0.30, 0.40),
        work: (2560.0, 1440.0),
        unseen_display: false,
        landed_here: false,
        maximized: false,
        fullscreen: false,
        validate_size: false,
        fractions: (0.85, 0.88),
    });
    assert_eq!(too_small, GeometryPlan::Rebuild { width: 2176.0, height: 1267.0 });
}

#[test]
fn a_normal_share_and_a_deliberate_small_window_are_left_alone() {
    // 80% of the panel: normal, keep it.
    assert_eq!(
        plan_geometry(GeometryInput {
            share: (0.80, 0.80),
            work: (1920.0, 1050.0),
            unseen_display: false,
            landed_here: false,
            maximized: false,
            fullscreen: false,
            validate_size: true,
            fractions: (0.85, 0.88),
        }),
        GeometryPlan::Keep
    );
    // Exactly at the floor after a display change: still a deliberate size, not a leftover. (The
    // startup pass has the additional 1250x750 design minimum, so it is not the right place to
    // assert this.)
    assert_eq!(
        plan_geometry(GeometryInput {
            share: (MIN_WIDTH_FRACTION, MIN_HEIGHT_FRACTION),
            work: (1920.0, 1050.0),
            unseen_display: false,
            landed_here: false,
            maximized: false,
            fullscreen: false,
            validate_size: false,
            fractions: (0.85, 0.88),
        }),
        GeometryPlan::Keep
    );
}

#[test]
fn a_drag_onto_a_display_always_rebuilds_from_that_displays_own_share() {
    // The share is already normal for the target (two identically sized panels), yet the cross
    // display drag must still take the target's own record — otherwise a 0.60 window carried onto
    // a panel last used at 0.85 would stay at 0.60 for ever.
    let plan = plan_geometry(GeometryInput {
        share: (0.60, 0.60),
        work: (2560.0, 1440.0),
        unseen_display: false,
        landed_here: true,
        maximized: false,
        fullscreen: false,
        validate_size: false,
        fractions: (0.85, 0.88),
    });
    assert_eq!(plan, GeometryPlan::Rebuild { width: 2176.0, height: 1267.0 });
}

#[test]
fn rebuild_never_leaves_the_work_area_or_undercuts_the_designed_minimum() {
    // A portrait panel: a share recorded on a landscape one must still land inside this work area.
    let (w, h) = sized((1.0, 1.0), 1440.0, 2560.0);
    assert_eq!((w, h), (1440.0, 2560.0));
    // A work area smaller than the designed minimum cannot produce a size larger than itself.
    let (w, h) = sized((DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION), 1024.0, 700.0);
    assert_eq!((w, h), (1024.0, 700.0));
}
