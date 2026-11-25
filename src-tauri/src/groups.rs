//! Group workspaces: one directory per group, with the group's own document.
//!
//! A group is a project of its own: it owns a folder under `~/Documents/ALWith/groups/<slug>/`
//! and a `group.md` describing the topic, the goal and the constraints. The members read that
//! document instead of guessing from the conversation alone, so a group's context survives a
//! restart and can be edited outside the app.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Text files a role definition may point at. A role is instructions, not a binary blob.
const TEXT_SUFFIXES: [&str; 4] = ["md", "markdown", "txt", "text"];
/// A role definition longer than this is a document the app must not paste into a prompt.
const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// An index lists at most this many files per material folder; past it the rest is counted, not named.
const MAX_INDEX_FILES: usize = 200;
/// One folder index renders within this many characters, so several folders cannot swamp the doc.
const MAX_INDEX_CHARS: usize = 4000;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupDirectory {
    /// The absolute path of the group's folder.
    pub directory: String,
    /// The absolute path of the group's document.
    pub document: String,
}

/// One material folder rendered as a markdown section (heading, note, and path list).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupMaterialSection {
    pub markdown: String,
}

/// The tail of a file, cut on a character boundary so multi-byte text never breaks mid-glyph.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupTail {
    pub text: String,
    /// True when older content before the tail was skipped.
    pub truncated: bool,
}

/// The folder every group lives in.
fn groups_root() -> Result<PathBuf, String> {
    let home =
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join("Documents").join("ALWith").join("groups"))
}

