//! Window helpers ported from ALwith Desktop's `app/native.rs`.

use tauri::{LogicalPosition, LogicalSize, Manager, Monitor};

#[tauri3_specta::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_open(&app)?;
    let window = app.get_webview_window("main").expect("main window is retained for the application lifetime");
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn is_closing(app: &tauri::AppHandle) -> bool {
    // Native window notifications may arrive before setup has installed DriveState.
    app.try_state::<crate::drive::DriveState>().is_some_and(|state| state.is_closing())
        || app.state::<crate::runtime::RuntimeState>().is_closing()
}

/// Leaves native fullscreen on every window before they are hidden or destroyed.
///
/// macOS keeps the fullscreen Space alive for as long as its window belongs to it. Hiding a
/// fullscreen window leaves that Space behind as a black rectangle covering the display, which
/// is exactly what "click X and the screen stays black" looks like. Leaving fullscreen first
/// shrinks the window back to its desktop Space, so hiding it leaves nothing on screen.
/// Set once when shutdown has to retire a native-fullscreen window. macOS animates the
/// fullscreen → desktop transition; letting the process disappear (or hiding the window) mid
/// transition strands that Space as a black rectangle. The final exit waits for this flag.
static FULLSCREEN_EXIT_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn mark_fullscreen_exit() {
    FULLSCREEN_EXIT_PENDING.store(true, std::sync::atomic::Ordering::Release);
}

/** Consumes the one-shot delay: true only for the first final exit after a fullscreen retirement. */
pub fn take_fullscreen_exit_delay() -> bool {
    FULLSCREEN_EXIT_PENDING.swap(false, std::sync::atomic::Ordering::AcqRel)
}

pub fn leave_fullscreen_all(app: &tauri::AppHandle) {
    for window in app.webview_windows().into_values() {
        if window.is_fullscreen().unwrap_or(false) {
            log::info!("Leaving fullscreen before shutdown: {}", window.label());
            if let Err(error) = window.set_fullscreen(false) {
                log::error!("Cannot leave fullscreen for {}: {error}", window.label());
            }
        }
    }
}

pub fn ensure_open(app: &tauri::AppHandle) -> Result<(), String> {
    if is_closing(app) {
        return Err("Application is closing".into());
    }
    Ok(())
}

/// Last-resort guarantee that "close the window" always ends the process.
///
/// The graceful path drains Drive and Runtime first. If either of those drains wedges past its
/// own timeout — or a helper window refuses to go away — the user would otherwise be left with
/// a hidden app (and, in fullscreen, a black Space) they cannot dismiss. A detached watchdog
/// makes the promise absolute: nothing on screen, no lingering process.
pub fn arm_exit_watchdog(seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        log::warn!("Graceful shutdown exceeded {seconds}s; forcing exit");
        std::process::exit(0);
    });
}

