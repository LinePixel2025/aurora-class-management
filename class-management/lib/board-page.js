'use strict'

/**
 * 页面型「班级事务台」（panelId = board）后端处理器。
 *
 * 与 `lib/calendar.js` 同形：页面 request(method, params) 的 params 直接是对象；
 * 业务规则全部复用 `lib/ops.js`；写动作成功后统一 `pushAll`（2 面板 + 2 小组件）。
 *
 * 视图（ui.v1.view）：`board`（今日）/ `duty`（值日）/ `schedule`（安排）/ `settings`（设置）。
 */

const { DataError, readBoard } = require('./state')
const { clip } = require('./util')
const { todayKey, dateLabel, shortDate } = require('./time')
const ops = require('./ops')
const { pushAll } = require('./push')
const { asParams, messageOf, readOrNull } = require('./page-core')

const BOARD_PANEL_ID = 'board'
const VIEWS = ['board', 'duty', 'schedule', 'settings']

/** 会修改数据的动作；过去周（weekOffset < 0）一律拒绝。 */
const WRITE_METHODS = new Set([
  'add-task',
  'update-task',
  'toggle-task',
  'delete-task',
  'add-schedule',
  'update-schedule',
  'delete-schedule',
  'set-duty-week',
  'save-duty-groups',
  'save-announcement',
  'clear-scope',
  'load-demo',
])

function isValidView(value) {
  return VIEWS.includes(String(value))
}

function defaultOffsetForView(view, ui) {
  if (view === 'board' || view === 'settings') return 0
  return ops.readWeekOffset(ui.weekOffset, 0)
}

function readOffset(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return ops.readWeekOffset(value, fallback)
}

function weekRangeLabel(weekCtx) {
  if (weekCtx === null || weekCtx === undefined) return ''
  if (!(weekCtx.monday instanceof Date) || !(weekCtx.sunday instanceof Date)) return ''
  return `${shortDate(weekCtx.monday)}–${shortDate(weekCtx.sunday)}`
}

function weekIsEmpty(data) {
  const week = data.week !== null && typeof data.week === 'object' ? data.week : {}
  const tasks = Array.isArray(week.tasks) ? week.tasks.length : 0
  const schedule = Array.isArray(week.schedule) ? week.schedule.length : 0
  const duty = week.duty !== null && typeof week.duty === 'object' ? week.duty : {}
  return (
    tasks === 0 &&
    schedule === 0 &&
    (week.announcement === undefined || week.announcement === '') &&
    duty.groupId === undefined &&
    duty.note === undefined
  )
}

/** 把 `loadWeek` 的结果整理成页面直接可用的数据。 */
function shapeBoardData(data, view) {
  const weekCtx = data.weekCtx
  const duty = data.duty
  const week = data.week !== null && typeof data.week === 'object' ? data.week : {}
  const weekDuty = week.duty !== null && typeof week.duty === 'object' ? week.duty : {}
  return {
    view,
    weekOffset: weekCtx.offset,
    isCurrentWeek: weekCtx.isCurrent === true,
    isPastWeek: weekCtx.offset < 0,
    canEdit: weekCtx.offset >= 0,
    weekLabel: weekCtx.label,
    weekNumber: weekCtx.weekNumber,
    weekRange: weekRangeLabel(weekCtx),
    today: data.today,
    taskDate: data.taskDate,
    taskDateLabel: data.taskDateLabel,
    settings: {
      className: data.settings.className,
      teacher: data.settings.teacher,
      termStartDate: data.settings.termStartDate,
    },
    counts: data.counts,
    completion: data.completion,
    tasks: data.tasks.map((task) => ops.taskSummary(task, weekCtx)),
    schedule: data.schedule,
    announcement: data.announcement,
    duty: {
      groupName: duty.groupName,
      members: duty.members,
      note: duty.note,
      hasOverrideGroup: duty.hasOverrideGroup,
      orderNames: duty.orderNames,
    },
    dutyGroupId: typeof weekDuty.groupId === 'string' ? weekDuty.groupId : '',
    groups: data.board.duty.groups,
    groupsText: data.groupsText,
    orderText: data.orderText,
    rotationPreview: data.rotationPreview,
    stats: data.stats,
    boardEmpty: weekIsEmpty(data),
  }
}

