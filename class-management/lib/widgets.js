'use strict'

/**
 * 4 个桌面浮窗的声明式 schema。
 *
 * 注意：Aurora 0.5.1 的 `PluginSchemaRenderer` 会把 row / grid 的子节点包进一个竖向
 * `.plugin-schema` 容器，因此 `row` / `grid` 在这版宿主里**不会真的横向排列**。
 * 浮窗按「一列到底」设计，用紧凑条目而不是并排按钮。
 */

const { clip } = require('./util')
const { weekdayLabel } = require('./time')
const { dueLabel, isOverdue } = require('./ops')

function button(text, action) {
  return { type: 'button', text, action }
}

function openButton(view, label) {
  return button(label === undefined ? '打开班级事务台' : label, {
    method: 'open-panel',
    params: { view },
  })
}

function taskButtonText(task, weekCtx) {
  const meta = []
  const due = dueLabel(task, weekCtx)
  if (due !== '') meta.push(isOverdue(task, weekCtx) ? `已逾期 ${due}` : due)
  if (task.priority === 'high') meta.push('高')
  const prefix = task.done ? '✓ ' : '○ '
  const suffix = task.done ? '（已完成）' : ''
  return `${prefix}${clip(task.text, 22)}${suffix}${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`
}

function namesSummary(names) {
  if (names.length === 0) return '待安排'
  if (names.length <= 3) return names.join(' ')
  return `${names.slice(0, 3).join(' ')} 等 ${names.length} 人`
}

function dutyWidget(data) {
  const today = data.weekCtx.todayWeekday
  const hasNames = data.duty.days.some(
    (entry) => entry.names.length > 0 || entry.area !== '' || entry.note !== '',
  )
  const groupLabel =
    data.duty.group.members.length === 0 && !data.duty.hasOverrideGroup
      ? '未设置'
      : data.duty.groupName
  const items = data.duty.days.map((entry) => {
    const isToday = entry.weekday === today
    const area = entry.area !== '' ? ` · ${entry.area}` : ''
    return {
      label: isToday ? `${entry.label} · 今天` : entry.label,
      value: `${namesSummary(entry.names)}${area}`,
      tone: isToday ? (entry.names.length > 0 ? 'ok' : 'warn') : entry.names.length > 0 ? 'default' : 'muted',
    }
  })
  const nodes = [
    { type: 'text', text: data.weekCtx.label, tone: 'muted' },
    { type: 'text', text: `值日组：${groupLabel}`, tone: groupLabel === '未设置' ? 'muted' : 'default' },
    ...(hasNames
      ? [{ type: 'list', items }]
      : [
          {
            type: 'text',
            text: '本周还没有值日名单。点「编辑值日」填写分组和成员，或让 Agent 帮你设置。',
            tone: 'muted',
          },
        ]),
    { type: 'divider' },
    openButton('duty', '编辑值日'),
    openButton('board'),
  ]
  return { version: 1, nodes }
}

function tasksWidget(data) {
  const visible = data.settings.showCompleted ? data.tasks.slice(0, 5) : data.pendingTasks.slice(0, 5)
  const hidden = data.settings.showCompleted
    ? Math.max(0, data.tasks.length - visible.length)
    : Math.max(0, data.pendingTasks.length - visible.length)
  const nodes = [
    {
      type: 'text',
      text: `待办 ${data.counts.pending} · 完成 ${data.counts.done}${data.counts.overdue > 0 ? ` · 逾期 ${data.counts.overdue}` : ''}`,
      tone: data.counts.pending === 0 && data.counts.total > 0 ? 'ok' : 'default',
    },
    { type: 'progress', percent: data.completion },
    {
      type: 'input',
      bind: `quickTask_${data.ui.quickRev}`,
      placeholder: '快速加一条事务，例如：收物理作业',
    },
    button('＋ 添加事务', { method: 'quick-add', toast: '已添加事务' }),
    ...visible.map((task) =>
      button(taskButtonText(task, data.weekCtx), {
        method: 'toggle-task',
        params: { id: task.id },
        toast: task.done ? '已恢复为待办' : '已完成',
      }),
    ),
    ...(visible.length === 0
      ? [
          {
            type: 'text',
            text:
              data.counts.total === 0
                ? '本周还没有事务。在上面输入内容点「添加事务」，或让 Agent 帮你加一条。'
                : '本周事务都完成了。',
            tone: 'muted',
          },
        ]
      : [
          {
            type: 'text',
            text:
              data.settings.showCompleted && data.counts.done > 0
                ? '点未完成项标记完成，点已完成项恢复为待办。'
                : '点一下事务即可标记完成。',
            tone: 'muted',
          },
        ]),
    ...(hidden > 0 ? [{ type: 'text', text: `还有 ${hidden} 条，打开班级事务台查看。`, tone: 'muted' }] : []),
    { type: 'divider' },
    openButton('board'),
  ]
  return { version: 1, nodes }
}

function scheduleWidget(data) {
  const today = data.weekCtx.todayWeekday
  const visible = data.schedule.slice(0, 4)
  const items = visible.map((entry) => {
    const time = entry.time === '' ? '' : ` ${entry.time}`
    const place = entry.place === '' ? '' : ` · ${entry.place}`
    return {
      label: `${weekdayLabel(entry.weekday)}${time}${entry.weekday === today ? ' · 今天' : ''}`,
      value: `${clip(entry.title, 24)}${place}`,
      tone: entry.weekday === today ? 'ok' : 'default',
    }
  })
  if (items.length === 0) items.push({ label: '本周', value: '还没有安排', tone: 'muted' })
  return {
    version: 1,
    nodes: [
      { type: 'text', text: data.weekCtx.label, tone: 'muted' },
      { type: 'list', items },
      ...(data.schedule.length > visible.length
        ? [{ type: 'text', text: `还有 ${data.schedule.length - visible.length} 项，打开班级事务台查看。`, tone: 'muted' }]
        : []),
      ...(data.schedule.length === 0
        ? [{ type: 'text', text: '点「编辑安排」添加班会、活动或考试。', tone: 'muted' }]
        : []),
      { type: 'divider' },
      openButton('schedule', '编辑安排'),
      openButton('board'),
    ],
  }
}

function overviewWidget(data) {
  const teacher = data.settings.teacher === '' ? '班主任未设置' : `班主任 ${data.settings.teacher}`
  const nodes = [
    { type: 'heading', text: data.settings.className },
    { type: 'text', text: `${data.weekCtx.label} · ${teacher}`, tone: 'muted' },
    { type: 'progress', percent: data.completion },
    {
      type: 'keyValue',
      items: [
        { label: '本周事务', value: `${data.counts.pending} 待办 / ${data.counts.done} 完成` },
        { label: '值日组', value: data.duty.groupName },
        { label: '今日值日', value: data.todayDuty === '' ? '无' : data.todayDuty },
        { label: '本周安排', value: `${data.schedule.length} 项` },
      ],
    },
    {
      type: 'text',
      text: data.announcement === '' ? '本周暂无通知。' : `通知：${clip(data.announcement, 76)}`,
      tone: data.announcement === '' ? 'muted' : 'default',
    },
    openButton('board'),
  ]
  return { version: 1, nodes }
}

function widgetSchema(widgetId, data) {
  if (widgetId === 'duty-week') return dutyWidget(data)
  if (widgetId === 'week-tasks') return tasksWidget(data)
  if (widgetId === 'week-schedule') return scheduleWidget(data)
  if (widgetId === 'week-overview') return overviewWidget(data)
  return null
}

module.exports = {
  widgetSchema,
}
