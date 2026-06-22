import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import "./App.css";
import { navItems, rules, type NavPage } from "./data/mockData";
import {
  deleteManagedApp,
  emptyAppSettings,
  getAppSettings,
  resolveDroppedApp,
  saveAppSettings,
  updateWindowBindings,
  upsertManagedApp,
  type DroppedAppCandidate,
  type AppSettings,
  type HotkeyConfig,
  type ManagedApp,
  type WindowOpacitySettings,
} from "./lib/appsApi";
import { formatHotkey, getLaunchableHotkeys } from "./lib/appHotkeys";
import {
  hideNativeWindow,
  listAllNativeWindows,
  listNativeWindows,
  clearTopmostWindow,
  pickTopmostWindow,
  resumeNativeProcess,
  showNativeWindow,
  suspendNativeProcess,
  updateTopmostWindowMarker,
  type NativeWindowInfo,
  type TopmostMarkerOptions,
  type TopmostMarkerStyle,
  type TopmostWindowInfo,
} from "./lib/windowsApi";
import {
  addUniquePid,
  mergeRecoverableWindows,
  processInitial,
  removePid,
  removeWindowByHwnd,
  toneForProcess,
  upsertWindow,
  type RecoverableWindow,
} from "./lib/windowState";
import {
  getBoundToggleTargets,
  removeBinding as removeStoredBinding,
  upsertBinding,
} from "./lib/windowBindings";

type TauriDragDropPayload = {
  paths?: string[];
  position?: { x: number; y: number };
};

type TopmostWindowRemovedPayload = {
  hwnd: number;
  reason?: "closed" | "shortcut" | "manual";
};

type NoticeTone = "success" | "error" | "info";

type OperationNotice = {
  id: number;
  message: string;
  tone: NoticeTone;
};

const authorProfile = {
  name: "Monica",
  qq: "1842063160",
  email: "tellmevx@gmail.com",
} as const;

const pageTitles: Record<NavPage, { title: string; subtitle: string }> = {
  overview: {
    title: "今天的工作区状态",
    subtitle: "先把常用应用整理成可启动、可切换、可绑定快捷键的入口。",
  },
  apps: {
    title: "应用管理",
    subtitle: "管理常用应用、启动参数、工作目录和全局快捷键；已运行时切换窗口，未运行时启动。",
  },
  bindings: {
    title: "窗口绑定",
    subtitle: "选择当前系统窗口并绑定到进程池，Ctrl+Q 统一显示或隐藏这些窗口。",
  },
  extensions: {
    title: "窗口置顶",
    subtitle: "管理置顶标记和快速置顶，让当前窗口层级更好控制。",
  },
  dimmer: {
    title: "窗口调光",
    subtitle: "用全局快捷键调低、调高或还原当前前台窗口透明度。",
  },
  rules: {
    title: "规则中心",
    subtitle: "把 Boss-Key 的热键设置和其他选项合并成一个可扫描的规则页面。",
  },
  recovery: {
    title: "窗口恢复工具",
    subtitle: "重做 Boss-Key 的独立恢复窗口：隐藏、显示、刷新、冻结、解冻和申请管理员权限。",
  },
  settings: {
    title: "设置",
    subtitle: "管理开机自启、托盘行为和基础运行偏好。",
  },
  about: {
    title: "关于作者",
    subtitle: "Manico 的作者信息与联系入口，后续反馈和定制需求可以从这里找到联系方式。",
  },
};

