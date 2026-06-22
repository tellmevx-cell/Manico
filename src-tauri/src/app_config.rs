use crate::windows_api::TopmostMarkerOptions;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{Manager, Runtime};

const STARTUP_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_VALUE_NAME: &str = "Manico";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub groups: Vec<AppGroup>,
    pub apps: Vec<ManagedApp>,
    #[serde(default)]
    pub window_bindings: Vec<WindowBinding>,
    #[serde(default = "default_quick_topmost_hotkey")]
    pub quick_topmost_hotkey: HotkeyConfig,
    #[serde(default)]
    pub topmost_marker_options: TopmostMarkerOptions,
    #[serde(default)]
    pub window_opacity_settings: WindowOpacitySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppGroup {
    pub id: String,
    pub name: String,
    pub order: u32,
    pub is_expanded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedApp {
    pub id: String,
    pub name: String,
    pub executable_path: String,
    pub shortcut_path: Option<String>,
    pub app_user_model_id: Option<String>,
    pub arguments: Option<String>,
    pub working_directory: Option<String>,
    pub group_id: String,
    pub hotkey: Option<HotkeyConfig>,
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HotkeyConfig {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowOpacitySettings {
    pub decrease_hotkey: HotkeyConfig,
    pub increase_hotkey: HotkeyConfig,
    pub reset_hotkey: HotkeyConfig,
    pub step_percent: u8,
    pub min_percent: u8,
}

impl WindowOpacitySettings {
    pub fn normalized(self) -> Self {
        Self {
            decrease_hotkey: self.decrease_hotkey,
            increase_hotkey: self.increase_hotkey,
            reset_hotkey: self.reset_hotkey,
            step_percent: self.step_percent.clamp(5, 30),
            min_percent: self.min_percent.clamp(20, 80),
        }
    }
}

impl Default for WindowOpacitySettings {
    fn default() -> Self {
        Self {
            decrease_hotkey: HotkeyConfig {
                ctrl: true,
                alt: true,
                shift: false,
                win: false,
                key: "1".to_string(),
            },
            increase_hotkey: HotkeyConfig {
                ctrl: true,
                alt: true,
                shift: false,
                win: false,
                key: "2".to_string(),
            },
            reset_hotkey: HotkeyConfig {
                ctrl: true,
                alt: true,
                shift: false,
                win: false,
                key: "0".to_string(),
            },
            step_percent: 10,
            min_percent: 35,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowBinding {
    pub hwnd: isize,
    pub title: String,
    pub process_id: u32,
    pub process_name: String,
    pub process_path: Option<String>,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DroppedAppCandidate {
    pub name: String,
    pub executable_path: String,
    pub shortcut_path: Option<String>,
    pub app_user_model_id: Option<String>,
    pub arguments: Option<String>,
    pub working_directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ShortcutMetadata {
    #[serde(rename = "TargetPath")]
    target_path: Option<String>,
    #[serde(rename = "WorkingDirectory")]
    working_directory: Option<String>,
    #[serde(rename = "Arguments")]
    arguments: Option<String>,
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        start_with_windows: false,
        minimize_to_tray: true,
        groups: vec![AppGroup {
            id: "default".to_string(),
            name: "默认".to_string(),
            order: 0,
            is_expanded: true,
        }],
        apps: Vec::new(),
        window_bindings: Vec::new(),
        quick_topmost_hotkey: default_quick_topmost_hotkey(),
        topmost_marker_options: TopmostMarkerOptions::default(),
        window_opacity_settings: WindowOpacitySettings::default(),
    }
}

pub fn default_quick_topmost_hotkey() -> HotkeyConfig {
    HotkeyConfig {
        ctrl: true,
        alt: true,
        shift: false,
        win: false,
        key: "P".to_string(),
    }
}

pub fn read_settings(path: PathBuf) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(default_settings());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read settings file {}: {error}", path.display()))?;
    let mut settings: AppSettings = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse settings file {}: {error}", path.display()))?;
    settings.topmost_marker_options = settings.topmost_marker_options.normalized();
    settings.window_opacity_settings = settings.window_opacity_settings.normalized();
    Ok(settings)
}

pub fn write_settings(path: PathBuf, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create settings directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let mut normalized = settings.clone();
    normalized.topmost_marker_options = normalized.topmost_marker_options.normalized();
    normalized.window_opacity_settings = normalized.window_opacity_settings.normalized();
    let content = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Unable to serialize settings: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Unable to write settings file {}: {error}", path.display()))
}

pub fn startup_registry_args(exe_path: PathBuf, enabled: bool) -> Vec<String> {
    if enabled {
        vec![
            "ADD".to_string(),
            STARTUP_RUN_KEY.to_string(),
            "/v".to_string(),
            STARTUP_VALUE_NAME.to_string(),
            "/t".to_string(),
            "REG_SZ".to_string(),
            "/d".to_string(),
            format!("\"{}\"", exe_path.display()),
            "/f".to_string(),
        ]
    } else {
        vec![
            "DELETE".to_string(),
            STARTUP_RUN_KEY.to_string(),
            "/v".to_string(),
            STARTUP_VALUE_NAME.to_string(),
            "/f".to_string(),
        ]
    }
}

#[cfg(target_os = "windows")]
pub fn sync_startup_registration(enabled: bool) -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve current executable path: {error}"))?;
    let output = Command::new("reg.exe")
        .args(startup_registry_args(exe_path, enabled))
        .output()
        .map_err(|error| format!("Unable to update Windows startup registration: {error}"))?;

    if output.status.success() || !enabled {
        return Ok(());
    }

    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn sync_startup_registration(_enabled: bool) -> Result<(), String> {
    Ok(())
}

pub fn upsert_app(settings: &mut AppSettings, app: ManagedApp) {
    if let Some(existing) = settings.apps.iter_mut().find(|item| item.id == app.id) {
        *existing = app;
    } else {
        settings.apps.push(app);
    }
    settings.apps.sort_by_key(|item| item.order);
}

pub fn delete_app(settings: &mut AppSettings, id: &str) -> bool {
    let before = settings.apps.len();
    settings.apps.retain(|item| item.id != id);
    before != settings.apps.len()
}

pub fn replace_window_bindings(settings: &mut AppSettings, window_bindings: Vec<WindowBinding>) {
    settings.window_bindings = window_bindings;
}

pub fn resolve_dropped_app(path: String) -> Result<DroppedAppCandidate, String> {
    let source_path = PathBuf::from(path.trim_matches('"'));
    if source_path.as_os_str().is_empty() {
        return Err("Dropped file path is empty".to_string());
    }

    let is_shortcut = source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"));

    let (executable_path, arguments, working_directory) = if is_shortcut {
        let shortcut = resolve_windows_shortcut(&source_path)?;
        let target_path = clean_optional(shortcut.target_path);
        let arguments = clean_optional(shortcut.arguments);
        let app_user_model_id = extract_app_user_model_id(arguments.as_deref());

        let executable_path = if app_user_model_id.is_some() {
            PathBuf::from(r"C:\Windows\explorer.exe")
        } else {
            target_path
                .map(PathBuf::from)
                .unwrap_or_else(|| source_path.clone())
        };

        (
            executable_path,
            arguments,
            clean_optional(shortcut.working_directory).or_else(|| {
                source_path
                    .parent()
                    .map(|parent| parent.to_string_lossy().to_string())
                    .filter(|value| !value.trim().is_empty())
            }),
        )
    } else {
        (
            source_path.clone(),
            None,
            source_path
                .parent()
                .map(|parent| parent.to_string_lossy().to_string())
                .filter(|value| !value.trim().is_empty()),
        )
    };

    let name = file_stem(&source_path)
        .or_else(|| file_stem(&executable_path))
        .unwrap_or_else(|| "新应用".to_string());

    Ok(DroppedAppCandidate {
        name,
        executable_path: executable_path.to_string_lossy().to_string(),
        shortcut_path: is_shortcut.then(|| source_path.to_string_lossy().to_string()),
        app_user_model_id: extract_app_user_model_id(arguments.as_deref()),
        arguments,
        working_directory,
    })
}

fn file_stem(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn extract_app_user_model_id(arguments: Option<&str>) -> Option<String> {
    const PREFIX: &str = "shell:AppsFolder\\";
    let arguments = arguments?;
    let lower = arguments.to_lowercase();
    let index = lower.find(&PREFIX.to_lowercase())?;
    let app_id = arguments[index + PREFIX.len()..].trim().trim_matches('"');
    (!app_id.is_empty()).then(|| app_id.to_string())
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Result<ShortcutMetadata, String> {
    let output = Command::new("powershell.exe")
        .args(shortcut_resolver_powershell_args())
        .env(shortcut_resolver_env_key(), path)
        .output()
        .map_err(|error| format!("Unable to run PowerShell shortcut resolver: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse shortcut metadata: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn resolve_windows_shortcut(path: &Path) -> Result<ShortcutMetadata, String> {
    Err(format!(
        "Shortcut resolving is only available on Windows: {}",
        path.display()
    ))
}

fn shortcut_resolver_env_key() -> &'static str {
    "MANICO_SHORTCUT_PATH"
}

fn shortcut_resolver_script() -> &'static str {
    r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$shortcutPath = [Environment]::GetEnvironmentVariable('MANICO_SHORTCUT_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($shortcutPath)) {
  throw 'Shortcut path is empty'
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
[PSCustomObject]@{
  TargetPath = $shortcut.TargetPath
  WorkingDirectory = $shortcut.WorkingDirectory
  Arguments = $shortcut.Arguments
} | ConvertTo-Json -Compress
"#
}

fn shortcut_resolver_powershell_args() -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        shortcut_resolver_script().to_string(),
    ]
}

pub fn settings_file<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve Manico config directory: {error}"))?;
    Ok(dir.join("settings.json"))
}

#[cfg(test)]
mod tests {
    use super::{
        shortcut_resolver_env_key, shortcut_resolver_powershell_args, shortcut_resolver_script,
    };

    #[test]
    fn shortcut_resolver_uses_environment_for_paths_with_spaces() {
        let args = shortcut_resolver_powershell_args();
        let script = shortcut_resolver_script();

        assert_eq!(args.last().map(String::as_str), Some(script));
        assert!(script.contains(shortcut_resolver_env_key()));
        assert!(!script.contains("$args[0]"));
    }
}
