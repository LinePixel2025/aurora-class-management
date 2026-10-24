# Step 05 — v2.0.0 页面型班级周历与预览

- Task: widget-notify-calendar
- Step: 5 / 7
- Status: pending
- Depends on: step 4
- Produces: `manifest.json` 2.0.0 增加 `calendar` 页面面板与 `/calendar` 命令；`ui/calendar.html/css/js` 实现 7 天时间线、任务拖动与编辑；`dev/preview-calendar.mjs` 生成页面预览截图
- Phase: 界面/集成
- Writes: `class-management/manifest.json`、`class-management/main.js`、`class-management/lib/push.js`、`class-management/ui/calendar.html`、`class-management/ui/calendar.css`、`class-management/ui/calendar.js`、`dev/preview-calendar.mjs`、`dev/test-plugin.mjs`、`dev/.cache/`
- Size: L
- Risk: 页面 CSP 只允许外部脚本，内联 `<script>`、内联事件属性、CDN、`fetch` 都会被拦截；右栏宽度约 400px，7 列横向网格会不可用，必须用垂直 7 天时间线；页面 `request` 返回 `{ data, error, message }`，所有动作后重新渲染
- Sources: `plugin-dev-kit/docs/01-contract.md` §5.2/§5.5（页面沙箱、`window.auroraPlugin`、推送，v0.5.2）；`plugin-dev-kit/docs/02-guide.md` §7/§7.6（页面请求与事件，v0.5.2）；Aurora v0.5.2 Release（<https://github.com/LinePixel2025/Aurora-releases/releases/tag/v0.5.2>，访问 2026-10-24）

## 目标

在右栏新增“班级周历”页面型管理台：以垂直 7 天时间线展示每天的事务与安排，顶部显示本周值日组和统计；支持内联添加事务、点击完成、编辑/删除、拖动到其他日期、编辑安排、设置本周值日组和通知。页面只通过 `window.auroraPlugin.request/onEvent` 与插件通信，不引入外部资源。

## 输入

- step 4 产出的 `lib/calendar.js`：`CALENDAR_PANEL_ID = 'calendar'`，`handleCalendarPanel` 已支持 `load/add-task/update-task/toggle-task/delete-task/move-task/add-schedule/update-schedule/delete-schedule/set-duty-week/save-announcement`，返回 `{ data, message?, error? }`。
- step 4 产出的 `ops.loadWeekGrid` 数据形状：`{ weekOffset, weekLabel, weekNumber, isCurrentWeek, todayKey, canEdit, duty, groups, announcement, stats, days }`，`days[]` 每项有 `date/weekday/label/isToday/canEdit/tasks/schedule`。
- `class-management/main.js`：`invokePanel` 已有 calendar 分支；`invokeCommand` 目前只有 `class` 与 `week-plan`。
- `class-management/lib/push.js`：当前 `PANEL_ID = 'board'`、`WIDGET_IDS` 2 个；`pushAll` 只推 board + 2 widgets。
- `class-management/manifest.json`：当前 1.3.0，1 个 panel，无 `calendar` 命令。
- 页面约束：CSP `script-src 'self'`，页面只能拿到 `window.auroraPlugin.request/onEvent`，没有 `window.aurora`、Node、文件系统；页面样式不能复用宿主令牌，需要自带暗色/亮色 CSS。
- `dev/preview.mjs` 只渲染声明式 schema，不能直接渲染页面；需要新增独立 `dev/preview-calendar.mjs`。

## 操作

1. 修改 `class-management/manifest.json`：
   - `"version": "2.0.0"`；
   - `contributes.panels` 增加：
     ```json
     { "id": "calendar", "title": "班级周历", "icon": "CalendarClock", "entry": "ui/calendar.html" }
     ```
   - `contributes.commands` 增加：
     ```json
     { "name": "calendar", "title": "打开班级周历", "description": "在右栏打开班级周历，按天查看和编辑事务、安排与值日", "mode": "action" }
     ```
   - 保留既有 `board` 面板与 `class` / `week-plan` 命令。
