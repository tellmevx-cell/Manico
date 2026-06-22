import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideNativeWindow,
  listNativeWindows,
  resumeNativeProcess,
  showNativeWindow,
  suspendNativeProcess,
} from "./windowsApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("windowsApi", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("calls the native list_windows command", async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    await expect(listNativeWindows()).resolves.toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith("list_windows");
  });

  it("calls native window and process control commands with ids", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await hideNativeWindow(100);
    await showNativeWindow(100);
    await suspendNativeProcess(42);
    await resumeNativeProcess(42);

    expect(mockedInvoke).toHaveBeenCalledWith("hide_window", { hwnd: 100 });
    expect(mockedInvoke).toHaveBeenCalledWith("show_window", { hwnd: 100 });
    expect(mockedInvoke).toHaveBeenCalledWith("suspend_process", { pid: 42 });
    expect(mockedInvoke).toHaveBeenCalledWith("resume_process", { pid: 42 });
  });
});
