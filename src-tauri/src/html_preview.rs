//! Isolated HTML previews use revocable capabilities scoped to an authorized workspace.

use alwith_fs::FileSystem;
use base64::Engine;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::http::{Method, Request, Response};

#[derive(Clone)]
struct Preview {
    filesystem: FileSystem,
    root: PathBuf,
    document: PathBuf,
    source: String,
}

static PREVIEWS: OnceLock<Mutex<HashMap<String, Preview>>> = OnceLock::new();

fn previews() -> &'static Mutex<HashMap<String, Preview>> {
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(serde::Serialize, specta::Type)]
pub struct PreviewLocation {
    token: String,
    path: String,
}

#[tauri3_specta::command]
pub fn html_preview_open(
    window: tauri::WebviewWindow, root: PathBuf, path: PathBuf, source: String,
) -> Result<PreviewLocation, String> {
    if window.label() != "main" {
        return Err("HTML previews are limited to the main window".into());
    }
    let root = crate::workspace::authorize_preview_root(&root)?;
    let filesystem = FileSystem::new([root.clone()])?;
    let document = filesystem.authorize_path(&path)?;
    if !document.is_file() {
        return Err(format!("HTML preview must reference a file: {}", path.display()));
    }
    let relative = document.strip_prefix(&root).map_err(|error| error.to_string())?;
    let path = relative.to_str().ok_or("HTML preview path is not UTF-8")?.replace('\\', "/");
    let token = uuid::Uuid::new_v4().to_string();
    previews()
        .lock()
        .map_err(|error| error.to_string())?
        .insert(token.clone(), Preview { filesystem, root, document, source });
    Ok(PreviewLocation { token, path })
}

#[tauri3_specta::command]
pub fn html_preview_close(window: tauri::WebviewWindow, token: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("HTML previews are limited to the main window".into());
    }
    previews().lock().map_err(|error| error.to_string())?.remove(&token);
    Ok(())
}

fn decode_path(encoded: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut remaining = encoded.as_bytes();
    while let Some((&first, tail)) = remaining.split_first() {
        if first == b'%' {
            if tail.len() < 2 {
                return Err("Invalid URL escape".into());
            }
            let decoded = hex::decode(&tail[..2]).map_err(|error| error.to_string())?;
            bytes.push(decoded[0]);
            remaining = &tail[2..];
        } else {
            bytes.push(first);
            remaining = tail;
        }
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

/// Installed into the previewed document.
///
/// A preview renders inside an iframe, which is a document of its own: the parent page never sees
/// its `contextmenu` event, so the native English menu would open. This cancels that menu and asks
/// the parent to show the translated one, reporting where the pointer was inside the frame.
///
/// It is installed twice: as a same-origin script (`__alwith-menu.js`) so a document whose CSP only
/// allows `script-src 'self'` still gets it, and inline for documents that only allow inline
/// scripts. The guard makes whichever runs first win instead of opening the menu twice.
const PREVIEW_MENU_BRIDGE: &str = r#"
(function () {
  if (window.__alwithPreviewMenu === true) return;
  window.__alwithPreviewMenu = true;
  // The hosting page never sees events inside this frame, so right-click and text selection are
  // both forwarded: contextmenu opens the translated menu, selection drives the copy/quote pill.
  document.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    var text = '';
    try {
      var selection = window.getSelection && window.getSelection();
      if (selection) { text = String(selection).trim(); }
    } catch (error) {}
    try {
      window.parent.postMessage({
        source: 'alwith-preview',
        type: 'context-menu',
        text: text,
        x: event.clientX,
        y: event.clientY
      }, '*');
    } catch (error) {}
  }, true);
  var lastText = null;
  function reportSelection() {
    var text = '';
    var rect = null;
    try {
      var selection = window.getSelection && window.getSelection();
      if (selection && selection.rangeCount > 0) {
        text = String(selection).trim().slice(0, 20000);
        var box = selection.getRangeAt(0).getBoundingClientRect();
        rect = { left: box.left, top: box.top, bottom: box.bottom, width: box.width };
      }
    } catch (error) {}
    if (text === lastText) return;
    lastText = text;
    try {
      window.parent.postMessage({
        source: 'alwith-preview',
        type: 'selection',
        text: text,
        rect: rect
      }, '*');
    } catch (error) {}
  }
  document.addEventListener('mouseup', function (event) {
    if (event.button !== 0) return;
    setTimeout(reportSelection, 0);
  }, true);
  document.addEventListener('mousedown', function (event) {
    if (event.button !== 0) return;
    if (lastText !== '') { lastText = ''; try { window.parent.postMessage({ source: 'alwith-preview', type: 'selection', text: '', rect: null }, '*'); } catch (error) {} }
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') reportSelection();
  }, true);
  document.addEventListener('selectionchange', function () {
    if (window.getSelection && String(window.getSelection()).trim() === '') reportSelection();
  }, true);
})();
"#;

