import { describe, expect, it } from "vitest";
import {
  getBoundToggleTargets,
  upsertBinding,
  windowMatchesBinding,
} from "./windowBindings";
import type { NativeWindowInfo } from "./windowsApi";

function windowInfo(
  hwnd: number,
  processName: string,
  processPath: string | null,
  title = `window-${hwnd}`,
): NativeWindowInfo {
  return {
    hwnd,
    title,
    process_id: hwnd,
    process_name: processName,
    process_path: processPath,
    visible: true,
  };
}

describe("windowBindings", () => {
  it("matches windows by process path first and process name as fallback", () => {
    const binding = windowInfo(1, "opera.exe", "C:\\Apps\\Opera\\opera.exe");

    expect(windowMatchesBinding(windowInfo(2, "opera.exe", "C:\\Apps\\Opera\\opera.exe"), binding)).toBe(true);
    expect(windowMatchesBinding(windowInfo(3, "opera.exe", "C:\\Other\\opera.exe"), binding)).toBe(false);
    expect(windowMatchesBinding(windowInfo(4, "opera.exe", null), { ...binding, process_path: null })).toBe(true);
  });

  it("collects all visible process windows and hidden bound windows for Ctrl+Q", () => {
    const binding = windowInfo(1, "Code.exe", "C:\\Tools\\Code.exe");
    const visibleWindows = [
      windowInfo(2, "Code.exe", "C:\\Tools\\Code.exe"),
      windowInfo(3, "Code.exe", "C:\\Tools\\Code.exe"),
      windowInfo(4, "opera.exe", "C:\\Apps\\Opera\\opera.exe"),
    ];
    const hiddenWindows = [
      { ...windowInfo(5, "Code.exe", "C:\\Tools\\Code.exe"), visible: false },
    ];

    const targets = getBoundToggleTargets(visibleWindows, hiddenWindows, [binding]);

    expect(targets.map((item) => item.hwnd)).toEqual([2, 3, 5]);
  });

  it("skips WeChat internal windows from Ctrl+Q targets", () => {
    const binding = windowInfo(1, "Weixin.exe", "C:\\Wechat\\Weixin.exe", "微信");
    const visibleWindows = [
      windowInfo(2, "Weixin.exe", "C:\\Wechat\\Weixin.exe", "邹顺江"),
      windowInfo(3, "Weixin.exe", "C:\\Wechat\\Weixin.exe", "Weixin"),
      windowInfo(4, "Weixin.exe", "C:\\Wechat\\Weixin.exe", "Default IME"),
    ];
    const hiddenWindows = [
      { ...windowInfo(5, "Weixin.exe", "C:\\Wechat\\Weixin.exe", "WxTrayIconMessageWindow"), visible: false },
    ];

    const targets = getBoundToggleTargets(visibleWindows, hiddenWindows, [binding]);

    expect(targets.map((item) => item.hwnd)).toEqual([2]);
  });

  it("skips small auxiliary windows from Ctrl+Q targets", () => {
    const binding = windowInfo(1, "QQ.exe", "C:\\Tencent\\QQ.exe", "QQ");
    const visibleWindows = [
      {
        ...windowInfo(2, "QQ.exe", "C:\\Tencent\\QQ.exe", "QQ"),
        rect: { x: 0, y: 0, width: 140, height: 90 },
      },
      {
        ...windowInfo(3, "QQ.exe", "C:\\Tencent\\QQ.exe", "QQ"),
        rect: { x: 0, y: 0, width: 860, height: 640 },
      },
    ];
    const hiddenWindows = [
      {
        ...windowInfo(4, "QQ.exe", "C:\\Tencent\\QQ.exe", "QQToast"),
        visible: false,
        rect: { x: 0, y: 0, width: 220, height: 120 },
      },
    ];

    const targets = getBoundToggleTargets(visibleWindows, hiddenWindows, [binding]);

    expect(targets.map((item) => item.hwnd)).toEqual([3]);
  });

  it("deduplicates bindings by preferred process identity", () => {
    const first = windowInfo(1, "Code.exe", "C:\\Tools\\Code.exe", "first");
    const updated = windowInfo(2, "Code.exe", "C:\\Tools\\Code.exe", "updated");

    expect(upsertBinding([first], updated)).toEqual([updated]);
  });
});
