//! 在线 BI 的登录凭据：存在系统钥匙串里，界面里只显示掩码。
//!
//! The dashboard is a plain web app behind a username/password form, and retyping it every launch is
//! the whole friction. macOS Keychain already gives us encrypted-at-rest storage plus per-user
//! access control, so there is no custom crypto to get wrong: the pair is stored as one generic
//! password and only ever leaves this module as a masked summary unless the window asks for a fill.

use serde::Serialize;
use tauri::Manager;

const SERVICE: &str = "alwith.online-bi";
const ACCOUNT: &str = "default";

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBiCredentials {
    pub username: String,
    /// Never the real secret: the settings row only needs to say whether one is stored.
    pub secret_masked: String,
    /// Same for the API token: the row shows a mask, the embed URL is built in Rust.
    pub token_masked: String,
    pub has_token: bool,
    /// Path the preview column embeds; the token is appended as `?s=`.
    pub path: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Stored {
    username: String,
    secret: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    path: String,
}

/// The page that understands `?s=`. The BI Metrics extension hard-codes this same path for its
/// deep links; the site root is a separate portal and ignores the parameter.
const DEFAULT_PATH: &str = "/personal_dashboard";

fn read_stored() -> Result<Option<Stored>, String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
        .output()
        .map_err(|error| format!("security: {error}"))?;
    if !output.status.success() {
        // Exit 44 is "item not found", which is a legitimately empty state.
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<Stored>(&raw).map(Some).map_err(|error| format!("stored credentials: {error}"))
}

fn mask(secret: &str) -> String {
    "*".repeat(secret.chars().count().clamp(4, 12))
}

#[tauri3_specta::command]
pub fn online_bi_credentials_save(
    username: String, secret: String, token: Option<String>, path: Option<String>,
) -> Result<OnlineBiCredentials, String> {
    let username = username.trim().to_string();
    // A token alone is enough: it is what makes the embedded frame logged in.
    let previous = read_stored().ok().flatten();
    let secret = if secret.is_empty() {
        previous.as_ref().map(|entry| entry.secret.clone()).unwrap_or_default()
    } else {
        secret
    };
    let token = token.unwrap_or_default().trim().to_string();
    let token =
        if token.is_empty() { previous.as_ref().map(|entry| entry.token.clone()).unwrap_or_default() } else { token };
    if secret.is_empty() && token.is_empty() {
        return Err("登录密钥和 API Token 至少填一个".into());
    }
    if username.is_empty() {
        return Err("用户名不能为空".into());
    }
    let path = path.unwrap_or_default().trim().to_string();
    let path =
        if path.is_empty() { previous.as_ref().map(|entry| entry.path.clone()).unwrap_or_default() } else { path };
    let payload = serde_json::to_string(&Stored {
        username: username.clone(),
        secret: secret.clone(),
        token: token.clone(),
        path: path.clone(),
    })
    .map_err(|error| error.to_string())?;
    let status = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", &payload])
        .status()
        .map_err(|error| format!("security: {error}"))?;
    if !status.success() {
        return Err("写入钥匙串失败".into());
    }
    Ok(OnlineBiCredentials {
        username,
        secret_masked: mask(&secret),
        token_masked: mask(&token),
        has_token: !token.is_empty(),
        path,
    })
}

#[tauri3_specta::command]
pub fn online_bi_credentials_load() -> Result<Option<OnlineBiCredentials>, String> {
    Ok(read_stored()?.map(|stored| OnlineBiCredentials {
        secret_masked: mask(&stored.secret),
        token_masked: mask(&stored.token),
        has_token: !stored.token.is_empty(),
        username: stored.username,
        path: if stored.path.is_empty() { DEFAULT_PATH.to_string() } else { stored.path },
    }))
}

#[tauri3_specta::command]
pub fn online_bi_credentials_clear() -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
        .status()
        .map_err(|error| format!("security: {error}"))?;
    // A missing item is already cleared.
    if !status.success() {
        log::info!("online-bi: nothing to delete in the keychain");
    }
    Ok(())
}

/// Saves only the API token, keeping the existing username/secret/path.
///
/// Used after the sign-in window lands on a `?s=<JWT>` URL: we grab that token and persist it so the
/// embedded frame can open already signed in next time, without the user copy-pasting anything.
#[tauri3_specta::command]
pub fn online_bi_credentials_save_token(token: String) -> Result<OnlineBiCredentials, String> {
    let previous = read_stored()?.ok_or("请先在设置里保存用户名与登录密钥")?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token 不能为空".into());
    }
    let payload = serde_json::to_string(&Stored {
        username: previous.username.clone(),
        secret: previous.secret.clone(),
        token: token.clone(),
        path: previous.path.clone(),
    })
    .map_err(|error| error.to_string())?;
    let status = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", &payload])
        .status()
        .map_err(|error| format!("security: {error}"))?;
    if !status.success() {
        return Err("写入钥匙串失败".into());
    }
    Ok(OnlineBiCredentials {
        username: previous.username,
        secret_masked: mask(&previous.secret),
        token_masked: mask(&token),
        has_token: true,
        path: previous.path,
    })
}

