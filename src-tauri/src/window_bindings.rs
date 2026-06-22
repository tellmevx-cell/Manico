use crate::{
    app_config::WindowBinding,
    windows_api::{self, WindowInfo},
};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

static HIDDEN_BOUND_WINDOWS: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();
const MIN_USER_WINDOW_WIDTH: u32 = 240;
const MIN_USER_WINDOW_HEIGHT: u32 = 160;
const MIN_USER_WINDOW_AREA: u64 = 60_000;
const WS_CHILD_STYLE: u32 = 0x4000_0000;
const WS_EX_TOOLWINDOW_STYLE: u32 = 0x0000_0080;
const WS_EX_APPWINDOW_STYLE: u32 = 0x0004_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    Hidden,
    Restored,
    NoBindings,
    NoTargets,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToggleResult {
    pub action: ToggleAction,
    pub count: usize,
    pub binding_count: usize,
}

pub fn toggle_bound_windows(bindings: &[WindowBinding]) -> Result<ToggleResult, String> {
    if bindings.is_empty() {
        return Ok(ToggleResult {
            action: ToggleAction::NoBindings,
            count: 0,
            binding_count: 0,
        });
    }

    let binding_count = bindings.len();
    let windows = windows_api::list_windows_for_matching()?;
    let targets = matching_bound_windows(&windows, bindings);

    let mut hidden_handles = hidden_bound_windows()
        .lock()
        .map_err(|_| "Unable to lock hidden window state".to_string())?;
    hidden_handles.retain(|hwnd| {
        targets
            .iter()
            .any(|window| window.hwnd == *hwnd && !window.visible)
    });

    let (action, planned_targets) = toggle_plan(&targets, &hidden_handles);

    if planned_targets.is_empty() {
        return Ok(ToggleResult {
            action,
            count: 0,
            binding_count,
        });
    }

    if action == ToggleAction::Restored {
        let mut count = 0;
        for window in planned_targets {
            windows_api::show_window(window.hwnd)?;
            hidden_handles.remove(&window.hwnd);
            count += 1;
        }

        return Ok(ToggleResult {
            action: ToggleAction::Restored,
            count,
            binding_count,
        });
    }

    let mut count = 0;
    for window in planned_targets {
        windows_api::hide_window(window.hwnd)?;
        hidden_handles.insert(window.hwnd);
        count += 1;
    }

    Ok(ToggleResult {
        action: ToggleAction::Hidden,
        count,
        binding_count,
    })
}

pub fn matching_bound_windows(
    windows: &[WindowInfo],
    bindings: &[WindowBinding],
) -> Vec<WindowInfo> {
    let mut matches = Vec::new();
    for window in windows {
        if bindings
            .iter()
            .any(|binding| window_matches_binding(window, binding))
            && is_user_bound_window(window)
            && !matches
                .iter()
                .any(|item: &WindowInfo| item.hwnd == window.hwnd)
        {
            matches.push(window.clone());
        }
    }
    matches
}

pub fn matching_bound_internal_windows(
    windows: &[WindowInfo],
    bindings: &[WindowBinding],
) -> Vec<WindowInfo> {
    let mut matches = Vec::new();
    for window in windows {
        if bindings
            .iter()
            .any(|binding| window_matches_binding(window, binding))
            && is_internal_bound_window(window)
            && !matches
                .iter()
                .any(|item: &WindowInfo| item.hwnd == window.hwnd)
        {
            matches.push(window.clone());
        }
    }
    matches
}

pub fn window_matches_binding(window: &WindowInfo, binding: &WindowBinding) -> bool {
    let window_path = normalize_path(window.process_path.as_deref());
    let binding_path = normalize_path(binding.process_path.as_deref());

    if let (Some(window_path), Some(binding_path)) = (window_path, binding_path) {
        return window_path == binding_path;
    }

    if !window.process_name.trim().is_empty() && !binding.process_name.trim().is_empty() {
        return window
            .process_name
            .eq_ignore_ascii_case(&binding.process_name);
    }

    window.process_id == binding.process_id
}

