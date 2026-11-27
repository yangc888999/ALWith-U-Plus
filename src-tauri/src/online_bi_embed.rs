//! 在线 BI 的原生视图。
//!
//! An `<iframe>` cannot work here: WKWebView treats a cross-site frame as third-party, so the
//! dashboard's session cookies (`_streamlit_user`) are never stored and every sign-in is dropped.
//! A native view loads the board as a top-level document under its own origin, so cookies behave.
//!
//! It is a **child window**, not `Window::add_child`: Tauri decides a window "is a WebviewWindow"
//! by checking that every webview in it shares the window's label. Adding a second webview named
//! `online-bi-embed` to the main window made that check fail, and every command taking
//! `tauri::WebviewWindow` started returning "current webview is not a WebviewWindow" — the
//! sidebar's own requests included. A separate window leaves the main window's shape untouched.
//!
//! Coordinates: the front end measures the preview slot in CSS pixels. A child window is placed in
//! screen coordinates, so the main window's inner position (physical) is divided by the scale
//! factor and added.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "online-bi-embed";

fn parsed(url: &str) -> Result<tauri::Url, String> {
    url.parse().map_err(|error| format!("invalid url: {error}"))
}

fn existing(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Turns the slot's CSS pixels into screen coordinates and resizes the window onto it.
fn place(app: &AppHandle, view: &tauri::WebviewWindow, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let main = app.get_window("main").ok_or("main window is missing")?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let origin = main.inner_position().map_err(|error| error.to_string())?;
    view.set_position(LogicalPosition::new((origin.x as f64) / scale + x, (origin.y as f64) / scale + y))
        .map_err(|error| error.to_string())?;
    view.set_size(LogicalSize::new(width, height)).map_err(|error| error.to_string())?;
    Ok(())
}

/// Fills the dashboard's email field with the account already signed in to the app.
///
/// The board is a Streamlit page rendered after load, so the input appears late and re-renders;
/// the script uses the native value setter (React-style controlled inputs ignore a plain
/// assignment), retries briefly, and never overwrites something the reader typed.
fn prefill_login_email(email: &str) -> String {
    let literal = serde_json::to_string(email).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
  const email = {literal};
  let tries = 0;
  const fill = () => {{
    const input = document.querySelector(
      'input[type="email"], input[autocomplete="username"], input[placeholder*="邮箱"], input[placeholder*="mail"], input[type="text"]'
    );
    if (!input) return false;
    if (!input.value) {{
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, email);
      input.dispatchEvent(new Event("input", {{ bubbles: true }}));
      input.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }}
    return true;
  }};
  const timer = setInterval(() => {{
    if (fill() || ++tries > 80) clearInterval(timer);
  }}, 250);
  document.addEventListener("focusin", (event) => {{
    const target = event.target;
    if (target instanceof HTMLInputElement && target.value === "") fill();
  }}, true);
}})();"#
    )
}

/// A small stylesheet so the embedded external BI site reads like the app's own surface: a clean
/// white card layout and the system font, instead of the raw Streamlit default. Injected as an
/// initialization script (runs before page scripts) and re-applied if the SPA swaps the document head.
fn inject_bi_skin() -> String {
    let css = r#"
    html, body, .stApp { background: #ffffff !important; color: #1f2937 !important; }
    .stApp { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important; }
    .main .block-container { max-width: 100% !important; padding: 1rem 1.25rem 4rem !important; }
    .element-container { margin-bottom: 0.5rem !important; }
    .stCard, [data-testid="stMetric"], .stMetric {
      background: #ffffff !important;
      border: 1px solid #ececec !important;
      border-radius: 12px !important;
      padding: 0.75rem 1rem !important;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04) !important;
    }
    .stMetric .metric-value, .stMetricValue { font-size: 1.5rem !important; font-weight: 600 !important; }
  "#;
    format!(
        r#"(() => {{
  const css = `{css}`;
  const id = 'alwith-bi-skin';
  const inject = () => {{
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }};
  inject();
  const obs = new MutationObserver(inject);
  obs.observe(document.documentElement, {{ childList: true, subtree: true }});
}})();"#
    )
}

/// Creates the window on first call, then only moves/resizes it.
#[tauri3_specta::command]
pub async fn online_bi_embed_mount(
    app: AppHandle, url: String, x: f64, y: f64, width: f64, height: f64, email: Option<String>,
) -> Result<(), String> {
    if let Some(view) = existing(&app) {
        place(&app, &view, x, y, width, height)?;
        view.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    // `parent` takes the window's webview, which is also what keeps the child glued to it.
    let main = app.get_webview_window("main").ok_or("main window is missing")?;
    let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(parsed(&url)?))
        .title("在线 BI")
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        // `parent` is the one step that can fail, so it ends the chain.
        .parent(&main)
        .map_err(|error| error.to_string())?;
    // A styling patch so the embedded external BI site reads like the app's own surface (clean white
    // cards, system font) instead of the raw Streamlit default. It is the closest we can get to the
    // plugin's look without re-rendering the third-party dashboard ourselves.
    let mut init_script = inject_bi_skin();
    if let Some(email) = email.filter(|value| value.contains('@')) {
        init_script.push_str(&format!("\n{}", prefill_login_email(&email)));
    }
    builder = builder.initialization_script(init_script);
    let view = builder.build().map_err(|error| error.to_string())?;
    place(&app, &view, x, y, width, height)?;
    view.show().map_err(|error| error.to_string())?;
    Ok(())
}

/// Navigates the existing view. Never recreate it for a URL change — that is a new cookie jar.
#[tauri3_specta::command]
pub fn online_bi_embed_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let Some(view) = existing(&app) else {
        return Ok(());
    };
    view.navigate(parsed(&url)?).map_err(|error| error.to_string())
}

/// The report address the native view is on right now. This is the source of truth for 「取当前地址」:
/// the page can navigate itself inside Streamlit, so the address bar in the host webview cannot
/// infer the final report URL from the URL it requested.
#[tauri3_specta::command]
pub fn online_bi_embed_current_url(app: AppHandle) -> Result<Option<String>, String> {
    Ok(existing(&app).and_then(|view| view.url().ok()).map(|url| url.to_string()))
}

/// Hides the view without destroying it: the session lives in this window's cookie jar.
#[tauri3_specta::command]
pub fn online_bi_embed_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(view) = existing(&app) else {
        return Ok(());
    };
    if visible { view.show() } else { view.hide() }.map_err(|error| error.to_string())
}

/// Drops the view when the preview leaves the BI surface.
#[tauri3_specta::command]
pub fn online_bi_embed_close(app: AppHandle) -> Result<(), String> {
    if let Some(view) = existing(&app) {
        view.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
