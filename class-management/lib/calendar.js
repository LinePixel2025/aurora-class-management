'use strict'

/**
 * 页面型「班级周历」面板处理器。
 *
 * 宿主的页面 request(method, params) 会把 params 原样作为 invokePanel 的第 3 个参数，
 * 因此这里直接读取 params 字段，不再套声明式面板的 { params, values } 形状。
 * 业务规则全部复用 lib/ops.js；动作成功后统一重新读取整周数据，保证页面拿到最新状态。
 */

const { DataError } = require('./state')
const ops = require('./ops')

const CALENDAR_PANEL_ID = 'calendar'

/** 读取页面所需的整周数据。 */
async function calendarData(ctx, weekOffset) {
  return ops.loadWeekGrid(ctx, weekOffset)
}

/** 在整周数据里按 id 查找事务（toggle-task 需要先知道当前完成状态）。 */
function findTask(data, id) {
  const days = Array.isArray(data.days) ? data.days : []
  for (const day of days) {
    const tasks = day !== null && typeof day === 'object' && Array.isArray(day.tasks) ? day.tasks : []
    const task = tasks.find((item) => item.id === id)
    if (task !== undefined) return task
  }
  return null
}

/** 重新读取最新整周数据并附带结果；读取失败时只返回 error。 */
async function respond(ctx, weekOffset, extra, fallback) {
  try {
    return { data: await calendarData(ctx, weekOffset), ...extra }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { error: text === '' ? fallback : text }
  }
}

/** 执行页面动作；返回成功提示，load 与未知方法返回空字符串。 */
async function runAction(name, p, ctx, weekOffset) {
  if (name === 'add-task') {
    await ops.addTask(ctx, p)
    return '已添加事务'
  }
  if (name === 'update-task') {
    await ops.updateTask(ctx, p)
    return '已保存事务'
  }
  if (name === 'toggle-task') {
    const data = await calendarData(ctx, weekOffset)
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') throw new DataError('缺少事务 id')
    const task = findTask(data, id)
    if (task === null) throw new DataError('这条事务已不存在')
    await ops.updateTask(ctx, { id: task.id, done: !task.done })
    return task.done ? '已恢复为待办' : '已完成'
  }
  if (name === 'delete-task') {
    await ops.deleteTask(ctx, p)
    return '已删除事务'
  }
  if (name === 'move-task') {
    await ops.moveTask(ctx, p)
    return '已移动事务'
  }
  if (name === 'add-schedule') {
    await ops.addSchedule(ctx, p)
    return '已添加安排'
  }
  if (name === 'update-schedule') {
    await ops.updateSchedule(ctx, p)
    return '已保存安排'
  }
  if (name === 'delete-schedule') {
    await ops.deleteSchedule(ctx, p)
    return '已删除安排'
  }
  if (name === 'set-duty-week') {
    await ops.setDutyWeek(ctx, p)
    return '已保存值日'
  }
  if (name === 'save-announcement') {
    await ops.setAnnouncement(ctx, p)
    return '已保存通知'
  }
  return ''
}

async function handleCalendarPanel(panelId, method, params, ctx) {
  const p = params !== null && typeof params === 'object' ? params : {}
  const name = typeof method === 'string' ? method : ''

  let weekOffset = 0
  try {
    weekOffset = ops.readWeekOffset(p.weekOffset, 0)
  } catch (error) {
    // 非法 weekOffset 不执行任何写操作：回落到本周，并把原因交给页面展示。
    if (!(error instanceof DataError)) {
      ctx.log('error', '班级周历操作失败', { method: name, error: String(error) })
    }
    const text =
      error instanceof Error && error.message !== '' ? error.message : '操作失败，请重试'
    return respond(ctx, 0, { error: text }, text)
  }

  let message = ''
  try {
    message = await runAction(name, p, ctx, weekOffset)
  } catch (error) {
    if (error instanceof DataError) {
      return respond(ctx, weekOffset, { error: error.message }, error.message)
    }
    ctx.log('error', '班级周历操作失败', { method: name, error: String(error) })
    return respond(ctx, weekOffset, { error: '操作失败，请重试' }, '操作失败，请重试')
  }

  return respond(ctx, weekOffset, message === '' ? {} : { message }, '操作失败，请重试')
}

module.exports = {
  CALENDAR_PANEL_ID,
  calendarData,
  handleCalendarPanel,
}
