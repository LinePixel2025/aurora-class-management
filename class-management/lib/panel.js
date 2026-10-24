'use strict'

/**
 * 右栏「班级事务台」：4 个视图 + 所有按钮动作。
 *
 * 宿主 0.5.1 的 row / grid 实际按列渲染（子节点被包进竖向 `.plugin-schema`），
 * 因此这里全部按单列设计：视图 / 周切换用一个 select + 一个「应用」按钮；
 * 每条事务 / 安排一张可预填编辑的卡片，避免“选择 + 留空不改 + 一排按钮”的旧交互。
 *
 * 宿主的 params 形状是 `{ params: <动作参数>, values: <输入绑定值> }`。
 */

const { clip, priorityLabel } = require('./util')
const { weekdayLabel, normalizeOffset, resolveWeekContext } = require('./time')
const { DataError, VIEWS } = require('./state')
const {
  loadWeek,
  loadUi,
  saveUi,
  bumpFormRev,
  addTask,
  updateTask,
  deleteTask,
  setDutyWeek,
  setDutyGroups,
  addSchedule,
  updateSchedule,
  deleteSchedule,
  setAnnouncement,
  clearScope,
  loadDemo,
  isOverdue,
  dueLabel,
} = require('./ops')
const { parseDutyGroupsText, parseOrderText } = require('./duty')
const { pushWidgets } = require('./push')

const PANEL_ID = 'board'

const CATEGORY_OPTIONS = ['作业', '活动', '通知', '事务', '其他'].map((value) => ({ value, label: value }))
const PRIORITY_OPTIONS = [
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
]
const VIEW_LABELS = [
  ['board', '今日'],
  ['duty', '值日'],
  ['schedule', '安排'],
  ['settings', '设置'],
]
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  value: String(day),
  label: weekdayLabel(day),
}))

function button(text, action) {
  return { type: 'button', text, action }
}

function offsetName(offset) {
  if (offset === 0) return '本周'
  if (offset === 1) return '下周'
  if (offset === -1) return '上周'
  if (offset === 2) return '下下周'
  if (offset === -2) return '上上周'
  return offset > 0 ? `后 ${offset} 周` : `前 ${-offset} 周`
}

function weekOptions(data) {
  const offsets = [...new Set([-2, -1, 0, 1, 2, data.weekCtx.offset])].sort((left, right) => left - right)
  return offsets.map((offset) => {
    const context = resolveWeekContext(offset, data.settings, data.board)
    const range = context.label.replace(/^(第 \d+ 周|未开学) · /, '')
    return { value: String(offset), label: `${offsetName(offset)}｜${range}` }
  })
}

function header(data) {
  const teacher = data.settings.teacher === '' ? '' : ` · 班主任 ${data.settings.teacher}`
  const dateText =
    data.ui.view === 'board' || data.ui.view === 'settings' ? ` · ${data.taskDateLabel}` : ''
  const nodes = [
    { type: 'heading', text: data.settings.className },
    { type: 'text', text: `${data.weekCtx.label}${dateText}${teacher}`, tone: 'muted' },
    {
      type: 'select',
      bind: 'viewChoice',
      text: '视图',
      options: VIEW_LABELS.map(([value, label]) => ({ value, label })),
      value: data.ui.view,
    },
  ]
  if (data.ui.view === 'duty' || data.ui.view === 'schedule') {
    nodes.push({
      type: 'select',
      bind: 'weekChoice',
      text: '周',
      options: weekOptions(data),
      value: String(data.weekCtx.offset),
    })
  }
  nodes.push(
    button('应用', { method: 'apply-nav', toast: '已切换' }),
    {
      type: 'text',
      text:
        data.ui.view === 'duty' || data.ui.view === 'schedule'
          ? '选好后点「应用」。事务只显示今天；周切换影响值日、安排和通知。'
          : '选好后点「应用」。事务只显示今天。',
      tone: 'muted',
    },
    { type: 'divider' },
  )
  return nodes
}

function dueInputValue(task) {
  if (task.dueDate === '') return ''
  return task.dueTime === '' ? task.dueDate : `${task.dueDate} ${task.dueTime}`
}

