//! Codex skills management for the settings window.
//!
//! Skills live in `$CODEX_HOME/skills/<id>/SKILL.md` (the same folder WorkBuddy and the
//! ChatGPT desktop app use). Codex discovers whatever sits there on startup, so "disabled" is
//! implemented by moving the skill's directory into `$CODEX_HOME/skills-disabled/` — the engine
//! then simply does not see it, and re-enabling moves it back. Entries under `.system/` are the
//! engine's own skills and stay read-only.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// Directory name (also the stable id used for enable/disable).
    pub id: String,
    /// `name:` from the frontmatter, falling back to the directory name.
    pub name: String,
    /// First non-empty line of `description:`.
    pub description: String,
    /// Lives under `.system/`: built in by the engine, not toggleable.
    pub system: bool,
    pub enabled: bool,
    pub path: String,
}

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex"))
}

fn skills_dir() -> Result<PathBuf, String> {
    Ok(codex_home()?.join("skills"))
}

fn disabled_dir() -> Result<PathBuf, String> {
    Ok(codex_home()?.join("skills-disabled"))
}

/// Reads `name` and `description` out of a SKILL.md frontmatter block.
///
/// Hand-rolled on purpose: a full YAML parser is a heavyweight dependency for two scalar fields.
/// Multi-line `description: |` blocks are folded into one line (the UI shows a single line).
fn parse_frontmatter(markdown: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut lines = markdown.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut current: Option<&str> = None;
    let mut block: Vec<String> = Vec::new();
    let flush = |key: Option<&str>, block: &mut Vec<String>, name: &mut Option<String>, description: &mut Option<String>| {
        if block.is_empty() {
            return;
        }
        let joined = block.join(" ").trim().to_string();
        match key {
            Some("name") if !joined.is_empty() => *name = Some(joined),
            Some("description") if !joined.is_empty() => *description = Some(joined),
            _ => {}
        }
        block.clear();
    };
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            flush(current, &mut block, &mut name, &mut description);
            current = Some("name");
            block.push(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("description:") {
            flush(current, &mut block, &mut name, &mut description);
            current = Some("description");
            let trimmed = rest.trim();
            if trimmed != "|" && trimmed != ">" && !trimmed.is_empty() {
                block.push(trimmed.to_string());
            }
        } else if current.is_some() && (line.starts_with(' ') || line.starts_with('\t')) {
            // Continuation of the current block scalar.
            block.push(line.trim().to_string());
        } else if !line.trim().is_empty() {
            // Any other top-level key ends the previous block.
            flush(current, &mut block, &mut name, &mut description);
            current = None;
        }
    }
    flush(current, &mut block, &mut name, &mut description);
    (name, description)
}

fn entry_for(id: &str, dir: &Path, system: bool, enabled: bool) -> SkillEntry {
    let markdown = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
    let (name, description) = parse_frontmatter(&markdown);
    SkillEntry {
        id: id.to_string(),
        name: name.unwrap_or_else(|| id.to_string()),
        description: description.unwrap_or_default(),
        system,
        enabled,
        path: dir.to_string_lossy().to_string(),
    }
}

fn scan(dir: &Path, system: bool, enabled: bool, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else { continue };
        if id.starts_with('.') && id != ".system" {
            continue;
        }
        if system {
            // `.system/<skill>` holds the built-in skills themselves.
            if path.join("SKILL.md").is_file() {
                out.push(entry_for(id, &path, true, true));
            }
            continue;
        }
        if id == ".system" {
            scan(&path, true, true, out);
            continue;
        }
        if path.join("SKILL.md").is_file() {
            out.push(entry_for(id, &path, false, enabled));
        }
    }
}

#[tauri3_specta::command]
pub fn skills_list() -> Result<Vec<SkillEntry>, String> {
    let mut entries = Vec::new();
    scan(&skills_dir()?, false, true, &mut entries);
    scan(&disabled_dir()?, false, false, &mut entries);
    // Enabled user skills first, then disabled ones, then the engine's built-ins.
    entries.sort_by(|a, b| {
        (a.system, !a.enabled, a.name.to_lowercase()).cmp(&(b.system, !b.enabled, b.name.to_lowercase()))
    });
    Ok(entries)
}

fn move_skill(id: &str, from: &Path, to: &Path) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id == "." || id == ".." {
        return Err("Invalid skill id".into());
    }
    let source = from.join(id);
    if !source.join("SKILL.md").is_file() {
        return Err(format!("No SKILL.md in {}", source.display()));
    }
    std::fs::create_dir_all(to).map_err(|error| error.to_string())?;
    let target = to.join(id);
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    std::fs::rename(&source, &target).map_err(|error| format!("move failed: {error}"))
}

