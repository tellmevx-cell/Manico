import { invoke } from "@tauri-apps/api/core";

export type NativeWindowInfo = {
  hwnd: number;
  title: string;
  process_id: number;
  process_name: string;
  process_path?: string | null;
  visible: boolean;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  class_name?: string | null;
  style?: number | null;
  ex_style?: number | null;
  owner_hwnd?: number | null;
  cloaked?: boolean;
};

export type TopmostWindowInfo = NativeWindowInfo & {
  marker_color: string;
  border_width: number;
  glow_size: number;
  opacity: number;
  marker_style: TopmostMarkerStyle;
};

export type TopmostMarkerStyle = "line" | "glow" | "pulse";

export type TopmostMarkerOptions = {
  marker_color: string;
  border_width: number;
  glow_size: number;
  opacity: number;
  marker_style: TopmostMarkerStyle;
};

export function listNativeWindows(): Promise<NativeWindowInfo[]> {
  return invoke<NativeWindowInfo[]>("list_windows");
}

export function listAllNativeWindows(): Promise<NativeWindowInfo[]> {
  return invoke<NativeWindowInfo[]>("list_all_windows");
}

export function hideNativeWindow(hwnd: number): Promise<void> {
  return invoke("hide_window", { hwnd });
}

export function showNativeWindow(hwnd: number): Promise<void> {
  return invoke("show_window", { hwnd });
}

export function suspendNativeProcess(pid: number): Promise<void> {
  return invoke("suspend_process", { pid });
}

export function resumeNativeProcess(pid: number): Promise<void> {
  return invoke("resume_process", { pid });
}

export function pickTopmostWindow(options: TopmostMarkerOptions): Promise<TopmostWindowInfo> {
  return invoke<TopmostWindowInfo>("pick_topmost_window", { options });
}

export function updateTopmostWindowMarker(
  hwnd: number,
  options: TopmostMarkerOptions,
): Promise<TopmostWindowInfo> {
  return invoke<TopmostWindowInfo>("update_topmost_window_marker", { hwnd, options });
}

export function clearTopmostWindow(hwnd: number): Promise<void> {
  return invoke("clear_topmost_window", { hwnd });
}
