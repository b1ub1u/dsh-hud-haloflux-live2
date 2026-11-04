# dsh-hud — HALOFLUX × (DeepSeek Harness + MiniMax Code + WorkBuddy + Claude Code) 实时联动壁纸

把 [HALOFLUX](https://github.com/Ryder191/haloflux)（单文件 Canvas 科幻可视化）接到本机
**DeepSeek Harness、MiniMax Code、WorkBuddy 和 Claude Code 的会话数据**上：
轮盘转速、光束爆发、面板数字都由真实的会话事件驱动；空闲时进入待命慢速状态，干活时爆发。
同时把本机播放器（QQ 音乐等）和 ChatGPT 桌面版的状态也接进同一个画面，最终作为 **Lively Wallpaper** 的桌面壁纸常驻。

> HALOFLUX 采用 PolyForm Noncommercial 许可：**仅限个人非商业使用**。画布右下角保留署名
> `HALOFLUX by Ryder191 · PolyForm Noncommercial · 个人非商业使用`。

---

## 架构

```
~/.dsh/sessions/<workspace>/session-*.jsonl.zstd      （DSH：所有工作区、所有会话）
        │  每 500ms 增量解码（多帧 zstd，逐帧解压）
        ▼
~/.minimax/v2/sessions/<y>/<m>/<d>/*/messages.jsonl   （MiniMax Code：追加写的事件日志）
        │  每 500ms 按字节偏移增量 tail（首次只读尾部 4MB）
        │  ~/.minimax/v2/sqlite/runtime-state.sqlite → 标题 / 工作区 / 状态 / token 用量
        ▼
~/.workbuddy/projects/<enc-cwd>/<sessionId>.jsonl     （WorkBuddy：追加写的事件日志）
        │  每 500ms 按字节偏移增量 tail（首次整文件，>8MB 只读尾部）
        │  ~/.workbuddy/workbuddy.db → 标题 / 工作区 / 状态 / 模型
        ▼
$CLAUDE_CONFIG_DIR|~/.claude/projects/<enc-cwd>/<uuid>.jsonl  （Claude Code：transcript）
        │  每 500ms 按字节偏移增量 tail；标题取 summary 记录 / 首条提问
        ▼
dsh-hud/server.mjs                                 127.0.0.1:7788
        │  四个数据源共用一套状态机 · SSE /stream  ·  JSON /state /stats /media /external /usage
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
| `minimax-source.mjs` | MiniMax Code 数据源：tail `messages.jsonl` + 读 sqlite 元数据，输出与 DSH 同构的事件流 |
| `workbuddy-source.mjs` | WorkBuddy 数据源：tail `~/.workbuddy/projects/**/<session>.jsonl` + 读 `workbuddy.db`，同样输出同构事件流 |
| `claude-source.mjs` | Claude Code 数据源：tail `~/.claude/projects/**/<uuid>.jsonl`（无 sqlite，transcript 即全部真相） |
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

健康检查：`http://127.0.0.1:7788/stats`（含 `workbuddySessions` / `claudeSessions` / `claudeStore`）
分源体检：`http://127.0.0.1:7788/sources`（每个 harness 的会话数 / 活跃数 / 速率 / 工具数 / 错误数）

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

| 事件（四个 harness 通用） | 画面反应 |
|---|---|
| 事件速率（最近 4 秒） | `tempo` / `ringSpeed` / 数据块闪烁 |
| 每次工具调用 | 直接调用 `onBeat()` → 真实光束爆发 |
| 并发工具 / 报错 | `beamBright` / `beamGlow` 提升；`flareRate` 变密 |
| 空闲（4 秒无事件且无工具运行） | 全部参数归零，时间轴降到 10%，轮盘仅缓慢漂移 |
| 工作恢复 | 参数从 0 平滑爬升到满 |

其它：

- **媒体面板**：读取系统媒体会话（优先 QQMusic/Spotify 等，忽略壁纸自身的 WebView2 会话），支持上一首 / 播放暂停 / 下一首
- **外部 AI 面板**：ChatGPT 通过 UI Automation 读取状态、最近对话片段、`Worked for` 用时（豆包 / WorkBuddy 的 UIA 元素为 0——WorkBuddy 已改走自己的会话数据源，面板上直接显示真实的
  会话数 / 事件速率 / 当前标题）
- **界面**：标题 `DSH × MINIMAX × WORKBUDDY` / `大肥鱼 · 实时会话可视化`；中文用 MiSans，英文数字用 JetBrains Mono
- **BGM 已硬静音**：删除 HALOFLUX 自带 `<audio>` 并拦截 `play()`，避免壁纸自动播放

---

## MiniMax Code 数据源

DSH 的会话日志是 `zstd` 压缩的 JSONL；MiniMax Code 是另一套存储，所以单独写了一个数据源
`minimax-source.mjs`，但**输出与 DSH 完全同构的事件**，两边共用同一套状态机和 SSE。

| 读什么 | 从哪读 | 用途 |
|---|---|---|
| 事件流 | `~/.minimax/v2/sessions/<y>/<m>/<d>/*/messages.jsonl` | 工具调用 / 工具结果 / 轮次 / 步数 |
| 会话元数据 | `~/.minimax/v2/sqlite/runtime-state.sqlite` → `local_runtime_sessions` | 标题、工作区、状态（started/idle/aborted） |
| token 用量 | 同上 → `local_runtime_token_usage` | 今日 TOKENS、缓存命中率 |

实现要点：

- **增量 tail**：按字节偏移读取，跨块的半行存在 `tail` 里；文件被截断/轮转时自动重置。
  首次接入只读尾部 4 MB，避免解析十几 MB 的历史。
- **事件归一**：`assistant` 消息里的 `toolCall` → `tool/call`；`toolResult` → `tool/result`；
  `turn_id` 变化 → `turn/start`；`model` 变化 → `request/header`。于是 `server.mjs` 里
  `onEvent()` 一行都不用改。
- **降级**：sqlite 被占用或不存在时，只用 JSONL 照样工作；整个数据源出错也绝不会拖垮 HUD。
- **来源标记**：每个会话带 `source: 'dsh' | 'minimax' | 'workbuddy' | 'claude'`，聚合结果里还有 `bySource` 分源速率。

画面上的体现：

- **颜色**：DSH = 冷白 `#e8eaf0`，MiniMax Code = 紫罗兰 `#ba8cff`，WorkBuddy = 品牌绿 `#0ec7a8`（官方 logo 渐变 `#0EC7A8 → #00C885`），Claude Code = 陶土橘 `#d6a06e`
  （注：MiniMax Code 客户端的**官方 accent 是天蓝 `#0094fc`**——`mcode-default` 主题包的
  `--border_accent: var(--blue_400)`，实机配置 `colors.*.accent` 为 null 即走该默认值。
  当前紫罗兰是暂时选用的占位色，改回官方色只需动 `bridge.js` 里的 `SRC_COLOR` 常量。）
- **事件速率图**：分源堆叠柱（白 → 紫 → 蓝 → 橘 自下而上），右上角带 `■ DSH ■ MM ■ WB ■ CC` 图例
- **会话工作台**：四个 harness 的活跃会话并排，各自带 `DSH` / `MM` / `WB` / `CC` 标签和速率
- **工具调用流**：每条动作前带来源徽标
- **用量 · 费用**：`DSH 今日 … / MM … 命中 …% / WB … / CC … / 合计 … · 余额 …`（今日没有消耗的源不占行）
- **顶部 KPI**：今日 TOKENS 与缓存命中率是**四方合计**

---

## WorkBuddy 数据源

WorkBuddy（CodeBuddy 桌面版）把每个会话追加写到自己的 JSONL 日志里，元数据在 sqlite 里，
所以和 MiniMax Code 一样单写了一个 `workbuddy-source.mjs`，**输出仍然与 DSH 完全同构**，
`server.mjs` 的 `onEvent()` / 聚合 / SSE 一行没改。

| 读什么 | 从哪读 | 用途 |
|---|---|---|
| 事件流 | `~/.workbuddy/projects/<enc-cwd>/<sessionId>.jsonl` | 工具调用 / 工具结果 / 轮次 / 步数 / 标题 |
| 会话元数据 | `~/.workbuddy/workbuddy.db` → `sessions` | 标题、工作区（cwd）、状态、模型 |
| token 用量 | JSONL 里每条 assistant 消息的 `providerData.rawUsage` | 今日 TOKENS、缓存命中率 |

记录 → 事件的映射：

| JSONL `type` | 归一化事件 | 说明 |
|---|---|---|
| `message`（role=user） | `user/message` | 去掉 `<system-reminder>` 注入后取正文，兼作标题兜底 |
| `message`（role=assistant） | `turn/start` + `step/start` + `assistant/message` | `providerData.conversationRequestId` 变化 = 新轮次；`stepSeq` 变化 = 新步 |
| `reasoning` | `step/start` | 思考也算一步，但不会伪造工具调用 |
| `function_call` | `tool/call` | `callId` / `name` / `arguments`（原样透传，`summarizeArgs` 会解析） |
| `function_call_result` | `tool/result` | `status != completed` 或正文以 `Error:` 开头 → 记为失败 |
| `ai-title` | `session/title` | 侧栏标题 |
| `credit-usage` | —（只记账） | 积分消耗，不改画面 |

实现要点：

- **增量 tail**：与 MiniMax 同一套 `offset + tail` 逻辑，半行不丢、截断自动重置。
  首次读整文件（今日日志一共几 MB，一次性把轮次/工具/用量统计补全）；超过 8 MB 只读尾部。
- **只看热会话**：目录扫描只收 12 小时内动过的日志，最多 24 个文件，每 6 秒扫一次；
  元数据每 15 秒读一次；稳定态每 500ms 只做 3 次 `statSync`，实测 ≈0.25% 单核。
- **状态准确**：会话 3 分钟没有新事件就回落 `idle`，不会因为最后一条是 `assistant/message`
  而永远显示「思考中」（这条对三个数据源都生效）。
- **降级**：sqlite 被占用/缺表时只靠 JSONL，标题退回 `ai-title` → 首条用户消息。

画面上的体现：

- **品牌绿 `#0ec7a8`** 是 WorkBuddy 的专属色（取自官方 logo 的渐变起点，`#0EC7A8 → #00C885`），
  工具流 / 工作台 / 圆环卡片 / 外部 AI 面板统一
- **事件速率图**最上层是蓝柱；**会话工作台**里 `WB` 标签
- **外部 AI 面板**里 WorkBuddy 不再依赖 UIA 抓屏，直接显示「N 事件/分」和当前会话标题
- **底部大字提示**（chkK/chkV）在 WorkBuddy 活跃时显示 `WORKBUDDY` + 会话标题

---

## Claude Code 数据源

Claude Code（官方 CLI / 它的各种 fork）把每个会话的 transcript 追加写到
`<claude-root>/projects/<encoded-cwd>/<session-uuid>.jsonl`，其中 `<claude-root>` 是
`$CLAUDE_CONFIG_DIR` 或 `~/.claude`。这里没有 sqlite、没有索引，**transcript 本身就是全部真相**，
所以 `claude-source.mjs` 只 tail 这一种文件，元数据全靠记录推导。

| 读什么 | 从哪读 | 用途 |
|---|---|---|
| 事件流 | `<claude-root>/projects/<enc-cwd>/<uuid>.jsonl` | 轮次 / 步数 / 工具调用与结果 |
| 标题 | `{"type":"summary","summary":…}` 记录，缺失时用首条人类提问 | 工作台 / 现在任务 |
| 工作区 | 每条记录自带的 `cwd` | 面板标签 |
| token 用量 | `assistant.message.usage`（input / cache_read / cache_creation / output） | 今日 TOKENS、缓存命中率 |

记录 → 事件的映射：

| JSONL 记录 | 归一化事件 | 说明 |
|---|---|---|
| `type:"user"` + 纯文本 content | `turn/start` + `user/message` | 一条人类提问 = 一轮；`isMeta` 的注入消息不算 |
| `type:"user"` + `tool_result` 块 | `tool/result` | 按 `tool_use_id` 回填；`is_error` 记为失败 |
| `type:"assistant"` | `step/start` + `request/header` + `assistant/message` | 一条 assistant 记录 = 一次 API step（按 `message.id` 去重） |
| `assistant` 里的 `tool_use` 块 | `tool/call` | `id` / `name` / `input`；同一条消息里的多个 `tool_use` 各算一次 |
| `type:"summary"` | `session/title` | `/resume` 列表里显示的那个标题 |
| `system` / `progress` / `file-history-snapshot` / `queued_command` | — | 画面不画 |

实现要点：

- **没装也能接**：`~/.claude/projects` 不存在时数据源直接报 0 会话，`/stats` 里
  `claudeStore:false`，日志会写 `no store yet - idle until Claude Code runs`；
  哪天你装上 CLI 并跑第一次对话，壁纸下一次 500ms 轮询就会自己亮起来，不用重启服务。
- **多账号/多配置**：认 `CLAUDE_CONFIG_DIR`，和官方 CLI 的行为一致（同一台机器上切账号不会串）。
- **子代理不算独立会话**：`projects/**/agent-*.jsonl` 是 subagent 的 transcript，会被跳过——
  否则一次 Task 调用就会在「会话工作台」里多出好几个幽灵会话。
- **增量 tail**：同样是 `offset + tail`，首次整文件（>8MB 只读尾部），半行留到下一轮，
  文件被截断自动重置；稳定态每 500ms 只有几次 `statSync`。

画面上的体现：陶土橘 `#d6a06e` + `CC` 徽标，出现在工具流、工作台、圆环卡片和速率图最上层。

---

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
`read_image`→看图，`ask_user`→等你确认，`job_*`→后台任务，`task/subagent`→派子任务，
`mcp_browser`→操作浏览器，`mcp_invoke`→调用集成，`tool_search`→查找工具，`skill`→加载技能，
`miniapp`→小程序，`todowrite`→任务清单，`update_goal`→目标状态，`website_deploy`→部署站点。

用量数据来自 `dsh-cost-meter` 账本 + MiniMax `local_runtime_token_usage`（`GET /usage`，5 秒缓存）。

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

- Claude Code 目前在本机还没安装：数据源已就位，`/stats` 显示 `claudeStore:false`，装上跑一次就有数据
- 豆包、WorkBuddy 桌面版关闭了 Chromium 无障碍树，UIA 读取为空；WorkBuddy 因此改走会话 JSONL 数据源
  （UIA 行仍保留，只在数据源没有活跃会话时显示「无活跃会话」）
- `external.ps1` 每 6 秒才刷新一次（按需触发，无轮询时零开销）；ChatGPT 窗口隐藏时仍可读 UIA
- 显示器的 Lively 编号会随插拔变化，换屏后需重新确认映射
- HALOFLUX 仅限非商业使用，署名行不可移除
