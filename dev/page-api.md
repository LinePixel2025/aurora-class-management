# 页面型面板 / 小组件 API 契约（v2.1.0 开发约定）

> 本文件是 v2.1.0「页面化重构」的开发契约，不随插件包发布（`dev/` 不打包）。
> 实现必须与本文一致；前端页面与后端处理器都以此为准。

## 1. 背景与目标

v2.0.0 的两个右栏面板分别是：

- `board`：**声明式**面板（宿主 `PluginSchemaRenderer` 渲染，视觉受限，删除入口埋在编辑卡片里）；
- `calendar`：**页面型**面板（`entry: ui/calendar.html`，自定义 HTML/CSS/JS，暗色黑板风格）。

v2.1.0 把 **班级事务台（board）改为页面型面板**，并把 **两张桌面小组件改为页面型 widget**
（`entry` 页面），统一使用与「班级周历」一致的视觉语言（`ui/calendar.css` 的设计令牌与组件），
同时修复：

- 今日「已完成事务」没有删除入口；
- 安排/事务删除需要宿主底部确认条、点删除像没反应；
- 周历本周内过去天（周一到昨天）的编辑/删除控件被禁用，导致本周安排删不掉；
- 浮窗（桌面小组件）毛玻璃效果与信息密度问题。

## 2. 清单与页面文件

```jsonc
// manifest.json（节选）
"panels": [
  { "id": "board", "title": "班级事务台", "icon": "CalendarClock", "entry": "ui/board.html" },
  { "id": "calendar", "title": "班级周历", "icon": "CalendarClock", "entry": "ui/calendar.html" }
],
"widgets": [
  {
    "id": "week-overview", "title": "班级速览", "icon": "Gauge", "slot": "desktop",
    "windowLevel": "desktop", "windowMaterial": "none", "hideCloseButton": true,
    "entry": "ui/widget-overview.html", "defaultSize": { "width": 320, "height": 300 }
  },
  {
    "id": "week-tasks", "title": "今日事务", "icon": "ListChecks", "slot": "desktop",
    "windowLevel": "desktop", "windowMaterial": "none", "hideCloseButton": true,
    "entry": "ui/widget-tasks.html", "defaultSize": { "width": 360, "height": 460 }
  }
]
```

新增/修改页面文件：

| 文件 | 说明 |
| --- | --- |
| `ui/board.html` / `board.css` / `board.js` | 班级事务台页面（4 视图） |
| `ui/widget-overview.html` / `widget-overview.js` | 班级速览小组件页面 |
| `ui/widget-tasks.html` / `widget-tasks.js` | 今日事务小组件页面 |
| `ui/widget.css` | 两张小组件共用样式 |
| `ui/calendar.css` | **全插件页面共用设计系统**（令牌 / 基础 / 按钮 / 弹层 / 表单 / 状态条），不再只是周历 |
| `ui/theme.css` | 不拆：新页面直接 `<link>` `calendar.css`，再链自己的 CSS |

删除：`ui/panel.json`、`ui/widget-overview.json`、`ui/widget-tasks.json`、`lib/panel.js`、`lib/widgets.js`。

## 3. 页面沙箱约束（静态检查会验证）

- 页面运行在 `aurora-plugin://<pluginId>/<entry>` 沙箱里，只能通过
  `window.auroraPlugin.request(method, params)` / `window.auroraPlugin.onEvent(listener)` 通信；
- **禁止**内联 `<script>`、内联事件（`onclick=` 等）、`fetch` / `XMLHttpRequest` / `localStorage` / 外部 CDN / 外部字体；
- CSS / JS 全部是页面内相对路径的独立文件；
- 所有用户内容只通过 `createElement` + `textContent` / `value` 写入，禁止拼 HTML 字符串；
- `onEvent(listener)` 的监听签名是 `listener(event, payload)`，返回取消函数；页面 `pagehide` 时取消；
- 宿主推送事件固定为 `board.changed`，页面收到后去抖 150–250ms 重新 `load`。

