'use strict'

/**
 * 2 个桌面浮窗的声明式 schema。
 *
 * 注意：Aurora 0.5.1 的 `PluginSchemaRenderer` 会把 row / grid 的子节点包进一个竖向
 * `.plugin-schema` 容器，因此浮窗按「一列到底」设计，用紧凑条目而不是并排按钮。
 *
 * 浮窗只保留必要动作：今日事务的快速添加与点条目完成/撤销；不再有“打开班级事务台”按钮。
 */

const { clip } = require('./util')
const { weekdayLabel } = require('./time')
const { dueLabel, isOverdue } = require('./ops')

function button(text, action) {
  return { type: 'button', text, action }
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
  if (names.length === 0) return '待设置'
  if (names.length <= 4) return names.join(' ')
  return `${names.slice(0, 4).join(' ')} 等 ${names.length} 人`
}

/** 班级速览 + 本周值日（无按钮）。 */
function overviewWidget(data) {
  const teacher = data.settings.teacher === '' ? '' : ` · 班主任 ${data.settings.teacher}`
  const groupLabel =
    data.duty.members.length === 0 && !data.duty.hasOverrideGroup ? '待设置' : data.duty.groupName
  const members = namesSummary(data.duty.members)
  const summary = `${data.counts.pending} 待办 / ${data.counts.done} 完成`
  const nodes = [
    { type: 'heading', text: data.settings.className },
    { type: 'text', text: `${data.weekCtx.label}${teacher}`, tone: 'muted' },
    {
      type: 'keyValue',
      items: [
        { label: '今日事务', value: summary },
        { label: '本周值日', value: groupLabel === '待设置' ? groupLabel : `${groupLabel} · ${members}` },
        { label: '本周安排', value: `${data.schedule.length} 项` },
      ],
    },
  ]
  if (data.duty.note !== '') {
    nodes.push({ type: 'text', text: `值日备注：${clip(data.duty.note, 40)}`, tone: 'muted' })
  }
  if (data.announcement !== '') {
    nodes.push({ type: 'text', text: `通知：${clip(data.announcement, 72)}` })
  }
  return { version: 1, nodes }
}

/** 今日事务 + 本周安排。 */
function tasksWidget(data) {
  const visible = data.settings.showCompleted ? data.tasks.slice(0, 5) : data.pendingTasks.slice(0, 5)
  const hidden = data.settings.showCompleted
    ? Math.max(0, data.tasks.length - visible.length)
    : Math.max(0, data.pendingTasks.length - visible.length)
  const scheduleItems = data.schedule.slice(0, 4).map((entry) => {
    const time = entry.time === '' ? '' : ` ${entry.time}`
    const place = entry.place === '' ? '' : ` · ${entry.place}`
    return {
      label: `${weekdayLabel(entry.weekday)}${time}${entry.weekday === data.weekCtx.todayWeekday ? ' · 今天' : ''}`,
      value: `${clip(entry.title, 24)}${place}`,
      tone: entry.weekday === data.weekCtx.todayWeekday ? 'ok' : 'default',
    }
  })
  const nodes = [
    {
      type: 'text',
      text: `${data.taskDateLabel} · 待办 ${data.counts.pending} · 完成 ${data.counts.done}${
        data.counts.overdue > 0 ? ` · 逾期 ${data.counts.overdue}` : ''
      }`,
      tone: data.counts.pending === 0 && data.counts.total > 0 ? 'ok' : 'default',
    },
    { type: 'progress', percent: data.completion },
    {
      type: 'input',
      bind: `quickTask_${data.ui.quickRev}`,
      placeholder: '快速加一条今日事务，例如：收物理作业',
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
                ? '今天还没有事务。在上面输入内容点「添加事务」，或让 Agent 帮你加一条。'
                : '今天的事务都完成了。',
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
    ...(hidden > 0
      ? [{ type: 'text', text: `还有 ${hidden} 条，打开班级事务台查看。`, tone: 'muted' }]
      : []),
    { type: 'divider' },
    { type: 'text', text: '本周安排', tone: 'muted' },
    ...(scheduleItems.length > 0
      ? [{ type: 'list', items: scheduleItems }]
      : [{ type: 'text', text: '本周暂无安排。', tone: 'muted' }]),
    ...(data.schedule.length > scheduleItems.length
      ? [
          {
            type: 'text',
            text: `还有 ${data.schedule.length - scheduleItems.length} 项安排。`,
            tone: 'muted',
          },
        ]
      : []),
  ]
  return { version: 1, nodes }
}

function widgetSchema(widgetId, data) {
  if (widgetId === 'week-overview') return overviewWidget(data)
  if (widgetId === 'week-tasks') return tasksWidget(data)
  return null
}

module.exports = {
  widgetSchema,
}