function taskMetaLine(task, weekCtx) {
  const parts = [task.category, priorityLabel(task.priority)]
  const due = dueLabel(task, weekCtx)
  if (due !== '') parts.push(`${isOverdue(task, weekCtx) ? '已逾期' : '截止'} ${due}`)
  if (task.assignee !== '') parts.push(task.assignee)
  return parts.filter(Boolean).join(' · ')
}

function taskRowText(task, data) {
  const meta = []
  const due = dueLabel(task, data.weekCtx)
  if (due !== '') meta.push(isOverdue(task, data.weekCtx) ? `已逾期 ${due}` : due)
  if (task.priority === 'high') meta.push('高')
  return `○ ${clip(task.text, 20)}${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`
}

function taskEditCard(task, data) {
  const id = task.id
  const revision = data.ui.formRev
  return {
    type: 'card',
    title: `编辑事务 · ${clip(task.text, 24)}`,
    children: [
      { type: 'text', text: taskMetaLine(task, data.weekCtx), tone: 'muted' },
      {
        type: 'input',
        bind: `taskText_${id}_${revision}`,
        text: '内容',
        value: task.text,
        placeholder: '事务内容',
      },
      {
        type: 'input',
        bind: `taskDue_${id}_${revision}`,
        text: '截止',
        value: dueInputValue(task),
        placeholder: 'YYYY-MM-DD HH:mm；留空清除',
      },
      {
        type: 'select',
        bind: `taskPriority_${id}_${revision}`,
        text: '优先级',
        options: PRIORITY_OPTIONS,
        value: task.priority,
      },
      button('保存修改', { method: 'update-task', params: { id }, toast: '事务已更新' }),
      button(task.done ? '恢复为待办' : '标记完成', {
        method: 'toggle-task',
        params: { id },
        toast: task.done ? '已恢复为待办' : '已完成',
      }),
      button('删除', {
        method: 'delete-task',
        params: { id },
        confirm: '删除这条事务？删除后无法恢复。',
        toast: '已删除事务',
      }),
      button('关闭编辑', { method: 'select-task', params: { id: '' } }),
    ],
  }
}

function scheduleCard(entry, data) {
  const id = entry.id
  const revision = data.ui.formRev
  const time = entry.time === '' ? '' : ` ${entry.time}`
  return {
    type: 'card',
    title: `${weekdayLabel(entry.weekday)}${time} · ${clip(entry.title, 22)}`,
    children: [
      {
        type: 'input',
        bind: `scheduleTitle_${id}_${revision}`,
        text: '事项',
        value: entry.title,
        placeholder: '例如：班会',
      },
      {
        type: 'input',
        bind: `scheduleTime_${id}_${revision}`,
        text: '时间',
        value: entry.time,
        placeholder: 'HH:mm（可留空）',
      },
      {
        type: 'input',
        bind: `schedulePlace_${id}_${revision}`,
        text: '地点',
        value: entry.place,
        placeholder: '例如：教室（可留空）',
      },
      {
        type: 'select',
        bind: `scheduleDay_${id}_${revision}`,
        text: '周几',
        options: WEEKDAY_OPTIONS,
        value: String(entry.weekday),
      },
      button('保存修改', {
        method: 'update-schedule',
        params: { id },
        toast: '安排已更新',
      }),
      button('删除', {
        method: 'delete-schedule',
        params: { id },
        confirm: '删除这条安排？删除后无法恢复。',
        toast: '已删除安排',
      }),
    ],
  }
}

function addTaskCard(data) {
  const revision = data.ui.formRev
  return {
    type: 'card',
    title: '添加今日事务',
    children: [
      {
        type: 'input',
        bind: `taskText_${revision}`,
        text: '内容',
        placeholder: '例如：收物理作业',
      },
      {
        type: 'input',
        bind: `taskDue_${revision}`,
        text: '截止（可选）',
        placeholder: `${data.taskDate} 18:00，也可只写 18:00`,
      },
      {
        type: 'select',
        bind: `taskPriority_${revision}`,
        text: '优先级',
        options: PRIORITY_OPTIONS,
        value: 'normal',
      },
      {
        type: 'select',
        bind: `taskCategory_${revision}`,
        text: '分类',
        options: CATEGORY_OPTIONS,
        value: '作业',
      },
      button('添加事务', { method: 'add-task', toast: '已添加事务' }),
    ],
  }
}

