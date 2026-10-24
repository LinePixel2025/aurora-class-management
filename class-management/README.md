# 班级事务台 · Aurora 插件

> GitHub：<https://github.com/LinePixel2025/aurora-class-management>

把「班级速览」与「今日事务」做成 **2 张页面型桌面小组件**，并在 Aurora 右栏提供
**2 个页面型面板**：班级事务台（`/class`）与班级周历（`/calendar`）。两个面板使用同一套
「黑板 / 备课本」视觉设计，都能直接删除事务与安排；同时把数据接口交给 Agent——
用自然语言就能改值日、加事务、排安排。

- 插件 id：`com.classmanagement.board`
- 版本：`2.1.0`（插件 API v1，Aurora ≥ 0.5.2）
- 权限：`tools` / `skills` / `commands` / `storage` / `config` / `logging` / `ui.panels` / `ui.widgets` / `notifications`
- 面板：页面型「班级事务台」（`/class`，4 视图）+ 页面型「班级周历」（`/calendar`，垂直 7 天时间线）
- 小组件：`windowLevel: "desktop"`、`windowMaterial: "none"`（不启用原生毛玻璃）
- 系统通知：可选（每日简报 / 截止提醒 / 周一值日提醒），默认全关，需在插件设置里开启

## 安装

### 方式 A：安装插件包（推荐）

1. 在项目根目录运行 `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`，得到
   `dist/class-management-2.1.0.zip`（zip 根目录直接是 `manifest.json`）；
2. Aurora → 设置 → 插件 → 已安装 → **安装插件包**，选择该 zip；
3. 核对权限与工具后安装。安装完成后桌面出现 2 张小组件，右栏可打开「班级事务台」或「班级周历」。
4. 如需免掉只读工具的逐次确认，在插件详情点「信任此插件」。

### 方式 B：开发目录（改代码自动重启）

1. 先**完全退出 Aurora**；
2. 在项目根目录运行 `powershell -ExecutionPolicy Bypass -File scripts\dev-register.ps1`
   （脚本会先备份 `%APPDATA%\Aurora\config.json`，并拒绝在 Aurora 运行时改动）；
3. 重新启动 Aurora → 设置 → 插件 → 开发，应能看到本目录；
4. 之后修改 `main.js` / `lib/` / `ui/` 会在 300ms 防抖后自动重启插件。

移除：`scripts\dev-register.ps1 -Remove`（同样需要先退出 Aurora）。

> 开发目录加载的插件不会出现在安装记录里，工具确认状态与正式安装不同；日常使用建议走方式 A。

## 桌面小组件

| 小组件 | 内容 | 默认尺寸 | 形态 | `windowLevel` | `windowMaterial` |
| --- | --- | --- | --- | --- | --- |
| 班级速览 | 班级名、周次、班主任、今日待办/完成/逾期计数与进度、本周值日组与成员/备注、本周安排前 3 项（今天高亮）、班级通知摘要 | 320×300 | 页面型 `ui/widget-overview.html` | `desktop` | `none` |
| 今日事务 | 今日日期与计数、完成率、快速添加、待办行（完成/恢复、截止信息、删除）、已完成区（显示时可恢复/删除）、本周安排（今天高亮） | 360×460 | 页面型 `ui/widget-tasks.html` | `desktop` | `none` |

- 都是 Aurora 的**桌面层小组件**（无边框、不占任务栏），可拖动、缩放、隐藏；位置 / 尺寸 / 显隐由 Aurora 持久化，重启后保留。
- `desktop` 是尽力而为：宿主按“普通窗口 + Win32 owner 亲和 + 恢复守护”实现，owner 亲和失败时回退普通层（`normal`）；
  不是壁纸层嵌入、不是桌面图标层、也不是点击穿透。
- **不启用毛玻璃**：v2.1.0 起改为 `windowMaterial: "none"`，小组件是不透明卡片，内容样式与班级周历一致；
  v2.0.0 的 Acrylic 需要 Windows 11 22H2+ 且宿主外观毛玻璃开启，观感不稳定，本版已去掉。
- 小组件页面运行在宿主沙箱的 webview 里，只通过 `window.auroraPlugin.request` / `onEvent` 与插件后端通信。
- 小组件里可以直接：快速添加今日事务、点圆点完成 / 恢复、删除待办（页面内二次确认）；**不需要打开面板**。
- 右上角的 `×` 是 **Aurora 宿主**绘制的“隐藏小组件”按钮，不属于插件清单或页面 DOM，**插件侧无法删除它**；
  误点后到 设置 → 插件 → 班级事务台 → 「显示在桌面」重新打开即可（位置沿用）。