function App() {
  const [page, setPage] = useState<NavPage>("overview");
  const [nativeStatus, setNativeStatus] = useState("已就绪：刷新窗口后可绑定、隐藏、恢复和冻结进程");
  const [operationNotice, setOperationNotice] = useState<OperationNotice | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(emptyAppSettings);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appDraft, setAppDraft] = useState<ManagedApp>(() => createBlankApp(0));
  const [nativeWindows, setNativeWindows] = useState<NativeWindowInfo[]>([]);
  const [hiddenWindows, setHiddenWindows] = useState<NativeWindowInfo[]>([]);
  const [frozenPids, setFrozenPids] = useState<number[]>([]);
  const [boundWindowsState, setBoundWindowsState] = useState<NativeWindowInfo[]>([]);
  const [topmostWindows, setTopmostWindows] = useState<TopmostWindowInfo[]>([]);
  const [topmostOptions, setTopmostOptions] = useState<TopmostMarkerOptions>(() => defaultTopmostMarkerOptions());
  const [quickTopmostHotkey, setQuickTopmostHotkey] = useState<HotkeyConfig>(() => defaultQuickTopmostHotkey());
  const [windowOpacitySettings, setWindowOpacitySettings] = useState<WindowOpacitySettings>(() => defaultWindowOpacitySettings());
  const [isPickingTopmost, setPickingTopmost] = useState(false);
  const [pendingBindingRemovals, setPendingBindingRemovals] = useState<Set<number>>(() => new Set());
  const [selectedHwnd, setSelectedHwnd] = useState<number | null>(null);
  const topmostMarkerUpdateId = useRef(0);
  const noticeId = useRef(0);
  const title = pageTitles[page];

  const showStatus = useCallback((message: string, withNotice = true) => {
    setNativeStatus(message);
    if (!withNotice) return;

    noticeId.current += 1;
    setOperationNotice({
      id: noticeId.current,
      message,
      tone: noticeToneForMessage(message),
    });
  }, []);

  const copyContact = useCallback(async (label: string, value: string) => {
    try {
      await writeClipboardText(value);
      showStatus(`已复制 ${label}：${value}`);
    } catch (error) {
      showStatus(`复制 ${label} 失败：${formatError(error)}`);
    }
  }, [showStatus]);

  useEffect(() => {
    if (!operationNotice) return undefined;

    const timer = window.setTimeout(() => {
      setOperationNotice((current) => current?.id === operationNotice.id ? null : current);
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [operationNotice]);

  const recoverableWindows = useMemo(
    () => mergeRecoverableWindows(nativeWindows, hiddenWindows, frozenPids),
    [nativeWindows, hiddenWindows, frozenPids],
  );

  const selectedWindow = useMemo(
    () => recoverableWindows.find((window) => window.hwnd === selectedHwnd) ?? recoverableWindows[0] ?? null,
    [recoverableWindows, selectedHwnd],
  );

  const selectedManagedApp = useMemo(
    () => appSettings.apps.find((app) => app.id === selectedAppId) ?? null,
    [appSettings.apps, selectedAppId],
  );

  const loadAppSettings = useCallback(async (withNotice = false) => {
    if (!isTauriRuntime()) {
      setAppSettings(emptyAppSettings);
      return;
    }

    try {
      const nextSettings = await getAppSettings();
      setAppSettings(nextSettings);
      setQuickTopmostHotkey(nextSettings.quick_topmost_hotkey ?? defaultQuickTopmostHotkey());
      setTopmostOptions(nextSettings.topmost_marker_options ?? defaultTopmostMarkerOptions());
      setWindowOpacitySettings(nextSettings.window_opacity_settings ?? defaultWindowOpacitySettings());
      const firstApp = nextSettings.apps[0] ?? null;
      setSelectedAppId((current) => current ?? firstApp?.id ?? null);
      setAppDraft(firstApp ?? createBlankApp(nextSettings.apps.length));
      setBoundWindowsState(nextSettings.window_bindings ?? []);
      showStatus(`已加载 ${nextSettings.apps.length} 个快捷应用`, withNotice);
    } catch (error) {
      showStatus(`应用配置读取失败：${formatError(error)}`);
    }
  }, [showStatus]);

  useEffect(() => {
    void loadAppSettings(false);
  }, [loadAppSettings]);

  const refreshNativeWindows = useCallback(async (withNotice = true) => {
    try {
      const nextWindows = await listNativeWindows();
      setNativeWindows(nextWindows);
      setSelectedHwnd((current) => current ?? nextWindows[0]?.hwnd ?? null);
      showStatus(`已读取 ${nextWindows.length} 个可见窗口`, withNotice);
    } catch (error) {
      showStatus(`窗口读取失败：${formatError(error)}`);
    }
  }, [showStatus]);

  const hideWindow = useCallback(async (window: NativeWindowInfo) => {
    try {
      await hideNativeWindow(window.hwnd);
      setHiddenWindows((current) => upsertWindow(current, window));
      setNativeWindows((current) => removeWindowByHwnd(current, window.hwnd));
      showStatus(`已隐藏：${window.title}`);
    } catch (error) {
      showStatus(`隐藏失败：${formatError(error)}`);
    }
  }, [showStatus]);

  const showWindow = useCallback(
    async (window: NativeWindowInfo) => {
      try {
        await showNativeWindow(window.hwnd);
        setHiddenWindows((current) => removeWindowByHwnd(current, window.hwnd));
        await refreshNativeWindows(false);
        showStatus(`已恢复：${window.title}`);
      } catch (error) {
        showStatus(`恢复失败：${formatError(error)}`);
      }
    },
    [refreshNativeWindows, showStatus],
  );

  const freezeProcess = useCallback(async (window: NativeWindowInfo) => {
    try {
      await suspendNativeProcess(window.process_id);
      setFrozenPids((current) => addUniquePid(current, window.process_id));
      showStatus(`已冻结进程：${window.process_name} (${window.process_id})`);
    } catch (error) {
      showStatus(`冻结失败：${formatError(error)}`);
    }
  }, [showStatus]);

  const resumeProcess = useCallback(async (window: NativeWindowInfo) => {
    try {
      await resumeNativeProcess(window.process_id);
      setFrozenPids((current) => removePid(current, window.process_id));
      showStatus(`已解冻进程：${window.process_name} (${window.process_id})`);
    } catch (error) {
      showStatus(`解冻失败：${formatError(error)}`);
    }
  }, [showStatus]);

  const saveAppDraft = useCallback(async () => {
    const normalizedDraft: ManagedApp = {
      ...appDraft,
      id: appDraft.id || makeId(),
      name: appDraft.name.trim(),
      executable_path: appDraft.executable_path.trim(),
      shortcut_path: appDraft.shortcut_path?.trim() ? appDraft.shortcut_path.trim() : null,
      app_user_model_id: appDraft.app_user_model_id?.trim() ? appDraft.app_user_model_id.trim() : null,
      arguments: appDraft.arguments?.trim() ? appDraft.arguments.trim() : null,
      working_directory: appDraft.working_directory?.trim() ? appDraft.working_directory.trim() : null,
      group_id: appDraft.group_id || "default",
      hotkey: normalizeHotkey(appDraft.hotkey),
      order: appDraft.order ?? appSettings.apps.length,
    };

    if (!normalizedDraft.name || !normalizedDraft.executable_path) {
      showStatus("应用名称和 exe 路径不能为空");
      return;
    }

    try {
      if (isTauriRuntime()) {
        const nextSettings = await upsertManagedApp(normalizedDraft);
        setAppSettings(nextSettings);
        setBoundWindowsState(nextSettings.window_bindings ?? []);
      } else {
        setAppSettings((current) => upsertAppLocal(current, normalizedDraft));
      }
      setSelectedAppId(normalizedDraft.id);
      setAppDraft(normalizedDraft);
      showStatus(`已保存应用：${normalizedDraft.name}`);
    } catch (error) {
      showStatus(`保存应用失败：${formatError(error)}`);
    }
  }, [appDraft, appSettings.apps.length, showStatus]);

  const deleteSelectedApp = useCallback(async () => {
    if (!selectedManagedApp) return;

    try {
      let nextSettings: AppSettings;
      if (isTauriRuntime()) {
        nextSettings = await deleteManagedApp(selectedManagedApp.id);
      } else {
        nextSettings = {
          ...appSettings,
          apps: appSettings.apps.filter((app) => app.id !== selectedManagedApp.id),
        };
      }

      setAppSettings(nextSettings);
      setBoundWindowsState(nextSettings.window_bindings ?? []);
      const nextApp = nextSettings.apps[0] ?? null;
      setSelectedAppId(nextApp?.id ?? null);
      setAppDraft(nextApp ?? createBlankApp(nextSettings.apps.length));
      showStatus(`已删除应用：${selectedManagedApp.name}`);
    } catch (error) {
      showStatus(`删除应用失败：${formatError(error)}`);
    }
  }, [appSettings, selectedManagedApp, showStatus]);

  const importDroppedApp = useCallback(async (path: string | null) => {
    if (!path) {
      showStatus("没有读取到拖入文件路径，请拖入桌面快捷方式或 exe 文件");
      return;
    }

    try {
      const candidate = isTauriRuntime() ? await resolveDroppedApp(path) : candidateFromPath(path);
      const nextApp: ManagedApp = {
        ...createBlankApp(appSettings.apps.length),
        name: candidate.name,
        executable_path: candidate.executable_path,
        shortcut_path: candidate.shortcut_path ?? null,
        app_user_model_id: candidate.app_user_model_id ?? null,
        arguments: candidate.arguments ?? null,
        working_directory: candidate.working_directory ?? null,
        hotkey: {
          ...defaultHotkey(),
          key: suggestHotkeyKey(candidate.name, appSettings.apps),
        },
      };

      setSelectedAppId(null);
      setAppDraft(nextApp);
      setPage("apps");
      showStatus(`已读取拖入应用：${candidate.name}，确认快捷键后保存`);
    } catch (error) {
      showStatus(`拖入应用失败：${formatError(error)}`);
    }
  }, [appSettings.apps, showStatus]);

  useEffect(() => {
    const preventDefaultDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventDefaultDrop, true);
    window.addEventListener("drop", preventDefaultDrop, true);
    return () => {
      window.removeEventListener("dragover", preventDefaultDrop, true);
      window.removeEventListener("drop", preventDefaultDrop, true);
    };
  }, []);

  const persistWindowBindings = useCallback(
    async (
      nextBindings: NativeWindowInfo[],
      successMessage: string,
      pendingMessage: string,
      previousBindings: NativeWindowInfo[],
    ) => {
      setBoundWindowsState(nextBindings);
      showStatus(pendingMessage);

      if (!isTauriRuntime()) {
        setAppSettings((current) => ({ ...current, window_bindings: nextBindings }));
        showStatus(successMessage);
        return;
      }

      try {
        const nextSettings = await updateWindowBindings(nextBindings);
        setAppSettings(nextSettings);
        setBoundWindowsState(nextSettings.window_bindings ?? nextBindings);
        showStatus(successMessage);
      } catch (error) {
        setBoundWindowsState(previousBindings);
        showStatus(`窗口绑定保存失败：${formatError(error)}`);
      }
    },
    [showStatus],
  );

  const bindWindow = useCallback(
    (window: NativeWindowInfo) => {
      const nextBindings = upsertBinding(boundWindowsState, window);
      void persistWindowBindings(
        nextBindings,
        `已绑定进程：${window.process_name}`,
        `正在绑定进程：${window.process_name}`,
        boundWindowsState,
      );
    },
    [boundWindowsState, persistWindowBindings],
  );

  const removeBinding = useCallback(
    (hwnd: number) => {
      if (pendingBindingRemovals.has(hwnd)) return;

      const binding = boundWindowsState.find((window) => window.hwnd === hwnd);
      if (!binding) return;

      const nextBindings = removeStoredBinding(boundWindowsState, binding);
      setPendingBindingRemovals((current) => new Set(current).add(hwnd));
      void persistWindowBindings(
        nextBindings,
        `已移除绑定：${binding.process_name}`,
        `正在移除绑定：${binding.process_name}`,
        boundWindowsState,
      ).finally(() => {
        setPendingBindingRemovals((current) => {
          const next = new Set(current);
          next.delete(hwnd);
          return next;
        });
      });
    },
    [boundWindowsState, pendingBindingRemovals, persistWindowBindings],
  );

  const pickTopmost = useCallback(async () => {
    setPickingTopmost(true);
    showStatus("进入置顶选择模式：点击要置顶并标记的窗口");

    try {
      const pickedWindow = await pickTopmostWindow(topmostOptions);
      setTopmostWindows((current) => upsertTopmostWindow(current, pickedWindow));
      showStatus(`已置顶并标记：${pickedWindow.title}`);
    } catch (error) {
      showStatus(`置顶选择失败：${formatError(error)}`);
    } finally {
      setPickingTopmost(false);
    }
  }, [showStatus, topmostOptions]);

  const clearTopmost = useCallback(async (hwnd: number) => {
    const window = topmostWindows.find((item) => item.hwnd === hwnd);

    try {
      await clearTopmostWindow(hwnd);
      setTopmostWindows((current) => current.filter((item) => item.hwnd !== hwnd));
      showStatus(`已取消置顶：${window?.title ?? hwnd}`);
    } catch {
      setTopmostWindows((current) => current.filter((item) => item.hwnd !== hwnd));
      showStatus(`已移除失效置顶窗口：${window?.title ?? hwnd}`);
    }
  }, [showStatus, topmostWindows]);

  const applyTopmostOptions = useCallback((options: TopmostMarkerOptions) => {
    const markerOptions = normalizeTopmostOptions(options);
    const currentWindows = topmostWindows;
    const updateId = topmostMarkerUpdateId.current + 1;
    topmostMarkerUpdateId.current = updateId;

    setTopmostOptions(markerOptions);

    if (currentWindows.length === 0) return;

    setTopmostWindows((current) => applyMarkerOptionsToTopmostWindows(current, markerOptions));

    if (!isTauriRuntime()) return;

    void Promise.allSettled(
      currentWindows.map((window) => updateTopmostWindowMarker(window.hwnd, markerOptions)),
    ).then((results) => {
      if (topmostMarkerUpdateId.current !== updateId) return;

      const updatedWindows: TopmostWindowInfo[] = [];
      const failedWindows: TopmostWindowInfo[] = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          updatedWindows.push(result.value);
        } else {
          failedWindows.push(currentWindows[index]);
        }
      });

      if (updatedWindows.length > 0) {
        setTopmostWindows((current) => {
          let next = current;
          updatedWindows.forEach((window) => {
            next = upsertTopmostWindow(next, window);
          });
          return next;
        });
      }

      if (failedWindows.length > 0) {
        showStatus("置顶标记更新失败，已保留取消入口");
      } else {
        showStatus(`已更新 ${updatedWindows.length} 个置顶窗口标记`);
      }
    });
  }, [showStatus, topmostWindows]);

  const saveExtensionSettings = useCallback(async () => {
    const quickHotkey = normalizeHotkey(quickTopmostHotkey) ?? defaultQuickTopmostHotkey();
    const markerOptions = normalizeTopmostOptions(topmostOptions);
    const opacitySettings = normalizeWindowOpacitySettings(windowOpacitySettings);
    const nextDraft: AppSettings = {
      ...appSettings,
      quick_topmost_hotkey: quickHotkey,
      topmost_marker_options: markerOptions,
      window_opacity_settings: opacitySettings,
    };

    try {
      if (isTauriRuntime()) {
        const nextSettings = await saveAppSettings(nextDraft);
        setAppSettings(nextSettings);
        setQuickTopmostHotkey(nextSettings.quick_topmost_hotkey ?? quickHotkey);
        setTopmostOptions(nextSettings.topmost_marker_options ?? markerOptions);
        setWindowOpacitySettings(nextSettings.window_opacity_settings ?? opacitySettings);
      } else {
        setAppSettings(nextDraft);
        setQuickTopmostHotkey(quickHotkey);
        setTopmostOptions(markerOptions);
        setWindowOpacitySettings(opacitySettings);
      }
      showStatus("已保存窗口置顶与窗口调光快捷键");
    } catch (error) {
      showStatus(`窗口置顶设置保存失败：${formatError(error)}`);
    }
  }, [appSettings, quickTopmostHotkey, showStatus, topmostOptions, windowOpacitySettings]);

  const saveSystemSettings = useCallback(async () => {
    try {
      if (isTauriRuntime()) {
        const nextSettings = await saveAppSettings(appSettings);
        setAppSettings(nextSettings);
        setBoundWindowsState(nextSettings.window_bindings ?? []);
        setQuickTopmostHotkey(nextSettings.quick_topmost_hotkey ?? quickTopmostHotkey);
        setTopmostOptions(nextSettings.topmost_marker_options ?? topmostOptions);
        setWindowOpacitySettings(nextSettings.window_opacity_settings ?? windowOpacitySettings);
      }
      showStatus("已保存系统设置");
    } catch (error) {
      showStatus(`系统设置保存失败：${formatError(error)}`);
    }
  }, [appSettings, quickTopmostHotkey, showStatus, topmostOptions, windowOpacitySettings]);

  const addSelectedBinding = useCallback(() => {
    if (!selectedWindow) {
      showStatus("请先刷新并选择一个窗口");
      return;
    }

    bindWindow(selectedWindow);
  }, [bindWindow, selectedWindow, showStatus]);

  const synchronizeBoundWindows = useCallback(async () => {
    try {
      const allWindows = await listAllNativeWindows();
      const visibleWindows = allWindows.filter((window) => window.visible);
      const hiddenBoundWindows = getBoundToggleTargets([], allWindows.filter((window) => !window.visible), boundWindowsState);
      setNativeWindows(visibleWindows);
      setHiddenWindows(hiddenBoundWindows);
    } catch {
      await refreshNativeWindows(false);
    }
  }, [boundWindowsState, refreshNativeWindows]);

  useEffect(() => {
    if (page === "bindings") {
      void refreshNativeWindows(false);
    }
  }, [page, refreshNativeWindows]);

  const handlePrimaryAction = useCallback(() => {
    if (page === "overview") {
      const next = createBlankApp(appSettings.apps.length);
      setSelectedAppId(null);
      setAppDraft(next);
      setPage("apps");
    } else if (page === "bindings") {
      addSelectedBinding();
    } else if (page === "extensions") {
      void pickTopmost();
    } else if (page === "dimmer") {
      void saveExtensionSettings();
    } else if (page === "recovery" && selectedWindow) {
      void showWindow(selectedWindow);
    } else if (page === "rules") {
      showStatus("规则已保留为本地默认配置，后续接入持久化");
    } else if (page === "apps") {
      void saveAppDraft();
    } else if (page === "settings") {
      void saveSystemSettings();
    } else if (page === "about") {
      void copyContact("邮箱", authorProfile.email);
    }
  }, [addSelectedBinding, appSettings.apps.length, copyContact, page, pickTopmost, saveAppDraft, saveExtensionSettings, saveSystemSettings, selectedWindow, showStatus, showWindow]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlistenDrop: (() => void) | undefined;
    let unlistenEnter: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;
    let disposed = false;

    listen<TauriDragDropPayload>(TauriEvent.DRAG_DROP, (event) => {
      void importDroppedApp(event.payload.paths?.[0] ?? null);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenDrop = unlisten;
    }).catch((error) => showStatus(`拖拽监听失败：${formatError(error)}`));

    listen<TauriDragDropPayload>(TauriEvent.DRAG_ENTER, () => {
      showStatus("松开鼠标即可导入应用快捷方式或 exe 文件");
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenEnter = unlisten;
    }).catch(() => undefined);

    listen(TauriEvent.DRAG_LEAVE, () => {
      showStatus(`已加载 ${appSettings.apps.length} 个快捷应用`);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenLeave = unlisten;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenEnter?.();
      unlistenLeave?.();
    };
  }, [appSettings.apps.length, importDroppedApp, showStatus]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlistenBindingUpdates: (() => void) | undefined;
    let unlistenErrors: (() => void) | undefined;
    let unlistenTopmostUpserts: (() => void) | undefined;
    let unlistenTopmostRemovals: (() => void) | undefined;
    let disposed = false;

    listen("manico://bindings-updated", () => {
      void synchronizeBoundWindows();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenBindingUpdates = unlisten;
    }).catch((error) => showStatus(`快捷键监听失败：${formatError(error)}`));

    listen<string>("manico://shortcut-error", (event) => {
      showStatus(event.payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenErrors = unlisten;
    }).catch(() => undefined);

    listen<TopmostWindowInfo>("manico://topmost-window-upserted", (event) => {
      setTopmostWindows((current) => upsertTopmostWindow(current, event.payload));
      showStatus(`已置顶并标记：${event.payload.title}`);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenTopmostUpserts = unlisten;
    }).catch(() => undefined);

    listen<TopmostWindowRemovedPayload>("manico://topmost-window-removed", (event) => {
      setTopmostWindows((current) => current.filter((item) => item.hwnd !== event.payload.hwnd));
      showStatus(event.payload.reason === "closed" ? "置顶窗口已关闭，已移除记录" : "已取消当前窗口置顶");
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenTopmostRemovals = unlisten;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlistenBindingUpdates?.();
      unlistenErrors?.();
      unlistenTopmostUpserts?.();
      unlistenTopmostRemovals?.();
    };
  }, [showStatus, synchronizeBoundWindows]);

  return (
    <main className="app-shell">
      <div className="window-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      {operationNotice ? (
        <NoticeToast
          notice={operationNotice}
          onDismiss={() => setOperationNotice(null)}
        />
      ) : null}
      <Rail page={page} onPageChange={setPage} />
      <Sidebar page={page} onPageChange={setPage} appCount={appSettings.apps.length} boundCount={boundWindowsState.length} />
      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>{title.title}</h2>
            <p>{title.subtitle}</p>
          </div>
          <TopActions
            page={page}
            onRefreshWindows={() => void refreshNativeWindows(true)}
            onReloadApps={() => void loadAppSettings(true)}
            onPrimaryAction={handlePrimaryAction}
          />
        </header>
        <div className="native-status">{nativeStatus}</div>
        {page === "overview" && (
          <Overview
            apps={appSettings.apps}
            visibleCount={nativeWindows.length}
            onImportDroppedPath={importDroppedApp}
            onOpenApps={() => setPage("apps")}
          />
        )}
        {page === "apps" && (
          <Applications
            apps={appSettings.apps}
            draft={appDraft}
            selectedAppId={selectedManagedApp?.id ?? null}
            onDraftChange={setAppDraft}
            onSelectApp={(app) => {
              setSelectedAppId(app.id);
              setAppDraft(app);
            }}
            onNewApp={() => {
              const next = createBlankApp(appSettings.apps.length);
              setSelectedAppId(null);
              setAppDraft(next);
            }}
            onImportDroppedPath={importDroppedApp}
            onSaveApp={saveAppDraft}
            onDeleteApp={deleteSelectedApp}
          />
        )}
        {page === "bindings" && (
          <Bindings
            windows={nativeWindows}
            boundWindows={boundWindowsState}
            selectedHwnd={selectedWindow?.hwnd ?? null}
            onSelect={setSelectedHwnd}
            onBind={(window) => {
              bindWindow(window);
            }}
            onHide={hideWindow}
            onRemoveBinding={removeBinding}
          />
        )}
        {page === "extensions" && (
          <Extensions
            topmostWindows={topmostWindows}
            topmostOptions={topmostOptions}
            quickTopmostHotkey={quickTopmostHotkey}
            isPickingTopmost={isPickingTopmost}
            onTopmostOptionsChange={applyTopmostOptions}
            onQuickTopmostHotkeyChange={setQuickTopmostHotkey}
            onSaveExtensionSettings={saveExtensionSettings}
            onPickTopmost={pickTopmost}
            onClearTopmost={clearTopmost}
          />
        )}
        {page === "dimmer" && (
          <WindowDimmer
            settings={windowOpacitySettings}
            onSettingsChange={setWindowOpacitySettings}
          />
        )}
        {page === "rules" && <Rules />}
        {page === "recovery" && (
          <Recovery
            rows={recoverableWindows}
            selectedWindow={selectedWindow}
            selectedHwnd={selectedWindow?.hwnd ?? null}
            onSelect={setSelectedHwnd}
            onHide={hideWindow}
            onShow={showWindow}
            onFreeze={freezeProcess}
            onResume={resumeProcess}
            onRemoveBinding={removeBinding}
          />
        )}
        {page === "settings" && (
          <SystemSettings
            settings={appSettings}
            onSettingsChange={setAppSettings}
          />
        )}
        {page === "about" && (
          <AboutAuthor onCopyContact={copyContact} />
        )}
      </section>
    </main>
  );
}

