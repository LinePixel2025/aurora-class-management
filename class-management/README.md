# 班级事务台 · Aurora 插件

> GitHub：<https://github.com/LinePixel2025/aurora-class-management>

把「本周值日 / 本周事务 / 本周安排 / 班级速览」做成 4 张桌面置顶浮窗，并在 Aurora 右栏提供
一个可增删改的管理台；同时把数据接口交给 Agent——用自然语言就能改值日、加事务、排安排。

- 插件 id：`com.classmanagement.board`
- 版本：`1.0.0`（插件 API v1，Aurora ≥ 0.5.1）
- 权限：`tools` / `skills` / `commands` / `storage` / `config` / `logging` / `ui.panels` / `ui.widgets`

## 安装

### 方式 A：安装插件包（推荐）

1. 在项目根目录运行 `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`，得到
   `dist/class-management-1.0.0.zip`（zip 根目录直接是 `manifest.json`）；
2. Aurora → 设置 → 插件 → 已安装 → **安装插件包**，选择该 zip；
3. 核对权限与工具后安装。安装完成后桌面出现 4 张浮窗，右栏可打开「班级事务台」。
4. 如需免掉只读工具的逐次确认，在插件详情点「信任此插件」。

### 方式 B：开发目录（改代码自动重启）

1. 先**完全退出 Aurora**；
2. 在项目根目录运行 `powershell -ExecutionPolicy Bypass -File scripts\dev-register.ps1`
   （脚本会先备份 `%APPDATA%\Aurora\config.json`，并拒绝在 Aurora 运行时改动）；
3. 重新启动 Aurora → 设置 → 插件 → 开发，应能看到本目录；
4. 之后修改 `main.js` / `lib/` 会在 300ms 防抖后自动重启插件。

移除：`scripts\dev-register.ps1 -Remove`（同样需要先退出 Aurora）。

> 开发目录加载的插件不会出现在安装记录里，工具确认状态与正式安装不同；日常使用建议走方式 A。

## 桌面浮窗

| 浮窗 | 内容 | 默认尺寸 |
| --- | --- | --- |
| 本周值日 | 第几周与日期范围、本周值日组、今日值日、周一至周五名单（今日高亮） | 320×340 |
| 本周事务 | 待办/完成/逾期计数、完成率、行内快速添加、点条目完成或撤销 | 360×420 |
| 本周安排 | 本周班会/活动/考试清单，今日高亮 | 320×300 |
| 班级速览 | 班级名、班主任、完成率、四项统计、本周通知摘要 | 300×320 |

- 都是 Aurora 的**桌面置顶浮动卡片**（`alwaysOnTop`，无边框、不占任务栏），可拖动、缩放、隐藏；
  位置与显隐由 Aurora 持久化，重启后保留。
- 单插件最多 4 个小组件（宿主限制），因此这里是 4 张浮窗而不是无限多张。
- 浮窗始终显示**本周**；跨天/跨周时插件会自动推送刷新，不需要手动点刷新。
- 隐藏 / 显示：设置 → 插件 → 班级事务台 → 对应浮窗的「显示在桌面」开关。

## 右栏管理台

命令 `/class` 或右栏「插件面板 → 班级事务台」打开，共 5 个视图：

- **看板**：本周统计、添加事务（内容/截止/优先级/分类）、事务列表与完成/删除、今日值日、安排摘要、班级通知；
- **值日**：上方只读显示本周实际值日；「按天覆盖」只填需要改的天（格式 `周五: 张三 李四 | 教室 | 备注`），其余沿用值日组；可编辑分组、轮换顺序、本周指定组与备注；
- **安排**：添加/删除本周安排；
- **通知**：编辑本周班级通知；
- **设置**：班级信息（只读，去插件设置里改）、数据量、写入示例周、按范围清理、Agent 工具清单。

