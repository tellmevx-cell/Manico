# Manico

Manico 是一款面向 Windows 的效率工具，目标是把快捷应用启动、窗口绑定、窗口置顶、窗口调光等常用窗口操作放到一个统一、现代化的控制台里。

## 功能

- 快捷应用启动：给常用应用绑定全局快捷键；应用未启动时打开，已启动时切换到前台。
- 窗口绑定：选择当前系统窗口并绑定，使用 `Ctrl+Q` 统一显示或隐藏。
- 窗口置顶：对当前窗口进行置顶，并支持边框颜色、粗细、发光强度和透明度配置。
- 窗口调光：通过快捷键调低、调高或还原当前窗口透明度。
- 托盘运行：关闭主窗口时可缩小到系统托盘。

## 开发

```powershell
npm install
npm run tauri -- dev
```

## 构建

```powershell
npm run build
npm run tauri -- build
```

构建产物默认位于：

- `src-tauri/target/release/manico.exe`
- `src-tauri/target/release/bundle/nsis/Manico_0.1.0_x64-setup.exe`

## 请作者喝咖啡

如果 Manico 对你有帮助，可以请作者喝杯咖啡。

也可以通过下面的收款码支持作者：

<table>
  <tr>
    <td align="center" valign="top"><strong>微信</strong></td>
    <td align="center" valign="top"><strong>支付宝</strong></td>
  </tr>
  <tr>
    <td align="center" valign="top"><img src="donate/vx.jpg" alt="微信收款码" width="220" /></td>
    <td align="center" valign="top"><img src="donate/zfb.jpg" alt="支付宝收款码" width="220" /></td>
  </tr>
</table>

## 作者

- 作者：Monica
- QQ：1842063160
- 邮箱：tellmevx@gmail.com
