//! Window helpers ported from ALwith Desktop's `app/native.rs`.

use tauri::{LogicalPosition, Manager, Monitor, PhysicalSize};

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
    // Native window notifications may arrive before setup has installed the Drive plugin's state.
    app.try_state::<alwith_drive::Drive>().is_some_and(|state| state.is_closing())
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
// display. Each display keeps its own remembered window share (keyed by name + the display's own
// frame origin, which the Dock, the menu bar and Stage Manager cannot move), so moving the window
// between a 2880x1620 landscape panel and a 1440x2560 portrait panel rebuilds the right size on
// each, without a single global record being polluted by mixed geometry. A drag that lands the
// window on a *different* display triggers a debounced rebuild; same-display drags and manual
// resizes are left untouched.
//
// A display's own parameters can also change without any drag (resolution, scale factor, input
// source, a panel plugged in or removed). That path used to only rescue a window that had drifted
// fully off-screen, so a window prepared for the old panel kept its old size on the new, larger
// one — the "只占屏幕左边三分之一、侧边栏被压到 100px" report. It now runs the same share model.
//
// Everything below compares rectangles in **global physical pixels**. `Monitor::work_area` and
// `outer_position`/`outer_size` already share that space, whereas dividing each by its own scale
// factor (window vs monitor) yields coordinates that cannot be compared on a mixed-DPI pair.

const MAIN_MIN_WIDTH: f64 = 1250.0;
const MAIN_MIN_HEIGHT: f64 = 750.0;
const DEFAULT_WIDTH_FRACTION: f64 = 0.85;
const DEFAULT_HEIGHT_FRACTION: f64 = 0.88;
/// A restored frame larger than the work area by this factor is a transient/corrupt capture (the
/// classic 11440×3000 zoned state), not a size the reader chose. Deliberately large windows are
/// *not* caught by this: a window filling 98% of its panel is a legitimate choice, and the old
/// "share > 0.95 is absurd" test shrank exactly those back to 85% on every launch.
const ABSURD_WORK_AREA_FACTOR: f64 = 1.5;
/// A window that covers less than this share of its display is treated as "sized for a different
/// screen" — e.g. the 1280×820 config default on a 2880×1620 panel, or the same window carried
/// over to a display with another resolution.
const MIN_WIDTH_FRACTION: f64 = 0.45;
const MIN_HEIGHT_FRACTION: f64 = 0.45;

/// Debounce for a drag that crosses onto another display: only the display the window finally
/// rests on (after the drag stops) is acted on, so we never resize on every Moved frame.
const ADAPT_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);
/// The window's size as a fraction of the work area of whatever display it is on.
///
/// This is the whole model: **one** number pair, `work_area × share`, applied everywhere. No
/// per-display record, no display identity, no "have I seen this panel before". That machinery was
/// the bug: the display key mixed in the work area, so the Dock sliding, the menu bar showing or a
/// scale change all looked like a brand-new display, which rebuilt the window from the defaults —
/// shrinking a deliberately large window on launch and leaving 14 phantom "displays" in the store
/// on a two-panel machine. A window that filled 98% of its panel was also rejected as "absurd" and
/// reset to 85% by the same logic.
///
/// Only `work_width`/`work_height` are needed to derive the share; they may be stale (the Dock has
/// moved since) because the record is read as the ratio `width / work_width`, which is scale-free.
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
struct DisplayRecord {
    work_width: f64,
    work_height: f64,
    width: f64,
    height: f64,
}

/// On-disk state: a single global share. Nothing per display is persisted any more.
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct DisplayRecords {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    share: Option<(f64, f64)>,
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

static MOVE_MONITOR_STATE: std::sync::Mutex<MoveMonitorState> =
    std::sync::Mutex::new(MoveMonitorState { last_key: None, generation: 0, applying: false });

fn move_state() -> std::sync::MutexGuard<'static, MoveMonitorState> {
    MOVE_MONITOR_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn display_record_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|directory| directory.join(DISPLAY_RECORD_FILE))
}

