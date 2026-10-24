'use strict'

/**
 * 右栏「班级事务台」：5 个视图 + 所有按钮动作。
 *
 * 宿主 0.5.1 的 row / grid 实际按列渲染（子节点被包进竖向 `.plugin-schema`），
 * 因此这里全部按单列设计：视图 / 周切换用一个 select + 「切换」按钮，
 * 任务与安排用「列表 + select + 按钮」而不是给每一行并排按钮。
 *
 * 宿主的 params 形状是 `{ params: <动作参数>, values: <输入绑定值> }`。
 */

const { clip } = require('./util')
const { weekdayLabel, normalizeOffset, resolveWeekContext, dateKeyOf } = require('./time')
const { DataError, VIEWS } = require('./state')
const {
  loadWeek,
  saveUi,
  bumpFormRev,
  addTask,
  updateTask,
  clearDone,
  deleteTask,
  setDutyPlan,
  resetDutyPlan,
  setDutyGroups,
  setDutyWeek,
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
  ['board', '看板'],
  ['duty', '值日'],
  ['schedule', '安排'],
  ['notice', '通知'],
  ['settings', '设置'],
]

function button(text, action) {
  return { type: 'button', text, action }
}

function taskTone(task, weekCtx) {
  if (task.done) return 'muted'
  if (isOverdue(task, weekCtx)) return 'error'
  if (task.priority === 'high') return 'warn'
  return 'default'
}

/** 列表右侧的简短元信息：太长会和左侧内容抢空间。 */
function taskListMeta(task, weekCtx) {
  const parts = []
  const due = dueLabel(task, weekCtx)
  if (due !== '') parts.push(isOverdue(task, weekCtx) ? `已逾期 ${due}` : `截止 ${due}`)
  if (task.priority === 'high') parts.push('高优先级')
  return parts.join(' · ')
}