## 4. 请求 / 响应形状（页面侧）

页面调用：

```js
window.auroraPlugin.request('load', { ...params }) // → Promise<{ data?, message?, error? }>
window.auroraPlugin.request('delete-task', { id, weekOffset }, ...)
```

- 成功：`{ data: <最新全量数据>, message?: '已删除事务' }`；
- 失败：`{ data?: <最新数据>, error: '不能给过去的日期添加事务' }`（尽量带 data，页面可回填）；
- 写动作成功后 **后端统一 `pushAll(ctx, reason)`**：2 面板 + 2 小组件各 1 条 `board.changed`；
- 未知方法返回当前数据、无 message / error（视为刷新）。

## 5. 班级事务台（`panelId: "board"`）

### 5.1 `load`

```ts
request('load', { view?: 'board'|'duty'|'schedule'|'settings', weekOffset?: number })
// → { data: BoardPageData }
```

- `view` 缺省沿用 `ui.v1.view`（`'board'` = 今日）；`weekOffset` 缺省：今日/设置视图固定 0，
  值日/安排视图沿用 `ui.v1.weekOffset`；
- 服务端把 `view` / `weekOffset` 写入 `ui.v1`（页面切换视图、切周都持久化）。

`BoardPageData`：

```ts
interface BoardPageData {
  view: 'board' | 'duty' | 'schedule' | 'settings'
  weekOffset: number            // -12..12
  isCurrentWeek: boolean
  isPastWeek: boolean           // weekOffset < 0
  canEdit: boolean              // weekOffset >= 0（本周与未来周可编辑；过去周只读）
  weekLabel: string             // 例：第 6 周 · 10/19–10/25
  weekNumber: number
  weekRange: string             // 例：10/19–10/25
  today: string                 // YYYY-MM-DD
  taskDate: string
  taskDateLabel: string         // 例：10/24 周六
  settings: { className: string; teacher: string; termStartDate: string }
  counts: { total: number; pending: number; done: number; high: number; overdue: number }
  completion: number            // 0..100
  tasks: TaskSummary[]          // 今日视图：今天的全部事务（含已完成）；其他视图：该周周一的（一般不用）
  schedule: ScheduleEntry[]     // 当前加载周的全部安排（按周几/时间排序）
  routines: RoutineEntry[]      // 全部基础安排（全班长期数据，与加载的周无关）
  todayRoutines: RoutineEntry[] // 其中命中 taskDate 那个周几的基础安排
  announcement: string
  duty: {
    groupName: string
    members: string[]
    note: string
    hasOverrideGroup: boolean
    orderNames: string[]        // 轮换顺序组名
  }
  dutyGroupId: string           // 当前周指定组 id；空串 = 自动轮换
  groups: { id: string; name: string; members: string[] }[]
  groupsText: string            // 「第1组: 张三, 李四」多行文本（值日编辑器用）
  orderText: string             // 「第1组，第2组」轮换顺序文本
  rotationPreview: { week: string; group: string }[]  // 4 行轮换预览
  stats: { weeks: number; tasks: number; done: number; schedule: number; bytes: number }
  boardEmpty: boolean           // 当前加载周是否完全没有数据（写示例周按钮用）
}

interface TaskSummary {
  id: string
  text: string
  done: boolean
  date: string
  priority: 'high' | 'normal' | 'low'
  category: string
  dueDate: string               // '' 或 YYYY-MM-DD
  dueTime: string               // '' 或 HH:mm
  assignee: string
  doneAt?: string
  createdAt: string
  dueLabel: string              // 例：周六 20:00 / 10/30 08:00 / ''（含“今天”口径）
  overdue: boolean
}

interface ScheduleEntry {
  id: string
  weekday: number               // 1..7
  time: string                  // '' 或 HH:mm
  title: string
  place: string
  note: string
  createdAt: string
  remind: boolean               // 是否在到点前提醒（默认 false）
  remindLead?: number           // 0..120；缺省 = 用设置里的 notifyScheduleLead
}

interface RoutineEntry {
  id: string
  time: string                  // '' 或 HH:mm
  title: string
  place: string
  note: string
  weekdays: number[]            // 1..7 去重升序，缺省 [1,2,3,4,5]
  createdAt: string
}
```