/// Parses the size record, migrating every older on-disk shape to the single global share.
///
/// Shapes seen in the wild, in order of age:
///   1. one bare `DisplayRecord` (very old);
///   2. `{"by_display": {key: DisplayRecord}, "last": key}` (per-display map, the design that shrank
///      windows whenever a key changed);
///   3. `{"share": [w, h], "by_display": …, "last": …}` (transitional);
///   4. `{"share": [w, h]}` (current).
///
/// Older shapes are read **once** to recover the reader's chosen proportion, then the file is
/// rewritten in the current shape. Nothing per display survives. A corrupt file degrades to empty
/// so it can never crash startup.
fn parse_display_records(text: &str) -> DisplayRecords {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return DisplayRecords::default();
    };
    let Some(object) = value.as_object() else {
        return DisplayRecords::default();
    };
    if let Some(share) = object.get("share").and_then(|raw| serde_json::from_value::<(f64, f64)>(raw.clone()).ok()) {
        return DisplayRecords { share: Some(share) };
    }
    // Every older shape expresses the same thing — the proportion the reader last chose — so read
    // whichever record is present, in order of preference: the display last sized on, then any
    // remaining per-display record, then a bare single-record file.
    let map = object.get("by_display").and_then(serde_json::Value::as_object);
    let by_key = |key: &str| {
        map.and_then(|map| map.get(key))
            .and_then(|raw| serde_json::from_value::<DisplayRecord>(raw.clone()).ok())
    };
    let carried = object
        .get("last")
        .and_then(serde_json::Value::as_str)
        .and_then(by_key)
        .or_else(|| map.and_then(|map| map.values().find_map(|raw| serde_json::from_value::<DisplayRecord>(raw.clone()).ok())));
    let single = carried.or_else(|| serde_json::from_value::<DisplayRecord>(value.clone()).ok());
    DisplayRecords { share: single.map(|record| footprint(Some(record))) }
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
        Ok(()) => log::info!("main window: remembered share {:?}", records.share),
        Err(error) => log::warn!("Cannot remember the main window displays: {error}"),
    }
}

/// A stable identity for a display: its name plus the origin of its **own frame**.
///
/// The work area is deliberately *not* part of the identity. `work_area()` shrinks and moves
/// whenever the Dock is shown/hidden or resized, the menu bar appears/disappears, or Stage Manager
/// takes a strip off the side — so including it (either its size or its origin) turned a mere Dock
/// change into "a brand new display". Every such fake display then re-created the window from a
/// carried-over footprint, which is exactly the observed "换屏后窗口尺寸乱跳、越换越小":
/// the same panel appeared as `…|1920x960`, `…|1920x1050` and `…|2560x1320`, and each of those was
/// sized as if it were a display the app had never seen.
///
/// The display's own `position()` only changes when the displays are physically rearranged, which
/// really is a different layout. Values are logical points rounded to whole points, so sub-point
/// jitter cannot invalidate the key either.
fn display_key(name: Option<&str>, x: f64, y: f64) -> String {
    let r = |v: f64| v.round() as i64;
    format!("{}|{},{}", name.unwrap_or("?"), r(x), r(y))
}

fn monitor_display_key(monitor: &Monitor) -> String {
    let mscale = monitor.scale_factor();
    let position = monitor.position();
    display_key(monitor.name().map(String::as_str), position.x as f64 / mscale, position.y as f64 / mscale)
}

