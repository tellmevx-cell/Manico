import type { HotkeyConfig, ManagedApp } from "./appsApi";

export type LaunchableHotkey = {
  appId: string;
  shortcut: string;
};

export function getLaunchableHotkeys(apps: ManagedApp[]): LaunchableHotkey[] {
  const used = new Set<string>();
  const hotkeys: LaunchableHotkey[] = [];

  for (const app of apps) {
    const shortcut = formatHotkey(app.hotkey);
    if (!shortcut || used.has(shortcut)) continue;

    used.add(shortcut);
    hotkeys.push({ appId: app.id, shortcut });
  }

  return hotkeys;
}

export function formatHotkey(hotkey?: HotkeyConfig | null): string {
  if (!hotkey?.key.trim()) return "";

  const parts: string[] = [];
  if (hotkey.ctrl) parts.push("Ctrl");
  if (hotkey.alt) parts.push("Alt");
  if (hotkey.shift) parts.push("Shift");
  if (hotkey.win) parts.push("Super");
  if (parts.length === 0) return "";
  parts.push(hotkey.key.trim().toUpperCase());
  return parts.join("+");
}
