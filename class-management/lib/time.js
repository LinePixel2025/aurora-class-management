'use strict'

/**
 * 本地时间与「周」运算。
 *
 * 约定：一周从周一开始，所有日期键都是本地时区的 `YYYY-MM-DD`（绝不经 UTC 解析，
 * 否则东八区的用户会在周日晚上看到「昨天」）。测试可用 `setNowForTests` 固定时钟。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日']

let nowProvider = null

function nowMs() {
  return nowProvider === null ? Date.now() : nowProvider()
}

function setNowForTests(value) {
  nowProvider = typeof value === 'function' ? value : () => value
}

function resetNowForTests() {
  nowProvider = null
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function dateKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 严格解析 `YYYY-MM-DD`，非法日期（如 2026-02-31）返回 null。 */
function parseDateKey(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

function addDays(date, days) {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return startOfDay(next)
}

function mondayOf(date) {
  const day = startOfDay(date)
  const offset = (day.getDay() + 6) % 7
  return addDays(day, -offset)
}

function currentMonday() {
  return mondayOf(new Date(nowMs()))
}

function todayKey() {
  return dateKeyOf(startOfDay(new Date(nowMs())))
}

/** `2026-10-24` → `10/24 周五`；非法日期返回 ''。 */
function dateLabel(value) {
  const date = parseDateKey(value)
  if (date === null) return ''
  return `${shortDate(date)} ${weekdayLabel(weekdayIndex(date))}`
}

function todayLabel() {
  return dateLabel(todayKey())
}

/** 某个周上下文里周几对应的日期键；非法 weekday 返回 ''。 */
function dateKeyOfWeekday(weekCtx, weekday) {
  const index = Number(weekday)
  if (!Number.isInteger(index) || index < 1 || index > 7) return ''
  if (weekCtx === null || typeof weekCtx !== 'object' || !(weekCtx.monday instanceof Date)) return ''
  return dateKeyOf(addDays(weekCtx.monday, index - 1))
}

function currentWeekKey() {
  return dateKeyOf(currentMonday())
}

function weekKeyFromOffset(offset) {
  return dateKeyOf(addDays(currentMonday(), normalizeOffset(offset) * 7))
}

function weekRangeOf(weekKey) {
  const monday = parseDateKey(weekKey)
  if (monday === null) return null
  return { monday, sunday: addDays(monday, 6) }
}

/** 1 = 周一 … 7 = 周日。 */
function weekdayIndex(date) {
  return ((date.getDay() + 6) % 7) + 1
}

function weekdayLabel(weekday) {
  const index = Number(weekday)
  return WEEKDAY_LABELS[index >= 1 && index <= 7 ? index - 1 : 0]
}

function weekdayShort(weekday) {
  const index = Number(weekday)
  return WEEKDAY_SHORT[index >= 1 && index <= 7 ? index - 1 : 0]
}

/** 星期集合 → 人类可读：连续段用 `~`（`周一~周五`），离散用 `、`。 */
function weekdaysLabel(weekdays) {
  const days = []
  for (const item of Array.isArray(weekdays) ? weekdays : []) {
    const index = Number(item)
    if (Number.isInteger(index) && index >= 1 && index <= 7 && !days.includes(index)) days.push(index)
  }
  if (days.length === 0) return ''
  days.sort((left, right) => left - right)
  if (days.length === 7) return '每天'
  const runs = []
  let start = days[0]
  let prev = days[0]
  for (const day of days.slice(1)) {
    if (day === prev + 1) {
      prev = day
      continue
    }
    runs.push([start, prev])
    start = day
    prev = day
  }
  runs.push([start, prev])
  return runs
    .map(([from, to]) =>
      from === to ? weekdayLabel(from) : to - from === 1 ? `${weekdayLabel(from)}、${weekdayLabel(to)}` : `${weekdayLabel(from)}~${weekdayLabel(to)}`,
    )
    .join('、')
}

function normalizeOffset(offset, min = -12, max = 12) {
  const number = Number(offset)
  if (!Number.isFinite(number)) return 0
  const integer = Math.trunc(number)
  return Math.min(max, Math.max(min, integer))
}

function weekNumberOf(weekKey, anchorKey) {
  const monday = parseDateKey(weekKey)
  const anchor = parseDateKey(anchorKey)
  if (monday === null || anchor === null) return 1
  const difference = Math.round((monday.getTime() - mondayOf(anchor).getTime()) / DAY_MS / 7)
  // 允许 0 / 负数：anchor 之前的周显示“未开学”，不要伪装成第 1 周
  return difference + 1
}

function shortDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function weekLabel(weekKey, anchorKey) {
  const number = weekNumberOf(weekKey, anchorKey)
  const range = weekRangeOf(weekKey)
  const prefix = number >= 1 ? `第 ${number} 周` : '未开学'
  if (range === null) return prefix
  return `${prefix} · ${shortDate(range.monday)}–${shortDate(range.sunday)}`
}

/**
 * 当前视图/操作的周上下文。`anchorMonday` 来自插件数据（配置没填学期起始时使用），
 * 保证「第 N 周」不会每周重新从 1 开始。
 */
function resolveWeekContext(offset, settings, board) {
  const normalized = normalizeOffset(offset)
  const key = weekKeyFromOffset(normalized)
  const range = weekRangeOf(key)
  const configured = settings !== null && typeof settings === 'object' ? settings.termStartDate : ''
  const anchorKey =
    typeof configured === 'string' && parseDateKey(configured) !== null
      ? configured
      : board !== null && typeof board === 'object'
        ? board.anchorMonday
        : currentWeekKey()
  const today = todayKey()
  return {
    offset: normalized,
    key,
    monday: range === null ? currentMonday() : range.monday,
    sunday: range === null ? addDays(currentMonday(), 6) : range.sunday,
    weekNumber: weekNumberOf(key, anchorKey),
    label: weekLabel(key, anchorKey),
    todayKey: today,
    todayWeekday: weekdayIndex(new Date(nowMs())),
    currentWeekKey: dateKeyOf(currentMonday()),
    isCurrent: key === dateKeyOf(currentMonday()),
  }
}

function isCurrentWeek(weekKey) {
  return weekKey === dateKeyOf(currentMonday())
}

/** 把日期键折算成相对当前周的偏移；超出 ±12 周返回 null。 */
function offsetOfDateKey(dateKey) {
  const date = parseDateKey(dateKey)
  if (date === null) return null
  const difference = Math.round((mondayOf(date).getTime() - currentMonday().getTime()) / DAY_MS / 7)
  if (difference < -12 || difference > 12) return null
  return difference
}

/** `8:00` / `08:00` → `08:00`；非法或空返回 ''。 */
function normalizeTime(value) {
  if (typeof value !== 'string') return ''
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (match === null) return ''
  return `${pad2(Number(match[1]))}:${match[2]}`
}

function isValidDateKey(value) {
  return parseDateKey(value) !== null
}

function nowTimeKey() {
  const now = new Date(nowMs())
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

module.exports = {
  DAY_MS,
  WEEKDAY_LABELS,
  nowMs,
  setNowForTests,
  resetNowForTests,
  pad2,
  startOfDay,
  dateKeyOf,
  parseDateKey,
  addDays,
  mondayOf,
  currentMonday,
  currentWeekKey,
  todayKey,
  dateLabel,
  todayLabel,
  dateKeyOfWeekday,
  weekKeyFromOffset,
  weekRangeOf,
  weekdayIndex,
  weekdayLabel,
  weekdayShort,
  weekdaysLabel,
  normalizeOffset,
  weekNumberOf,
  weekLabel,
  resolveWeekContext,
  isCurrentWeek,
  offsetOfDateKey,
  normalizeTime,
  isValidDateKey,
  nowTimeKey,
  shortDate,
}