function weekWord(data) {
  return data.weekCtx.isCurrent ? '本周' : offsetName(data.weekCtx.offset)
}

function boardView(data) {
  const nodes = header(data)
  const summary = [
    `待办 ${data.counts.pending}`,
    `完成 ${data.counts.done}`,
    ...(data.counts.overdue > 0 ? [`逾期 ${data.counts.overdue}`] : []),
    ...(data.counts.high > 0 ? [`高优先级 ${data.counts.high}`] : []),
  ].join(' · ')
  nodes.push({
    type: 'text',
    text: `${data.taskDateLabel} · ${summary}`,
    tone: data.counts.pending === 0 && data.counts.total > 0 ? 'ok' : 'default',
  })
  nodes.push({ type: 'progress', percent: data.completion })
  nodes.push({
    type: 'text',
    text:
      data.duty.members.length > 0 || data.duty.hasOverrideGroup
        ? `本周值日：${data.duty.groupName} · ${data.duty.members.join(' ') || '待设置成员'}${
            data.duty.note === '' ? '' : `（${data.duty.note}）`
          }`
        : '本周值日：待设置',
    tone: 'muted',
  })

  nodes.push(addTaskCard(data))

  const editing =
    data.ui.editingTaskId === ''
      ? undefined
      : data.tasks.find((task) => task.id === data.ui.editingTaskId)
  const pendingAll = data.pendingTasks.filter((task) => task.id !== data.ui.editingTaskId)
  const doneAll = data.doneTasks.filter((task) => task.id !== data.ui.editingTaskId)
  const pending = pendingAll.slice(0, 12)
  const done = doneAll.slice(0, 8)
  const taskChildren = []
  if (pending.length === 0 && done.length === 0 && editing === undefined) {
    taskChildren.push({
      type: 'text',
      text: '今天还没有事务。可以在上面添加，或让 Agent 帮你加一条。',
      tone: 'muted',
    })
  } else {
    if (pending.length > 0) {
      taskChildren.push({ type: 'text', text: '点一条事务即可在下方编辑。', tone: 'muted' })
      for (const task of pending) {
        taskChildren.push(
          button(taskRowText(task, data), {
            method: 'select-task',
            params: { id: task.id },
          }),
        )
      }
    }
    if (editing !== undefined) {
      taskChildren.push(taskEditCard(editing, data))
    } else if (data.ui.editingTaskId !== '') {
      taskChildren.push({
        type: 'text',
        text: '所选事务已不在今日列表，请重新选择。',
        tone: 'muted',
      })
    }
    if (done.length > 0) {
      taskChildren.push({ type: 'divider' })
      taskChildren.push({ type: 'text', text: '已完成（点条目恢复为待办）', tone: 'muted' })
      for (const task of done) {
        taskChildren.push(
          button(`✓ ${clip(task.text, 30)} · 点此恢复`, {
            method: 'toggle-task',
            params: { id: task.id },
            toast: '已恢复为待办',
          }),
        )
      }
    }
    const hidden = pendingAll.length - pending.length + (doneAll.length - done.length)
    if (hidden > 0) {
      taskChildren.push({
        type: 'text',
        text: `还有 ${hidden} 条未显示，可以让 Agent 帮你查看或分批处理。`,
        tone: 'muted',
      })
    }
  }
  nodes.push({ type: 'card', title: `今日事务（${data.counts.total}）`, children: taskChildren })

  const schedulePreview = data.schedule.slice(0, 6)
  nodes.push({
    type: 'card',
    title: `本周安排（${data.schedule.length}）`,
    children: [
      ...(schedulePreview.length === 0
        ? [{ type: 'text', text: '本周还没有安排。', tone: 'muted' }]
        : [
            {
              type: 'list',
              items: schedulePreview.map((entry) => ({
                label: `${weekdayLabel(entry.weekday)}${entry.time === '' ? '' : ` ${entry.time}`}${
                  data.weekCtx.isCurrent && entry.weekday === data.weekCtx.todayWeekday ? ' · 今天' : ''
                }`,
                value: `${clip(entry.title, 24)}${entry.place === '' ? '' : ` · ${entry.place}`}`,
                tone:
                  data.weekCtx.isCurrent && entry.weekday === data.weekCtx.todayWeekday
                    ? 'ok'
                    : 'default',
              })),
            },
          ]),
      ...(data.schedule.length > schedulePreview.length
        ? [{ type: 'text', text: `还有 ${data.schedule.length - schedulePreview.length} 项。`, tone: 'muted' }]
        : []),
      { type: 'text', text: '在「安排」视图里编辑。', tone: 'muted' },
    ],
  })

  nodes.push({
    type: 'card',
    title: '班级通知',
    children: [
      {
        type: 'textarea',
        bind: `announcementText_${data.ui.formRev}`,
        text: '通知内容',
        value: data.announcement,
        placeholder: '最多 600 字；留空保存即清空。',
      },
      button('保存通知', { method: 'save-announcement', toast: '通知已保存' }),
    ],
  })
  return { version: 1, nodes }
}

