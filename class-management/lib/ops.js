'use strict'

/**
 * 业务操作层：所有写操作都通过 `updateBoard` 串行化、原子落盘；
 * 工具（Agent）、面板、浮窗共用同一套函数，保证口径一致。
 *
 * 事务按天（task.date），只显示今天；旧事务保留 HISTORY_DAYS 天供查询。
 * 值日按周轮换一组，不再有按天覆盖。
 */

const {
  clip,
  clipMultiline,
  splitNames,
  normalizePriority,
  makeId,
  priorityRank,
} = require('./util')
const {
  nowMs,
  nowTimeKey,
  todayKey,
  addDays,
  dateKeyOf,
  dateKeyOfWeekday,
  dateLabel,
  parseDateKey,
  resolveWeekContext,
  normalizeOffset,
  weekdayLabel,
  weekdayIndex,
  offsetOfDateKey,
  normalizeTime,
} = require('./time')
const {
  LIMITS,
  HISTORY_DAYS,
  DataError,
  readSettings,
  readBoard,
  updateBoard,
  readUi,
  updateUi,
  ensureWeek,
  emptyWeek,
  boardStats,
  seedGroups,
  historyCutoff,
  purgeStoredTaskHistory,
} = require('./state')
const { resolveDuty, formatDutyGroupsText, formatOrderText } = require('./duty')

function readWeekOffset(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new DataError('weekOffset 必须是 -12 到 12 的整数')
  const integer = Math.trunc(number)
  if (integer < -12 || integer > 12) throw new DataError('weekOffset 必须在 -12 到 12 之间')
  return integer
}

/** 读取任务日期：默认今天；不允许过去日期（历史只读）。 */
function readTaskDate(value, options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return todayKey()
  if (parseDateKey(raw) === null) throw new DataError('date 格式应为 YYYY-MM-DD')
  if (offsetOfDateKey(raw) === null) throw new DataError('date 超出当前 ±12 周的可管理范围')
  const today = todayKey()
  if (raw < today && settings.allowPast !== true) {
    throw new DataError('不能给过去的日期添加事务；历史事务只能在最近 7 天内查询')
  }
  if (raw < today && raw < historyCutoff(today)) {
    throw new DataError(`只保留最近 ${HISTORY_DAYS} 天的事务`)
  }
  return raw
}

function readHistoryDate(value) {
  return readTaskDate(value, { allowPast: true })
}

function weekOffsetOfDate(date) {
  const offset = offsetOfDateKey(date)
  if (offset === null) throw new DataError('date 超出当前 ±12 周的可管理范围')
  return offset
}

function isOverdue(task, weekCtx) {
  if (task.done || task.dueDate === '') return false
  const today = todayKey()
  if (task.dueDate < today) return true
  if (task.dueDate === today && task.dueTime !== '' && task.dueTime < nowTimeKey()) return true
  return false
}

function dueLabel(task, weekCtx) {
  const date = parseDateKey(task.dueDate)
  if (date === null) {
    if (task.dueTime === '') return ''
    // 只填了时间没填日期：按事务所在日期解释，不能一律写成“今天”。
    const today = todayKey()
    const taskDate = parseDateKey(task.date)
    if (taskDate === null || task.date === today) return `今天 ${task.dueTime}`
    const inWeek = taskDate >= weekCtx.monday && taskDate <= weekCtx.sunday
    const base = inWeek ? weekdayLabel(weekdayIndex(taskDate)) : `${taskDate.getMonth() + 1}/${taskDate.getDate()}`
    return `${base} ${task.dueTime}`
  }
  const inWeek = date >= weekCtx.monday && date <= weekCtx.sunday
  const base = inWeek ? weekdayLabel(weekdayIndex(date)) : `${date.getMonth() + 1}/${date.getDate()}`
  return task.dueTime === '' ? base : `${base} ${task.dueTime}`
}

function taskMeta(task, weekCtx) {
  const parts = []
  const due = dueLabel(task, weekCtx)
  if (due !== '') parts.push(due)
  if (task.priority === 'high') parts.push('高优先级')
  if (task.assignee !== '') parts.push(task.assignee)
  return parts.join(' · ')
}

function dueSortKey(task) {
  return `${task.dueDate === '' ? '9999-12-31' : task.dueDate} ${task.dueTime === '' ? '23:59' : task.dueTime}`
}

