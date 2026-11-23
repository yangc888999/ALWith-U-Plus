mod browser_bridge;
#[cfg(test)]
mod codex_launcher;
mod power;
mod antigravity;

#[cfg(all(test, target_os = "macos"))]
#[path = "__tests__/dropped_file_url.rs"]
mod dropped_file_url_tests;

mod appearance;
mod window_effects;
mod auth;
mod autostart;
mod bridge;
mod bridge_payload;
mod bundled_extensions;
mod chatgpt_auth;
mod codex_update;
mod chat_files;
mod chat_window;
mod computer;
mod draft_directory;
mod drive;
mod enterprise;
mod extension_capabilities;
mod extension_inbox;
mod extension_wire;
#[cfg(target_os = "macos")]
mod fullscreen_controls;
mod html_preview;
mod installed_apps;
mod legacy_extensions;
mod menu;
mod mobile;
mod model_identity;
mod named_store;
mod native;
#[cfg(target_os = "macos")]
mod panel;
mod panic_report;
mod project_memory;
mod providers;
mod provider_quota;
mod reset_credits;
mod external_models;
mod runtime;
mod secret_store;
mod settings;
mod online_bi;
mod online_bi_embed;
mod session_origin;
mod settings_store;
mod groups;
mod skills;
use atlas_tauri as trackpad;
mod tray;
mod updater;
mod usage;
mod lark_cli;
mod support_components;
mod voice;
mod voice_credentials;
mod window;
#[cfg(target_os = "windows")]
mod windows_frame;
mod workspace;
mod workspace_move;

use tauri::{Emitter, Manager};

fn application_context() -> tauri::Context {
    tauri::generate_context!()
}

