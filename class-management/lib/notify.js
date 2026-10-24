'use strict'

/**
 * 可选系统通知引擎。
 *
 * 由 main 的 60 秒定时器调用 `checkNotifications`，按天 / 周 / 单条事务去重：
 * - 每日简报：到达 `notifyTime` 后每天最多一次；
 * - 周一值日：周一到达 `notifyTime` 后每周最多一次；
 * - 截止提醒：截止前 `notifyDueLead` 分钟提醒，每条事务每天最多一次，一次最多汇总 3 条。
 *
 * 去重状态单独存在 `notify.v1`，与业务数据 `board.v1` 解耦；通知失败只记 warn 并记录
 * 已尝试，避免每分钟重发；读取 board 等异常自然抛给 main 的定时器统一记录。
 */

const { clip } = require('./util')
const {
  nowMs,
  nowTimeKey,
  todayKey,
  weekKeyFromOffset,
  weekdayIndex,
  normalizeTime,
  parseDateKey,
} = require('./time')
const { readSettings } = require('./state')
const { loadWeek } = require('./ops')

const NOTIFY_KEY = 'notify.v1'
const TEXT_MAX = 40
const BODY_MAX = 200
const NOTE_MAX = 60
const DUE_BATCH_MAX = 3
const DEFAULT_DAILY_MINUTES = 7 * 60 + 30
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/** 净化通知状态；任何非法字段都回落到空值，保证写入始终可控。 */
function sanitizeNotifyState(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const due = {}
  if (source.due !== null && typeof source.due === 'object' && !Array.isArray(source.due)) {
    for (const [id, value] of Object.entries(source.due)) {
      if (!ID_PATTERN.test(id) || id === '__proto__') continue
      if (typeof value !== 'string' || parseDateKey(value) === null) continue
      due[id] = value.trim()
    }
  }
  return {
    dailyDate: clip(source.dailyDate, TEXT_MAX),
    dutyWeek: clip(source.dutyWeek, TEXT_MAX),
    due,
  }
}

/** 读取 `notify.v1`；缺失 / 损坏时返回净化后的空状态，**不写盘**。 */
async function readNotifyState(ctx) {
  const raw = await ctx.storage.get(NOTIFY_KEY)
  return sanitizeNotifyState(raw)
}

/** 净化后写入 `notify.v1`，返回实际落盘的形状。 */
async function writeNotifyState(ctx, state) {
  const clean = sanitizeNotifyState(state)
  await ctx.storage.set(NOTIFY_KEY, clean)
  return clean
}

/** `HH:mm` → 当天第几分钟（0–1439）；非法返回 null（与 time.normalizeTime 同口径）。 */
function timeToMinutes(value) {
  const normalized = normalizeTime(value)
  if (normalized === '') return null
  const [hour, minute] = normalized.split(':')
  return Number(hour) * 60 + Number(minute)
}