function taskListLabel(task, weekCtx) {
  const mark = task.done ? '✓' : '•'
  return `${mark} ${clip(task.text, 22)}${task.done ? '（已完成）' : ''}`
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
  const nodes = [
    { type: 'heading', text: data.settings.className },
    { type: 'text', text: `${data.weekCtx.label}${teacher}`, tone: 'muted' },
    {
      type: 'select',
      bind: 'viewChoice',
      text: '视图',
      options: VIEW_LABELS.map(([value, label]) => ({ value, label })),
      value: data.ui.view,
    },
    {
      type: 'select',
      bind: 'weekChoice',
      text: '周',
      options: weekOptions(data),
      value: String(data.weekCtx.offset),
    },
    button('应用视图与周', { method: 'apply-nav', toast: '视图与周已更新' }),
    { type: 'text', text: '改完上面两个下拉框后，点「应用视图与周」生效。', tone: 'muted' },
    ...(data.weekCtx.isCurrent
      ? []
      : [{ type: 'text', text: '桌面浮窗始终显示本周；这里可以查看前后周。', tone: 'muted' }]),
    { type: 'divider' },
  ]
  return nodes
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
    text: summary,
    tone: data.counts.pending === 0 && data.counts.total > 0 ? 'ok' : 'default',
  })
  nodes.push({ type: 'progress', percent: data.completion })

  const emptyWeek =
    data.counts.total === 0 &&
    data.schedule.length === 0 &&
    !data.hasDuty &&
    data.announcement === ''
  if (emptyWeek) {
    nodes.push({
      type: 'card',
      title: '开始使用',
      children: [
        {
          type: 'text',
          text: '三步开始：① 在 设置 → 插件 → 班级事务台 填班级名和学期起始日期；② 到「值日」填分组；③ 加事务、安排和通知。',
          tone: 'muted',
        },
        ...(data.weekCtx.offset === 0
          ? [
              button('写入示例周', {
                method: 'load-demo',
                confirm: '把示例值日、事务、安排写入本周？只在当前周为空时可用。',
                toast: '示例数据已写入',
              }),
            ]
          : []),
        button('先填值日分组', { method: 'view', params: { view: 'duty' } }),
        button('添加安排', { method: 'view', params: { view: 'schedule' } }),
      ],
    })
  }

  const groupLabel =
    data.duty.group.members.length === 0 && !data.duty.hasOverrideGroup
      ? '未设置（点「编辑值日」设置）'
      : data.duty.groupName
  nodes.push({
    type: 'card',
    title: data.weekCtx.isCurrent ? '今日值日' : '本周值日',
    children: [
      {
        type: 'keyValue',
        items: [
          { label: '值日组', value: groupLabel },
          { label: data.weekCtx.isCurrent ? '今日' : '当天', value: data.todayDuty === '' ? '无' : data.todayDuty },
          { label: '备注', value: data.duty.note === '' ? '—' : data.duty.note },
        ],
      },
      button('编辑值日', { method: 'view', params: { view: 'duty' } }),
    ],
  })

  const schedulePreview = data.schedule.slice(0, 4)
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
      button('编辑安排', { method: 'view', params: { view: 'schedule' } }),
    ],
  })

  nodes.push({
    type: 'card',
    title: '班级通知',
    children: [
      {
        type: 'text',
        text: data.announcement === '' ? '本周还没有通知。' : `通知：${data.announcement}`,
        tone: data.announcement === '' ? 'muted' : 'default',
      },
      button('编辑通知', { method: 'view', params: { view: 'notice' } }),
    ],
  })

  const visible = data.tasks.slice(0, 20)
  const taskChildren = []
  if (visible.length === 0) {
    taskChildren.push({
      type: 'text',
      text: '本周还没有事务。可以在下方「添加事务」里加一条，或让 Agent 帮你加。',
      tone: 'muted',
    })
  } else {
    taskChildren.push({
      type: 'list',
      items: visible.map((task) => ({
        label: taskListLabel(task, data.weekCtx),
        value: taskListMeta(task, data.weekCtx),
        tone: taskTone(task, data.weekCtx),
      })),
    })
    taskChildren.push({
      type: 'select',
      bind: 'taskPick',
      text: '选择一条事务后操作',
      options: [
        { value: '', label: '选择一条事务…' },
        ...visible.map((task) => ({
          value: task.id,
          label: `${task.done ? '✓ ' : ''}${clip(task.text, 26)}`,
        })),
      ],
      value: '',
    })
    taskChildren.push({
      type: 'input',
      bind: `taskEditText_${data.ui.formRev}`,
      placeholder: '改内容（留空不改）',
    })
    taskChildren.push({
      type: 'input',
      bind: `taskEditDue_${data.ui.formRev}`,
      placeholder: '改截止：2026-10-25 或 2026-10-25 20:00（留空不改）',
    })
    taskChildren.push({
      type: 'select',
      bind: `taskEditPriority_${data.ui.formRev}`,
      text: '改优先级',
      options: [
        { value: '', label: '不修改' },
        { value: 'high', label: '高' },
        { value: 'normal', label: '普通' },
        { value: 'low', label: '低' },
      ],
      value: '',
    })
    taskChildren.push(
      button('保存修改', { method: 'update-task', toast: '事务已更新' }),
      button('切换完成 / 撤销', { method: 'toggle-task', toast: '已更新完成状态' }),
      button('清除所选事务的截止', {
        method: 'clear-task-due',
        confirm: '清除下拉框里选中的这条事务的截止日期和时间？',
        toast: '截止已清除',
      }),
      button('删除所选事务', {
        method: 'delete-task',
        confirm: '删除下拉框里选中的这条事务？删除后无法恢复。',
        toast: '已删除事务',
      }),
    )
  }
  if (data.tasks.length > visible.length) {
    taskChildren.push({
      type: 'text',
      text: `还有 ${data.tasks.length - visible.length} 条，可以让 Agent 帮你查看或分批处理。`,
      tone: 'muted',
    })
  }
  if (data.counts.done > 0) {
    taskChildren.push(
      button('清理已完成', {
        method: 'clear-done',
        confirm: `删除本周 ${data.counts.done} 条已完成事务？删除后无法恢复。`,
        toast: '已清理完成项',
      }),
    )
  }
  nodes.push({ type: 'card', title: `本周事务（${data.counts.total}）`, children: taskChildren })

  nodes.push({
    type: 'card',
    title: '添加事务',
    children: [
      { type: 'input', bind: `taskText_${data.ui.formRev}`, placeholder: '内容：例如收物理作业' },
      {
        type: 'input',
        bind: `taskDue_${data.ui.formRev}`,
        placeholder: `截止：${dateKeyOf(data.weekCtx.sunday)} 20:00（可选，可只写日期）`,
      },
      { type: 'select', bind: `taskPriority_${data.ui.formRev}`, text: '优先级', options: PRIORITY_OPTIONS, value: 'normal' },
      { type: 'select', bind: `taskCategory_${data.ui.formRev}`, text: '分类', options: CATEGORY_OPTIONS, value: '作业' },
      button('添加事务', { method: 'add-task', toast: '已添加事务' }),
    ],
  })
  return { version: 1, nodes }
}