function dutyView(data) {
  const nodes = header(data)
  const word = weekWord(data)
  const groupLabel = data.duty.members.length === 0 && !data.duty.hasOverrideGroup ? '待设置' : data.duty.groupName
  nodes.push({
    type: 'card',
    title: `${word}值日`,
    children: [
      {
        type: 'keyValue',
        items: [
          { label: '值日组', value: groupLabel },
          { label: '轮换方式', value: data.duty.hasOverrideGroup ? '本周指定' : '按周自动轮换' },
          { label: '备注', value: data.duty.note === '' ? '—' : data.duty.note },
        ],
      },
      {
        type: 'text',
        text:
          data.duty.members.length > 0
            ? `成员：${data.duty.members.join(' ')}`
            : '这个组还没有成员。可在下方「分组与轮换顺序」里填写。',
        tone: data.duty.members.length > 0 ? 'default' : 'muted',
      },
    ],
  })

  nodes.push({
    type: 'card',
    title: '轮换预览（一周一组）',
    children: [
      {
        type: 'table',
        columns: [
          { key: 'week', label: '周次' },
          { key: 'group', label: '值日组' },
        ],
        rows: data.rotationPreview.map((row) => ({ week: row.week, group: row.group })),
      },
      {
        type: 'text',
        text:
          data.duty.orderNames.length > 0
            ? `轮换顺序：${data.duty.orderNames.join(' → ')}`
            : '还没有设置轮换顺序。',
        tone: 'muted',
      },
    ],
  })

  nodes.push({
    type: 'card',
    title: `${word}临时换组`,
    children: [
      {
        type: 'select',
        bind: `dutyGroupPick_${data.ui.formRev}`,
        text: `${word}值日组`,
        options: [
          { value: '', label: '自动轮换' },
          ...data.board.duty.groups.map((group) => ({ value: group.id, label: group.name })),
        ],
        value: data.week.duty.groupId === undefined ? '' : data.week.duty.groupId,
      },
      {
        type: 'input',
        bind: `dutyNoteText_${data.ui.formRev}`,
        text: `${word}备注`,
        value: data.duty.note,
        placeholder: '例如：本周五放学后大扫除',
      },
      button('保存轮换', { method: 'save-duty-week', toast: '本周轮换已保存' }),
    ],
  })

  nodes.push({
    type: 'card',
    title: '分组与轮换顺序',
    children: [
      {
        type: 'text',
        text: '每行一组：第1组: 张三, 李四。轮换顺序填组名，用逗号分隔；按周依次轮换。',
        tone: 'muted',
      },
      { type: 'textarea', bind: `dutyGroupsText_${data.ui.formRev}`, text: '分组', value: data.groupsText },
      {
        type: 'input',
        bind: `dutyOrderText_${data.ui.formRev}`,
        text: '轮换顺序',
        value: data.orderText,
        placeholder: '第1组，第2组，第3组，第4组',
      },
      button('保存分组', { method: 'save-duty-groups', toast: '分组已保存' }),
    ],
  })
  return { version: 1, nodes }
}