/// Makes `label` a child window of `main` (macOS only): it floats above the main window,
/// follows it between Spaces and never becomes its own Stage Manager stage. Called on every
/// open: hiding a child window (orderOut) detaches it, so reopening must re-attach.
/// Other platforms have no such grouping; the command is a no-op there.
#[tauri3_specta::command]
pub fn attach_window_to_main(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    ensure_open(&app)?;
    #[cfg(target_os = "macos")]
    {
        let Some(child) = app.get_webview_window(&label) else {
            return Ok(false);
        };
        let Some(main) = app.get_webview_window("main") else {
            return Ok(false);
        };
        let child_for_ptr = child.clone();
        child
            .run_on_main_thread(move || {
                use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
                if is_closing(child_for_ptr.app_handle()) {
                    return;
                }
                // ns_window() must be called on the main thread.
                let (Ok(child_ptr), Ok(main_ptr)) = (child_for_ptr.ns_window(), main.ns_window()) else {
                    return;
                };
                // SAFETY: both pointers are live NSWindows owned by Tauri; this runs on the main thread.
                let child_ns: &NSWindow = unsafe { &*(child_ptr as *const NSWindow) };
                let main_ns: &NSWindow = unsafe { &*(main_ptr as *const NSWindow) };
                // Attach first (an orderedOut child is ordered above its parent = shown), then focus.
                unsafe {
                    main_ns.addChildWindow_ordered(child_ns, NSWindowOrderingMode::Above);
                    child_ns.makeKeyAndOrderFront(None);
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &label);
    Ok(true)
}

// ── Adaptive, monitor-aware main-window geometry ──────────────────────────────
//
// `tauri_plugin_window_state` restores the last saved size/position verbatim, with no bounds
// check against the actual displays. A corrupt or legacy value (e.g. a transient maximized/
// zoned state captured as 11440×3000) therefore reopens as a screen-filling monster on every
// launch — exactly the "双屏首次打开就铺满屏幕" report.
//
// We re-validate the geometry at startup: a sane saved size is kept but clamped inside the
// monitor's work area; anything absurd (or off-screen) falls back to a proportion of the
// display. Each display keeps its own remembered window share (keyed by name + work-area
// geometry), so moving the window between a 2880x1620 landscape panel and a 1440x2560 portrait
// panel rebuilds the right size on each, without a single global record being polluted by mixed
// geometry. A drag that lands the window on a *different* display triggers a debounced rebuild;
// same-display drags and manual resizes are left untouched. Display-layout changes still only
// rescue a fully off-screen window, so a deliberate placement is never moved.

const MAIN_MIN_WIDTH: f64 = 1250.0;
const MAIN_MIN_HEIGHT: f64 = 750.0;
const DEFAULT_WIDTH_FRACTION: f64 = 0.85;
const DEFAULT_HEIGHT_FRACTION: f64 = 0.88;
const MAX_RESTORED_FRACTION: f64 = 0.95;
/// A window that covers less than this share of its display is treated as "sized for a different
/// screen" — e.g. the 1280×820 config default on a 2880×1620 panel, or the same window carried
/// over to a display with another resolution.
const MIN_WIDTH_FRACTION: f64 = 0.45;
const MIN_HEIGHT_FRACTION: f64 = 0.45;

/// Debounce for a drag that crosses onto another display: only the display the window finally
/// rests on (after the drag stops) is acted on, so we never resize on every Moved frame.
const ADAPT_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);
/// Fallback slot for the upgraded old single-record file, which carries no display key.
const LEGACY_KEY: &str = "__legacy_single__";

/// The window's size relative to one display's work area. A separate record is kept per display,
/// so switching between differently-sized panels remembers each panel's own share instead of a
/// single global record being overwritten with "new work area + old window size".
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
struct DisplayRecord {
    work_width: f64,
    work_height: f64,
    width: f64,
    height: f64,
}

/// On-disk state. `by_display` is keyed by the stable display key (see `display_key`); `last`
/// names the display the window was most recently sized on, used to pick a carry-over footprint
/// when it first lands on an unseen display.
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct DisplayRecords {
    by_display: std::collections::HashMap<String, DisplayRecord>,
    last: Option<String>,
}

const DISPLAY_RECORD_FILE: &str = "main-window-display.json";

/// Resizes arrive in bursts; the record only needs to be roughly current, so skip the churn.
static LAST_RECORD_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const RECORD_INTERVAL: std::time::Duration = std::time::Duration::from_millis(800);

/// Tracks display changes seen while dragging the main window.
///
/// * `last_key` is the last display identity observed (equivalent to the suggested
///   `LAST_MONITOR_KEY`): a change in this value — not merely a position change — is what triggers
///   an adaptation.
/// * `generation` is a debounce token: each change bumps it, and a scheduled task only runs if
///   its generation is still the latest when it wakes (later moves supersede earlier ones).
/// * `applying` is a reentrancy guard: the Moved/Resized events emitted by our own set_size /
///   set_position must not schedule another adaptation or overwrite the record just written.
struct MoveMonitorState {
    last_key: Option<String>,
    generation: u64,
    applying: bool,
}

static MOVE_MONITOR_STATE: std::sync::Mutex<MoveMonitorState> = std::sync::Mutex::new(MoveMonitorState {
    last_key: None,
    generation: 0,
    applying: false,
});

fn move_state() -> std::sync::MutexGuard<'static, MoveMonitorState> {
    MOVE_MONITOR_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn display_record_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|directory| directory.join(DISPLAY_RECORD_FILE))
}