pub fn run() {
    let context = application_context();

    let builder = tauri::Builder::default()
        .manage(enterprise::Enterprise::default())
        .register_asynchronous_uri_scheme_protocol("preview-html", html_preview::handle_protocol)
        .runtime(tauri_runtime_wry::Wry::default())
        // Second launch: focus the running instance instead of starting a second alwith-runtime
        // against the same ~/.codex.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            log::info!("second instance argv={argv:?} cwd={cwd:?}");
            if window::is_closing(app) {
                return;
            }
            if let Err(error) = window::show_main_window(app.clone()) {
                log::error!("Cannot reopen main window: {error}");
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init()).plugin(fullscreen_controls::init());

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_decoration::init());

    let builder = builder
        .plugin(chat_window::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(alwith_extension::plugin::init_with_paths(None, native::development_directory()))
        .plugin(drive::plugin())
        .plugin(appearance::wallpaper::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        // Chat is created hidden before converting it to NSPanel. Restoring visibility here
        // would focus an unprepared NSWindow and break AppKit's keyboard/KVO lifecycle.
        // Settings has a fixed logical size; cached physical sizes must not override it.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // Shutdown hides windows before draining IPC. Each launch must still
                // show main according to its config, rather than restore that hidden state.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                // `main` opens at the size its display asks for (`window::designed_size`), so a
                // cached frame is never the right answer — and a frame cached while leaving native
                // fullscreen came back in physical pixels applied as points (2x wide, half off-screen).
                .with_denylist(&["chat", "settings", "main"])
                // Windows guide windows must not restore their legacy undecorated state.
                .map_label(|label| if cfg!(target_os = "windows") && label == "guide" { "guide-native" } else { label })
                .build(),
        )
        .manage(legacy_extensions::files::LegacyFiles::default())
        .manage(legacy_extensions::importer::LegacyImports::default())
        .manage(runtime::RuntimeState::default())
        .manage(antigravity::AntigravityBridge::default())
        .manage(power::PreventSleep::default())
        .manage(extension_inbox::InboxState::default());

    #[cfg(feature = "hasgard-testing")]
    let builder = builder.plugin(tauri_plugin_hasgard::init());

    let app = builder
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            fullscreen_controls::on_window_event(window, event);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                voice::detach(window.app_handle(), window.label());
            }
            if window.label() == "main" {
                match event {
                    // A drag that lands the window on another display rebuilds its size for that
                    // display (debounced). Same-display moves are a no-op.
                    tauri::WindowEvent::Moved(_) => window::on_main_window_moved(window.app_handle()),
                    // Keep each display's remembered footprint in step with user resizes. This is
                    // intentionally NOT done on Moved: a cross-display drag has not been resized
                    // yet, so recording it would write the old size against the new work area.
                    tauri::WindowEvent::Resized(_) => window::note_main_window_geometry(window.app_handle()),
                    _ => {}
                }
            }
        })
        .on_menu_event(|app, event| {
            if event.id().0 == menu::QUIT_ID {
                app.exit(0);
                return;
            }
            if window::is_closing(app) {
                return;
            }
            let Some(event_name) = menu::event_name(event.id().0.as_str()) else {
                return;
            };
            if let Some(focused) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                let _ = app.emit_to(focused.label(), event_name, ());
            }
        })
        .setup(|app| {
            match app.path().app_log_dir() {
                Ok(directory) => panic_report::install(directory.join("panic.log")),
                Err(error) => log::warn!("Cannot resolve panic report directory: {error}"),
            }
            app.manage(native::Native::load(app.handle())?);
            mobile::initialize(app.handle())?;
            named_store::init(app.handle())?;
            settings::initialize(app.handle())?;
            external_models::init(app.handle());
            // The bridge that lets outside software call these models travels with the bundle and
            // is released on launch: a manual `install.sh` step is exactly the kind of thing that
            // gets skipped, and a missing bridge only shows up as an outside agent that cannot
            // connect. Off the setup thread — releasing and waiting for a launchd restart can take
            // a second, and nothing about the first window depends on it.
            let bridge_handle = app.handle().clone();
            std::thread::spawn(move || bridge_payload::ensure(&bridge_handle));
            voice::initialize(app.handle())?;
            app.manage(providers::Providers::load(app.handle())?);
            // Write the merged catalog before the engine can boot. The engine reads it once, from
            // the path in `ALWITH_U_MODEL_CATALOG`; when the file is missing that variable is empty
            // and the engine falls back to its own catalog — which is how a stale/missing file
            // silently kept the wrong `Model identity:` paragraph in the system prompt.
            providers::prepare_merged_catalog(app.handle());
            // The company (account-managed) provider's model catalog is regenerated by the Codex
            // plugin on each launch without an early-compaction limit; keep re-applying the 70%
            // rule so it never silently hits the window ceiling.
            providers::start_managed_catalog_tuner(app.handle());
            // The sanitizing proxy must be listening before the first provider apply rewrites a
            // gateway's base_url to point at it.
            if let Err(error) = bridge::start(app.handle().clone()) {
                log::warn!("Sanitizing bridge unavailable; gateways fall back to direct connections: {error}");
            }
            // Before any window can ask the engine to start: a config.toml that names the router
            // without defining it makes Codex exit 1 on launch, and the repair that runs on the
            // first request can never be reached. The port is known now, so write it here.
            providers::repair_router_provider();
            trackpad::install(app.handle())?;
            computer::initialize(app.handle())?;
            // Ship the operator personas with the app and drop them into `$CODEX_HOME/rob_models`
            // on launch. Additive only: a persona the user deleted stays deleted.
            match groups::release_rob_models(app.handle()) {
                Ok(0) => {}
                Ok(count) => log::info!("Released {count} operator personas into rob_models"),
                Err(error) => log::warn!("Could not release operator personas: {error}"),
            }
            log::info!("ALWith U⁺ {} starting", env!("CARGO_PKG_VERSION"));
            #[cfg(target_os = "windows")]
            {
                use tauri::window::{Effect, EffectsBuilder};
                let window = app.get_webview_window("main").expect("main window exists at setup");
                window.hide()?;
                window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build())?;
            }
            // Windows draws no app-level menu (it would surface on every window); macOS wants
            // one NSApp menu and Linux a per-window one. Built here, not in `Builder::menu`,
            // because the locale lookup needs the path resolver, which exists only after build.
            #[cfg(not(target_os = "windows"))]
            app.set_menu(menu::build_app_menu(app.handle())?)?;
            tray::initialize(app.handle())?;
            // Re-validate the main window against the current displays so a corrupt/legacy saved
            // size (or a monitor rearrange) can never leave it off-screen or screen-filling.
            window::install_main_window_monitoring(app.handle());
            updater::init(app);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => voice::detach(webview.app_handle(), webview.label()),
                tauri::webview::PageLoadEvent::Finished => voice::document_ready(webview.app_handle(), webview.label()),
            }
            #[cfg(target_os = "windows")]
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let window = webview.app_handle().get_webview_window("main").expect("main window exists on page load");
                tauri::async_runtime::spawn(windows_frame::activate(window));
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                extension_inbox::window_closed(webview.app_handle(), webview.label());
            }
            log::info!("page {:?} {}", payload.event(), payload.url());
            let _ = webview;
        })
        .invoke_handler({
            let typed = bindings().invoke_handler();
            #[cfg(target_os = "macos")]
            let binary: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                voice::voice_push,
                settings::settings_request,
                fullscreen_controls::set_traffic_light_zoom
            ];
            #[cfg(not(target_os = "macos"))]
            let binary: fn(tauri::ipc::Invoke) -> bool =
                tauri::generate_handler![voice::voice_push, settings::settings_request];
            move |invoke| {
                if matches!(invoke.message.command(), "voice_push" | "settings_request" | "set_traffic_light_zoom") {
                    binary(invoke)
                } else {
                    typed(invoke)
                }
            }
        })
        .build(context)
        .expect("error while building ALWith U⁺");
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } if !window::is_closing(app) => {
            if let Err(error) = window::show_main_window(app.clone()) {
                log::error!("Cannot reopen main window: {error}");
            }
        }
        // Closing the main window quits the app. Hiding it instead (the old behaviour) left the
        // process — and, in native fullscreen, the black Space it owned — alive after the user
        // believed they had quit. Leave fullscreen first so no empty Space is left behind, then
        // run the normal exit path, which drains the background services with a bounded wait.
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. }
            if label == "main" =>
        {
            api.prevent_close();
            window::leave_fullscreen_all(app);
            // A dirty buffer owns the exit: the workspace asks the user to save first, so no
            // watchdog may cut that prompt short. Only a clean exit gets the hard deadline.
            if !workspace::is_dirty() {
                window::arm_exit_watchdog(8);
            }
            app.exit(0);
        }
        // Unexpected destruction cannot leave background services without their host.
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main" => {
            app.exit(0);
        }
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
            #[cfg(target_os = "macos")]
            panel::closed(app, &label);
            extension_inbox::window_closed(app, &label);
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let closing = window::is_closing(app);
            if (!closing && workspace::prevent_exit(app))
                || drive::prevent_exit(app, code)
                || runtime::prevent_exit(app, code)
            {
                api.prevent_exit();
            } else if window::take_fullscreen_exit_delay() {
                // The Drive/Runtime drains finish in a few milliseconds, far shorter than
                // macOS's animated fullscreen → desktop transition. Hold the final exit long
                // enough for the Space to be retired, otherwise the display stays black.
                api.prevent_exit();
                let handle = app.clone();
                let exit_code = code.unwrap_or(0);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    handle.exit(exit_code);
                });
            }
        }
        tauri::RunEvent::Exit => {
            app.state::<alwith_computer::ComputerHost>().kill_on_exit();
            bridge_payload::kill_on_exit();
            voice::shutdown(app);
            power::sync(app, false);
            app.state::<runtime::RuntimeState>().kill_on_exit();
        }
        _ => {}
    });
}