function sortTasks(tasks) {
  return tasks.slice().sort((left, right) => {
    if (left.done !== right.done) return left.done ? 1 : -1
    const leftKey = dueSortKey(left)
    const rightKey = dueSortKey(right)
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
    const priority = priorityRank(right.priority) - priorityRank(left.priority)
    if (priority !== 0) return priority
    return String(right.createdAt).localeCompare(String(left.createdAt))
  })
}

function sortSchedule(schedule) {
  return schedule.slice().sort((left, right) => {
    if (left.weekday !== right.weekday) return left.weekday - right.weekday
    const leftTime = left.time === '' ? '99:99' : left.time
    const rightTime = right.time === '' ? '99:99' : right.time
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1
    return String(left.title).localeCompare(String(right.title))
  })
}

function taskCounts(tasks, weekCtx) {
  const pending = tasks.filter((task) => !task.done)
  return {
    total: tasks.length,
    pending: pending.length,
    done: tasks.length - pending.length,
    high: pending.filter((task) => task.priority === 'high').length,
    overdue: pending.filter((task) => isOverdue(task, weekCtx)).length,
  }
}

function completionPercent(counts) {
  if (counts.total === 0) return 0
  return Math.round((counts.done / counts.total) * 100)
}

/** 本周 + 后 3 周的轮换预览，用来直观看到“一周一组”。 */
function buildRotationPreview(board, settings, baseCtx, count) {
  const rows = []
  const total = count === undefined ? 4 : count
  for (let index = 0; index < total; index += 1) {
    const offset = Math.min(12, Math.max(-12, baseCtx.offset + index))
    const context = resolveWeekContext(offset, settings, board)
    const duty = resolveDuty(board, context.key, context.weekNumber)
    rows.push({
      week: `${context.label}${context.key === baseCtx.key ? '（本周）' : ''}`,
      group: duty.groupName,
    })
    if (offset >= 12) break
  }
  return rows
}

/**
 * 读取某一天 + 所在周的展示数据（面板、浮窗、文本输出共用）。
 * - 选项为数字时等价于 `{ weekOffset }`
 * - `date` 给了就从日期反推周；否则事务日期默认今天
 */
async function loadWeek(ctx, options) {
  const opt =
    typeof options === 'number'
      ? { weekOffset: options }
      : options !== null && typeof options === 'object'
        ? options
        : {}
  const board = await readBoard(ctx)
  const settings = readSettings(ctx.config)
  const ui = await readUi(ctx)
  let weekOffset = opt.weekOffset === undefined ? normalizeOffset(ui.weekOffset) : normalizeOffset(opt.weekOffset)
  let weekCtx = resolveWeekContext(weekOffset, settings, board)
  let taskDate = todayKey()
  if (opt.date !== undefined && opt.date !== null && opt.date !== '') {
    taskDate = readHistoryDate(opt.date)
    weekOffset = weekOffsetOfDate(taskDate)
    weekCtx = resolveWeekContext(weekOffset, settings, board)
  } else if (weekOffset !== 0) {
    // 查看其他周时默认看该周周一的事务，避免把“今天”的事务混进下周总览。
    taskDate = dateKeyOf(weekCtx.monday)
  }
  const week = board.weeks[weekCtx.key] !== undefined ? board.weeks[weekCtx.key] : emptyWeek()
  const duty = resolveDuty(board, weekCtx.key, weekCtx.weekNumber)
  const allTasks = sortTasks(week.tasks)
  const tasks = allTasks.filter((task) => task.date === taskDate)
  const pendingTasks = tasks.filter((task) => !task.done)
  const doneTasks = tasks.filter((task) => task.done)
  const schedule = sortSchedule(week.schedule)
  const counts = taskCounts(tasks, weekCtx)
  const today = todayKey()
  return {
    board,
    settings,
    ui,
    weekCtx,
    week,
    duty,
    taskDate,
    taskDateLabel: dateLabel(taskDate),
    today,
    isToday: taskDate === today,
    tasks,
    pendingTasks,
    doneTasks,
    schedule,
    announcement: week.announcement,
    counts,
    completion: completionPercent(counts),
    hasDuty: duty.members.length > 0 || duty.hasOverrideGroup || duty.note !== '',
    rotationPreview: buildRotationPreview(board, settings, weekCtx),
    groupsText: formatDutyGroupsText(board),
    orderText: formatOrderText(board),
    stats: boardStats(board),
  }
}

/**
 * 页面型周历：一次返回整周 7 天的日期、事务摘要与安排，只读、不写存储。
 * `weekOffsetInput` 与面板口径一致（-12..12，缺省本周）。
 */
