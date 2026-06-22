import type { NativeWindowInfo } from "./windowsApi";

export type RecoverableWindow = NativeWindowInfo & {
  hidden: boolean;
  frozen: boolean;
};

export function mergeRecoverableWindows(
  visibleWindows: NativeWindowInfo[],
  hiddenWindows: NativeWindowInfo[],
  frozenPids: number[],
): RecoverableWindow[] {
  const frozen = new Set(frozenPids);
  const rows = new Map<number, RecoverableWindow>();

  for (const window of visibleWindows) {
    rows.set(window.hwnd, {
      ...window,
      visible: true,
      hidden: false,
      frozen: frozen.has(window.process_id),
    });
  }

  for (const window of hiddenWindows) {
    if (rows.has(window.hwnd)) continue;
    rows.set(window.hwnd, {
      ...window,
      visible: false,
      hidden: true,
      frozen: frozen.has(window.process_id),
    });
  }

  return Array.from(rows.values());
}

export function upsertWindow(windows: NativeWindowInfo[], nextWindow: NativeWindowInfo): NativeWindowInfo[] {
  const index = windows.findIndex((window) => window.hwnd === nextWindow.hwnd);
  if (index === -1) return [...windows, nextWindow];

  const next = [...windows];
  next[index] = nextWindow;
  return next;
}

export function removeWindowByHwnd(windows: NativeWindowInfo[], hwnd: number): NativeWindowInfo[] {
  return windows.filter((window) => window.hwnd !== hwnd);
}

export function addUniquePid(pids: number[], pid: number): number[] {
  return pids.includes(pid) ? pids : [...pids, pid];
}

export function removePid(pids: number[], pid: number): number[] {
  return pids.filter((item) => item !== pid);
}

export function processInitial(processName: string): string {
  const first = processName.trim().replace(".exe", "").charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function toneForProcess(processName: string): string {
  const name = processName.toLowerCase();
  if (name.includes("opera")) return "orange";
  if (name.includes("code") || name.includes("studio")) return "purple";
  if (name.includes("rider") || name.includes("jetbrains")) return "blue";
  if (name.includes("terminal") || name.includes("powershell") || name.includes("explorer")) return "gray";
  return "green";
}