### 5.2 写动作（统一返回 `{ data, message? }` / `{ data?, error }`）

| method | params | 说明 |
| --- | --- | --- |
| `save-view` | `{ view, weekOffset }` | 切换视图/周；写 `ui.v1`；不推送 |
| `add-task` | `{ text, dueDate?, dueTime?, priority?, category?, assignee? }` | 加今天的事务 |
| `update-task` | `{ id, text?, dueDate?, dueTime?, priority?, category?, assignee?, done? }` | 空字符串表示清除截止/负责人 |
| `toggle-task` | `{ id, done?: boolean }` | 缺省 `done` 时取反 |
| `delete-task` | `{ id }` | 任意周、任意天的事务都可删（本周内过去天也允许） |
| `add-schedule` | `{ weekday, time?, title, place?, note?, remind?, remindLead?, weekOffset? }` | 当前加载周；`remindLead: ''` = 用默认提前量 |
| `update-schedule` | `{ id, weekday?, time?, title?, place?, note?, remind?, remindLead?, weekOffset? }` | `weekOffset` 用于定位周；`remindLead: ''` 清除单条提前量 |
| `delete-schedule` | `{ id, weekOffset?, weekday?, title? }` | 安排允许删除（本周内过去周几也可删） |
| `add-routine` | `{ time?, title, place?, note?, weekdays? }` | 新增一条基础安排（全班长期，最多 30 条） |
| `update-routine` | `{ id, time?, title?, place?, note?, weekdays? }` | 逐字段修改；`weekdays` 传数组 |
| `delete-routine` | `{ id }` 或 `{ title }` | `title` 模糊匹配，必须唯一命中 |
| `set-duty-week` | `{ weekOffset?, groupId?, note? }` | `groupId: ''` = 恢复自动轮换；`note: ''` = 清空备注 |
| `save-duty-groups` | `{ groups: { name, members }[], order?: string[] }` | 值日分组与轮换顺序 |
| `save-announcement` | `{ text, weekOffset? }` | 空字符串 = 清空通知 |
| `clear-scope` | `{ scope: 'tasks' \| 'schedule' \| 'duty' \| 'all', weekOffset? }` | 清理范围（今日事务 / 本周安排 / 本周值日 / 全部） |
| `load-demo` | `{}` | 仅当前周为空时可用；写示例值日/事务/安排/通知 |

所有写动作都会 `pushAll`；`save-view` 只写 ui 状态，不推送。

### 5.3 页面 UI 要求（对齐班级周历）

- 顶部：`班级事务台` 大标题（宋体栈 / 字距）+ 班级名、周次、班主任；视图切换用胶囊 tab
  （今日 / 值日 / 安排 / 设置），当前 tab 用 `--cal-accent`；值日/安排视图显示周切换
  `‹ 上一周 / 本周 / 下一周 ›` 与周信息；
- 今日视图：日期 + 待办/完成/逾期/高优先级 + 进度条；值日胶囊（点击打开值日弹层）；
  添加事务表单（内容、截止日期、截止时间、优先级、分类、负责人）；
  未完成事务行 = 圆点切换 + 文本 + 元信息 + `编辑` + `删除`；
  **已完成事务也必须有 `删除` 按钮**（在“已完成”折叠区里，同时保留恢复为待办）；
  本周安排预览卡（可跳转安排视图）；班级通知卡（textarea + 保存）；