#[tauri3_specta::command]
pub fn skills_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let skills = skills_dir()?;
    let disabled = disabled_dir()?;
    if enabled {
        move_skill(&id, &disabled, &skills)
    } else {
        move_skill(&id, &skills, &disabled)
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let entries = std::fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().ok_or("entry without name")?;
        let to = target.join(name);
        if path.is_dir() {
            copy_tree(&path, &to)?;
        } else {
            std::fs::copy(&path, &to).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Installs a skill from a local directory: it must contain SKILL.md.
#[tauri3_specta::command]
pub fn skills_install(source: String) -> Result<SkillEntry, String> {
    let source_dir = PathBuf::from(&source);
    if !source_dir.join("SKILL.md").is_file() {
        return Err("所选目录里没有 SKILL.md，不是技能目录".into());
    }
    let markdown = std::fs::read_to_string(source_dir.join("SKILL.md")).map_err(|error| error.to_string())?;
    let (name, _) = parse_frontmatter(&markdown);
    let id = name
        .as_deref()
        .map(|value| value.trim().replace([' ', '/', '\\'], "-").to_lowercase())
        .filter(|value| !value.is_empty())
        .or_else(|| source_dir.file_name().and_then(|name| name.to_str()).map(str::to_string))
        .ok_or("技能目录没有名字")?;
    let target = skills_dir()?.join(&id);
    if target.exists() {
        return Err(format!("技能 {id} 已存在，先移除或改名再安装"));
    }
    copy_tree(&source_dir, &target)?;
    Ok(entry_for(&id, &target, false, true))
}


/// The directory temporary "chat" sessions live in: the app's default project-less folder.
///
/// module-chat treats `~/Documents/Codex` (and `~/Documents/ALwith`) as quick-chat directories,
/// so a new chat created here belongs to the "会话" section instead of any project.
#[tauri3_specta::command]
pub fn quick_chat_directory() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME is not set".to_string())?;
    let directory = std::path::PathBuf::from(home).join("Documents").join("Codex");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().to_string())
}

/// Native folder picker for "new project": the chosen directory becomes a project.
#[tauri3_specta::command]
pub fn pick_project_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose folder with prompt "选择项目目录")"#;
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
        Err("当前平台请手动选择项目目录".into())
    }
}


/// Deletes a user skill's directory (enabled or disabled). Engine built-ins stay read-only.
///
/// Deletion is irreversible, so the id is validated against path traversal and the directory
/// must actually look like a skill (contains SKILL.md).
#[tauri3_specta::command]
pub fn skills_uninstall(id: String) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id == "."
        || id == ".."
        || id.starts_with('.')
    {
        return Err("Invalid skill id".into());
    }
    for directory in [skills_dir()?, disabled_dir()?] {
        let target = directory.join(&id);
        if target.join("SKILL.md").is_file() {
            return std::fs::remove_dir_all(&target).map_err(|error| format!("remove failed: {error}"));
        }
    }
    Err("Skill not found (built-in skills cannot be removed)".into())
}

/// Opens the skills folder in the system file manager.
#[tauri3_specta::command]
pub fn skills_open_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = skills_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&dir).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn().map_err(|error| error.to_string())?;
    }
    let _ = app;
    Ok(dir.to_string_lossy().to_string())
}

/// Native folder picker for "install from a local directory".
#[tauri3_specta::command]
pub fn skills_pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let _ = app;
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose folder with prompt "选择技能目录（包含 SKILL.md）")"#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            // User cancelled: osascript exits non-zero with "User canceled."
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台请手动输入技能目录路径".into())
    }
}

/// The global prompt lives next to the skills so the user can edit it in the same folder.
const GLOBAL_PROMPT_FILE: &str = "ALWith.md";
const GLOBAL_PROMPT_MAX_BYTES: usize = 256 * 1024;
/// Starter for a fresh install. Kept short on purpose: the user replaces the placeholders.
const DEFAULT_GLOBAL_PROMPT: &str = r#"# ALWith 全局工作上下文

> 这个文件会在每个新项目 / 会话的第一句之前静默注入 system prompt，不会出现在聊天记录里。
> 把你的长期约定、业务背景和输出规范写在这里；保存后，下一个新建会话生效。

## 我的角色