/// A folder name that is safe to create and to show in a path.
fn slug_of(name: &str) -> String {
    let mut slug = String::new();
    for character in name.trim().chars() {
        if character.is_alphanumeric() || character == '-' || character == '_' {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "group".to_string() } else { slug }
}

/// The starter `group.md`.
///
/// The create dialog collects the question the room must answer and the analysis direction, so
/// they belong in the document every member reads — not only in the UI's saved config. Empty
/// fields keep the explanatory placeholder; a filled direction gets its own section.
fn starter_document(name: &str, topic: Option<&str>, focus: Option<&str>) -> String {
    let topic = topic.map(str::trim).filter(|value| !value.is_empty());
    let focus = focus.map(str::trim).filter(|value| !value.is_empty());
    let mut document = format!(
        "# {name}\n\n## 这个群聊要解决的问题\n\n{}\n\n",
        topic.unwrap_or("（写清楚背景、目标和边界。群聊里的每个角色都会读到这一段。）")
    );
    if let Some(focus) = focus {
        document.push_str(&format!("## 分析方向\n\n{focus}\n\n"));
    }
    document.push_str("## 约束\n\n- \n\n## 参与者\n\n（由设置里的角色定义补充。）\n\n## 目录约定\n\n- `资料/` — 这次讨论要用的原始数据、口径、截图。\n- `产出/` — 讨论收敛后的方案、报告、SQL。\n\n## 群聊怎么用\n\n- 成员按设置里的顺序轮流发言，每人一次算一轮；总共跑「默认循环」设定的轮数。\n- 主持人（moderator）在每轮结束时按「讨论总结模板」输出结论，下一轮在结论上继续。\n- 用户随时可以直接发消息插话：已完成的发言保留，群聊从第 1 轮重新开始，跑完剩余轮次。\n- 成员只读本文件和 `资料/`，产出写到 `产出/`，不要改动别人的文件。\n");
    document
}

/// Replaces the body of a `## heading` section, preserving everything before and after it.
/// Returns `None` when the heading is absent.
fn replace_section(document: &str, heading: &str, body: &str) -> Option<String> {
    let marker = format!("## {heading}");
    let start = document.find(&marker)?;
    let after_marker = start + marker.len();
    let rest = &document[after_marker..];
    let end = rest.find("\n## ").map(|offset| after_marker + offset).unwrap_or(document.len());
    let mut next = String::with_capacity(document.len() + body.len());
    next.push_str(&document[..start]);
    next.push_str(&marker);
    next.push_str("\n\n");
    next.push_str(body.trim());
    next.push('\n');
    next.push_str(&document[end..]);
    Some(next)
}

/// Inserts a `## heading` section before `## 约束` (or at the end when the template changed).
fn insert_section(document: &str, heading: &str, body: &str) -> String {
    let section = format!("## {heading}\n\n{}\n\n", body.trim());
    match document.find("## 约束") {
        Some(index) => format!("{}{}{}", &document[..index], section, &document[index..]),
        None => format!("{document}\n\n{section}"),
    }
}

/// Applies the dialog's topic/focus to an existing `group.md` without touching any other section.
///
/// Re-creating a meeting whose folder already exists used to leave the old starter text in place:
/// the directory command only wrote `group.md` when it was missing. The topic and direction the
/// reader just typed must land in the document in that case too, or the members never see them.
fn apply_topic_and_focus(document: &str, topic: Option<&str>, focus: Option<&str>) -> String {
    let mut next = document.to_string();
    if let Some(topic) = topic.map(str::trim).filter(|value| !value.is_empty()) {
        next = replace_section(&next, "这个群聊要解决的问题", topic).unwrap_or(next);
    }
    if let Some(focus) = focus.map(str::trim).filter(|value| !value.is_empty()) {
        next = replace_section(&next, "分析方向", focus).unwrap_or_else(|| insert_section(&next, "分析方向", focus));
    }
    next
}

/// Creates (or reuses) the group's folder and writes the starter document into it.
///
/// `parent` picks where the meeting lives: the folder is always `<parent>/<slug(name)>`, so naming
/// the meeting first and choosing the parent second still lands in a subfolder named after the
/// meeting — never directly inside the picked folder. Omitted = the default `~/Documents/ALWith/groups`.
#[tauri3_specta::command]
pub fn group_directory_create(
    name: String, parent: Option<String>, topic: Option<String>, focus: Option<String>,
) -> Result<GroupDirectory, String> {
    let root = match parent {
        Some(path) if !path.trim().is_empty() => expand_home(path.trim()),
        _ => groups_root()?,
    };
    if !root.is_absolute() {
        return Err("父文件夹必须是绝对路径".into());
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let directory = root.join(slug_of(&name));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    // A group is a project, so the folder is laid out like one: the group's own document at the
    // root, the material it argues from in 资料/, and what the discussion delivers in 产出/.
    for folder in ["资料", "产出"] {
        fs::create_dir_all(directory.join(folder)).map_err(|error| error.to_string())?;
    }
    let document = directory.join("group.md");
    if document.exists() {
        // An existing meeting keeps its document, but the topic/direction just submitted must be
        // reflected in the sections that drive the discussion.
        let current = fs::read_to_string(&document).map_err(|error| error.to_string())?;
        let updated = apply_topic_and_focus(&current, topic.as_deref(), focus.as_deref());
        if updated != current {
            fs::write(&document, updated).map_err(|error| error.to_string())?;
        }
    } else {
        fs::write(&document, starter_document(name.trim(), topic.as_deref(), focus.as_deref()))
            .map_err(|error| error.to_string())?;
    }
    Ok(GroupDirectory {
        directory: directory.to_string_lossy().to_string(),
        document: document.to_string_lossy().to_string(),
    })
}

/// Heals a meeting record whose directory points at a PARENT folder instead of the meeting's own
/// named subfolder.
///
/// The retired settings-page "attach" flow pinned a group straight onto the picked folder — which
/// is how a meeting ended up living in `groups/` itself while its conversations ran in
/// `groups/<会议名>/`. The panel then matched no session to the group (继续上一次 stayed grey) and
/// 新开一场 entered the parent. When `<directory>/<slug(name)>` exists on disk, that subfolder is
/// the meeting's real home: return it (creating only what is missing, never touching an existing
/// group.md). When it does not exist, return None and leave the record alone.
#[tauri3_specta::command]
pub fn group_directory_heal(name: String, directory: String) -> Result<Option<GroupDirectory>, String> {
    let parent = expand_home(directory.trim());
    if !parent.is_absolute() || !parent.is_dir() {
        return Ok(None);
    }
    let slug = slug_of(&name);
    let child = parent.join(&slug);
    // Already the meeting's own folder (or the slug would collide with the parent itself).
    if child == parent || !child.is_dir() {
        return Ok(None);
    }
    for folder in ["资料", "产出"] {
        fs::create_dir_all(child.join(folder)).map_err(|error| error.to_string())?;
    }
    let document = child.join("group.md");
    if !document.exists() {
        // The heal path only repairs a mis-pinned folder; it has no topic/focus in hand.
        fs::write(&document, starter_document(name.trim(), None, None)).map_err(|error| error.to_string())?;
    }
    Ok(Some(GroupDirectory {
        directory: child.to_string_lossy().to_string(),
        document: document.to_string_lossy().to_string(),
    }))
}

/// Native folder picker for the group's own directory.
#[tauri3_specta::command]
pub fn pick_group_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose folder with prompt "选择群聊目录")"#;
        let output =
            std::process::Command::new("osascript").args(["-e", script]).output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台请手动填写文件夹路径".into())
    }
}

