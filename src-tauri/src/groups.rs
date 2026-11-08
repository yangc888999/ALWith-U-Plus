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

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GroupDirectory {
    /// The absolute path of the group's folder.
    pub directory: String,
    /// The absolute path of the group's document.
    pub document: String,
}

/// The folder every group lives in.
fn groups_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join("Documents")
        .join("ALWith")
        .join("groups"))
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
    if slug.is_empty() {
        "group".to_string()
    } else {
        slug
    }
}

fn starter_document(name: &str) -> String {
    format!(
        "# {name}\n\n## 这个群聊要解决的问题\n\n（写清楚背景、目标和边界。群聊里的每个角色都会读到这一段。）\n\n## 约束\n\n- \n\n## 参与者\n\n（由设置里的角色定义补充。）\n\n## 目录约定\n\n- `资料/` — 这次讨论要用的原始数据、口径、截图。\n- `产出/` — 讨论收敛后的方案、报告、SQL。\n\n## 群聊怎么用\n\n- 成员按设置里的顺序轮流发言，每人一次算一轮；总共跑「默认循环」设定的轮数。\n- 主持人（moderator）在每轮结束时按「讨论总结模板」输出结论，下一轮在结论上继续。\n- 用户随时可以直接发消息插话：已完成的发言保留，群聊从第 1 轮重新开始，跑完剩余轮次。\n- 成员只读本文件和 `资料/`，产出写到 `产出/`，不要改动别人的文件。\n"
    )
}

/// Creates (or reuses) the group's folder and writes the starter document into it.
#[tauri3_specta::command]
pub fn group_directory_create(name: String) -> Result<GroupDirectory, String> {
    let root = groups_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let directory = root.join(slug_of(&name));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    // A group is a project, so the folder is laid out like one: the group's own document at the
    // root, the material it argues from in 资料/, and what the discussion delivers in 产出/.
    for folder in ["资料", "产出"] {
        fs::create_dir_all(directory.join(folder)).map_err(|error| error.to_string())?;
    }
    let document = directory.join("group.md");
    if !document.exists() {
        fs::write(&document, starter_document(name.trim()))
            .map_err(|error| error.to_string())?;
    }
    Ok(GroupDirectory {
        directory: directory.to_string_lossy().to_string(),
        document: document.to_string_lossy().to_string(),
    })
}

/// Points a group at a folder the user picked, laying the group's own files out inside it.
///
/// A group used to be pinned to `~/Documents/ALWith/groups/<slug>`. A discussion about a real
/// project belongs in that project's folder — the data it argues from is already there — so the
/// directory is the user's to choose, and this only adds what the group needs (`资料/`, `产出/`,
/// and a `group.md` when there is not one yet). An existing `group.md` is never touched.
#[tauri3_specta::command]
pub fn group_directory_attach(path: String) -> Result<GroupDirectory, String> {
    let directory = expand_home(path.trim());
    if !directory.is_dir() {
        return Err("文件夹不存在".into());
    }
    for folder in ["资料", "产出"] {
        fs::create_dir_all(directory.join(folder)).map_err(|error| error.to_string())?;
    }
    let document = directory.join("group.md");
    if !document.exists() {
        let name = directory
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "群聊".to_string());
        fs::write(&document, starter_document(&name)).map_err(|error| error.to_string())?;
    }
    Ok(GroupDirectory {
        directory: directory.to_string_lossy().to_string(),
        document: document.to_string_lossy().to_string(),
    })
}

/// Native folder picker for the group's own directory.
#[tauri3_specta::command]
pub fn pick_group_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose folder with prompt "选择群聊目录")"#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
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
        let stem = source
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = source
            .extension()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
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

/// Writes a group's own document.
#[tauri3_specta::command]
pub fn group_document_write(document: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&document).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&document, content).map_err(|error| error.to_string())
}

/// Native file picker for a role definition: markdown or text files only.
#[tauri3_specta::command]
pub fn pick_role_document() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose file with prompt "选择角色定义文件" of type {"net.daringfireball.markdown", "public.plain-text", "public.text"})"#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
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
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn read_text_file_at(path: &str) -> Result<String, String> {
    let path = &expand_home(path);
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
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
    if let Ok(value) = std::env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value).join("skills"));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex").join("skills"))
}

/// The folder the app releases its bundled operator personas into: `$CODEX_HOME/rob_models`.
/// Same base as the skills folder, so a role and a skill live side by side.
pub fn rob_models_root() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value).join("rob_models"));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME is not set".to_string())?;
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
    let source = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("rob_models");
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
        std::process::Command::new("open")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
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
}
