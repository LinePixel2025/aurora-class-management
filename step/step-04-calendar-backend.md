# Step 04 — v2.0.0 班级周历后端与数据接口

- Task: widget-notify-calendar
- Step: 4 / 7
- Status: pending
- Depends on: step 3
- Produces: `lib/ops.js` 增加 `loadWeekGrid` 与 `moveTask`；新增 `lib/calendar.js` 的 `load` 与编辑动作；`main.invokePanel('calendar', ...)` 可调用；离线测试覆盖 7 天数据与增删改移
- Phase: 集成
- Writes: `class-management/lib/calendar.js`、`class-management/lib/ops.js`、`class-management/main.js`、`dev/test-plugin.mjs`
- Size: L
- Risk: 页面型面板的 params 是直接对象（不是声明式面板的 `{ params, values }`）；`moveTask` 跨周要同时维护两个周桶与容量，失败必须保持原数据
- Sources: `plugin-dev-kit/docs/01-contract.md` §5.2（页面型面板 `request` 直接进入 `invokePanel`，v0.5.2）；`plugin-dev-kit/docs/02-guide.md` §7/§7.6（页面与事件推送，v0.5.2）；Aurora v0.5.2 Release（<https://github.com/LinePixel2025/Aurora-releases/releases/tag/v0.5.2>，访问 2026-10-24）

## 目标

为页面型“班级周历”准备完整后端：一次返回所选周的 7 天时间线数据（日期、每日事务、每日安排、值日组、通知、统计、是否可编辑），并提供页面所需的添加/编辑/完成/删除/移动事务、安排编辑、值日组与通知保存动作。本步不把页面入口写进 manifest，页面前端在 step 5 接入。

## 输入

- `class-management/lib/ops.js`：现有 `loadWeek` 只返回 `taskDate` 当天事务；`addTask`/`updateTask`/`completeTask`/`deleteTask`/`addSchedule`/`updateSchedule`/`deleteSchedule`/`setDutyWeek`/`setAnnouncement` 已存在；`taskSummary`/`dueLabel`/`isOverdue` 是内部函数。
- `class-management/main.js`：`invokePanel(panelId, method, params, ctx)` 当前只接受 `PANEL_ID = 'board'`，其他 panelId 返回 `{}`。
- `class-management/lib/state.js`：`readBoard`、`readSettings`、`emptyWeek`、`ensureWeek`、`updateBoard`、`LIMITS` 可用；`task.date` 已是数据模型字段。
- `class-management/lib/time.js`：`dateKeyOfWeekday`、`dateLabel`、`todayKey`、`weekdayLabel`、`normalizeOffset`、`resolveWeekContext`、`readWeekOffset`（在 ops）可用。
- 页面端约定：`window.auroraPlugin.request(method, params)` 的 `params` 会原样传给 `invokePanel`，不要再套 `{ params, values }`。
- 当前 `dev/test-plugin.mjs` 的 `invokePanel` helper 形如 `main.invokePanel('board', method, { params, values }, ctx)`；页面测试要直接传 `{ weekOffset, ... }`。

## 操作

1. 修改 `class-management/lib/ops.js`：
   - 新增 `loadWeekGrid(ctx, weekOffsetInput)`：
     - `weekOffset = readWeekOffset(weekOffsetInput, 0)`；
     - 读取 board/settings，`weekCtx = resolveWeekContext(weekOffset, settings, board)`，`week = board.weeks[weekCtx.key] || emptyWeek()`；
     - `duty = resolveDuty(...)`，`tasks = sortTasks(week.tasks)`，`schedule = sortSchedule(week.schedule)`；
     - 生成 `days`：1..7 每天 `{ date, weekday, label: dateLabel(date), isToday: date === todayKey(), canEdit: date >= todayKey(), tasks: 当天任务摘要, schedule: 当天安排 }`；任务摘要包含 `id`、`text`、`done`、`date`、`priority`、`category`、`assignee`、`dueLabel`、`overdue`；
     - 返回 `{ weekOffset, weekLabel: weekCtx.label, weekNumber: weekCtx.weekNumber, isCurrentWeek: weekCtx.isCurrent, todayKey: todayKey(), canEdit: weekOffset >= 0, duty, groups: board.duty.groups, announcement: week.announcement, stats: taskCounts(tasks, weekCtx), days }`。
   - 新增 `moveTask(ctx, input)`：
     - `id` 必填；`date` 用 `readTaskDate(input.date)`（不能早于今天，±12 周内）；
     - 在 `updateBoard` 内按 id 查找任务；计算目标周 `weekOffsetOfDate(date)`、目标 `weekCtx`、目标 `week`；
     - 目标周与源周不同时：先检查目标周 `tasks.length < LIMITS.maxTasksPerWeek`，再从源周移除、推入目标周、设置 `task.date`；两个周都 `touch`；
     - 同一周内只改 `task.date` 并 `touch`；
     - 返回 `{ task: taskSummary(task, targetWeekCtx), weekCtx: targetWeekCtx }`。
   - 导出 `loadWeekGrid`、`moveTask`，不要删除现有导出。