/// Copies files dropped into a group chat into that group's 资料/ folder.
///
/// The group's material is what every member reads before speaking; a drag into the conversation
/// is the fastest way to hand it over. Files are copied, never moved, and the destination is the
/// group's own folder — the one the user chose for it.
#[tauri3_specta::command]
pub fn group_copy_materials(paths: Vec<String>, group_directory: String) -> Result<Vec<String>, String> {
    let directory = expand_home(&group_directory);
    if !directory.is_absolute() {
        return Err("群聊目录必须是绝对路径".into());
    }
    if !directory.is_dir() {
        return Err("群聊目录不存在".into());
    }
    let materials = directory.join("资料");
    fs::create_dir_all(&materials).map_err(|error| error.to_string())?;
    let mut saved: Vec<String> = Vec::new();
    for path in paths {
        let source = PathBuf::from(&path);
        if !source.is_file() {
            continue;
        }
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "资料文件".to_string());
        let stem = source.file_stem().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
        let ext = source.extension().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
        let mut target = materials.join(&name);
        let mut index = 1;
        while target.exists() {
            target = materials.join(if ext.is_empty() {
                format!("{stem}-{index}")
            } else {
                format!("{stem}-{index}.{ext}")
            });
            index += 1;
        }
        fs::copy(&source, &target).map_err(|error| error.to_string())?;
        saved.push(target.to_string_lossy().to_string());
    }
    Ok(saved)
}

/// Reads a group's own document.
#[tauri3_specta::command]
pub fn group_document_read(document: String) -> Result<String, String> {
    read_text_file_at(&document)
}

/// Walks one folder collecting text-file paths (relative, sorted), bounded by the index caps.
fn collect_index_files(root: &Path, cap: usize) -> Result<(Vec<String>, usize), String> {
    let mut found: Vec<String> = Vec::new();
    let mut overflow: usize = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                // Hidden folders (.git, .obsidian, …) are not meeting material.
                if name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let suffix =
                path.extension().and_then(|value| value.to_str()).map(|value| value.to_lowercase()).unwrap_or_default();
            if !TEXT_SUFFIXES.contains(&suffix.as_str()) {
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            if found.len() < cap {
                let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                found.push(relative);
            } else {
                overflow += 1;
            }
        }
    }
    found.sort();
    Ok((found, overflow))
}

