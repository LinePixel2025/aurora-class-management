# 任务：为班级事务台增加桌面层/亚克力、系统通知与页面型班级周历

- 任务标识：widget-notify-calendar
- 项目根目录：D:\AICOP\ClassManagement
- 创建时间：2026-10-24 13:12
- 基线提交：54719f5
- 归档目录：（完成后填写）
- 归档时间：（完成后填写）

## 完成标准

- 插件升到 **v2.0.0**：2 张桌面浮窗声明 `windowLevel: "desktop"` 与 `windowMaterial: "acrylic"`，`minAuroraVersion: "0.5.2"`；`check-plugin.mjs` 与宿主 zod 清单解析通过。
- 新增**系统通知/定时提醒**：每日简报、截止提醒、周一值日提醒均可配置，默认全部关闭，按天/周/任务去重；离线测试覆盖重复调用不重复通知。
- 新增**页面型“班级周历”管理台**：`/calendar` 可打开；7 天时间线支持查看/添加/编辑/完成/删除/拖动事务，编辑安排、值日组与通知；页面只通过 `window.auroraPlugin` 通信，无内联脚本、无 CDN、无 `fetch`。
- `node dev/test-plugin.mjs` 全绿；`node dev/preview.mjs` 与 `node dev/preview-calendar.mjs` 退出码 0；`scripts\build.ps1` 生成 `class-management-2.0.0.zip` 并记录 SHA-256；根 README 与插件 README 同步更新。

## 现状与关键结论

- 当前插件 v1.1.0（commit `54719f5`）：`board.v1` 内部 schema v2，2 张桌面浮窗（`week-overview`、`week-tasks`），12 个工具，1 个声明式面板，59/59 离线测试通过。
- Aurora 0.5.2 已安装，`app.asar` 的 `WidgetManager` 支持 `windowLevel`（`floating` / `normal` / `desktop`）与 `windowMaterial`（`none` / `acrylic`）；本机 Windows 11 `10.0.26300` 且 `appearance.glass=true`，满足 Acrylic 条件。
- 0.5.2 契约：`windowLevel=desktop` 是“普通窗口 + Win32 owner 亲和 + 恢复守护”的尽力而为，不是壁纸层/桌面图标层/点击穿透；Acrylic 仅 Windows 11 22H2+ 且毛玻璃开启时生效，失败回退不透明卡片。
- 设置 → 插件详情已提供逐 widget 的层级覆盖（跟随插件 / 置顶 / 普通 / 桌面层），覆盖值写入 `plugin-widget-layout.json` 的 `windowLevelOverride`。
- 基线验收：`node plugin-dev-kit/tools/check-plugin.mjs class-management` 通过；`node dev/test-plugin.mjs` **59/59** 通过；`node dev/preview.mjs` **失败**，原因是 0.5.2 的 widget CSS 哈希从 `widget-D6DYJhPI.css` 变为 `widget-CG0kUrlE.css`，预览脚本硬编码了旧文件名。step 1 先修这个基线问题。
- 当前 `manifest.json` 无 `notifications` 权限、无通知配置字段、无页面型面板；`ui.panels` 权限已具备，可新增 `entry` 页面面板。
- 外部来源：Aurora v0.5.2 Release（<https://github.com/LinePixel2025/Aurora-releases/releases/tag/v0.5.2>，访问 2026-10-24）；本机 `plugin-dev-kit/docs/01-contract.md` §5.3、`docs/02-guide.md` §7.5 与 `README.md` 升级说明（v0.5.2）。

## 假设与待确认