function scheduleView(data) {
  const nodes = header(data)
  const word = weekWord(data)
  const revision = data.ui.formRev
  nodes.push({
    type: 'card',
    title: '添加安排',
    children: [
      {
        type: 'select',
        bind: `scheduleDay_${revision}`,
        text: '周几',
        options: WEEKDAY_OPTIONS,
        value: '1',
      },
      { type: 'input', bind: `scheduleTime_${revision}`, text: '时间（可选）', placeholder: '16:00' },
      { type: 'input', bind: `scheduleTitle_${revision}`, text: '事项', placeholder: '例如：班会' },
      { type: 'input', bind: `schedulePlace_${revision}`, text: '地点（可选）', placeholder: '例如：教室' },
      button('添加安排', { method: 'add-schedule', toast: '已添加安排' }),
    ],
  })

  const visible = data.schedule.slice(0, 20)
  const children = []
  if (visible.length === 0) {
    children.push({ type: 'text', text: `${word}还没有安排。`, tone: 'muted' })
  } else {
    for (const entry of visible) children.push(scheduleCard(entry, data))
    if (data.schedule.length > visible.length) {
      children.push({
        type: 'text',
        text: `还有 ${data.schedule.length - visible.length} 项，可以让 Agent 帮你查看或分批处理。`,
        tone: 'muted',
      })
    }
  }
  nodes.push({ type: 'card', title: `${word}安排（${data.schedule.length}）`, children })
  return { version: 1, nodes }
}

function settingsView(data) {
  const nodes = header(data)
  nodes.push({
    type: 'card',
    title: '班级设置',
    children: [
      {
        type: 'keyValue',
        items: [
          { label: '班级名称', value: data.settings.className },
          { label: '班主任', value: data.settings.teacher === '' ? '未设置' : data.settings.teacher },
          {
            label: '学期起始',
            value:
              data.settings.termStartDate === ''
                ? `未设置（以 ${data.board.anchorMonday} 所在周为第 1 周）`
                : data.settings.termStartDate,
          },
        ],
      },
      { type: 'text', text: '修改班级名称、班主任、学期起始日期：设置 → 插件 → 班级事务台。', tone: 'muted' },
    ],
  })

  const weekEmpty =
    data.week.tasks.length === 0 &&
    data.schedule.length === 0 &&
    data.announcement === '' &&
    data.week.duty.groupId === undefined &&
    data.week.duty.note === undefined
  nodes.push({
    type: 'card',
    title: '数据',
    children: [
      {
        type: 'keyValue',
        items: [
          { label: '已保存周数', value: String(data.stats.weeks) },
          { label: '事务总数', value: `${data.stats.tasks}（含近 7 天，完成 ${data.stats.done}）` },
          { label: '安排总数', value: String(data.stats.schedule) },
          { label: '占用空间', value: `${Math.ceil(data.stats.bytes / 1024)} KB（上限 240 KB）` },
        ],
      },
      ...(weekEmpty
        ? [
            button('写入示例周', {
              method: 'load-demo',
              confirm: '把示例值日、事务、安排写入本周？只在当前周为空时可用。',
              toast: '示例数据已写入',
            }),
          ]
        : []),
      {
        type: 'select',
        bind: 'clearScope',
        text: '删除范围',
        options: [
          { value: 'tasks', label: '今日事务' },
          { value: 'schedule', label: '本周安排' },
          { value: 'duty', label: '本周值日设置' },
          { value: 'all', label: '今日事务 + 本周安排/值日/通知' },
        ],
        value: 'tasks',
      },
      button('删除所选范围的数据', {
        method: 'clear-scope',
        confirm: '删除所选范围的数据？删除后无法恢复。',
        toast: '已清理',
      }),
      {
        type: 'text',
        text: '旧事务保留最近 7 天，可用 Agent 调用 list_tasks（date=YYYY-MM-DD）查回。',
        tone: 'muted',
      },
    ],
  })

  nodes.push({
    type: 'card',
    title: '给 Agent 用（可选）',
    children: [
      { type: 'text', text: '• /class 打开管理台；/week-plan 让 Agent 总结今日计划。', tone: 'muted' },
      {
        type: 'text',
        text: '• 事务按天：add_task 默认今天，传 date 可排未来某天；旧事务保留 7 天。',
        tone: 'muted',
      },
      {
        type: 'text',
        text: '• 值日按周：set_duty_week 指定本周组，set_duty_groups 编辑分组与轮换顺序。',
        tone: 'muted',
      },
      { type: 'text', text: '• Agent 修改后浮窗与面板会自动刷新，无需手动刷新。', tone: 'muted' },
    ],
  })
  return { version: 1, nodes }
}

