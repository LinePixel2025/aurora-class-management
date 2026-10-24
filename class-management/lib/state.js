'use strict'

/**
 * 插件数据层。
 *
 * - `board.v1`：业务数据（值日分组/轮换、每周安排/通知、按天事务）
 * - `ui.v1`：界面状态（当前面板视图、周偏移），与业务数据分开保存
 *
 * 事务按天存放（`task.date`），界面只显示今天；旧事务保留 7 天供查询，之后自动清理。
 * 所有写入都经过净化、容量守卫与串行队列；单个存储值上限 256 KB，这里自留 240 KB 余量。
 */

const {
  clip,
  clipMultiline,
  splitNames,
  byteLength,
  normalizePriority,
  makeId,
} = require('./util')
const {
  currentWeekKey,
  normalizeOffset,
  normalizeTime,
  parseDateKey,
  todayKey,
  addDays,
  dateKeyOf,
} = require('./time')

function isoNowLocal() {
  return new Date().toISOString()
}

const BOARD_KEY = 'board.v1'
const UI_KEY = 'ui.v1'
const BOARD_VERSION = 2
const HISTORY_DAYS = 7
const MAX_BOARD_BYTES = 240 * 1024
const VIEWS = ['board', 'duty', 'schedule', 'settings']

const LIMITS = {
  maxWeeks: 40,
  maxTasksPerWeek: 80,
  maxSchedulePerWeek: 60,
  maxGroups: 8,
  maxMembers: 12,
  maxTaskText: 200,
  maxAnnouncement: 600,
  maxArea: 40,
  maxNote: 60,
  maxCategory: 12,
  maxAssignee: 20,
  maxGroupName: 20,
  maxClassName: 60,
  maxTeacher: 40,
  maxScheduleTitle: 60,
  maxPlace: 40,
}

class DataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DataError'
  }
}

function seedGroups() {
  return [1, 2, 3, 4].map((index) => ({ id: `g${index}`, name: `第${index}组`, members: [] }))
}

function emptyWeek() {
  return {
    duty: {},
    tasks: [],
    schedule: [],
    announcement: '',
    updatedAt: isoNowLocal(),
  }
}

function createBoard() {
  return {
    version: BOARD_VERSION,
    anchorMonday: currentWeekKey(),
    duty: { groups: seedGroups(), order: ['g1', 'g2', 'g3', 'g4'] },
    weeks: {},
  }
}

function sanitizeTask(raw, fallbackDate) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const text = clip(raw.text, LIMITS.maxTaskText)
  if (text === '') return null
  const fallback =
    typeof fallbackDate === 'string' && parseDateKey(fallbackDate) !== null ? fallbackDate : todayKey()
  const task = {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(String(raw.id)) ? String(raw.id) : makeId('t', []),
    text,
    done: raw.done === true,
    date: parseDateKey(raw.date) === null ? fallback : String(raw.date).trim(),
    priority: normalizePriority(raw.priority),
    category: clip(raw.category, LIMITS.maxCategory) || '事务',
    dueDate: parseDateKey(raw.dueDate) === null ? '' : String(raw.dueDate).trim(),
    dueTime: normalizeTime(raw.dueTime),
    assignee: clip(raw.assignee, LIMITS.maxAssignee),
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt.length <= 40
        ? raw.createdAt
        : new Date().toISOString(),
  }
  if (task.done === true && typeof raw.doneAt === 'string' && raw.doneAt.length <= 40) {
    task.doneAt = raw.doneAt
  }
  return task
}

function sanitizeSchedule(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const weekday = Number(raw.weekday)
  const title = clip(raw.title, LIMITS.maxScheduleTitle)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || title === '') return null
  return {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(String(raw.id)) ? String(raw.id) : makeId('s', []),
    weekday,
    time: normalizeTime(raw.time),
    title,
    place: clip(raw.place, LIMITS.maxPlace),
    note: clip(raw.note, LIMITS.maxNote),
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt.length <= 40
        ? raw.createdAt
        : new Date().toISOString(),
  }
}

function sanitizeDutyGroups(rawGroups) {
  const groups = []
  const usedIds = new Set()
  const usedNames = new Set()
  for (const item of Array.isArray(rawGroups) ? rawGroups : []) {
    if (item === null || typeof item !== 'object') continue
    const name = clip(item.name, LIMITS.maxGroupName)
    if (name === '' || usedNames.has(name)) continue
    let id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(item.id) ? item.id : ''
    if (id === '' || usedIds.has(id)) {
      let index = groups.length + 1
      while (usedIds.has(`g${index}`)) index += 1
      id = `g${index}`
    }
    usedIds.add(id)
    usedNames.add(name)
    groups.push({ id, name, members: splitNames(item.members) })
    if (groups.length >= LIMITS.maxGroups) break
  }
  return groups
}