2. 修改 `class-management/lib/push.js`：
   - 面板目标改为 `PANEL_IDS = ['board', 'calendar']`；
   - `pushPanel(ctx, panelId, reason)` 支持显式目标；`pushAll` 依次推 board、calendar 与 2 个 widget，单次最多 4 条；
   - 保留 `pushWidgets`，widget 目标仍为 2 个。
3. 修改 `class-management/main.js`：
   - `invokeCommand('calendar')`：`await ctx.ui.openPanel(CALENDAR_PANEL_ID)`，返回 `{ summary: '已打开班级周历' }`；不需要保存 `ui.v1` 视图；
   - `invokeCommand('class')` 保持打开 board，并只推 board；
   - 确保 `pushAll` 的新签名在工具/面板/浮窗调用处一致；不要改变 `board.changed` 事件名。
4. 新增 `class-management/ui/calendar.html`：
   - 只使用 `<link rel="stylesheet" href="calendar.css">` 与 `<script src="calendar.js" defer></script>`；
   - 禁止内联 `<script>`、内联 `onclick`/`onchange`、外部 CDN、`fetch`、`eval`；
   - 结构至少包含：顶部标题/周切换、值日摘要、7 天时间线容器、通知区、编辑弹层、错误/状态提示区；
   - 所有用户内容由 `calendar.js` 用 `textContent` 填充。
5. 新增 `class-management/ui/calendar.css`：
   - 自带暗色/亮色变量，使用 `@media (prefers-color-scheme: light)`；
   - 右栏宽度下使用**垂直 7 天卡片**，不要做 7 列横向网格；
   - 事务按钮/安排条/添加表单在窄宽度下可换行；编辑弹层使用 `position: fixed` 覆盖；
   - 提供 `:focus-visible` 样式与基础响应式。
6. 新增 `class-management/ui/calendar.js`：
   - 只通过 `window.auroraPlugin.request(method, params)` 调用后端；通过 `window.auroraPlugin.onEvent` 订阅 `board.changed`，事件到达时重新 `load`；
   - 初始状态 `weekOffset = 0`；`load` 调用 `request('load', { weekOffset })`；
   - 渲染 7 天卡片：日期、值日组/统计在顶部；每天列出事务、安排；当天高亮；
   - 交互：
     - 每天底部一个内联 `input` + “添加”按钮，调用 `add-task`（date 用该天日期）；
     - 点事务切换完成（`toggle-task`）；事务旁“编辑”打开弹层；
     - 编辑弹层支持内容、截止日期/时间、优先级、分类、负责人、完成状态；保存调用 `update-task`，删除调用 `delete-task`；
     - 安排条点击打开安排弹层，支持周几/时间/事项/地点；保存/删除调用对应方法；
     - 值日摘要点击打开值日弹层，select 组（value 用组名） + 备注，保存调用 `set-duty-week({ groupName, note, weekOffset })`；
     - 通知编辑区 textarea + 保存调用 `save-announcement`；
     - 顶部上一周/本周/下一周按钮，调用 `load` 并更新 `weekOffset`；
     - `data.canEdit === false`（过去周）时隐藏或禁用添加、编辑、删除、拖动控件，只保留查看与周切换；每天日期早于今天时，该天的添加/放置控件也要禁用；
     - 任务支持 HTML5 drag/drop：dragstart 记录 id，放到某天调用 `move-task({ id, date })`；目标日 `canEdit === false` 时禁止放置；拖动失败显示错误并重新加载；
   - 每次动作后用返回的 `data` 重新渲染；`error` 显示在提示区，不抛到控制台；
   - 不使用 `innerHTML` 拼接用户文本；使用 `document.createElement`/`textContent`；不使用内联事件属性；
   - 不对 `window.auroraPlugin` 之外的宿主对象做假设。