function buildPanelSchema(data) {
  if (data.ui.view === 'duty') return dutyView(data)
  if (data.ui.view === 'schedule') return scheduleView(data)
  if (data.ui.view === 'settings') return settingsView(data)
  return boardView(data)
}

async function panelData(ctx) {
  const ui = await loadUi(ctx)
  const offset = ui.view === 'duty' || ui.view === 'schedule' ? ui.weekOffset : 0
  return loadWeek(ctx, offset)
}

async function renderPanel(ctx) {
  const data = await panelData(ctx)
  return buildPanelSchema(data)
}

async function safeRender(ctx) {
  try {
    return await renderPanel(ctx)
  } catch (error) {
    ctx.log('error', '生成管理台失败', { error: String(error) })
    return null
  }
}

async function afterChange(ctx, toast) {
  const schema = await safeRender(ctx)
  return { ...(schema === null ? {} : { schema }), ...(toast === undefined ? {} : { toast }) }
}

function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function readDue(value, fallbackDate, fallbackTime, defaultDate) {
  if (value === undefined) {
    return { dueDate: fallbackDate, dueTime: fallbackTime }
  }
  const raw = clip(value, 40)
  if (raw === '') return { dueDate: '', dueTime: '' }
  const full = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/.exec(raw)
  if (full !== null) {
    return { dueDate: full[1], dueTime: full[2] === undefined ? '' : full[2] }
  }
  const timeOnly = /^(\d{1,2}:\d{2})$/.exec(raw)
  if (timeOnly !== null && typeof defaultDate === 'string' && defaultDate !== '') {
    return { dueDate: defaultDate, dueTime: timeOnly[1] }
  }
  throw new DataError('截止时间没看懂：写成「2026-10-30」「2026-10-30 20:00」或「20:00」')
}

function formValue(values, key, revision) {
  const dynamic = `${key}_${revision}`
  if (values[dynamic] !== undefined) return values[dynamic]
  return values[key]
}