/// Commands live in a module: `tauri3_specta::command` defines `#[macro_export]` helper macros
/// that collide with a crate-root re-import when the function is declared at the crate root.
mod overload_commands {
    /// Pushes the UI's mute switch into the bridge. `forward_chatgpt` reads the shared atomic on
    /// every upstream request, so a change applies immediately without restarting the engine. The
    /// engine itself never retries (`request_max_retries=0`): honouring the upstream `retry-after`
    /// would stall the turn for minutes, so the bridge owns the immediate replay loop instead.
    /// When muted, the bridge swallows `server_is_overloaded` and re-sends the same request with no
    /// ceiling — the 60-minute whole-request timeout is the only backstop.
    #[tauri3_specta::command]
    pub fn set_overload_mute(mute: bool) {
        crate::bridge::set_overload_mute(mute);
    }

    /// OpenRouter answers a burst with HTTP 429 instead of the structured `server_is_overloaded`
    /// event. When the user switches the OpenRouter「模型异常提醒」off, the bridge treats a 429 as
    /// a transient hiccup and re-sends the same request once, so the turn either completes or
    /// fails on its own merits instead of stopping at `请求太频繁`.
    #[tauri3_specta::command]
    pub fn set_overload_429_mute(mute: bool) {
        crate::bridge::set_overload_429_mute(mute);
    }
}

