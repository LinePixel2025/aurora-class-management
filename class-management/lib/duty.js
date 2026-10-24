'use strict'

/** 值日轮换与「按天覆盖」的解析、格式化。 */

const { clip, splitNames } = require('./util')
const { weekdayLabel } = require('./time')

const AREA_MAX = 40
const NOTE_MAX = 60
const GROUP_NAME_MAX = 20

/**
 * 计算某一周的实际值日：
 * 1. 本周指定组（`week.duty.groupId`）优先；
 * 2. 否则按 `board.duty.order` 以「第 N 周」轮换；
 * 3. 某天有覆盖就用覆盖，否则周一至周五沿用轮换组名单；
 * 4. 周末默认不值日，只有显式覆盖才显示。
 */
function resolveDuty(board, weekKey, weekNumber) {
  const groups = Array.isArray(board.duty.groups) ? board.duty.groups : []
  const byId = new Map(groups.map((group) => [group.id, group]))
  const order = (Array.isArray(board.duty.order) ? board.duty.order : []).filter((id) => byId.has(id))
  const week = board.weeks !== null && typeof board.weeks === 'object' ? board.weeks[weekKey] : null
  const weekDuty = week !== null && week !== undefined && week.duty !== undefined ? week.duty : {}
  const overrideId =
    typeof weekDuty.groupId === 'string' && byId.has(weekDuty.groupId) ? weekDuty.groupId : ''

  let group = null
  if (overrideId !== '') {
    group = byId.get(overrideId)
  } else if (order.length > 0) {
    group = byId.get(order[(Math.max(1, weekNumber) - 1) % order.length])
  } else if (groups.length > 0) {
    group = groups[0]
  }

  const days = []
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const override =
      weekDuty.days !== null && typeof weekDuty.days === 'object'
        ? weekDuty.days[String(weekday)]
        : undefined
    let entry = null
    if (override !== undefined && override !== null) {
      entry = {
        weekday,
        label: weekdayLabel(weekday),
        names: Array.isArray(override.names) ? override.names.slice() : [],
        area: typeof override.area === 'string' ? override.area : '',
        note: typeof override.note === 'string' ? override.note : '',
        source: 'override',
      }
    } else if (weekday <= 5) {
      entry = {
        weekday,
        label: weekdayLabel(weekday),
        names: group !== null ? group.members.slice() : [],
        area: '',
        note: '',
        source: 'rotation',
      }
    }
    if (entry !== null) days.push(entry)
  }

  return {
    group,
    groupId: group !== null ? group.id : '',
    groupName: group !== null ? group.name : '未分组',
    days,
    note: typeof weekDuty.note === 'string' ? weekDuty.note : '',
    hasOverrideGroup: overrideId !== '',
    orderNames: order.map((id) => byId.get(id).name).filter(Boolean),
  }
}

function dutyOfWeekday(duty, weekday) {
  return duty.days.find((entry) => entry.weekday === weekday) || null
}

function todayDutyText(duty, todayWeekday) {
  const entry = dutyOfWeekday(duty, todayWeekday)
  if (entry === null || entry.names.length === 0) return ''
  const area = entry.area !== '' ? ` · ${entry.area}` : ''
  return `${entry.names.join(' ')}${area}`
}

function formatDutyPlanText(duty) {
  return duty.days
    .map((entry) => {
      const names = entry.names.join(' ')
      const parts = [names]
      if (entry.area !== '') parts.push(entry.area)
      if (entry.note !== '') parts.push(entry.note)
      return `${entry.label}: ${parts.join(' | ')}`.trimEnd()
    })
    .join('\n')
}

/** 只输出「按天覆盖」的文本，用于面板编辑；留空即沿用值日组。 */
function formatDutyOverrideText(week) {
  const days = week !== null && week !== undefined && week.duty !== undefined ? week.duty.days : {}
  const entries = Object.keys(days || {})
    .map(Number)
    .filter((day) => day >= 1 && day <= 7)
    .sort((left, right) => left - right)
  return entries
    .map((day) => {
      const entry = days[String(day)]
      const parts = [(entry.names || []).join(' ')]
      if (entry.area !== undefined && entry.area !== '') parts.push(entry.area)
      if (entry.note !== undefined && entry.note !== '') parts.push(entry.note)
      return `${weekdayLabel(day)}: ${parts.join(' | ')}`.trimEnd()
    })
    .join('\n')
}

function formatDutyGroupsText(board) {
  return board.duty.groups
    .map((group) => `${group.name}: ${group.members.join(', ')}`.trimEnd())
    .join('\n')
}

function formatOrderText(board) {
  const byId = new Map(board.duty.groups.map((group) => [group.id, group]))
  return board.duty.order
    .map((id) => (byId.has(id) ? byId.get(id).name : ''))
    .filter(Boolean)
    .join('，')
}

const DUTY_DAY_PATTERN = /^周([一二三四五六日天])\s*[:：]?\s*(.*)$/

function dayIndexFromLabel(value) {
  if (value === '天') return 7
  const index = '一二三四五六'.indexOf(value)
  return index < 0 ? 0 : index + 1
}

/**
 * 解析面板里的值日文本：
 * `周一: 张三 李四 | 教室 | 大扫除`；留空的行表示沿用值日组。
 */
function parseDutyPlanText(text) {
  const days = {}
  const issues = []
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^[-*·•]\s*/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    const match = DUTY_DAY_PATTERN.exec(line)
    if (match === null) {
      issues.push(`第 ${index + 1} 行看不懂：${clip(line, 24)}`)
      continue
    }
    const weekday = dayIndexFromLabel(match[1])
    if (weekday === 0) {
      issues.push(`第 ${index + 1} 行看不懂：${clip(line, 24)}`)
      continue
    }
    const parts = match[2]
      .split(/[|｜]/)
      .map((part) => part.trim())
    const names = splitNames(parts[0] === undefined ? '' : parts[0])
    const area = clip(parts[1], AREA_MAX)
    const note = clip(parts[2], NOTE_MAX)
    if (names.length === 0 && area === '' && note === '') continue
    days[String(weekday)] = { names, area, note }
  }
  return { days, issues }
}

function parseDutyGroupsText(text) {
  const groups = []
  const issues = []
  const names = new Set()
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[-*·•]\s*/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':') >= 0 ? line.indexOf(':') : line.indexOf('：')
    const rawName = separator >= 0 ? line.slice(0, separator) : line
    const rawMembers = separator >= 0 ? line.slice(separator + 1) : ''
    const name = clip(rawName, GROUP_NAME_MAX)
    if (name === '') {
      issues.push(`分组缺少名称：${clip(line, 24)}`)
      continue
    }
    if (names.has(name)) {
      issues.push(`分组名重复：${name}`)
      continue
    }
    names.add(name)
    groups.push({ name, members: splitNames(rawMembers) })
    if (groups.length >= 8) break
  }
  return { groups, issues }
}

function parseOrderText(text) {
  return splitNames(String(text === undefined || text === null ? '' : text).replace(/[，、]/g, ','))
    .map((name) => clip(name, GROUP_NAME_MAX))
    .filter(Boolean)
}

module.exports = {
  AREA_MAX,
  NOTE_MAX,
  GROUP_NAME_MAX,
  resolveDuty,
  dutyOfWeekday,
  todayDutyText,
  formatDutyPlanText,
  formatDutyOverrideText,
  formatDutyGroupsText,
  formatOrderText,
  parseDutyPlanText,
  parseDutyGroupsText,
  parseOrderText,
}
