use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::ptr::null_mut;

#[cfg(target_os = "windows")]
use std::{
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, BOOL, COLORREF, HANDLE, HWND, LPARAM, POINT, RECT},
    Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CLOAKED,
    },
    System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
    UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetCursorPos,
        GetForegroundWindow, GetLayeredWindowAttributes, GetWindow, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindow, IsWindowVisible, LoadCursorW, SetCursor, SetForegroundWindow,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint,
        GA_ROOT, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST,
        IDC_CROSS, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
        SW_RESTORE, SW_SHOW, WS_EX_LAYERED, WS_EX_TOPMOST,
    },
};

const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
const DEFAULT_MARKER_COLOR: &str = "#ef4444";
const DEFAULT_BORDER_WIDTH: u32 = 6;
const DEFAULT_GLOW_SIZE: u32 = 24;
const DEFAULT_MARKER_OPACITY: f64 = 0.9;
#[cfg(target_os = "windows")]
const DWMWA_COLOR_DEFAULT: u32 = 0xFFFFFFFF;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub process_id: u32,
    pub process_name: String,
    pub process_path: Option<String>,
    pub visible: bool,
    #[serde(default)]
    pub rect: Option<WindowRect>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub style: Option<u32>,
    #[serde(default)]
    pub ex_style: Option<u32>,
    #[serde(default)]
    pub owner_hwnd: Option<isize>,
    #[serde(default)]
    pub cloaked: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopmostWindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub process_id: u32,
    pub process_name: String,
    pub process_path: Option<String>,
    pub visible: bool,
    pub marker_color: String,
    pub border_width: u32,
    pub glow_size: u32,
    pub opacity: f64,
    pub marker_style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowOpacityInfo {
    pub hwnd: isize,
    pub title: String,
    pub opacity_percent: u8,
}