你是我的长期协作伙伴。默认从这些视角综合思考：

- 业务负责人
- 数据分析师
- 战略顾问

## 业务背景

- 市场：
- 公司 / 产品：
- 我负责的业务：

## 核心约定

- 结论先行：先给判断，再给依据。
- 分析归到根因，不要头疼医头。
- 不确定的事实明确说「不确定」，不要编造。
- 数字必须能回溯到来源；没有数据时用占位符并标注「待确认」。
- 每次聊天完成后，无论用户是否正在查看该对话窗口，都必须把本次聊天记录同步到对话对应项目文件夹的 memory.md（该文件夹没有 memory.md 就新建）。同步格式固定：第一行「时间戳 + 标题（不超过 15 个字，说清本次对接事项）」；第二行「用户：问题原文」；第三行「助手：回答逻辑化整理」。开始新对话时先检查历史是否漏同步，漏了就在最前面补写。

## 输出规范

- 默认中文，结构清晰。
- 长报告：结论先行 + 图表 / 表格 + 备份表。
- 文档命名：主题_日期_版本号.格式。
"#;

fn read_prompt_file(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_prompt_file(directory: &Path, content: &str) -> Result<(), String> {
    if content.len() > GLOBAL_PROMPT_MAX_BYTES {
        return Err(format!(
            "ALWith.md is too large (max {} bytes)",
            GLOBAL_PROMPT_MAX_BYTES
        ));
    }
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(GLOBAL_PROMPT_FILE), content).map_err(|error| error.to_string())
}

/// Reads `<CODEX_HOME>/skills/ALWith.md`. A fresh install gets the starter file; an existing
/// file is never overwritten (an intentionally emptied file stays empty).
fn ensure_prompt_file(path: &Path) -> Result<String, String> {
    if path.exists() {
        return read_prompt_file(path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, DEFAULT_GLOBAL_PROMPT).map_err(|error| error.to_string())?;
    Ok(DEFAULT_GLOBAL_PROMPT.to_string())
}

/// Reads `<CODEX_HOME>/skills/ALWith.md`, creating the starter when it is missing.
#[tauri3_specta::command]
pub fn global_prompt_read() -> Result<String, String> {
    ensure_prompt_file(&skills_dir()?.join(GLOBAL_PROMPT_FILE))
}

/// Writes `<CODEX_HOME>/skills/ALWith.md`, creating the skills directory when needed.
#[tauri3_specta::command]
pub fn global_prompt_write(content: String) -> Result<(), String> {
    write_prompt_file(&skills_dir()?, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_simple_scalars() {
        let markdown = "---\nname: yup-kb\ndescription: 公司知识库接入\nallowed-tools:\n  - Bash\n---\n\n# body";
        let (name, description) = parse_frontmatter(markdown);
        assert_eq!(name.as_deref(), Some("yup-kb"));
        assert_eq!(description.as_deref(), Some("公司知识库接入"));
    }

    #[test]
    fn frontmatter_folds_block_description() {
        let markdown = "---\nname: demo\ndescription: |\n  第一行\n  第二行\n---\n";
        let (name, description) = parse_frontmatter(markdown);
        assert_eq!(name.as_deref(), Some("demo"));
        assert_eq!(description.as_deref(), Some("第一行 第二行"));
    }

    #[test]
    fn frontmatter_absent_returns_none() {
        assert_eq!(parse_frontmatter("# just markdown"), (None, None));
    }
}

#[cfg(test)]
mod global_prompt_tests {
    use super::*;

    #[test]
    fn missing_prompt_reads_empty_and_write_round_trips() {
        let root = std::env::temp_dir().join(format!("alwith-global-prompt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join(GLOBAL_PROMPT_FILE);
        assert_eq!(read_prompt_file(&path).unwrap(), "");
        write_prompt_file(&root, "# ALWith\n\n- be concise").unwrap();
        assert_eq!(read_prompt_file(&path).unwrap(), "# ALWith\n\n- be concise");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_prompt_is_seeded_once_and_never_overwritten() {
        let root = std::env::temp_dir().join(format!("alwith-global-prompt-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join(GLOBAL_PROMPT_FILE);
        let seeded = ensure_prompt_file(&path).unwrap();
        assert!(seeded.contains("ALWith 全局工作上下文"));
        assert!(path.exists());
        write_prompt_file(&root, "CUSTOM").unwrap();
        assert_eq!(ensure_prompt_file(&path).unwrap(), "CUSTOM");
        let _ = fs::remove_dir_all(&root);
    }
}
