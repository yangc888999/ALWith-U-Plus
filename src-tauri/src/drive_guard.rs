//! Local guard against cloud-side version rollback.
//!
//! The Drive sync daemon lives in a prebuilt native library and writes files on its own; there is
//! no hook to intercept a download before it lands. What the app *can* do purely locally is keep a
//! small content ledger per Drive file: every distinct content the file has had, plus a shadow copy
//! of the newest one. When the daemon later replaces a file with content that the same machine has
//! already seen (and which is not the newest), that is a rollback — another device uploaded an old
//! copy — and the guard restores the shadow copy instead of letting the old version win.
//!
//! Deliberately narrow:
//! * Only files under an indexed Drive root are considered.
//! * A write that follows a user edit through the app within `USER_WRITE_GRACE_MS` is trusted and
//!   becomes the new baseline — the user asked for it.
//! * Content that was never seen before is treated as a newer edit and recorded, never restored.
//! * Only the newest shadow copy is kept (bounded); older history is hashes only.
//!
//! The guard is opt-in through the Drive settings switch; off means the default daemon behaviour.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

/// How long after a write through the app's own editor a file change is still attributed to the
/// user. The daemon may finalise a save a moment later, so this is a grace window, not an exact
/// handoff.
pub const USER_WRITE_GRACE_MS: i64 = 15_000;

/// Files above this size are hashed but never shadowed: the point is to rescue documents, not to
/// mirror a video library into app data.
pub const SHADOW_SIZE_CAP: u64 = 32 * 1024 * 1024;

/// Hashes remembered per path. Enough to catch an old version coming back after several edits,
/// small enough that the ledger stays a few hundred bytes per file.
const HISTORY_CAP: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// First time this content is seen: record it as the newest.
    Baseline,
    /// A change right after the user's own save: trust it and make it the newest.
    UserEdit,
    /// Content the machine has seen before but which is not the newest: a rollback.
    Rollback,
    /// Content never seen before and not a user save: someone else's newer edit.
    Newer,
    /// Nothing changed since the last scan.
    Unchanged,
}

#[derive(Debug, Default, Clone)]
pub struct LedgerEntry {
    /// Newest content hash, in the order this machine observed them.
    pub newest: String,
    /// All hashes ever seen for this path, newest last. Used to recognise a returning old version.
    pub history: VecDeque<String>,
    /// Wall clock of the newest observation (epoch ms).
    pub newest_at: i64,
    /// Shadow copy of the newest content, when small enough to keep.
    pub shadow: Option<PathBuf>,
    /// Size and modification time (nanoseconds) of the file the ledger last looked at. A pass that
    /// finds both unchanged skips hashing entirely, so the guard costs one `stat` per file instead
    /// of reading the whole Drive every five minutes and competing with the sync daemon for disk.
    /// Nanoseconds, not milliseconds: two saves inside the same millisecond are otherwise
    /// indistinguishable and a rollback would be missed.
    pub size: u64,
    pub mtime_ns: i64,
}

impl LedgerEntry {
    fn remember(&mut self, hash: &str, at: i64, shadow: Option<PathBuf>, size: u64, mtime_ns: i64) {
        if self.history.iter().any(|known| known == hash) {
            self.history.retain(|known| known != hash);
        }
        self.history.push_back(hash.to_string());
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
        self.newest = hash.to_string();
        self.newest_at = at;
        self.size = size;
        self.mtime_ns = mtime_ns;
        if shadow.is_some() {
            self.shadow = shadow;
        }
    }

    fn seen_before(&self, hash: &str) -> bool {
        self.history.iter().any(|known| known == hash)
    }
}

/// Pure decision: given what the ledger knows and the hash now on disk, what should happen?
///
/// `last_user_write_ms` is the last time the app itself wrote this path (0 when never). The caller
/// restores the shadow copy only on `Rollback`; every other verdict is recorded.
pub fn decide(
    entry: Option<&LedgerEntry>,
    current_hash: &str,
    now_ms: i64,
    last_user_write_ms: i64,
) -> Verdict {
    let Some(entry) = entry else {
        return Verdict::Baseline;
    };
    if entry.newest == current_hash {
        return Verdict::Unchanged;
    }
    if last_user_write_ms > 0 && now_ms.saturating_sub(last_user_write_ms) <= USER_WRITE_GRACE_MS {
        return Verdict::UserEdit;
    }
    if entry.seen_before(current_hash) {
        return Verdict::Rollback;
    }
    Verdict::Newer
}

