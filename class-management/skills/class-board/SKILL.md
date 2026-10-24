---
name: class-board
description: 查询与修改「班级事务台」插件的今日事务、本周值日、本周安排与班级通知
when_to_use: 用户提到班级值日、今日事务、作业/通知/活动安排，或要求修改班级事务台里的内容时
---

# class-board

## 数据口径

- **事务按天**：每条事务有 `date`（`YYYY-MM-DD`），默认今天；浮窗和管理台只显示今天。
- **旧事务保留 7 天**：今天 + 前 6 天的历史仍可用 `list_tasks date=YYYY-MM-DD` 查回，超过 7 天自动清理；不能给过去的日期新增事务。
- **未来事务**：`add_task` 可以传今天到 +12 周内的 `date`，到那天才会出现在“今日事务”里。
- **值日按周**：一周由一组负责，按分组顺序每周轮换；没有按天覆盖。`set_duty_week` 可指定某一周的组，`set_duty_groups` 改分组与轮换顺序。
- **安排 / 通知按周**：用 `weekOffset`（0=本周，1=下周，-1=上周）定位。
- 事务 id 形如 `txxxxxx`，由 `get_overview` / `list_tasks` 返回；修改/删除时优先用 id，避免同名歧义。

## 推荐用法

1. 先调用 `plugin.com.classmanagement.board.get_overview` 了解班级、周次、值日组、今日事务、本周安排与通知；默认就是今天。要看某一天用 `date`；用 `weekOffset` 看某周时，事务默认该周周一。
2. 只读查询用 `get_overview` / `list_tasks`；它们标了只读，在只读模式下也可用。
3. 单条修改：
   - 增加事务：`add_task`（内容必填，可带 `date`、截止日期/时间、优先级、分类、负责人）；
   - 完成/撤销：`complete_task`（优先 id；文本匹配默认今天，可传 `date`）；
   - 改字段：`update_task`；删除：`delete_task`；
   - 值日：`set_duty_week`（本周轮换组/备注）、`set_duty_groups`（分组与按周轮换顺序）；**没有** `set_duty_day`；
   - 安排：`add_schedule` / `delete_schedule`；通知：`set_announcement`。
4. 一次安排整周（多个事务 / 多个安排 / 整周值日 / 通知）用 `apply_week_plan`，原子写入、只确认一次。事务的 `date` 必须落在目标周；本周默认今天，其他周默认该周周一。
5. 写入成功后桌面浮窗与面板会自动刷新，**不需要**再调用任何刷新工具。

## 注意

- `text` 模糊匹配必须唯一命中；返回「歧义」时先用 `list_tasks` 取 id。
- 日期用 `YYYY-MM-DD`，时间用 `HH:mm`，都用本地时间。
- 不要编造事务 id；不要一次添加超过 80 条事务。
- `apply_week_plan` 的 `plan.duty` 只接受 `groupName` / `note`，传 `days` 会报错（值日已改为整周轮换）。
- 修改前一览数据，修改后向用户复述「改了什么、在哪一天/哪一周」。
