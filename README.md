# 班级事务台 · Aurora 插件项目

> GitHub：<https://github.com/LinePixel2025/aurora-class-management>

基于 **Aurora v0.5.1（插件 API v1）** 的班级事务管理系统：

- **4 张桌面置顶浮窗**：本周值日、本周事务、本周安排、班级速览——可拖动、可缩放、可隐藏，位置由 Aurora 记住；
- **右栏管理台**：看板 / 值日 / 安排 / 通知 / 设置 五个视图，能增删改事务、值日、安排与通知；
- **Agent 可改**：13 个插件工具 + 1 个 Skill + 2 条斜杠命令；写入后浮窗与面板自动刷新，不用手动点刷新；
- 数据只存插件私有存储，不联网、不读写用户文件、不接触 Aurora 凭据。

![4 个桌面浮窗（示例数据）](docs/images/widgets-dark.png)

![班级事务台看板（完整内容）](docs/images/panel-board-full-dark.png)

更多截图：[空看板](docs/images/panel-board-empty-dark.png) · [值日](docs/images/panel-duty-dark.png) · [安排](docs/images/panel-schedule-dark.png) · [通知](docs/images/panel-notice-dark.png) · [设置](docs/images/panel-settings-dark.png) · [浅色浮窗](docs/images/widgets-light.png)

## 交付物

```
class-management/                 插件包（zip 根目录）
  manifest.json / main.js / lib/ / ui/ / skills/ / types/ / README.md
Releases                          v1.0.0 安装包附件（本地构建输出到 dist/class-management-1.0.0.zip）
dev/test-plugin.mjs               离线全链路测试（mock 宿主 + 宿主原版 schema 校验器）
dev/preview.mjs                   用宿主 CSS 生成浮窗 / 面板预览与截图
dev/preview-renderer.js           预览用声明式渲染器（只读，不随插件发布）
dev/.cache/                       预览 HTML / PNG / 字体缓存（已 gitignore）
scripts/build.ps1                 校验 → 测试 → 打 zip → 输出 SHA-256
scripts/dev-register.ps1          注册 / 移除开发目录（需先退出 Aurora，自动备份配置）
docs/images/                       README 用截图（预览脚本生成后拷入）
```

> 本仓库**不包含** Aurora 官方的 `plugin-dev-kit/`（第三方工具包）。需要独立静态校验时，把它放到项目根的 `plugin-dev-kit/`；`dev/test-plugin.mjs` 会优先从本机 Aurora 安装目录提取宿主校验器。

## 安装

### 方式 A：安装插件包（推荐）