/// Renders one material folder as a markdown section for the group document.
///
/// A material folder is referenced, never copied: members read the originals through
/// `read_text_file`, so the document carries only the index — names, sizes and the instruction to
/// read rather than guess. The caps keep a giant vault from swamping the 6000-char context budget.
#[tauri3_specta::command]
pub fn group_material_index(path: String) -> Result<GroupMaterialSection, String> {
    let directory = expand_home(path.trim());
    if !directory.is_absolute() {
        return Err("材料文件夹必须是绝对路径".into());
    }
    if !directory.is_dir() {
        return Err("材料文件夹不存在".into());
    }
    let (files, overflow) = collect_index_files(&directory, MAX_INDEX_FILES)?;
    let label = directory
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| directory.to_string_lossy().to_string());
    let mut lines: Vec<String> = vec![format!("### {}", label)];
    if files.is_empty() {
        lines.push(format!("（{} 下没有可读的文本文件（支持 md/txt）。）", directory.to_string_lossy()));
        return Ok(GroupMaterialSection { markdown: lines.join("\n") });
    }
    for file in &files {
        // The size guides reading order: a 4KB note is safe to read in full, a 250KB log is not.
        let size = fs::metadata(directory.join(file))
            .map(|metadata| {
                if metadata.len() >= 1024 * 1024 {
                    format!("，约 {} MB", metadata.len() / (1024 * 1024))
                } else if metadata.len() >= 1024 {
                    format!("，约 {} KB", metadata.len() / 1024)
                } else {
                    "，小于 1 KB".to_string()
                }
            })
            .unwrap_or_default();
        lines.push(format!("- {}{}", file, size));
    }
    if overflow > 0 {
        lines.push(format!("- …另有 {} 个文件未列出", overflow));
    }
    lines.push(format!(
        "\n（共 {} 个文件。引用材料时写明 `/{}/相对路径`。）",
        files.len(),
        directory.to_string_lossy()
    ));
    let mut markdown = lines.join("\n");
    // Character-safe budget cut: drop the listed lines from the end until it fits, keep the note.
    if markdown.chars().count() > MAX_INDEX_CHARS {
        let mut kept = files.clone();
        while kept.len() > 1 {
            kept.pop();
            let mut retried: Vec<String> = vec![format!("### {}", label)];
            for file in &kept {
                retried.push(format!("- {}", file));
            }
            retried.push(format!("- …另有 {} 个文件未列出", files.len() - kept.len() + overflow));
            retried.push(format!(
                "\n（共 {} 个文件。引用材料时写明 `/{}/相对路径`。）",
                files.len(),
                directory.to_string_lossy()
            ));
            markdown = retried.join("\n");
            if markdown.chars().count() <= MAX_INDEX_CHARS {
                break;
            }
        }
    }
    Ok(GroupMaterialSection { markdown })
}

/// Reads the last characters of a text file, whatever its size.
///
/// `group_document_read` caps at 256 KB and refuses more; the minutes tail comes off a `memory.md`
/// that grows with every round, so the tail reader must not share that cap. UTF-8 boundaries are
/// honoured so no glyph is cut in half.
#[tauri3_specta::command]
pub fn group_tail_text(path: String, max_chars: usize) -> Result<GroupTail, String> {
    let file = expand_home(&path);
    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("文件不存在".into());
    }
    // Read from the end window directly: memory.md stays small for months, but the cap must never
    // force a full-file read of a gigabyte log. 4 bytes per char is the worst-case UTF-8 width.
    let budget = max_chars.clamp(1, 200_000);
    let window = (budget as u64 * 4).min(metadata.len());
    let start = metadata.len() - window;
    let mut handle = fs::File::open(&file).map_err(|error| error.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    handle.seek(SeekFrom::Start(start)).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(window as usize);
    handle.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    // If the window started mid-character, the leading replacement char drops; its bytes belong to
    // a character whose front half we intentionally skipped.
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    while text.starts_with('\u{FFFD}') {
        text.remove(0);
    }
    let characters: Vec<char> = text.chars().collect();
    let truncated = start > 0 || characters.len() > budget;
    let kept: String = characters[characters.len().saturating_sub(budget)..].iter().collect();
    Ok(GroupTail { text: kept, truncated })
}