/// The resource name the injected script loads, scoped to the preview's capability token.
const PREVIEW_MENU_RESOURCE: &str = "__alwith-menu.js";

fn preview_menu_script(token: &str) -> String {
    format!(
        "<script src=\"/{token}/{PREVIEW_MENU_RESOURCE}\"></script><script>{PREVIEW_MENU_BRIDGE}</script>"
    )
}

/// Returns the document with the context-menu bridge installed.
///
/// The script runs as the very first thing in the document, wherever the content allows: installed
/// after `<head>` it still lost the race against a page that registered its own `contextmenu`
/// handler later, and a fragment with no head or body at all must not be left with the English
/// menu either.
fn inject_preview_script(html: &str, token: &str) -> Vec<u8> {
    // Lowercasing is ASCII-only, so the byte length — and therefore every byte index — still
    // lines up with the original string.
    let lowered = html.to_ascii_lowercase();
    let anchor = lowered.find("<head").map(|index| lowered[index..].find('>').map_or(index, |end| index + end + 1));
    let script = preview_menu_script(token);
    let mut out = String::with_capacity(html.len() + script.len());
    match anchor {
        Some(index) => {
            out.push_str(&html[..index]);
            out.push_str(&script);
            out.push_str(&html[index..]);
        }
        None => {
            out.push_str(&script);
            out.push_str(html);
        }
    }
    out.into_bytes()
}

async fn read_resource(preview: &Preview, encoded: &str, token: &str) -> Result<(Vec<u8>, &'static str), String> {
    if encoded == PREVIEW_MENU_RESOURCE {
        return Ok((PREVIEW_MENU_BRIDGE.as_bytes().to_vec(), "application/javascript; charset=utf-8"));
    }
    let decoded = decode_path(encoded)?;
    let relative = Path::new(&decoded);
    if decoded.contains(['\\', '\0']) || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("Invalid preview resource path".into());
    }
    // Canonical authorization prevents ../ and symlinks from escaping the granted workspace.
    let path = preview.filesystem.authorize_path(&preview.root.join(relative))?;
    let mime = mime_for_extension(path.extension().and_then(|extension| extension.to_str()));
    let bytes = if path == preview.document {
        inject_preview_script(&preview.source, token)
    } else {
        let encoded = preview.filesystem.read_base64(path).await?;
        base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|error| error.to_string())?
    };
    Ok((bytes, mime))
}

async fn protocol_response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result = async {
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return Err((405, "Preview resources support GET and HEAD only".to_owned()));
        }
        let (token, path) = request
            .uri()
            .path()
            .trim_start_matches('/')
            .split_once('/')
            .ok_or((400, "Missing HTML preview capability".to_owned()))?;
        let preview = previews()
            .lock()
            .map_err(|error| (500, error.to_string()))?
            .get(token)
            .cloned()
            .ok_or((403, "HTML preview capability is unavailable".to_owned()))?;
        read_resource(&preview, path, token).await.map_err(|error| (404, error))
    }
    .await;
    let (status, bytes, mime) = match result {
        Ok((bytes, mime)) => (200, bytes, mime),
        Err((status, error)) => (status, error.into_bytes(), "text/plain; charset=utf-8"),
    };
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store, no-cache, must-revalidate")
        .header("Pragma", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff")
        .body(if request.method() == Method::HEAD { Vec::new() } else { bytes })
        .expect("Static preview response headers must be valid")
}

pub fn handle_protocol<R: tauri::Runtime>(
    _context: tauri::UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move { responder.respond(protocol_response(request).await) });
}

