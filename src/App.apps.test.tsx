import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { emptyAppSettings, type AppSettings } from "./lib/appsApi";

const settings: AppSettings = {
  ...emptyAppSettings,
  apps: [
    {
      id: "my-tool",
      name: "My Real Tool",
      executable_path: "C:\\Tools\\MyRealTool.exe",
      shortcut_path: null,
      app_user_model_id: null,
      arguments: null,
      working_directory: null,
      group_id: "default",
      hotkey: { ctrl: false, alt: true, shift: false, win: false, key: "M" },
      order: 0,
    },
  ],
};

const mocks = vi.hoisted(() => ({
  eventListeners: new Map<string, (event: { payload: unknown }) => void>(),
  getAppSettings: vi.fn(),
  launchManagedApp: vi.fn(),
  listNativeWindows: vi.fn(),
  pickTopmostWindow: vi.fn(),
  clearTopmostWindow: vi.fn(),
  updateTopmostWindowMarker: vi.fn(),
  resolveDroppedApp: vi.fn(),
  saveAppSettings: vi.fn(),
  updateWindowBindings: vi.fn(),
  upsertManagedApp: vi.fn(),
}));

vi.mock("./lib/appsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/appsApi")>();
  return {
    ...actual,
    getAppSettings: mocks.getAppSettings,
    launchManagedApp: mocks.launchManagedApp,
    resolveDroppedApp: mocks.resolveDroppedApp,
    saveAppSettings: mocks.saveAppSettings,
    updateWindowBindings: mocks.updateWindowBindings,
    upsertManagedApp: mocks.upsertManagedApp,
    deleteManagedApp: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventListeners.set(eventName, handler);
    return Promise.resolve(() => mocks.eventListeners.delete(eventName));
  }),
  TauriEvent: {
    DRAG_DROP: "tauri://drag-drop",
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_LEAVE: "tauri://drag-leave",
  },
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(() => Promise.resolve()),
  unregister: vi.fn(() => Promise.resolve()),
}));

vi.mock("./lib/windowsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/windowsApi")>();
  return {
    ...actual,
    listNativeWindows: mocks.listNativeWindows,
    pickTopmostWindow: mocks.pickTopmostWindow,
    clearTopmostWindow: mocks.clearTopmostWindow,
    updateTopmostWindowMarker: mocks.updateTopmostWindowMarker,
  };
});

