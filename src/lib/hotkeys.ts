const keyAliases: Record<string, string> = {
  ctrl: "CommandOrControl",
  control: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  win: "Super",
  windows: "Super",
  esc: "Escape",
};

export function normalizeHotkey(input: string): string {
  return input
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      const alias = keyAliases[trimmed.toLowerCase()];
      if (alias) return alias;
      if (trimmed.length === 1) return trimmed.toUpperCase();
      return trimmed;
    })
    .join("+");
}
