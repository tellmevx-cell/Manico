import { describe, expect, it } from "vitest";
import { getLaunchableHotkeys } from "./appHotkeys";
import type { ManagedApp } from "./appsApi";

function app(id: string, key: string | null): ManagedApp {
  return {
    id,
    name: id,
    executable_path: `C:\\Tools\\${id}.exe`,
    arguments: null,
    working_directory: null,
    group_id: "default",
    hotkey: key ? { ctrl: false, alt: true, shift: false, win: false, key } : null,
    order: 0,
  };
}

describe("appHotkeys", () => {
  it("returns normalized app hotkeys and skips apps without hotkeys", () => {
    expect(getLaunchableHotkeys([app("rider", "R"), app("terminal", null)])).toEqual([
      { appId: "rider", shortcut: "Alt+R" },
    ]);
  });

  it("deduplicates conflicting shortcuts by keeping the first app", () => {
    expect(getLaunchableHotkeys([app("rider", "R"), app("reader", "R")])).toEqual([
      { appId: "rider", shortcut: "Alt+R" },
    ]);
  });
});