function sanitizeWeek(raw, weekKey) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const fallbackDate =
    weekKey === currentWeekKey()
      ? todayKey()
      : typeof weekKey === 'string' && parseDateKey(weekKey) !== null
        ? weekKey
        : todayKey()

  const tasks = []
  const taskIds = new Set()
  for (const item of Array.isArray(source.tasks) ? source.tasks : []) {
    const task = sanitizeTask(item, fallbackDate)
    if (task === null) continue
    while (taskIds.has(task.id)) task.id = makeId('t', [...taskIds])
    taskIds.add(task.id)
    tasks.push(task)
    if (tasks.length >= LIMITS.maxTasksPerWeek) break
  }

  const schedule = []
  const scheduleIds = new Set()
  for (const item of Array.isArray(source.schedule) ? source.schedule : []) {
    const entry = sanitizeSchedule(item)
    if (entry === null) continue
    while (scheduleIds.has(entry.id)) entry.id = makeId('s', [...scheduleIds])
    scheduleIds.add(entry.id)
    schedule.push(entry)
    if (schedule.length >= LIMITS.maxSchedulePerWeek) break
  }

  const dutyRaw = source.duty !== null && typeof source.duty === 'object' ? source.duty : {}
  const week = {
    duty: {},
    tasks,
    schedule,
    announcement: clipMultiline(source.announcement, LIMITS.maxAnnouncement),
    updatedAt:
      typeof source.updatedAt === 'string' && source.updatedAt.length <= 40
        ? source.updatedAt
        : new Date().toISOString(),
  }
  if (typeof dutyRaw.groupId === 'string' && dutyRaw.groupId !== '') {
    week.duty.groupId = clip(dutyRaw.groupId, 40)
  }
  if (typeof dutyRaw.note === 'string' && dutyRaw.note !== '') {
    week.duty.note = clip(dutyRaw.note, LIMITS.maxNote)
  }
  return week
}

function sanitizeBoard(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (source === null) {
    return { board: createBoard(), changed: true }
  }
  const board = {
    version: BOARD_VERSION,
    anchorMonday:
      parseDateKey(source.anchorMonday) === null ? currentWeekKey() : String(source.anchorMonday).trim(),
    duty: { groups: [], order: [] },
    weeks: {},
  }
  const dutyRaw = source.duty !== null && typeof source.duty === 'object' ? source.duty : {}
  const groups = sanitizeDutyGroups(dutyRaw.groups)
  board.duty.groups = groups.length > 0 ? groups : seedGroups()
  const groupIds = new Set(board.duty.groups.map((group) => group.id))
  const order = []
  for (const item of Array.isArray(dutyRaw.order) ? dutyRaw.order : []) {
    const id = String(item)
    if (groupIds.has(id) && !order.includes(id)) order.push(id)
  }
  if (order.length === 0) order.push(...board.duty.groups.map((group) => group.id))
  board.duty.order = order

  const weeksRaw = source.weeks !== null && typeof source.weeks === 'object' ? source.weeks : {}
  for (const [key, value] of Object.entries(weeksRaw)) {
    if (parseDateKey(key) === null) continue
    if (value === null || typeof value !== 'object') continue
    board.weeks[key] = sanitizeWeek(value, key)
  }

  const changed = JSON.stringify(board) !== JSON.stringify(source)
  return { board, changed }
}

function readSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const termStartDate =
    parseDateKey(source.termStartDate) === null ? '' : String(source.termStartDate).trim()
  return {
    className: clip(source.className, LIMITS.maxClassName) || '我的班级',
    teacher: clip(source.teacher, LIMITS.maxTeacher),
    termStartDate,
    showCompleted: source.showCompleted === true,
    notifyDaily: source.notifyDaily === true,
    notifyTime: normalizeTime(source.notifyTime) || '07:30',
    notifyDue: source.notifyDue === true,
    notifyDueLead: Number.isFinite(Number(source.notifyDueLead))
      ? Math.min(120, Math.max(0, Math.trunc(Number(source.notifyDueLead))))
      : 10,
    notifyDuty: source.notifyDuty === true,
  }
}

/** 历史事务保留窗口：今天 + 前 (HISTORY_DAYS - 1) 天。 */
function historyCutoff(today) {
  const date = parseDateKey(today)
  if (date === null) return dateKeyOf(addDays(new Date(), -(HISTORY_DAYS - 1)))
  return dateKeyOf(addDays(date, -(HISTORY_DAYS - 1)))
}

/** 删除早于保留窗口的事务；返回删除数量与截止日。 */
function purgeTaskHistory(board, today) {
  const cutoff = historyCutoff(today)
  let removed = 0
  for (const week of Object.values(board.weeks)) {
    const before = week.tasks.length
    week.tasks = week.tasks.filter((task) => task.date >= cutoff)
    removed += before - week.tasks.length
  }
  return { removed, cutoff }
}

function pruneWeeks(board) {
  const keys = Object.keys(board.weeks).sort()
  if (keys.length > LIMITS.maxWeeks) {
    for (const key of keys.slice(0, keys.length - LIMITS.maxWeeks)) {
      delete board.weeks[key]
    }
  }
}

function pruneToFit(board) {
  pruneWeeks(board)
  let keys = Object.keys(board.weeks).sort()
  while (byteLength(board) > MAX_BOARD_BYTES && keys.length > 1) {
    delete board.weeks[keys[0]]
    keys = keys.slice(1)
  }
}