7. 新增 `dev/preview-calendar.mjs`：
   - 从 `ui/calendar.html`、`ui/calendar.css`、`ui/calendar.js` 读取内容，产物写到 `dev/.cache/`；
   - 注入一个只读 mock `window.auroraPlugin`（`request` 返回 demo 数据，`onEvent` 返回空取消函数），再加载真实 `calendar.js`，用于截图；
   - `dev/preview.mjs` 已有 Chrome/Edge 查找与截图逻辑；把其中的 `readAsarEntry`、`findChrome`、`screenshot` 小函数复制到新脚本，不要 `import` 这个脚本（避免执行它的 `mainRun`）。
   - 截图产物保存到 `dev/.cache/calendar-preview.png`；
   - 预览 HTML 可以内联 CSS/JS（只用于 dev，不进入插件包），但 `ui/calendar.html` 本身必须保持外链。
8. 修改 `dev/test-plugin.mjs`：
   - 清单断言：version `2.0.0`、panels 包含 `calendar` 且 `entry === 'ui/calendar.html'`、commands 包含 `calendar`；
   - 推送断言：面板目标允许 `board` 与 `calendar`，单次推送 ≤ 5；`pushAll` 产生 4 条（2 面板 + 2 widgets）；
   - 页面静态检查：3 个页面文件存在；`calendar.html` 中没有缺 `src` 的 `<script>`、没有 `http://`/`https://`；`calendar.js` 包含 `auroraPlugin.request` 与 `auroraPlugin.onEvent`；
   - 命令测试：`invokeCommand('calendar')` 打开 `calendar` 面板并返回 summary；
   - 更新最终测试计数，step 6 同步 README。

## 验收标准

- [ ] `node plugin-dev-kit/tools/check-plugin.mjs class-management` 退出码 0，清单包含 2 个 panel 与 3 个命令。
- [ ] `node dev/test-plugin.mjs` 全绿；包含页面清单/命令、推送 ≤ 5、页面静态检查。
- [ ] `node --check class-management/ui/calendar.js` 与 `node --check dev/preview-calendar.mjs` 退出码 0。
- [ ] `node dev/preview-calendar.mjs` 退出码 0，生成 `dev/.cache/calendar-preview.png`；截图中 7 天时间线、值日条、添加表单、编辑弹层至少各出现一次。
- [ ] `node -e "const fs=require('fs'); const h=fs.readFileSync('class-management/ui/calendar.html','utf8'); const bad=/<script(?![^>]*\bsrc=)/i.test(h)||/https?:\/\//i.test(h)||/\son[a-z]+\s*=/i.test(h); process.exit(bad?1:0)"` 退出码 0。
- [ ] `node -e "const fs=require('fs'); const j=fs.readFileSync('class-management/ui/calendar.js','utf8'); const ok=/auroraPlugin\.request/.test(j)&&/auroraPlugin\.onEvent/.test(j)&&!/\bfetch\s*\(/.test(j)&&!/\beval\s*\(/.test(j); process.exit(ok?0:1)"` 退出码 0。
- [ ] `node dev/preview.mjs` 退出码 0（声明式预览不受影响）。
- [ ] `git diff --check` 无空白错误。
- [ ] 真机手动核对：斜杠命令 `calendar` 打开“班级周历”；7 天卡片可滚动；添加、完成、编辑、删除、拖动事务；切换周；编辑安排、值日、通知；页面刷新后数据保留。

## 交接

- 页面文件、命令、面板、推送目标全部就绪；step 6 只做文档、截图与构建，不再改页面功能。
- `calendar` 面板的页面事件依赖 `board.changed`；`pushAll` 现在推 4 条，任何新增推送目标都要重新核对 ≤ 5。
- 页面预览由 `dev/preview-calendar.mjs` 生成，step 6 将其截图复制到 `docs/images/calendar-dark.png` 与 `docs/images/calendar-light.png`。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题。）