fn mime_for_extension(extension: Option<&str>) -> &'static str {
    match extension.map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("xhtml") => "application/xhtml+xml",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs" | "cjs") => "application/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("txt" | "md" | "log" | "csv") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn resource(preview: &Preview, path: &str) -> Result<(Vec<u8>, &'static str), String> {
        tauri::async_runtime::block_on(read_resource(preview, path, "token"))
    }

    fn response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        tauri::async_runtime::block_on(protocol_response(request))
    }

    fn fixture() -> (tempfile::TempDir, Preview) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir(root.join("report")).unwrap();
        fs::write(root.join("report/index.html"), "disk contents").unwrap();
        fs::write(root.join("report/a b.css"), "body { color: red }").unwrap();
        fs::write(root.join("data.json"), r#"{"value":42}"#).unwrap();
        let preview = Preview { filesystem: FileSystem::new([root.clone()]).unwrap(), document: root.join("report/index.html"), root, source: "<a href='#section'>Anchor</a><form action='./result.html'></form><script>fetch('../data.json')</script>".into() };
        (directory, preview)
    }

    #[test]
    fn serves_html_with_the_context_menu_bridge_and_relative_resources_with_correct_mime() {
        let (_directory, preview) = fixture();
        let (html, mime) = resource(&preview, "report/index.html").unwrap();
        let served = String::from_utf8(html).unwrap();
        assert!(
            served.starts_with(&preview_menu_script("token")),
            "the bridge must run before the document"
        );
        assert!(served.contains(PREVIEW_MENU_RESOURCE));
        assert!(served.ends_with(&preview.source));
        assert_eq!(mime, "text/html; charset=utf-8");
        // The bridge is also served as its own script so a CSP that only allows 'self' still runs it.
        let (script, mime) = resource(&preview, PREVIEW_MENU_RESOURCE).unwrap();
        assert_eq!(script, PREVIEW_MENU_BRIDGE.as_bytes());
        assert_eq!(mime, "application/javascript; charset=utf-8");
        let (css, mime) = resource(&preview, "report/a%20b.css").unwrap();
        assert_eq!(css, b"body { color: red }");
        assert_eq!(mime, "text/css; charset=utf-8");
        let (json, mime) = resource(&preview, "data.json").unwrap();
        assert_eq!(json, br#"{"value":42}"#);
        assert_eq!(mime, "application/json; charset=utf-8");
    }

    #[test]
    fn rejects_absolute_traversal_and_invalid_paths() {
        let (_directory, preview) = fixture();
        for path in [
            "../secret",
            "%2e%2e/secret",
            "/etc/passwd",
            "%2Fetc/passwd",
            "report/../../secret",
            "C:%5Csecret",
            "report/%00",
            "report/%zz",
        ] {
            assert!(resource(&preview, path).is_err(), "unexpected access: {path}");
        }
    }

    #[test]
    fn capability_revocation_and_no_store_apply_to_protocol_requests() {
        let (_directory, preview) = fixture();
        let token = uuid::Uuid::new_v4().to_string();
        previews().lock().unwrap().insert(token.clone(), preview.clone());
        let uri = format!("preview-html://localhost/{token}/report/index.html");
        let result = response(Request::builder().uri(&uri).body(Vec::new()).unwrap());
        assert_eq!(result.status(), 200);
        let served = String::from_utf8(result.body().clone()).unwrap();
        assert!(served.ends_with(&preview.source));
        assert!(served.starts_with(&preview_menu_script(&token)));
        assert!(result.headers()["Cache-Control"].to_str().unwrap().contains("no-store"));
        let result = response(Request::builder().method("POST").uri(&uri).body(Vec::new()).unwrap());
        assert_eq!(result.status(), 405);
        previews().lock().unwrap().remove(&token);
        let result = response(Request::builder().uri(&uri).body(Vec::new()).unwrap());
        assert_eq!(result.status(), 403);
    }

    #[test]
    fn subsequent_asset_requests_read_saved_bytes() {
        let (_directory, preview) = fixture();
        assert_eq!(resource(&preview, "data.json").unwrap().0, br#"{"value":42}"#);
        fs::write(preview.root.join("data.json"), r#"{"value":99}"#).unwrap();
        assert_eq!(resource(&preview, "data.json").unwrap().0, br#"{"value":99}"#);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_outside_the_authorized_workspace() {
        let (_directory, preview) = fixture();
        let secret = tempfile::NamedTempFile::new().unwrap();
        fs::write(secret.path(), "secret").unwrap();
        std::os::unix::fs::symlink(secret.path(), preview.root.join("secret.txt")).unwrap();
        assert!(resource(&preview, "secret.txt").is_err());
    }
}
