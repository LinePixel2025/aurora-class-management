'use strict'

/**
 * 值日轮换：一周由一组负责，按 `board.duty.order` 以「第 N 周」轮换。
 * 不支持按天覆盖；某周可临时指定 groupId 并写备注。
 */

const { clip, splitNames } = require('./util')

const AREA_MAX = 40
const NOTE_MAX = 60
const GROUP_NAME_MAX = 20

/**
 * 计算某一周的实际值日组：
 * 1. 本周指定组（`week.duty.groupId`）优先；
 * 2. 否则按 `board.duty.order` 以「第 N 周」轮换；
 * 3. 分组或轮换顺序为空时回退到第一个组。
 */
function resolveDuty(board, weekKey, weekNumber) {
  const groups = Array.isArray(board.duty.groups) ? board.duty.groups : []
  const byId = new Map(groups.map((group) => [group.id, group]))
  const order = (Array.isArray(board.duty.order) ? board.duty.order : []).filter((id) => byId.has(id))
  const week = board.weeks !== null && typeof board.weeks === 'object' ? board.weeks[weekKey] : null
  const weekDuty =
    week !== null && week !== undefined && week.duty !== null && typeof week.duty === 'object'
      ? week.duty
      : {}
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

  return {
    group,
    groupId: group !== null ? group.id : '',
    groupName: group !== null ? group.name : '未分组',
    members: group !== null && Array.isArray(group.members) ? group.members.slice() : [],
    note: typeof weekDuty.note === 'string' ? weekDuty.note : '',
    hasOverrideGroup: overrideId !== '',
    orderNames: order.map((id) => byId.get(id).name).filter(Boolean),
    orderIds: order,
  }
}

/** 只输出「分组与成员」的文本，用于面板编辑。 */
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
  formatDutyGroupsText,
  formatOrderText,
  parseDutyGroupsText,
  parseOrderText,
}