impl TopmostWindowInfo {
    fn from_window(window: WindowInfo, options: TopmostMarkerOptions) -> Self {
        Self {
            hwnd: window.hwnd,
            title: window.title,
            process_id: window.process_id,
            process_name: window.process_name,
            process_path: window.process_path,
            visible: window.visible,
            marker_color: options.marker_color,
            border_width: options.border_width,
            glow_size: options.glow_size,
            opacity: options.opacity,
            marker_style: options.marker_style,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopmostMarkerOptions {
    pub marker_color: String,
    pub border_width: u32,
    pub glow_size: u32,
    pub opacity: f64,
    pub marker_style: String,
}

impl TopmostMarkerOptions {
    pub fn normalized(self) -> Self {
        Self {
            marker_color: normalize_marker_color(&self.marker_color),
            border_width: self.border_width.clamp(1, 12),
            glow_size: self.glow_size.clamp(0, 40),
            opacity: if self.opacity.is_finite() {
                self.opacity.clamp(0.2, 1.0)
            } else {
                DEFAULT_MARKER_OPACITY
            },
            marker_style: MarkerStyle::from_str(&self.marker_style)
                .as_str()
                .to_string(),
        }
    }
}

impl Default for TopmostMarkerOptions {
    fn default() -> Self {
        Self {
            marker_color: DEFAULT_MARKER_COLOR.to_string(),
            border_width: DEFAULT_BORDER_WIDTH,
            glow_size: DEFAULT_GLOW_SIZE,
            opacity: DEFAULT_MARKER_OPACITY,
            marker_style: MarkerStyle::Glow.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerStyle {
    Line,
    Glow,
    Pulse,
}

impl MarkerStyle {
    pub fn from_str(style: &str) -> Self {
        match style {
            "line" => Self::Line,
            "pulse" => Self::Pulse,
            _ => Self::Glow,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Line => "line",
            Self::Glow => "glow",
            Self::Pulse => "pulse",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlayBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayTargetState {
    Visible,
    Hidden,
    Closed,
}

pub fn is_candidate_window_title(title: &str) -> bool {
    !title.trim().is_empty()
}

#[allow(dead_code)]
pub fn dedupe_pids(pids: Vec<u32>) -> Vec<u32> {
    let mut out = Vec::new();
    for pid in pids {
        if !out.contains(&pid) {
            out.push(pid);
        }
    }
    out
}

pub fn can_suspend_pid(pid: u32, current_pid: u32) -> bool {
    pid > 4 && pid != current_pid
}

#[cfg(target_os = "windows")]
#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(process_handle: HANDLE) -> i32;
    fn NtResumeProcess(process_handle: HANDLE) -> i32;
}

#[cfg(target_os = "windows")]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    enumerate_windows(false)
}

#[cfg(target_os = "windows")]
pub fn list_windows_for_matching() -> Result<Vec<WindowInfo>, String> {
    enumerate_windows(true)
}

#[cfg(not(target_os = "windows"))]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "windows"))]
pub fn list_windows_for_matching() -> Result<Vec<WindowInfo>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
pub fn hide_window(hwnd: isize) -> Result<(), String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() {
        return Err("Invalid window handle".to_string());
    }

    unsafe {
        ShowWindow(hwnd, SW_HIDE);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn hide_window(_hwnd: isize) -> Result<(), String> {
    Err("Window hiding is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn show_window(hwnd: isize) -> Result<(), String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() {
        return Err("Invalid window handle".to_string());
    }

    force_foreground_window(hwnd);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn show_window(_hwnd: isize) -> Result<(), String> {
    Err("Window restore is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn is_window_topmost(hwnd: isize) -> Result<bool, String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() || unsafe { IsWindow(hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    Ok((style as u32 & WS_EX_TOPMOST) != 0)
}

#[cfg(not(target_os = "windows"))]
pub fn is_window_topmost(_hwnd: isize) -> Result<bool, String> {
    Err("Window topmost is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn is_valid_window(hwnd: isize) -> bool {
    let hwnd = hwnd_from_isize(hwnd);
    hwnd != null_mut() && unsafe { IsWindow(hwnd) } != 0
}

#[cfg(not(target_os = "windows"))]
pub fn is_valid_window(_hwnd: isize) -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn overlay_target_state(hwnd: isize) -> OverlayTargetState {
    let hwnd = hwnd_from_isize(hwnd);
    let is_valid = hwnd != null_mut() && unsafe { IsWindow(hwnd) } != 0;
    let is_visible = is_valid && unsafe { IsWindowVisible(hwnd) } != 0;
    let is_minimized = is_valid && unsafe { IsIconic(hwnd) } != 0;
    overlay_target_state_from_flags(is_valid, is_visible, is_minimized)
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_target_state(_hwnd: isize) -> OverlayTargetState {
    OverlayTargetState::Closed
}

fn overlay_target_state_from_flags(
    is_valid: bool,
    is_visible: bool,
    is_minimized: bool,
) -> OverlayTargetState {
    if !is_valid {
        OverlayTargetState::Closed
    } else if !is_visible || is_minimized {
        OverlayTargetState::Hidden
    } else {
        OverlayTargetState::Visible
    }
}

#[cfg(target_os = "windows")]
pub fn set_window_topmost(hwnd: isize, enabled: bool) -> Result<(), String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() || unsafe { IsWindow(hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    let insert_after = if enabled {
        HWND_TOPMOST
    } else {
        HWND_NOTOPMOST
    };
    let ok = unsafe {
        SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };

    if ok == 0 {
        return Err("Unable to update window topmost state".to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_topmost(_hwnd: isize, _enabled: bool) -> Result<(), String> {
    Err("Window topmost is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn pick_topmost_window(options: TopmostMarkerOptions) -> Result<TopmostWindowInfo, String> {
    let window = pick_window_by_click(Duration::from_secs(20))?;

    mark_window_topmost_from_info(window, options)
}

#[cfg(not(target_os = "windows"))]
pub fn pick_topmost_window(_options: TopmostMarkerOptions) -> Result<TopmostWindowInfo, String> {
    Err("Window topmost picker is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn mark_window_topmost(
    hwnd: isize,
    options: TopmostMarkerOptions,
) -> Result<TopmostWindowInfo, String> {
    let window = window_info(hwnd)?;
    mark_window_topmost_from_info(window, options)
}

#[cfg(not(target_os = "windows"))]
pub fn mark_window_topmost(
    _hwnd: isize,
    _options: TopmostMarkerOptions,
) -> Result<TopmostWindowInfo, String> {
    Err("Window topmost marker is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn mark_window_topmost_from_info(
    window: WindowInfo,
    options: TopmostMarkerOptions,
) -> Result<TopmostWindowInfo, String> {
    let options = options.normalized();
    set_window_topmost(window.hwnd, true)?;
    let _ = set_window_marker_color(window.hwnd, &options.marker_color);
    let _ = show_window(window.hwnd);

    Ok(TopmostWindowInfo::from_window(window, options))
}

#[cfg(target_os = "windows")]
pub fn clear_topmost_window(hwnd: isize) -> Result<(), String> {
    if !is_valid_window(hwnd) {
        return Ok(());
    }

    set_window_topmost(hwnd, false)?;
    let _ = clear_window_marker_color(hwnd);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn clear_topmost_window(_hwnd: isize) -> Result<(), String> {
    Err("Window topmost picker is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn overlay_bounds(
    hwnd: isize,
    options: &TopmostMarkerOptions,
) -> Result<OverlayBounds, String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() || unsafe { IsWindow(hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
    if ok == 0 {
        return Err("Unable to read window bounds".to_string());
    }

    let options = options.clone().normalized();
    let padding = options.glow_size as i32 + options.border_width as i32 + 8;
    let width = (rect.right - rect.left + padding * 2).max(1) as u32;
    let height = (rect.bottom - rect.top + padding * 2).max(1) as u32;

    Ok(OverlayBounds {
        x: rect.left - padding,
        y: rect.top - padding,
        width,
        height,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_bounds(
    _hwnd: isize,
    _options: &TopmostMarkerOptions,
) -> Result<OverlayBounds, String> {
    Err("Window overlay bounds are only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn foreground_window_hwnd() -> Option<isize> {
    let hwnd = unsafe { GetForegroundWindow() };
    (hwnd != null_mut()).then_some(hwnd as isize)
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_window_hwnd() -> Option<isize> {
    None
}

#[cfg(target_os = "windows")]
pub fn window_info(hwnd: isize) -> Result<WindowInfo, String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() || unsafe { IsWindow(hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    unsafe { window_info_from_hwnd(hwnd) }
        .ok_or_else(|| "Unable to read selected window details".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn window_info(_hwnd: isize) -> Result<WindowInfo, String> {
    Err("Window details are only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn adjust_foreground_window_opacity(
    delta_percent: i16,
    min_percent: u8,
) -> Result<WindowOpacityInfo, String> {
    let hwnd = foreground_window_hwnd().ok_or_else(|| "没有找到当前前台窗口".to_string())?;
    let current = window_opacity_percent(hwnd).unwrap_or(100);
    let min_percent = min_percent.clamp(20, 80);
    let next = (current as i16 + delta_percent).clamp(min_percent as i16, 100) as u8;

    set_window_opacity_percent(hwnd, next)
}

#[cfg(not(target_os = "windows"))]
pub fn adjust_foreground_window_opacity(
    _delta_percent: i16,
    _min_percent: u8,
) -> Result<WindowOpacityInfo, String> {
    Err("Window opacity is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn reset_foreground_window_opacity() -> Result<WindowOpacityInfo, String> {
    let hwnd = foreground_window_hwnd().ok_or_else(|| "没有找到当前前台窗口".to_string())?;
    set_window_opacity_percent(hwnd, 100)
}

#[cfg(not(target_os = "windows"))]
pub fn reset_foreground_window_opacity() -> Result<WindowOpacityInfo, String> {
    Err("Window opacity is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn suspend_process(pid: u32) -> Result<(), String> {
    if !can_suspend_pid(pid, std::process::id()) {
        return Err("Refusing to suspend Manico or a protected system process".to_string());
    }

    with_process_handle(pid, PROCESS_SUSPEND_RESUME, |handle| unsafe {
        ntstatus_to_result(NtSuspendProcess(handle), "suspend process")
    })
}

#[cfg(not(target_os = "windows"))]
pub fn suspend_process(_pid: u32) -> Result<(), String> {
    Err("Process suspend is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn resume_process(pid: u32) -> Result<(), String> {
    with_process_handle(pid, PROCESS_SUSPEND_RESUME, |handle| unsafe {
        ntstatus_to_result(NtResumeProcess(handle), "resume process")
    })
}

#[cfg(not(target_os = "windows"))]
pub fn resume_process(_pid: u32) -> Result<(), String> {
    Err("Process resume is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
struct WindowEnumeration {
    include_hidden: bool,
    windows: Vec<WindowInfo>,
}

#[cfg(target_os = "windows")]
fn enumerate_windows(include_hidden: bool) -> Result<Vec<WindowInfo>, String> {
    let mut enumeration = WindowEnumeration {
        include_hidden,
        windows: Vec::new(),
    };
    let lparam = &mut enumeration as *mut WindowEnumeration as LPARAM;

    let ok = unsafe { EnumWindows(Some(enum_windows_proc), lparam) };
    if ok == 0 {
        return Err("EnumWindows failed".to_string());
    }

    Ok(enumeration.windows)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let enumeration = &mut *(lparam as *mut WindowEnumeration);
    let Some(window) = window_info_from_hwnd(hwnd) else {
        return 1;
    };
    if !enumeration.include_hidden && !window.visible {
        return 1;
    }

    enumeration.windows.push(window);

    1
}

#[cfg(target_os = "windows")]
fn pick_window_by_click(timeout: Duration) -> Result<WindowInfo, String> {
    let start = Instant::now();
    while left_button_down() {
        if start.elapsed() > timeout {
            return Err("Window selection timed out".to_string());
        }
        thread::sleep(Duration::from_millis(16));
    }

    let cursor = unsafe { LoadCursorW(null_mut(), IDC_CROSS) };
    loop {
        if start.elapsed() > timeout {
            return Err("Window selection timed out".to_string());
        }

        if cursor != null_mut() {
            unsafe {
                SetCursor(cursor);
            }
        }

        if left_button_down() {
            let hwnd = window_under_cursor()?;
            while left_button_down() {
                thread::sleep(Duration::from_millis(16));
            }
            return unsafe { window_info_from_hwnd(hwnd) }
                .ok_or_else(|| "Unable to read selected window details".to_string());
        }

        thread::sleep(Duration::from_millis(16));
    }
}

#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 }
}

#[cfg(target_os = "windows")]
fn window_under_cursor() -> Result<HWND, String> {
    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        return Err("Unable to read cursor position".to_string());
    }

    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd == null_mut() {
        return Err("No window found under cursor".to_string());
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    Ok(if root == null_mut() { hwnd } else { root })
}

#[cfg(target_os = "windows")]
unsafe fn window_info_from_hwnd(hwnd: HWND) -> Option<WindowInfo> {
    let visible = IsWindowVisible(hwnd) != 0;
    let title = get_window_title(hwnd);
    if !is_candidate_window_title(&title) {
        return None;
    }

    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, &mut process_id);
    if process_id == 0 {
        return None;
    }

    let process_path = get_process_path(process_id);
    let process_name = process_path
        .as_deref()
        .and_then(|path| path.rsplit(['\\', '/']).next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("pid-{process_id}"));

    Some(WindowInfo {
        hwnd: hwnd as isize,
        title,
        process_id,
        process_name,
        process_path,
        visible,
        rect: window_rect(hwnd),
        class_name: window_class_name(hwnd),
        style: Some(GetWindowLongPtrW(hwnd, GWL_STYLE) as u32),
        ex_style: Some(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32),
        owner_hwnd: owner_window(hwnd),
        cloaked: is_dwm_cloaked(hwnd),
    })
}

#[cfg(target_os = "windows")]
unsafe fn window_rect(hwnd: HWND) -> Option<WindowRect> {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = GetWindowRect(hwnd, &mut rect);
    if ok == 0 {
        return None;
    }

    let width = rect.right.saturating_sub(rect.left) as u32;
    let height = rect.bottom.saturating_sub(rect.top) as u32;
    Some(WindowRect {
        x: rect.left,
        y: rect.top,
        width,
        height,
    })
}

#[cfg(target_os = "windows")]
unsafe fn window_class_name(hwnd: HWND) -> Option<String> {
    let mut buffer = vec![0u16; 256];
    let copied = GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    if copied <= 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&buffer[..copied as usize]))
}

#[cfg(target_os = "windows")]
unsafe fn owner_window(hwnd: HWND) -> Option<isize> {
    let owner = GetWindow(hwnd, GW_OWNER);
    (owner != null_mut()).then_some(owner as isize)
}

#[cfg(target_os = "windows")]
unsafe fn is_dwm_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED as u32,
        &mut cloaked as *mut u32 as *mut c_void,
        std::mem::size_of::<u32>() as u32,
    );

    result >= 0 && cloaked != 0
}

#[cfg(target_os = "windows")]
unsafe fn get_window_title(hwnd: HWND) -> String {
    let length = GetWindowTextLengthW(hwnd);
    if length <= 0 {
        return String::new();
    }

    let mut buffer = vec![0u16; length as usize + 1];
    let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    if copied <= 0 {
        return String::new();
    }

    String::from_utf16_lossy(&buffer[..copied as usize])
}

#[cfg(target_os = "windows")]
fn get_process_path(pid: u32) -> Option<String> {
    with_process_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION, |handle| unsafe {
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        if ok == 0 || size == 0 {
            return Ok(None);
        }

        Ok(Some(String::from_utf16_lossy(&buffer[..size as usize])))
    })
    .ok()
    .flatten()
}

#[cfg(target_os = "windows")]
fn with_process_handle<T>(
    pid: u32,
    access: u32,
    f: impl FnOnce(HANDLE) -> Result<T, String>,
) -> Result<T, String> {
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle == null_mut() {
        return Err(format!("Unable to open process {pid}"));
    }

    let result = f(handle);
    unsafe {
        CloseHandle(handle);
    }
    result
}

#[cfg(target_os = "windows")]
fn ntstatus_to_result(status: i32, action: &str) -> Result<(), String> {
    if status >= 0 {
        Ok(())
    } else {
        Err(format!("Failed to {action}: NTSTATUS 0x{status:08X}"))
    }
}

fn normalize_marker_color(color: &str) -> String {
    let trimmed = color.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.chars().all(|char| char.is_ascii_hexdigit()) {
        return DEFAULT_MARKER_COLOR.to_string();
    }

    format!("#{}", hex.to_ascii_lowercase())
}

fn marker_color_to_colorref(color: &str) -> u32 {
    let color = normalize_marker_color(color);
    let hex = &color[1..];
    let red = u32::from_str_radix(&hex[0..2], 16).unwrap_or(0xef);
    let green = u32::from_str_radix(&hex[2..4], 16).unwrap_or(0x44);
    let blue = u32::from_str_radix(&hex[4..6], 16).unwrap_or(0x44);

    (blue << 16) | (green << 8) | red
}

#[cfg(target_os = "windows")]
fn set_window_marker_color(hwnd: isize, color: &str) -> Result<(), String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() {
        return Err("Invalid window handle".to_string());
    }

    let colorref = marker_color_to_colorref(color);
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &colorref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };

    if result < 0 {
        return Err(format!(
            "Unable to mark window border: HRESULT 0x{:08X}",
            result as u32
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_window_marker_color(hwnd: isize) -> Result<(), String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() {
        return Err("Invalid window handle".to_string());
    }

    let colorref = DWMWA_COLOR_DEFAULT;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &colorref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };

    if result < 0 {
        return Err(format!(
            "Unable to clear window marker: HRESULT 0x{:08X}",
            result as u32
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn set_window_opacity_percent(hwnd: isize, percent: u8) -> Result<WindowOpacityInfo, String> {
    let window = window_info(hwnd)?;
    let raw_hwnd = hwnd_from_isize(hwnd);
    if raw_hwnd == null_mut() || unsafe { IsWindow(raw_hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    let percent = percent.clamp(1, 100);
    let style = unsafe { GetWindowLongPtrW(raw_hwnd, GWL_EXSTYLE) };
    unsafe {
        SetWindowLongPtrW(raw_hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
    }

    let ok = unsafe {
        SetLayeredWindowAttributes(raw_hwnd, 0, opacity_percent_to_alpha(percent), LWA_ALPHA)
    };
    if ok == 0 {
        return Err("Unable to update window opacity".to_string());
    }

    Ok(WindowOpacityInfo {
        hwnd,
        title: window.title,
        opacity_percent: percent,
    })
}

#[cfg(target_os = "windows")]
fn window_opacity_percent(hwnd: isize) -> Result<u8, String> {
    let hwnd = hwnd_from_isize(hwnd);
    if hwnd == null_mut() || unsafe { IsWindow(hwnd) } == 0 {
        return Err("Invalid window handle".to_string());
    }

    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if (style as u32 & WS_EX_LAYERED) == 0 {
        return Ok(100);
    }

    let mut color_key: COLORREF = 0;
    let mut alpha = 255u8;
    let mut flags = 0u32;
    let ok = unsafe { GetLayeredWindowAttributes(hwnd, &mut color_key, &mut alpha, &mut flags) };
    if ok == 0 || (flags & LWA_ALPHA) == 0 {
        return Ok(100);
    }

    Ok(((alpha as u16 * 100 + 127) / 255).clamp(1, 100) as u8)
}

fn opacity_percent_to_alpha(percent: u8) -> u8 {
    let percent = percent.clamp(1, 100);
    ((percent as u16 * 255 + 50) / 100).clamp(1, 255) as u8
}

#[cfg(target_os = "windows")]
fn hwnd_from_isize(hwnd: isize) -> HWND {
    hwnd as *mut c_void
}

#[cfg(target_os = "windows")]
fn force_foreground_window(hwnd: HWND) {
    unsafe {
        let foreground = GetForegroundWindow();
        let foreground_thread_id = GetWindowThreadProcessId(foreground, null_mut());
        let current_thread_id = GetCurrentThreadId();
        let attached = foreground_thread_id != 0
            && foreground_thread_id != current_thread_id
            && AttachThreadInput(current_thread_id, foreground_thread_id, 1) != 0;

        ShowWindow(hwnd, SW_SHOW);
        ShowWindow(hwnd, SW_RESTORE);

        BringWindowToTop(hwnd);
        SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        SetForegroundWindow(hwnd);

        if attached {
            AttachThreadInput(current_thread_id, foreground_thread_id, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        can_suspend_pid, dedupe_pids, is_candidate_window_title, marker_color_to_colorref,
        normalize_marker_color, opacity_percent_to_alpha, overlay_target_state_from_flags,
        MarkerStyle, OverlayTargetState, TopmostMarkerOptions,
    };

    #[test]
    fn rejects_empty_or_whitespace_titles() {
        assert!(!is_candidate_window_title(""));
        assert!(!is_candidate_window_title("   "));
        assert!(is_candidate_window_title("Visual Studio Code"));
    }

    #[test]
    fn deduplicates_process_ids_for_freeze() {
        assert_eq!(dedupe_pids(vec![10, 10, 22, 10, 22]), vec![10, 22]);
    }

    #[test]
    fn protects_system_and_current_process_from_suspend() {
        assert!(!can_suspend_pid(0, 100));
        assert!(!can_suspend_pid(4, 100));
        assert!(!can_suspend_pid(100, 100));
        assert!(can_suspend_pid(200, 100));
    }

    #[test]
    fn normalizes_marker_colors_for_window_borders() {
        assert_eq!(normalize_marker_color("#EF4444"), "#ef4444");
        assert_eq!(normalize_marker_color("2F6DF6"), "#2f6df6");
        assert_eq!(normalize_marker_color("bad"), "#ef4444");
        assert_eq!(marker_color_to_colorref("#112233"), 0x00332211);
    }

    #[test]
    fn normalizes_topmost_marker_options() {
        let options = TopmostMarkerOptions {
            marker_color: "BAD".to_string(),
            border_width: 99,
            glow_size: 99,
            opacity: 9.0,
            marker_style: "unknown".to_string(),
        }
        .normalized();

        assert_eq!(options.marker_color, "#ef4444");
        assert_eq!(options.border_width, 12);
        assert_eq!(options.glow_size, 40);
        assert_eq!(options.opacity, 1.0);
        assert_eq!(options.marker_style, MarkerStyle::Glow.as_str());
    }

    #[test]
    fn converts_opacity_percent_to_layered_alpha() {
        assert_eq!(opacity_percent_to_alpha(0), 3);
        assert_eq!(opacity_percent_to_alpha(35), 89);
        assert_eq!(opacity_percent_to_alpha(100), 255);
    }

    #[test]
    fn hidden_or_minimized_windows_hide_overlay_without_closing_it() {
        assert_eq!(
            overlay_target_state_from_flags(false, true, false),
            OverlayTargetState::Closed
        );
        assert_eq!(
            overlay_target_state_from_flags(true, false, false),
            OverlayTargetState::Hidden
        );
        assert_eq!(
            overlay_target_state_from_flags(true, true, true),
            OverlayTargetState::Hidden
        );
        assert_eq!(
            overlay_target_state_from_flags(true, true, false),
            OverlayTargetState::Visible
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn clearing_missing_topmost_window_is_idempotent() {
        assert!(super::clear_topmost_window(0).is_ok());
    }
}