async function handlePanelAction(panelId, method, params, ctx) {
  if (panelId !== PANEL_ID) throw new Error(`未知面板：${panelId}`)
  const raw = params !== null && typeof params === 'object' ? params : {}
  const actionParams = raw.params !== null && typeof raw.params === 'object' ? raw.params : {}
  const values = raw.values !== null && typeof raw.values === 'object' ? raw.values : {}
  const name = typeof method === 'string' ? method : ''

  try {
    if (name === 'apply-nav') {
      const currentUi = await loadUi(ctx)
      const view = values.viewChoice === undefined ? currentUi.view : String(values.viewChoice)
      if (!VIEWS.includes(view)) throw new DataError('未知视图')
      let weekOffset = 0
      if (view === 'duty' || view === 'schedule') {
        if (values.weekChoice !== undefined && values.weekChoice !== '') {
          const parsed = Number(values.weekChoice)
          if (!Number.isFinite(parsed)) throw new DataError('周选择无效')
          weekOffset = normalizeOffset(parsed)
        } else {
          // 宿主只回传用户改过的输入；没改周就保留当前周，避免点“应用”把下周重置回本周。
          weekOffset = view === currentUi.view ? currentUi.weekOffset : 0
        }
      }
      await saveUi(ctx, { view, weekOffset })
      return { schema: await renderPanel(ctx), toast: '已切换' }
    }
    if (name === 'view') {
      const view = String(actionParams.view === undefined ? '' : actionParams.view)
      if (!VIEWS.includes(view)) throw new DataError('未知视图')
      await saveUi(ctx, { view, weekOffset: 0 })
      return { schema: await renderPanel(ctx) }
    }

    const data = await panelData(ctx)
    const revision = data.ui.formRev
    const offset = data.weekCtx.offset

    if (name === 'select-task') {
      const id = clip(actionParams.id, 40)
      if (id !== '' && !data.tasks.some((task) => task.id === id)) {
        throw new DataError('这条事务已不存在，请刷新面板')
      }
      await saveUi(ctx, { editingTaskId: id })
      return { schema: await renderPanel(ctx) }
    }
    if (name === 'add-task') {
      const due = readDue(formValue(values, 'taskDue', revision), '', '', data.taskDate)
      const priority = formValue(values, 'taskPriority', revision)
      const category = formValue(values, 'taskCategory', revision)
      await addTask(ctx, {
        text: formValue(values, 'taskText', revision),
        date: data.taskDate,
        priority: priority === undefined ? 'normal' : priority,
        category: category === undefined ? '作业' : category,
        dueDate: due.dueDate,
        dueTime: due.dueTime,
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-add-task')
      return afterChange(ctx, '已添加事务')
    }
    if (name === 'toggle-task') {
      const id = clip(actionParams.id, 40)
      if (id === '') throw new DataError('缺少事务 id')
      const task = data.tasks.find((item) => item.id === id)
      if (task === undefined) throw new DataError('这条事务已不存在，请刷新面板')
      await updateTask(ctx, { id, done: !task.done })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-toggle-task')
      return afterChange(ctx, task.done ? '已恢复为待办' : '已完成')
    }
    if (name === 'update-task') {
      const id = clip(actionParams.id, 40)
      if (id === '') throw new DataError('缺少事务 id')
      const task = data.tasks.find((item) => item.id === id)
      if (task === undefined) throw new DataError('这条事务已不存在，请刷新面板')
      const patch = { id }
      const textValue = formValue(values, `taskText_${id}`, revision)
      if (textValue !== undefined) {
        const text = clip(textValue, 200)
        if (text === '') throw new DataError('事务内容不能为空')
        patch.text = text
      }
      const dueValue = formValue(values, `taskDue_${id}`, revision)
      if (dueValue !== undefined) {
        const due = readDue(dueValue, task.dueDate, task.dueTime, data.taskDate)
        patch.dueDate = due.dueDate
        patch.dueTime = due.dueTime
      }
      const priority = formValue(values, `taskPriority_${id}`, revision)
      if (priority !== undefined) patch.priority = priority
      if (Object.keys(patch).length <= 1) throw new DataError('没有要修改的内容')
      await updateTask(ctx, patch)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-update-task')
      return afterChange(ctx, '事务已更新')
    }
    if (name === 'delete-task') {
      const id = clip(actionParams.id, 40)
      if (id === '') throw new DataError('缺少事务 id')
      const task = data.tasks.find((item) => item.id === id)
      if (task === undefined) throw new DataError('这条事务已不存在，请刷新面板')
      await deleteTask(ctx, { id })
      await saveUi(ctx, { editingTaskId: '' })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-delete-task')
      return afterChange(ctx, '已删除事务')
    }
    if (name === 'add-schedule') {
      const day = formValue(values, 'scheduleDay', revision)
      await addSchedule(ctx, {
        weekday: Number(day === undefined ? 1 : day),
        time: formValue(values, 'scheduleTime', revision),
        title: formValue(values, 'scheduleTitle', revision),
        place: formValue(values, 'schedulePlace', revision),
        weekOffset: offset,
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-add-schedule')
      return afterChange(ctx, '已添加安排')
    }
    if (name === 'update-schedule') {
      const id = clip(actionParams.id, 40)
      if (id === '') throw new DataError('缺少安排 id')
      const entry = data.schedule.find((item) => item.id === id)
      if (entry === undefined) throw new DataError('这条安排已不存在，请刷新面板')
      const patch = { id, weekOffset: offset }
      const title = formValue(values, `scheduleTitle_${id}`, revision)
      if (title !== undefined) patch.title = title
      const time = formValue(values, `scheduleTime_${id}`, revision)
      if (time !== undefined) patch.time = time
      const place = formValue(values, `schedulePlace_${id}`, revision)
      if (place !== undefined) patch.place = place
      const day = formValue(values, `scheduleDay_${id}`, revision)
      if (day !== undefined) patch.weekday = Number(day)
      if (Object.keys(patch).length <= 2) throw new DataError('没有要修改的内容')
      await updateSchedule(ctx, patch)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-update-schedule')
      return afterChange(ctx, '安排已更新')
    }
    if (name === 'delete-schedule') {
      const id = clip(actionParams.id, 40)
      if (id === '') throw new DataError('缺少安排 id')
      const entry = data.schedule.find((item) => item.id === id)
      if (entry === undefined) throw new DataError('这条安排已不存在，请刷新面板')
      await deleteSchedule(ctx, { id, weekOffset: offset })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-delete-schedule')
      return afterChange(ctx, '已删除安排')
    }
    if (name === 'save-duty-week') {
      const picked = formValue(values, 'dutyGroupPick', revision)
      const note = formValue(values, 'dutyNoteText', revision)
      if (picked === undefined && note === undefined) throw new DataError('没有修改')
      await setDutyWeek(ctx, {
        ...(picked === undefined ? {} : picked === '' ? { clear: true } : { groupName: String(picked) }),
        ...(note === undefined ? {} : { note }),
        weekOffset: offset,
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-duty-week')
      return afterChange(ctx, '本周轮换已保存')
    }
    if (name === 'save-duty-groups') {
      const groupsText = formValue(values, 'dutyGroupsText', revision)
      const orderText = formValue(values, 'dutyOrderText', revision)
      const parsed = parseDutyGroupsText(groupsText === undefined ? data.groupsText : groupsText)
      if (parsed.issues.length > 0) throw new DataError(parsed.issues.slice(0, 3).join('；'))
      if (parsed.groups.length === 0) throw new DataError('请至少填写一个值日组')
      const order = parseOrderText(orderText === undefined ? data.orderText : orderText)
      await setDutyGroups(ctx, {
        groups: parsed.groups,
        ...(order.length > 0 ? { order } : {}),
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-duty-groups')
      return afterChange(ctx, '值日分组已保存')
    }
    if (name === 'save-announcement') {
      const typed = formValue(values, 'announcementText', revision)
      const text = typed === undefined ? data.announcement : typed
      await setAnnouncement(ctx, { text, weekOffset: offset })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-announcement')
      return afterChange(ctx, '通知已保存')
    }
    if (name === 'clear-scope') {
      const scope = ['tasks', 'schedule', 'duty', 'all'].includes(values.clearScope)
        ? values.clearScope
        : 'tasks'
      const result = await clearScope(ctx, scope, offset)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-clear-scope')
      const removed = result.removed.tasks + result.removed.schedule + result.removed.duty
      return afterChange(ctx, removed > 0 ? '已清理所选数据' : '所选范围没有数据')
    }
    if (name === 'load-demo') {
      if (offset !== 0) throw new DataError('请先回到本周，再写入示例周')
      await loadDemo(ctx)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-demo')
      return afterChange(ctx, '示例数据已写入')
    }
    if (name === '' || name === 'refresh' || name === 'event') {
      return { schema: buildPanelSchema(data) }
    }
    return { schema: buildPanelSchema(data) }
  } catch (error) {
    ctx.log('warn', '管理台操作失败', { method: name, error: String(error) })
    const schema = await safeRender(ctx)
    return {
      ...(schema === null ? {} : { schema }),
      toast: `没有保存：${messageOf(error)}`,
    }
  }
}

module.exports = {
  PANEL_ID,
  renderPanel,
  handlePanelAction,
  buildPanelSchema,
}
