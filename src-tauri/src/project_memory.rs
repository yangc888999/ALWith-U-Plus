//! Per-project `memory.md`: created when a project chat starts, appended after every turn.
//!
//! Kept native (instead of the frontend fs adapter) because the project directory is outside
//! the asset protocol scope and the write must work even when the file tree has never opened.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const HEADER: &str = "# 项目记忆\n\n> 本文件由 ALWith L 自动维护：新建项目会话时创建，每轮对话结束后追加记录。\n\n";

fn memory_path(root: &str) -> Result<PathBuf, String> {
    let directory = Path::new(root);
    if !directory.is_dir() {
        return Err(format!("project directory does not exist: {root}"));
    }
    Ok(directory.join("memory.md"))
}

fn history_path(root: &str) -> Result<PathBuf, String> {
    let directory = Path::new(root);
    if !directory.is_dir() {
        return Err(format!("project directory does not exist: {root}"));
    }
    Ok(directory.join("history.md"))
}

fn ensure_file(path: &Path) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    fs::write(path, HEADER).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Creates `memory.md` when missing. Returns `true` when the file was created by this call.
#[tauri3_specta::command]
pub fn project_memory_ensure(root: String) -> Result<bool, String> {
    let path = memory_path(&root)?;
    ensure_file(&path)
}

/// The idempotency marker a turn block carries, when present.
///
/// New blocks use U+2063 (INVISIBLE SEPARATOR) around `alwith-turn:…`, so the marker never prints
/// in the editor or a rendered view; files written before that still carry `<!-- alwith-turn:… -->`.
fn turn_marker(block: &str) -> Option<&str> {
    const SEP: char = '\u{2063}';
    if let Some(start) = block.find(SEP) {
        let rest = &block[start..];
        let inner = &rest[SEP.len_utf8()..];
        if inner.starts_with("alwith-turn:") {
            if let Some(end) = inner.find(SEP) {
                return Some(&rest[..SEP.len_utf8() + end + SEP.len_utf8()]);
            }
        }
    }
    let start = block.find("<!-- alwith-turn:")?;
    let rest = &block[start..];
    let end = rest.find("-->")?;
    Some(&rest[..end + 3])
}

/// Archives the current `memory.md` verbatim into `<root>/history.md` before a compression.
///
/// The first snapshot creates `history.md`; every later one appends a new block. Each block is
/// marked with the local timestamp the frontend supplies and separated by `---` dividers, so the
/// file keeps every pre-compression state in chronological order. The timestamp comes from the
/// frontend because the native side cannot cheaply format the user's local timezone.
#[tauri3_specta::command]
pub fn project_memory_snapshot(root: String, timestamp: String) -> Result<(), String> {
    let path = memory_path(&root)?;
    ensure_file(&path)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let history = history_path(&root)?;
    let mut block = String::new();
    if history.exists() {
        block.push_str("\n---\n\n");
    }
    block.push_str(&format!("## 压缩前快照 · {timestamp}\n\n---\n\n"));
    block.push_str(content.trim_end());
    block.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&history)
        .map_err(|error| error.to_string())?;
    file.write_all(block.as_bytes()).map_err(|error| error.to_string())
}

/// Appends a Markdown block to `memory.md`, creating the file (and header) when missing.
///
/// The same turn can reach this command twice — the main window and the floating chat both observe
/// the conversation, and a relaunch can replay one already recorded. A block that is already in the
/// file is skipped, so a synced project is not written twice in a row for the same turn.
#[tauri3_specta::command]
pub fn project_memory_append(root: String, block: String) -> Result<(), String> {
    let path = memory_path(&root)?;
    ensure_file(&path)?;
    if let Some(marker) = turn_marker(&block) {
        if let Ok(existing) = fs::read_to_string(&path) {
            if existing.contains(marker) {
                return Ok(());
            }
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{}", block.trim_end()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("alwith-memory-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("temp project");
        directory
    }

    #[test]
    fn ensure_creates_once_and_never_rewrites_existing_memory() {
        let directory = temp_project("idempotent");
        let root = directory.to_string_lossy().to_string();
        assert!(project_memory_ensure(root.clone()).expect("first ensure creates"));
        let after_first = fs::read_to_string(directory.join("memory.md")).expect("memory exists");
        // A second visit to the same project must be a no-op.
        assert!(!project_memory_ensure(root.clone()).expect("second ensure is a no-op"));
        assert_eq!(
            fs::read_to_string(directory.join("memory.md")).expect("memory exists"),
            after_first
        );
        project_memory_append(root, "## 2026-01-01 00:00 · test\n\nhello".into()).expect("append");
        let content = fs::read_to_string(directory.join("memory.md")).expect("memory exists");
        assert!(content.starts_with("# 项目记忆"));
        assert!(content.contains("hello"));
        assert_eq!(content.matches("# 项目记忆").count(), 1, "header is written once only");
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn append_creates_the_file_for_a_project_that_never_called_ensure() {
        let directory = temp_project("append-first");
        let root = directory.to_string_lossy().to_string();
        project_memory_append(root, "first turn".into()).expect("append creates");
        let content = fs::read_to_string(directory.join("memory.md")).expect("memory exists");
        assert!(content.starts_with("# 项目记忆"));
        assert!(content.contains("first turn"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn snapshots_archive_memory_verbatim_with_timestamps_and_dividers() {
        let directory = temp_project("snapshot");
        let root = directory.to_string_lossy().to_string();
        project_memory_ensure(root.clone()).expect("ensure");
        project_memory_append(root.clone(), "## 2026-01-01 00:00 · chat\n\nhello world".into()).expect("append");
        project_memory_snapshot(root.clone(), "2026-01-02 09:00".into()).expect("first snapshot");
        let history = fs::read_to_string(directory.join("history.md")).expect("history exists");
        assert!(history.contains("## 压缩前快照 · 2026-01-02 09:00"));
        assert!(history.contains("hello world"));
        assert_eq!(history.matches("---").count(), 1);
        // A second snapshot keeps the first block intact and appends a separated new one.
        project_memory_append(root.clone(), "second turn".into()).expect("append");
        project_memory_snapshot(root.clone(), "2026-01-02 10:00".into()).expect("second snapshot");
        let history = fs::read_to_string(directory.join("history.md")).expect("history exists");
        assert!(history.contains("hello world"));
        assert!(history.contains("second turn"));
        assert!(history.contains("## 压缩前快照 · 2026-01-02 10:00"));
        assert_eq!(history.matches("---").count(), 3);
        // The live memory is never touched by archiving.
        let memory = fs::read_to_string(directory.join("memory.md")).expect("memory exists");
        assert!(memory.contains("hello world"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn snapshot_rejects_a_missing_project_directory() {
        let root = "/nonexistent/alwith-project-nowhere";
        assert!(project_memory_snapshot(root.into(), "2026-01-02 09:00".into()).is_err());
    }

    #[test]
    fn the_same_turn_is_never_appended_twice() {
        let directory = temp_project("idempotent-turn");
        let root = directory.to_string_lossy().to_string();
        let block = "## 2026-01-01 00:00 · chat\n\nhello\n\n<!-- alwith-turn:s1:m7 -->";
        project_memory_append(root.clone(), block.into()).expect("first append");
        project_memory_append(root, block.into()).expect("duplicate append is a no-op");
        let content = fs::read_to_string(directory.join("memory.md")).expect("memory exists");
        assert_eq!(content.matches("hello").count(), 1, "one turn, one block");
        assert_eq!(content.matches("alwith-turn:s1:m7").count(), 1);
        let _ = fs::remove_dir_all(&directory);
    }
}