async function loadWeekGrid(ctx, weekOffsetInput) {
  const weekOffset = readWeekOffset(weekOffsetInput, 0)
  const board = await readBoard(ctx)
  const settings = readSettings(ctx.config)
  const weekCtx = resolveWeekContext(weekOffset, settings, board)
  const week = board.weeks[weekCtx.key] !== undefined ? board.weeks[weekCtx.key] : emptyWeek()
  const duty = resolveDuty(board, weekCtx.key, weekCtx.weekNumber)
  const tasks = sortTasks(week.tasks)
  const schedule = sortSchedule(week.schedule)
  const today = todayKey()
  const weekEditable = weekOffset >= 0
  const days = []
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const date = dateKeyOfWeekday(weekCtx, weekday)
    days.push({
      date,
      weekday,
      label: dateLabel(date),
      isToday: date === today,
      isPast: date < today,
      // 周级可编辑：本周与未来周都可以编辑/删除/完成，只有「过去周」整体只读。
      canEdit: weekEditable,
      // 新增事务仍只允许今天与未来日期。
      canAddTask: weekEditable && date >= today,
      tasks: tasks.filter((task) => task.date === date).map((task) => taskSummary(task, weekCtx)),
      schedule: schedule.filter((entry) => entry.weekday === weekday),
    })
  }
  return {
    weekOffset,
    weekLabel: weekCtx.label,
    weekNumber: weekCtx.weekNumber,
    isCurrentWeek: weekCtx.isCurrent,
    todayKey: today,
    canEdit: weekEditable,
    duty,
    groups: board.duty.groups,
    announcement: week.announcement,
    stats: taskCounts(tasks, weekCtx),
    days,
  }
}

async function loadUi(ctx) {
  return readUi(ctx)
}

/**
 * 读取某一天截止的未完成事务（跨周扫描 board，不依赖 task.date 是否等于当天）。
 * 用于截止提醒：昨天登记、今天截止的任务也要能提醒。
 */
async function loadTasksDueOn(ctx, date) {
  const board = await readBoard(ctx)
  const tasks = []
  for (const week of Object.values(board.weeks)) {
    for (const task of week.tasks) {
      if (task.done) continue
      if (task.dueDate === date || (task.dueDate === '' && task.date === date)) {
        tasks.push(task)
      }
    }
  }
  return sortTasks(tasks)
}

async function saveUi(ctx, patch) {
  return updateUi(ctx, patch)
}

async function bumpFormRev(ctx) {
  return updateUi(ctx, (ui) => ({ formRev: (Number(ui.formRev) || 0) + 1 }))
}

async function bumpQuickRev(ctx) {
  return updateUi(ctx, (ui) => ({ quickRev: (Number(ui.quickRev) || 0) + 1 }))
}

function findGroup(board, value) {
  const query = clip(value, 40)
  if (query === '') return null
  return (
    board.duty.groups.find((group) => group.id === query) ||
    board.duty.groups.find((group) => group.name === query) ||
    null
  )
}

function findTaskById(board, value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '') return null
  for (const [weekKey, week] of Object.entries(board.weeks)) {
    const task = week.tasks.find((item) => item.id === id)
    if (task !== undefined) return { weekKey, week, task }
  }
  return null
}

function matchTask(tasks, options, label) {
  const id = typeof options.id === 'string' ? options.id.trim() : ''
  if (id !== '') {
    const found = tasks.find((task) => task.id === id)
    if (found === undefined) throw new DataError(`找不到事务 id：${id}`)
    return found
  }
  const query = clip(options.text, LIMITS.maxTaskText).toLowerCase()
  if (query === '') throw new DataError('请提供事务 id 或内容片段')
  const matches = tasks.filter((task) => task.text.toLowerCase().includes(query))
  if (matches.length === 0) {
    throw new DataError(`${label === undefined ? '今天' : label}没有匹配「${query}」的事务`)
  }
  if (matches.length > 1) {
    throw new DataError(
      `「${query}」匹配到 ${matches.length} 条事务，请改用 id：${matches
        .slice(0, 3)
        .map((task) => `${task.id}（${task.text}）`)
        .join('、')}`,
    )
  }
  return matches[0]
}

