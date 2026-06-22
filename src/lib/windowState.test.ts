import { describe, expect, it } from "vitest";
import {
  addUniquePid,
  mergeRecoverableWindows,
  removePid,
  removeWindowByHwnd,
  upsertWindow,
} from "./windowState";
import type { NativeWindowInfo } from "./windowsApi";

const opera: NativeWindowInfo = {
  hwnd: 101,
  title: "Opera",
  process_id: 20,
  process_name: "opera.exe",
  process_path: "C:\\Opera\\opera.exe",
  visible: true,
};

const terminal: NativeWindowInfo = {
  hwnd: 202,
  title: "PowerShell",
  process_id: 30,
  process_name: "WindowsTerminal.exe",
  process_path: null,
  visible: true,
};

describe("windowState", () => {
  it("merges visible and hidden windows with frozen process markers", () => {
    const rows = mergeRecoverableWindows([opera], [terminal], [30]);

    expect(rows).toEqual([
      expect.objectContaining({ hwnd: 101, hidden: false, frozen: false }),
      expect.objectContaining({ hwnd: 202, hidden: true, frozen: true }),
    ]);
  });

  it("upserts windows and removes by hwnd", () => {
    const renamedOpera = { ...opera, title: "Opera - Work" };
    const next = upsertWindow([opera], renamedOpera);

    expect(next).toHaveLength(1);
    expect(next[0].title).toBe("Opera - Work");
    expect(removeWindowByHwnd(next, 101)).toEqual([]);
  });

  it("keeps frozen pids unique and removable", () => {
    expect(addUniquePid([30], 30)).toEqual([30]);
    expect(addUniquePid([30], 42)).toEqual([30, 42]);
    expect(removePid([30, 42], 30)).toEqual([42]);
  });
});