/// Parses the display-record file, accepting both the current per-display map and the old single
/// `DisplayRecord` (pre-upgrade) format. A corrupt/foreign file degrades to an empty store so a
/// bad value can never crash startup or poison the adaptive baseline.
fn parse_display_records(text: &str) -> DisplayRecords {
    // Current format: {"by_display": {"<key>": {...}}, "last": "<key>"}.
    if let Ok(records) = serde_json::from_str::<DisplayRecords>(text) {
        return records;
    }
    // Legacy format: one bare DisplayRecord with no display key. Keep it as a global fallback.
    if let Ok(single) = serde_json::from_str::<DisplayRecord>(text) {
        let mut by_display = std::collections::HashMap::new();
        by_display.insert(LEGACY_KEY.to_string(), single);
        return DisplayRecords { by_display, last: None };
    }
    DisplayRecords::default()
}

fn load_display_records(app: &tauri::AppHandle) -> DisplayRecords {
    let Some(path) = display_record_path(app) else {
        return DisplayRecords::default();
    };
    match std::fs::read_to_string(path) {
        Ok(text) => parse_display_records(&text),
        Err(_) => DisplayRecords::default(),
    }
}

fn save_display_records(app: &tauri::AppHandle, records: &DisplayRecords) {
    let Some(path) = display_record_path(app) else {
        return;
    };
    match serde_json::to_string(records)
        .map_err(|error| error.to_string())
        .and_then(|text| std::fs::write(&path, text).map_err(|error| error.to_string()))
    {
        Ok(()) => log::info!(
            "main window: remembered footprints for {} display(s), last = {:?}",
            records.by_display.len(),
            records.last
        ),
        Err(error) => log::warn!("Cannot remember the main window displays: {error}"),
    }
}

/// Chooses which display's footprint to size against: prefer the target display's own remembered
/// share (so returning to a screen restores its share), else carry over the share from the display
/// we came from (`last`), else fall back to the upgraded legacy record.
fn footprint_record_for(records: &DisplayRecords, key: &str) -> Option<DisplayRecord> {
    records
        .by_display
        .get(key)
        .or_else(|| records.last.as_deref().and_then(|last| records.by_display.get(last)))
        .or_else(|| records.by_display.get(LEGACY_KEY))
        .copied()
}

/// A stable identity for a display. Comparing only work-area width/height (the old `same_display`
/// check) conflates two identically-sized monitors; combining the name with the work-area origin
/// and size distinguishes them. Values are logical points, rounded to absorb sub-point jitter, so
/// a mere scale-factor change does not invalidate the key.
fn display_key(name: Option<&str>, wa_x: f64, wa_y: f64, wa_w: f64, wa_h: f64) -> String {
    let r = |v: f64| v.round() as i64;
    format!("{}|{},{}|{}x{}", name.unwrap_or("?"), r(wa_x), r(wa_y), r(wa_w), r(wa_h))
}

fn monitor_display_key(monitor: &Monitor) -> String {
    let mscale = monitor.scale_factor();
    let wa = monitor.work_area();
    display_key(
        monitor.name().map(String::as_str),
        wa.position.x as f64 / mscale,
        wa.position.y as f64 / mscale,
        wa.size.width as f64 / mscale,
        wa.size.height as f64 / mscale,
    )
}

/// The share of the screen the window covered when it was last sized there.
fn footprint(saved: Option<DisplayRecord>) -> (f64, f64) {
    match saved {
        Some(saved) if saved.work_width > 1.0 && saved.work_height > 1.0 => (
            (saved.width / saved.work_width).clamp(MIN_WIDTH_FRACTION, 1.0),
            (saved.height / saved.work_height).clamp(MIN_HEIGHT_FRACTION, 1.0),
        ),
        _ => (DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION),
    }
}

/// Turns a share of the display into a concrete size, never smaller than the designed minimum
/// and never larger than the work area.
fn sized(fractions: (f64, f64), wa_w: f64, wa_h: f64) -> (f64, f64) {
    (
        (wa_w * fractions.0).round().clamp(MAIN_MIN_WIDTH.min(wa_w), wa_w),
        (wa_h * fractions.1).round().clamp(MAIN_MIN_HEIGHT.min(wa_h), wa_h),
    )
}

