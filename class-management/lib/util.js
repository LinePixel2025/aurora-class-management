'use strict'

/** 纯工具函数：文本净化、参数拆分、id 生成、优先级映射。 */

const NAME_MAX = 20

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** 单行文本：压缩换行/连续空白，并按字符数截断。 */
function clip(value, max) {
  const text = asString(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 多行文本：保留换行，只去首尾空白。 */
function clipMultiline(value, max) {
  const text = asString(value).trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 兼容数组 / 逗号 / 顿号 / 斜杠 / 空白分隔的姓名输入。 */
function splitNames(value) {
  const list = Array.isArray(value)
    ? value
    : asString(value).split(/[,，、/\s]+/)
  const names = []
  for (const item of list) {
    const name = clip(asString(item), NAME_MAX)
    if (name !== '' && !names.includes(name)) names.push(name)
    if (names.length >= 12) break
  }
  return names
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const PRIORITY_RANK = { high: 3, normal: 2, low: 1 }
const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低' }

function normalizePriority(value) {
  return value === 'high' || value === 'low' || value === 'normal' ? value : 'normal'
}

function priorityLabel(value) {
  return PRIORITY_LABEL[normalizePriority(value)]
}

function priorityRank(value) {
  return PRIORITY_RANK[normalizePriority(value)]
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6)
}

/** 生成包内唯一 id（前缀 + 时间 + 随机），避免与已有 id 冲突。 */
function makeId(prefix, existingIds) {
  const used = new Set(Array.isArray(existingIds) ? existingIds : [])
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `${prefix}${Date.now().toString(36)}${randomSuffix()}`
    if (!used.has(id)) return id
  }
  return `${prefix}${Date.now().toString(36)}${randomSuffix()}${randomSuffix()}`
}

/**
 * 宿主调用插件面板/小组件时，params 形状是 `{ params: <动作参数>, values: <输入绑定值> }`。
 * 这里统一拆开，避免各处理器各写一遍。
 */
function splitHostParams(params) {
  const raw = params !== null && typeof params === 'object' ? params : {}
  const actionParams = raw.params !== null && typeof raw.params === 'object' ? raw.params : {}
  const values = raw.values !== null && typeof raw.values === 'object' ? raw.values : {}
  return { actionParams, values }
}

function asInteger(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const integer = Math.trunc(number)
  if (integer < min || integer > max) return null
  return integer
}

function isoNow(nowMs) {
  return new Date(nowMs).toISOString()
}

module.exports = {
  NAME_MAX,
  asString,
  clip,
  clipMultiline,
  splitNames,
  byteLength,
  normalizePriority,
  priorityLabel,
  priorityRank,
  makeId,
  splitHostParams,
  asInteger,
  isoNow,
}