/// The proportion to size at: the stored global share, or the defaults on a fresh install.
fn saved_share(records: &DisplayRecords) -> (f64, f64) {
    match records.share {
        Some((w, h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            (w.clamp(MIN_WIDTH_FRACTION, 1.0), h.clamp(MIN_HEIGHT_FRACTION, 1.0))
        }
        _ => (DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION),
    }
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

/// A rectangle in global physical pixels. Every geometry comparison in this module uses this one
/// unit; logical points are only produced at the very edge, when a share is recorded.
#[derive(Clone, Copy, Debug, PartialEq)]
struct RectPx {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn work_area_px(monitor: &Monitor) -> RectPx {
    let wa = monitor.work_area();
    RectPx { x: wa.position.x as f64, y: wa.position.y as f64, w: wa.size.width as f64, h: wa.size.height as f64 }
}

/// The area two rectangles share. Zero when they merely touch, so a window sitting exactly on the
/// seam between two displays belongs to neither rather than to both.
fn overlap_area(a: RectPx, b: RectPx) -> f64 {
    let w = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let h = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    if w <= 0.0 || h <= 0.0 { 0.0 } else { w * h }
}

/// The display a window belongs to: the one it covers the most of.
///
/// `window.current_monitor()` is the obvious call and it is the wrong one — for a window that
/// straddles two displays (a maximised window whose frame is one pixel over the seam, a window
/// mid-drag) the platform may answer either, and acting on "either" is what let a maximised window
/// grow past its own screen edge because the *other* display's width was used as the ceiling.
fn owning_monitor_index(areas: &[RectPx], window: RectPx) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (index, area) in areas.iter().enumerate() {
        let covered = overlap_area(*area, window);
        if covered <= 0.0 {
            continue;
        }
        if best.is_none_or(|(_, most)| covered > most) {
            best = Some((index, covered));
        }
    }
    best.map(|(index, _)| index)
}

/// What a display change should do with the main window.
#[derive(Clone, Copy, Debug, PartialEq)]
enum GeometryPlan {
    /// Leave the size alone; the window is already the right size for this display.
    Keep,
    /// Resize (in logical points) and re-centre in the owning display's work area.
    Rebuild { width: f64, height: f64 },
}

struct GeometryInput {
    /// The window's size as a share of the owning display's work area.
    share: (f64, f64),
    /// Logical work-area size of the owning display.
    work: (f64, f64),
    /// A drag onto another display: re-apply the share against the new work area.
    landed_here: bool,
    /// The display's own resolution/scale changed, so the share must be re-applied.
    display_changed: bool,
    maximized: bool,
    fullscreen: bool,
    /// The startup pass also rejects an absurdly large or sub-minimum saved size.
    validate_size: bool,
    /// The global share to size at (`work area × share`).
    fractions: (f64, f64),
}

/// The single place that decides whether a window's size belongs to the display it is on.
///
/// The model is one global share of the work area: the size on **any** display is
/// `that display's work area × share`. Which display it is, and whether we have ever sized on it,
/// is deliberately **not** part of the decision — that was the bug. Keying on display identity meant
/// any key change (Dock, menu bar, scale factor, a rename) looked like a brand-new panel and rebuilt
/// the window from defaults, shrinking a deliberately large window on every launch.
///
/// A window is only resized when the geometry actually has to change: it was dragged to another
/// panel, that panel's own resolution changed, or the current size is outside the sane range.
/// A deliberate small window, a maximised window and a fullscreen window are left untouched.
fn plan_geometry(input: GeometryInput) -> GeometryPlan {
    // Never fight the window server: a maximised or fullscreen window is positioned by the system
    // and its frame is the work area itself (a share of ~1.0), which the "too large" test below
    // would otherwise read as a corrupt saved geometry and shrink to 85%.
    if input.fullscreen || input.maximized {
        return GeometryPlan::Keep;
    }
    let rebuild = |fractions: (f64, f64)| {
        let (width, height) = sized(fractions, input.work.0, input.work.1);
        GeometryPlan::Rebuild { width, height }
    };
    // Only a real geometry change re-applies the share. Being on an unfamiliar display is not one.
    if input.landed_here || input.display_changed {
        return rebuild(input.fractions);
    }
    let smaller_than_intended = input.share.0 < MIN_WIDTH_FRACTION || input.share.1 < MIN_HEIGHT_FRACTION;
    if smaller_than_intended {
        return rebuild(input.fractions);
    }
    if !input.validate_size {
        return GeometryPlan::Keep;
    }
    // Startup: a frame larger than the work area by a wide margin cannot be a size anyone chose —
    // it is the classic transient maximised/zoned capture (11440×3000). Test the *pixels against
    // the work area*, not the share: a window deliberately filling 98% of its panel is legitimate
    // and must survive a restart (the old "share > 0.95" rule shrank exactly those to 85%).
    let absurd = input.share.0 > ABSURD_WORK_AREA_FACTOR || input.share.1 > ABSURD_WORK_AREA_FACTOR;
    if absurd {
        // A corrupt capture (11440×3000 recorded on a 2560×1440 panel). Nothing about it is usable,
        // so start from the designed default.
        return rebuild((DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION));
    }
    let too_small = input.share.0 * input.work.0 < MAIN_MIN_WIDTH.min(input.work.0)
        || input.share.1 * input.work.1 < MAIN_MIN_HEIGHT.min(input.work.1);
    if too_small {
        return rebuild((DEFAULT_WIDTH_FRACTION, DEFAULT_HEIGHT_FRACTION));
    }
    // A window slightly larger than its work area is normal after a display change (macOS loses the
    // rounded corners and clips the bottom rows). Fill the work area instead of jumping to 85%:
    // the reader asked for "as big as possible", not for a 15% margin.
    let oversized = input.share.0 > 1.0 || input.share.1 > 1.0;
    if oversized {
        return rebuild((input.share.0.min(1.0), input.share.1.min(1.0)));
    }
    GeometryPlan::Keep
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
    // A maximized/fullscreen frame is the work area, not the size the reader picked. Recording it
    // would remember "100% of the screen" for this display and restore the app maximized-looking
    // on the next launch — the other half of the "最大化也异常" report.
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(outer), Ok(position), Ok(monitors)) =
        (window.outer_size(), window.outer_position(), app.available_monitors())
    else {
        return;
    };
    let frame = RectPx { x: position.x as f64, y: position.y as f64, w: outer.width as f64, h: outer.height as f64 };
    let areas: Vec<RectPx> = monitors.iter().map(work_area_px).collect();
    // Same ownership rule as every other path here: the display the window covers the most of.
    let Some(owner) = owning_monitor_index(&areas, frame) else {
        return;
    };
    let work = areas[owner];
    let mut records = load_display_records(app);
    // The reader just chose a size. Store it as the one global proportion of the work area, so the
    // same window proportion is reproduced on any panel — never a per-display footprint.
    records.share = Some((
        (frame.w / work.w).clamp(MIN_WIDTH_FRACTION, 1.0),
        (frame.h / work.h).clamp(MIN_HEIGHT_FRACTION, 1.0),
    ));
    save_display_records(app, &records);
}

/// Applies a target size/position to the main window and records the footprint for `key`.
///
/// Sizes arrive in physical pixels and are applied as such: `PhysicalSize`/`PhysicalPosition` need
/// no scale factor at all, which removes the "divide by the window's scale or the monitor's?"
/// ambiguity that made a mixed-DPI pair land on the wrong size.
fn commit_main_window_geometry(
    app: &tauri::AppHandle,
    work: RectPx,
    target: (f64, f64), // logical size to apply
    cur: RectPx,        // current frame, global physical pixels
    recentre: bool,
    mscale: f64, // owning display's scale factor, for the recorded share only
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window is gone".to_string())?;
    let tgt_w = target.0;
    let tgt_h = target.1;
    let tgt_w_px = (tgt_w * mscale).round();
    let tgt_h_px = (tgt_h * mscale).round();
    if (tgt_w_px - cur.w).abs() > 1.0 || (tgt_h_px - cur.h).abs() > 1.0 {
        window.set_size(PhysicalSize::new(tgt_w_px, tgt_h_px)).map_err(|error| error.to_string())?;
    }
    let wa_x = work.x / mscale;
    let wa_y = work.y / mscale;
    let wa_w = work.w / mscale;
    let wa_h = work.h / mscale;
    let (new_x, new_y) = if recentre {
        (wa_x + (wa_w - tgt_w) / 2.0, wa_y + (wa_h - tgt_h) / 2.0)
    } else {
        // Keep a deliberate placement, only pulling the frame back inside the work area.
        ((cur.x / mscale).max(wa_x).min(wa_x + wa_w - tgt_w), (cur.y / mscale).max(wa_y).min(wa_y + wa_h - tgt_h))
    };
    window.set_position(LogicalPosition::new(new_x, new_y)).map_err(|error| error.to_string())?;

    let mut records = load_display_records(app);
    records.share = Some((
        (tgt_w / wa_w).clamp(MIN_WIDTH_FRACTION, 1.0),
        (tgt_h / wa_h).clamp(MIN_HEIGHT_FRACTION, 1.0),
    ));
    save_display_records(app, &records);
    Ok(())
}

/// Holds the adaptation reentrancy flag for the duration of one geometry commit, so the
/// `Resized`/`Moved` events our own `set_size` emits are neither recorded nor re-scheduled — and so
/// an early return can never leave the flag set.
struct Applying;

impl Applying {
    fn enter() -> Option<Self> {
        let mut state = move_state();
        if state.applying {
            return None;
        }
        state.applying = true;
        Some(Self)
    }
}

impl Drop for Applying {
    fn drop(&mut self) {
        move_state().applying = false;
    }
}

/// Everything a geometry pass needs to know about the window and the display it is on, measured
/// once so the two clamp paths cannot disagree about which display that is.
struct Frame {
    window: tauri::WebviewWindow,
    work: RectPx,
    frame: RectPx,
    key: String,
    mscale: f64,
    maximized: bool,
    fractions: (f64, f64),
}

impl Frame {
    /// The window's size as a share of its display's work area. Both numbers are in physical
    /// pixels, so the share carries no scale factor and compares correctly across a mixed-DPI pair.
    fn share(&self) -> (f64, f64) {
        (self.frame.w / self.work.w, self.frame.h / self.work.h)
    }

    fn work_logical(&self) -> (f64, f64) {
        (self.work.w / self.mscale, self.work.h / self.mscale)
    }

    /// The window is entirely inside its display's work area.
    fn inside(&self) -> bool {
        self.frame.x >= self.work.x
            && self.frame.y >= self.work.y
            && self.frame.x + self.frame.w <= self.work.x + self.work.w
            && self.frame.y + self.frame.h <= self.work.y + self.work.h
    }

    fn is_fullscreen(&self) -> bool {
        self.window.is_fullscreen().unwrap_or(false)
    }
}

/// Reads the main window and the display it belongs to. `None` when there is no window or no
/// display to measure against (a headless start), which every caller treats as a no-op.
fn measure_main_window(app: &tauri::AppHandle) -> Result<Option<Frame>, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Ok(None);
    }
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let frame = RectPx { x: position.x as f64, y: position.y as f64, w: outer.width as f64, h: outer.height as f64 };
    let areas: Vec<RectPx> = monitors.iter().map(work_area_px).collect();
    let owner = owning_monitor_index(&areas, frame);
    // Fully off every display: fall back to the primary so the caller can pull it back, instead of
    // leaving the reader with a window they cannot reach.
    let owner = match owner {
        Some(index) => index,
        None => match app.primary_monitor() {
            Ok(Some(primary)) => {
                let key = monitor_display_key(&primary);
                monitors.iter().position(|monitor| monitor_display_key(monitor) == key).unwrap_or(0)
            }
            _ => 0,
        },
    };
    let monitor = monitors[owner].clone();
    let records = load_display_records(app);
    let key = monitor_display_key(&monitor);
    Ok(Some(Frame {
        key: key.clone(),

        fractions: saved_share(&records),
        work: areas[owner],
        mscale: monitor.scale_factor(),
        maximized: window.is_maximized().unwrap_or(false),
        frame,
        window,
    }))
}