pub fn toggle_plan(
    targets: &[WindowInfo],
    hidden_by_manico: &HashSet<isize>,
) -> (ToggleAction, Vec<WindowInfo>) {
    let restore_targets = targets
        .iter()
        .filter(|window| !window.visible && hidden_by_manico.contains(&window.hwnd))
        .cloned()
        .collect::<Vec<_>>();
    if !restore_targets.is_empty() {
        return (ToggleAction::Restored, restore_targets);
    }

    let hide_targets = targets
        .iter()
        .filter(|window| window.visible)
        .cloned()
        .collect::<Vec<_>>();
    if !hide_targets.is_empty() {
        return (ToggleAction::Hidden, hide_targets);
    }

    (ToggleAction::NoTargets, Vec::new())
}

pub fn status_message(result: ToggleResult) -> String {
    match result.action {
        ToggleAction::Hidden => format!(
            "Ctrl+Q 已隐藏 {} 个绑定进程，实际处理 {} 个窗口",
            result.binding_count, result.count
        ),
        ToggleAction::Restored => format!(
            "Ctrl+Q 已恢复 {} 个绑定进程，实际处理 {} 个窗口",
            result.binding_count, result.count
        ),
        ToggleAction::NoBindings => "还没有绑定窗口，请先进入窗口绑定页添加窗口".to_string(),
        ToggleAction::NoTargets => "未找到已绑定进程的当前窗口".to_string(),
    }
}

fn normalize_path(path: Option<&str>) -> Option<String> {
    path.map(|value| value.trim().replace('/', "\\").to_lowercase())
        .filter(|value| !value.is_empty())
}

fn hidden_bound_windows() -> &'static Mutex<HashSet<isize>> {
    HIDDEN_BOUND_WINDOWS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_user_bound_window(window: &WindowInfo) -> bool {
    !is_internal_bound_window(window)
}

fn is_internal_bound_window(window: &WindowInfo) -> bool {
    let title = window.title.trim().to_lowercase();
    let process_name = window.process_name.trim().to_lowercase();
    let process_path = window
        .process_path
        .as_deref()
        .unwrap_or_default()
        .trim()
        .replace('/', "\\")
        .to_lowercase();

    if matches!(
        title.as_str(),
        "default ime"
            | "msctfime ui"
            | "cicerouiwndframe"
            | "program manager"
            | "dde server window"
    ) {
        return true;
    }

    if title.contains("wxtrayiconmessagewindow")
        || title.contains(".net-broadcasteventwindow")
        || title.contains("notificationwindow")
        || title.contains("messagewindow")
    {
        return true;
    }

    if window.cloaked
        || is_tool_window(window)
        || is_child_window(window)
        || is_owned_tool_window(window)
    {
        return true;
    }

    if !has_user_window_size(window) {
        return true;
    }

    let is_wechat =
        process_name.eq_ignore_ascii_case("weixin.exe") || process_path.ends_with("\\weixin.exe");
    is_wechat && title == "weixin"
}

fn is_tool_window(window: &WindowInfo) -> bool {
    window
        .ex_style
        .map(|style| style & WS_EX_TOOLWINDOW_STYLE != 0)
        .unwrap_or(false)
}

fn is_child_window(window: &WindowInfo) -> bool {
    window
        .style
        .map(|style| style & WS_CHILD_STYLE != 0)
        .unwrap_or(false)
}

fn is_owned_tool_window(window: &WindowInfo) -> bool {
    window.owner_hwnd.is_some()
        && window
            .ex_style
            .map(|style| style & WS_EX_APPWINDOW_STYLE == 0)
            .unwrap_or(true)
}

fn has_user_window_size(window: &WindowInfo) -> bool {
    let Some(rect) = window.rect else {
        return true;
    };

    if rect.width < MIN_USER_WINDOW_WIDTH || rect.height < MIN_USER_WINDOW_HEIGHT {
        return false;
    }

    (rect.width as u64 * rect.height as u64) >= MIN_USER_WINDOW_AREA
}

#[cfg(test)]
mod tests {
    use super::{
        matching_bound_internal_windows, matching_bound_windows, status_message, toggle_plan,
        window_matches_binding, ToggleAction, ToggleResult, WS_CHILD_STYLE, WS_EX_TOOLWINDOW_STYLE,
    };
    use crate::{app_config::WindowBinding, windows_api::WindowInfo};
    use std::collections::HashSet;

    fn window(
        hwnd: isize,
        process_name: &str,
        process_path: Option<&str>,
        visible: bool,
    ) -> WindowInfo {
        window_with_title(
            hwnd,
            &format!("window-{hwnd}"),
            process_name,
            process_path,
            visible,
        )
    }