async function writeBoard(ctx, board) {
  pruneToFit(board)
  if (byteLength(board) > MAX_BOARD_BYTES) {
    throw new DataError('班级事务数据已超过 240 KB。请在管理台「设置 → 清理」删除旧周数据后重试。')
  }
  await ctx.storage.set(BOARD_KEY, board)
}

/**
 * 纯读取：缺失/损坏时返回净化后的内存数据，**不写盘**。
 * 修复/种子写入统一走 `ensureBoard`（持锁）或下一次业务写入，避免读路径与写路径互相覆盖。
 */
async function readBoard(ctx) {
  const raw = await ctx.storage.get(BOARD_KEY)
  const { board } = sanitizeBoard(raw)
  return board
}

/** 启动时在串行队列里补种子 / 修复坏数据 / 清理过期事务。 */
async function ensureBoard(ctx) {
  return exclusive(async () => {
    const raw = await ctx.storage.get(BOARD_KEY)
    const { board, changed } = sanitizeBoard(raw)
    const { removed } = purgeTaskHistory(board, todayKey())
    if (raw === undefined || raw === null || changed || removed > 0) {
      if (raw !== undefined && raw !== null) {
        ctx.log('warn', '班级事务数据已自动修复/迁移', { changed, removed })
      }
      await writeBoard(ctx, board)
    }
    return board
  })
}

/** 供跨天 tick / 启动时单独清理历史事务（不触碰业务变更）。 */
async function purgeStoredTaskHistory(ctx) {
  return exclusive(async () => {
    const raw = await ctx.storage.get(BOARD_KEY)
    const { board } = sanitizeBoard(raw)
    const result = purgeTaskHistory(board, todayKey())
    if (result.removed > 0) await writeBoard(ctx, board)
    return result
  })
}

function sanitizeUi(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const formRev = Number.isFinite(Number(source.formRev))
    ? Math.max(0, Math.trunc(Number(source.formRev)))
    : 0
  const quickRev = Number.isFinite(Number(source.quickRev))
    ? Math.max(0, Math.trunc(Number(source.quickRev)))
    : 0
  return {
    view: VIEWS.includes(source.view) ? source.view : 'board',
    weekOffset: normalizeOffset(source.weekOffset),
    // 表单绑定键版本号：动作成功后递增，避免宿主用旧输入值覆盖刚写入的数据
    formRev,
    // 浮窗「快速添加」输入框的版本号
    quickRev,
    // 管理台当前展开编辑的事务（空字符串表示未选中）
    editingTaskId:
      typeof source.editingTaskId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(source.editingTaskId)
        ? source.editingTaskId
        : '',
  }
}

async function readUi(ctx) {
  const raw = await ctx.storage.get(UI_KEY)
  return sanitizeUi(raw)
}

async function writeUi(ctx, ui) {
  const clean = sanitizeUi(ui)
  await ctx.storage.set(UI_KEY, clean)
  return clean
}

let queue = Promise.resolve()

/** 进程内串行队列：工具 / 面板 / 浮窗写入不会互相覆盖。 */
function exclusive(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function updateBoard(ctx, mutate) {
  return exclusive(async () => {
    const board = await readBoard(ctx)
    purgeTaskHistory(board, todayKey())
    const result = await mutate(board)
    await writeBoard(ctx, board)
    return result
  })
}

async function updateUi(ctx, patchOrFactory) {
  return exclusive(async () => {
    const ui = await readUi(ctx)
    const patch =
      typeof patchOrFactory === 'function' ? patchOrFactory(ui) : patchOrFactory || {}
    return writeUi(ctx, { ...ui, ...patch })
  })
}

function ensureWeek(board, weekKey) {
  if (board.weeks[weekKey] === undefined) board.weeks[weekKey] = emptyWeek()
  return board.weeks[weekKey]
}

function emptyWeekGuard() {
  return emptyWeek()
}

function boardStats(board) {
  const keys = Object.keys(board.weeks)
  let tasks = 0
  let done = 0
  let schedule = 0
  for (const key of keys) {
    const week = board.weeks[key]
    tasks += week.tasks.length
    done += week.tasks.filter((task) => task.done).length
    schedule += week.schedule.length
  }
  return {
    weeks: keys.length,
    tasks,
    done,
    schedule,
    bytes: byteLength(board),
  }
}

module.exports = {
  BOARD_KEY,
  UI_KEY,
  BOARD_VERSION,
  HISTORY_DAYS,
  VIEWS,
  LIMITS,
  MAX_BOARD_BYTES,
  DataError,
  seedGroups,
  emptyWeek: emptyWeekGuard,
  createBoard,
  sanitizeBoard,
  sanitizeWeek,
  sanitizeTask,
  sanitizeSchedule,
  sanitizeDutyGroups,
  readSettings,
  readBoard,
  ensureBoard,
  writeBoard,
  readUi,
  writeUi,
  updateBoard,
  updateUi,
  ensureWeek,
  boardStats,
  pruneToFit,
  historyCutoff,
  purgeTaskHistory,
  purgeStoredTaskHistory,
}