/// Commits a plan for `frame`. `recentre` is implied by a rebuild; a `Keep` only nudges the frame
/// back inside the work area.
fn apply_plan(app: &tauri::AppHandle, frame: &Frame, plan: GeometryPlan) -> Result<(), String> {
    // A maximized or fullscreen frame belongs to the window server: it is already exactly the work
    // area, so "resize to fit" would shrink it by a few pixels and "re-centre" would move it. Both
    // are visible glitches, and recording that frame would remember ~100% as the reader's chosen
    // size. Every display change re-maximizes on its own, so there is nothing left to do.
    if frame.maximized || frame.is_fullscreen() {
        log::info!("main window: maximized or fullscreen; leaving the frame to the window server");
        return Ok(());
    }
    let Some(_applying) = Applying::enter() else {
        return Ok(());
    };
    let (target, recentre) = match plan {
        GeometryPlan::Keep => ((frame.frame.w / frame.mscale, frame.frame.h / frame.mscale), false),
        GeometryPlan::Rebuild { width, height } => ((width, height), true),
    };
    commit_main_window_geometry(app, frame.work, target, frame.frame, recentre, frame.mscale)
}

/// Re-validate and, if needed, correct the main window's size/position against the displays.
///
/// * `only_if_offscreen = false` (startup): always ensure a sane, fully-visible size.
/// * `only_if_offscreen = true` (routine re-clamp): leave a window that sits inside its display at
///   a share that display could have chosen — an intentional placement survives a monitor
///   reconnect/rearrange. A window that is off-screen, or too small for the display it is now on,
///   is pulled back and re-sized.
pub fn clamp_main_window_to_monitor(app: &tauri::AppHandle, only_if_offscreen: bool) -> Result<(), String> {
    let Some(frame) = measure_main_window(app)? else {
        return Ok(());
    };
    let plan = plan_geometry(GeometryInput {
        share: frame.share(),
        work: frame.work_logical(),
        display_changed: false,
        landed_here: false,
        maximized: frame.maximized,
        fullscreen: frame.is_fullscreen(),
        validate_size: !only_if_offscreen,
        fractions: frame.fractions,
    });
    log::info!(
        "main window: clamp {}x{}px at ({},{}) on {} (scale {:.2}, maximized: {}, share: {:.2}x{:.2}, \
         plan: {:?})",
        frame.frame.w.round(),
        frame.frame.h.round(),
        frame.frame.x.round(),
        frame.frame.y.round(),
        frame.key,
        frame.mscale,
        frame.maximized,
        frame.share().0,
        frame.share().1,
        plan
    );
    if only_if_offscreen && frame.inside() && plan == GeometryPlan::Keep {
        return Ok(());
    }
    apply_plan(app, &frame, plan)
}