function dutyView(data) {
  const nodes = header(data)
  const groupLabel =
    data.duty.group.members.length === 0 && !data.duty.hasOverrideGroup
      ? '未设置'
      : data.duty.groupName
  nodes.push({
    type: 'keyValue',
    items: [
      { label: '本周值日组', value: groupLabel },
      { label: '轮换方式', value: data.duty.hasOverrideGroup ? '本周指定' : '按周自动轮换' },
      {
        label: '轮换顺序',
        value: data.duty.orderNames.length > 0 ? data.duty.orderNames.join(' → ') : '未设置',
      },
      { label: '值日备注', value: data.duty.note === '' ? '—' : data.duty.note },
    ],
  })
  nodes.push({
    type: 'list',
    items: data.duty.days.map((entry) => ({
      label:
        data.weekCtx.isCurrent && entry.weekday === data.weekCtx.todayWeekday
          ? `${entry.label} · 今天`
          : entry.label,
      value: `${entry.names.length > 0 ? entry.names.join(' ') : '待安排'}${
        entry.area === '' ? '' : ` · ${entry.area}`
      }`,
      tone:
        data.weekCtx.isCurrent && entry.weekday === data.weekCtx.todayWeekday
          ? 'ok'
          : entry.names.length > 0
            ? 'default'
            : 'muted',
    })),
  })

  const editCard = {
    type: 'card',
    title: '按天覆盖（可选）',
    children: [
      {
        type: 'text',
        text: '上面是本周实际值日。这里只填需要覆盖的天，例如「周五: 张三 李四 | 教室」；留空就沿用值日组。',
        tone: 'muted',
      },
      {
        type: 'textarea',
        bind: `dutyPlanText_${data.ui.formRev}`,
        text: '覆盖',
        value: data.dutyOverrideText,
        placeholder: '周五: 张三 李四 | 教室',
      },
      button('保存覆盖', { method: 'save-duty-plan', toast: '值日已保存' }),
      ...(data.hasDutyOverride
        ? [
            button('清除全部覆盖', {
              method: 'reset-duty-plan',
              confirm: '清除本周所有按天覆盖、指定组与备注，恢复自动轮换？',
              toast: '已恢复轮换默认',
            }),
          ]
        : []),
    ],
  }

  const groupsCard = {
    type: 'card',
    title: '值日分组与轮换',
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
      {
        type: 'select',
        bind: `dutyGroupPick_${data.ui.formRev}`,
        text: '本周指定值日组（不改分组时用）',
        options: [
          { value: '', label: '自动轮换' },
          ...data.board.duty.groups.map((group) => ({ value: group.id, label: group.name })),
        ],
        value: data.week.duty.groupId === undefined ? '' : data.week.duty.groupId,
      },
      {
        type: 'input',
        bind: `dutyNoteText_${data.ui.formRev}`,
        text: '本周值日备注',
        value: data.duty.note,
        placeholder: '例如：本周五放学后大扫除',
      },
      button('保存本周轮换', { method: 'save-duty-week', toast: '本周轮换已保存' }),
    ],
  }

  const groupsEmpty = data.duty.group.members.length === 0 && !data.duty.hasOverrideGroup
  nodes.push(...(groupsEmpty ? [groupsCard, editCard] : [editCard, groupsCard]))
  return { version: 1, nodes }
}

