import type { NativeWindowInfo } from "./windowsApi";

const MIN_USER_WINDOW_WIDTH = 240;
const MIN_USER_WINDOW_HEIGHT = 160;
const MIN_USER_WINDOW_AREA = 60_000;
const WS_CHILD_STYLE = 0x4000_0000;
const WS_EX_TOOLWINDOW_STYLE = 0x0000_0080;
const WS_EX_APPWINDOW_STYLE = 0x0004_0000;

export function windowMatchesBinding(
  window: NativeWindowInfo,
  binding: NativeWindowInfo,
): boolean {
  const windowPath = normalizePath(window.process_path);
  const bindingPath = normalizePath(binding.process_path);

  if (windowPath && bindingPath) {
    return windowPath === bindingPath;
  }

  if (window.process_name && binding.process_name) {
    return window.process_name.toLowerCase() === binding.process_name.toLowerCase();
  }

  return window.process_id === binding.process_id;
}

export function getBoundToggleTargets(
  visibleWindows: NativeWindowInfo[],
  hiddenWindows: NativeWindowInfo[],
  bindings: NativeWindowInfo[],
): NativeWindowInfo[] {
  const targets = [...visibleWindows, ...hiddenWindows].filter((window) =>
    bindings.some((binding) => windowMatchesBinding(window, binding)) && isUserToggleWindow(window),
  );

  return dedupeWindows(targets);
}

export function upsertBinding(
  bindings: NativeWindowInfo[],
  nextBinding: NativeWindowInfo,
): NativeWindowInfo[] {
  const withoutExisting = bindings.filter((binding) => !sameBindingIdentity(binding, nextBinding));
  return [...withoutExisting, nextBinding];
}

export function removeBinding(
  bindings: NativeWindowInfo[],
  bindingToRemove: NativeWindowInfo,
): NativeWindowInfo[] {
  return bindings.filter((binding) => !sameBindingIdentity(binding, bindingToRemove));
}

function sameBindingIdentity(left: NativeWindowInfo, right: NativeWindowInfo): boolean {
  const leftPath = normalizePath(left.process_path);
  const rightPath = normalizePath(right.process_path);

  if (leftPath && rightPath) {
    return leftPath === rightPath;
  }

  if (left.process_name && right.process_name) {
    return left.process_name.toLowerCase() === right.process_name.toLowerCase();
  }

  return left.process_id === right.process_id;
}

function dedupeWindows(windows: NativeWindowInfo[]): NativeWindowInfo[] {
  const seen = new Set<number>();
  const result: NativeWindowInfo[] = [];

  for (const window of windows) {
    if (seen.has(window.hwnd)) continue;
    seen.add(window.hwnd);
    result.push(window);
  }

  return result;
}

function normalizePath(path: string | null | undefined): string | null {
  const normalized = path?.trim().replace(/\//g, "\\").toLowerCase();
  return normalized || null;
}

function isUserToggleWindow(window: NativeWindowInfo): boolean {
  return !isInternalWindow(window);
}

function isInternalWindow(window: NativeWindowInfo): boolean {
  const title = window.title.trim().toLowerCase();
  const processName = window.process_name.trim().toLowerCase();
  const processPath = normalizePath(window.process_path) ?? "";

  if (
    [
      "default ime",
      "msctfime ui",
      "cicerouiwndframe",
      "program manager",
      "dde server window",
    ].includes(title)
  ) {
    return true;
  }

  if (
    title.includes("wxtrayiconmessagewindow") ||
    title.includes(".net-broadcasteventwindow") ||
    title.includes("notificationwindow") ||
    title.includes("messagewindow")
  ) {
    return true;
  }

  if (
    window.cloaked ||
    isToolWindow(window) ||
    isChildWindow(window) ||
    isOwnedToolWindow(window) ||
    !hasUserWindowSize(window)
  ) {
    return true;
  }

  const isWeChat = processName === "weixin.exe" || processPath.endsWith("\\weixin.exe");
  return isWeChat && title === "weixin";
}

function isToolWindow(window: NativeWindowInfo): boolean {
  return ((window.ex_style ?? 0) & WS_EX_TOOLWINDOW_STYLE) !== 0;
}

function isChildWindow(window: NativeWindowInfo): boolean {
  return ((window.style ?? 0) & WS_CHILD_STYLE) !== 0;
}

function isOwnedToolWindow(window: NativeWindowInfo): boolean {
  return window.owner_hwnd != null && (((window.ex_style ?? 0) & WS_EX_APPWINDOW_STYLE) === 0);
}

function hasUserWindowSize(window: NativeWindowInfo): boolean {
  if (!window.rect) return true;
  if (window.rect.width < MIN_USER_WINDOW_WIDTH || window.rect.height < MIN_USER_WINDOW_HEIGHT) {
    return false;
  }

  return window.rect.width * window.rect.height >= MIN_USER_WINDOW_AREA;
}