- 安排视图：添加安排表单（周几/时间/事项/地点）+ 每条安排行 `编辑` / `删除`；
  删除用页面内确认弹层（不要依赖宿主声明式确认条）；
- 值日视图：本周值日卡（组 / 成员 / 备注 / 修改按钮）、轮换预览、分组与轮换顺序编辑；
- 设置视图：班级信息、数据统计、清理范围、写示例周、Agent 用法提示；
- 所有危险操作（删除事务 / 删除安排 / 清空数据 / 写示例周）走页面内确认弹层，确认后调用 API；
- 失败时在状态条显示后端 `error`，并保留页面现有数据；成功显示 `message` 并自动消失（约 3s）；
- 过去周（`canEdit === false`）整体只读：隐藏/禁用添加、编辑、删除控件，并显示「过去周只读」；
- 页面复用 `calendar.css` 的 `.cal-btn` / `.cal-btn-primary` / `.cal-btn-danger` / `.cal-modal*` /
  `.cal-field` / `.cal-check` / `.cal-error` / `.cal-status` / `--cal-*` 令牌；自有布局类用 `board-` 前缀；
- 右栏 320–420px 宽也要可用；≥640px 时内容居中留白；窄屏按钮可换行；
- 无障碍：弹层 `role="dialog"`、Esc 关闭、打开时聚焦第一个输入、焦点返回触发按钮；状态条 `aria-live="polite"`。

## 6. 班级周历（`panelId: "calendar"`，改造点）

保留 v2.0.0 的 API 方法（`load` / `add-task` / `update-task` / `toggle-task` / `delete-task` /
`move-task` / `add-schedule` / `update-schedule` / `delete-schedule` / `set-duty-week` /
`save-announcement`），只改数据标志与前端可用性：

- `loadWeekGrid` 每天新增：
  - `isPast: boolean`（日期 < 今天）；
  - `canEdit: boolean`（**周可编辑**：`weekOffset >= 0`）——本周内过去天也允许编辑/删除/完成，
    仅**过去周**只读；
  - `canAddTask: boolean`（`weekOffset >= 0 && date >= today`）——过去天不能新增事务；
  - `routines: RoutineEntry[]`（v2.2.0 新增）——命中该天周几的基础安排；顶层同时返回整表 `routines`；
- 前端：
  - 事务/安排的编辑、删除、完成切换在 `canEdit` 时启用（**不再按天禁用**）；
  - 基础安排每天只读展示（「每天例行」+ 粉笔粉条目），不在日卡上增删改；
  - 安排行 `remind === true` 时显示「提前 n 分钟 / 到点前提醒」标记，提醒开关只在事务台「安排」视图编辑；
  - 每天「＋ 安排」在周可编辑时启用；
  - 添加事务输入框/按钮在 `canAddTask` 时启用；
  - 拖拽：源任务在本周可拖；放置目标必须是 `canAddTask` 的天；
  - 过去周仍显示「过去周（只读）」。

## 7. 桌面小组件（页面型）

### 7.1 `week-overview`（班级速览）

两个小组件的 `load` 返回**同一形状**（`WidgetData`），字段如下（缺什么就按空值渲染）：

```ts
interface WidgetData {
  widgetId: 'week-overview' | 'week-tasks'
  className: string
  teacher: string             // '' 表示未设置
  weekLabel: string           // 例：第 6 周 · 10/19–10/25
  weekRange: string           // 例：10/19–10/25
  weekNumber: number
  today: string               // YYYY-MM-DD
  todayLabel: string          // 例：10/24 周六
  taskDateLabel: string       // 与 todayLabel 相同（兼容 v2.0 口径）
  todayWeekday: number        // 1=周一 … 7=周日，页面用它给本周安排里的“今天”高亮
  counts: { total: number; pending: number; done: number; high: number; overdue: number }
  completion: number
  tasks: TaskSummary[]        // 今天的全部事务（含已完成，已排序）
  schedule: ScheduleEntry[]   // 本周全部安排（按周几/时间排序）
  scheduleCount: number
  routines: RoutineEntry[]    // 今天要做的基础安排（后端已按 todayWeekday 过滤）  duty: { groupName: string; members: string[]; note: string; hasOverrideGroup: boolean; isCurrentWeek: boolean }
  announcement: string
  showCompleted: boolean      // 配置项 showCompleted（今日事务小组件用）
}
```

