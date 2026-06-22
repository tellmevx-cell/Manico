pub mod app_config;
pub mod app_launcher;
pub mod window_bindings;
pub mod windows_api;

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Default)]
struct AppShortcutState {
    registered: Mutex<Vec<Shortcut>>,
}

#[derive(Default)]
struct TopmostOverlayState {
    options: Mutex<HashMap<isize, windows_api::TopmostMarkerOptions>>,
}

#[derive(Clone, serde::Serialize)]
struct TopmostWindowRemovedPayload {
    hwnd: isize,
    reason: &'static str,
}

enum QuickTopmostResult {
    Enabled(windows_api::TopmostWindowInfo),
    Disabled(isize),
}

#[derive(Clone, Copy)]
enum WindowOpacityAction {
    Decrease,
    Increase,
    Reset,
}

const OVERLAY_TRACKER_INTERVAL_MS: u64 = 24;

#[tauri::command]
fn list_windows() -> Result<Vec<windows_api::WindowInfo>, String> {
    windows_api::list_windows()
}

#[tauri::command]
fn list_all_windows() -> Result<Vec<windows_api::WindowInfo>, String> {
    windows_api::list_windows_for_matching()
}

#[tauri::command]
fn hide_window(hwnd: isize) -> Result<(), String> {
    windows_api::hide_window(hwnd)
}

#[tauri::command]
fn show_window(hwnd: isize) -> Result<(), String> {
    windows_api::show_window(hwnd)
}

#[tauri::command]
async fn pick_topmost_window(
    handle: tauri::AppHandle,
    options: windows_api::TopmostMarkerOptions,
) -> Result<windows_api::TopmostWindowInfo, String> {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.hide();
    }

    let result =
        tauri::async_runtime::spawn_blocking(move || windows_api::pick_topmost_window(options))
            .await
            .map_err(|error| format!("Window picker task failed: {error}"))?;

    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    let window = result?;
    create_or_update_topmost_overlay(&handle, &window)?;
    Ok(window)
}

#[tauri::command]
fn update_topmost_window_marker(
    handle: tauri::AppHandle,
    hwnd: isize,
    options: windows_api::TopmostMarkerOptions,
) -> Result<windows_api::TopmostWindowInfo, String> {
    let window = windows_api::mark_window_topmost(hwnd, options)?;
    create_or_update_topmost_overlay(&handle, &window)?;
    Ok(window)
}

#[tauri::command]
fn clear_topmost_window(handle: tauri::AppHandle, hwnd: isize) -> Result<(), String> {
    close_topmost_overlay(&handle, hwnd);
    windows_api::clear_topmost_window(hwnd)
}

#[tauri::command]
fn suspend_process(pid: u32) -> Result<(), String> {
    windows_api::suspend_process(pid)
}

#[tauri::command]
fn resume_process(pid: u32) -> Result<(), String> {
    windows_api::resume_process(pid)
}

#[tauri::command]
fn get_app_settings(handle: tauri::AppHandle) -> Result<app_config::AppSettings, String> {
    app_config::read_settings(app_config::settings_file(&handle)?)
}

