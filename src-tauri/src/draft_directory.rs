use std::path::{Path, PathBuf};
use tauri::Manager;

fn resolve_directory(cwd: Option<PathBuf>, documents: &Path) -> Result<PathBuf, String> {
    let directory = match cwd {
        Some(directory) => directory,
        None => {
            let directory = documents.join("ALwith");
            std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            directory
        }
    };
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(format!("Project directory is unavailable: {}", directory.display()));
    }
    // Canonicalize so the session's cwd matches the workspace root produced by `workspace_open`
    // (which also canonicalizes). Without this, a freshly created project's first session had a raw
    // path that differed from the previewed document's root whenever the path carried a symlink or
    // `.`/`..` segments, so the chat silently dropped the document reference.
    let canonical = directory.canonicalize().map_err(|error| format!("Project directory is unavailable: {error}"));
    Ok(canonical.unwrap_or(directory))
}

#[tauri3_specta::command]
pub async fn draft_directory(app: tauri::AppHandle, cwd: Option<PathBuf>) -> Result<String, String> {
    let documents = app.path().document_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        resolve_directory(cwd, &documents)?
            .into_os_string()
            .into_string()
            .map_err(|_| "Project directory is not valid UTF-8".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_use_creates_a_workspace_but_never_recreates_a_missing_project() {
        let root = tempfile::tempdir().unwrap();
        let documents = root.path();
        let default = resolve_directory(None, documents).unwrap();
        assert!(default.is_dir());
        assert_eq!(default, documents.join("ALwith").canonicalize().unwrap());
        assert_eq!(resolve_directory(None, documents).unwrap(), default);
        let missing = documents.join("removed-project");
        assert!(resolve_directory(Some(missing.clone()), documents).is_err());
        assert!(!missing.exists());
        assert_eq!(
            resolve_directory(Some(documents.to_owned()), documents).unwrap(),
            documents.canonicalize().unwrap()
        );
    }
}