顶部两个下拉框切换「视图」和「周」（本周/上周/下周等），点「切换」生效。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `get_overview` | 读取某周总览：班级、周次、值日、事务（带 id）、安排、通知 |
| `list_tasks` | 按状态/分类列出事务，带 id |
| `add_task` | 添加事务（内容、截止、优先级、分类、负责人） |
| `update_task` | 按 id 修改事务 |
| `complete_task` | 按 id 或唯一文本完成/撤销 |
| `delete_task` | 删除事务（优先用 id） |
| `set_duty_day` | 设置某天值日名单/区域/备注，或清除覆盖 |
| `set_duty_week` | 指定本周由哪个组轮值，或恢复自动轮换 |
| `set_duty_groups` | 设置值日分组与按周轮换顺序 |
| `add_schedule` | 添加本周安排 |
| `delete_schedule` | 删除安排 |
| `set_announcement` | 设置/清空本周通知 |
| `apply_week_plan` | 一次写入整周事务/安排/值日/通知，原子生效 |

- 工具默认需要确认；在插件详情「信任此插件」后，只读工具（`get_overview` / `list_tasks`）免确认。
- 写入成功后浮窗与已打开的管理台会通过 `ctx.ui.panelEvent` 即时刷新，无需手动刷新。
- 附带 Skill `class-board`，教 Agent 周偏移、id 与批量写入的正确用法。
- 斜杠命令：`/class` 打开班级事务台；`/week-plan` 让 Agent 用三条要点总结本周。

对 Agent 说这些话就能改数据：

> 把下周三的值日改成张三和李四，区域写走廊。
> 这周再加一条事务：周五前交物理实验报告，高优先级，负责人物理课代表。
> 帮我把下周的班会、月考动员和值日一次性排好。

## 数据与配置

- 数据只在插件私有存储：`%APPDATA%\Aurora\plugin-data\com.classmanagement.board\storage.json`
  （`board.v1` 业务数据、`ui.v1` 界面状态）。
- 单值上限 240 KB（宿主上限 256 KB）；每周事务 ≤ 80、安排 ≤ 60，最多保留 40 周，超限会先修剪最旧周。
- 设置 → 插件 → 班级事务台 可改：班级名称、班主任、学期起始日期（第 1 周周一，留空则以首次运行所在周为第 1 周）、
  浮窗是否显示已完成事务。
- 不联网、不读写用户文件、不读取 Aurora 凭据。

## 安全边界

插件进程以**当前用户权限**运行，可以直接读写文件、联网、调用子进程。权限只门控 Aurora API，
**不是操作系统沙箱**；安装插件 = 信任其代码。本插件本身只使用插件存储与界面 API，不发起网络请求、
不访问插件目录以外的文件；但请仍然只安装来源可信的插件包。

## 目录

```
manifest.json              清单：权限与全部贡献
main.js                    入口：工具 / 命令 / 面板 / 浮窗 / 跨天刷新
lib/time.js                本地周运算与日期校验
lib/state.js               存储读写、净化、容量守卫、串行队列
lib/duty.js                值日轮换与逐日覆盖
lib/ops.js                 业务操作（工具/面板/浮窗共用）
lib/text.js                Agent 文本输出
lib/push.js                事件推送目标与单次上限
lib/widgets.js             4 个浮窗 schema
lib/panel.js               5 个面板视图与动作
ui/*.json                  初始声明式 schema（宿主兜底）
skills/class-board          Agent Skill
types/aurora-plugin.d.ts   契约类型
```

## 开发与验证

在项目根目录：

```powershell
node plugin-dev-kit/tools/check-plugin.mjs class-management   # 清单 / 权限 / schema 静态校验
node dev/test-plugin.mjs                                      # 离线全链路测试（mock 宿主 + 宿主 schema 校验器）
node dev/preview.mjs                                          # 生成浮窗/面板预览与截图（dev/.cache）
powershell -ExecutionPolicy Bypass -File scripts/build.ps1    # 校验 + 测试 + 打 zip
```

`dev/test-plugin.mjs` 会从本机 Aurora 的 `app.asar` 里提取宿主原版 `validatePanelSchema`，
校验每一份静态与动态 schema；没有安装 Aurora 时会降级为结构检查。

### 已知平台特性（Aurora 0.5.1）

- `PluginSchemaRenderer` 的 `row` / `grid` 会把子节点再包进一个纵向 `.plugin-schema`，
  实际按列渲染。本插件因此全部按单列排版：视图/周切换用下拉框，事务/安排用「列表 + 选择框 + 按钮」。
- 桌面浮窗是置顶浮动卡片，不是壁纸层嵌入；v1 不允许插件自建窗口。
- 提示条（edge-bar）小组件与本期 4 张桌面浮窗不同槽位；单插件最多 4 个小组件。