function buildTask(input, existingIds, date) {
  const text = clip(input.text, LIMITS.maxTaskText)
  if (text === '') throw new DataError('事务内容不能为空')
  const dueDateRaw = typeof input.dueDate === 'string' ? input.dueDate.trim() : ''
  if (dueDateRaw !== '' && parseDateKey(dueDateRaw) === null) {
    throw new DataError('dueDate 格式应为 YYYY-MM-DD')
  }
  const dueTimeRaw = typeof input.dueTime === 'string' ? input.dueTime.trim() : ''
  const dueTime = normalizeTime(dueTimeRaw)
  if (dueTimeRaw !== '' && dueTime === '') throw new DataError('dueTime 格式应为 HH:mm')
  return {
    id: makeId('t', existingIds),
    text,
    done: false,
    date,
    priority: normalizePriority(input.priority),
    category: clip(input.category, LIMITS.maxCategory) || '事务',
    dueDate: dueDateRaw,
    dueTime,
    assignee: clip(input.assignee, LIMITS.maxAssignee),
    createdAt: new Date(nowMs()).toISOString(),
  }
}

function buildSchedule(input, existingIds) {
  const weekday = Number(input.weekday)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new DataError('weekday 必须是 1（周一）到 7（周日）')
  }
  const title = clip(input.title, LIMITS.maxScheduleTitle)
  if (title === '') throw new DataError('安排事项不能为空')
  const timeRaw = typeof input.time === 'string' ? input.time.trim() : ''
  const time = normalizeTime(timeRaw)
  if (timeRaw !== '' && time === '') throw new DataError('time 格式应为 HH:mm')
  return {
    id: makeId('s', existingIds),
    weekday,
    time,
    title,
    place: clip(input.place, LIMITS.maxPlace),
    note: clip(input.note, LIMITS.maxNote),
    createdAt: new Date(nowMs()).toISOString(),
  }
}

function touch(week) {
  week.updatedAt = new Date(nowMs()).toISOString()
}

function taskSummary(task, weekCtx) {
  return { ...task, dueLabel: dueLabel(task, weekCtx), overdue: isOverdue(task, weekCtx) }
}

function taskWeekCtx(task, settings, board) {
  const offset = offsetOfDateKey(task.date)
  return resolveWeekContext(offset === null ? 0 : offset, settings, board)
}

// ───────────────────────── 事务 ─────────────────────────

async function addTask(ctx, input) {
  const date = readTaskDate(input.date)
  const weekOffset = weekOffsetOfDate(date)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    if (week.tasks.length >= LIMITS.maxTasksPerWeek) {
      throw new DataError(`本周事务总量已达 ${LIMITS.maxTasksPerWeek} 条上限（含近 7 天历史）`)
    }
    const task = buildTask(input, week.tasks.map((item) => item.id), date)
    week.tasks.push(task)
    touch(week)
    return { task: taskSummary(task, weekCtx), weekCtx, date }
  })
}

async function updateTask(ctx, input) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new DataError('请提供事务 id')
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const found = findTaskById(board, id)
    if (found === null) throw new DataError(`找不到事务 id：${id}`)
    const { week, task } = found
    if (input.text !== undefined) {
      const text = clip(input.text, LIMITS.maxTaskText)
      if (text === '') throw new DataError('事务内容不能为空')
      task.text = text
    }
    if (input.dueDate !== undefined) {
      const raw = typeof input.dueDate === 'string' ? input.dueDate.trim() : ''
      if (raw !== '' && parseDateKey(raw) === null) throw new DataError('dueDate 格式应为 YYYY-MM-DD')
      task.dueDate = raw
    }
    if (input.dueTime !== undefined) {
      const raw = typeof input.dueTime === 'string' ? input.dueTime.trim() : ''
      const time = normalizeTime(raw)
      if (raw !== '' && time === '') throw new DataError('dueTime 格式应为 HH:mm')
      task.dueTime = time
    }
    if (input.priority !== undefined) {
      if (!['high', 'normal', 'low'].includes(input.priority)) {
        throw new DataError('priority 只能是 high / normal / low')
      }
      task.priority = input.priority
    }
    if (input.category !== undefined) task.category = clip(input.category, LIMITS.maxCategory) || '事务'
    if (input.assignee !== undefined) task.assignee = clip(input.assignee, LIMITS.maxAssignee)
    if (input.done !== undefined) {
      task.done = input.done === true
      if (task.done) task.doneAt = new Date(nowMs()).toISOString()
      else delete task.doneAt
    }
    touch(week)
    return { task: taskSummary(task, taskWeekCtx(task, settings, board)), date: task.date }
  })
}

