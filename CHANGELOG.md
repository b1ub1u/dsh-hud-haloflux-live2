# 更新日志 / Changelog

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