#[tauri::command]
fn save_app_settings(
    handle: tauri::AppHandle,
    settings: app_config::AppSettings,
) -> Result<app_config::AppSettings, String> {
    app_config::write_settings(app_config::settings_file(&handle)?, &settings)?;
    app_config::sync_startup_registration(settings.start_with_windows)?;
    refresh_app_shortcuts(&handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn update_window_bindings(
    handle: tauri::AppHandle,
    window_bindings: Vec<app_config::WindowBinding>,
) -> Result<app_config::AppSettings, String> {
    let path = app_config::settings_file(&handle)?;
    let mut settings = app_config::read_settings(path.clone())?;
    app_config::replace_window_bindings(&mut settings, window_bindings);
    app_config::write_settings(path, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn upsert_managed_app(
    handle: tauri::AppHandle,
    app: app_config::ManagedApp,
) -> Result<app_config::AppSettings, String> {
    let path = app_config::settings_file(&handle)?;
    let mut settings = app_config::read_settings(path.clone())?;
    app_config::upsert_app(&mut settings, app);
    app_config::write_settings(path, &settings)?;
    refresh_app_shortcuts(&handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn delete_managed_app(
    handle: tauri::AppHandle,
    id: String,
) -> Result<app_config::AppSettings, String> {
    let path = app_config::settings_file(&handle)?;
    let mut settings = app_config::read_settings(path.clone())?;
    app_config::delete_app(&mut settings, &id);
    app_config::write_settings(path, &settings)?;
    refresh_app_shortcuts(&handle, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn resolve_dropped_app(path: String) -> Result<app_config::DroppedAppCandidate, String> {
    app_config::resolve_dropped_app(path)
}

#[tauri::command]
fn launch_managed_app(
    handle: tauri::AppHandle,
    id: String,
) -> Result<app_launcher::LaunchResult, String> {
    let settings = app_config::read_settings(app_config::settings_file(&handle)?)?;
    let app = settings
        .apps
        .iter()
        .find(|app| app.id == id)
        .ok_or_else(|| format!("Managed app not found: {id}"))?;
    app_launcher::launch_or_switch_app(app)
}

fn create_or_update_topmost_overlay<R: Runtime>(
    app: &tauri::AppHandle<R>,
    target: &windows_api::TopmostWindowInfo,
) -> Result<(), String> {
    let options = marker_options_from_window(target);
    let bounds = windows_api::overlay_bounds(target.hwnd, &options)?;
    let label = topmost_overlay_label(target.hwnd);
    remember_topmost_options(app, target.hwnd, options.clone());

    if let Some(overlay) = app.get_webview_window(&label) {
        update_existing_topmost_overlay(&overlay, target, bounds)?;
        return Ok(());
    }

    let init_script = marker_update_script(target)?;

    let overlay = WebviewWindowBuilder::new(
        app,
        label.clone(),
        WebviewUrl::App("topmost-overlay.html".into()),
    )
    .title("Manico Topmost Marker")
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .inner_size(bounds.width as f64, bounds.height as f64)
    .position(bounds.x as f64, bounds.y as f64)
    .initialization_script(init_script)
    .build()
    .map_err(|error| format!("Unable to create topmost marker overlay: {error}"))?;

    let _ = overlay.set_ignore_cursor_events(true);
    let _ = overlay.set_always_on_top(true);
    apply_overlay_bounds(&overlay, bounds)?;
    spawn_overlay_tracker(app.clone(), label, target.hwnd);
    Ok(())
}

fn close_topmost_overlay<R: Runtime>(app: &tauri::AppHandle<R>, hwnd: isize) {
    forget_topmost_options(app, hwnd);
    if let Some(window) = app.get_webview_window(&topmost_overlay_label(hwnd)) {
        let _ = window.destroy();
    }
}

fn topmost_overlay_label(hwnd: isize) -> String {
    format!("topmost-marker-{hwnd}")
}

fn marker_options_from_window(
    window: &windows_api::TopmostWindowInfo,
) -> windows_api::TopmostMarkerOptions {
    windows_api::TopmostMarkerOptions {
        marker_color: window.marker_color.clone(),
        border_width: window.border_width,
        glow_size: window.glow_size,
        opacity: window.opacity,
        marker_style: window.marker_style.clone(),
    }
    .normalized()
}

fn marker_update_script(window: &windows_api::TopmostWindowInfo) -> Result<String, String> {
    let marker_json = serde_json::to_string(window)
        .map_err(|error| format!("Unable to serialize marker options: {error}"))?;
    Ok(format!(
        "window.__MANICO_MARKER_OPTIONS__ = {marker_json};\
         if (window.__MANICO_APPLY_MARKER_OPTIONS__) {{\
           window.__MANICO_APPLY_MARKER_OPTIONS__(window.__MANICO_MARKER_OPTIONS__);\
         }}"
    ))
}

fn remember_topmost_options<R: Runtime>(
    app: &tauri::AppHandle<R>,
    hwnd: isize,
    options: windows_api::TopmostMarkerOptions,
) {
    if let Ok(mut current) = app.state::<TopmostOverlayState>().options.lock() {
        current.insert(hwnd, options);
    }
}

fn forget_topmost_options<R: Runtime>(app: &tauri::AppHandle<R>, hwnd: isize) {
    if let Ok(mut current) = app.state::<TopmostOverlayState>().options.lock() {
        current.remove(&hwnd);
    }
}

fn current_topmost_options<R: Runtime>(
    app: &tauri::AppHandle<R>,
    hwnd: isize,
) -> windows_api::TopmostMarkerOptions {
    app.state::<TopmostOverlayState>()
        .options
        .lock()
        .ok()
        .and_then(|current| current.get(&hwnd).cloned())
        .unwrap_or_default()
}

fn overlay_tracker_interval() -> Duration {
    Duration::from_millis(OVERLAY_TRACKER_INTERVAL_MS)
}

fn update_existing_topmost_overlay<R: Runtime>(
    overlay: &WebviewWindow<R>,
    target: &windows_api::TopmostWindowInfo,
    bounds: windows_api::OverlayBounds,
) -> Result<(), String> {
    apply_overlay_bounds(overlay, bounds)?;
    let _ = overlay.set_always_on_top(true);
    overlay
        .eval(marker_update_script(target)?)
        .map_err(|error| format!("Unable to update topmost marker overlay: {error}"))?;
    Ok(())
}

fn should_apply_overlay_bounds(
    last_bounds: Option<&windows_api::OverlayBounds>,
    next_bounds: &windows_api::OverlayBounds,
) -> bool {
    last_bounds != Some(next_bounds)
}

fn apply_overlay_bounds<R: Runtime>(
    window: &WebviewWindow<R>,
    bounds: windows_api::OverlayBounds,
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("Unable to move marker overlay: {error}"))?;
    window
        .set_size(PhysicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("Unable to size marker overlay: {error}"))?;
    Ok(())
}

fn spawn_overlay_tracker<R: Runtime>(app: tauri::AppHandle<R>, label: String, hwnd: isize) {
    thread::spawn(move || {
        let mut last_bounds: Option<windows_api::OverlayBounds> = None;
        loop {
            thread::sleep(overlay_tracker_interval());
            let Some(window) = app.get_webview_window(&label) else {
                break;
            };

            match windows_api::overlay_target_state(hwnd) {
                windows_api::OverlayTargetState::Closed => {
                    forget_topmost_options(&app, hwnd);
                    let _ = window.destroy();
                    let _ = app.emit(
                        "manico://topmost-window-removed",
                        TopmostWindowRemovedPayload {
                            hwnd,
                            reason: "closed",
                        },
                    );
                    break;
                }
                windows_api::OverlayTargetState::Hidden => {
                    last_bounds = None;
                    let _ = window.hide();
                    continue;
                }
                windows_api::OverlayTargetState::Visible => {}
            }

            let options = current_topmost_options(&app, hwnd);
            match windows_api::overlay_bounds(hwnd, &options) {
                Ok(bounds) => {
                    if should_apply_overlay_bounds(last_bounds.as_ref(), &bounds) {
                        if apply_overlay_bounds(&window, bounds).is_ok() {
                            last_bounds = Some(bounds);
                        } else {
                            last_bounds = None;
                        }
                        let _ = window.set_always_on_top(true);
                    }
                    let _ = window.show();
                }
                Err(_) => {
                    forget_topmost_options(&app, hwnd);
                    let _ = window.destroy();
                    let _ = app.emit(
                        "manico://topmost-window-removed",
                        TopmostWindowRemovedPayload {
                            hwnd,
                            reason: "closed",
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn setup_tray<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 Manico", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Manico", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let mut tray = TrayIconBuilder::with_id("manico-tray")
        .menu(&menu)
        .tooltip("Manico")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => hide_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn install_global_shortcuts<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }

                if shortcut.matches(Modifiers::CONTROL, Code::KeyQ) {
                    handle_window_binding_shortcut(app);
                } else if shortcut.matches(Modifiers::SUPER, Code::Escape) {
                    app.exit(0);
                } else {
                    handle_app_shortcut(app, shortcut);
                }
            })
            .build(),
    )?;

    let shortcuts = [
        (
            "Ctrl+Q",
            Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ),
        ),
        (
            "Win+Esc",
            Shortcut::new(Some(Modifiers::SUPER), Code::Escape),
        ),
    ];

    for (label, shortcut) in shortcuts {
        if let Err(error) = app.global_shortcut().register(shortcut) {
            let _ = app.emit(
                "manico://shortcut-error",
                format!("{label} 注册失败：{error}"),
            );
        }
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_window_binding_shortcut<R: Runtime>(app: &tauri::AppHandle<R>) {
    let status = app_config::settings_file(app)
        .and_then(app_config::read_settings)
        .and_then(|settings| window_bindings::toggle_bound_windows(&settings.window_bindings))
        .map(window_bindings::status_message)
        .unwrap_or_else(|error| format!("Ctrl+Q 切换失败：{error}"));

    let _ = app.emit("manico://shortcut-error", status);
    let _ = app.emit("manico://bindings-updated", ());
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_app_shortcut<R: Runtime>(app: &tauri::AppHandle<R>, shortcut: &Shortcut) {
    let Ok(settings_path) = app_config::settings_file(app) else {
        return;
    };
    let Ok(settings) = app_config::read_settings(settings_path) else {
        return;
    };

    if shortcut_matches_hotkey(shortcut, &settings.quick_topmost_hotkey) {
        handle_quick_topmost_shortcut(app, &settings);
        return;
    }

    if shortcut_matches_hotkey(shortcut, &settings.window_opacity_settings.decrease_hotkey) {
        handle_window_opacity_shortcut(
            app,
            &settings.window_opacity_settings,
            WindowOpacityAction::Decrease,
        );
        return;
    }

    if shortcut_matches_hotkey(shortcut, &settings.window_opacity_settings.increase_hotkey) {
        handle_window_opacity_shortcut(
            app,
            &settings.window_opacity_settings,
            WindowOpacityAction::Increase,
        );
        return;
    }

    if shortcut_matches_hotkey(shortcut, &settings.window_opacity_settings.reset_hotkey) {
        handle_window_opacity_shortcut(
            app,
            &settings.window_opacity_settings,
            WindowOpacityAction::Reset,
        );
        return;
    }

    let Some(managed_app) = matching_app_shortcut(&settings, shortcut) else {
        return;
    };

    match app_launcher::launch_or_switch_app(managed_app) {
        Ok(result) => emit_launch_status(app, managed_app, &result.action),
        Err(error) => {
            let _ = app.emit("manico://shortcut-error", format!("快捷启动失败：{error}"));
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_window_opacity_shortcut<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &app_config::WindowOpacitySettings,
    action: WindowOpacityAction,
) {
    let result = match action {
        WindowOpacityAction::Decrease => windows_api::adjust_foreground_window_opacity(
            -(settings.step_percent as i16),
            settings.min_percent,
        ),
        WindowOpacityAction::Increase => windows_api::adjust_foreground_window_opacity(
            settings.step_percent as i16,
            settings.min_percent,
        ),
        WindowOpacityAction::Reset => windows_api::reset_foreground_window_opacity(),
    };

    match result {
        Ok(info) => {
            let verb = match action {
                WindowOpacityAction::Decrease => "已调低透明度",
                WindowOpacityAction::Increase => "已调高透明度",
                WindowOpacityAction::Reset => "已还原透明度",
            };
            let _ = app.emit(
                "manico://shortcut-error",
                format!("{verb}：{} {}%", info.title, info.opacity_percent),
            );
        }
        Err(error) => {
            let _ = app.emit("manico://shortcut-error", format!("窗口调光失败：{error}"));
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_quick_topmost_shortcut<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &app_config::AppSettings,
) {
    match toggle_foreground_topmost(app, &settings.topmost_marker_options) {
        Ok(QuickTopmostResult::Enabled(window)) => {
            let title = window.title.clone();
            let _ = app.emit("manico://topmost-window-upserted", window);
            let _ = app.emit(
                "manico://shortcut-error",
                format!("已置顶当前窗口：{title}"),
            );
        }
        Ok(QuickTopmostResult::Disabled(hwnd)) => {
            let _ = app.emit(
                "manico://topmost-window-removed",
                TopmostWindowRemovedPayload {
                    hwnd,
                    reason: "shortcut",
                },
            );
            let _ = app.emit("manico://shortcut-error", "已取消当前窗口置顶");
        }
        Err(error) => {
            let _ = app.emit("manico://shortcut-error", format!("快速置顶失败：{error}"));
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn toggle_foreground_topmost<R: Runtime>(
    app: &tauri::AppHandle<R>,
    options: &windows_api::TopmostMarkerOptions,
) -> Result<QuickTopmostResult, String> {
    let hwnd =
        windows_api::foreground_window_hwnd().ok_or_else(|| "没有找到当前前台窗口".to_string())?;

    if windows_api::is_window_topmost(hwnd).unwrap_or(false) {
        close_topmost_overlay(app, hwnd);
        windows_api::clear_topmost_window(hwnd)?;
        return Ok(QuickTopmostResult::Disabled(hwnd));
    }

    let window = windows_api::mark_window_topmost(hwnd, options.clone())?;
    create_or_update_topmost_overlay(app, &window)?;
    Ok(QuickTopmostResult::Enabled(window))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn emit_launch_status<R: Runtime>(
    app: &tauri::AppHandle<R>,
    managed_app: &app_config::ManagedApp,
    action: &str,
) {
    let action = match action {
        "hidden" => "已隐藏",
        "restored" => "已恢复",
        "switched" => "已切换到",
        _ => "已启动",
    };
    let _ = app.emit(
        "manico://shortcut-error",
        format!("{action}：{}", managed_app.name),
    );
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn matching_app_shortcut<'a>(
    settings: &'a app_config::AppSettings,
    shortcut: &Shortcut,
) -> Option<&'a app_config::ManagedApp> {
    let mut labels = HashSet::new();

    for managed_app in &settings.apps {
        if shortcut_matches_unique_hotkey(shortcut, managed_app.hotkey.as_ref(), &mut labels) {
            return Some(managed_app);
        }
    }

    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn refresh_app_shortcuts<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &app_config::AppSettings,
) -> Result<(), String> {
    let state = app.state::<AppShortcutState>();
    let mut registered = state
        .registered
        .lock()
        .map_err(|_| "Unable to lock app shortcut state".to_string())?;

    for shortcut in registered.drain(..) {
        let _ = app.global_shortcut().unregister(shortcut);
    }

    let mut labels = HashSet::from(["Ctrl+Q".to_string(), "Win+Esc".to_string()]);
    register_named_hotkey(
        app,
        &mut registered,
        &mut labels,
        Some(&settings.quick_topmost_hotkey),
        "快速置顶",
        "快捷键",
    );
    register_named_hotkey(
        app,
        &mut registered,
        &mut labels,
        Some(&settings.window_opacity_settings.decrease_hotkey),
        "窗口调光",
        "调低透明度",
    );
    register_named_hotkey(
        app,
        &mut registered,
        &mut labels,
        Some(&settings.window_opacity_settings.increase_hotkey),
        "窗口调光",
        "调高透明度",
    );
    register_named_hotkey(
        app,
        &mut registered,
        &mut labels,
        Some(&settings.window_opacity_settings.reset_hotkey),
        "窗口调光",
        "还原透明度",
    );

    for managed_app in &settings.apps {
        register_app_hotkey(
            app,
            &mut registered,
            &mut labels,
            managed_app,
            managed_app.hotkey.as_ref(),
            "启动快捷键",
        );
    }

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn register_named_hotkey<R: Runtime>(
    app: &tauri::AppHandle<R>,
    registered: &mut Vec<Shortcut>,
    labels: &mut HashSet<String>,
    hotkey: Option<&app_config::HotkeyConfig>,
    owner: &str,
    purpose: &str,
) {
    let Some(hotkey) = hotkey else {
        return;
    };
    let Some((modifiers, code, label)) = hotkey_parts(hotkey) else {
        return;
    };
    if !labels.insert(label.clone()) {
        let _ = app.emit(
            "manico://shortcut-error",
            format!("{label} 已被其他功能使用，已跳过：{owner} {purpose}"),
        );
        return;
    }

    let shortcut = Shortcut::new(Some(modifiers), code);
    match app.global_shortcut().register(shortcut.clone()) {
        Ok(()) => registered.push(shortcut),
        Err(error) => {
            let _ = app.emit(
                "manico://shortcut-error",
                format!("{label} 注册失败：{error}"),
            );
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn register_app_hotkey<R: Runtime>(
    app: &tauri::AppHandle<R>,
    registered: &mut Vec<Shortcut>,
    labels: &mut HashSet<String>,
    managed_app: &app_config::ManagedApp,
    hotkey: Option<&app_config::HotkeyConfig>,
    purpose: &str,
) {
    register_named_hotkey(app, registered, labels, hotkey, &managed_app.name, purpose);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn shortcut_matches_hotkey(shortcut: &Shortcut, hotkey: &app_config::HotkeyConfig) -> bool {
    let Some((modifiers, code, _label)) = hotkey_parts(hotkey) else {
        return false;
    };
    shortcut.matches(modifiers, code)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn shortcut_matches_unique_hotkey(
    shortcut: &Shortcut,
    hotkey: Option<&app_config::HotkeyConfig>,
    labels: &mut HashSet<String>,
) -> bool {
    let Some(hotkey) = hotkey else {
        return false;
    };
    let Some((modifiers, code, label)) = hotkey_parts(hotkey) else {
        return false;
    };
    if !labels.insert(label) {
        return false;
    }
    shortcut.matches(modifiers, code)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn hotkey_parts(hotkey: &app_config::HotkeyConfig) -> Option<(Modifiers, Code, String)> {
    let mut modifiers = Modifiers::empty();
    let mut labels = Vec::<String>::new();
    if hotkey.ctrl {
        modifiers |= Modifiers::CONTROL;
        labels.push("Ctrl".to_string());
    }
    if hotkey.alt {
        modifiers |= Modifiers::ALT;
        labels.push("Alt".to_string());
    }
    if hotkey.shift {
        modifiers |= Modifiers::SHIFT;
        labels.push("Shift".to_string());
    }
    if hotkey.win {
        modifiers |= Modifiers::SUPER;
        labels.push("Win".to_string());
    }
    if modifiers.is_empty() {
        return None;
    }

    let key = hotkey.key.trim().to_uppercase();
    let code = key_to_code(&key)?;
    labels.push(key);
    Some((modifiers, code, labels.join("+")))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn key_to_code(key: &str) -> Option<Code> {
    match key {
        "0" => Some(Code::Digit0),
        "1" => Some(Code::Digit1),
        "2" => Some(Code::Digit2),
        "3" => Some(Code::Digit3),
        "4" => Some(Code::Digit4),
        "5" => Some(Code::Digit5),
        "6" => Some(Code::Digit6),
        "7" => Some(Code::Digit7),
        "8" => Some(Code::Digit8),
        "9" => Some(Code::Digit9),
        "A" => Some(Code::KeyA),
        "B" => Some(Code::KeyB),
        "C" => Some(Code::KeyC),
        "D" => Some(Code::KeyD),
        "E" => Some(Code::KeyE),
        "F" => Some(Code::KeyF),
        "G" => Some(Code::KeyG),
        "H" => Some(Code::KeyH),
        "I" => Some(Code::KeyI),
        "J" => Some(Code::KeyJ),
        "K" => Some(Code::KeyK),
        "L" => Some(Code::KeyL),
        "M" => Some(Code::KeyM),
        "N" => Some(Code::KeyN),
        "O" => Some(Code::KeyO),
        "P" => Some(Code::KeyP),
        "Q" => Some(Code::KeyQ),
        "R" => Some(Code::KeyR),
        "S" => Some(Code::KeyS),
        "T" => Some(Code::KeyT),
        "U" => Some(Code::KeyU),
        "V" => Some(Code::KeyV),
        "W" => Some(Code::KeyW),
        "X" => Some(Code::KeyX),
        "Y" => Some(Code::KeyY),
        "Z" => Some(Code::KeyZ),
        "F1" => Some(Code::F1),
        "F2" => Some(Code::F2),
        "F3" => Some(Code::F3),
        "F4" => Some(Code::F4),
        "F5" => Some(Code::F5),
        "F6" => Some(Code::F6),
        "F7" => Some(Code::F7),
        "F8" => Some(Code::F8),
        "F9" => Some(Code::F9),
        "F10" => Some(Code::F10),
        "F11" => Some(Code::F11),
        "F12" => Some(Code::F12),
        _ => None,
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn install_global_shortcuts<R: Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn refresh_app_shortcuts<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    _settings: &app_config::AppSettings,
) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppShortcutState::default())
        .manage(TopmostOverlayState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            install_global_shortcuts(app.handle())?;
            setup_tray(app)?;
            if let Ok(settings_path) = app_config::settings_file(app.handle()) {
                if let Ok(settings) = app_config::read_settings(settings_path) {
                    let _ = refresh_app_shortcuts(app.handle(), &settings);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let minimize_to_tray = app_config::settings_file(window.app_handle())
                    .and_then(app_config::read_settings)
                    .map(|settings| settings.minimize_to_tray)
                    .unwrap_or(true);
                if should_hide_instead_of_close(window.label(), minimize_to_tray) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_windows,
            list_all_windows,
            hide_window,
            show_window,
            pick_topmost_window,
            update_topmost_window_marker,
            clear_topmost_window,
            suspend_process,
            resume_process,
            get_app_settings,
            save_app_settings,
            update_window_bindings,
            upsert_managed_app,
            delete_managed_app,
            resolve_dropped_app,
            launch_managed_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn should_hide_instead_of_close(label: &str, minimize_to_tray: bool) -> bool {
    minimize_to_tray && label == "main"
}

#[cfg(test)]
mod tests {
    use super::{
        marker_update_script, overlay_tracker_interval, should_apply_overlay_bounds,
        should_hide_instead_of_close,
    };
    use crate::windows_api::{OverlayBounds, TopmostWindowInfo};
    use std::time::Duration;

    #[test]
    fn only_main_window_uses_hide_instead_of_close() {
        assert!(should_hide_instead_of_close("main", true));
        assert!(!should_hide_instead_of_close("main", false));
        assert!(!should_hide_instead_of_close(
            "topmost-marker-2099486",
            true
        ));
        assert!(!should_hide_instead_of_close("topmost-marker--42", true));
    }

    #[test]
    fn marker_update_script_updates_existing_overlay_options() {
        let window = TopmostWindowInfo {
            hwnd: 42,
            title: "Pinned".to_string(),
            process_id: 7,
            process_name: "Pinned.exe".to_string(),
            process_path: Some("C:\\Tools\\Pinned.exe".to_string()),
            visible: true,
            marker_color: "#1d9a72".to_string(),
            border_width: 11,
            glow_size: 32,
            opacity: 0.7,
            marker_style: "pulse".to_string(),
        };

        let script = marker_update_script(&window).expect("script should serialize");

        assert!(script.contains("__MANICO_APPLY_MARKER_OPTIONS__"));
        assert!(script.contains("\"marker_color\":\"#1d9a72\""));
        assert!(script.contains("\"border_width\":11"));
        assert!(script.contains("\"glow_size\":32"));
        assert!(script.contains("\"opacity\":0.7"));
        assert!(script.contains("\"marker_style\":\"pulse\""));
    }

    #[test]
    fn overlay_tracker_refreshes_at_interactive_speed() {
        assert!(overlay_tracker_interval() <= Duration::from_millis(33));
    }

    #[test]
    fn overlay_tracker_skips_reapplying_unchanged_bounds() {
        let bounds = OverlayBounds {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
        };
        let moved = OverlayBounds { x: 12, ..bounds };

        assert!(should_apply_overlay_bounds(None, &bounds));
        assert!(!should_apply_overlay_bounds(Some(&bounds), &bounds));
        assert!(should_apply_overlay_bounds(Some(&bounds), &moved));
    }
}