async function completeTask(ctx, input) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const date = id === '' ? readHistoryDate(input.date) : ''
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    let week = null
    let task = null
    if (id !== '') {
      const found = findTaskById(board, id)
      if (found === null) throw new DataError(`找不到事务 id：${id}`)
      week = found.week
      task = found.task
    } else {
      const weekCtx = resolveWeekContext(weekOffsetOfDate(date), settings, board)
      week = ensureWeek(board, weekCtx.key)
      task = matchTask(week.tasks.filter((item) => item.date === date), input, dateLabel(date))
    }
    task.done = input.done !== false
    if (task.done) task.doneAt = new Date(nowMs()).toISOString()
    else delete task.doneAt
    touch(week)
    const weekCtx = taskWeekCtx(task, settings, board)
    return { task: taskSummary(task, weekCtx), weekCtx, date: task.date }
  })
}

async function deleteTask(ctx, input) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const date = id === '' ? readHistoryDate(input.date) : ''
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    let week = null
    let task = null
    if (id !== '') {
      const found = findTaskById(board, id)
      if (found === null) throw new DataError(`找不到事务 id：${id}`)
      week = found.week
      task = found.task
    } else {
      const weekCtx = resolveWeekContext(weekOffsetOfDate(date), settings, board)
      week = ensureWeek(board, weekCtx.key)
      task = matchTask(week.tasks.filter((item) => item.date === date), input, dateLabel(date))
    }
    week.tasks.splice(week.tasks.indexOf(task), 1)
    touch(week)
    const weekCtx = taskWeekCtx(task, settings, board)
    return { task: taskSummary(task, weekCtx), weekCtx, date: task.date }
  })
}

/**
 * 把事务改到另一天（拖拽/改期共用）。跨周时先校验目标周容量，
 * 再搬移并刷新源周与目标周的 updatedAt；任何报错都不会落盘。
 */
async function moveTask(ctx, input) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new DataError('请提供事务 id')
  const date = readTaskDate(input.date)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const found = findTaskById(board, id)
    if (found === null) throw new DataError(`找不到事务 id：${id}`)
    const targetOffset = weekOffsetOfDate(date)
    const targetWeekCtx = resolveWeekContext(targetOffset, settings, board)
    const targetWeek = ensureWeek(board, targetWeekCtx.key)
    if (found.weekKey !== targetWeekCtx.key) {
      if (targetWeek.tasks.length >= LIMITS.maxTasksPerWeek) {
        throw new DataError(`目标周事务已达 ${LIMITS.maxTasksPerWeek} 条上限`)
      }
      found.week.tasks.splice(found.week.tasks.indexOf(found.task), 1)
      targetWeek.tasks.push(found.task)
      touch(found.week)
      touch(targetWeek)
      found.task.date = date
    } else {
      found.task.date = date
      touch(found.week)
    }
    return { task: taskSummary(found.task, targetWeekCtx), weekCtx: targetWeekCtx }
  })
}

async function listTasks(ctx, input) {
  const date = readHistoryDate(input.date)
  const weekOffset = weekOffsetOfDate(date)
  const status = ['pending', 'done', 'all'].includes(input.status) ? input.status : 'pending'
  const category = clip(input.category, LIMITS.maxCategory)
  const limit = Math.min(60, Math.max(1, Number.isInteger(Number(input.limit)) ? Number(input.limit) : 30))
  const data = await loadWeek(ctx, { weekOffset, date })
  let tasks = data.tasks
  if (status === 'pending') tasks = tasks.filter((task) => !task.done)
  if (status === 'done') tasks = tasks.filter((task) => task.done)
  if (category !== '') tasks = tasks.filter((task) => task.category === category)
  return { data, tasks: tasks.slice(0, limit), total: tasks.length, status, category, date }
}

// ───────────────────────── 值日 ─────────────────────────

async function setDutyWeek(ctx, input) {
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    const clear = input.clear === true || input.groupName === ''
    if (clear) {
      delete week.duty.groupId
    } else if (input.groupName !== undefined) {
      const group = findGroup(board, input.groupName)
      if (group === null) {
        throw new DataError(
          `找不到值日组「${clip(input.groupName, LIMITS.maxGroupName)}」；可用：${board.duty.groups
            .map((item) => item.name)
            .join('、')}`,
        )
      }
      week.duty.groupId = group.id
    }
    if (input.note !== undefined) {
      const note = clip(input.note, LIMITS.maxNote)
      if (note === '') delete week.duty.note
      else week.duty.note = note
    }
    touch(week)
    const group = week.duty.groupId !== undefined ? findGroup(board, week.duty.groupId) : null
    return { weekCtx, groupName: group === null ? '' : group.name }
  })
}