- 假设：三个功能作为一套连续任务实现，版本依次升到 v1.2.0（桌面层/亚克力）→ v1.3.0（通知）→ v2.0.0（页面周历）。
- 假设：两张桌面浮窗都默认 `desktop` + `acrylic`；用户仍可在插件详情里覆盖层级。
- 假设：通知默认全部关闭；每日简报/周一值日提醒使用 `notifyTime`（默认 `07:30`），截止提醒提前 `notifyDueLead`（默认 10 分钟）。
- 假设：页面型周历作为**第二个面板**新增，不替换现有声明式“今日”面板；页面采用适合右栏宽度的垂直 7 天时间线，过去周只读，当前/未来周可编辑。
- 假设：页面任务拖动只在当前/未来周内移动，目标日期必须是今天或以后；跨周移动通过 `moveTask` 原子处理。
- 待确认：无。页面按新增第二个面板、通知默认全关执行；若之后要替换现有面板或默认开启，先修改 step 3 / step 5 再执行。
- 范围之外：edge-bar 小组件、插件主题、自动化动作/事件、宿主事件自动抓取聊天内容、多班级/多学期、壁纸层/点击穿透、外部 Win32 补丁、GitHub 提交/Release、修改 `plugin-dev-kit/` 或 Aurora 安装目录。

## 步骤

> 同波可并行：无

| # | 文件 | 标题 | 状态 | 依赖 | 写范围 |
|---|------|------|------|------|--------|
| 1 | step-01-preview-assets.md | 修复预览脚本适配 0.5.2 资源哈希 | pending | - | `dev/preview.mjs`、`dev/.cache/` |
| 2 | step-02-desktop-acrylic.md | v1.2.0 桌面层与原生亚克力 | pending | step 1 | `class-management/manifest.json`、`class-management/README.md`、`README.md`、`docs/aurora-widget-desktop-level.md`、`dev/test-plugin.mjs` |
| 3 | step-03-notifications.md | v1.3.0 系统通知与定时提醒 | pending | step 2 | `class-management/manifest.json`、`class-management/main.js`、`class-management/lib/notify.js`、`dev/test-plugin.mjs`、`README.md`、`class-management/README.md` |
| 4 | step-04-calendar-backend.md | v2.0.0 班级周历后端与数据接口 | pending | step 3 | `class-management/lib/calendar.js`、`class-management/lib/ops.js`、`class-management/main.js`、`dev/test-plugin.mjs` |
| 5 | step-05-calendar-page.md | v2.0.0 页面型班级周历与预览 | pending | step 4 | `class-management/manifest.json`、`class-management/main.js`、`class-management/lib/push.js`、`class-management/ui/calendar.html`、`class-management/ui/calendar.css`、`class-management/ui/calendar.js`、`dev/preview-calendar.mjs`、`dev/test-plugin.mjs`、`dev/.cache/` |
| 6 | step-06-docs-build.md | v2.0.0 文档、截图与构建 | pending | step 5 | `README.md`、`class-management/README.md`、`docs/images/calendar-dark.png`、`docs/images/calendar-light.png`、`dev/preview-calendar.mjs`、`dev/.cache/`、`dist/` |
| 7 | step-07-archive.md | 归档清理 | pending | step 1..6 | `step/` |

## 审查重点

- 页面入口的 CSP：`ui/calendar.html` 只能通过外部 `calendar.js` 加载脚本，不能有内联脚本、内联事件处理器、CDN、`fetch`、`eval`。
- 页面型面板的 `invokePanel` 参数形状与声明式面板不同：页面 `request(method, params)` 的 params 直接进入 `invokePanel`，不要再套 `{ params, values }`。
- 通知去重：跨天、跨周、插件重启、重复 tick 都不能重复发；`ctx.notify` 返回 false 时只记日志，不抛错。
- 拖动事务要校验目标日期（今天或未来、±12 周内）和目标周容量，失败时保留原数据。
- 推送目标从 3 个变为 4 个（board + calendar + 2 widgets），仍不得超过宿主单次 5 条上限。
- 所有改动不得读取/外发 Aurora 凭据、不得写插件目录以外的文件。

## 执行记录

（供执行阶段追加：每步实际改动、验证结果、git 提交清单、代码审查结论与处置。）