2. 新增 `class-management/lib/calendar.js`：
   - `CALENDAR_PANEL_ID = 'calendar'`；
   - `calendarData(ctx, weekOffset)` 调用 `loadWeekGrid`；
   - `handleCalendarPanel(panelId, method, params, ctx)`：
     - `params` 直接读取，`weekOffset = readWeekOffset(params.weekOffset, 0)`；
     - `load` 返回 `{ data: await calendarData(ctx, weekOffset) }`；
     - 支持动作：`add-task`、`update-task`、`toggle-task`、`delete-task`、`move-task`、`add-schedule`、`update-schedule`、`delete-schedule`、`set-duty-week`、`save-announcement`；
     - `add-task` 使用 `date` 字段（页面传入当天日期），调用 `ops.addTask`；`update-task` 直接透传字段；`toggle-task` 先读当前数据找到任务，再调用 `ops.updateTask({ id, done: !task.done })`；`move-task` 调用 `ops.moveTask`；
     - `set-duty-week` 的参数固定为 `{ groupName, note, weekOffset }`，调用 `ops.setDutyWeek`；`add-schedule` 传 `{ weekday, time, title, place, weekOffset }`；`save-announcement` 传 `{ text, weekOffset }`；
     - 成功返回 `{ data: 最新数据, message: '已...' }`；`DataError` 返回 `{ data: 最新数据, error: error.message }`；其他异常记录日志后返回 `{ data: 最新数据, error: '操作失败，请重试' }`；
     - 未知 method 返回 `{ data: 最新数据 }`。
3. 修改 `class-management/main.js`：
   - 引入 `handleCalendarPanel` 与 `CALENDAR_PANEL_ID`；
   - `invokePanel` 增加分支：`panelId === CALENDAR_PANEL_ID` 时直接 `return handleCalendarPanel(panelId, method, params, ctx)`；保留 board 的 `handlePanelAction` 分支；
   - 本步 manifest 与 `push.js` 保持原样，暂不暴露 `/calendar` 命令。
4. 修改 `dev/test-plugin.mjs`：
   - 增加 calendar 后端测试：`load` 返回 7 天、今日事务/安排/值日/通知正确；过去周 `canEdit === false`；添加、更新、完成、删除事务；跨天移动任务；添加/更新/删除安排；设置本周值日组与备注；保存通知；非法日期/未知 id 返回 `error` 且数据不半写；
   - 测试直接调用 `main.invokePanel('calendar', method, params, ctx)`；
   - 更新最终测试计数，step 6 同步 README。
5. 运行 `node --check` 与全量测试；本步不要求页面文件存在。

## 验收标准

- [ ] `node plugin-dev-kit/tools/check-plugin.mjs class-management` 退出码 0（本步 manifest 未改，仍应通过）。
- [ ] `node dev/test-plugin.mjs` 全绿；输出包含 calendar 相关测试，且 `load` 的 7 天数据、增删改移、安排、值日、通知均有断言。
- [ ] `node -e "const m=require('./class-management/main.js'); const c=require('./class-management/lib/calendar.js'); process.exit(typeof m.invokePanel==='function'&&typeof c.handleCalendarPanel==='function'&&c.CALENDAR_PANEL_ID==='calendar'?0:1)"` 退出码 0。
- [ ] `node --check class-management/lib/calendar.js` 与 `node --check class-management/lib/ops.js` 退出码 0。
- [ ] `node dev/preview.mjs` 退出码 0（本步不改变声明式 schema，视觉无变化）。
- [ ] `git diff --check` 无空白错误。

## 交接

- 页面数据形状固定为 `{ weekOffset, weekLabel, weekNumber, isCurrentWeek, todayKey, canEdit, duty, groups, announcement, stats, days }`；step 5 的 `ui/calendar.js` 直接使用这些字段。
- 页面动作方法名固定为 `load/add-task/update-task/toggle-task/delete-task/move-task/add-schedule/update-schedule/delete-schedule/set-duty-week/save-announcement`；step 5 不再改名。
- 本步未把 `calendar` 放进 manifest，所以 `check-plugin` 仍只看到 1 个 panel；step 5 才暴露。
- `push.js` 未改，`board.changed` 目前只发给 board + 2 widgets；step 5 再把 calendar 加入面板推送目标。

## 执行记录

（执行后填写：实际改动、验证结果、遗留问题。）