async function setDutyGroups(ctx, input) {
  const rawGroups = Array.isArray(input.groups) ? input.groups : []
  if (rawGroups.length === 0) throw new DataError('请至少提供一个值日组')
  if (rawGroups.length > LIMITS.maxGroups) {
    throw new DataError(`值日组最多 ${LIMITS.maxGroups} 个`)
  }
  return updateBoard(ctx, async (board) => {
    const groups = []
    const usedNames = new Set()
    for (const raw of rawGroups) {
      if (raw === null || typeof raw !== 'object') continue
      const name = clip(raw.name, LIMITS.maxGroupName)
      if (name === '') continue
      if (usedNames.has(name)) throw new DataError(`值日组重名：${name}`)
      usedNames.add(name)
      const existing = board.duty.groups.find((group) => group.name === name)
      let id = existing !== undefined ? existing.id : ''
      if (id === '') {
        let index = groups.length + 1
        while (board.duty.groups.some((group) => group.id === `g${index}`) || groups.some((group) => group.id === `g${index}`)) {
          index += 1
        }
        id = `g${index}`
      }
      groups.push({ id, name, members: splitNames(raw.members) })
      if (groups.length >= LIMITS.maxGroups) break
    }
    if (groups.length === 0) throw new DataError('没有可用的值日组名称')
    board.duty.groups = groups

    const byName = new Map(groups.map((group) => [group.name, group]))
    const byId = new Map(groups.map((group) => [group.id, group]))
    const order = []
    const pushOrder = (id) => {
      if (id !== '' && !order.includes(id)) order.push(id)
    }
    if (Array.isArray(input.order) && input.order.length > 0) {
      for (const rawName of input.order) {
        const query = clip(rawName, LIMITS.maxGroupName)
        const group = byName.get(query) || byId.get(query)
        if (group === undefined) throw new DataError(`轮换顺序里的「${query}」不在分组中`)
        pushOrder(group.id)
      }
    } else {
      for (const id of board.duty.order) if (byId.has(id)) pushOrder(id)
      for (const group of groups) pushOrder(group.id)
    }
    if (order.length === 0) for (const group of groups) pushOrder(group.id)
    board.duty.order = order

    const groupIds = new Set(groups.map((group) => group.id))
    for (const week of Object.values(board.weeks)) {
      if (typeof week.duty.groupId === 'string' && !groupIds.has(week.duty.groupId)) {
        delete week.duty.groupId
      }
    }
    return { groups: groups.length, order: order.length }
  })
}

// ───────────────────────── 安排 / 通知 / 整周计划 ─────────────────────────

async function addSchedule(ctx, input) {
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    if (week.schedule.length >= LIMITS.maxSchedulePerWeek) {
      throw new DataError(`本周安排已达 ${LIMITS.maxSchedulePerWeek} 条上限`)
    }
    const entry = buildSchedule(input, week.schedule.map((item) => item.id))
    week.schedule.push(entry)
    touch(week)
    return { entry, weekCtx }
  })
}

async function updateSchedule(ctx, input) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new DataError('请提供安排 id')
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    const entry = week.schedule.find((item) => item.id === id)
    if (entry === undefined) throw new DataError(`找不到安排 id：${id}`)
    if (input.weekday !== undefined) {
      const weekday = Number(input.weekday)
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
        throw new DataError('weekday 必须是 1（周一）到 7（周日）')
      }
      entry.weekday = weekday
    }
    if (input.time !== undefined) {
      const raw = typeof input.time === 'string' ? input.time.trim() : ''
      const time = normalizeTime(raw)
      if (raw !== '' && time === '') throw new DataError('time 格式应为 HH:mm')
      entry.time = time
    }
    if (input.title !== undefined) {
      const title = clip(input.title, LIMITS.maxScheduleTitle)
      if (title === '') throw new DataError('安排事项不能为空')
      entry.title = title
    }
    if (input.place !== undefined) entry.place = clip(input.place, LIMITS.maxPlace)
    if (input.note !== undefined) entry.note = clip(input.note, LIMITS.maxNote)
    touch(week)
    return { entry, weekCtx }
  })
}

async function deleteSchedule(ctx, input) {
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    let entry = null
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id !== '') {
      entry = week.schedule.find((item) => item.id === id) || null
      if (entry === null) throw new DataError(`找不到安排 id：${id}`)
    } else {
      const weekday = Number(input.weekday)
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
        throw new DataError('请提供安排 id，或 weekday + title')
      }
      const query = clip(input.title, LIMITS.maxScheduleTitle).toLowerCase()
      if (query === '') throw new DataError('请提供安排 id，或 weekday + title')
      const matches = week.schedule.filter(
        (item) => item.weekday === weekday && item.title.toLowerCase().includes(query),
      )
      if (matches.length === 0) throw new DataError(`周${'一二三四五六日'[weekday - 1]}没有匹配「${query}」的安排`)
      if (matches.length > 1) {
        throw new DataError(`匹配到 ${matches.length} 条安排，请改用 id：${matches.map((item) => item.id).join('、')}`)
      }
      entry = matches[0]
    }
    week.schedule.splice(week.schedule.indexOf(entry), 1)
    touch(week)
    return { entry, weekCtx }
  })
}