/// Bounded ledger shared between the scan loop and the command that records user writes.
#[derive(Debug, Default)]
pub struct Ledger {
    entries: Mutex<HashMap<PathBuf, LedgerEntry>>,
    user_writes: Mutex<HashMap<PathBuf, i64>>,
    enabled: AtomicBool,
    last_scan_ms: AtomicI64,
}

impl Ledger {
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn note_user_write(&self, path: &Path, at_ms: i64) {
        if let Ok(mut writes) = self.user_writes.lock() {
            writes.insert(path.to_path_buf(), at_ms);
        }
    }

    pub fn user_write_at(&self, path: &Path) -> i64 {
        self.user_writes.lock().ok().and_then(|writes| writes.get(path).copied()).unwrap_or(0)
    }

    /// Applies a verdict to the ledger. Returns true when the caller must restore the shadow copy.
    pub fn observe(
        &self,
        path: &Path,
        hash: &str,
        now_ms: i64,
        verdict: Verdict,
        shadow: Option<PathBuf>,
        size: u64,
        mtime_ns: i64,
    ) -> bool {
        let Ok(mut entries) = self.entries.lock() else { return false };
        let entry = entries.entry(path.to_path_buf()).or_default();
        match verdict {
            Verdict::Unchanged => false,
            Verdict::Baseline | Verdict::UserEdit | Verdict::Newer => {
                entry.remember(hash, now_ms, shadow, size, mtime_ns);
                false
            }
            // A rollback keeps the newest hash in `history` so a second identical push is still a
            // rollback, and refreshes nothing else.
            Verdict::Rollback => true,
        }
    }

    pub fn shadow_for(&self, path: &Path) -> Option<PathBuf> {
        self.entries.lock().ok()?.get(path)?.shadow.clone()
    }

    pub fn mark_scan(&self, at_ms: i64) {
        self.last_scan_ms.store(at_ms, Ordering::Relaxed);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// What one scan pass did. Returned to the UI so it can tell the user what was rescued.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Files whose old content was pushed back and replaced by the shadow copy.
    pub restored: Vec<String>,
    /// Files recorded for the first time, or accepted as a newer edit.
    pub recorded: u32,
    /// Files skipped because they are too large to shadow.
    pub skipped: u32,
}

/// Walks the given Drive roots once and records what should happen.
///
/// Deliberately synchronous and coarse: it runs on a blocking thread from a Tauri command, never on
/// the UI thread. Restores are only *planned* here — `PendingRestore` is applied by the caller
/// inside a Drive transaction, so the sync daemon learns about the write before it lands and
/// uploads it as a normal local change instead of treating it as an outside edit and minting a
/// conflict copy.
pub fn scan(ledger: &Ledger, roots: &[PathBuf], shadow_root: &Path) -> ScanPlan {
    let mut plan = ScanPlan::default();
    let at = now_ms();
    for root in roots {
        let mut stack = vec![root.clone()];
        while let Some(directory) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&directory) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(file_type) = entry.file_type() else { continue };
                if file_type.is_dir() {
                    // `.alwith-*` holds the app's own shadow copies; never descend into it.
                    if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(".alwith-")) {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                // `.yupcloud` placeholders are metadata, not documents: no content to rescue.
                if path.extension().and_then(|extension| extension.to_str()) == Some("yupcloud") {
                    continue;
                }
                // Conflict copies are sync artefacts, not deliverables. Watching them would keep
                // shadowing and "restoring" files the tree deliberately hides, so the guard stays
                // out of the resolver's way and lets the user decide what the copy is worth.
                if path.file_name().and_then(|name| name.to_str()).is_some_and(is_conflict_copy) {
                    continue;
                }
                // One `stat` decides most files: the daemon writes change both size and mtime, so a
                // pass over an idle Drive never reads content at all. This keeps a five-minute
                // guard from competing with the sync daemon for disk on a large project.
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|meta| meta.len()).unwrap_or(0);
                let mtime_ns = meta
                    .as_ref()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_nanos() as i64)
                    .unwrap_or(0);
                let known = {
                    let Ok(entries) = ledger.entries.lock() else { continue };
                    entries.get(&path).cloned()
                };
                if let Some(known) = &known
                    && known.mtime_ns == mtime_ns
                    && known.size == size
                {
                    continue;
                }
                let Some(hash) = hash_file(&path) else { continue };
                let shadow = if size <= SHADOW_SIZE_CAP {
                    let relative = path.strip_prefix(root).unwrap_or(&path);
                    Some(shadow_root.join(sanitize(relative)))
                } else {
                    plan.report.skipped += 1;
                    None
                };
                let verdict = decide(known.as_ref(), &hash, at, ledger.user_write_at(&path));
                if verdict == Verdict::Rollback {
                    if let Some(previous) = ledger.shadow_for(&path) {
                        plan.restores.push(PendingRestore { path, shadow: previous });
                        continue;
                    }
                    // Nothing to restore from (shadow missing): leave the file alone and keep the
                    // ledger untouched so the next identical push is still reported as a rollback.
                    continue;
                }
                if verdict != Verdict::Unchanged {
                    plan.report.recorded += 1;
                }
                let shadow_path = match &shadow {
                    Some(target) if verdict != Verdict::Unchanged => {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if std::fs::copy(&path, target).is_ok() {
                            Some(target.clone())
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                ledger.observe(&path, &hash, at, verdict, shadow_path, size, mtime_ns);
            }
        }
    }
    ledger.mark_scan(at);
    plan
}