/// Re-builds the main window for the display it now belongs to after a display's own parameters
/// changed (resolution, scale factor, input source, a panel plugged in or removed) with no drag.
///
/// This is the path that used to be missing. `clamp_main_window_to_monitor(.., true)` returns as
/// soon as the window is still on some screen, so a window left over from a smaller panel kept its
/// old frame on the new, larger one — it occupied a corner of the screen and the app laid itself out
/// for a width it no longer had.
pub fn adapt_main_window_after_display_change(app: &tauri::AppHandle) -> Result<(), String> {
    if is_closing(app) {
        return Ok(());
    }
    let Some(frame) = measure_main_window(app)? else {
        return Ok(());
    };
    // Leaving fullscreen emits the same notification; resizing underneath it fights the window
    // server and leaves a stray frame behind.
    if frame.is_fullscreen() {
        log::info!("main window: display changed while fullscreen on {}; deferring", frame.key);
        return Ok(());
    }
    let plan = plan_geometry(GeometryInput {
        share: frame.share(),
        work: frame.work_logical(),
        display_changed: true,
        landed_here: false,
        maximized: frame.maximized,
        fullscreen: false,
        validate_size: false,
        fractions: frame.fractions,
    });
    log::info!(
        "main window: display changed, owning {} (share {:.2}x{:.2}, plan: {:?})",
        frame.key,
        frame.share().0,
        frame.share().1,
        plan
    );
    let result = if frame.inside() && plan == GeometryPlan::Keep { Ok(()) } else { apply_plan(app, &frame, plan) };
    // The baseline must follow the new display, or the very next `Moved` reads as a cross-display
    // drag and adapts a second time (a visible bounce). Bumping the generation also discards a
    // drag adaptation that was scheduled before the display changed.
    {
        let mut state = move_state();
        state.generation = state.generation.wrapping_add(1);
        state.last_key = Some(frame.key.clone());
    }
    result
}

