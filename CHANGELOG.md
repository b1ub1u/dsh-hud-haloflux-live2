# 更新日志 / Changelog

## [Unreleased] — 2026-11-05 晚

### Claude Code 接入（第四个数据源）
- **新增 `dsh-hud/claude-source.mjs`**：tail `<CLAUDE_CONFIG_DIR|~/.claude>/projects/**/<uuid>.jsonl`，
  无 sqlite（transcript 即全部真相），把 `message` / `tool_use` / `tool_result` / `summary`
  归一成与其余三个数据源相同的事件词汇
  - `type:"user"` 纯文本 → `turn/start` + `user/message`（`isMeta` 注入消息跳过）
  - `type:"user"` + `tool_result` → `tool/result`（按 `tool_use_id` 回填，`is_error` 记为失败）
  - `type:"assistant"` → `step/start`（按 `message.id` 去重）+ `request/header` + `assistant/message`
  - `tool_use` 块 → `tool/call`；`type:"summary"` → `session/title`
  - `assistant.message.usage` → 今日 tokens / 缓存命中
- **子代理不单列**：`agent-*.jsonl` 是 subagent transcript，直接跳过，避免一次 Task 调用冒出多个幽灵会话
- **没装也能接**：`~/.claude/projects` 不存在时报 0 会话，`/stats` 给 `claudeStore:false`，
  装上 CLI 跑一次即自动亮起，**不需要重启服务**
- **`server.mjs`**：新增 `pollClaude()`、`/stats` 增加 `claudeSessions` / `claudeRoot` / `claudeStore`、
  `/usage` 增加 `claude`、启动日志打印 Claude 根目录与是否找到存储
- **`bridge.js`**：陶土橘 `#d6a06e` + `CC` 徽标；速率图第四层、图例 `■ CC`；
  用量面板按「今日有消耗才占行」渲染，四个源全开也只有 7 行不撑破面板；
  标题改成双行 lockup（`DSH × MINIMAX` / `WORKBUDDY × CLAUDE CODE`），四个名字单行放不下
- **验证**：用仿真 transcript（含 thinking / tool_use / tool_result / 失败结果 / summary / turn_duration，
  两条会话）跑第二实例（`:7789` + `CLAUDE_CONFIG_DIR` 指向仿真目录）端到端验证，
  增量追加记录、turn/step/tool 计数、usage 与 UI 配色均正确

### 顺手修掉的布局地雷
- **任务栏高度误判**：`--taskbar-safe` 原来取 `innerHeight - screen.availHeight`，当窗口比屏幕高
  （多屏纵向拼接、DevTools 模拟、远程桌面）时会算出几百像素的“任务栏”，把整个面板行顶到屏幕上半部、
  画布被压成一条。现在差值 >200px 视为无意义，回落到标准 49px。真机上任务栏高度正常的场景行为不变。

## [Unreleased] — 2026-11-05

### WorkBuddy 接入（第三个数据源）
- **新增 `dsh-hud/workbuddy-source.mjs`**：tail `~/.workbuddy/projects/**/<sessionId>.jsonl`，
  读 `~/.workbuddy/workbuddy.db` 的 `sessions` 表拿标题/工作区/状态/模型，
  把 `message` / `reasoning` / `function_call` / `function_call_result` / `ai-title` 归一成
  与 DSH、MiniMax Code 完全相同的事件词汇（`turn/start`、`step/start`、`tool/call`、
  `tool/result`、`assistant/message`、`session/title`、`request/header`）
- **`server.mjs`**：新增 `pollWorkBuddy()`（异步、失败不影响主循环），`/stats` 增加
  `workbuddySessions`，`/usage` 增加 `workbuddy`（今日 tokens / 缓存命中 / 积分）；
  会话工作区标签优先用数据源给的（时间戳目录格式化成 `MM-DD HH:mm`）