- 插件只声明默认层级 / 材质；在 Aurora 设置 → 插件 → 班级事务台 → 对应小组件可逐 widget 改为跟随插件 / 置顶 / 普通 / 桌面层。
- 小组件始终显示**今天 / 本周**；跨天/跨周时插件会自动推送刷新，不需要手动点刷新。

## 右栏面板

共 2 个面板，都是**页面型**（清单 `entry` 指定 HTML，运行在宿主页面沙箱）。
两者共用 `ui/calendar.css` 中的设计令牌与组件（深色「晚自习黑板」/ 浅色「备课本」、宋体标题、粉笔黄主色），
样式与交互保持一致。

### 班级事务台（页面型）

命令 `/class` 或右栏「插件面板 → 班级事务台」打开，入口 `ui/board.html`，顶部是 4 个视图 tab：

- **今日**：今日日期与统计、完成率、本周值日胶囊；添加今日事务（内容 / 截止日期 / 截止时间 / 优先级 / 分类 / 负责人）；
  未完成事务行可直接「编辑 / 删除」；**已完成事务也每条都有「删除」**（同时保留恢复为待办）；
  本周安排预览（可跳到安排视图）；班级通知直接编辑保存；
- **值日**：本周值日组与成员、值日备注、未来四周轮换预览、本周临时换组（弹层）、分组与轮换顺序编辑（弹层）；
  值日按整周一组轮换，**没有按天覆盖**；
- **安排**：添加本周安排（周几 / 时间 / 事项 / 地点 / 备注）；每条安排行「编辑 / 删除」；
- **设置**：班级信息（只读，去插件设置里改）、数据量统计、按范围清理（今日事务 / 本周安排 / 本周值日 / 全部）、
  写入示例周（仅当前周为空时）、Agent 用法说明。

视图切换用 tab；值日 / 安排视图显示 `‹ 上一周 / 本周 / 下一周 ›`，可查看前后 12 周。
事务只显示今天，周切换只影响值日、安排和通知。
**删除、清理、写示例周都使用页面内确认弹层**，不依赖宿主声明式确认条；确认后立即生效并在状态条提示。

### 班级周历（页面型）

命令 `/calendar` 或右栏「插件面板 → 班级周历」打开，入口 `ui/calendar.html`：

- **垂直 7 天时间线**：每天一张卡片，展示当天事务与安排；顶部显示周次、本周待办 / 完成 / 逾期统计和本周值日组；
- **事务**：在当天行内添加；点圆圈按钮完成 / 撤销；点「编辑」打开编辑卡片（内容、截止、优先级、分类、负责人），可删除；
  可以拖动事务到其他日期；
- **安排 / 值日 / 通知**：点安排条目编辑或删除；「本周值日」可临时换组并写备注；班级通知在页面底部直接编辑保存；
- **可编辑范围**：本周内**过去几天也可以编辑 / 删除已有事务与安排**（「过去周只读」只限制上一周及更早）；
  新增事务仍只允许今天与未来日期，拖拽不能落到过去日期；
- 订阅 `board.changed`，Agent、小组件或事务台的改动会自动刷新，重新打开面板时也会重新读取最新数据。

页面运行在 Aurora 的页面沙箱里，只通过 `window.auroraPlugin.request` / `onEvent` 与插件后端通信：
没有内联脚本、没有 CDN、没有 `fetch`，不读写文件 / 网络；页面展示的数据全部来自插件后端
（`ui/calendar.js` → `lib/calendar.js`；`ui/board.js` → `lib/board-page.js`；小组件页面 → `lib/widget-page.js`）。

## 系统通知（可选）

三类通知默认关闭，在 Aurora 设置 → 插件 → 班级事务台 开启并按需配置：

- **每日简报**（`notifyDaily`，默认 `false`）：到达提醒时间后发送今日待办 / 完成计数与本周值日组，每天最多一次；
- **截止提醒**（`notifyDue`，默认 `false`；`notifyDueLead` 默认 `10`，范围 0–120）：对今天截止（或未填截止日期）的事务，
  在截止时间前 N 分钟提醒；每条事务每天最多一次，一次最多汇总 3 条；
- **周一值日提醒**（`notifyDuty`，默认 `false`）：每周一到达提醒时间后发送本周值日组与成员，每周最多一次。

`notifyTime` 是提醒时间，默认 `07:30`，本地 `HH:mm`，每日简报与周一值日提醒共用。

