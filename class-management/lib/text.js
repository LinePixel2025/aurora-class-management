'use strict'

/** 给 Agent 的纯文本输出：信息密度高、带 id、可直接照着调用工具。 */

const { clip } = require('./util')
const { weekdayLabel } = require('./time')

function weekOffsetLabel(offset) {
  if (offset === 0) return '本周'
  if (offset === 1) return '下周'
  if (offset === -1) return '上周'
  return `偏移 ${offset > 0 ? '+' : ''}${offset} 周`
}

function priorityText(task) {
  return task.priority === 'high' ? '高优先级' : task.priority === 'low' ? '低优先级' : '普通'
}

function taskLine(task, weekCtx) {
  const mark = task.done ? '[x]' : '[ ]'
  const parts = [clip(task.text, 120)]
  if (task.dueDate !== '' || task.dueTime !== '') {
    const due = `${task.dueDate === '' ? '' : task.dueDate}${task.dueTime === '' ? '' : ` ${task.dueTime}`}`.trim()
    parts.push(`截止 ${due}`)
  }
  if (task.category !== '') parts.push(task.category)
  parts.push(priorityText(task))
  if (task.assignee !== '') parts.push(`负责人 ${task.assignee}`)
  if (task.done && task.doneAt !== undefined) parts.push('已完成')
  return `${mark} id=${task.id} 日期 ${task.date} ${parts.join('｜')}`
}

function dutyReport(data) {
  const lines = [
    `值日组：${data.duty.groupName}${data.duty.hasOverrideGroup ? '（本周指定）' : '（按周轮换）'}`,
  ]
  if (data.duty.members.length > 0) lines.push(`值日成员：${data.duty.members.join(' ')}`)
  if (data.duty.orderNames.length > 0) lines.push(`轮换顺序：${data.duty.orderNames.join(' → ')}`)
  if (data.duty.note !== '') lines.push(`值日备注：${data.duty.note}`)
  return lines
}

function scheduleReport(data) {
  if (data.schedule.length === 0) return ['（本周没有安排）']
  return data.schedule.map((entry) => {
    const time = entry.time === '' ? '' : ` ${entry.time}`
    const place = entry.place !== '' ? ` @ ${entry.place}` : ''
    const note = entry.note !== '' ? `（${entry.note}）` : ''
    return `- id=${entry.id} ${weekdayLabel(entry.weekday)}${time} ${entry.title}${place}${note}`
  })
}

function overViewText(data, options) {
  const includeDone =
    options !== null && typeof options === 'object' && options.includeDone === false ? false : true
  const lines = []
  const teacher = data.settings.teacher !== '' ? `｜班主任：${data.settings.teacher}` : ''
  lines.push(`班级：${data.settings.className}${teacher}`)
  lines.push(`${data.weekCtx.label}（${weekOffsetLabel(data.weekCtx.offset)}）｜事务日期：${data.taskDateLabel}`)
  lines.push('')
  lines.push(...dutyReport(data))
  lines.push('')
  const taskHeading = data.isToday ? '今日事务' : `${data.taskDateLabel} 事务`
  lines.push(
    `${taskHeading}：待办 ${data.counts.pending} 条 / 完成 ${data.counts.done} 条${
      data.counts.overdue > 0 ? `（已逾期 ${data.counts.overdue} 条）` : ''
    }`,
  )
  const visibleTasks = includeDone ? data.tasks : data.pendingTasks
  if (visibleTasks.length === 0) {
    lines.push(data.isToday ? '（今天没有登记事务）' : '（当天没有登记事务）')
  } else {
    for (const task of visibleTasks.slice(0, 60)) lines.push(taskLine(task, data.weekCtx))
    if (visibleTasks.length > 60) lines.push(`… 还有 ${visibleTasks.length - 60} 条，用 list_tasks 分页查看`)
  }
  lines.push('')
  lines.push('本周安排：')
  lines.push(...scheduleReport(data))
  lines.push('')
  lines.push(`班级通知：${data.announcement === '' ? '（无）' : data.announcement}`)
  return clipContent(lines.join('\n'))
}

function taskListText(data, tasks, total, status) {
  const statusLabel = status === 'pending' ? '待办' : status === 'done' ? '已完成' : '全部'
  const lines = [
    `${data.taskDateLabel}｜${statusLabel}事务：${total} 条（${data.weekCtx.label}，${weekOffsetLabel(
      data.weekCtx.offset,
    )}）`,
  ]
  if (tasks.length === 0) {
    lines.push('（没有匹配的事务）')
  } else {
    for (const task of tasks) lines.push(taskLine(task, data.weekCtx))
    if (total > tasks.length) lines.push(`… 只显示前 ${tasks.length} 条，可加大 limit`)
  }
  return clipContent(lines.join('\n'))
}

function planSummaryText(summary) {
  const parts = [`${summary.weekLabel} 已更新`]
  if (summary.tasksAdded > 0) parts.push(`事务 +${summary.tasksAdded}`)
  if (summary.scheduleAdded > 0) parts.push(`安排 +${summary.scheduleAdded}`)
  if (typeof summary.dutyGroup === 'string' && summary.dutyGroup !== '') {
    parts.push(`值日组 ${summary.dutyGroup}`)
  }
  if (summary.announcement === true) parts.push('通知已更新')
  return parts.join('，')
}

function clipContent(text) {
  return text.length > 18000 ? `${text.slice(0, 18000)}\n…（内容过长已截断）` : text
}

module.exports = {
  weekOffsetLabel,
  priorityText,
  taskLine,
  dutyReport,
  scheduleReport,
  overViewText,
  taskListText,
  planSummaryText,
  clipContent,
}