/// Records the main window's current size against the display it is *actually* on, keyed by that
/// display. Called on user resizes (and after an adaptation) so each display keeps its own share.
pub fn note_main_window_geometry(app: &tauri::AppHandle) {
    // Shutdown re-emits Resized while leaving fullscreen; that transient geometry must not be
    // remembered as the user's chosen size, and must never schedule an adaptation.
    if is_closing(app) {
        return;
    }
    // Our own set_size/set_position emit events; don't let them write transient geometry.
    if move_state().applying {
        return;
    }
    let now = std::time::Instant::now();
    {
        let mut last = match LAST_RECORD_AT.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if last.is_some_and(|at| now.duration_since(at) < RECORD_INTERVAL) {
            return;
        }
        *last = Some(now);
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return;
    };
    let Ok(outer) = window.outer_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let mscale = monitor.scale_factor();
    let wa = monitor.work_area();
    let key = monitor_display_key(&monitor);
    let mut records = load_display_records(app);
    records.by_display.insert(
        key.clone(),
        DisplayRecord {
            work_width: wa.size.width as f64 / mscale,
            work_height: wa.size.height as f64 / mscale,
            width: outer.width as f64 / scale,
            height: outer.height as f64 / scale,
        },
    );
    records.last = Some(key);
    save_display_records(app, &records);
}

/// True when the logical rect intersects at least one monitor's work area.
fn is_on_any_monitor(monitors: &[Monitor], x: f64, y: f64, w: f64, h: f64) -> bool {
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let wa = m.work_area();
        let mx = wa.position.x as f64 / scale;
        let my = wa.position.y as f64 / scale;
        let mw = wa.size.width as f64 / scale;
        let mh = wa.size.height as f64 / scale;
        x < mx + mw && x + w > mx && y < my + mh && y + h > my
    })
}

/// Applies a target size/position to the main window and persists the footprint for `key`.
/// Re-fetches the window through the handle so this helper stays runtime-agnostic.
fn commit_main_window_geometry(
    app: &tauri::AppHandle,
    key: &str,
    wa_x: f64,
    wa_y: f64,
    wa_w: f64,
    wa_h: f64,
    tgt_w: f64,
    tgt_h: f64,
    cur: (f64, f64, f64, f64), // cur_w, cur_h, cur_x, cur_y in logical points
    recentre: bool,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window is gone".to_string())?;
    if (tgt_w - cur.0).abs() > 0.5 || (tgt_h - cur.1).abs() > 0.5 {
        window.set_size(LogicalSize::new(tgt_w, tgt_h)).map_err(|error| error.to_string())?;
    }
    let (new_x, new_y) = if recentre {
        (wa_x + (wa_w - tgt_w) / 2.0, wa_y + (wa_h - tgt_h) / 2.0)
    } else {
        (
            cur.2.max(wa_x).min(wa_x + wa_w - tgt_w),
            cur.3.max(wa_y).min(wa_y + wa_h - tgt_h),
        )
    };
    window.set_position(LogicalPosition::new(new_x, new_y)).map_err(|error| error.to_string())?;

    let mut records = load_display_records(app);
    records.by_display.insert(
        key.to_string(),
        DisplayRecord { work_width: wa_w, work_height: wa_h, width: tgt_w, height: tgt_h },
    );
    records.last = Some(key.to_string());
    save_display_records(app, &records);
    Ok(())
}

