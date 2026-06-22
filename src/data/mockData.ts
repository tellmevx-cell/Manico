export type NavPage = "overview" | "apps" | "bindings" | "extensions" | "dimmer" | "rules" | "recovery" | "settings" | "about";

export const navItems: Array<{ key: NavPage; rail: string; label: string; count?: number }> = [
  { key: "overview", rail: "总", label: "总览", count: 4 },
  { key: "apps", rail: "启", label: "应用启动", count: 12 },
  { key: "bindings", rail: "绑", label: "窗口绑定" },
  { key: "extensions", rail: "顶", label: "窗口置顶" },
  { key: "dimmer", rail: "光", label: "窗口调光" },
];

export const apps = [
  {
    name: "JetBrains Rider",
    path: "C:\\monica\\softposition\\JetBrains Rider 2025.3.1\\bin\\rider64.exe",
    hotkey: "Alt+R",
    status: "运行中",
    tone: "blue",
    icon: "R",
  },
  {
    name: "MobaXterm_CHS1",
    path: "C:\\monica\\softposition\\MobaXterm_20.0汉化\\MobaXterm.exe",
    hotkey: "Alt+2",
    status: "未运行",
    tone: "gray",
    icon: "M",
  },
  {
    name: "Visual Studio Code",
    path: "C:\\Users\\...\\Code.exe",
    hotkey: "Alt+C",
    status: "运行中",
    tone: "purple",
    icon: "V",
  },
  {
    name: "Opera",
    path: "C:\\monica\\softposition\\Opera\\opera.exe",
    hotkey: "Alt+O",
    status: "已绑定",
    tone: "orange",
    icon: "O",
  },
];

export const windows = [
  { title: "Code.exe / Visual Studio Code", hwnd: "269500", pid: "45496", process: "Code.exe", tone: "purple", icon: "C", status: "可绑定" },
  { title: "文件资源管理器", hwnd: "23860778", pid: "10836", process: "explorer.exe", tone: "gray", icon: "E", status: "忽略" },
  { title: "内网云 - Opera", hwnd: "8458238", pid: "46068", process: "opera.exe", tone: "orange", icon: "O", status: "可绑定" },
  { title: "WindowsTerminal.exe", hwnd: "39393206", pid: "40876", process: "WindowsTerminal.exe", tone: "gray", icon: "T", status: "可绑定" },
];

export const boundWindows = [
  { title: "内网云 - 千帆异云 - Opera", meta: "opera.exe · PID 46068 · hwnd 8458238", mode: "路径匹配", tone: "orange", icon: "O" },
  { title: "04-agent-loop - Visual Studio Code", meta: "Code.exe · PID 45496 · hwnd 269500", mode: "精确窗口", tone: "purple", icon: "C" },
  { title: "PowerShell", meta: "WindowsTerminal.exe · PID 40876", mode: "待确认", tone: "gray", icon: "T" },
];

export const rules = [
  { title: "隐藏窗口后静音", desc: "自动静音目标进程音频会话。", enabled: true },
  { title: "隐藏前发送暂停键", desc: "用于暂停视频或关闭输入框。", enabled: false },
  { title: "隐藏后隐藏托盘图标", desc: "进一步降低可见性。", enabled: false },
  { title: "文件路径匹配", desc: "隐藏同一路径启动的所有窗口。", enabled: true },
  { title: "隐藏时冻结进程", desc: "恢复窗口时自动解冻。", enabled: false },
  { title: "增强冻结", desc: "需要 pssuspend64 与管理员权限。", enabled: false },
];

export const recoveryRows = [
  { title: "内网云 - 千帆异云 - Opera", state: "已隐藏", hwnd: "8458238", pid: "46068", tone: "orange", icon: "O" },
  { title: "04-agent-loop - Visual Studio Code", state: "可见", hwnd: "269500", pid: "45496", tone: "purple", icon: "C" },
  { title: "MobaXterm_CHS1", state: "已冻结", hwnd: "6233790", pid: "40876", tone: "gray", icon: "M" },
  { title: "无标题窗口", state: "未知", hwnd: "131394", pid: "6808", tone: "gray", icon: "S" },
];