function NoticeToast({
  notice,
  onDismiss,
}: {
  notice: OperationNotice;
  onDismiss: () => void;
}) {
  const role = notice.tone === "error" ? "alert" : "status";

  return (
    <div
      aria-label="操作提示"
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
      className={`notice-toast ${notice.tone}`}
      role={role}
    >
      <span aria-hidden="true" className="notice-dot" />
      <div className="notice-copy">
        <b>{notice.tone === "error" ? "操作失败" : notice.tone === "success" ? "操作成功" : "操作提示"}</b>
        <p>{notice.message}</p>
      </div>
      <button aria-label="关闭提示" onClick={onDismiss} type="button">关闭</button>
    </div>
  );
}

function Rail({ page, onPageChange }: { page: NavPage; onPageChange: (page: NavPage) => void }) {
  return (
    <aside className="rail">
      <div className="brand-mark">M</div>
      {navItems.map((item) => (
        <button
          className={`rail-btn ${page === item.key ? "active" : ""}`}
          key={item.key}
          onClick={() => onPageChange(item.key)}
          title={item.label}
          type="button"
        >
          {item.rail}
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        className={`rail-btn ${page === "about" ? "active" : ""}`}
        onClick={() => onPageChange("about")}
        type="button"
        title="关于作者"
      >
        作
      </button>
      <button
        className={`rail-btn ${page === "settings" ? "active" : ""}`}
        onClick={() => onPageChange("settings")}
        type="button"
        title="设置"
      >
        设
      </button>
    </aside>
  );
}

function Sidebar({
  page,
  onPageChange,
  appCount,
  boundCount,
}: {
  page: NavPage;
  onPageChange: (page: NavPage) => void;
  appCount: number;
  boundCount: number;
}) {
  return (
    <aside className="sidebar">
      <div className="product">
        <h1>Manico</h1>
        <p>工作区控制台</p>
      </div>
      <div className="status-pill">
        <span />
        托盘运行中
      </div>
      <nav className="nav-list" aria-label="主导航">
        <div className="nav-label">工作区</div>
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${page === item.key ? "active" : ""}`}
            onClick={() => onPageChange(item.key)}
            type="button"
          >
            {item.label}
            {item.key === "apps" ? <em>{appCount}</em> : item.key === "bindings" ? <em>{boundCount}</em> : item.count ? <em>{item.count}</em> : null}
          </button>
        ))}
      </nav>
      <nav className="nav-list" aria-label="系统">
        <div className="nav-label">系统</div>
        <button
          className={`nav-item ${page === "settings" ? "active" : ""}`}
          onClick={() => onPageChange("settings")}
          type="button"
        >
          设置
        </button>
        <button
          className={`nav-item ${page === "about" ? "active" : ""}`}
          onClick={() => onPageChange("about")}
          type="button"
        >
          关于作者
        </button>
      </nav>
      <div className="sidebar-note">
        <b>快捷启动</b>
        <p>
          <kbd>Alt+键</kbd>
          调出已保存应用
        </p>
      </div>
    </aside>
  );
}

function TopActions({
  page,
  onRefreshWindows,
  onReloadApps,
  onPrimaryAction,
}: {
  page: NavPage;
  onRefreshWindows: () => void;
  onReloadApps: () => void;
  onPrimaryAction: () => void;
}) {
  const actions: Record<NavPage, [string, string]> = {
    overview: ["重载配置", "新建快捷"],
    apps: ["重载配置", "保存应用"],
    bindings: ["刷新进程", "添加绑定"],
    extensions: ["刷新窗口", "选择置顶"],
    dimmer: ["重载配置", "保存调光"],
    rules: ["重置设置", "保存规则"],
    recovery: ["刷新窗口", "显示选中窗口"],
    settings: ["重载配置", "保存设置"],
    about: ["重载配置", "复制联系邮箱"],
  };

  return (
    <div className="top-actions">
      <button
        className="secondary"
        onClick={
          page === "apps"
            || page === "overview"
            || page === "dimmer"
            || page === "settings"
            || page === "about"
            ? onReloadApps
            : page === "bindings" || page === "extensions" || page === "recovery"
              ? onRefreshWindows
              : undefined
        }
        type="button"
      >
        {actions[page][0]}
      </button>
      <button className="primary" onClick={onPrimaryAction} type="button">{actions[page][1]}</button>
    </div>
  );
}

function Overview({
  apps,
  visibleCount,
  onImportDroppedPath,
  onOpenApps,
}: {
  apps: ManagedApp[];
  visibleCount: number;
  onImportDroppedPath: (path: string | null) => void;
  onOpenApps: () => void;
}) {
  return (
    <div className="page-grid">
      <div className="main-stack">
        <div className="metrics">
          <Metric label="快捷应用" value={String(apps.length)} note="配置持久化" />
          <Metric label="可见窗口" value={String(visibleCount)} note="来自系统枚举" />
          <Metric label="可用热键" value={String(getLaunchableHotkeys(apps).length)} note="全局启动/切换" />
          <Metric label="启动模式" value="切换" note="已运行时调出窗口" />
        </div>
        <Panel title="快捷添加启动" subtitle="拖入桌面图标、开始菜单快捷方式或 exe 文件，生成可绑定热键的应用入口。" badge="Alt+键">
          <AppDropZone onImportDroppedPath={onImportDroppedPath} />
          <AppRows items={apps} compact />
          <button className="primary full" onClick={onOpenApps} type="button">进入应用启动</button>
        </Panel>
      </div>
      <Inspector title="快捷启动">
        <div className="identity"><Icon tone="blue" label="启" /><b>添加后即可用热键调出应用</b></div>
        <div className="inspector-section">
          <h3>当前快捷</h3>
          {apps.length > 0 ? (
            apps.slice(0, 4).map((app) => (
              <HotkeyCard
                key={app.id}
                name={app.name}
                desc="启动或切换到应用窗口"
                hotkey={formatHotkey(app.hotkey) || "未设置"}
              />
            ))
          ) : (
            <EmptyState text="还没有快捷应用。拖入一个应用图标开始。" />
          )}
        </div>
      </Inspector>
    </div>
  );
}

function Applications({
  apps,
  draft,
  selectedAppId,
  onDraftChange,
  onSelectApp,
  onNewApp,
  onImportDroppedPath,
  onSaveApp,
  onDeleteApp,
}: {
  apps: ManagedApp[];
  draft: ManagedApp;
  selectedAppId: string | null;
  onDraftChange: (app: ManagedApp) => void;
  onSelectApp: (app: ManagedApp) => void;
  onNewApp: () => void;
  onImportDroppedPath: (path: string | null) => void;
  onSaveApp: () => void;
  onDeleteApp: () => void;
}) {
  return (
    <div className="page-grid">
      <div className="main-stack">
        <Panel title="应用列表" subtitle="配置常用应用，点击启动时自动切换已有窗口或启动新进程。">
          <AppDropZone onImportDroppedPath={onImportDroppedPath} />
          <div className="panel-tools">
            <div className="search">搜索应用、路径或热键</div>
            <button className="secondary" onClick={onNewApp} type="button">新建应用</button>
          </div>
          <AppTable apps={apps} selectedAppId={selectedAppId} onSelectApp={onSelectApp} />
        </Panel>
        <Panel title="分组与排序" subtitle="左侧分组用于快捷启动；老板键绑定在隐藏模块单独管理。">
          <div className="button-row">
            <button className="secondary" type="button">新建分组</button>
            <button className="secondary" type="button">重命名</button>
            <button className="danger" type="button">删除</button>
          </div>
        </Panel>
      </div>
      <Inspector title="应用详情">
        <div className="identity">
          <Icon tone={toneForApp(draft)} label={appInitial(draft)} />
          <b>{draft.name || "新应用"}</b>
        </div>
        <div className="form-stack">
          <Field label="名称" value={draft.name} onChange={(value) => onDraftChange({ ...draft, name: value })} />
          <Field label="exe 路径" value={draft.executable_path} onChange={(value) => onDraftChange({ ...draft, executable_path: value })} />
          <Field label="启动参数" value={draft.arguments ?? ""} onChange={(value) => onDraftChange({ ...draft, arguments: value })} />
          <Field label="工作目录" value={draft.working_directory ?? ""} onChange={(value) => onDraftChange({ ...draft, working_directory: value })} />
          <HotkeyFields title="启动快捷键" hotkey={draft.hotkey ?? defaultHotkey()} onChange={(hotkey) => onDraftChange({ ...draft, hotkey })} />
        </div>
        <div className="inspector-section">
          <h3>操作</h3>
          <HotkeyCard name="切换或启动" desc="应用已运行时切到窗口" hotkey={formatHotkey(draft.hotkey) || "未设置"} />
          <button className="primary full" onClick={onSaveApp} type="button">保存应用</button>
          <button className="danger full" disabled={!selectedAppId} onClick={onDeleteApp} type="button">删除应用</button>
        </div>
      </Inspector>
    </div>
  );
}

function AppDropZone({ onImportDroppedPath }: { onImportDroppedPath: (path: string | null) => void }) {
  const [isDragActive, setDragActive] = useState(false);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    onImportDroppedPath(extractDroppedPath(event.dataTransfer));
  };

  return (
    <div
      className={`drop-zone ${isDragActive ? "active" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <span>+</span>
      <div>
        <b>拖入应用图标</b>
        <small>支持桌面快捷方式、开始菜单快捷方式或 exe 文件</small>
      </div>
    </div>
  );
}

function Bindings({
  windows,
  boundWindows,
  selectedHwnd,
  onSelect,
  onBind,
  onHide,
  onRemoveBinding,
}: {
  windows: NativeWindowInfo[];
  boundWindows: NativeWindowInfo[];
  selectedHwnd: number | null;
  onSelect: (hwnd: number) => void;
  onBind: (window: NativeWindowInfo) => void;
  onHide: (window: NativeWindowInfo) => void;
  onRemoveBinding: (hwnd: number) => void;
}) {
  const selectedWindow = windows.find((window) => window.hwnd === selectedHwnd) ?? null;

  return (
    <div className="main-stack full bindings-page">
      <div className="binding-summary">
        <BindingStat label="当前可见窗口" value={`${windows.length}`} note="刷新后同步系统窗口" />
        <BindingStat label="已绑定进程" value={`${boundWindows.length}`} note="Ctrl+Q 只按这些进程计数" />
        <BindingStat
          label="当前选择"
          value={selectedWindow?.process_name ?? "未选择"}
          note={selectedWindow?.title ?? "从左侧列表选择窗口后添加绑定"}
        />
      </div>
      <div className="binding-grid">
        <Panel title="当前窗口" subtitle="按窗口标题、句柄和 PID 扫描；长标题会自动收起。">
          <WindowTable windows={windows} selectedHwnd={selectedHwnd} onSelect={onSelect} onBind={onBind} onHide={onHide} />
        </Panel>
        <Panel title="已绑定进程" subtitle="这里显示绑定项数量；同一路径进程只保留一条。">
          <BoundRows items={boundWindows} onRemove={onRemoveBinding} />
        </Panel>
      </div>
      <Panel title="Ctrl+Q 总切换" subtitle="绑定项没有单独快捷键，统一由全局 Ctrl+Q 控制。">
        <div className="split">
          <HotkeyCard name="显示/隐藏绑定窗口" desc="有隐藏窗口时恢复，否则隐藏全部匹配窗口" hotkey="Ctrl+Q" />
          <div className="warning">
            绑定按进程路径优先匹配，路径读取不到时按进程名匹配；同一进程的多个窗口会一起处理。
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Extensions({
  topmostWindows,
  topmostOptions,
  quickTopmostHotkey,
  isPickingTopmost,
  onTopmostOptionsChange,
  onQuickTopmostHotkeyChange,
  onSaveExtensionSettings,
  onPickTopmost,
  onClearTopmost,
}: {
  topmostWindows: TopmostWindowInfo[];
  topmostOptions: TopmostMarkerOptions;
  quickTopmostHotkey: HotkeyConfig;
  isPickingTopmost: boolean;
  onTopmostOptionsChange: (options: TopmostMarkerOptions) => void;
  onQuickTopmostHotkeyChange: (hotkey: HotkeyConfig) => void;
  onSaveExtensionSettings: () => void;
  onPickTopmost: () => void;
  onClearTopmost: (hwnd: number) => void;
}) {
  const patchOptions = (patch: Partial<TopmostMarkerOptions>) => {
    onTopmostOptionsChange({ ...topmostOptions, ...patch });
  };

  return (
    <div className="extensions-page" aria-label="窗口置顶工作区">
      <div className="extension-workbench">
        <section className="panel marker-editor-panel" aria-label="置顶标记设置">
          <header className="panel-header">
            <div>
              <h3>窗口置顶标记</h3>
              <p>点选窗口后创建透明穿透标记层，并让它跟随目标窗口。</p>
            </div>
          </header>
          <div className="topmost-tool">
            <button className="primary" disabled={isPickingTopmost} onClick={onPickTopmost} type="button">
              {isPickingTopmost ? "等待选择..." : "选择窗口置顶"}
            </button>
            <label className="color-field">
              <span>标记颜色</span>
              <input
                aria-label="标记颜色"
                onChange={(event) => patchOptions({ marker_color: event.target.value })}
                type="color"
                value={topmostOptions.marker_color}
              />
            </label>
            <div className="color-swatches" aria-label="常用标记颜色">
              {["#ef4444", "#2f6df6", "#1d9a72", "#d87418", "#8b5cf6"].map((color) => (
                <button
                  aria-label={`使用颜色 ${color}`}
                  className={`swatch ${topmostOptions.marker_color.toLowerCase() === color ? "active" : ""}`}
                  key={color}
                  onClick={() => patchOptions({ marker_color: color })}
                  style={{ "--swatch-color": color } as CSSProperties}
                  type="button"
                />
              ))}
            </div>
          </div>
          <div className="marker-controls">
            <MarkerSlider
              label="边框粗细"
              max={12}
              min={1}
              suffix="px"
              value={topmostOptions.border_width}
              onChange={(border_width) => patchOptions({ border_width })}
            />
            <MarkerSlider
              label="发光强度"
              max={40}
              min={0}
              suffix="px"
              value={topmostOptions.glow_size}
              onChange={(glow_size) => patchOptions({ glow_size })}
            />
            <MarkerSlider
              label="透明度"
              max={100}
              min={20}
              suffix="%"
              value={Math.round(topmostOptions.opacity * 100)}
              onChange={(opacity) => patchOptions({ opacity: opacity / 100 })}
            />
          </div>
          <div className="style-segments" aria-label="标记样式">
            {(["line", "glow", "pulse"] as TopmostMarkerStyle[]).map((style) => (
              <button
                aria-pressed={topmostOptions.marker_style === style}
                className={topmostOptions.marker_style === style ? "active" : ""}
                key={style}
                onClick={() => patchOptions({ marker_style: style })}
                type="button"
              >
                {topmostStyleLabel(style)}
              </button>
            ))}
          </div>
        </section>

        <section className="panel marker-preview-panel" aria-label="置顶效果预览">
          <header className="panel-header">
            <div>
              <h3>效果预览</h3>
              <p>预览标记强度，实际效果会贴住系统窗口边缘。</p>
            </div>
          </header>
          <MarkerPreview options={topmostOptions} />
        </section>
      </div>

      <section className="quick-topmost-bar" aria-label="快速置顶工具条">
        <div className="quick-copy">
          <span>快速置顶</span>
          <b>当前窗口置顶切换</b>
          <small>当前前台窗口已置顶时取消置顶，未置顶时添加置顶标记。</small>
        </div>
        <div className="quick-hotkey-compact">
          <HotkeyFields
            title="快速置顶快捷键"
            hotkey={quickTopmostHotkey}
            onChange={onQuickTopmostHotkeyChange}
          />
        </div>
        <kbd className="quick-hotkey-display">{formatHotkey(quickTopmostHotkey) || "未设置"}</kbd>
        <button className="primary quick-save" onClick={onSaveExtensionSettings} type="button">保存窗口设置</button>
      </section>

      <section className="panel pinned-topmost-panel" aria-label="已置顶窗口列表">
        <header className="panel-header">
          <div>
            <h3>已置顶窗口</h3>
            <p>这里显示当前由 Manico 管理的置顶窗口和标记效果。</p>
          </div>
        </header>
        <TopmostRows items={topmostWindows} onClear={onClearTopmost} />
      </section>
    </div>
  );
}

function WindowDimmer({
  settings,
  onSettingsChange,
}: {
  settings: WindowOpacitySettings;
  onSettingsChange: (settings: WindowOpacitySettings) => void;
}) {
  const patchSettings = (patch: Partial<WindowOpacitySettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  return (
    <div className="page-grid dimmer-page" aria-label="窗口调光工作区">
      <div className="main-stack">
        <Panel title="调光快捷键" subtitle="快捷键始终作用于当前前台窗口，可分别调低、调高或还原透明度。" badge="当前窗口">
          <div className="dimmer-hotkeys">
            <HotkeyFields
              title="调低透明度"
              hotkey={settings.decrease_hotkey}
              onChange={(decrease_hotkey) => patchSettings({ decrease_hotkey })}
            />
            <HotkeyFields
              title="调高透明度"
              hotkey={settings.increase_hotkey}
              onChange={(increase_hotkey) => patchSettings({ increase_hotkey })}
            />
            <HotkeyFields
              title="还原透明度"
              hotkey={settings.reset_hotkey}
              onChange={(reset_hotkey) => patchSettings({ reset_hotkey })}
            />
          </div>
        </Panel>
        <Panel title="调光参数" subtitle="控制每次快捷键改变的幅度，并设置最低透明度保护线。">
          <div className="dimmer-controls">
            <MarkerSlider
              label="调节步进"
              max={30}
              min={5}
              suffix="%"
              value={settings.step_percent}
              onChange={(step_percent) => patchSettings({ step_percent })}
            />
            <MarkerSlider
              label="最低透明度"
              max={80}
              min={20}
              suffix="%"
              value={settings.min_percent}
              onChange={(min_percent) => patchSettings({ min_percent })}
            />
          </div>
        </Panel>
      </div>
      <Inspector title="调光状态">
        <div className="identity">
          <Icon tone="blue" label="光" />
          <b>控制当前前台窗口透明度</b>
        </div>
        <div className="inspector-section">
          <h3>当前快捷键</h3>
          <HotkeyCard name="调低透明度" desc={`每次降低 ${settings.step_percent}%`} hotkey={formatHotkey(settings.decrease_hotkey)} />
          <HotkeyCard name="调高透明度" desc={`每次提高 ${settings.step_percent}%`} hotkey={formatHotkey(settings.increase_hotkey)} />
          <HotkeyCard name="还原透明度" desc="恢复到 100%" hotkey={formatHotkey(settings.reset_hotkey)} />
        </div>
        <div className="dimmer-summary">
          <span>保护线</span>
          <b>最低 {settings.min_percent}%</b>
          <small>避免窗口被调到几乎看不见；还原快捷键始终会恢复到 100%。</small>
        </div>
      </Inspector>
    </div>
  );
}

function SystemSettings({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}) {
  return (
    <div className="main-stack full settings-page" aria-label="系统设置工作区">
      <Panel title="启动与托盘" subtitle="这些设置会影响 Manico 自身的运行方式。">
        <div className="settings-grid">
          <SettingToggle
            checked={settings.start_with_windows}
            desc="写入当前用户的 Windows 启动项，登录后自动启动 Manico。"
            label="开机自动启动"
            onChange={(start_with_windows) => onSettingsChange({ ...settings, start_with_windows })}
          />
          <SettingToggle
            checked={settings.minimize_to_tray}
            desc="关闭主窗口时保持托盘运行，快捷键和窗口控制继续生效。"
            label="关闭窗口时最小化到托盘"
            onChange={(minimize_to_tray) => onSettingsChange({ ...settings, minimize_to_tray })}
          />
        </div>
      </Panel>
      <Panel title="当前配置" subtitle="设置保存后会立即同步到本地配置文件。">
        <div className="settings-status-grid">
          <HotkeyCard name="开机自启" desc="Windows 当前用户启动项" hotkey={settings.start_with_windows ? "已开启" : "未开启"} />
          <HotkeyCard name="托盘运行" desc="关闭窗口后的处理方式" hotkey={settings.minimize_to_tray ? "已开启" : "直接关闭"} />
          <HotkeyCard name="快捷应用" desc="已保存应用数量" hotkey={`${settings.apps.length}`} />
        </div>
      </Panel>
    </div>
  );
}

function AboutAuthor({
  onCopyContact,
}: {
  onCopyContact: (label: string, value: string) => void;
}) {
  return (
    <div className="page-grid about-page" aria-label="关于作者工作区">
      <div className="main-stack">
        <section className="panel author-hero">
          <div className="author-hero-main">
            <Icon tone="blue" label="M" />
            <div>
              <span className="author-kicker">Manico Author</span>
              <h3>{authorProfile.name}</h3>
              <p>持续把 Windows 日常效率工具做得更顺手：快捷启动、窗口绑定、置顶标记和窗口调光都会围绕真实使用场景继续打磨。</p>
            </div>
          </div>
          <div className="author-badges" aria-label="作者标签">
            <span>桌面效率</span>
            <span>Windows 工具</span>
            <span>持续迭代</span>
          </div>
        </section>
        <Panel title="联系方式" subtitle="遇到问题、想反馈体验或者讨论定制需求，可以通过下面的方式联系。">
          <div className="contact-list" aria-label="作者联系方式">
            <ContactCard
              actionLabel="复制 QQ"
              label="QQ"
              tone="purple"
              value={authorProfile.qq}
              onCopy={() => onCopyContact("QQ", authorProfile.qq)}
            />
            <ContactCard
              actionLabel="复制邮箱"
              label="邮箱"
              tone="green"
              value={authorProfile.email}
              onCopy={() => onCopyContact("邮箱", authorProfile.email)}
            />
          </div>
        </Panel>
      </div>
      <Inspector title="联系作者">
        <div className="author-side-card">
          <Icon tone="blue" label="M" />
          <div>
            <b>{authorProfile.name}</b>
            <span>Manico 作者</span>
          </div>
        </div>
        <div className="inspector-section">
          <h3>快速复制</h3>
          <div className="side-action-stack">
            <button className="primary full" onClick={() => onCopyContact("邮箱", authorProfile.email)} type="button">复制作者邮箱</button>
            <button className="secondary full" onClick={() => onCopyContact("QQ", authorProfile.qq)} type="button">复制作者 QQ</button>
          </div>
          <div className="contact-note">
            <b>邮箱更适合详细反馈</b>
            <span>功能建议、异常截图和复现步骤都可以一起发过来。</span>
          </div>
        </div>
      </Inspector>
    </div>
  );
}

function ContactCard({
  label,
  value,
  tone,
  actionLabel,
  onCopy,
}: {
  label: string;
  value: string;
  tone: string;
  actionLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="contact-card">
      <Icon tone={tone} label={label.slice(0, 1)} />
      <span className="contact-label">{label}</span>
      <b className="contact-value">{value}</b>
      <div className="contact-action">
        <button className="secondary" onClick={onCopy} type="button">{actionLabel}</button>
      </div>
    </div>
  );
}

function SettingToggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-toggle">
      <input
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className={`switch ${checked ? "on" : ""}`} aria-hidden="true" />
      <span>
        <b>{label}</b>
        <small>{desc}</small>
      </span>
    </label>
  );
}

function MarkerSlider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="marker-slider">
      <span>{label}</span>
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        type="range"
        value={value}
      />
      <b>{value}{suffix}</b>
    </label>
  );
}

function MarkerPreview({ options }: { options: TopmostMarkerOptions }) {
  return (
    <div
      className={`marker-preview ${options.marker_style}`}
      style={{
        "--marker-color": options.marker_color,
        "--marker-width": `${options.border_width}px`,
        "--marker-glow": `${options.glow_size}px`,
        "--marker-opacity": String(options.opacity),
      } as CSSProperties}
    >
      <div className="preview-window">
        <span />
        <strong>目标窗口</strong>
        <small>发散标记层</small>
      </div>
    </div>
  );
}

function BindingStat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="binding-stat">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <small title={note}>{note}</small>
    </div>
  );
}

function Rules() {
  return (
    <div className="page-grid">
      <div className="main-stack">
        <Panel title="键盘热键" subtitle="隐藏/恢复窗口与一键关闭程序。">
          <div className="split">
            <HotkeyCard name="隐藏/显示窗口" desc="切换所有绑定窗口状态" hotkey="Ctrl+Q" />
            <HotkeyCard name="一键关闭程序" desc="退出 Manico 托盘进程" hotkey="Win+Esc" />
          </div>
        </Panel>
        <Panel title="鼠标隐藏" subtitle="中键、侧键、屏幕四角和移动恢复。" badge="4 个角落启用">
          <div className="mouse-grid">
            <div className="corner-map">
              <span className="tl">左上隐藏</span><span className="tr">右上隐藏</span>
              <span className="bl">左下隐藏</span><span className="br">右下隐藏</span>
            </div>
            <div className="main-stack tight">
              <Rule title="启用鼠标中键切换隐藏" desc="点击中键快速隐藏或恢复窗口。" />
              <Rule title="启用移动恢复窗口" desc="移动到同一角落时恢复已隐藏窗口。" />
            </div>
          </div>
        </Panel>
        <Panel title="隐藏与冻结行为" subtitle="保留 Boss-Key 原有开关，改成分组卡片。">
          <div className="rule-grid">
            {rules.map((rule) => <Rule key={rule.title} {...rule} />)}
          </div>
        </Panel>
      </div>
      <Inspector title="权限检测">
        <Detail label="管理员权限" value="未启用" />
        <Detail label="pssuspend64" value="未检测" />
        <Detail label="基础冻结" value="可用" />
        <div className="warning">基础冻结使用系统进程控制接口；增强冻结需要管理员权限和外部工具时再启用。</div>
        <button className="primary full" type="button">以管理员身份重启</button>
      </Inspector>
    </div>
  );
}

function Recovery({
  rows,
  selectedWindow,
  selectedHwnd,
  onSelect,
  onHide,
  onShow,
  onFreeze,
  onResume,
  onRemoveBinding,
}: {
  rows: RecoverableWindow[];
  selectedWindow: RecoverableWindow | null;
  selectedHwnd: number | null;
  onSelect: (hwnd: number) => void;
  onHide: (window: NativeWindowInfo) => void;
  onShow: (window: NativeWindowInfo) => void;
  onFreeze: (window: NativeWindowInfo) => void;
  onResume: (window: NativeWindowInfo) => void;
  onRemoveBinding: (hwnd: number) => void;
}) {
  return (
    <div className="page-grid">
      <div className="main-stack">
        <Panel title="隐藏窗口与冻结进程" subtitle="恢复、隐藏、冻结和解冻都在这里集中处理。">
          <div className="panel-tools">
            <div className="search">搜索窗口标题、进程或 PID</div>
            <div className="button-row">
              <button className="secondary" disabled={!selectedWindow} onClick={() => selectedWindow && onHide(selectedWindow)} type="button">隐藏窗口</button>
              <button className="secondary" disabled={!selectedWindow} onClick={() => selectedWindow && onFreeze(selectedWindow)} type="button">冻结进程</button>
              <button className="danger" disabled={!selectedWindow} onClick={() => selectedWindow && onResume(selectedWindow)} type="button">解冻进程</button>
            </div>
          </div>
          <RecoveryTable
            rows={rows}
            selectedHwnd={selectedHwnd}
            onSelect={onSelect}
            onHide={onHide}
            onShow={onShow}
            onFreeze={onFreeze}
            onResume={onResume}
          />
        </Panel>
        <div className="split">
          <Panel title="批量恢复" subtitle="一次恢复所有 Manico 隐藏的窗口。">
            <button className="primary" disabled={rows.every((row) => !row.hidden)} type="button">恢复全部</button>
          </Panel>
          <Panel title="管理员权限" subtitle="冻结/解冻未知进程前建议启用。">
            <button className="secondary" type="button">获取权限</button>
          </Panel>
        </div>
      </div>
      <Inspector title="选中窗口">
        {selectedWindow ? (
          <>
            <div className="identity"><Icon tone={toneForProcess(selectedWindow.process_name)} label={processInitial(selectedWindow.process_name)} /><b>{selectedWindow.process_name}</b></div>
            <Detail label="标题" value={selectedWindow.title} />
            <Detail label="窗口句柄" value={selectedWindow.hwnd} />
            <Detail label="进程 PID" value={selectedWindow.process_id} />
            <Detail label="路径" value={selectedWindow.process_path ?? "路径未读取"} />
            <button className="primary full" onClick={() => onShow(selectedWindow)} type="button">显示窗口</button>
            <button className="secondary full" onClick={() => onRemoveBinding(selectedWindow.hwnd)} type="button">从绑定中移除</button>
          </>
        ) : (
          <EmptyState text="刷新窗口后选择一个目标。" />
        )}
      </Inspector>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Panel({ title, subtitle, badge, children }: { title: string; subtitle: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        {badge ? <span className="chip blue">{badge}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Inspector({ title, children }: { title: string; children: React.ReactNode }) {
  return <aside className="inspector"><h3>{title}</h3>{children}</aside>;
}

function AppRows({
  items,
  compact = false,
}: {
  items: ManagedApp[];
  compact?: boolean;
}) {
  if (items.length === 0) {
    return <EmptyState text="暂无快捷应用。进入应用启动页添加 exe 路径和热键。" />;
  }

  return (
    <div className="rows">
      {items.slice(0, compact ? 3 : items.length).map((app) => (
        <Row
          key={app.id}
          icon={appInitial(app)}
          tone={toneForApp(app)}
          title={app.name}
          meta={app.executable_path}
          right={<kbd>{formatHotkey(app.hotkey) || "未设置"}</kbd>}
        />
      ))}
    </div>
  );
}

function BoundRows({
  items,
  compact = false,
  onRemove,
}: {
  items: NativeWindowInfo[];
  compact?: boolean;
  onRemove?: (hwnd: number) => void;
}) {
  if (items.length === 0) {
    return <EmptyState text="暂无绑定窗口。刷新窗口后选择目标，再点击添加绑定。" />;
  }

  return (
    <div className="rows binding-list-scroll">
      {items.slice(0, compact ? 2 : items.length).map((window) => (
        <Row
          key={window.hwnd}
          icon={processInitial(window.process_name)}
          tone={toneForProcess(window.process_name)}
          title={window.title}
          meta={formatWindowMeta(window)}
          right={(
            <div className="row-actions">
              <span className="chip green">已绑定</span>
              {onRemove ? <button className="mini danger" onClick={() => onRemove(window.hwnd)} type="button">移除</button> : null}
            </div>
          )}
        />
      ))}
    </div>
  );
}

function TopmostRows({
  items,
  onClear,
}: {
  items: TopmostWindowInfo[];
  onClear: (hwnd: number) => void;
}) {
  if (items.length === 0) {
    return <EmptyState text="暂无置顶窗口。点击选择置顶，然后点选需要保持在最上层的窗口。" />;
  }

  return (
    <div className="rows topmost-rows">
      {items.map((window) => (
        <Row
          key={window.hwnd}
          icon={processInitial(window.process_name)}
          tone={toneForProcess(window.process_name)}
          title={window.title}
          meta={formatWindowMeta(window)}
          pinColor={window.marker_color}
          right={(
            <div className="row-actions">
              <span className="chip red">已置顶</span>
              <span className="chip gray">{window.border_width}px / {topmostStyleLabel(window.marker_style)}</span>
              <button className="mini danger" onClick={() => onClear(window.hwnd)} type="button">取消置顶</button>
            </div>
          )}
        />
      ))}
    </div>
  );
}

function AppTable({
  apps,
  selectedAppId,
  onSelectApp,
}: {
  apps: ManagedApp[];
  selectedAppId: string | null;
  onSelectApp: (app: ManagedApp) => void;
}) {
  if (apps.length === 0) {
    return <EmptyState text="还没有应用。点击新建应用，填写 exe 路径后即可启动或切换。" />;
  }

  return (
    <div className="table apps-table">
      <div className="thead"><span>应用</span><span>路径</span><span>热键</span><span>状态</span></div>
      {apps.map((app) => (
        <div
          className={`tr selectable ${selectedAppId === app.id ? "selected" : ""}`}
          key={app.id}
          onClick={() => onSelectApp(app)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectApp(app);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span><Icon tone={toneForApp(app)} label={appInitial(app)} /> {app.name}</span>
          <span className="muted">{app.executable_path}</span>
          <kbd>{formatHotkey(app.hotkey) || "未设置"}</kbd>
          <span className="chip blue">可启动</span>
        </div>
      ))}
    </div>
  );
}

function WindowTable({
  windows,
  selectedHwnd,
  onSelect,
  onBind,
  onHide,
}: {
  windows: NativeWindowInfo[];
  selectedHwnd: number | null;
  onSelect: (hwnd: number) => void;
  onBind: (window: NativeWindowInfo) => void;
  onHide: (window: NativeWindowInfo) => void;
}) {
  if (windows.length === 0) {
    return <EmptyState text="点击刷新进程读取当前系统窗口。" />;
  }

  return (
    <div className="table-scroll window-table-scroll">
      <div className="table windows-table">
        <div className="thead"><span>窗口标题</span><span>窗口句柄</span><span>进程 PID</span><span>操作</span></div>
        {windows.map((window) => (
          <div
            className={`tr selectable ${selectedHwnd === window.hwnd ? "selected" : ""}`}
            key={window.hwnd}
            onClick={() => onSelect(window.hwnd)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(window.hwnd);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span className="window-title-cell">
              <Icon tone={toneForProcess(window.process_name)} label={processInitial(window.process_name)} />
              <span className="window-title-text" title={window.title}>{window.title}</span>
            </span>
            <span className="mono-value">{window.hwnd}</span>
            <span className="mono-value">{window.process_id}</span>
            <span className="table-actions">
              <button className="mini secondary" onClick={(event) => { event.stopPropagation(); onBind(window); }} type="button">绑定</button>
              <button className="mini danger" onClick={(event) => { event.stopPropagation(); onHide(window); }} type="button">隐藏</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecoveryTable({
  rows,
  selectedHwnd,
  onSelect,
  onHide,
  onShow,
  onFreeze,
  onResume,
}: {
  rows: RecoverableWindow[];
  selectedHwnd: number | null;
  onSelect: (hwnd: number) => void;
  onHide: (window: NativeWindowInfo) => void;
  onShow: (window: NativeWindowInfo) => void;
  onFreeze: (window: NativeWindowInfo) => void;
  onResume: (window: NativeWindowInfo) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState text="暂无可恢复窗口。先刷新窗口或隐藏一个窗口。" />;
  }

  return (
    <div className="table recovery-table">
      <div className="thead"><span>窗口标题</span><span>状态</span><span>窗口句柄</span><span>进程 PID</span><span>操作</span></div>
      {rows.map((row) => (
        <div
          className={`tr selectable ${selectedHwnd === row.hwnd ? "selected" : ""}`}
          key={row.hwnd}
          onClick={() => onSelect(row.hwnd)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(row.hwnd);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span><Icon tone={toneForProcess(row.process_name)} label={processInitial(row.process_name)} /> {row.title}</span>
          <span className={`chip ${row.hidden ? "red" : row.frozen ? "orange" : "green"}`}>{recoveryStateLabel(row)}</span>
          <span>{row.hwnd}</span>
          <span>{row.process_id}</span>
          <span className="table-actions">
            {row.hidden ? (
              <button className="mini secondary" onClick={(event) => { event.stopPropagation(); onShow(row); }} type="button">显示</button>
            ) : (
              <button className="mini secondary" onClick={(event) => { event.stopPropagation(); onHide(row); }} type="button">隐藏</button>
            )}
            {row.frozen ? (
              <button className="mini danger" onClick={(event) => { event.stopPropagation(); onResume(row); }} type="button">解冻</button>
            ) : (
              <button className="mini secondary" onClick={(event) => { event.stopPropagation(); onFreeze(row); }} type="button">冻结</button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Row({
  icon,
  tone,
  title,
  meta,
  right,
  pinColor,
}: {
  icon: string;
  tone: string;
  title: string;
  meta: string;
  right: React.ReactNode;
  pinColor?: string;
}) {
  return (
    <div className="row-card">
      <div>
        <div className="row-title"><Icon tone={tone} label={icon} /> <b>{title}</b>{pinColor ? <PinMark color={pinColor} /> : null}</div>
        <p>{meta}</p>
      </div>
      {right}
    </div>
  );
}

function Rule({ title, desc, enabled = false }: { title: string; desc: string; enabled?: boolean }) {
  return <div className="rule"><div><h4>{title}</h4><p>{desc}</p></div><span className={`switch ${enabled ? "on" : ""}`} /></div>;
}

function HotkeyCard({
  name,
  desc,
  hotkey,
  pinned = false,
}: {
  name: string;
  desc: string;
  hotkey: string;
  pinned?: boolean;
}) {
  return (
    <div className="hotkey-card">
      <div><b>{name}{pinned ? <PinMark /> : null}</b><span>{desc}</span></div>
      <kbd>{hotkey}</kbd>
    </div>
  );
}

function PinMark({ color = "#ef4444" }: { color?: string }) {
  return <span className="pin-mark" aria-label="已置顶" style={{ "--pin-color": color } as CSSProperties} title="已置顶" />;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field-label">
      <span>{label}</span>
      <input
        className="field"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        type="text"
        value={value}
      />
    </label>
  );
}

function HotkeyFields({
  title,
  hotkey,
  onChange,
}: {
  title: string;
  hotkey: HotkeyConfig;
  onChange: (hotkey: HotkeyConfig) => void;
}) {
  const patchHotkey = (patch: Partial<HotkeyConfig>) => onChange({ ...hotkey, ...patch });

  return (
    <div className="hotkey-editor">
      <div className="hotkey-title">{title}</div>
      <div className="field-label">
        <span>修饰键</span>
        <div className="hotkey-mods">
          <CheckPill label="Ctrl" checked={hotkey.ctrl} onChange={(checked) => patchHotkey({ ctrl: checked })} />
          <CheckPill label="Alt" checked={hotkey.alt} onChange={(checked) => patchHotkey({ alt: checked })} />
          <CheckPill label="Shift" checked={hotkey.shift} onChange={(checked) => patchHotkey({ shift: checked })} />
          <CheckPill label="Win" checked={hotkey.win} onChange={(checked) => patchHotkey({ win: checked })} />
        </div>
      </div>
      <Field
        label="按键"
        onChange={(value) => patchHotkey({ key: value.slice(0, 16) })}
        placeholder="R / 1 / F8"
        value={hotkey.key}
      />
    </div>
  );
}

function CheckPill({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`check-pill ${checked ? "checked" : ""}`}>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      {label}
    </label>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="detail"><span>{label}</span><b>{value}</b></div>;
}

function Icon({ tone, label }: { tone: string; label: string }) {
  return <span className={`icon ${tone}`}>{label}</span>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const didCopy = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!didCopy) {
    throw new Error("当前环境不支持写入剪贴板");
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noticeToneForMessage(message: string): NoticeTone {
  if (/(失败|错误|不能为空|请先|没有读取|未找到|无法|不能)/.test(message)) {
    return "error";
  }

  if (/^(已|保存|添加|删除|恢复|隐藏|冻结|解冻|读取|更新)/.test(message)) {
    return "success";
  }

  return "info";
}

function formatWindowMeta(window: NativeWindowInfo): string {
  return `${window.process_name} · PID ${window.process_id}${window.process_path ? ` · ${window.process_path}` : ""}`;
}

function recoveryStateLabel(row: RecoverableWindow): string {
  if (row.hidden && row.frozen) return "隐藏+冻结";
  if (row.hidden) return "已隐藏";
  if (row.frozen) return "已冻结";
  return "可见";
}

function createBlankApp(order: number): ManagedApp {
  return {
    id: makeId(),
    name: "",
    executable_path: "",
    shortcut_path: null,
    app_user_model_id: null,
    arguments: null,
    working_directory: null,
    group_id: "default",
    hotkey: defaultHotkey(),
    order,
  };
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultHotkey(): HotkeyConfig {
  return { ctrl: false, alt: true, shift: false, win: false, key: "" };
}

function defaultQuickTopmostHotkey(): HotkeyConfig {
  return { ctrl: true, alt: true, shift: false, win: false, key: "P" };
}

function defaultWindowOpacitySettings(): WindowOpacitySettings {
  return {
    decrease_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "1" },
    increase_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "2" },
    reset_hotkey: { ctrl: true, alt: true, shift: false, win: false, key: "0" },
    step_percent: 10,
    min_percent: 35,
  };
}

function defaultTopmostMarkerOptions(): TopmostMarkerOptions {
  return {
    marker_color: "#ef4444",
    border_width: 6,
    glow_size: 24,
    opacity: 0.9,
    marker_style: "glow",
  };
}

function normalizeHotkey(hotkey?: HotkeyConfig | null): HotkeyConfig | null {
  const key = hotkey?.key.trim().toUpperCase() ?? "";
  if (!hotkey || !key || (!hotkey.ctrl && !hotkey.alt && !hotkey.shift && !hotkey.win)) {
    return null;
  }

  return { ...hotkey, key };
}

function normalizeTopmostOptions(options: TopmostMarkerOptions): TopmostMarkerOptions {
  const fallback = defaultTopmostMarkerOptions();
  const color = /^#[0-9a-f]{6}$/i.test(options.marker_color) ? options.marker_color.toLowerCase() : fallback.marker_color;
  const markerStyle = (["line", "glow", "pulse"] as TopmostMarkerStyle[]).includes(options.marker_style)
    ? options.marker_style
    : fallback.marker_style;

  return {
    marker_color: color,
    border_width: clampNumber(options.border_width, 1, 12),
    glow_size: clampNumber(options.glow_size, 0, 40),
    opacity: clampNumber(options.opacity, 0.2, 1),
    marker_style: markerStyle,
  };
}

function normalizeWindowOpacitySettings(settings: WindowOpacitySettings): WindowOpacitySettings {
  const fallback = defaultWindowOpacitySettings();
  return {
    decrease_hotkey: normalizeHotkey(settings.decrease_hotkey) ?? fallback.decrease_hotkey,
    increase_hotkey: normalizeHotkey(settings.increase_hotkey) ?? fallback.increase_hotkey,
    reset_hotkey: normalizeHotkey(settings.reset_hotkey) ?? fallback.reset_hotkey,
    step_percent: clampNumber(settings.step_percent, 5, 30),
    min_percent: clampNumber(settings.min_percent, 20, 80),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function topmostStyleLabel(style: TopmostMarkerStyle): string {
  const labels: Record<TopmostMarkerStyle, string> = {
    line: "细线",
    glow: "发光",
    pulse: "呼吸",
  };
  return labels[style];
}

function upsertTopmostWindow(windows: TopmostWindowInfo[], window: TopmostWindowInfo): TopmostWindowInfo[] {
  const existingIndex = windows.findIndex((item) => item.hwnd === window.hwnd);
  if (existingIndex < 0) return [window, ...windows];

  const nextWindows = [...windows];
  nextWindows[existingIndex] = window;
  return nextWindows;
}

function applyMarkerOptionsToTopmostWindows(
  windows: TopmostWindowInfo[],
  options: TopmostMarkerOptions,
): TopmostWindowInfo[] {
  return windows.map((window) => ({ ...window, ...options }));
}

function upsertAppLocal(settings: AppSettings, app: ManagedApp): AppSettings {
  const existingIndex = settings.apps.findIndex((item) => item.id === app.id);
  const nextApps = existingIndex >= 0 ? [...settings.apps] : [...settings.apps, app];

  if (existingIndex >= 0) {
    nextApps[existingIndex] = app;
  }

  nextApps.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  return { ...settings, apps: nextApps };
}

function appInitial(app: ManagedApp): string {
  const source = app.name.trim() || app.executable_path.split(/[\\/]/).pop() || "A";
  return source.slice(0, 1).toUpperCase();
}

function toneForApp(app: ManagedApp): string {
  const tones = ["blue", "green", "orange", "purple", "gray"];
  const source = app.name || app.executable_path || app.id;
  const index = Array.from(source).reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length;
  return tones[index];
}

function extractDroppedPath(dataTransfer: DataTransfer): string | null {
  const file = dataTransfer.files.item(0) as (File & { path?: string }) | null;
  if (file?.path) return file.path;

  const text = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
  return droppedTextToPath(text);
}

function droppedTextToPath(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  if (!firstLine) return null;
  if (!firstLine.startsWith("file://")) return firstLine;

  try {
    const url = new URL(firstLine);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path.replace(/\//g, "\\");
  } catch {
    return null;
  }
}

function candidateFromPath(path: string): DroppedAppCandidate {
  const normalizedPath = path.trim();
  const fileName = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
  const name = fileName.replace(/\.[^.]+$/, "") || "新应用";
  const parent = normalizedPath.includes("\\")
    ? normalizedPath.slice(0, normalizedPath.lastIndexOf("\\"))
    : normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));

  return {
    name,
    executable_path: normalizedPath,
    shortcut_path: normalizedPath.toLowerCase().endsWith(".lnk") ? normalizedPath : null,
    app_user_model_id: null,
    arguments: null,
    working_directory: parent || null,
  };
}

function suggestHotkeyKey(name: string, apps: ManagedApp[]): string {
  const used = new Set(apps.map((app) => formatHotkey(app.hotkey)));
  const candidates = Array.from(name.toUpperCase()).filter((char) => /^[A-Z0-9]$/.test(char));

  for (const key of candidates) {
    if (!used.has(`Alt+${key}`)) {
      return key;
    }
  }

  return "";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default App;
