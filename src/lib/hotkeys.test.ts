import { describe, expect, it } from "vitest";
import { normalizeHotkey } from "./hotkeys";

describe("normalizeHotkey", () => {
  it("normalizes modifier aliases into Tauri shortcut syntax", () => {
    expect(normalizeHotkey("Ctrl+Q")).toBe("CommandOrControl+Q");
    expect(normalizeHotkey("Win+Esc")).toBe("Super+Escape");
    expect(normalizeHotkey("Alt+2")).toBe("Alt+2");
  });
});