/// One rollback the caller still has to write back. The ledger is left untouched until the write
/// succeeds, so a failed restore is retried on the next pass instead of being forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRestore {
    pub path: PathBuf,
    pub shadow: PathBuf,
}

#[derive(Debug, Default)]
pub struct ScanPlan {
    pub report: ScanReport,
    pub restores: Vec<PendingRestore>,
}

/// Copies the shadow bytes over the file. Test-only: production restores run inside
/// `DriveService::with_filesystem`, never as a bare write, so the daemon stays informed.
#[cfg(test)]
pub fn apply_restore(restore: &PendingRestore) -> bool {
    let Ok(bytes) = std::fs::read(&restore.shadow) else { return false };
    std::fs::write(&restore.path, bytes).is_ok()
}

/// The same marker the tree filter uses for `… （冲突副本 · user · 2026-11-06 0912）.md`.
fn is_conflict_copy(name: &str) -> bool {
    name.contains("冲突副本") || name.to_lowercase().contains("conflicted copy")
}


/// Shadow file names mirror the Drive tree, with the separators folded so one directory per file.
fn sanitize(relative: &Path) -> String {
    let mut name = String::new();
    for part in relative.components() {
        if !name.is_empty() {
            name.push_str("__");
        }
        name.push_str(&part.as_os_str().to_string_lossy());
    }
    name
}

/// Process-wide guard state. Registered once at startup; the scan command walks the Drive roots the
/// native service already exposes, so the guard never invents a root list of its own.
pub struct GuardState(pub std::sync::Arc<Ledger>);

#[tauri3_specta::command]
pub fn drive_guard_set_enabled(state: tauri::State<'_, GuardState>, enabled: bool) {
    state.0.set_enabled(enabled);
}

/// Called from the app's own file-write path. A save the user just made is trusted by the next
/// scan instead of being mistaken for a rollback.
#[tauri3_specta::command]
pub fn drive_guard_note_write(state: tauri::State<'_, GuardState>, path: String) {
    state.0.note_user_write(Path::new(&path), now_ms());
}

#[tauri3_specta::command]
pub fn drive_guard_enabled(state: tauri::State<'_, GuardState>) -> bool {
    state.0.enabled()
}

