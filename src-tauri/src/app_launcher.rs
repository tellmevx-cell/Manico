use crate::{app_config::ManagedApp, windows_api};
use serde::Serialize;
use std::{path::Path, process::Command, thread, time::Duration};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LaunchResult {
    pub action: String,
    pub window: Option<windows_api::WindowInfo>,
}

pub fn launch_or_switch_app(app: &ManagedApp) -> Result<LaunchResult, String> {
    let windows = windows_api::list_windows_for_matching()?;
    if let Some(window) = find_matching_window(app, &windows) {
        if should_hide_on_hotkey(&window, windows_api::foreground_window_hwnd()) {
            windows_api::hide_window(window.hwnd)?;
            return Ok(LaunchResult {
                action: "hidden".to_string(),
                window: Some(window),
            });
        }

        windows_api::show_window(window.hwnd)?;
        let action = if window.visible {
            "switched"
        } else {
            "restored"
        };
        return Ok(LaunchResult {
            action: action.to_string(),
            window: Some(window),
        });
    }

    start_process(app)?;

    for _ in 0..80 {
        thread::sleep(Duration::from_millis(125));
        let windows = windows_api::list_windows_for_matching()?;
        if let Some(window) = find_matching_window(app, &windows) {
            let _ = windows_api::show_window(window.hwnd);
            return Ok(LaunchResult {
                action: "launched".to_string(),
                window: Some(window),
            });
        }
    }

    Ok(LaunchResult {
        action: "launched".to_string(),
        window: None,
    })
}

pub fn should_hide_on_hotkey(
    window: &windows_api::WindowInfo,
    foreground_hwnd: Option<isize>,
) -> bool {
    window.visible && foreground_hwnd == Some(window.hwnd)
}

pub fn find_matching_window(
    app: &ManagedApp,
    windows: &[windows_api::WindowInfo],
) -> Option<windows_api::WindowInfo> {
    let target_path = normalize_path(&app.executable_path);

    if !should_skip_exact_path_match(&app.executable_path) {
        if let Some(window) = best_matching_window(windows, |window| {
            window
                .process_path
                .as_deref()
                .map(normalize_path)
                .is_some_and(|path| path == target_path)
        }) {
            return Some(window.clone());
        }
    }

    if let Some(target_name) = executable_name(&app.executable_path) {
        if let Some(window) = best_matching_window(windows, |window| {
            window.process_name.eq_ignore_ascii_case(&target_name)
        }) {
            return Some(window.clone());
        }
    }

    let names = matching_names(app);
    best_matching_window(windows, |window| {
        let title = window.title.to_lowercase();
        let process_name = window.process_name.to_lowercase();
        names.iter().any(|name| {
            let name = name.to_lowercase();
            name.len() >= 2 && (title.contains(&name) || process_name.contains(&name))
        })
    })
    .cloned()
}

fn best_matching_window(
    windows: &[windows_api::WindowInfo],
    predicate: impl Fn(&windows_api::WindowInfo) -> bool,
) -> Option<&windows_api::WindowInfo> {
    let mut best: Option<(&windows_api::WindowInfo, (u8, u64, u8, usize))> = None;

    for window in windows.iter().filter(|window| predicate(window)) {
        let score = window_preference_score(window);
        if best.map_or(true, |(_, best_score)| score > best_score) {
            best = Some((window, score));
        }
    }

    best.map(|(window, _)| window)
}

fn window_preference_score(window: &windows_api::WindowInfo) -> (u8, u64, u8, usize) {
    let area = window_area(window);
    let size_bucket = match area {
        150_000.. => 3,
        40_000..=149_999 => 2,
        10_000..=39_999 => 1,
        _ => 0,
    };

    (
        size_bucket,
        area,
        u8::from(window.visible),
        window.title.chars().count().min(80),
    )
}

fn window_area(window: &windows_api::WindowInfo) -> u64 {
    window
        .rect
        .map(|rect| rect.width as u64 * rect.height as u64)
        .unwrap_or(0)
}

pub fn split_command_line_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in input.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

fn start_process(app: &ManagedApp) -> Result<(), String> {
    if app.executable_path.trim().is_empty() {
        return Err("Executable path is empty".to_string());
    }

    if app
        .app_user_model_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return start_app_user_model_id(app);
    }

    if should_launch_with_shell(&app.executable_path) {
        return start_with_shell(app);
    }

    let mut command = Command::new(&app.executable_path);

    if let Some(arguments) = app
        .arguments
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.args(split_command_line_args(arguments));
    }

    if let Some(working_directory) = app
        .working_directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.current_dir(working_directory);
    }

    command
        .spawn()
        .map(|_| ())
        .or_else(|_| start_shortcut_fallback(app))
        .map_err(|error| format!("Unable to launch {}: {error}", app.executable_path))
}

