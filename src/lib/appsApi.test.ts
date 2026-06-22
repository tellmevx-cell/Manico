import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteManagedApp,
  emptyAppSettings,
  getAppSettings,
  launchManagedApp,
  saveAppSettings,
  upsertManagedApp,
  type AppSettings,
  type ManagedApp,
} from "./appsApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

const app: ManagedApp = {
  id: "rider",
  name: "Rider",
  executable_path: "C:\\Tools\\Rider\\bin\\rider64.exe",
  arguments: null,
  working_directory: null,
  group_id: "default",
  hotkey: { ctrl: false, alt: true, shift: false, win: false, key: "R" },
  order: 0,
};

const settings: AppSettings = {
  ...emptyAppSettings,
  apps: [app],
};

describe("appsApi", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("calls native app settings commands", async () => {
    mockedInvoke.mockResolvedValue(settings);

    await getAppSettings();
    await saveAppSettings(settings);
    await upsertManagedApp(app);
    await deleteManagedApp("rider");

    expect(mockedInvoke).toHaveBeenCalledWith("get_app_settings");
    expect(mockedInvoke).toHaveBeenCalledWith("save_app_settings", { settings });
    expect(mockedInvoke).toHaveBeenCalledWith("upsert_managed_app", { app });
    expect(mockedInvoke).toHaveBeenCalledWith("delete_managed_app", { id: "rider" });
  });

  it("launches or switches a managed app by id", async () => {
    mockedInvoke.mockResolvedValue({ action: "launched", window: null });

    await expect(launchManagedApp("rider")).resolves.toEqual({ action: "launched", window: null });
    expect(mockedInvoke).toHaveBeenCalledWith("launch_managed_app", { id: "rider" });
  });
});