function countOf(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

/** 「第 1 组 · 张三、李四」；成员为空时只保留组名。 */
function dutyText(duty) {
  const source = duty !== null && typeof duty === 'object' ? duty : {}
  const name = clip(source.groupName, TEXT_MAX) || '未分组'
  const members = Array.isArray(source.members)
    ? source.members.map((member) => clip(member, 20)).filter((member) => member !== '')
    : []
  return members.length === 0 ? name : `${name} · ${members.join('、')}`
}

function dailyBody(data) {
  const source = data !== null && typeof data === 'object' ? data : {}
  const counts = source.counts !== null && typeof source.counts === 'object' ? source.counts : {}
  return clip(
    `待办 ${countOf(counts.pending)} 条 / 完成 ${countOf(counts.done)} 条；本周值日：${dutyText(source.duty)}`,
    BODY_MAX,
  )
}

function dutyBody(data) {
  const source = data !== null && typeof data === 'object' ? data : {}
  const duty = source.duty !== null && typeof source.duty === 'object' ? source.duty : {}
  const note = clip(duty.note, NOTE_MAX)
  const text = dutyText(duty)
  return clip(note === '' ? text : `${text}；备注：${note}`, BODY_MAX)
}

/**
 * 发送一条通知；返回 false 或抛错都只记 warn，不打断后续通知。
 * 调用方在 await 之后记录去重状态（“已尝试”即记录），避免每分钟重发。
 */
async function deliver(ctx, title, body) {
  try {
    const delivered = await ctx.notify({ title, body: clip(body, BODY_MAX) })
    if (delivered === false) {
      ctx.log('warn', '系统通知未送达', { title })
    }
  } catch (error) {
    ctx.log('warn', '系统通知发送失败', { title, error: String(error) })
  }
}

/**
 * 检查并发送当前到点的通知。三项配置全关时不读 board、不写存储；
 * `loadWeek` 等读取异常不在这里吞掉，交给 main 的定时器统一记日志。
 */
async function checkNotifications(ctx) {
  const settings = readSettings(ctx.config)
  if (!settings.notifyDaily && !settings.notifyDue && !settings.notifyDuty) return

  const today = todayKey()
  const nowMinutes = timeToMinutes(nowTimeKey())
  if (nowMinutes === null) return
  const configuredMinutes = timeToMinutes(settings.notifyTime)
  const reminderMinutes = configuredMinutes === null ? DEFAULT_DAILY_MINUTES : configuredMinutes
  const dueLead = Number.isFinite(Number(settings.notifyDueLead))
    ? Math.min(120, Math.max(0, Math.trunc(Number(settings.notifyDueLead))))
    : 10
  const weekday = weekdayIndex(new Date(nowMs()))
  const weekKey = weekKeyFromOffset(0)

  const notifyState = await readNotifyState(ctx)
  const before = JSON.stringify(notifyState)
  let data = null
  const ensureData = async () => {
    if (data === null) data = await loadWeek(ctx, 0)
    return data
  }

  if (
    settings.notifyDaily === true &&
    nowMinutes >= reminderMinutes &&
    notifyState.dailyDate !== today
  ) {
    await deliver(ctx, '今日班级事务', dailyBody(await ensureData()))
    notifyState.dailyDate = today
  }

  if (
    settings.notifyDuty === true &&
    weekday === 1 &&
    nowMinutes >= reminderMinutes &&
    notifyState.dutyWeek !== weekKey
  ) {
    await deliver(ctx, '本周值日', dutyBody(await ensureData()))
    notifyState.dutyWeek = weekKey
  }

  if (settings.notifyDue === true) {
    const info = await ensureData()
    const tasks = Array.isArray(info.tasks) ? info.tasks : []
    const picked = []
    for (const task of tasks) {
      if (picked.length >= DUE_BATCH_MAX) break
      if (task === null || typeof task !== 'object' || task.done === true) continue
      if (typeof task.id !== 'string' || !ID_PATTERN.test(task.id) || task.id === '__proto__') continue
      if (typeof task.dueTime !== 'string' || task.dueTime === '') continue
      const dueDate = typeof task.dueDate === 'string' ? task.dueDate : ''
      if (dueDate !== '' && dueDate !== today) continue
      if (notifyState.due[task.id] === today) continue
      const dueMinutes = timeToMinutes(task.dueTime)
      if (dueMinutes === null || nowMinutes < dueMinutes - dueLead) continue
      picked.push(task)
    }
    if (picked.length > 0) {
      const body = picked.map((task) => `${task.dueTime} ${clip(task.text, BODY_MAX)}`).join('；')
      await deliver(ctx, '事务即将截止', body)
      for (const task of picked) notifyState.due[task.id] = today
    }
  }

  const nextDue = {}
  for (const [id, date] of Object.entries(notifyState.due)) {
    if (date === today) nextDue[id] = date
  }
  notifyState.due = nextDue

  if (JSON.stringify(notifyState) !== before) {
    await writeNotifyState(ctx, notifyState)
  }
}

module.exports = {
  NOTIFY_KEY,
  readNotifyState,
  writeNotifyState,
  timeToMinutes,
  checkNotifications,
}