fn start_app_user_model_id(app: &ManagedApp) -> Result<(), String> {
    let app_id = app
        .app_user_model_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AppUserModelId is empty".to_string())?;

    Command::new("explorer.exe")
        .arg(format!(r"shell:AppsFolder\{app_id}"))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to launch app id {app_id}: {error}"))
}

fn start_with_shell(app: &ManagedApp) -> Result<(), String> {
    let mut command = Command::new("cmd.exe");
    command.args(["/C", "start", "", &app.executable_path]);

    if let Some(arguments) = app
        .arguments
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.args(split_command_line_args(arguments));
    }

    if let Some(working_directory) = app
        .working_directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.current_dir(working_directory);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open shortcut {}: {error}", app.executable_path))
}

fn start_shortcut_fallback(app: &ManagedApp) -> Result<(), std::io::Error> {
    let shortcut_path = app
        .shortcut_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "shortcut path missing")
        })?;

    Command::new("cmd.exe")
        .args(["/C", "start", "", shortcut_path])
        .spawn()
        .map(|_| ())
}

fn should_launch_with_shell(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    ["lnk", "url", "appref-ms"]
        .iter()
        .any(|item| extension.eq_ignore_ascii_case(item))
}

fn should_skip_exact_path_match(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("explorer.exe"))
}

fn matching_names(app: &ManagedApp) -> Vec<String> {
    let mut names = Vec::new();
    push_name(&mut names, &app.name);
    push_path_stem(&mut names, &app.executable_path);
    if let Some(shortcut_path) = app.shortcut_path.as_deref() {
        push_path_stem(&mut names, shortcut_path);
    }
    if let Some(app_id) = app.app_user_model_id.as_deref() {
        push_name(&mut names, &app_id.replace(['.', '_', '!', '-'], " "));
    }
    names
}

fn push_path_stem(names: &mut Vec<String>, path: &str) {
    if let Some(stem) = Path::new(path).file_stem().and_then(|value| value.to_str()) {
        push_name(names, stem);
    }
}

fn push_name(names: &mut Vec<String>, name: &str) {
    let name = name.trim();
    if !name.is_empty() && !names.iter().any(|item| item.eq_ignore_ascii_case(name)) {
        names.push(name.to_string());
    }
}

fn executable_name(path: &str) -> Option<String> {
    let file_name = path
        .rsplit(['\\', '/'])
        .next()
        .filter(|value| !value.is_empty())?;
    if Path::new(file_name).extension().is_some() {
        Some(file_name.to_string())
    } else {
        Some(format!("{file_name}.exe"))
    }
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::find_matching_window;
    use crate::{
        app_config::ManagedApp,
        windows_api::{WindowInfo, WindowRect},
    };

    fn app(path: &str) -> ManagedApp {
        ManagedApp {
            id: "moba".to_string(),
            name: "MobaXterm".to_string(),
            executable_path: path.to_string(),
            shortcut_path: None,
            app_user_model_id: None,
            arguments: None,
            working_directory: None,
            group_id: "default".to_string(),
            hotkey: None,
            order: 0,
        }
    }

    fn window(hwnd: isize, title: &str, width: u32, height: u32) -> WindowInfo {
        WindowInfo {
            hwnd,
            title: title.to_string(),
            process_id: 1200,
            process_name: "MobaXterm.exe".to_string(),
            process_path: Some("C:\\Tools\\MobaXterm\\MobaXterm.exe".to_string()),
            visible: true,
            rect: Some(WindowRect {
                x: 0,
                y: 0,
                width,
                height,
            }),
            class_name: None,
            style: None,
            ex_style: None,
            owner_hwnd: None,
            cloaked: false,
        }
    }

    #[test]
    fn exact_path_match_prefers_larger_main_window_over_small_auxiliary_window() {
        let small_auxiliary_window = window(10, "MobaXterm", 460, 155);
        let main_window = window(20, "MobaXterm Professional", 1280, 820);

        let matched = find_matching_window(
            &app("C:\\Tools\\MobaXterm\\MobaXterm.exe"),
            &[small_auxiliary_window, main_window],
        );

        assert_eq!(matched.map(|window| window.hwnd), Some(20));
    }
}