- **状态准确性**：`summarize()` 增加 3 分钟静默回落 `idle`，避免「已完成的一轮」永远显示思考中
- **`bridge.js`**：
  - 品牌绿 `#0ec7a8` 作为 WorkBuddy 身份色（工具流徽标、工作台、圆环卡片、会话装饰）
    ——取自 WorkBuddy 官方 logo 的渐变起点 `#0EC7A8 → #00C885`（`app.asar` 里的 `logo-workbuddy-*.svg`）
  - 事件速率图改为三层堆叠（DSH 白 → MM 紫 → WB 蓝），图例补 `WB`
  - 用量面板新增 `WB 今日 … tok · 命中 …%`，顶部 KPI 的 TOKENS / 缓存命中改为三方合计
  - 「现在任务 / 进度 / 底部大字」的来源标签不再写死 `MM` / `DSH`，改用 `srcLabel()`
  - 「外部 AI」面板里 WorkBuddy 改为显示真实会话数据（N 事件/分 + 当前标题），不再只靠 UIA
  - 工具名中文化补齐 WorkBuddy 的 PascalCase 工具（`PowerShell`、`ToolSearch`、`Task*`、
    `present_files`、`AskUserQuestion`、`automation_update`…）

### 性能
- WorkBuddy 数据源只扫 12 小时内的热会话（最多 24 个文件，6s 一次），元数据 15s 一次，
  稳定态每 500ms 仅 3 次 `statSync`；实测增量开销 ≈0.25% 单核

## [Unreleased] — 2026-11-04

### 一键安装
- **重写 `install.ps1`**：从"只检查+自启+启动"升级为全自动部署
  - 自动检测并安装 Node.js / Lively Wallpaper（经 winget）
  - 自动注入壁纸工程到 Lively 库并调用 `setwp` 设置为桌面壁纸
  - 自动写入开机自启、启动数据服务、对齐屏幕与安全边距
  - 支持 `-Port` / `-SkipLively` / `-Uninstall` 参数
- **新增 `uninstall.ps1`**：一键停服务、撤壁纸、删自启（保留项目与 Lively）

### 外部 AI 接入
- **`external.ps1` 扩展为通用 UI Automation 探测**：新增 `Get-UiaAppInfo`，支持
  ChatGPT、WorkBuddy、MiniMax Code、豆包四家的运行状态与界面文本读取
- **`bridge.js` 新增外部 AI 面板**：底部「外部 AI」列显示全部应用状态
- **按身份染色**（`AGENT_COLOR`）：
  - DSH / DEEPSEEK → 冷白
  - ChatGPT → 薄荷绿
  - WorkBuddy → 天蓝
  - MiniMax Code → 紫罗兰
  - 豆包 → 桃粉
  - 未知应用用稳定哈希取色，同名同色
- **运行/未运行明暗区分**：运行中亮身份色，未运行统一灰暗——谁在工作一目了然
- **环带卡片也按 AI 染色**：每个运行中的外部 AI 在圆环上占一张身份色数据卡

### 显示质量修复
- **消除摩尔纹/模糊**：`devicePixelRatio` 由硬编码 0.95 改为读取原生值（150% 缩放时 1.5），
  canvas 与物理像素 1:1 对齐
- **环内标题清晰化**：
  - 坐标改为整数像素对齐（消除小数位移导致的模糊）
  - 背景不透明度 85% → 97%，加阴影与 `backdrop-filter`，光束不再透过字
  - 标题字号 12px → 27px，标签 8px → 15px
  - 停用每 3.6 秒覆盖真实标题的假数据轮播定时器

### 布局修复
- **底部面板避开任务栏**：新增 `--taskbar-safe` 动态测量，底部留白 = 任务栏高度 + 1px，
  每 3 秒自适应（跟随任务栏自动隐藏、分辨率变化）
- **播放器面板**：壁纸模式默认展开；位置下移避免遮挡左上品牌标题

### 其他
- `server.mjs` 新增 `/probe` 端点，回报真实 DPR、canvas 尺寸与布局指标，便于排查
- 修正 `wall-proj/index.html` 中文乱码
- PowerShell 脚本统一使用 **UTF-8 with BOM**，避免 PowerShell 5.1 读出乱码导致解析失败
- 清理根目录测试截图与临时产物，规范化到 `docs/screenshots/`