/// Re-validate and, if needed, correct the main window's size/position against the displays.
///
/// * `only_if_offscreen = false` (startup): always ensure a sane, fully-visible size.
/// * `only_if_offscreen = true` (display change): only act when the window is no longer on any
///   monitor, so an intentional placement survives a monitor reconnect/rearrange.
pub fn clamp_main_window_to_monitor(app: &tauri::AppHandle, only_if_offscreen: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Ok(());
    }
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let cur_w = outer.width as f64 / scale;
    let cur_h = outer.height as f64 / scale;
    let cur_x = position.x as f64 / scale;
    let cur_y = position.y as f64 / scale;

    if only_if_offscreen && is_on_any_monitor(&monitors, cur_x, cur_y, cur_w, cur_h) {
        return Ok(());
    }

    // Prefer the monitor the window is on; fall back to primary, then any monitor.
    let primary = match app.primary_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        _ => monitors.first().cloned(),
    };
    let monitor = window.current_monitor().ok().flatten().or(primary);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let key = monitor_display_key(&monitor);
    let mscale = monitor.scale_factor();
    let wa = monitor.work_area();
    let wa_x = wa.position.x as f64 / mscale;
    let wa_y = wa.position.y as f64 / mscale;
    let wa_w = wa.size.width as f64 / mscale;
    let wa_h = wa.size.height as f64 / mscale;

    let records = load_display_records(app);
    // A display we have a footprint for is one the window was previously sized on; a fresh one
    // (e.g. after a rearrange) is rebuilt from a carried-over share. Unlike the old work-area
    // width/height comparison, this cannot conflate two identically-sized monitors.
    let same_display = records.by_display.contains_key(&key);
    let footprint_record = footprint_record_for(&records, &key);

    let sane = cur_w <= wa_w * MAX_RESTORED_FRACTION
        && cur_h <= wa_h * MAX_RESTORED_FRACTION
        && cur_w >= MAIN_MIN_WIDTH.min(wa_w)
        && cur_h >= MAIN_MIN_HEIGHT.min(wa_h)
        && cur_w >= wa_w * MIN_WIDTH_FRACTION
        && cur_h >= wa_h * MIN_HEIGHT_FRACTION
        && cur_x + cur_w > wa_x
        && cur_y + cur_h > wa_y
        && cur_x < wa_x + wa_w
        && cur_y < wa_y + wa_h;

    // A window sized on another display (or on its first launch) is rebuilt from the share of the
    // screen it used to cover, so a 4K panel gets a 4K-sized window and a laptop panel a laptop one.
    let resized_by_display = !only_if_offscreen && !same_display;
    let (tgt_w, tgt_h, recentre) = if only_if_offscreen || resized_by_display {
        let (width, height) = sized(footprint(footprint_record), wa_w, wa_h);
        (width, height, true)
    } else if sane {
        (cur_w, cur_h, false)
    } else {
        let (width, height) = sized((DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION), wa_w, wa_h);
        (width, height, true)
    };

    log::info!(
        "main window: {cur_w:.0}x{cur_h:.0}pt at ({cur_x:.0},{cur_y:.0}) on a {wa_w:.0}x{wa_h:.0}pt display \
         (scale {mscale:.2}, same display: {same_display}, sane: {sane}) -> {tgt_w:.0}x{tgt_h:.0}pt"
    );

    commit_main_window_geometry(app, &key, wa_x, wa_y, wa_w, wa_h, tgt_w, tgt_h, (cur_w, cur_h, cur_x, cur_y), recentre)
}

/// Rebuilds the main window to fit `target_key`'s work area after a drag landed it on a new
/// display. Uses the target display's own remembered share when returning, otherwise carries over
/// the share from the display it came from. Always re-centres within the target work area.
fn adapt_main_window_to_display(app: &tauri::AppHandle, target_key: &str) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window is gone".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    // The window may still straddle the boundary; prefer current_monitor when it is the target,
    // otherwise locate the target by its stable key. If it vanished (unplugged mid-drag), no-op.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .filter(|m| monitor_display_key(m).as_str() == target_key)
        .or_else(|| monitors.into_iter().find(|m| monitor_display_key(m).as_str() == target_key));
    let Some(monitor) = monitor else {
        log::info!("main window: target display {target_key} is gone; skipping adaptation");
        return Ok(());
    };
    let mscale = monitor.scale_factor();
    let wa = monitor.work_area();
    let wa_x = wa.position.x as f64 / mscale;
    let wa_y = wa.position.y as f64 / mscale;
    let wa_w = wa.size.width as f64 / mscale;
    let wa_h = wa.size.height as f64 / mscale;

    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let cur = (
        outer.width as f64 / scale,
        outer.height as f64 / scale,
        position.x as f64 / scale,
        position.y as f64 / scale,
    );

    let records = load_display_records(app);
    let fractions = footprint(footprint_record_for(&records, target_key));
    let (tgt_w, tgt_h) = sized(fractions, wa_w, wa_h);

    log::info!(
        "main window: adapting to display {target_key} ({wa_w:.0}x{wa_h:.0}pt) -> {tgt_w:.0}x{tgt_h:.0}pt"
    );

    commit_main_window_geometry(app, target_key, wa_x, wa_y, wa_w, wa_h, tgt_w, tgt_h, cur, true)
}