/** 读取事务（跨周查找），toggle-task 需要知道当前完成状态。 */
async function findAnyTask(ctx, id) {
  const board = await readBoard(ctx)
  const found = ops.findTaskById(board, id)
  return found === null ? null : found.task
}

/** 执行一个写动作，返回成功提示。 */
async function applyBoardAction(name, p, ctx, offsetNow) {
  if (name === 'add-task') {
    const text = clip(p.text, 200)
    if (text === '') throw new DataError('请先输入事务内容')
    await ops.addTask(ctx, {
      text,
      date: todayKey(),
      dueDate: p.dueDate,
      dueTime: p.dueTime,
      priority: p.priority,
      category: p.category,
      assignee: p.assignee,
    })
    return '已添加事务'
  }
  if (name === 'update-task') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') throw new DataError('缺少事务 id')
    const task = await findAnyTask(ctx, id)
    if (task === null) throw new DataError('这条事务已不存在，请刷新后重试')
    const patch = { id }
    for (const key of ['text', 'dueDate', 'dueTime', 'priority', 'category', 'assignee', 'done']) {
      if (p[key] !== undefined) patch[key] = p[key]
    }
    if (Object.keys(patch).length <= 1) throw new DataError('没有要修改的内容')
    await ops.updateTask(ctx, patch)
    return '事务已更新'
  }
  if (name === 'toggle-task') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') throw new DataError('缺少事务 id')
    const task = await findAnyTask(ctx, id)
    if (task === null) throw new DataError('这条事务已不存在，请刷新后重试')
    const done = typeof p.done === 'boolean' ? p.done : !task.done
    await ops.updateTask(ctx, { id, done })
    return done ? '已完成' : '已恢复为待办'
  }
  if (name === 'delete-task') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') {
      if (typeof p.text !== 'string' || p.text.trim() === '') {
        throw new DataError('缺少事务 id')
      }
      await ops.deleteTask(ctx, { text: p.text, date: p.date })
      return '已删除事务'
    }
    const task = await findAnyTask(ctx, id)
    if (task === null) throw new DataError('这条事务已不存在，请刷新后重试')
    await ops.deleteTask(ctx, { id })
    return '已删除事务'
  }
  if (name === 'add-schedule') {
    await ops.addSchedule(ctx, {
      weekday: p.weekday,
      time: p.time,
      title: p.title,
      place: p.place,
      note: p.note,
      weekOffset: offsetNow,
    })
    return '已添加安排'
  }
  if (name === 'update-schedule') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') throw new DataError('缺少安排 id')
    const patch = { id, weekOffset: offsetNow }
    for (const key of ['weekday', 'time', 'title', 'place', 'note']) {
      if (p[key] !== undefined) patch[key] = p[key]
    }
    if (Object.keys(patch).length <= 2) throw new DataError('没有要修改的内容')
    await ops.updateSchedule(ctx, patch)
    return '安排已更新'
  }
  if (name === 'delete-schedule') {
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (id === '') {
      await ops.deleteSchedule(ctx, {
        weekOffset: offsetNow,
        weekday: p.weekday,
        title: p.title,
      })
      return '已删除安排'
    }
    await ops.deleteSchedule(ctx, { id, weekOffset: offsetNow })
    return '已删除安排'
  }
  if (name === 'set-duty-week') {
    const patch = { weekOffset: offsetNow }
    if (p.groupId !== undefined) patch.groupName = String(p.groupId)
    if (p.note !== undefined) patch.note = String(p.note)
    if (patch.groupName === undefined && patch.note === undefined) {
      throw new DataError('没有要修改的内容')
    }
    await ops.setDutyWeek(ctx, patch)
    return '值日轮换已保存'
  }
  if (name === 'save-duty-groups') {
    const groups = Array.isArray(p.groups) ? p.groups : []
    if (groups.length === 0) throw new DataError('请至少填写一个值日组')
    const order = Array.isArray(p.order) ? p.order : undefined
    await ops.setDutyGroups(ctx, { groups, ...(order === undefined ? {} : { order }) })
    return '值日分组已保存'
  }
  if (name === 'save-announcement') {
    if (p.text === undefined) throw new DataError('请提供通知内容')
    await ops.setAnnouncement(ctx, { text: String(p.text), weekOffset: offsetNow })
    return String(p.text).trim() === '' ? '通知已清空' : '通知已保存'
  }
  if (name === 'clear-scope') {
    const scope = ['tasks', 'schedule', 'duty', 'all'].includes(p.scope) ? p.scope : 'tasks'
    const result = await ops.clearScope(ctx, scope, offsetNow)
    const removed = result.removed.tasks + result.removed.schedule + result.removed.duty
    return removed > 0 ? '已清理所选数据' : '所选范围没有数据'
  }
  if (name === 'load-demo') {
    if (offsetNow !== 0) throw new DataError('请先回到本周，再写入示例周')
    await ops.loadDemo(ctx)
    return '示例数据已写入'
  }
  return ''
}