    fn window_with_title(
        hwnd: isize,
        title: &str,
        process_name: &str,
        process_path: Option<&str>,
        visible: bool,
    ) -> WindowInfo {
        WindowInfo {
            hwnd,
            title: title.to_string(),
            process_id: hwnd as u32,
            process_name: process_name.to_string(),
            process_path: process_path.map(str::to_string),
            visible,
            rect: None,
            class_name: None,
            style: None,
            ex_style: None,
            owner_hwnd: None,
            cloaked: false,
        }
    }

    fn window_with_rect(
        hwnd: isize,
        title: &str,
        process_name: &str,
        process_path: Option<&str>,
        visible: bool,
        width: u32,
        height: u32,
    ) -> WindowInfo {
        let mut window = window_with_title(hwnd, title, process_name, process_path, visible);
        window.rect = Some(crate::windows_api::WindowRect {
            x: 0,
            y: 0,
            width,
            height,
        });
        window
    }

    fn binding(hwnd: isize, process_name: &str, process_path: Option<&str>) -> WindowBinding {
        WindowBinding {
            hwnd,
            title: format!("binding-{hwnd}"),
            process_id: hwnd as u32,
            process_name: process_name.to_string(),
            process_path: process_path.map(str::to_string),
            visible: true,
        }
    }

    #[test]
    fn matches_by_process_path_before_process_name() {
        let opera_binding = binding(1, "opera.exe", Some("C:/Apps/Opera/opera.exe"));

        assert!(window_matches_binding(
            &window(2, "opera.exe", Some("C:\\Apps\\Opera\\opera.exe"), true),
            &opera_binding
        ));
        assert!(!window_matches_binding(
            &window(3, "opera.exe", Some("C:\\Other\\opera.exe"), true),
            &opera_binding
        ));
        assert!(window_matches_binding(
            &window(4, "opera.exe", None, true),
            &binding(5, "OPERA.EXE", None)
        ));
    }