/// The embeddable URL for the preview column.
///
/// `bi.finture.id` is a Streamlit app: inside a cross-origin frame the sign-in cookie is dropped, but
/// the app accepts `?s=<JWT>` and restores the session from it — the same trick the BI Metrics
/// extension uses for its dashboard links. With no token stored we hand back the bare URL, and the
/// frame shows the sign-in form (the stand-alone window stays the way to sign in).
#[tauri3_specta::command]
pub fn online_bi_embed_url() -> Result<String, String> {
    const BASE: &str = "https://bi.finture.id";
    let stored = read_stored()?.unwrap_or(Stored {
        username: String::new(),
        secret: String::new(),
        token: String::new(),
        path: String::new(),
    });
    let path = if stored.path.trim().is_empty() { DEFAULT_PATH.to_string() } else { stored.path.trim().to_string() };
    let separator = if path.contains('?') { '&' } else { '?' };
    if stored.token.is_empty() {
        // Streamlit's embed switches hide its own chrome; harmless without a token too.
        return Ok(format!("{BASE}{path}{separator}embed=true&embed_options=show_padding"));
    }
    Ok(format!("{BASE}{path}{separator}s={}&embed=true&embed_options=show_padding", urlencode(&stored.token)))
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Where the dashboard window currently sits. Used to notice that the sign-in finished: the login
/// page and the board have different paths, so a changed URL is the one signal available without
/// injecting anything into the third-party page.
#[tauri3_specta::command]
pub fn online_bi_window_url(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app.get_webview_window("online-bi").and_then(|window| window.url().ok()).map(|url| url.to_string()))
}

/// Fills and submits the dashboard's sign-in form in the already-open window.
///
/// Best effort by design: the page is third-party HTML we do not build against, so the script finds
/// the first visible text/password pair and submits the surrounding form. Returns whether a pair was
/// found and filled, which the caller uses to decide whether to try again after the page settles.
#[tauri3_specta::command]
pub fn online_bi_autofill(app: tauri::AppHandle, account: Option<String>) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("online-bi") else {
        return Ok(false);
    };
    let stored = read_stored()?;
    // Prefer the app's own login email (brought over so the user only types the password) when no
    // stored BI username exists; otherwise fall back to the saved credential.
    let user = account
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stored.as_ref().map(|entry| entry.username.clone()));
    let pass = stored.as_ref().map(|entry| entry.secret.clone());
    let Some(user) = user else {
        return Ok(false);
    };
    let user = serde_json::to_string(&user).map_err(|error| error.to_string())?;
    // Serialize the password as a real JSON value: `null` (the literal) when unknown, so the
    // in-page `if (!pass)` check correctly leaves the form for the user — not the string "null".
    let pass = match &pass {
        Some(secret) => serde_json::to_string(secret).map_err(|error| error.to_string())?,
        None => "null".to_string(),
    };
    let script = format!(
        r#"(() => {{
  const user = {user}, pass = {pass};
  const set = (el, value) => {{
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", {{ bubbles: true }}));
    el.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  const visible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const password = inputs.find((el) => el.type === "password");
  const text = inputs.filter((el) => el.type === "text" || el.type === "email" || el.type === "tel" || el.type === "");
  if (text.length === 0) return false;
  // Prefer the field that looks like an account box: a page can open with a search field first.
  const hint = (el) => ((el.getAttribute("name") || "") + " " + (el.id || "") + " " + (el.placeholder || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
  const score = (el) => (el.type === "email" ? 3 : 0) + (/email|user|account|login|邮箱|账号|用户/.test(hint(el)) ? 2 : 0) + (el.type === "text" ? 1 : 0);
  const account = text.slice().sort((a, b) => score(b) - score(a))[0];
  set(account, user);
  // Only submit when we also have a password; otherwise leave it for the user to type.
  if (!pass) return true;
  if (!password) return false;
  set(password, pass);
  const form = password.closest("form");
  const submit = (form && form.querySelector('button[type="submit"], input[type="submit"]')) ||
    document.querySelector('button[type="submit"], input[type="submit"]');
  if (submit) {{ submit.click(); return true; }}
  if (form && form.requestSubmit) {{ form.requestSubmit(); return true; }}
  return false;
}})();"#
    );
    window.eval(&script).map_err(|error| error.to_string())?;
    Ok(true)
}