/// The native handler and TypeScript exporter use this same command and event graph.
pub fn bindings() -> tauri3_specta::Bindings {
    macro_rules! commands {
        ($($platform:path),* $(,)?) => {
            tauri3_specta::commands![
                $($platform,)*
                named_store::store_entries,
                named_store::store_set,
                named_store::store_delete,
                named_store::store_clear,
                named_store::store_reload,
                project_memory::project_memory_ensure,
                project_memory::project_memory_append,
                project_memory::project_memory_snapshot,
                autostart::autostart_status,
                usage::usage_report,
                usage::usage_report_refresh,
                usage::fetch_text,
                reset_credits::chatgpt_reset_credits,
                reset_credits::chatgpt_reset_credit,
                window_effects::appearance_effect,
                provider_quota::provider_quota_query,
                provider_quota::provider_quota_cached,
                provider_quota::provider_quota_clear,
                provider_quota::openrouter_free_usage,
                bridge::gateway_retry_get,
                bridge::gateway_retry_set,
                lark_cli::lark_cli_status,
                lark_cli::lark_cli_targets,
                lark_cli::lark_cli_send,
                lark_cli::lark_cli_install,
                lark_cli::lark_cli_check_update,
                lark_cli::lark_cli_update,
                lark_cli::lark_cli_auth_status,
                lark_cli::lark_cli_auth_login,
                lark_cli::lark_cli_auth_complete,
                lark_cli::lark_cli_auth_logout,
                lark_cli::lark_cli_user_profile,
                support_components::node_status,
                support_components::node_install,
                support_components::brew_status,
                support_components::brew_install,
                computer::computer_status,
                computer::computer_start,
                computer::computer_reconnect,
                computer::computer_stop,
                computer::computer_context,
                computer::computer_revision,
                computer::computer_bind,
                computer::computer_ready,
                computer::computer_stop_session,
                computer::computer_subscribe,
                computer::computer_focus,
                computer::computer_unsubscribe,
                computer::computer_request_permissions,
                autostart::autostart_set,
                window::show_main_window,
                window::window_drag,
                extension_inbox::extension_inbox_scan,
                extension_inbox::extension_inbox_scan_extension,
                extension_inbox::extension_inbox_finish,
                extension_inbox::extension_inbox_prepare,
                extension_inbox::extension_inbox_complete,
                extension_inbox::extension_inbox_failed,
                draft_directory::draft_directory,
                voice::voice_start,
                voice::voice_control,
                voice::voice_profiles,
                voice::voice_save_credential,
                voice::voice_delete_credential,
                drive::drive_path_exists,
                chat_files::chat_save_file,
                chat_files::chat_write_text_attachment,
                chat_files::chat_read_image,
                chat_files::chat_preview_file,
                chat_files::chat_read_dropped_file,
                workspace::workspace_open,
                workspace::workspace_list_files,
                workspace::workspace_import,
                workspace::workspace_file,
                workspace::workspace_watch,
                workspace::workspace_dirty,
                workspace::workspace_exit,
                html_preview::html_preview_open,
                html_preview::html_preview_close,
                workspace_move::workspace_move_to,
                bundled_extensions::extension_bundles,
                legacy_extensions::importer::extension_prepare_install,
                legacy_extensions::importer::extension_install_from_url,
                legacy_extensions::importer::legacy_stage_import,
                legacy_extensions::importer::legacy_take_initial_data,
                legacy_extensions::importer::legacy_ack_initial_data,
                legacy_extensions::importer::legacy_cleanup_import,
                legacy_extensions::http::legacy_http,
                legacy_extensions::http::extension_http,
                extension_capabilities::extension_cleanup_grants,
                legacy_extensions::files::extension_file,
                legacy_extensions::files::extension_directories,
                legacy_extensions::files::extension_pick_directory,
                legacy_extensions::files::legacy_file,
                legacy_extensions::business_sharing::legacy_share_business,
                legacy_extensions::files::legacy_directories,
                legacy_extensions::files::legacy_pick_directory,
                appearance::wallpaper::wallpaper_list,
                appearance::wallpaper::wallpaper_import,
                appearance::wallpaper::wallpaper_remove,
                auth::refresh_tokens,
                chat_window::plugin::present_chat_window,
                chat_window::plugin::resize_chat_window,
                runtime::runtime_start,
                runtime::runtime_send,
                runtime::restart_runtime_engine,
                runtime::codex_version,
                runtime::codex_bundled_models,
                antigravity::antigravity_start,
                antigravity::antigravity_status,
                antigravity::antigravity_send,
                antigravity::antigravity_stop,
                overload_commands::set_overload_mute,
                overload_commands::set_overload_429_mute,
                skills::skills_list,
                skills::skills_set_enabled,
                skills::skills_install,
                skills::skills_open_folder,
                skills::skills_pick_directory,
                skills::skills_uninstall,
                skills::global_prompt_read,
                skills::global_prompt_write,
                groups::group_directory_create,
                groups::group_directory_heal,
                groups::pick_group_directory,
                groups::group_copy_materials,
                groups::group_document_read,
                groups::group_document_write,
                groups::group_material_index,
                groups::group_tail_text,
                groups::read_text_file,
                groups::rob_models_open_folder,
                groups::rob_models_list,
                groups::rob_models_read_config,
                groups::rob_models_write_config,
                groups::pick_role_document,
                groups::skill_document_read,
                session_origin::session_origin,
                session_origin::repair_session_rollout,
                session_origin::migrate_threads_to_router,
                online_bi::online_bi_credentials_save,
                online_bi::online_bi_credentials_load,
                online_bi::online_bi_credentials_clear,
                online_bi::online_bi_autofill,
                online_bi::online_bi_window_url,
                online_bi::online_bi_embed_url,
                online_bi::online_bi_credentials_save_token,
                online_bi_embed::online_bi_embed_mount,
                online_bi_embed::online_bi_embed_navigate,
                online_bi_embed::online_bi_embed_set_visible,
                online_bi_embed::online_bi_embed_close,
                session_origin::apply_session_provider,
                session_origin::restart_app,
                session_origin::append_diagnostic,
                skills::quick_chat_directory,
                skills::new_chat_directory,
                skills::delete_chat_directory,
                skills::pick_project_directory,
                mobile::mobile_set_draft_sessions,
                mobile::mobile_bridge_start,
                mobile::mobile_bridge_stop,
                mobile::mobile_bridge_status,
                mobile::bridge_set_active_session,
                mobile::bridge_pairing_start,
                mobile::bridge_identity,
                mobile::bridge_trusted_list,
                mobile::bridge_trusted_revoke,
                providers::providers_read,
                providers::providers_save,
                providers::providers_save_custom,
                providers::providers_remove_custom,
                providers::providers_test,
                providers::providers_test_model,
                providers::providers_discover_models,
                providers::providers_apply,
                providers::providers_save_built_in_models,
                // Account-managed ALwith models (upstream 8f7f701e). The provider id is `litellm`,
                // so these never touch the `alwith` router table.
                providers::managed::providers_account_bind,
                providers::managed::providers_refresh_managed,
                providers::managed::providers_clear_managed,
                // The company model's default reasoning level (Finture / DeepSeek V4.1 Flash).
                // Frontend pushes its 大模型-page choice here; the backend mirrors it into the
                // engine catalog and the managed-provider snapshot.
                providers::set_company_model_reasoning,
                enterprise::enterprise_bind,
                enterprise::enterprise_refresh,
                enterprise::enterprise_catalog,
                enterprise::enterprise_clear,
                enterprise::enterprise_status,
                enterprise::enterprise_begin,
                enterprise::enterprise_cancel,
                enterprise::enterprise_update_account,
                enterprise::enterprise_logout,
                updater::commands::updater_get_state,
                updater::commands::updater_install_and_relaunch,
                updater::commands::updater_check_now,
                window::attach_window_to_main,
                installed_apps::read_apps_info,
                browser_bridge::chrome_extension_installed,
                browser_bridge::chrome_bridge_installed,
                browser_bridge::set_chrome_bridge_enabled,
                installed_apps::default_browser,
                installed_apps::is_app_running,
                installed_apps::open_app_by_id,
                installed_apps::open_path_in_app
            ]
            .event::<trackpad::TrackpadGesture>()
            .event::<runtime::RuntimeLines>()
            .event::<computer::ComputerPreview>()
            .event::<runtime::RuntimeExit>()
            .event::<providers::Snapshot>()
            .event::<providers::managed::RevokedSessions>()
            .event::<updater::state::State>()
            .event::<menu::OpenSettings>()
            .event::<menu::NewChat>()
            .event::<menu::NewTab>()
            .event::<menu::CloseTab>()
            .event::<menu::ReopenTab>()
            .event::<menu::ProjectTree>()
            .event::<menu::FindInChat>()
            .event::<menu::ReplaceInFile>()
            .event::<menu::EditUndo>()
            .event::<menu::EditRedo>()
            .event::<menu::CommandPalette>()
            .event::<menu::OpenHotkeys>()
            .event::<menu::ZoomIn>()
            .event::<menu::ZoomOut>()
            .event::<menu::ActualSize>()
        };
    }
    commands![]
}