    #[test]
    fn collects_all_windows_for_bound_processes() {
        let matches = matching_bound_windows(
            &[
                window(10, "Code.exe", Some("C:\\Tools\\Code.exe"), true),
                window(11, "Code.exe", Some("C:\\Tools\\Code.exe"), false),
                window(12, "opera.exe", Some("C:\\Apps\\Opera\\opera.exe"), true),
            ],
            &[binding(20, "Code.exe", Some("C:\\Tools\\Code.exe"))],
        );

        assert_eq!(
            matches.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn skips_wechat_internal_windows_when_matching_bound_processes() {
        let matches = matching_bound_windows(
            &[
                window_with_title(
                    10,
                    "邹顺江",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    true,
                ),
                window_with_title(
                    11,
                    "Weixin",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    true,
                ),
                window_with_title(
                    12,
                    "WxTrayIconMessageWindow",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    false,
                ),
                window_with_title(
                    13,
                    "Default IME",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    false,
                ),
            ],
            &[binding(20, "Weixin.exe", Some("C:\\Wechat\\Weixin.exe"))],
        );

        assert_eq!(
            matches.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![10]
        );
    }

    #[test]
    fn skips_small_auxiliary_windows_when_matching_bound_processes() {
        let matches = matching_bound_windows(
            &[
                window_with_rect(
                    10,
                    "QQ",
                    "QQ.exe",
                    Some("C:\\Tencent\\QQ.exe"),
                    true,
                    140,
                    90,
                ),
                window_with_rect(
                    11,
                    "QQ",
                    "QQ.exe",
                    Some("C:\\Tencent\\QQ.exe"),
                    true,
                    860,
                    640,
                ),
                window_with_rect(
                    12,
                    "QQToast",
                    "QQ.exe",
                    Some("C:\\Tencent\\QQ.exe"),
                    false,
                    220,
                    120,
                ),
            ],
            &[binding(20, "QQ.exe", Some("C:\\Tencent\\QQ.exe"))],
        );

        assert_eq!(
            matches.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![11]
        );
    }

    #[test]
    fn skips_native_auxiliary_window_shapes_when_matching_bound_processes() {
        let mut tool_window = window_with_rect(
            10,
            "QQ工具窗",
            "QQ.exe",
            Some("C:\\Tencent\\QQ.exe"),
            true,
            500,
            400,
        );
        tool_window.ex_style = Some(WS_EX_TOOLWINDOW_STYLE);

        let mut child_window = window_with_rect(
            11,
            "QQ子窗口",
            "QQ.exe",
            Some("C:\\Tencent\\QQ.exe"),
            true,
            500,
            400,
        );
        child_window.style = Some(WS_CHILD_STYLE);

        let mut owned_popup = window_with_rect(
            12,
            "QQ浮层",
            "QQ.exe",
            Some("C:\\Tencent\\QQ.exe"),
            true,
            500,
            400,
        );
        owned_popup.owner_hwnd = Some(99);

        let mut cloaked_window = window_with_rect(
            13,
            "QQ预加载",
            "QQ.exe",
            Some("C:\\Tencent\\QQ.exe"),
            true,
            500,
            400,
        );
        cloaked_window.cloaked = true;

        let matches = matching_bound_windows(
            &[
                tool_window,
                child_window,
                owned_popup,
                cloaked_window,
                window_with_rect(
                    14,
                    "QQ",
                    "QQ.exe",
                    Some("C:\\Tencent\\QQ.exe"),
                    true,
                    860,
                    640,
                ),
            ],
            &[binding(20, "QQ.exe", Some("C:\\Tencent\\QQ.exe"))],
        );

        assert_eq!(
            matches.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![14]
        );
    }

    #[test]
    fn finds_visible_internal_bound_windows_for_cleanup_only() {
        let internals = matching_bound_internal_windows(
            &[
                window_with_title(
                    10,
                    "邹顺江",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    true,
                ),
                window_with_title(
                    11,
                    "Weixin",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    true,
                ),
                window_with_title(
                    12,
                    "Default IME",
                    "Weixin.exe",
                    Some("C:\\Wechat\\Weixin.exe"),
                    true,
                ),
            ],
            &[binding(20, "Weixin.exe", Some("C:\\Wechat\\Weixin.exe"))],
        );

        assert_eq!(
            internals.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![11, 12]
        );
    }

    #[test]
    fn hidden_windows_not_hidden_by_manico_do_not_trigger_restore() {
        let targets = vec![
            window_with_title(
                10,
                "邹顺江",
                "Weixin.exe",
                Some("C:\\Wechat\\Weixin.exe"),
                true,
            ),
            window_with_title(
                11,
                "微信",
                "Weixin.exe",
                Some("C:\\Wechat\\Weixin.exe"),
                false,
            ),
        ];
        let hidden_by_manico = HashSet::new();

        let (action, planned) = toggle_plan(&targets, &hidden_by_manico);

        assert_eq!(action, ToggleAction::Hidden);
        assert_eq!(
            planned.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![10]
        );
    }

    #[test]
    fn restores_only_windows_hidden_by_manico() {
        let targets = vec![
            window_with_title(
                10,
                "邹顺江",
                "Weixin.exe",
                Some("C:\\Wechat\\Weixin.exe"),
                true,
            ),
            window_with_title(
                11,
                "微信",
                "Weixin.exe",
                Some("C:\\Wechat\\Weixin.exe"),
                false,
            ),
            window_with_title(
                12,
                "微信",
                "Weixin.exe",
                Some("C:\\Wechat\\Weixin.exe"),
                false,
            ),
        ];
        let hidden_by_manico = HashSet::from([12]);

        let (action, planned) = toggle_plan(&targets, &hidden_by_manico);

        assert_eq!(action, ToggleAction::Restored);
        assert_eq!(
            planned.iter().map(|item| item.hwnd).collect::<Vec<_>>(),
            vec![12]
        );
    }

    #[test]
    fn formats_shortcut_status() {
        assert_eq!(
            status_message(ToggleResult {
                action: ToggleAction::Restored,
                count: 2,
                binding_count: 2,
            }),
            "Ctrl+Q 已恢复 2 个绑定进程，实际处理 2 个窗口"
        );
    }

    #[test]
    fn formats_binding_count_separately_from_window_count() {
        assert_eq!(
            status_message(ToggleResult {
                action: ToggleAction::Restored,
                count: 7,
                binding_count: 2,
            }),
            "Ctrl+Q 已恢复 2 个绑定进程，实际处理 7 个窗口"
        );
    }
}