async function setAnnouncement(ctx, input) {
  if (input.text === undefined) {
    throw new DataError('请提供 text；要清空通知请传空字符串')
  }
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    week.announcement = clipMultiline(input.text, LIMITS.maxAnnouncement)
    touch(week)
    return { weekCtx, announcement: week.announcement }
  })
}

async function applyWeekPlan(ctx, input) {
  const plan = input.plan
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new DataError('plan 必须是对象')
  }
  const weekOffset = readWeekOffset(input.weekOffset, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    const mondayKey = dateKeyOf(weekCtx.monday)
    const sundayKey = dateKeyOf(weekCtx.sunday)
    const defaultTaskDate = weekOffset === 0 ? todayKey() : mondayKey
    const summary = {
      weekLabel: weekCtx.label,
      tasksAdded: 0,
      scheduleAdded: 0,
      dutyGroup: '',
      announcement: false,
    }

    if (plan.replaceTasks === true) week.tasks = []
    if (plan.replaceSchedule === true) week.schedule = []

    for (const item of Array.isArray(plan.tasks) ? plan.tasks : []) {
      if (week.tasks.length >= LIMITS.maxTasksPerWeek) {
        throw new DataError(`本周事务会超过 ${LIMITS.maxTasksPerWeek} 条上限（含近 7 天历史）`)
      }
      let date = defaultTaskDate
      if (item.date !== undefined && item.date !== null && item.date !== '') {
        if (parseDateKey(item.date) === null) throw new DataError('plan.tasks[].date 格式应为 YYYY-MM-DD')
        date = String(item.date).trim()
      }
      if (date < mondayKey || date > sundayKey) {
        throw new DataError('plan.tasks[].date 必须落在目标周内')
      }
      week.tasks.push(buildTask(item, week.tasks.map((task) => task.id), date))
      summary.tasksAdded += 1
    }
    for (const item of Array.isArray(plan.schedule) ? plan.schedule : []) {
      if (week.schedule.length >= LIMITS.maxSchedulePerWeek) {
        throw new DataError(`本周安排会超过 ${LIMITS.maxSchedulePerWeek} 条上限`)
      }
      week.schedule.push(buildSchedule(item, week.schedule.map((entry) => entry.id)))
      summary.scheduleAdded += 1
    }
    if (plan.duty !== null && typeof plan.duty === 'object') {
      if (plan.duty.days !== undefined) {
        throw new DataError('值日已改为整周轮换，plan.duty.days 不再支持')
      }
      if (plan.duty.groupName !== undefined) {
        if (plan.duty.groupName === '') {
          delete week.duty.groupId
          summary.dutyGroup = ''
        } else {
          const group = findGroup(board, plan.duty.groupName)
          if (group === null) throw new DataError(`找不到值日组「${clip(plan.duty.groupName, 40)}」`)
          week.duty.groupId = group.id
          summary.dutyGroup = group.name
        }
      }
      if (plan.duty.note !== undefined) {
        const note = clip(plan.duty.note, LIMITS.maxNote)
        if (note === '') delete week.duty.note
        else week.duty.note = note
      }
    }
    if (typeof plan.announcement === 'string') {
      week.announcement = clipMultiline(plan.announcement, LIMITS.maxAnnouncement)
      summary.announcement = week.announcement !== ''
    }
    touch(week)
    return { weekCtx, summary }
  })
}

async function clearScope(ctx, scope, weekOffsetInput) {
  if (!['tasks', 'schedule', 'duty', 'all'].includes(scope)) {
    throw new DataError('清理范围只能是 tasks / schedule / duty / all')
  }
  const weekOffset = readWeekOffset(weekOffsetInput, 0)
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(weekOffset, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    const today = todayKey()
    const removed = { tasks: 0, schedule: 0, duty: 0 }
    if (scope === 'tasks' || scope === 'all') {
      const before = week.tasks.length
      week.tasks = week.tasks.filter((task) => task.date !== today)
      removed.tasks = before - week.tasks.length
    }
    if (scope === 'schedule' || scope === 'all') {
      removed.schedule = week.schedule.length
      week.schedule = []
    }
    if (scope === 'duty' || scope === 'all') {
      removed.duty =
        (week.duty.groupId !== undefined ? 1 : 0) + (week.duty.note !== undefined ? 1 : 0)
      week.duty = {}
    }
    if (scope === 'all') {
      week.announcement = ''
    }
    touch(week)
    return { weekCtx, removed }
  })
}

