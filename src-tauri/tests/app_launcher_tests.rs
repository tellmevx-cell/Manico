use manico_lib::{
    app_config::ManagedApp,
    app_launcher::{find_matching_window, should_hide_on_hotkey, split_command_line_args},
    windows_api::WindowInfo,
};

fn app(path: &str) -> ManagedApp {
    ManagedApp {
        id: "rider".to_string(),
        name: "Rider".to_string(),
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

fn window(hwnd: isize, process_path: Option<&str>, process_name: &str) -> WindowInfo {
    WindowInfo {
        hwnd,
        title: format!("window-{hwnd}"),
        process_id: hwnd as u32,
        process_name: process_name.to_string(),
        process_path: process_path.map(str::to_string),
        visible: true,
        rect: None,
        class_name: None,
        style: None,
        ex_style: None,
        owner_hwnd: None,
        cloaked: false,
    }
}

fn titled_window(
    hwnd: isize,
    title: &str,
    process_path: Option<&str>,
    process_name: &str,
) -> WindowInfo {
    WindowInfo {
        hwnd,
        title: title.to_string(),
        process_id: hwnd as u32,
        process_name: process_name.to_string(),
        process_path: process_path.map(str::to_string),
        visible: true,
        rect: None,
        class_name: None,
        style: None,
        ex_style: None,
        owner_hwnd: None,
        cloaked: false,
    }
}

fn hidden_window(
    hwnd: isize,
    title: &str,
    process_path: Option<&str>,
    process_name: &str,
) -> WindowInfo {
    WindowInfo {
        hwnd,
        title: title.to_string(),
        process_id: hwnd as u32,
        process_name: process_name.to_string(),
        process_path: process_path.map(str::to_string),
        visible: false,
        rect: None,
        class_name: None,
        style: None,
        ex_style: None,
        owner_hwnd: None,
        cloaked: false,
    }
}

#[test]
fn find_matching_window_prefers_exact_executable_path() {
    let windows = vec![
        window(10, Some("C:\\Other\\rider64.exe"), "rider64.exe"),
        window(
            20,
            Some("C:\\Tools\\Rider\\bin\\rider64.exe"),
            "rider64.exe",
        ),
    ];

    let matched = find_matching_window(&app("C:\\Tools\\Rider\\bin\\rider64.exe"), &windows);

    assert_eq!(matched.map(|item| item.hwnd), Some(20));
}

#[test]
fn find_matching_window_falls_back_to_process_name_when_path_is_unavailable() {
    let windows = vec![window(30, None, "rider64.exe")];

    let matched = find_matching_window(&app("C:\\Tools\\Rider\\bin\\rider64.exe"), &windows);

    assert_eq!(matched.map(|item| item.hwnd), Some(30));
}

#[test]
fn find_matching_window_falls_back_to_shortcut_name_for_shell_apps() {
    let mut shortcut_app = app("C:\\Users\\Public\\Desktop\\策牛股票.lnk");
    shortcut_app.name = "策牛股票".to_string();
    shortcut_app.shortcut_path = Some("C:\\Users\\Public\\Desktop\\策牛股票.lnk".to_string());

    let windows = vec![titled_window(
        40,
        "策牛股票 - 行情终端",
        None,
        "ApplicationFrameHost.exe",
    )];

    let matched = find_matching_window(&shortcut_app, &windows);

    assert_eq!(matched.map(|item| item.hwnd), Some(40));
}

#[test]
fn find_matching_window_can_match_hidden_tray_windows() {
    let windows = vec![hidden_window(
        50,
        "Shortcut Tool",
        Some("C:\\Tools\\ShortcutTool.exe"),
        "ShortcutTool.exe",
    )];

    let matched = find_matching_window(&app("C:\\Tools\\ShortcutTool.exe"), &windows);

    assert_eq!(
        matched.map(|item| (item.hwnd, item.visible)),
        Some((50, false))
    );
}

#[test]
fn should_hide_only_when_window_is_visible_and_foreground() {
    let visible = window(
        60,
        Some("C:\\Tools\\Rider\\bin\\rider64.exe"),
        "rider64.exe",
    );
    let hidden = hidden_window(
        70,
        "Rider",
        Some("C:\\Tools\\Rider\\bin\\rider64.exe"),
        "rider64.exe",
    );

    assert!(should_hide_on_hotkey(&visible, Some(60)));
    assert!(!should_hide_on_hotkey(&visible, Some(61)));
    assert!(!should_hide_on_hotkey(&hidden, Some(70)));
    assert!(!should_hide_on_hotkey(&visible, None));
}

#[test]
fn split_command_line_args_preserves_quoted_segments() {
    let args = split_command_line_args("--profile \"Work Space\" --safe-mode");

    assert_eq!(args, vec!["--profile", "Work Space", "--safe-mode"]);
}