只读展示（无写操作）：班级名、周次 + 班主任、待办/完成计数与进度、本周值日（组名徽章 + 轮换方式 + 成员 + 备注）、
每天例行（`routines`，为空时整块隐藏）、本周安排前 3 项（今天高亮，勾了提醒的带「提前 n 分钟」标记）与「还有 n 项」、班级通知摘要（最多 2 行）。

### 7.2 `week-tasks`（今日事务）

`request('load')` → `{ data: WidgetData }`（形状见 §7.1，`tasks` 是今天的全部事务，`showCompleted` 控制是否显示已完成）。

写动作（成功后返回最新 `data` + `message`，并 `pushAll`）：

| method | params | 说明 |
| --- | --- | --- |
| `toggle-task` | `{ id }` | 完成/恢复 |
| `delete-task` | `{ id }` | **删除今日待办（浮窗里直接删）** |

小组件窗口不可激活（Aurora 2026-10-30 起 `focusable: false`），页面不提供文本输入，也不提供 `add-task`；
新增事务请走班级事务台或周历。

页面（默认 360×460）：今日日期 + 待办/完成计数 + 进度条；
未完成事务行（圆点切换 + 文本 + 时限/优先级 + 删除按钮，二次点击或页面内小确认）；
已完成事务（`showCompleted` 开启时显示，可恢复/删除）；今日安排列表（最多 4 条，今天高亮）；
空态文案。写操作失败在页面顶部状态条显示。

### 7.3 小组件页面样式

- 链接 `calendar.css`（获得令牌/字体/主题）+ `widget.css`；
- `widget.css` 里 `html, body { background: transparent; }`，让宿主小组件卡片自己的不透明底色透出来
  （v2.1.0 已去掉 `windowMaterial: acrylic`）；
- 字号 11–13px，紧凑间距，内容超出时窗口内滚动；滚动条细化；
- 浅色/深色跟随系统（`calendar.css` 的 `prefers-color-scheme: light` 令牌）；
- 不显示插件名/关闭按钮等宿主 chrome 相关内容（宿主已渲染标题与 ×，页面只画内容）。

## 8. 测试与验收

- `dev/test-plugin.mjs` 覆盖：
  - 清单：2 个页面型面板、2 个页面型桌面小组件（`entry` 存在、`windowMaterial: 'none'`、`windowLevel: 'desktop'`）；
  - 页面静态约束：所有页面 HTML/CSS/JS（board / calendar / 2 widgets）无内联脚本、无 fetch、相对资源存在；
  - board `load` 数据形状、四视图、切周；添加/编辑/完成/删除事务（含**已完成事务删除**）；
    添加/编辑/删除安排；值日轮换/分组；通知；清理；示例周；过去周只读（写动作被拒）；
  - widget `load`、toggle/**delete-task**、失败提示；`add-task` 已移除（静默按刷新返回，不写不推送）；
  - calendar `load` 的 `isPast/canEdit/canAddTask`、**本周过去天可删除事务/安排**、过去周写拒绝；
  - 推送目标仍为 2 面板 + 2 小组件 = 4 条；
  - 原有时间/存储/迁移/7 天历史/通知/工具/命令检查全部保留。
- `node dev/preview.mjs` 生成「事务台 4 视图 + 2 张小组件」页面截图；`node dev/preview-calendar.mjs` 继续出周历截图。
- `powershell -ExecutionPolicy Bypass -File scripts/build.ps1` 通过并更新 zip SHA（版本 2.1.2）。