describe("App application management", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventListeners.clear();
    mocks.getAppSettings.mockResolvedValue(settings);
    mocks.launchManagedApp.mockResolvedValue({ action: "switched", window: null });
    mocks.listNativeWindows.mockResolvedValue([
      {
        hwnd: 101,
        title: "Design Tool",
        process_id: 202,
        process_name: "Design.exe",
        process_path: "C:\\Tools\\Design.exe",
        visible: true,
      },
    ]);
    mocks.pickTopmostWindow.mockResolvedValue({
      hwnd: 303,
      title: "Picked Window",
      process_id: 404,
      process_name: "Picked.exe",
      process_path: "C:\\Tools\\Picked.exe",
      visible: true,
      marker_color: "#ef4444",
      border_width: 6,
      glow_size: 24,
      opacity: 0.9,
      marker_style: "glow",
    });
    mocks.clearTopmostWindow.mockResolvedValue(undefined);
    mocks.updateTopmostWindowMarker.mockImplementation(async (hwnd: number, options) => ({
      hwnd,
      title: "Picked Window",
      process_id: 404,
      process_name: "Picked.exe",
      process_path: "C:\\Tools\\Picked.exe",
      visible: true,
      ...options,
    }));
    mocks.saveAppSettings.mockResolvedValue(settings);
    mocks.updateWindowBindings.mockResolvedValue(settings);
    mocks.resolveDroppedApp.mockResolvedValue({
      name: "Shortcut Tool",
      executable_path: "C:\\Tools\\ShortcutTool.exe",
      shortcut_path: "C:\\Users\\Public\\Desktop\\Shortcut Tool.lnk",
      app_user_model_id: null,
      arguments: "--from-shortcut",
      working_directory: "C:\\Tools",
    });
    mocks.upsertManagedApp.mockResolvedValue(settings);
    Reflect.set(window, "__TAURI_INTERNALS__", {});
  });

  it("loads configured apps without exposing a manual launch action", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("应用启动")[0]);
    expect(await screen.findAllByText("My Real Tool")).not.toHaveLength(0);

    expect(screen.queryByRole("button", { name: "启动/切换" })).toBeNull();
    expect(mocks.launchManagedApp).not.toHaveBeenCalled();
  });

  it("does not expose the old per-app topmost shortcut editor", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("应用启动")[0]);
    expect(await screen.findAllByText("My Real Tool")).not.toHaveLength(0);

    expect(screen.queryByText("置顶快捷键")).toBeNull();
    expect(screen.queryByText("Ctrl+Alt+T")).toBeNull();
    expect(screen.queryByText("热键中心")).toBeNull();
  });

  it("keeps topmost tools out of window bindings and restores scan space", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口绑定")[0]);

    expect(await screen.findByText("当前窗口")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择窗口置顶" })).toBeNull();
    expect(screen.queryByLabelText("标记颜色")).toBeNull();
  });

  it("offers topmost marker controls in the extension tools page", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);

    expect(await screen.findByRole("button", { name: "选择窗口置顶" })).toBeInTheDocument();
    expect(screen.getByLabelText("标记颜色")).toBeInTheDocument();
    expect(screen.getByLabelText("边框粗细")).toBeInTheDocument();
    expect(screen.getByLabelText("发光强度")).toBeInTheDocument();
    expect(screen.getByLabelText("透明度")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发光" })).toBeInTheDocument();
  });

  it("offers a configurable quick topmost hotkey in the extension tools page", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);

    expect(await screen.findByText("快速置顶快捷键")).toBeInTheDocument();
    expect(screen.getByDisplayValue("P")).toBeInTheDocument();
    expect(screen.getByText("当前前台窗口已置顶时取消置顶，未置顶时添加置顶标记。")).toBeInTheDocument();
  });

  it("organizes extension tools into a two-column editor, compact quick bar and pinned list", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);

    expect(await screen.findByLabelText("窗口置顶工作区")).toBeInTheDocument();
    expect(screen.getByLabelText("置顶标记设置")).toBeInTheDocument();
    expect(screen.getByLabelText("置顶效果预览")).toBeInTheDocument();
    expect(screen.getByLabelText("快速置顶工具条")).toHaveTextContent("Ctrl+Alt+P");
    expect(screen.getByLabelText("已置顶窗口列表")).toBeInTheDocument();
  });

  it("renames extension tools to window topmost and offers window dimmer hotkeys", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);

    expect((await screen.findAllByText("窗口置顶")).length).toBeGreaterThan(0);
    expect(screen.queryByText("扩展工具")).toBeNull();
    expect(screen.queryByLabelText("窗口调光工作区")).toBeNull();
  });

  it("moves window dimmer controls into a dedicated workspace", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口调光")[0]);

    expect(await screen.findByLabelText("窗口调光工作区")).toBeInTheDocument();
    expect(screen.getAllByText("调低透明度").length).toBeGreaterThan(0);
    expect(screen.getAllByText("调高透明度").length).toBeGreaterThan(0);
    expect(screen.getAllByText("还原透明度").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0")).toBeInTheDocument();
    expect(screen.getByLabelText("调节步进")).toBeInTheDocument();
    expect(screen.getByLabelText("最低透明度")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择窗口置顶" })).toBeNull();
  });

  it("saves basic system settings from the settings workspace", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("设置")[0]);
    fireEvent.click(await screen.findByLabelText("开机自动启动"));

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(mocks.saveAppSettings).toHaveBeenCalledWith(expect.objectContaining({
        start_with_windows: true,
        minimize_to_tray: true,
      }));
    });
  });

  it("shows picked topmost windows with a marker and can clear them", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "选择窗口置顶" }));

    expect(await screen.findByText("Picked Window")).toBeInTheDocument();
    expect(screen.getAllByLabelText("已置顶").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));

    expect(mocks.pickTopmostWindow).toHaveBeenCalledWith({
      marker_color: "#ef4444",
      border_width: 6,
      glow_size: 24,
      opacity: 0.9,
      marker_style: "glow",
    });
    expect(mocks.clearTopmostWindow).toHaveBeenCalledWith(303);
  });

  it("updates picked topmost marker overlays when marker controls change", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "选择窗口置顶" }));
    expect(await screen.findByText("Picked Window")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("边框粗细"), { target: { value: "10" } });
    await waitFor(() => {
      expect(mocks.updateTopmostWindowMarker).toHaveBeenLastCalledWith(
        303,
        expect.objectContaining({ border_width: 10, glow_size: 24, opacity: 0.9 }),
      );
    });
    expect(await screen.findByText("10px / 发光")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("发光强度"), { target: { value: "32" } });
    await waitFor(() => {
      expect(mocks.updateTopmostWindowMarker).toHaveBeenLastCalledWith(
        303,
        expect.objectContaining({ border_width: 10, glow_size: 32, opacity: 0.9 }),
      );
    });

    fireEvent.change(screen.getByLabelText("透明度"), { target: { value: "70" } });
    await waitFor(() => {
      expect(mocks.updateTopmostWindowMarker).toHaveBeenLastCalledWith(
        303,
        expect.objectContaining({ border_width: 10, glow_size: 32, opacity: 0.7 }),
      );
    });
  });

  it("keeps topmost rows controllable when marker overlay updates fail", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "选择窗口置顶" }));
    expect(await screen.findByText("Picked Window")).toBeInTheDocument();

    mocks.updateTopmostWindowMarker.mockRejectedValueOnce(new Error("overlay busy"));
    fireEvent.change(screen.getByLabelText("边框粗细"), { target: { value: "11" } });

    await waitFor(() => {
      expect(mocks.updateTopmostWindowMarker).toHaveBeenCalledWith(
        303,
        expect.objectContaining({ border_width: 11 }),
      );
    });

    expect(await screen.findByText("Picked Window")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消置顶" })).toBeInTheDocument();
    expect((await screen.findAllByText("置顶标记更新失败，已保留取消入口")).length).toBeGreaterThan(0);
  });

  it("removes a stale topmost row when clearing an already closed window fails", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "选择窗口置顶" }));
    expect(await screen.findByText("Picked Window")).toBeInTheDocument();

    mocks.clearTopmostWindow.mockRejectedValueOnce(new Error("Invalid window handle"));
    fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));

    expect((await screen.findAllByText("已移除失效置顶窗口：Picked Window")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Picked Window")).toBeNull();
  });

  it("removes topmost rows when the native overlay reports the target window closed", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口置顶")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "选择窗口置顶" }));
    expect(await screen.findByText("Picked Window")).toBeInTheDocument();

    mocks.eventListeners.get("manico://topmost-window-removed")?.({ payload: { hwnd: 303, reason: "closed" } });

    expect((await screen.findAllByText("置顶窗口已关闭，已移除记录")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Picked Window")).toBeNull();
  });

  it("removes window bindings optimistically with immediate feedback", async () => {
    const boundWindow = {
      hwnd: 909,
      title: "微信",
      process_id: 808,
      process_name: "Weixin.exe",
      process_path: "C:\\Wechat\\Weixin.exe",
      visible: true,
    };
    mocks.getAppSettings.mockResolvedValueOnce({
      ...settings,
      window_bindings: [boundWindow],
    });
    const pendingSave = new Promise<AppSettings>(() => undefined);
    mocks.updateWindowBindings.mockReturnValueOnce(pendingSave);
    mocks.saveAppSettings.mockReturnValueOnce(pendingSave);

    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口绑定")[0]);
    expect(await screen.findByText("微信")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(screen.queryByText("微信")).toBeNull();
    expect(await screen.findByRole("status", { name: "操作提示" })).toHaveTextContent("正在移除绑定：Weixin.exe");
    await waitFor(() => {
      expect(mocks.updateWindowBindings).toHaveBeenCalledWith([]);
    });
    expect(mocks.saveAppSettings).not.toHaveBeenCalled();
  });

  it("restores a removed window binding when the lightweight save fails", async () => {
    const boundWindow = {
      hwnd: 909,
      title: "微信",
      process_id: 808,
      process_name: "Weixin.exe",
      process_path: "C:\\Wechat\\Weixin.exe",
      visible: true,
    };
    mocks.getAppSettings.mockResolvedValueOnce({
      ...settings,
      window_bindings: [boundWindow],
    });
    mocks.updateWindowBindings.mockRejectedValueOnce(new Error("disk busy"));

    render(<App />);

    fireEvent.click(screen.getAllByTitle("窗口绑定")[0]);
    expect(await screen.findByText("微信")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(await screen.findByText("微信")).toBeInTheDocument();
    expect(await screen.findByRole("alert", { name: "操作提示" })).toHaveTextContent("窗口绑定保存失败：disk busy");
  });

  it("preserves shortcut metadata when saving a dropped app", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("应用启动")[0]);
    const dropZone = await screen.findByText("拖入应用图标");
    fireEvent.drop(dropZone.closest(".drop-zone") as Element, {
      dataTransfer: {
        files: { item: () => null },
        getData: (type: string) => (type === "text/plain" ? "C:\\Users\\Public\\Desktop\\Shortcut Tool.lnk" : ""),
      },
    });

    expect(await screen.findByDisplayValue("Shortcut Tool")).toBeInTheDocument();
    const saveButtons = screen.getAllByRole("button", { name: "保存应用" });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    expect(mocks.upsertManagedApp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shortcut Tool",
        executable_path: "C:\\Tools\\ShortcutTool.exe",
        shortcut_path: "C:\\Users\\Public\\Desktop\\Shortcut Tool.lnk",
        app_user_model_id: null,
        arguments: "--from-shortcut",
        working_directory: "C:\\Tools",
      }),
    );
  });

  it("shows a visible success toast after saving an app", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByTitle("应用启动")[0]);
    const saveButtons = await screen.findAllByRole("button", { name: "保存应用" });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    const toast = await screen.findByRole("status", { name: "操作提示" });
    expect(toast).toHaveTextContent("已保存应用：My Real Tool");
  });

  it("shows a visible failure toast when saving an app fails", async () => {
    mocks.upsertManagedApp.mockRejectedValueOnce(new Error("disk full"));
    render(<App />);

    fireEvent.click(screen.getAllByTitle("应用启动")[0]);
    const saveButtons = await screen.findAllByRole("button", { name: "保存应用" });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    const toast = await screen.findByRole("alert", { name: "操作提示" });
    expect(toast).toHaveTextContent("保存应用失败：disk full");
  });

  it("shows an author contact page in the system workspace", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "关于作者" }));

    expect(await screen.findByLabelText("关于作者工作区")).toBeInTheDocument();
    expect(screen.getAllByText("Monica").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1842063160").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tellmevx@gmail.com").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "复制 QQ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制邮箱" })).toBeInTheDocument();
  });

  it("does not include donation QR codes on the app author page", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "关于作者" }));

    expect(screen.queryByAltText("微信收款码")).not.toBeInTheDocument();
    expect(screen.queryByAltText("支付宝收款码")).not.toBeInTheDocument();
  });

  it("copies author contact values with operation feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "关于作者" }));
    fireEvent.click(screen.getByRole("button", { name: "复制 QQ" }));

    expect(writeText).toHaveBeenCalledWith("1842063160");
    const toast = await screen.findByRole("status", { name: "操作提示" });
    expect(toast).toHaveTextContent("已复制 QQ：1842063160");
  });
});