const DEMO_GROUPS = [
  ['张三', '李四', '王五'],
  ['赵六', '钱七', '孙八'],
  ['周九', '吴十', '郑一'],
  ['王二', '冯三', '陈四'],
]

async function loadDemo(ctx) {
  const settings = readSettings(ctx.config)
  return updateBoard(ctx, async (board) => {
    const weekCtx = resolveWeekContext(0, settings, board)
    const week = ensureWeek(board, weekCtx.key)
    const hasData =
      week.tasks.length > 0 ||
      week.schedule.length > 0 ||
      week.announcement !== '' ||
      week.duty.groupId !== undefined ||
      week.duty.note !== undefined
    if (hasData) {
      throw new DataError('本周已经有数据了。先到「设置 → 清理」清空本周，再写入示例。')
    }
    if (board.duty.groups.every((group) => group.members.length === 0)) {
      board.duty.groups = DEMO_GROUPS.map((members, index) => ({
        id: `g${index + 1}`,
        name: `第${index + 1}组`,
        members,
      }))
      board.duty.order = board.duty.groups.map((group) => group.id)
    }
    const day = (offset) => dateKeyOf(addDays(new Date(nowMs()), offset))
    const today = todayKey()
    week.tasks = [
      {
        id: makeId('t', []),
        text: '收数学作业',
        done: false,
        date: today,
        priority: 'high',
        category: '作业',
        dueDate: day(1),
        dueTime: '08:00',
        assignee: '数学课代表',
        createdAt: new Date(nowMs()).toISOString(),
      },
      {
        id: makeId('t', []),
        text: '物理实验报告',
        done: false,
        date: today,
        priority: 'normal',
        category: '作业',
        dueDate: day(2),
        dueTime: '20:00',
        assignee: '',
        createdAt: new Date(nowMs()).toISOString(),
      },
      {
        id: makeId('t', []),
        text: '班会主题征集',
        done: false,
        date: today,
        priority: 'low',
        category: '活动',
        dueDate: day(1),
        dueTime: '',
        assignee: '班长',
        createdAt: new Date(nowMs()).toISOString(),
      },
      {
        id: makeId('t', []),
        text: '校运会报名表',
        done: false,
        date: today,
        priority: 'normal',
        category: '通知',
        dueDate: day(3),
        dueTime: '17:00',
        assignee: '体育委员',
        createdAt: new Date(nowMs()).toISOString(),
      },
    ]
    week.schedule = [
      { id: makeId('s', []), weekday: 1, time: '08:00', title: '升旗仪式', place: '操场', note: '', createdAt: new Date(nowMs()).toISOString() },
      { id: makeId('s', []), weekday: 3, time: '16:00', title: '班会', place: '教室', note: '', createdAt: new Date(nowMs()).toISOString() },
      { id: makeId('s', []), weekday: 5, time: '15:30', title: '大扫除', place: '教室', note: '带清洁工具', createdAt: new Date(nowMs()).toISOString() },
    ]
    week.duty = { note: '本周五放学后大扫除' }
    week.announcement = '本周五下午大扫除，请各组带好清洁工具。'
    touch(week)
    return { weekCtx }
  })
}

/** 跨天/启动时清理过期历史事务；写操作内部也会自动清理一次。 */
async function purgeTaskHistory(ctx) {
  return purgeStoredTaskHistory(ctx)
}

module.exports = {
  readWeekOffset,
  readTaskDate,
  readHistoryDate,
  loadWeek,
  loadWeekGrid,
  loadTasksDueOn,
  loadUi,
  saveUi,
  bumpFormRev,
  bumpQuickRev,
  isOverdue,
  dueLabel,
  taskMeta,
  taskSummary,
  sortTasks,
  sortSchedule,
  taskCounts,
  completionPercent,
  findGroup,
  findTaskById,
  matchTask,
  addTask,
  updateTask,
  completeTask,
  deleteTask,
  moveTask,
  listTasks,
  setDutyWeek,
  setDutyGroups,
  addSchedule,
  updateSchedule,
  deleteSchedule,
  setAnnouncement,
  applyWeekPlan,
  clearScope,
  loadDemo,
  seedGroups,
  purgeTaskHistory,
}