/// A save that fires before the read has finished used to flush an empty string over the real
/// document. Refuse to overwrite a document we could not have loaded in full, or to wipe an
/// existing one with empty content. A first write (the file does not exist yet) is always
/// allowed, so creating a group's document is never blocked.
fn guard_document_write(document: &Path, content: &str) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(document) else {
        return Ok(());
    };
    if !metadata.is_file() {
        return Ok(());
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("群文档超出可读取大小，拒绝覆盖".into());
    }
    if content.trim().is_empty() && metadata.len() > 0 {
        return Err("拒绝用空内容覆盖已有群文档".into());
    }
    Ok(())
}

/// Writes a group's own document.
#[tauri3_specta::command]
pub fn group_document_write(document: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&document).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    guard_document_write(Path::new(&document), &content)?;
    fs::write(&document, content).map_err(|error| error.to_string())
}

/// Native file picker for a role definition: markdown or text files only.
#[tauri3_specta::command]
pub fn pick_role_document() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose file with prompt "选择角色定义文件" of type {"net.daringfireball.markdown", "public.plain-text", "public.text"})"#;
        let output =
            std::process::Command::new("osascript").args(["-e", script]).output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台请手动填写文件路径".into())
    }
}

/// Reads a local text file: a role definition may be a markdown file anywhere on disk.
#[tauri3_specta::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    read_text_file_at(&path)
}

/// `~/…` in a stored role path, so a seeded default survives a home folder that differs.
pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(path)
}

fn read_text_file_at(path: &str) -> Result<String, String> {
    let path = &expand_home(path);
    let suffix =
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_lowercase()).unwrap_or_default();
    if !TEXT_SUFFIXES.contains(&suffix.as_str()) {
        return Err("只支持读取 markdown 或文本文件".into());
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("文件不存在".into());
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("文件太大，无法作为角色定义".into());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

/// The skills folder a role can point at: `$CODEX_HOME/skills`.
pub fn skills_root() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME")
        && !value.trim().is_empty()
    {
        return Ok(PathBuf::from(value).join("skills"));
    }
    let home =
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex").join("skills"))
}

/// The folder the app releases its bundled operator personas into: `$CODEX_HOME/rob_models`.
/// Same base as the skills folder, so a role and a skill live side by side.
pub fn rob_models_root() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME")
        && !value.trim().is_empty()
    {
        return Ok(PathBuf::from(value).join("rob_models"));
    }
    let home =
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex").join("rob_models"))
}

/// Recursively copy files that are missing at the target, creating folders as needed.
fn copy_missing(source: &Path, target: &Path, released: &mut usize) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name() else { continue };
        let destination = target.join(name);
        if path.is_dir() {
            copy_missing(&path, &destination, released)?;
        } else if !destination.exists() {
            fs::copy(&path, &destination).map_err(|error| error.to_string())?;
            *released += 1;
        }
    }
    Ok(())
}

/// Copy the bundled personas that are not on disk yet into `rob_models_root()`, one folder per bot.
///
/// Additive on purpose: an existing file is left untouched, so a persona the user deleted (or
/// edited) stays exactly that way, while one added by a later build still lands. Returns how many
/// files were written.
pub fn release_rob_models(app: &tauri::AppHandle) -> Result<usize, String> {
    use tauri::Manager;
    let source = app.path().resource_dir().map_err(|error| error.to_string())?.join("rob_models");
    if !source.is_dir() {
        return Ok(0);
    }
    let target = rob_models_root()?;
    let mut released = 0;
    copy_missing(&source, &target, &mut released)?;
    Ok(released)
}

