import { invoke } from "@tauri-apps/api/core";
import type { NativeWindowInfo, TopmostMarkerOptions } from "./windowsApi";

export type HotkeyConfig = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  key: string;
};

export type AppGroup = {
  id: string;
  name: string;
  order: number;
  is_expanded: boolean;
};

export type ManagedApp = {
  id: string;
  name: string;
  executable_path: string;
  shortcut_path?: string | null;
  app_user_model_id?: string | null;
  arguments?: string | null;
  working_directory?: string | null;
  group_id: string;
  hotkey?: HotkeyConfig | null;
  order: number;
};

export type AppSettings = {
  start_with_windows: boolean;
  minimize_to_tray: boolean;
  groups: AppGroup[];
  apps: ManagedApp[];
  window_bindings: NativeWindowInfo[];
  quick_topmost_hotkey: HotkeyConfig;
  topmost_marker_options: TopmostMarkerOptions;
  window_opacity_settings: WindowOpacitySettings;
};

export type WindowOpacitySettings = {
  decrease_hotkey: HotkeyConfig;
  increase_hotkey: HotkeyConfig;
  reset_hotkey: HotkeyConfig;
  step_percent: number;
  min_percent: number;
};

export type LaunchResult = {
  action: "switched" | "launched" | "hidden" | "restored";
  window: NativeWindowInfo | null;
};

export type DroppedAppCandidate = {
  name: string;
  executable_path: string;
  shortcut_path?: string | null;
  app_user_model_id?: string | null;
  arguments?: string | null;
  working_directory?: string | null;
};

export const emptyAppSettings: AppSettings = {
  start_with_windows: false,
  minimize_to_tray: true,
  groups: [{ id: "default", name: "默认", order: 0, is_expanded: true }],
  apps: [],
  window_bindings: [],
  quick_topmost_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "P" },
  topmost_marker_options: {
    marker_color: "#ef4444",
    border_width: 6,
    glow_size: 24,
    opacity: 0.9,
    marker_style: "glow",
  },
  window_opacity_settings: {
    decrease_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "1" },
    increase_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "2" },
    reset_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "0" },
    step_percent: 10,
    min_percent: 35,
  },
};

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function saveAppSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("save_app_settings", { settings });
}

export function updateWindowBindings(windowBindings: NativeWindowInfo[]): Promise<AppSettings> {
  return invoke<AppSettings>("update_window_bindings", { windowBindings });
}

export function upsertManagedApp(app: ManagedApp): Promise<AppSettings> {
  return invoke<AppSettings>("upsert_managed_app", { app });
}

export function deleteManagedApp(id: string): Promise<AppSettings> {
  return invoke<AppSettings>("delete_managed_app", { id });
}

export function resolveDroppedApp(path: string): Promise<DroppedAppCandidate> {
  return invoke<DroppedAppCandidate>("resolve_dropped_app", { path });
}

export function launchManagedApp(id: string): Promise<LaunchResult> {
  return invoke<LaunchResult>("launch_managed_app", { id });
}