/// Rebuilds the main window to fit `target_key`'s work area after a drag landed it on a new
/// display. Uses the target display's own remembered share when returning, otherwise carries over
/// the share from the display it came from. Always re-centres within the target work area.
fn adapt_main_window_to_display(app: &tauri::AppHandle, target_key: &str) -> Result<(), String> {
    let Some(frame) = measure_main_window(app)? else {
        return Ok(());
    };
    if frame.key != target_key {
        // The drag ended somewhere else again; the newer `Moved` owns the decision.
        log::info!("main window: target display {target_key} is gone or no longer owns the window; skipping");
        return Ok(());
    }
    let plan = plan_geometry(GeometryInput {
        share: frame.share(),
        work: frame.work_logical(),
        display_changed: false,
        landed_here: true,
        maximized: frame.maximized,
        fullscreen: frame.is_fullscreen(),
        validate_size: false,
        fractions: frame.fractions,
    });
    log::info!(
        "main window: landed on {} (share {:.2}x{:.2}, plan: {:?})",
        frame.key,
        frame.share().0,
        frame.share().1,
        plan
    );
    apply_plan(app, &frame, plan)
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
    // Ownership by largest overlap, exactly as the clamp paths decide it: `current_monitor()` is
    // ambiguous for a window on the seam between two displays, and using a different rule here
    // than there let a drag trigger an adaptation against the wrong display's work area.
    let Some(frame) = measure_main_window(app).ok().flatten() else {
        return;
    };
    let key = frame.key.clone();

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
    // drag, and a drag that is already underway is detected immediately. `measure_main_window`
    // decides ownership by overlap, so the baseline names the display the window really is on.
    if let Ok(Some(frame)) = measure_main_window(app) {
        move_state().last_key = Some(frame.key);
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
        let mut builder = ClassBuilder::new(c"AlwithMainScreenObserver", NSObject::class())
            .expect("Main window screen observer class");
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
            // Two passes: pull a window that drifted off-screen back into view, then re-fit a
            // window that was sized for the display parameters that just went away. The second
            // pass is what makes "从另一个屏幕过来" land at the right size without the reader
            // having to nudge the window themselves.
            if let Err(error) = clamp_main_window_to_monitor(&handle, true) {
                log::warn!("Could not re-clamp main window after display change: {error}");
            }
            if let Err(error) = crate::window::adapt_main_window_after_display_change(&handle) {
                log::warn!("Could not re-fit main window after display change: {error}");
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