function scheduleView(data) {
  const nodes = header(data)
  nodes.push({
    type: 'card',
    title: '添加安排',
    children: [
      {
        type: 'select',
        bind: `scheduleDay_${data.ui.formRev}`,
        text: '周几',
        options: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ value: String(day), label: weekdayLabel(day) })),
        value: '1',
      },
      { type: 'input', bind: `scheduleTime_${data.ui.formRev}`, text: '时间（可选）', placeholder: '16:00' },
      { type: 'input', bind: `scheduleTitle_${data.ui.formRev}`, text: '事项', placeholder: '例如：班会' },
      { type: 'input', bind: `schedulePlace_${data.ui.formRev}`, text: '地点（可选）', placeholder: '例如：教室' },
      button('添加安排', { method: 'add-schedule', toast: '已添加安排' }),
    ],
  })

  const visible = data.schedule.slice(0, 20)
  const children = []
  if (visible.length === 0) {
    children.push({ type: 'text', text: '本周还没有安排。', tone: 'muted' })
  } else {
    children.push({
      type: 'list',
      items: visible.map((entry) => ({
        label: `${weekdayLabel(entry.weekday)}${entry.time === '' ? '' : ` ${entry.time}`}${
          data.weekCtx.isCurrent && entry.weekday === data.weekCtx.todayWeekday ? ' · 今天' : ''
        }`,
        value: `${clip(entry.title, 22)}${entry.place === '' ? '' : ` · ${entry.place}`}`,
        tone: entry.weekday === data.weekCtx.todayWeekday && data.weekCtx.isCurrent ? 'ok' : 'default',
      })),
    })
    children.push({
      type: 'select',
      bind: 'schedulePick',
      text: '选择一条安排后操作',
      options: [
        { value: '', label: '选择一条安排…' },
        ...visible.map((entry) => ({
          value: entry.id,
          label: `${weekdayLabel(entry.weekday)} ${clip(entry.title, 22)}`,
        })),
      ],
      value: '',
    })
    children.push({
      type: 'input',
      bind: `scheduleEditTitle_${data.ui.formRev}`,
      placeholder: '改事项（留空不改）',
    })
    children.push({
      type: 'input',
      bind: `scheduleEditTime_${data.ui.formRev}`,
      placeholder: '改时间：16:00（留空不改）',
    })
    children.push({
      type: 'input',
      bind: `scheduleEditPlace_${data.ui.formRev}`,
      placeholder: '改地点（留空不改）',
    })
    children.push(
      button('保存修改', { method: 'update-schedule', toast: '安排已更新' }),
      button('删除所选安排', {
        method: 'delete-schedule',
        confirm: '删除下拉框里选中的这条安排？删除后无法恢复。',
        toast: '已删除安排',
      }),
    )
  }
  if (data.schedule.length > visible.length) {
    children.push({
      type: 'text',
      text: `还有 ${data.schedule.length - visible.length} 项，可以让 Agent 帮你查看或分批处理。`,
      tone: 'muted',
    })
  }
  nodes.push({ type: 'card', title: `本周安排（${data.schedule.length}）`, children })
  return { version: 1, nodes }
}

