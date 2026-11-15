//! 外观材质：把「Liquid Glass / Aero / 纯色」三档落到**窗口**上。
//!
//! Webview 里的 CSS 只能做 `backdrop-filter` 的近似，真正会把桌面内容折射进来的那层材质由
//! AppKit 提供（`NSVisualEffectView` / macOS 26 的 `NSGlassEffectView`）。这里通过
//! `window-vibrancy` 直接挂到主窗口的 content view 上，并把窗口背景设为透明，让材质透出来。
//!
//! 三条纪律：
//!
//! 1. **纯色不动窗口**。它就是今天的样子（不透明背景 + 无材质），所以「切回去」必须是彻底的
//!    `clear`，不能留下半透明底。
//! 2. **不支持就如实说**。窗口级 API 只能在 macOS 上跑，`apply_liquid_glass` 还要求 macOS 26+；
//!    调用失败时返回 `applied: false` 与原因，前端据此退回 CSS 近似，而不是假装成功。
//! 3. **主线程**。AppKit 的调用必须在主线程；命令本身跑在工作线程，所以统一 marshal 回主线程
//!    并把结果送回来（oneshot），命令不会在材质未生效时就返回「成功」。

use std::sync::mpsc;

use tauri::{AppHandle, Manager};
use tauri::window::Color;

/// 与前端 `appearance-mode.ts` 的三个取值一一对应。
const LIQUID_GLASS: &str = "liquid-glass";
const AERO: &str = "aero";
const SOLID: &str = "solid";

/// 一次切换的结果。`applied` 只说「窗口材质确实按这个模式生效了」，
/// 不表示 CSS 那一半也成功——那一半是纯前端的事。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceEffect {
    pub mode: String,
    /// 真实材质已经挂到窗口上（或已彻底清除）。
    pub applied: bool,
    /// 生效的是哪种材质：`liquidGlass` | `vibrancy` | `none`。前端据此决定要不要叠加 CSS。
    pub material: String,
    /// 失败/降级原因，仅用于展示与诊断，不参与判断。
    pub detail: Option<String>,
}

impl AppearanceEffect {
    fn done(mode: &str, material: &str, detail: Option<String>) -> Self {
        Self { mode: mode.to_string(), applied: true, material: material.to_string(), detail }
    }

    fn refused(mode: &str, detail: impl Into<String>) -> Self {
        Self { mode: mode.to_string(), applied: false, material: "none".to_string(), detail: Some(detail.into()) }
    }
}

/// 把当前外观模式应用到主窗口。
///
/// 幂等：重复切到同一档不会叠加材质（`apply_vibrancy` 自己按 view tag 去重，
/// `apply_liquid_glass` 同样按 tag 查找）。
#[tauri3_specta::command]
pub async fn appearance_effect(app: AppHandle, mode: String) -> Result<AppearanceEffect, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(AppearanceEffect::refused(&mode, "主窗口不存在"));
    };
    // 主线程执行 + 结果回传。超时只是护栏：主线程被 AppKit 调用卡住时不该让命令永远挂着。
    let (tx, rx) = mpsc::channel::<AppearanceEffect>();
    let mode_for_task = mode.clone();
    let window_for_task = window.clone();
    app.run_on_main_thread(move || {
        let result = apply(&window_for_task, &mode_for_task);
        let _ = tx.send(result);
    })
    .map_err(|error| format!("无法调度到主线程: {error}"))?;
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(result) => Ok(result),
        Err(_) => Ok(AppearanceEffect::refused(&mode, "主线程未在 3 秒内回应")),
    }
}

#[cfg(target_os = "macos")]
fn apply(window: &tauri::WebviewWindow, mode: &str) -> AppearanceEffect {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    match mode {
        SOLID => {
            // 恢复不透明：清掉两层材质。窗口本身保持透明（tauri.conf 的 `transparent: true`），
            // 纯色模式靠 `html, body { background: var(--background) }` 把底色铺满——那里是
            // 不透明色，所以观感和升级前一模一样，也没有「半透明底露桌面」的窗口。
            let cleared_vibrancy = clear_vibrancy(window).unwrap_or(false);
            let cleared_glass = window_vibrancy::clear_liquid_glass(window).unwrap_or(false);
            let _ = window.set_background_color(None::<Color>);
            let detail = if cleared_vibrancy || cleared_glass {
                None
            } else {
                Some("此前没有挂过窗口材质".to_string())
            };
            AppearanceEffect::done(mode, "none", detail)
        }
        LIQUID_GLASS => {
            // 透明底来自 `tauri.conf` 的 `transparent: true`（macOS 上这里改 webview 层是
            // no-op，所以不把它当成功条件）。材质挂在 content view 下面，CSS 那层透明度一让开
            // 就能看见。
            let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
            // macOS 26+: 真·Liquid Glass。
            match window_vibrancy::apply_liquid_glass(
                window,
                window_vibrancy::LiquidGlassOptions::default().radius(0.0)
            ) {
                Ok(()) => AppearanceEffect::done(mode, "liquidGlass", None),
                Err(error) => {
                    // 26 以下没有玻璃层，退到同族的 vibrancy 材质；失败原因如实带回前端。
                    match apply_vibrancy(window, NSVisualEffectMaterial::UnderWindowBackground, Some(NSVisualEffectState::Active), None) {
                        Ok(()) => AppearanceEffect::done(
                            mode,
                            "vibrancy",
                            Some(format!("此系统没有 Liquid Glass（{error}），已退回毛玻璃材质"))
                        ),
                        Err(fallback) => AppearanceEffect::refused(mode, format!("系统不支持窗口材质: {fallback}")),
                    }
                }
            }
        }
        AERO => {
            let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
            // 经典 Aero 的观感来自更亮、更透的标题栏材质，`HudWindow` 是最接近的一档。
            match apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), None) {
                Ok(()) => AppearanceEffect::done(mode, "vibrancy", None),
                Err(error) => AppearanceEffect::refused(mode, format!("系统不支持窗口材质: {error}")),
            }
        }
        other => AppearanceEffect::refused(other, "未知的外观模式"),
    }
}

#[cfg(not(target_os = "macos"))]
fn apply(_window: &tauri::WebviewWindow, mode: &str) -> AppearanceEffect {
    // Windows/Linux 没有 AppKit；CSS 那一半照常工作，这里如实说明原生层没生效。
    if mode == SOLID {
        AppearanceEffect::done(mode, "none", None)
    } else {
        AppearanceEffect::refused(mode, "窗口级材质只在 macOS 上可用")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_result_never_claims_a_material() {
        let result = AppearanceEffect::refused("aero", "nope");
        assert!(!result.applied);
        assert_eq!(result.material, "none");
        assert_eq!(result.detail.as_deref(), Some("nope"));
        assert_eq!(result.mode, "aero");
    }

    #[test]
    fn a_done_result_carries_the_material_that_actually_landed() {
        let result = AppearanceEffect::done("liquid-glass", "vibrancy", Some("fallback".to_string()));
        assert!(result.applied);
        assert_eq!(result.mode, "liquid-glass");
        assert_eq!(result.material, "vibrancy");
        assert_eq!(result.detail.as_deref(), Some("fallback"));
    }
}
