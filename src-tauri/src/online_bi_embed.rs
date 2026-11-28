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

use std::sync::{Mutex, OnceLock};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    webview::PageLoadEvent,
};

const LABEL: &str = "online-bi-embed";
const BI_SESSION_COOKIE: &str = "bi_password_session";
const DARK_THEME_CSS: &str = include_str!("online_bi_theme.css");
static BI_THEME: OnceLock<Mutex<String>> = OnceLock::new();

fn theme_state() -> &'static Mutex<String> {
    BI_THEME.get_or_init(|| Mutex::new("light".into()))
}

fn normalized_theme(theme: &str) -> &'static str {
    if theme == "dark" { "dark" } else { "light" }
}

fn remember_theme(theme: &str) -> String {
    let theme = normalized_theme(theme).to_string();
    *theme_state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = theme.clone();
    theme
}

fn current_theme() -> String {
    theme_state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBiPageState {
    pub signed_in: bool,
    pub url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OnlineBiPageLoadEvent {
    phase: &'static str,
    signed_in: bool,
    url: String,
}

fn page_state(view: &WebviewWindow) -> OnlineBiPageState {
    let url = view.url().map(|value| value.to_string()).unwrap_or_default();
    // The BI platform sets this HttpOnly cookie only after a successful password/OAuth sign-in.
    // Reading it from the native view's own cookie jar avoids scraping the third-party DOM.
    let signed_in = tauri::Url::parse("https://bi.finture.id/")
        .ok()
        .and_then(|origin| view.cookies_for_url(origin).ok())
        .is_some_and(|cookies| {
            cookies.iter().any(|cookie| cookie.name() == BI_SESSION_COOKIE && !cookie.value().is_empty())
        });
    OnlineBiPageState { signed_in, url }
}

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

/// Applies the host app's light/dark appearance to the third-party BI document.
///
/// Streamlit's `embed_options=dark_theme` is ignored because this BI ships a custom theme. The
/// stylesheet maps the BI's own `--c-*` tokens and the Streamlit test ids onto a dark palette;
/// Plotly charts are re-laid out so their paper/axes stay readable, while ECharts canvases (which
/// cannot be recoloured from CSS) get a hue-preserving invert filter. Light mode simply removes the
/// `data-alwith-bi-theme` attribute, leaving the BI's original theme untouched.
fn theme_script(theme: &str) -> String {
    let theme = normalized_theme(theme);
    let css = serde_json::to_string(DARK_THEME_CSS).unwrap_or_else(|_| "\"\"".into());
    let template = r#"
(() => {
  const theme = "__THEME__";
  const css = __CSS__;
  let bootTries = 0;
  const boot = () => {
  const root = document.documentElement;
  if (!root) {
    if (++bootTries < 200) setTimeout(boot, 16);
    return;
  }
  root.setAttribute('data-alwith-bi-theme', theme);
  let style = document.getElementById('alwith-bi-theme');
  if (!style) {
    style = document.createElement('style');
    style.id = 'alwith-bi-theme';
  }
  style.textContent = css;
  (document.head || root).appendChild(style);

  function applyPlots() {
    const active = document.documentElement.getAttribute('data-alwith-bi-theme') === 'dark' ? 'dark' : 'light';
    if (active !== 'dark') {
      for (const el of document.querySelectorAll('.js-plotly-plot')) {
        const saved = el.__alwithLightLayout;
        if (saved && window.Plotly) {
          try { window.Plotly.relayout(el, saved); } catch (_) {}
          delete el.__alwithLightLayout;
        }
        delete el.__alwithTheme;
      }
      return;
    }
    if (!window.Plotly) return;
    for (const el of document.querySelectorAll('.js-plotly-plot')) {
      const paper = el._fullLayout && el._fullLayout.paper_bgcolor;
      if (el.__alwithTheme === 'dark' && (paper === '#0f1115' || paper === 'rgb(15, 17, 21)')) continue;
      if (!el.__alwithLightLayout) {
        try { el.__alwithLightLayout = JSON.parse(JSON.stringify(el.layout || {})); }
        catch (_) { el.__alwithLightLayout = {}; }
      }
      try {
        window.Plotly.relayout(el, {
          paper_bgcolor: '#0f1115',
          plot_bgcolor: '#0f1115',
          'font.color': '#e6e9ef',
          'xaxis.gridcolor': '#2b303b',
          'xaxis.zerolinecolor': '#2b303b',
          'xaxis.linecolor': '#2b303b',
          'xaxis.tickfont.color': '#9aa4b2',
          'yaxis.gridcolor': '#2b303b',
          'yaxis.zerolinecolor': '#2b303b',
          'yaxis.linecolor': '#2b303b',
          'yaxis.tickfont.color': '#9aa4b2',
          'legend.font.color': '#e6e9ef',
          'legend.bgcolor': 'rgba(0,0,0,0)',
          'hoverlabel.bgcolor': '#1b2230',
          'hoverlabel.bordercolor': '#2b303b',
          'hoverlabel.font.color': '#e6e9ef'
        });
        el.__alwithTheme = 'dark';
      } catch (_) {}
    }
  }
  applyPlots();

  if (!window.__alwithBiThemeReconciler) {
    let timer = 0;
    window.__alwithBiThemeReconciler = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(applyPlots, 600);
    });
    window.__alwithBiThemeReconciler.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  if (!window.__alwithBiThemeStyleObserver && document.head) {
    window.__alwithBiThemeStyleObserver = new MutationObserver(() => {
      if (!document.getElementById('alwith-bi-theme')) {
        (document.head || document.documentElement).appendChild(style);
      }
    });
    window.__alwithBiThemeStyleObserver.observe(document.head, { childList: true });
  }
  };
  boot();
})();
"#;
    template.replace("__THEME__", theme).replace("__CSS__", &css)
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
    let css = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".into());
    let template = r#"
(() => {
  const css = __CSS__;
  const id = 'alwith-bi-skin';
  let bootTries = 0;
  const boot = () => {
    const root = document.documentElement;
    if (!root) {
      if (++bootTries < 200) setTimeout(boot, 16);
      return;
    }
    const inject = () => {
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = css;
      (document.head || root).appendChild(style);
    };
    inject();
    const head = document.head;
    if (head) {
      const obs = new MutationObserver(inject);
      obs.observe(head, { childList: true });
    }
  };
  boot();
})();
"#;
    template.replace("__CSS__", &css)
}

/// Creates the window on first call, then only moves/resizes it.
#[tauri3_specta::command]
pub async fn online_bi_embed_mount(
    app: AppHandle, url: String, x: f64, y: f64, width: f64, height: f64, email: Option<String>, theme: Option<String>,
    visible: Option<bool>,
) -> Result<(), String> {
    let theme = remember_theme(theme.as_deref().unwrap_or("light"));
    let visible = visible.unwrap_or(true);
    if let Some(view) = existing(&app) {
        place(&app, &view, x, y, width, height)?;
        if visible { view.show() } else { view.hide() }.map_err(|error| error.to_string())?;
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
    // A Streamlit subpage navigation is a full document load. Re-apply the latest host theme on
    // every finished load so moving from the board to a report does not flash back to light.
    builder = builder.on_page_load(|view, payload| {
        let phase = match payload.event() {
            PageLoadEvent::Started => "started",
            PageLoadEvent::Finished => "finished",
        };
        let state = page_state(&view);
        let _ = view.app_handle().emit(
            "online-bi-embed:page-load",
            OnlineBiPageLoadEvent { phase, signed_in: state.signed_in, url: state.url },
        );
        if payload.event() == PageLoadEvent::Started {
            // Keep the native window out of the way while the next document loads; the host shows
            // its skeleton until the matching `finished` event.
            let _ = view.hide();
        }
        if payload.event() == PageLoadEvent::Finished {
            let _ = view.eval(&theme_script(&current_theme()));
        }
    });
    // A styling patch so the embedded external BI site reads like the app's own surface (clean white
    // cards, system font) instead of the raw Streamlit default. It is the closest we can get to the
    // plugin's look without re-rendering the third-party dashboard ourselves.
    let mut init_script = inject_bi_skin();
    init_script.push_str(&format!("\n{}", theme_script(&theme)));
    if let Some(email) = email.filter(|value| value.contains('@')) {
        init_script.push_str(&format!("\n{}", prefill_login_email(&email)));
    }
    builder = builder.initialization_script(init_script);
    let view = builder.build().map_err(|error| error.to_string())?;
    place(&app, &view, x, y, width, height)?;
    if visible { view.show() } else { view.hide() }.map_err(|error| error.to_string())?;
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

/// Current page URL plus the BI sign-in state. The frontend uses this when a page-load event was
/// missed (for example when the native view was created before React attached its listener).
#[tauri3_specta::command]
pub fn online_bi_embed_page_state(app: AppHandle) -> Result<OnlineBiPageState, String> {
    Ok(existing(&app)
        .map(|view| page_state(&view))
        .unwrap_or(OnlineBiPageState { signed_in: false, url: String::new() }))
}

/// Hides the view without destroying it: the session lives in this window's cookie jar.
#[tauri3_specta::command]
pub fn online_bi_embed_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(view) = existing(&app) else {
        return Ok(());
    };
    if visible { view.show() } else { view.hide() }.map_err(|error| error.to_string())
}

/// Applies the host app's appearance without reloading the board or touching its cookie jar.
#[tauri3_specta::command]
pub fn online_bi_embed_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let theme = remember_theme(&theme);
    let Some(view) = existing(&app) else {
        return Ok(());
    };
    view.eval(&theme_script(&theme)).map_err(|error| error.to_string())
}

/// Collapses the BI's own navigation sidebar when a host tab is opened.
///
/// Streamlit exposes a native collapse button and persists the choice under `stSidebarCollapsed-`.
/// Clicking the button is what leaves the reader a visible expand control; writing the storage key
/// as well keeps the rule effective when the tab change triggers a full Streamlit document load and
/// the button is not mounted yet. The reader can expand it again at any time; this command only
/// runs on an explicit tab open, never on every render.
#[tauri3_specta::command]
pub fn online_bi_embed_collapse_sidebar(app: AppHandle) -> Result<(), String> {
    let Some(view) = existing(&app) else {
        return Ok(());
    };
    let script = r#"
(() => {
  try {
    localStorage.setItem('stSidebarCollapsed-', 'true');
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('stSidebarCollapsed')) localStorage.setItem(key, 'true');
    }
  } catch (_) {}
  const button = document.querySelector(
    '[data-testid="stSidebarCollapseButton"] button, button[aria-label="Collapse sidebar"]'
  );
  if (button) button.click();
})();
"#;
    view.eval(script).map_err(|error| error.to_string())
}

/// Drops the view when the preview leaves the BI surface.
#[tauri3_specta::command]
pub fn online_bi_embed_close(app: AppHandle) -> Result<(), String> {
    if let Some(view) = existing(&app) {
        view.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalized_theme, theme_script};

    #[test]
    fn theme_script_normalizes_the_theme_and_embeds_the_stylesheet() {
        assert_eq!(normalized_theme("dark"), "dark");
        assert_eq!(normalized_theme("light"), "light");
        assert_eq!(normalized_theme("system"), "light");

        let dark = theme_script("dark");
        assert!(dark.contains("const theme = \"dark\";"));
        assert!(dark.contains("data-alwith-bi-theme"));
        assert!(dark.contains("#0f1115"));

        let light = theme_script("system");
        assert!(light.contains("const theme = \"light\";"));
    }
}