function noticeView(data) {
  const nodes = header(data)
  nodes.push({
    type: 'card',
    title: '本周通知',
    children: [
      {
        type: 'textarea',
                bind: `announcementText_${data.ui.formRev}`,
        text: '通知内容',
        value: data.announcement,
        placeholder: '最多 600 字，例如：本周五下午大扫除，请带好清洁工具。',
      },
      button('保存通知', { method: 'save-announcement', toast: '通知已保存' }),
      ...(data.announcement === ''
        ? []
        : [
            button('清空通知', {
              method: 'clear-announcement',
              confirm: '清空本周通知？清空后无法恢复。',
              toast: '通知已清空',
            }),
          ]),
      {
        type: 'text',
        text: '最多 600 字；通知会显示在「班级速览」浮窗和看板里。',
        tone: 'muted',
      },
    ],
  })
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
  nodes.push({
    type: 'card',
    title: '数据',
    children: [
      {
        type: 'keyValue',
        items: [
          { label: '已保存周数', value: String(data.stats.weeks) },
          { label: '事务总数', value: `${data.stats.tasks}（完成 ${data.stats.done}）` },
          { label: '安排总数', value: String(data.stats.schedule) },
          { label: '占用空间', value: `${Math.ceil(data.stats.bytes / 1024)} KB（上限 240 KB）` },
        ],
      },
      ...(data.counts.total === 0 &&
      data.schedule.length === 0 &&
      !data.hasDuty &&
      data.announcement === ''
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
          { value: 'tasks', label: '本周事务' },
          { value: 'schedule', label: '本周安排' },
          { value: 'duty', label: '值日覆盖' },
          { value: 'all', label: '整周数据（含通知）' },
        ],
        value: 'tasks',
      },
      button('删除所选范围的数据', {
        method: 'clear-scope',
        confirm: '删除所选范围的数据？删除后无法恢复。',
        toast: '已清理',
      }),
    ],
  })
  nodes.push({
    type: 'card',
    title: '给 Agent 用（可选）',
    children: [
      { type: 'text', text: '• /class 打开管理台；/week-plan 让 Agent 总结本周。', tone: 'muted' },
      {
        type: 'text',
        text: '• 也可以直接对 Agent 说：「把下周三的值日改成张三」「加一条周五交物理作业」。',
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
  if (data.ui.view === 'notice') return noticeView(data)
  if (data.ui.view === 'settings') return settingsView(data)
  return boardView(data)
}

async function renderPanel(ctx) {
  const data = await loadWeek(ctx)
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

function readDue(value, fallbackDate, fallbackTime) {
  if (value === undefined) {
    return { dueDate: fallbackDate, dueTime: fallbackTime }
  }
  const raw = clip(value, 40)
  if (raw === '') return { dueDate: '', dueTime: '' }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/.exec(raw)
  if (match === null) {
    throw new DataError('截止时间没看懂：写成「2026-10-30」或「2026-10-30 20:00」')
  }
  return { dueDate: match[1], dueTime: match[2] === undefined ? '' : match[2] }
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
      const view = values.viewChoice === undefined ? undefined : String(values.viewChoice)
      if (view !== undefined && !VIEWS.includes(view)) throw new DataError('未知视图')
      let weekOffset
      if (values.weekChoice !== undefined && values.weekChoice !== '') {
        const parsed = Number(values.weekChoice)
        if (!Number.isFinite(parsed)) throw new DataError('周选择无效')
        weekOffset = normalizeOffset(parsed)
      }
      await saveUi(ctx, {
        ...(view === undefined ? {} : { view }),
        ...(weekOffset === undefined ? {} : { weekOffset }),
      })
      return { schema: await renderPanel(ctx), toast: '已切换' }
    }
    if (name === 'view') {
      const view = String(actionParams.view === undefined ? '' : actionParams.view)
      if (!VIEWS.includes(view)) throw new DataError('未知视图')
      await saveUi(ctx, { view })
      return { schema: await renderPanel(ctx) }
    }
    if (name === 'nav') {
      const delta = Number(actionParams.delta)
      if (!Number.isFinite(delta)) throw new DataError('切换周失败：delta 必须是数字')
      const data = await loadWeek(ctx)
      const next = delta === 0 ? 0 : normalizeOffset(data.weekCtx.offset + Math.trunc(delta))
      await saveUi(ctx, { weekOffset: next })
      return { schema: await renderPanel(ctx) }
    }

    const data = await loadWeek(ctx)
    const offset = data.weekCtx.offset
    const revision = data.ui.formRev

    if (name === 'add-task') {
      const due = readDue(formValue(values, 'taskDue', revision), values.taskDueDate, values.taskDueTime)
      const priority = formValue(values, 'taskPriority', revision)
      const category = formValue(values, 'taskCategory', revision)
      await addTask(ctx, {
        text: formValue(values, 'taskText', revision),
        priority: priority === undefined ? 'normal' : priority,
        category: category === undefined ? '作业' : category,
        dueDate: due.dueDate,
        dueTime: due.dueTime,
        assignee: formValue(values, 'taskAssignee', revision),
        weekOffset: offset,
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-add-task')
      return afterChange(ctx, '已添加事务')
    }
    if (name === 'toggle-task') {
      const id = clip(actionParams.id === undefined ? values.taskPick : actionParams.id, 40)
      if (id === '') throw new DataError('请先在「选择事务」里选一条')
      const task = data.tasks.find((item) => item.id === id)
      if (task === undefined) throw new DataError('这条事务已不存在，请刷新面板')
      await updateTask(ctx, { id, done: !task.done, weekOffset: offset })
      await pushWidgets(ctx, 'panel-toggle-task')
      return afterChange(ctx, task.done ? '已恢复为待办' : '已完成')
    }
    if (name === 'update-task') {
      const id = clip(values.taskPick === undefined ? actionParams.id : values.taskPick, 40)
      if (id === '') throw new DataError('请先在「选择一条事务后操作」里选一条')
      const patch = { id, weekOffset: offset }
      const text = formValue(values, 'taskEditText', revision)
      if (text !== undefined && clip(text, 200) !== '') patch.text = text
      const dueRaw = formValue(values, 'taskEditDue', revision)
      if (dueRaw !== undefined && clip(dueRaw, 40) !== '') {
        const due = readDue(dueRaw)
        patch.dueDate = due.dueDate
        patch.dueTime = due.dueTime
      }
      const priority = formValue(values, 'taskEditPriority', revision)
      if (priority !== undefined && priority !== '') patch.priority = priority
      if (Object.keys(patch).length <= 2) throw new DataError('没有要修改的内容')
      await updateTask(ctx, patch)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-update-task')
      return afterChange(ctx, '事务已更新')
    }
    if (name === 'clear-task-due') {
      const id = clip(values.taskPick === undefined ? actionParams.id : values.taskPick, 40)
      if (id === '') throw new DataError('请先在下拉框里选一条事务')
      await updateTask(ctx, { id, dueDate: '', dueTime: '', weekOffset: offset })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-clear-task-due')
      return afterChange(ctx, '截止已清除')
    }
    if (name === 'delete-task') {
      const id = clip(actionParams.id === undefined ? values.taskPick : actionParams.id, 40)
      if (id === '') throw new DataError('请先在「选择一条事务后操作」里选一条')
      await deleteTask(ctx, { id, weekOffset: offset })
      await pushWidgets(ctx, 'panel-delete-task')
      return afterChange(ctx, '已删除事务')
    }
    if (name === 'clear-done') {
      const result = await clearDone(ctx, offset)
      await pushWidgets(ctx, 'panel-clear-done')
      return afterChange(ctx, result.removed > 0 ? `已清理 ${result.removed} 条已完成事务` : '没有可清理的事务')
    }
    if (name === 'save-duty-plan') {
      const text = formValue(values, 'dutyPlanText', revision)
      // 没有编辑时回退到「当前覆盖文本」，绝不能回退到含整周轮换的 dutyPlanText
      await setDutyPlan(ctx, text === undefined ? data.dutyOverrideText : text, offset)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-duty-plan')
      return afterChange(ctx, '值日已保存')
    }
    if (name === 'reset-duty-plan') {
      await resetDutyPlan(ctx, offset)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-reset-duty')
      return afterChange(ctx, '已恢复轮换默认')
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
    if (name === 'save-duty-week') {
      const picked = formValue(values, 'dutyGroupPick', revision)
      const note = formValue(values, 'dutyNoteText', revision)
      if (picked === undefined && note === undefined) throw new DataError('没有修改')
      const groupName = picked === undefined ? undefined : String(picked)
      await setDutyWeek(ctx, {
        ...(groupName === undefined ? {} : groupName === '' ? { clear: true } : { groupName }),
        ...(note === undefined ? {} : { note }),
        weekOffset: offset,
      })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-duty-week')
      return afterChange(ctx, '本周轮换已保存')
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
      const id = clip(values.schedulePick === undefined ? actionParams.id : values.schedulePick, 40)
      if (id === '') throw new DataError('请先在「选择一条安排后操作」里选一条')
      const patch = { id, weekOffset: offset }
      const title = formValue(values, 'scheduleEditTitle', revision)
      if (title !== undefined && clip(title, 60) !== '') patch.title = title
      const time = formValue(values, 'scheduleEditTime', revision)
      if (time !== undefined && clip(time, 8) !== '') patch.time = time
      const place = formValue(values, 'scheduleEditPlace', revision)
      if (place !== undefined && clip(place, 40) !== '') patch.place = place
      if (Object.keys(patch).length <= 2) throw new DataError('没有要修改的内容')
      await updateSchedule(ctx, patch)
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-update-schedule')
      return afterChange(ctx, '安排已更新')
    }
    if (name === 'delete-schedule') {
      const id = clip(actionParams.id === undefined ? values.schedulePick : actionParams.id, 40)
      if (id === '') throw new DataError('请先在「选择安排」里选一条')
      await deleteSchedule(ctx, { id, weekOffset: offset })
      await pushWidgets(ctx, 'panel-delete-schedule')
      return afterChange(ctx, '已删除安排')
    }
    if (name === 'save-announcement' || name === 'clear-announcement') {
      const typed = formValue(values, 'announcementText', revision)
      const text =
        name === 'clear-announcement' ? '' : typed === undefined ? data.announcement : typed
      await setAnnouncement(ctx, { text, weekOffset: offset })
      await bumpFormRev(ctx)
      await pushWidgets(ctx, 'panel-announcement')
      return afterChange(ctx, name === 'clear-announcement' ? '通知已清空' : '通知已保存')
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
