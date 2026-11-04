# 安装与依赖清单

目标环境：**Windows 10 / 11 x64**。整套东西都在本机运行，只监听 `127.0.0.1`，不联网上传。

## 一、必需依赖

| 依赖 | 用途 | 安装方式 | 是否随项目附带 |
|---|---|---|---|
| **Windows 10/11 x64** | 运行平台 | — | — |
| **Node.js ≥ 20** | 数据服务 / 静态托管 / SSE | 安装脚本自动检测，缺了可 `winget install OpenJS.NodeJS.LTS` | ❌ 需自装 |
| **PowerShell 5.1** | 媒体控制、外部 AI 读取 | 系统自带 | ✅ 系统组件 |
| **Lively Wallpaper** | 把页面变成桌面壁纸 | **安装脚本自动装**（`winget install --id rocksdanister.LivelyWallpaper`） | ❌ 需自装 |
| **Edge WebView2 Runtime** | Lively 渲染网页壁纸 | 随 Lively / Windows 自动安装 | ❌ 一般已存在 |
| **HALOFLUX** | 视觉本体 | — | ✅ 已包含 `haloflux/` |

> 服务端**零 npm 依赖**，不需要 `npm install`，只用 Node 内置模块。

## 二、可选依赖（没有也能跑，只是少对应面板）

| 依赖 | 影响的模块 | 缺失时表现 |
|---|---|---|
| **DeepSeek Harness 桌面版** | 主数据源（会话事件、进度、工具流） | 面板无数据，画面保持待命 |
| **dsh-cost-meter 插件** | 「用量 · 费用」面板、顶部花费/余额 | 显示"暂无用量数据" |
| **ChatGPT / WorkBuddy / MiniMax Code / 豆包** | 「外部 AI」面板与环带卡片 | 该项显示"未运行"（灰暗） |
| **QQ 音乐 / Spotify / 豆包 / B 站 等** | 左上播放器 | 显示"未检测到播放器" |
| **MiSans / HarmonyOS Sans 字体** | 中文排版 | 回退到微软雅黑 |
| **Wallpaper Engine**（付费，可选） | 替代 Lively 作为壁纸宿主 | 用 Lively 即可 |

## 三、安装（一条命令）

```powershell
# 解压后进入项目根目录，运行：
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\install.ps1
```

安装脚本会自动完成：

1. **环境检查** — Node.js 20+、HALOFLUX 文件完整性、DSH 数据目录
2. **装壁纸宿主** — 缺 Lively 就用 winget 自动安装
3. **注入壁纸工程** — 复制到 Lively 库 `dshhaloflux.001`
4. **设置壁纸** — 调用 `Lively.exe setwp` 挂到主屏
5. **写开机自启** — 当前用户 Startup 目录 `dsh-hud-start.vbs`
6. **启动数据服务** — 后台守护进程，端口 7788
7. **对齐屏幕** — 自动选屏 + 任务栏安全边距

完成后打开 <http://127.0.0.1:7788/> 即可预览。

### 可选参数

| 参数 | 作用 |
|---|---|
| `-Port 7788` | 指定数据服务端口 |
| `-SkipLively` | 只装数据服务，跳过 Lively 安装与壁纸设置 |
| `-Uninstall` | 卸载（停服务 + 撤壁纸 + 删自启） |

## 四、卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\install.ps1 -Uninstall
```

会清理服务、壁纸、自启；**保留**项目文件与 Lively 安装本身。

## 五、自动选屏（无需手动 setwp）

`start.ps1` 启动服务后会调用 `fix-wallpaper-screen.ps1`：

- 从 `WallpaperLayout.json` 读取每块屏在 Lively 里的真实编号（`LivelyScreen.Index`）
- 目标屏 **spacedesk 虚拟屏（iPad）优先，否则主屏**
- 只在目标屏设置壁纸，其它屏自动清掉

换电脑、插拔显示器、改显示设置后都无需手动干预；想强制指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\fix-wallpaper-screen.ps1 -Prefer primary
```

日志：`dsh-hud\wallpaper-screen.log`

## 六、多显示器 / 换屏幕

Lively 的屏幕编号与 Windows 的 `DISPLAYn` 不同，且插拔后会变：

```powershell
$exe = "C:\Program Files\Lively Wallpaper\Lively.exe"
$lib = "$env:LOCALAPPDATA\Lively Wallpaper\Library\wallpapers\dshhaloflux.001"

& $exe setwp --file $lib --monitor 3   # 示例：第 3 块屏
& $exe closewp --monitor 1             # 撤掉第 1 块屏的壁纸
& $exe setwp --file reload             # 改过页面后重载
```

确认映射：改一次后看 `%LOCALAPPDATA%\Lively Wallpaper\WallpaperLayout.json` 里的 `DeviceName`。

## 七、重启后自检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\verify-after-reboot.ps1
```

7 项检查：自启脚本 / 7788 监听 / `/stats` / `/wall` / Lively 进程 / 壁纸目标 / node 进程。
全部 `[ OK ]` 即恢复成功。

## 八、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 壁纸黑屏/中途出现"等待 dsh-hud 服务" | 服务没起来 | 运行 `dsh-hud\start.ps1` 看报错；端口被占会直接退出 |
| 退出 DSH 后壁纸消失 | 服务被当作 DSH 子进程启动 | 用开机自启或 `install.ps1` 启动，不要从 DSH 会话里手动起 |
| 壁纸跑到别的显示器 | Lively 屏幕编号变了 | 按上面「多显示器」重新 `setwp` |
| 底部面板被任务栏遮住 | 安全边距未生效 | 重载壁纸；或检查 `bridge.js` 的 `--taskbar-safe` 测量 |
| 画面卡顿 | 后台资源紧张 | 改 `bridge.js`：`LOAD` 0.50→0.35、帧预算 20→33、`quality` 上限 0.7→0.5 |
| 中文显示成方块 | 字体缺失 | 装 MiSans 或修改 `bridge.js` 里的字体栈 |
| 显存占用异常 | Lively 库其他壁纸的预览 | 重启 Lively 释放；壁纸本身是 2D canvas 不吃 GPU |
| 没有声音 | 正常：壁纸自带 BGM 已被硬静音 | 播放器面板控制的是你系统里的音乐软件 |

## 九、目录与文件

见 [README.md](README.md#目录)。服务端只读以下本机数据：

- `~/.dsh/sessions/**`（会话日志）
- `~/.dsh/storages/cost-meter/ledger.json`（用量账本）
- 系统媒体会话（Windows SMTC）
- 外部 AI 窗口的 UI Automation 树

**所有数据仅在本机处理，不上传。**
