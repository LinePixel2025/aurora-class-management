---
name: class-board
description: 查询与修改「班级事务台」插件的本周事务、值日安排、本周安排与班级通知
when_to_use: 用户提到班级值日、本周事务、作业/通知/活动安排，或要求修改班级事务台里的内容时
---

# class-board

## 数据口径

- 「周」以周一为起点，`weekOffset` 表示相对本周的偏移：`0` = 本周，`1` = 下周，`-1` = 上周。
- 事务、值日覆盖、安排、通知都按周存放；浮窗只显示**本周**。
- 事务 id 形如 `txxxxxx`，由 `get_overview` / `list_tasks` 返回；修改/删除时优先用 id，避免同名歧义。

## 推荐用法

1. 先调用 `plugin.com.classmanagement.board.get_overview` 了解班级、周次、值日、事务、安排、通知。
2. 只读查询用 `get_overview` / `list_tasks`；它们标了只读，在只读模式下也可用。
3. 单条修改：
   - 增加事务：`add_task`（内容必填，可带截止日期/时间、优先级、分类、负责人）；
   - 完成/撤销：`complete_task`（优先 id）；
   - 改字段：`update_task`；删除：`delete_task`；
   - 值日：`set_duty_day`（某天名单/区域/备注）、`set_duty_week`（本周轮换组）、`set_duty_groups`（分组与轮换顺序）；
   - 安排：`add_schedule` / `delete_schedule`；通知：`set_announcement`。
4. 一次安排整周（多个事务 / 多个安排 / 整周值日 / 通知）用 `apply_week_plan`，原子写入、只确认一次。
5. 写入成功后桌面浮窗与面板会自动刷新，**不需要**再调用任何刷新工具。

## 注意

- `text` 模糊匹配必须唯一命中；返回「歧义」时先用 `list_tasks` 取 id。
- 日期用 `YYYY-MM-DD`，时间用 `HH:mm`，都用本地时间。
- 不要编造事务 id；不要一次添加超过 80 条事务。
- 修改前一览数据，修改后向用户复述「改了什么、在哪一周」。