去重状态单独存在 `notify.v1`，按天 / 周 / 每条事务记录，插件重启后不重复发送。通知通过宿主 `ctx.notify` 发送，
**只在 Aurora 运行时生效**——插件不常驻后台，不是系统级后台提醒，Aurora 退出期间也不会补发。

## Agent 工具

工具共 **12 个**：

| 工具 | 作用 |
| --- | --- |
| `get_overview` | 读取某一天及所在周的总览：班级、周次、值日组与成员、该日事务（带 id）、本周安排与通知 |
| `list_tasks` | 按日期 / 状态 / 分类列出事务，带 id；默认今天，可查最近 7 天历史 |
| `add_task` | 添加事务（内容、`date`、截止、优先级、分类、负责人）；默认今天，最远 +12 周 |
| `update_task` | 按 id 修改事务 |
| `complete_task` | 按 id 或唯一文本完成/撤销；文本匹配默认今天，可传 `date` |
| `delete_task` | 删除事务（优先用 id；文本匹配默认今天，可传 `date`） |
| `set_duty_week` | 指定某一周由哪个组值日，或恢复自动轮换 |
| `set_duty_groups` | 设置值日分组与按周轮换顺序 |
| `add_schedule` | 添加本周安排 |
| `delete_schedule` | 删除安排 |
| `set_announcement` | 设置/清空本周通知 |
| `apply_week_plan` | 一次写入整周事务/安排/值日组/通知，原子生效 |

- 工具默认需要确认；在插件详情「信任此插件」后，只读工具（`get_overview` / `list_tasks`）免确认。
- Agent 写入成功后通过 `ctx.ui.panelEvent` 向 2 个面板与 2 张小组件推送 `board.changed`，无需手动刷新。
- 值日已改为整周轮换：`set_duty_day` 已删除；`apply_week_plan` 的 `plan.duty` 传 `days` 会报错。
- 附带 Skill `class-board`，教 Agent `date` / `weekOffset` 的分工、id 与批量写入方式。
- 斜杠命令：`/class` 打开班级事务台；`/week-plan` 让 Agent 用三条要点总结今日计划；`/calendar` 打开班级周历。

对 Agent 说这些话就能改数据：

> 今天再加一条事务：周五前交物理实验报告，高优先级，负责人物理课代表。
> 把本周值日改成第2组，备注写“周五放学后大扫除”。
> 帮我把下周的班会、月考动员和值日一次性排好。

## 数据与配置

- 数据只在插件私有存储：`%APPDATA%\Aurora\plugin-data\com.classmanagement.board\storage.json`
  （`board.v1` 业务数据、`ui.v1` 界面状态、`notify.v1` 通知去重状态）；`board.v1` 内部 schema 为 v2，首次启动自动从旧版迁移。
  2 个页面型面板与 2 张小组件复用同一份数据，页面不新增存储键。
- 事务带 `date`，界面只显示今天；旧事务保留最近 7 天（今天 + 前 6 天），之后自动清理。
- 单值上限 240 KB（宿主上限 256 KB）；每周事务 ≤ 80、安排 ≤ 60，最多保留 40 周，超限会先修剪最旧周。
- 事件推送固定为 `board.changed`：`pushAll` 一次发送 2 个面板 + 2 张小组件共 4 条，符合本项目自设单次 ≤5 条；宿主实际限速 20 条/秒、payload ≤64 KB。
- 设置 → 插件 → 班级事务台 可改：班级名称、班主任、学期起始日期（第 1 周周一，留空则以首次运行所在周为第 1 周）、
  今日事务小组件是否显示已完成事务、三类系统通知的开关与提醒时间（见「系统通知」）。
- 不联网、不读写用户文件、不读取 Aurora 凭据。

## 安全边界

插件进程以**当前用户权限**运行，可以直接读写文件、联网、调用子进程。权限只门控 Aurora API，
**不是操作系统沙箱**；安装插件 = 信任其代码。本插件本身只使用插件存储与界面 API，不发起网络请求、
不访问插件目录以外的文件；但请仍然只安装来源可信的插件包。

2 个页面型面板与 2 张页面型小组件都由宿主在页面沙箱中加载：页面只通过 `window.auroraPlugin.request` /
`onEvent` 与插件后端通信；HTML 无内联脚本，不引用 CDN，不使用 `fetch`，不读写文件 / 网络，
页面展示的数据全部来自插件后端。页面沙箱只约束这些页面，不等于上面的插件进程沙箱。

## 目录