/// One scan pass over every indexed Drive root. Cheap when the switch is off: it returns at once.
///
/// Restores are written inside `DriveService::with_filesystem`, the same transaction every save
/// from the editor uses. That ordering matters: the daemon is told which path is about to change,
/// so the restored bytes are uploaded as a normal local edit instead of being seen as an outside
/// change and answered with a conflict copy.
#[tauri3_specta::command]
pub async fn drive_guard_scan(
    app: tauri::AppHandle,
    state: tauri::State<'_, GuardState>,
) -> Result<ScanReport, String> {
    use tauri::Emitter;
    use tauri::Manager;
    if !state.0.enabled() {
        return Ok(ScanReport::default());
    }
    let drive = app.state::<crate::drive::DriveState>();
    let service = drive.shared()?;
    let snapshot = service.snapshot();
    let roots: Vec<PathBuf> = snapshot
        .roots
        .iter()
        .filter(|root| !root.local_path.is_empty())
        .map(|root| PathBuf::from(&root.local_path))
        .filter(|root| root.is_dir())
        .collect();
    if roots.is_empty() {
        return Ok(ScanReport::default());
    }
    let shadow_root = app.path().app_data_dir().map_err(|error| error.to_string())?.join("drive-guard");
    std::fs::create_dir_all(&shadow_root).map_err(|error| error.to_string())?;
    // Hashing a whole Drive is blocking work; never run it on the async runtime's worker.
    let ledger = std::sync::Arc::clone(&state.0);
    let plan = tauri::async_runtime::spawn_blocking(move || scan(&ledger, &roots, &shadow_root))
        .await
        .map_err(|error| error.to_string())?;
    let mut report = plan.report;
    for restore in plan.restores {
        let path = restore.path.clone();
        let shadow = restore.shadow.clone();
        let write = async move {
            let bytes = std::fs::read(&shadow).map_err(|error| error.to_string())?;
            std::fs::write(&path, bytes).map_err(|error| error.to_string())
        };
        match service.with_filesystem(&[restore.path.clone()], &[], write).await {
            Ok(()) => {
                let restored = restore.path.to_string_lossy().to_string();
                report.restored.push(restored.clone());
                let _ = app.emit("drive:version-guard-restored", serde_json::json!({ "path": restored }));
            }
            // A failed restore stays in the ledger as a rollback, so the next pass retries it.
            Err(error) => log::warn!("drive guard: restore failed for {}: {error}", restore.path.display()),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(hash: &str) -> LedgerEntry {
        LedgerEntry {
            newest: hash.to_string(),
            history: VecDeque::from([hash.to_string()]),
            newest_at: 1_000,
            shadow: None,
            size: 0,
            mtime_ns: 0,
        }
    }

    #[test]
    fn first_sighting_is_a_baseline_not_a_rollback() {
        assert_eq!(decide(None, "a", 2_000, 0), Verdict::Baseline);
    }

    #[test]
    fn unchanged_content_costs_nothing() {
        let known = entry("b");
        assert_eq!(decide(Some(&known), "b", 2_000, 0), Verdict::Unchanged);
    }

    #[test]
    fn a_returning_old_version_is_a_rollback() {
        // The file was "a", then "b" (newest). The daemon now writes "a" again.
        let mut known = entry("a");
        known.remember("b", 1_500, None, 0, 0);
        assert_eq!(decide(Some(&known), "a", 2_000, 0), Verdict::Rollback);
    }

    #[test]
    fn unseen_content_is_treated_as_a_newer_edit() {
        let known = entry("a");
        assert_eq!(decide(Some(&known), "c", 2_000, 0), Verdict::Newer);
    }

    #[test]
    fn a_save_right_after_the_users_own_write_is_trusted() {
        let mut known = entry("a");
        known.remember("b", 1_500, None, 0, 0);
        // The user edited "a" back in deliberately two seconds ago: not a rollback.
        assert_eq!(decide(Some(&known), "a", 10_000, 8_000), Verdict::UserEdit);
    }

    #[test]
    fn the_user_grace_window_expires() {
        let mut known = entry("a");
        known.remember("b", 1_500, None, 0, 0);
        let late = 8_000 + USER_WRITE_GRACE_MS + 1;
        assert_eq!(decide(Some(&known), "a", late, 8_000), Verdict::Rollback);
    }

    #[test]
    fn history_is_bounded_and_moves_the_newest_to_the_back() {
        let mut known = LedgerEntry::default();
        for index in 0..(HISTORY_CAP + 10) {
            known.remember(&format!("h{index}"), 1_000 + index as i64, None, 0, 0);
        }
        assert_eq!(known.history.len(), HISTORY_CAP);
        assert_eq!(known.newest, format!("h{}", HISTORY_CAP + 9));
        // Re-seeing an old hash moves it to the back and drops nothing else out of order.
        known.remember("h20", 9_999, None, 0, 0);
        assert_eq!(known.history.back().map(String::as_str), Some("h20"));
        assert_eq!(known.history.len(), HISTORY_CAP);
    }

    #[test]
    fn the_ledger_reports_a_restore_only_for_a_rollback() {
        let ledger = Ledger::default();
        let path = Path::new("/drive/notes.md");
        assert!(!ledger.observe(path, "a", 1_000, Verdict::Baseline, None, 0, 0));
        assert!(!ledger.observe(path, "b", 2_000, Verdict::Newer, None, 0, 0));
        assert!(ledger.observe(path, "a", 3_000, Verdict::Rollback, None, 0, 0));
        // The newest stays "b": a repeated push of "a" is still a rollback, not a baseline.
        assert!(ledger.observe(path, "a", 4_000, Verdict::Rollback, None, 0, 0));
        assert_eq!(ledger.shadow_for(path), None);
    }

    #[test]
    fn a_user_write_is_recorded_and_read_back() {
        let ledger = Ledger::default();
        let path = Path::new("/drive/budget.csv");
        assert_eq!(ledger.user_write_at(path), 0);
        ledger.note_user_write(path, 42_000);
        assert_eq!(ledger.user_write_at(path), 42_000);
    }

    #[test]
    fn the_switch_defaults_to_off_and_round_trips() {
        let ledger = Ledger::default();
        assert!(!ledger.enabled(), "opt-in only: default Drive behaviour is untouched");
        ledger.set_enabled(true);
        assert!(ledger.enabled());
        ledger.set_enabled(false);
        assert!(!ledger.enabled());
    }

    #[test]
    fn a_scan_restores_the_newest_content_after_a_rollback() {
        // End-to-end on a real temp tree, mirroring the real incident: the file started as an old
        // draft, was edited into the newest version, and another device then pushed the old draft
        // back. The scan must put the newest bytes back on disk.
        let drive_root = tempfile::tempdir().unwrap();
        let shadow_root = tempfile::tempdir().unwrap();
        let doc = drive_root.path().join("notes.md");
        std::fs::write(&doc, b"old version").unwrap();

        let ledger = Ledger::default();
        ledger.set_enabled(true);
        let first = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert_eq!(first.report.recorded, 1);
        assert!(first.restores.is_empty());

        // The newest content arrives (a real edit, whether by this user or a newer client).
        std::fs::write(&doc, b"newest version").unwrap();
        let second = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert!(second.restores.is_empty(), "unseen content is a newer edit, never a rollback");

        // Another device pushes the old draft back through the closed daemon.
        std::fs::write(&doc, b"old version").unwrap();
        let third = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert_eq!(third.restores.len(), 1, "the known old content must be restored away");
        assert!(apply_restore(&third.restores[0]));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "newest version");
        // A restore is not recorded as a new edit: the newest hash stays what it was, so the same
        // rollback is still recognised on the next pass instead of looping.
        let fourth = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert!(fourth.restores.is_empty());
        assert_eq!(fourth.report.recorded, 0);
    }

    #[test]
    fn a_user_save_within_the_grace_window_is_never_restored() {
        let drive_root = tempfile::tempdir().unwrap();
        let shadow_root = tempfile::tempdir().unwrap();
        let doc = drive_root.path().join("budget.csv");
        std::fs::write(&doc, b"a,b,c").unwrap();

        let ledger = Ledger::default();
        ledger.set_enabled(true);
        scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        std::fs::write(&doc, b"a,b,c,d").unwrap();
        scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());

        // The user deliberately reverts to the earlier content and saves through the app.
        std::fs::write(&doc, b"a,b,c").unwrap();
        ledger.note_user_write(&doc, now_ms());
        let plan = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert!(plan.restores.is_empty(), "a user save must never be treated as a rollback");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "a,b,c");
    }

    #[test]
    fn the_guard_skips_its_own_shadow_tree_placeholders_and_conflict_copies() {
        let drive_root = tempfile::tempdir().unwrap();
        let shadow_root = tempfile::tempdir().unwrap();
        std::fs::write(drive_root.path().join("real.md"), b"x").unwrap();
        std::fs::write(drive_root.path().join("cloud.yupcloud"), b"{}").unwrap();
        std::fs::create_dir(drive_root.path().join(".alwith-shadow")).unwrap();
        std::fs::write(drive_root.path().join(".alwith-shadow/copy.md"), b"x").unwrap();
        // The tree hides these; the guard must not keep shadowing or "restoring" them either.
        std::fs::write(drive_root.path().join("报告（冲突副本 · leo · 2026-11-06 0912）.md"), b"conflict").unwrap();
        std::fs::write(drive_root.path().join("notes (conflicted copy 2026-11-06).md"), b"conflict").unwrap();

        let ledger = Ledger::default();
        ledger.set_enabled(true);
        let plan = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert_eq!(plan.report.recorded, 1, "only the real document is tracked");
    }

    #[test]
    fn a_missing_shadow_is_not_reported_as_a_restore() {
        let drive_root = tempfile::tempdir().unwrap();
        let shadow_root = tempfile::tempdir().unwrap();
        let doc = drive_root.path().join("report.md");
        std::fs::write(&doc, b"a").unwrap();

        let ledger = Ledger::default();
        ledger.set_enabled(true);
        scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        std::fs::write(&doc, b"b").unwrap();
        scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        // Simulate a lost shadow file, then let the old version come back.
        for entry in std::fs::read_dir(shadow_root.path()).unwrap().flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        std::fs::write(&doc, b"a").unwrap();
        let plan = scan(&ledger, &[drive_root.path().to_path_buf()], shadow_root.path());
        assert_eq!(plan.restores.len(), 1, "the rollback is still detected");
        assert!(!apply_restore(&plan.restores[0]), "without a shadow nothing is written");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "a", "the file is left untouched");
    }
}