1. 从 [Releases](https://github.com/LinePixel2025/aurora-class-management/releases) 下载 `class-management-1.0.0.zip`；或本地构建：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build.ps1
   ```

2. Aurora → 设置 → 插件 → 已安装 → **安装插件包**，选择下载的 zip（本地构建则为 `dist\class-management-1.0.0.zip`）；
3. 核对权限、工具后安装。桌面上会出现 4 张浮窗；右栏「插件面板 → 班级事务台」可打开班级事务台。
4. 可选：在插件详情点「信任此插件」，让只读工具（`get_overview` / `list_tasks`）免逐次确认。

### 方式 B：开发目录（改代码自动重启）

1. **完全退出 Aurora**；
2. 运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\dev-register.ps1
   ```

   脚本会先备份 `%APPDATA%\Aurora\config.json`，再把本插件目录加入 `plugins.devDirs`；
3. 启动 Aurora → 设置 → 插件 → 开发，确认已加载；
4. 修改 `main.js` / `lib/` 后约 300ms 防抖自动重启插件。

移除开发目录：`scripts\dev-register.ps1 -Remove`（同样需要先退出 Aurora）。

> 开发目录加载的插件没有安装记录，工具默认逐次确认；日常使用建议走方式 A。
> 如果之前装过官方示例 `com.example.classboard`，桌面上可能多一张示例值日卡，可在插件详情里卸载示例。

## 试用

1. `/class` 打开班级事务台 → 设置 → 「写入示例周」写入一组示例值日 / 事务 / 安排；
2. 在「本周事务」浮窗的输入框里快速加一条事务，点「＋ 添加事务」；
3. 点浮窗里的事务条目可在完成 / 撤销之间切换；
4. 对 Agent 说：

   > 把下周三的值日改成张三和李四，区域写走廊。
   > 这周加一条事务：周五前交物理实验报告，高优先级，负责人物理课代表。
   > 帮我把下周的班会、月考动员和值日一次性排好。

   应能看到浮窗与已打开的面板立即更新。

## 验证

```powershell
# 1.（可选）本地有 Aurora 官方 plugin-dev-kit 时，跑清单 / 权限 / 静态 schema 校验
node plugin-dev-kit/tools/check-plugin.mjs class-management

# 2. 离线全链路测试：mock 宿主 + 从本机 Aurora app.asar 提取的宿主原版 validatePanelSchema
node dev/test-plugin.mjs

# 3. 视觉预览与截图（写入 dev/.cache，不随插件发布）
node dev/preview.mjs

# 4. 构建 zip
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

当前离线验证结果：

- `check-plugin.mjs`：通过（0 错误；本仓库未包含工具包，需要本地自备）；
- `dev/test-plugin.mjs`：**58/58 项检查通过**；
  覆盖时间/周次、存储读取、串行并发写、4 个浮窗、13 个工具、5 个面板视图与全部编辑动作、命令、推送目标/条数、整周计划失败回滚、跨天/跨周刷新、容量修剪；
- 所有静态与动态 schema 均通过 **Aurora 0.5.1 宿主原版** `validatePanelSchema`；清单同时通过从本机 Aurora 提取的宿主原版 zod `parsePluginManifest`；
- `dist/class-management-1.0.0.zip`：46.3 KB，SHA-256 `98BD19451B5AFC18A031B9585CE55C16AC2C3AD102C407B869806B47EBAAC35E`，manifest 在 zip 根，条目使用正斜杠，无 `node_modules`。

真机验收清单（需要你在 Aurora 里点一遍）：

- [ ] 插件状态「运行中」，桌面出现 4 张浮窗；
- [ ] 浮窗可拖动 / 缩放 / 点 × 隐藏，重启 Aurora 后位置保留；
- [ ] 管理台 5 个视图可切换，能加事务、勾完成、删除、编辑值日 / 安排 / 通知；
- [ ] Agent 调用工具后浮窗与面板立即更新（不点刷新）；
- [ ] 跨天 / 跨周后浮窗自动显示新一天 / 新一周；
- [ ] 停用 / 卸载插件后浮窗关闭。

## Agent 工具

`get_overview`、`list_tasks`、`add_task`、`update_task`、`complete_task`、`delete_task`、
`set_duty_day`、`set_duty_week`、`set_duty_groups`、`add_schedule`、`delete_schedule`、
`set_announcement`、`apply_week_plan`。

- 工具名为 `plugin.com.classmanagement.board.<name>`；
- 只读工具注册为 `readonly: true`，只读档也能用；
- 写入后通过 `ctx.ui.panelEvent({ panelId: 'board' } | { widgetId: ... })` 推送 `board.changed`，一次变更最多 5 条；
- Skill `class-board` 说明了 `weekOffset`（0=本周，1=下周）、id 使用与批量写入方式。

## 数据与隐私

- 业务数据在 `%APPDATA%\Aurora\plugin-data\com.classmanagement.board\storage.json`（键 `board.v1`），
  界面状态在 `ui.v1`；
- 单值 ≤ 240 KB（宿主上限 256 KB），每周事务 ≤ 80、安排 ≤ 60、最多 40 周，超限先修剪最旧周；
- 权限只有 `tools / skills / commands / storage / config / logging / ui.panels / ui.widgets`；
- 插件进程以当前用户权限运行，**不是 OS 沙箱，安装即信任**；本插件不发起网络请求、不读写插件目录以外的文件。

## 平台特性与边界（Aurora 0.5.1）

- **桌面浮窗**是宿主创建的置顶浮动 `BrowserWindow`（`alwaysOnTop`、无边框、不占任务栏），
  不是壁纸层嵌入，也不是插件自建窗口；v1 不允许插件创建任意窗口。
- 单插件最多 **4 个小组件**，因此是 4 张浮窗而不是更多；提示条（edge-bar）是另一种槽位，本项目未使用。
- 宿主 `PluginSchemaRenderer` 的 `row` / `grid` 会把子节点再包进一个纵向 `.plugin-schema`，实际按列渲染。
  因此本项目全部单列排版：视图/周切换用「下拉框 + 切换按钮」，事务/安排用「列表 + 下拉选择 + 按钮」。
- 开发目录插件没有安装记录，工具即使声明 `safe` 也会逐次确认。
- 浮窗默认按宿主级联位置出现，初次安装请拖到顺手的位置；位置 / 尺寸 / 显隐由 Aurora 持久化。

## 卸载

- 设置 → 插件 → 班级事务台 → 停用 / 卸载（可选同时删除数据）；
- 开发目录：退出 Aurora 后运行 `scripts\dev-register.ps1 -Remove`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装时报「清单校验失败」 | 本地有 Aurora 官方工具包时运行 `node plugin-dev-kit/tools/check-plugin.mjs class-management`；否则把完整错误发到 issue |
| 浮窗不显示 | 设置 → 插件 → 班级事务台 →「显示在桌面」开关；或检查是否停用 |
| 浮窗显示「正在读取…」不动 | 设置 → 插件 → 打开插件日志，检查 `%APPDATA%\Aurora\logs\plugins\com.classmanagement.board.log` |
| 工具每次都确认 | 在插件详情「信任此插件」；开发目录模式无法免确认 |
| Agent 改了但看不到 | 确认改的是**本周**（浮窗只显示本周）；用 `/class` 切换周查看其他周 |
| 写入失败「数据已超过 240 KB」 | 管理台 → 设置 → 清理旧数据 / 清理整周数据 |
| 改代码没生效 | 开发目录模式约 300ms 自动重启；或在插件详情点「重启」 |

## License

MIT。见 [LICENSE](LICENSE)。