async function boardData(ctx, view, weekOffset) {
  const data = await ops.loadWeek(ctx, { weekOffset })
  return shapeBoardData(data, view)
}

/** 读取当前页面数据（ui 里的视图 / 周）。 */
async function readBoardPage(ctx) {
  const ui = await ops.loadUi(ctx)
  const view = isValidView(ui.view) ? ui.view : 'board'
  const weekOffset = defaultOffsetForView(view, ui)
  return boardData(ctx, view, weekOffset)
}

async function handleBoardPanel(panelId, method, params, ctx) {
  if (panelId !== BOARD_PANEL_ID) throw new Error(`未知面板：${panelId}`)
  const p = asParams(params)
  const name = typeof method === 'string' ? method : ''
  let view = 'board'
  let weekOffset = 0
  try {
    const ui = await ops.loadUi(ctx)
    view = isValidView(ui.view) ? ui.view : 'board'
    weekOffset = defaultOffsetForView(view, ui)

    if (name === 'save-view') {
      const nextView = isValidView(p.view) ? String(p.view) : view
      const nextOffset = readOffset(p.weekOffset, defaultOffsetForView(nextView, ui))
      await ops.saveUi(ctx, { view: nextView, weekOffset: nextOffset })
      return { data: await boardData(ctx, nextView, nextOffset) }
    }

    if (name === '' || name === 'load' || name === 'refresh' || name === 'event') {
      const nextView = isValidView(p.view) ? String(p.view) : view
      const hasNav = isValidView(p.view) || (p.weekOffset !== undefined && p.weekOffset !== null)
      const nextOffset = readOffset(p.weekOffset, defaultOffsetForView(nextView, ui))
      if (hasNav) await ops.saveUi(ctx, { view: nextView, weekOffset: nextOffset })
      return { data: await boardData(ctx, nextView, nextOffset) }
    }

    const actionOffset = readOffset(p.weekOffset, weekOffset)
    if (actionOffset < 0 && WRITE_METHODS.has(name)) {
      throw new DataError('过去周只读，不能修改')
    }
    const message = await applyBoardAction(name, p, ctx, actionOffset)
    if (message === '') {
      // 未知方法：按刷新处理，不写数据也不推送。
      return { data: await boardData(ctx, view, weekOffset) }
    }
    await pushAll(ctx, `board-${name}`)
    return { data: await boardData(ctx, view, actionOffset), message }
  } catch (error) {
    const data = await readOrNull(() => boardData(ctx, view, weekOffset))
    if (error instanceof DataError) {
      return { ...(data === null ? {} : { data }), error: error.message }
    }
    ctx.log('warn', '班级事务台页面操作失败', { method: name, error: String(error) })
    return { ...(data === null ? {} : { data }), error: messageOf(error, '操作失败，请重试') }
  }
}

module.exports = {
  BOARD_PANEL_ID,
  VIEWS,
  boardData,
  readBoardPage,
  handleBoardPanel,
}