/// Called on every main-window `Moved` event. Only a change of *display identity* schedules an
/// adaptation; ordinary same-display dragging is a no-op. The work is debounced and reentrancy
/// guarded so we never resize per drag frame and never react to our own set_size/set_position.
pub fn on_main_window_moved(app: &tauri::AppHandle) {
    // Leaving fullscreen during shutdown emits Moved/Resized events. Never resize or reposition
    // a window that is on its way out — it would fight the fullscreen transition.
    if is_closing(app) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return;
    };
    let key = monitor_display_key(&monitor);

    let scheduled: Option<(u64, String)> = {
        let mut state = move_state();
        if state.applying {
            // Our own resize is in progress; keep the baseline current, never schedule a new one.
            state.last_key = Some(key);
            None
        } else {
            match &state.last_key {
                None => {
                    // First observation establishes the baseline; not a display change.
                    state.last_key = Some(key.clone());
                    None
                }
                Some(previous) if *previous == key => None,
                Some(_) => {
                    state.last_key = Some(key.clone());
                    state.generation = state.generation.wrapping_add(1);
                    Some((state.generation, key))
                }
            }
        }
    };
    let Some((generation, target_key)) = scheduled else {
        return;
    };

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ADAPT_DEBOUNCE);
        {
            let state = move_state();
            if state.generation != generation || state.applying {
                return; // superseded by a later move, or an adaptation already running
            }
        }
        let handle_for_main = handle.clone();
        let key_for_main = target_key.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            {
                let mut state = move_state();
                if state.generation != generation || state.applying {
                    return;
                }
                state.applying = true;
            }
            if !is_closing(&handle_for_main) {
                if let Err(error) = adapt_main_window_to_display(&handle_for_main, &key_for_main) {
                    log::warn!("Could not adapt main window to new display: {error}");
                }
            }
            let mut state = move_state();
            state.applying = false;
        }) {
            log::warn!("Could not schedule main window display adaptation: {error}");
        }
    });
}

/// Initial correction at startup, plus (on macOS) a live re-clamp when displays change.
pub fn install_main_window_monitoring(app: &tauri::AppHandle) {
    if let Err(error) = clamp_main_window_to_monitor(app, false) {
        log::warn!("Could not adapt main window to the display: {error}");
    }
    // Seed the display baseline so the very first Moved event isn't mistaken for a cross-display
    // drag, and a drag that is already underway is detected immediately.
    if let Some(window) = app.get_webview_window("main") {
        if let Some(key) = window.current_monitor().ok().flatten().map(|m| monitor_display_key(&m)) {
            move_state().last_key = Some(key);
        }
    }
    #[cfg(target_os = "macos")]
    install_screen_change_observer(app);
}

#[cfg(target_os = "macos")]
mod screen_observer {
    use std::sync::OnceLock;

    use objc2::{
        ClassType, msg_send,
        runtime::{AnyObject, ClassBuilder, Sel},
        sel,
    };
    use objc2_app_kit::NSApplicationDidChangeScreenParametersNotification;
    use objc2_foundation::{NSNotificationCenter, NSObject};
    use tauri::Manager;

    use crate::window::clamp_main_window_to_monitor;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    pub(super) fn install(app: &tauri::AppHandle) {
        APP.set(app.clone()).expect("Main window screen observer installed once");
        let mut builder =
            ClassBuilder::new(c"AlwithMainScreenObserver", NSObject::class()).expect("Main window screen observer class");
        // SAFETY: selector and callback agree; the observer lives until process exit.
        unsafe {
            builder.add_method(sel!(reclampMain:), reclamp as extern "C-unwind" fn(_, _, _));
            let class = builder.register();
            let observer: *mut AnyObject = msg_send![class, new];
            assert!(!observer.is_null(), "Main window screen observer allocation");
            let center = NSNotificationCenter::defaultCenter();
            let _: () = msg_send![
                &*center,
                addObserver: observer,
                selector: sel!(reclampMain:),
                name: NSApplicationDidChangeScreenParametersNotification,
                object: std::ptr::null::<AnyObject>()
            ];
        }
    }

    extern "C-unwind" fn reclamp(_observer: &AnyObject, _selector: Sel, _notification: *mut AnyObject) {
        let Some(app) = APP.get() else {
            return;
        };
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if crate::window::is_closing(&handle) {
                return;
            }
            // Only fix the window if it drifted fully off-screen; never move an intentional placement.
            if let Err(error) = clamp_main_window_to_monitor(&handle, true) {
                log::warn!("Could not re-clamp main window after display change: {error}");
            }
        }) {
            log::error!("Could not schedule main window re-clamp: {error}");
        }
    }
}

#[cfg(target_os = "macos")]
fn install_screen_change_observer(app: &tauri::AppHandle) {
    screen_observer::install(app);
}

#[cfg(test)]
#[path = "__tests__/window.rs"]
mod tests;
