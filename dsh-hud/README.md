# dsh-hud — HALOFLUX × DeepSeek Harness 实时联动壁纸

把 [HALOFLUX](https://github.com/Ryder191/haloflux)（单文件 Canvas 科幻可视化）接到本机 **DeepSeek Harness 会话数据**上：
轮盘转速、光束爆发、面板数字都由真实的会话事件驱动；空闲时进入待命慢速状态，干活时爆发。
同时把本机播放器（QQ 音乐等）和 ChatGPT 桌面版的状态也接进同一个画面，最终作为 **Lively Wallpaper** 的桌面壁纸常驻。

> HALOFLUX 采用 PolyForm Noncommercial 许可：**仅限个人非商业使用**。画布右下角保留署名
> `HALOFLUX by Ryder191 · PolyForm Noncommercial · 个人非商业使用`。

---

## 架构

```
~/.dsh/sessions/<workspace>/session-*.jsonl.zstd      （所有工作区、所有会话）
        │  每 500ms 增量解码（多帧 zstd，逐帧解压）
        ▼
dsh-hud/server.mjs                                 127.0.0.1:7788
        │  SSE /stream  ·  JSON /state /stats /media /external
        ▼
haloflux/lab.html + 运行时注入 bridge.js           （原文件不改，服务时注入）
        │  setParam() / onBeat() 驱动 HALOFLUX 内部参数
        ▼
Lively Wallpaper（WebView2）→ 桌面壁纸 / 侧栏预览
```

---

## 目录

| 文件 | 作用 |
|---|---|
| `server.mjs` | 数据服务：扫描所有工作区会话、增量解码、聚合、SSE 推送、媒体/外部 AI 代理 |
| `bridge.js` | 注入 HALOFLUX 的桥：参数联动、面板替换、中文化、字体、硬静音 BGM、外部 AI 面板 |
| `media.ps1` | 读取/控制系统媒体会话（QQ音乐 / Spotify / 网易云…），优先真实播放器 |
| `external.ps1` | 读取 ChatGPT 桌面版状态与最近对话（UI Automation）；OCR 辅助已保留但 WorkBuddy 暂不启用 |
| `ocr.ps1` / `capture-window.ps1` | Windows OCR + 窗口抓图（备用通道） |
| `start.ps1` | 启动服务（前台） |
| `start-hidden.vbs` | 无窗口启动（供自启使用） |
| `verify-after-reboot.ps1` | 重启后一键自检 |
| `wall-proj/` | Lively 壁纸工程（`LivelyInfo.json` + `index.html` 包装页，带服务断线重试） |
| `screenshot.mjs` / `shot-idle.mjs` | 通过 CDP 给页面截图（开发用） |

已安装到 Lively 的壁纸目录：`%LOCALAPPDATA%\Lively Wallpaper\Library\wallpapers\dshhaloflux.001`
（修改 `wall-proj/` 后需重新复制到该目录并 `setwp --file reload`。）

---

## 快速开始

```powershell
# 启动服务（会阻塞，Ctrl+C 停止）
pwsh -File dsh-hud/start.ps1

# 或后台无窗口启动
wscript.exe dsh-hud/start-hidden.vbs

# 浏览器预览（非壁纸模式）
http://127.0.0.1:7788/          # 完整控制台
http://127.0.0.1:7788/wall      # 壁纸模式（同样的完整画面）
```

健康检查：`http://127.0.0.1:7788/stats`

---

## 开机自启

`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-hud-start.vbs`
→ 无窗口运行 `dsh-hud\start.ps1` → `node server.mjs`。

- 服务与 DSH 进程树**解耦**：退出 DSH 不会带走服务
- 服务端有 `EADDRINUSE` 保护：重复启动不会崩
- Lively 自身 `Settings.json → Startup: true`，登录时一起自启

> 注意：如果在 DSH 会话里手动启动服务，它会是 DSH 的子进程，**退出 DSH 时会被一起杀掉**。
> 正常路径依赖登录自启即可。

---

## Lively 壁纸

安装：`winget install --id rocksdanister.LivelyWallpaper`

设置壁纸（Lively 的 monitor 编号与 Windows 的 `DISPLAYn` 不同）：

```powershell
$exe = "C:\Program Files\Lively Wallpaper\Lively.exe"
$lib = "$env:LOCALAPPDATA\Lively Wallpaper\Library\wallpapers\dshhaloflux.001"

& $exe setwp --file $lib --monitor 3    # 本机：iPad（spacedesk / DISPLAY18）
& $exe setwp --file $lib --monitor 2    # 本机：主屏（DISPLAY1，物理显示器）
& $exe closewp --monitor 1              # 撤掉某块屏上的壁纸
& $exe setwp --file reload              # 重新加载（改了页面后）
```

本机映射（可能随插拔变化，需重新确认）：

| Lively index | Windows 设备 | 说明 |
|---|---|---|
| 1 | `\\.\DISPLAY2`（NVIDIA 1067×1707） | 扩展/虚拟屏 |
| 2 | `\\.\DISPLAY1`（NVIDIA 2560×1440，primary） | 物理显示器 |
| 3 | `\\.\DISPLAY18`（spacedesk 2266×1488） | iPad |

---

## 联动规则

| DSH 事件 | 画面反应 |
|---|---|
| 事件速率（最近 4 秒） | `tempo` / `ringSpeed` / 数据块闪烁 |
| 每次工具调用 | 直接调用 `onBeat()` → 真实光束爆发 |
| 并发工具 / 报错 | `beamBright` / `beamGlow` 提升；`flareRate` 变密 |
| 空闲（4 秒无事件且无工具运行） | 全部参数归零，时间轴降到 10%，轮盘仅缓慢漂移 |
| 工作恢复 | 参数从 0 平滑爬升到满 |

其它：

- **媒体面板**：读取系统媒体会话（优先 QQMusic/Spotify 等，忽略壁纸自身的 WebView2 会话），支持上一首 / 播放暂停 / 下一首
- **外部 AI 面板**：ChatGPT 通过 UI Automation 读取状态、最近对话片段、`Worked for` 用时（豆包 / WorkBuddy 的 UIA 元素为 0，暂不接入）
- **界面**：标题 `DEEPSEEK HARNESS` / `大肥鱼 · 实时会话可视化`；中文用 MiSans，英文数字用 JetBrains Mono
- **BGM 已硬静音**：删除 HALOFLUX 自带 `<audio>` 并拦截 `play()`，避免壁纸自动播放


## 界面信息结构

**顶部 KPI**：今日 TOKENS · 今日花费 · 余额 · 缓存命中 · 峰谷剩余
**右上浮块**：本地播放器（正在播放 + 上一首/播放暂停/下一首）

**底部两行**（12 栏网格，宽度按内容分配）

| 第一排 | 栏数 | 第二排 | 栏数 |
|---|---|---|---|
| 现在任务 | 4 | 用量 · 费用 | 4 |
| 进度 | 2 | 工具调用 | 4 |
| 会话工作台 | 2 | 事件速率 | 2 |
| 今日之最 | 2 | 工具分布 | 2 |
| ChatGPT | 2 | — | — |

工具名 → 人话映射：`pwsh/node/python/git…`→运行命令，`read`→读取文件，`write`→新建文件，
`edit/apply_patch`→修改文件，`grep/glob/find`→查找内容，`web_search/web_fetch`→联网查询，
`read_image`→看图，`ask_user_question`→等你确认，`job_*`→后台任务，`subagent`→派子任务。

用量数据来自 `dsh-cost-meter` 账本（`GET /usage`，5 秒缓存）。

---

## 性能实测（本机 3840×2160 / i9-14900KF / RTX 4060）

| 场景 | CPU | 内存 |
|---|---|---|
| HUD 数据服务 | ≈0.3% 单核 | 60–110 MB |
| 壁纸 · 待命 | ≈4% 单核 | ≈1.0–1.2 GB |
| 壁纸 · 工作中 | ≈30–41% 单核 | ≈1.2–1.3 GB |

> Lively + WebView2 基线本身约 1 GB（换任何壁纸都差不多），页面增量约 200–300 MB。
> 壁纸模式已降载：DPR 0.65、动态帧率 30fps（工作）/ 8fps（待命）/ 2fps（隐藏）、重负载参数 ×0.45、自适应画质。

调参位置（`bridge.js`）：`devicePixelRatio` 的 `0.65`、帧预算 `AC >= 0.12 ? 33 : 125`、`LOAD` 的 `0.45`。

---

## 重启验证记录

**验证时间**：2026-10-29 18:44（系统启动于 17:48，重启后约 56 分钟）
**验证命令**：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File dsh-hud\verify-after-reboot.ps1`

```
[ OK ] startup launcher             %APPDATA%\...\Startup\dsh-hud-start.vbs
[ OK ] port 7788 listening          yes
[ OK ] /stats responds              rss=73MB clients=1 uptime=55.3min
[ OK ] /wall renders                122656 bytes
[ OK ] Lively running               pid=33336
[ OK ] wallpaper = HALOFLUX         %LOCALAPPDATA%\Lively Wallpaper\WallpaperLayout.json
[ OK ] server node process          pid=35392

RESULT: all checks passed — wallpaper stack survived reboot.
```

结论：**真实重启后，登录自启链路正常**——`shell:startup` 拉起服务，Lively 自动恢复壁纸，
壁纸页成功连上 SSE（`clients=1`），全程不需要手动操作。

当前壁纸落点：`\\.\DISPLAY18`（iPad / spacedesk）。

---

## 已知限制

- 豆包、WorkBuddy 桌面版关闭了 Chromium 无障碍树，UIA 读取为空；WorkBuddy 已从面板移除
- `external.ps1` 每 6 秒才刷新一次（按需触发，无轮询时零开销）；ChatGPT 窗口隐藏时仍可读 UIA
- 显示器的 Lively 编号会随插拔变化，换屏后需重新确认映射
- HALOFLUX 仅限非商业使用，署名行不可移除
