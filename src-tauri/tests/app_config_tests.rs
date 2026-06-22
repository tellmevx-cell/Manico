use manico_lib::app_config::{
    default_settings, delete_app, read_settings, replace_window_bindings, startup_registry_args,
    upsert_app, AppSettings, HotkeyConfig, ManagedApp, WindowBinding, WindowOpacitySettings,
};
use manico_lib::windows_api::TopmostMarkerOptions;
use std::{fs, path::PathBuf};

fn sample_app(id: &str, order: u32) -> ManagedApp {
    ManagedApp {
        id: id.to_string(),
        name: "JetBrains Rider".to_string(),
        executable_path: "C:\\Tools\\Rider\\bin\\rider64.exe".to_string(),
        shortcut_path: None,
        app_user_model_id: None,
        arguments: None,
        working_directory: Some("C:\\Tools\\Rider\\bin".to_string()),
        group_id: "default".to_string(),
        hotkey: Some(HotkeyConfig {
            ctrl: false,
            alt: true,
            shift: false,
            win: false,
            key: "R".to_string(),
        }),
        order,
    }
}

fn sample_binding(hwnd: isize, process_name: &str) -> WindowBinding {
    WindowBinding {
        hwnd,
        title: format!("window-{hwnd}"),
        process_id: hwnd as u32,
        process_name: process_name.to_string(),
        process_path: Some(format!("C:\\Tools\\{process_name}")),
        visible: true,
    }
}

#[test]
fn default_settings_include_the_default_group() {
    let settings = default_settings();

    assert!(settings.minimize_to_tray);
    assert_eq!(settings.groups.len(), 1);
    assert_eq!(settings.groups[0].id, "default");
    assert!(settings.apps.is_empty());
    assert!(settings.window_bindings.is_empty());
    assert_eq!(settings.quick_topmost_hotkey.key, "P");
    assert!(settings.quick_topmost_hotkey.ctrl);
    assert!(settings.quick_topmost_hotkey.alt);
    assert_eq!(
        settings.topmost_marker_options,
        TopmostMarkerOptions::default()
    );
    assert_eq!(
        settings.window_opacity_settings,
        WindowOpacitySettings::default()
    );
}

#[test]
fn upsert_app_replaces_existing_app_and_preserves_order() {
    let mut settings = AppSettings {
        apps: vec![sample_app("rider", 0)],
        ..default_settings()
    };
    let mut updated = sample_app("rider", 9);
    updated.name = "Rider 2026".to_string();

    upsert_app(&mut settings, updated);

    assert_eq!(settings.apps.len(), 1);
    assert_eq!(settings.apps[0].name, "Rider 2026");
    assert_eq!(settings.apps[0].order, 9);
}

#[test]
fn delete_app_removes_the_matching_id_only() {
    let mut settings = AppSettings {
        apps: vec![sample_app("rider", 0), sample_app("terminal", 1)],
        ..default_settings()
    };

    assert!(delete_app(&mut settings, "rider"));
    assert_eq!(settings.apps.len(), 1);
    assert_eq!(settings.apps[0].id, "terminal");
    assert!(!delete_app(&mut settings, "missing"));
}

#[test]
fn replace_window_bindings_updates_only_binding_list() {
    let mut settings = AppSettings {
        start_with_windows: true,
        apps: vec![sample_app("rider", 0)],
        window_bindings: vec![sample_binding(10, "Weixin.exe")],
        ..default_settings()
    };
    let next_bindings = vec![sample_binding(20, "QQ.exe")];

    replace_window_bindings(&mut settings, next_bindings.clone());

    assert!(settings.start_with_windows);
    assert_eq!(settings.apps.len(), 1);
    assert_eq!(settings.apps[0].id, "rider");
    assert_eq!(settings.window_bindings, next_bindings);
}

#[test]
fn read_settings_accepts_legacy_files_without_window_bindings() {
    let path = temp_settings_path("legacy-settings.json");
    fs::write(
        &path,
        r#"{
  "start_with_windows": false,
  "minimize_to_tray": true,
  "groups": [],
  "apps": []
}"#,
    )
    .expect("write legacy settings");

    let settings = read_settings(path.clone()).expect("read settings");

    assert!(settings.window_bindings.is_empty());
    assert_eq!(settings.quick_topmost_hotkey.key, "P");
    assert_eq!(
        settings.topmost_marker_options,
        TopmostMarkerOptions::default()
    );
    assert_eq!(
        settings.window_opacity_settings,
        WindowOpacitySettings::default()
    );
    let _ = fs::remove_file(path);
}

#[test]
fn startup_registry_args_quote_the_executable_path() {
    let args = startup_registry_args(PathBuf::from("C:\\Program Files\\Manico\\manico.exe"), true);

    assert_eq!(args[0], "ADD");
    assert!(args.contains(&"/v".to_string()));
    assert!(args.contains(&"Manico".to_string()));
    assert!(args.contains(&"\"C:\\Program Files\\Manico\\manico.exe\"".to_string()));
}

fn temp_settings_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("manico-{name}-{}", std::process::id()))
}
