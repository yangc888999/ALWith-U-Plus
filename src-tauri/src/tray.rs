//! The resident host remains reachable when its main window is hidden.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

pub fn initialize(app: &tauri::AppHandle) -> tauri::Result<()> {
    let chinese = crate::menu::detect_locale(app) == "zh-CN";
    let show = MenuItem::with_id(
        app,
        "tray-show",
        if chinese { "打开 ALWith U⁺" } else { "Open ALWith U⁺" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        if chinese { "退出 ALWith U⁺" } else { "Quit ALWith U⁺" },
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-icon.png");
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().expect("application icon is configured").clone();
    TrayIconBuilder::with_id("main")
        .icon(icon)
        // The glyph is white-on-transparent, so it must be a template image: macOS then tints the
        // alpha shape to match the menu bar (black on light, white on dark). Without template mode
        // a white glyph is invisible on a light bar.
        .icon_as_template(true)
        .tooltip("ALWith U⁺")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if crate::window::is_closing(app) {
                return;
            }
            let result = match event.id().as_ref() {
                "tray-show" => crate::window::show_main_window(app.clone()),
                "tray-quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                log::error!("Tray action failed: {error}");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
            ) && !crate::window::is_closing(tray.app_handle())
                && let Err(error) = crate::window::show_main_window(tray.app_handle().clone())
            {
                log::error!("Cannot reopen main window from tray: {error}");
            }
        })
        .build(app)?;
    Ok(())
}