```
manifest.json              清单：权限与全部贡献（2 页面型面板 / 2 页面型桌面小组件 / 12 工具 / 3 命令）
main.js                    入口：工具 / 命令 / 面板 / 小组件 / 跨天刷新 / 通知
lib/time.js                本地周运算、日期标签与日期校验
lib/state.js               存储读写、schema 迁移、7 天历史清理、串行队列
lib/duty.js                整周值日轮换与分组解析
lib/ops.js                 业务操作（工具 / 全部页面共用）
lib/text.js                Agent 文本输出
lib/util.js                文本净化、参数拆分、id 生成与优先级映射
lib/push.js                事件推送目标与单次上限
lib/notify.js              可选系统通知：每日简报 / 截止提醒 / 值日提醒与去重
lib/page-core.js           页面 RPC 公共工具（参数归一 / 动作结果 / 错误兜底）
lib/board-page.js          页面型「班级事务台」后端：4 视图数据与全部页面动作
lib/calendar.js            页面型「班级周历」后端：整周数据与页面动作
lib/widget-page.js         页面型桌面小组件后端：WidgetData 与快速添加 / 完成 / 删除
ui/calendar.css            全插件页面共用设计系统（令牌 / 基础 / 按钮 / 弹层 / 表单）
ui/board.html|css|js       班级事务台页面（4 视图，页面内确认弹层）
ui/calendar.html|css|js    班级周历页面（垂直 7 天时间线）
ui/widget-overview.html|js 班级速览小组件页面
ui/widget-tasks.html|js    今日事务小组件页面
ui/widget.css              两张小组件共用紧凑样式
skills/class-board         Agent Skill
types/aurora-plugin.d.ts   契约类型
README.md                  本说明（随插件包发布）
```

## 开发与验证

在项目根目录：

```powershell
node plugin-dev-kit/tools/check-plugin.mjs class-management   # 清单 / 权限 / 静态校验（v2.1.0）
node dev/test-plugin.mjs                                      # 离线全链路测试（mock 宿主 + 宿主原版 zod 清单解析，148/148）
node dev/preview.mjs                                          # 事务台 4 视图 + 2 张小组件页面预览与截图（dev/.cache）
node dev/preview-calendar.mjs                                 # 页面型「班级周历」预览与截图（dev/.cache）
powershell -ExecutionPolicy Bypass -File scripts/build.ps1    # 校验 + 测试 + 打 zip
```

- `dev/test-plugin.mjs` 会从本机 Aurora 的 `app.asar` 提取宿主原版清单 zod 解析器；
  没有安装 Aurora 时会打印警告并跳过该 2 项，其余检查照常。
- `dev/preview.mjs` / `dev/preview-calendar.mjs` 把真实的页面 HTML/CSS/JS 合成一份可用 `file://` 打开的预览页，
  注入只读 mock `window.auroraPlugin` 后交给本机 Chrome / Edge headless 截图；产物只写在 `dev/.cache/`，
  不随插件包发布；README 配图由这些图拷入 `docs/images/`。
- 当前离线验证：`check-plugin.mjs` 通过（v2.1.0），`dev/test-plugin.mjs` **148/148 通过**。

### 已知平台特性（Aurora 0.5.2）

- 页面型面板 / 页面型桌面小组件由清单 `entry` 指定插件目录内的 HTML；页面运行在宿主沙箱中，
  只通过 `window.auroraPlugin.request` / `onEvent` 与插件后端通信，不使用内联脚本、CDN 或 `fetch`。
- 桌面小组件由宿主创建，插件 API v1 不允许插件自建窗口；0.5.2 起支持
  `windowLevel`（`floating` / `normal` / `desktop`）与 `windowMaterial`（`none` / `acrylic`）。
- 本插件 2 张小组件默认 `desktop` / `none`：`desktop` 由宿主按“普通窗口 + Win32 owner 亲和 + 恢复守护”实现，
  owner 亲和失败时回退普通层（`normal`）；它不是壁纸层嵌入、不是桌面图标层、也不是点击穿透。
- 小组件窗口标题栏（标题 + `×` 隐藏按钮）由**宿主**绘制，插件清单没有隐藏它的字段；
  插件只负责标题栏下方页面内容，`×` 的显隐行为以宿主为准。
- 用户可在 Aurora 设置 → 插件 → 班级事务台 → 对应小组件逐 widget 覆盖层级（跟随插件 / 置顶 / 普通 / 桌面层）；
  插件只声明默认值，不读写宿主的窗口布局覆盖。
- 提示条（edge-bar）小组件与本期 2 张桌面小组件不同槽位；单插件最多 4 个小组件。