/// Open the role library folder (the group-roles "打开角色库目录" action).
#[tauri3_specta::command]
pub fn rob_models_open_folder() -> Result<String, String> {
    let directory = rob_models_root()?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&directory).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&directory).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&directory).spawn().map_err(|error| error.to_string())?;
    }
    Ok(directory.to_string_lossy().to_string())
}

/// A bot folder is a plain path segment; reject anything that could escape the library root.
fn valid_bot(bot: &str) -> Result<String, String> {
    let trimmed = bot.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
    {
        return Err("invalid bot id".to_string());
    }
    Ok(trimmed.to_string())
}

/// One bot folder in the role library, ready to become a group role.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RobModelEntry {
    /// The folder name, which is also the bot id.
    pub bot: String,
    /// Absolute path of the persona markdown the role will point at.
    pub persona: String,
    /// Raw `config.json` (model / effort / moderator), or None when the bot ships without one.
    pub config: Option<String>,
}

/// Lists every bot in `rob_models` that carries a persona file.
///
/// This is what the group page's「导入内置机器人」reads: the library folder is the source of truth,
/// so a persona added by a later build (or dropped in by hand) can be imported without reinstalling.
/// A folder without a `skill-<bot>.md` is skipped — a role with no instructions is not a role.
#[tauri3_specta::command]
pub fn rob_models_list() -> Result<Vec<RobModelEntry>, String> {
    let root = rob_models_root()?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut bots = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
        let Ok(bot) = valid_bot(name) else { continue };
        let persona = path.join(format!("skill-{bot}.md"));
        if !persona.is_file() {
            continue;
        }
        let config = fs::read_to_string(path.join("config.json")).ok();
        bots.push(RobModelEntry { bot, persona: persona.to_string_lossy().to_string(), config });
    }
    bots.sort_by(|left, right| left.bot.cmp(&right.bot));
    Ok(bots)
}

/// Read one bot's `config.json` (model / effort / moderator). Missing file → `None`.
#[tauri3_specta::command]
pub fn rob_models_read_config(bot: String) -> Result<Option<String>, String> {
    let path = rob_models_root()?.join(valid_bot(&bot)?).join("config.json");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Write one bot's `config.json`, keeping that bot's settings next to its persona.
#[tauri3_specta::command]
pub fn rob_models_write_config(bot: String, config: String) -> Result<(), String> {
    let directory = rob_models_root()?.join(valid_bot(&bot)?);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join("config.json"), config).map_err(|error| error.to_string())
}

