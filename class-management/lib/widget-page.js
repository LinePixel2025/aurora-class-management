'use strict'

/**
 * 页面型桌面小组件（week-overview / week-tasks）后端处理器。
 *
 * 页面 request(method, params) 的 params 是直接对象；数据统一来自 `ops.loadWeek(ctx, 0)`
 * （今天的视图），写动作复用 lib/ops.js 并在成功后 `pushAll`（2 面板 + 2 小组件）。
 * 两个小组件返回同一份 `WidgetData` 形状（见 dev/page-api.md §7.1）。
 */

const { DataError } = require('./state')
const { clip } = require('./util')
const { todayKey, dateLabel, shortDate } = require('./time')
const ops = require('./ops')
const { pushAll } = require('./push')
const { asParams, messageOf, readOrNull } = require('./page-core')

const WIDGET_IDS = ['week-overview', 'week-tasks']

function weekRangeLabel(weekCtx) {
  if (weekCtx === null || weekCtx === undefined) return ''
  if (!(weekCtx.monday instanceof Date) || !(weekCtx.sunday instanceof Date)) return ''
  return `${shortDate(weekCtx.monday)}–${shortDate(weekCtx.sunday)}`
}

function shapeWidgetData(data, widgetId) {
  const weekCtx = data.weekCtx
  const today = todayKey()
  return {
    widgetId,
    className: data.settings.className,
    teacher: data.settings.teacher,
    weekLabel: weekCtx.label,
    weekRange: weekRangeLabel(weekCtx),
    weekNumber: weekCtx.weekNumber,
    today,
    todayLabel: dateLabel(today),
    taskDateLabel: data.taskDateLabel,
    todayWeekday: weekCtx.todayWeekday,
    counts: data.counts,
    completion: data.completion,
    tasks: data.tasks.map((task) => ops.taskSummary(task, data.weekCtx)),
    schedule: data.schedule,
    scheduleCount: data.schedule.length,
    duty: {
      groupName: data.duty.groupName,
      members: data.duty.members,
      note: data.duty.note,
    },
    announcement: data.announcement,
    showCompleted: data.settings.showCompleted,
  }
}

async function widgetData(ctx, widgetId) {
  const data = await ops.loadWeek(ctx, 0)
  return shapeWidgetData(data, widgetId)
}

async function handleWidgetPage(widgetId, method, params, ctx) {
  if (!WIDGET_IDS.includes(widgetId)) return {}
  const p = asParams(params)
  const name = typeof method === 'string' ? method : ''

  const readData = () => widgetData(ctx, widgetId)

  if (name === '' || name === 'load' || name === 'refresh' || name === 'event') {
    return { data: await readData() }
  }

  try {
    if (name === 'add-task') {
      const text = clip(p.text, 200)
      if (text === '') throw new DataError('请先输入事务内容')
      await ops.addTask(ctx, { text, date: todayKey() })
      await pushAll(ctx, 'widget-add-task')
      return { data: await readData(), message: '已添加事务' }
    }
    if (name === 'toggle-task') {
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      if (id === '') throw new DataError('缺少事务 id')
      const data = await ops.loadWeek(ctx, 0)
      const task = data.tasks.find((item) => item.id === id)
      if (task === undefined) throw new DataError('这条事务已不存在，请刷新后重试')
      const done = typeof p.done === 'boolean' ? p.done : !task.done
      await ops.updateTask(ctx, { id, done })
      await pushAll(ctx, 'widget-toggle-task')
      return { data: await readData(), message: done ? '已完成' : '已恢复为待办' }
    }
    if (name === 'delete-task') {
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      if (id === '') throw new DataError('缺少事务 id')
      const data = await ops.loadWeek(ctx, 0)
      if (!data.tasks.some((item) => item.id === id)) {
        throw new DataError('这条事务已不存在，请刷新后重试')
      }
      await ops.deleteTask(ctx, { id })
      await pushAll(ctx, 'widget-delete-task')
      return { data: await readData(), message: '已删除事务' }
    }
    // 未知方法按刷新处理，不写数据也不推送。
    return { data: await readData() }
  } catch (error) {
    const data = await readOrNull(readData)
    if (error instanceof DataError) {
      return { ...(data === null ? {} : { data }), error: error.message }
    }
    ctx.log('warn', '桌面小组件页面操作失败', { widgetId, method: name, error: String(error) })
    return { ...(data === null ? {} : { data }), error: messageOf(error, '操作失败，请重试') }
  }
}

module.exports = {
  WIDGET_IDS,
  widgetData,
  handleWidgetPage,
}