/// Resolves a skill id to its `SKILL.md`. Skills are directories, so the id is validated against
/// path traversal before it is joined onto the skills folder.
#[tauri3_specta::command]
pub fn skill_document_read(id: String) -> Result<String, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id == "." || id == ".." {
        return Err("Invalid skill id".into());
    }
    let path = skills_root()?.join(&id).join("SKILL.md");
    read_text_file_at(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_create_lands_in_a_named_subfolder_of_the_chosen_parent() {
        let parent = std::env::temp_dir().join(format!("alwith-group-parent-{}", std::process::id()));
        let created =
            group_directory_create("交易北极星指标".into(), Some(parent.to_string_lossy().to_string()), None, None)
                .unwrap();
        let directory = PathBuf::from(&created.directory);
        assert_eq!(directory.parent().unwrap(), parent.as_path());
        assert_eq!(directory.file_name().unwrap().to_string_lossy(), "交易北极星指标");
        assert!(directory.join("group.md").is_file());
        assert!(directory.join("资料").is_dir());
        // Re-creating with the same name reuses the folder instead of erroring or suffixing.
        let again =
            group_directory_create("交易北极星指标".into(), Some(parent.to_string_lossy().to_string()), None, None)
                .unwrap();
        assert_eq!(again.directory, created.directory);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn directory_create_rejects_a_relative_parent() {
        assert!(group_directory_create("会".into(), Some("relative/path".into()), None, None).is_err());
    }

    #[test]
    fn directory_create_writes_topic_and_focus_into_the_document() {
        let parent = std::env::temp_dir().join(format!("alwith-group-topic-{}", std::process::id()));
        let created = group_directory_create(
            "定价会".into(),
            Some(parent.to_string_lossy().to_string()),
            Some("余额下滑到底是谁的锅？".into()),
            Some("看补贴退坡后的毛利弹性，重点评估 BNPL 渗透率。".into()),
        )
        .unwrap();
        let text = fs::read_to_string(&created.document).unwrap();
        assert!(text.contains("余额下滑到底是谁的锅？"));
        assert!(text.contains("## 分析方向"));
        assert!(text.contains("看补贴退坡后的毛利弹性，重点评估 BNPL 渗透率。"));
        assert!(!text.contains("（写清楚背景、目标和边界"));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn re_creating_with_a_new_topic_updates_the_existing_document() {
        let parent = std::env::temp_dir().join(format!("alwith-group-retopic-{}", std::process::id()));
        group_directory_create("续会".into(), Some(parent.to_string_lossy().to_string()), Some("旧议题".into()), None)
            .unwrap();
        let again = group_directory_create(
            "续会".into(),
            Some(parent.to_string_lossy().to_string()),
            Some("新议题".into()),
            Some("新方向".into()),
        )
        .unwrap();
        let text = fs::read_to_string(&again.document).unwrap();
        assert!(text.contains("新议题"));
        assert!(!text.contains("旧议题"));
        assert!(text.contains("## 分析方向"));
        assert!(text.contains("新方向"));
        // Sections the dialog does not own survive the targeted update.
        assert!(text.contains("## 群聊怎么用"));
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn heal_moves_a_parent_pinned_record_into_the_named_subfolder() {
        let parent = std::env::temp_dir().join(format!("alwith-group-heal-{}", std::process::id()));
        let child = parent.join("交易北极星指标");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("group.md"), "# 已有的会议文档").unwrap();
        let healed = group_directory_heal("交易北极星指标".into(), parent.to_string_lossy().to_string())
            .unwrap()
            .expect("the named subfolder exists, so the record heals");
        assert_eq!(healed.directory, child.to_string_lossy().to_string());
        assert!(child.join("资料").is_dir());
        assert!(child.join("产出").is_dir());
        // An existing document is never overwritten by the heal.
        assert_eq!(fs::read_to_string(child.join("group.md")).unwrap(), "# 已有的会议文档");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn heal_leaves_records_without_a_named_subfolder_alone() {
        let parent = std::env::temp_dir().join(format!("alwith-group-heal-none-{}", std::process::id()));
        fs::create_dir_all(&parent).unwrap();
        // No `<parent>/<slug>` on disk: nothing to heal into.
        assert!(group_directory_heal("没有目录的会".into(), parent.to_string_lossy().to_string()).unwrap().is_none());
        // A record already pointing at its own folder is not "healed" into a nested copy.
        let own = parent.join("自己的会");
        fs::create_dir_all(&own).unwrap();
        assert!(group_directory_heal("自己的会".into(), own.to_string_lossy().to_string()).unwrap().is_none());
        // Missing / relative directories are a no-op, not an error.
        assert!(group_directory_heal("会".into(), "/no/such/folder-at-all".into()).unwrap().is_none());
        assert!(group_directory_heal("会".into(), "relative/path".into()).unwrap().is_none());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn slug_keeps_readable_names() {
        assert_eq!(slug_of("支付告警 方案"), "支付告警-方案");
        assert_eq!(slug_of("  ///  "), "group");
        assert_eq!(slug_of("a/b"), "a-b");
    }

    #[test]
    fn text_files_only() {
        let path = std::env::temp_dir().join("alwith-role-test.png");
        fs::write(&path, b"not text").unwrap();
        assert!(read_text_file_at(&path.to_string_lossy()).is_err());
        let _ = fs::remove_file(&path);
    }

    /// A unique temp folder per fixture so parallel test runs never collide.
    fn temp_case(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("alwith-material-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn material_index_lists_text_files_sorted_with_relative_paths() {
        let root = temp_case("sorted");
        fs::write(root.join("b.md"), "x").unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        fs::write(root.join("image.png"), "x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/ignored.md"), "x").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/note.md"), "x").unwrap();
        let section = group_material_index(root.to_string_lossy().to_string()).unwrap();
        assert!(section.markdown.contains("- a.txt"));
        assert!(section.markdown.contains("- b.md"));
        assert!(section.markdown.contains("- sub/note.md"));
        assert!(!section.markdown.contains("image.png"));
        assert!(!section.markdown.contains("ignored.md"));
        assert!(section.markdown.contains("共 3 个文件"));
        // Order is the sorted list, not the readdir order.
        let a = section.markdown.find("a.txt").unwrap();
        let b = section.markdown.find("b.md").unwrap();
        let sub = section.markdown.find("sub/note.md").unwrap();
        assert!(a < b && b < sub);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn material_index_rejects_missing_and_relative_folders() {
        assert!(group_material_index("/no/such/folder-at-all".into()).is_err());
        assert!(group_material_index("relative/path".into()).is_err());
    }

    #[test]
    fn material_index_empty_folder_says_so() {
        let root = temp_case("empty");
        fs::write(root.join("only.png"), "x").unwrap();
        let section = group_material_index(root.to_string_lossy().to_string()).unwrap();
        assert!(section.markdown.contains("没有可读的文本文件"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn material_index_counts_overflow_past_the_cap() {
        let root = temp_case("cap");
        for index in 0..(MAX_INDEX_FILES + 5) {
            fs::write(root.join(format!("f{:04}.md", index)), "x").unwrap();
        }
        let section = group_material_index(root.to_string_lossy().to_string()).unwrap();
        // The cap overflows by 5, and the char budget may fold more lines into the note; either
        // way the section must state a "not listed" count and stay inside the budget.
        assert!(section.markdown.contains("个文件未列出"));
        // The budget cut keeps the heading and the reference note, so the section stays usable.
        assert!(section.markdown.chars().count() <= MAX_INDEX_CHARS);
        assert!(section.markdown.contains("###"));
        assert!(section.markdown.contains("引用材料时写明"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tail_text_returns_whole_small_file_and_cut_tail_for_large() {
        let root = temp_case("tail");
        let small = root.join("small.md");
        fs::write(&small, "# 纪要\n第一行\n第二行").unwrap();
        let got = group_tail_text(small.to_string_lossy().to_string(), 500).unwrap();
        assert_eq!(got.text, "# 纪要\n第一行\n第二行");
        assert!(!got.truncated);
        // Chinese content near the boundary must not cut a character in half.
        let big = root.join("big.md");
        fs::write(&big, format!("{}\n结尾一二三", "早".repeat(5000))).unwrap();
        let got = group_tail_text(big.to_string_lossy().to_string(), 5).unwrap();
        assert_eq!(got.text, "结尾一二三");
        assert!(got.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn document_write_guard_allows_first_write_and_rejects_destructive_ones() {
        let path = std::env::temp_dir().join("alwith-group-document-guard.md");
        let _ = fs::remove_file(&path);
        // A document that does not exist yet is always writable, empty content included.
        assert!(guard_document_write(&path, "").is_ok());
        fs::write(&path, "# real document").unwrap();
        assert!(guard_document_write(&path, "edited").is_ok());
        assert!(guard_document_write(&path, "   ").is_err());
        fs::write(&path, "x".repeat(MAX_TEXT_BYTES as usize + 1)).unwrap();
        assert!(guard_document_write(&path, "small").is_err());
        let _ = fs::remove_file(&path);
    }
}
