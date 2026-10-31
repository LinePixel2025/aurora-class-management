#!/usr/bin/env node
'use strict'

/**
 * 离线全链路测试（零依赖）· v2.1.0「页面化重构」。
 *
 * - mock 宿主 ctx，页面型面板 / 页面型小组件的 params 是**直接对象**（不再套 `{ params, values }`）；
 * - 保留 v2.0.0 有效检查：时间、存储与串行写、旧数据迁移、7 天历史清理、整周值日、
 *   13 个 Agent 工具、3 条命令、推送目标 / 条数（2 面板 + 2 小组件 = 4 条）、跨天 / 跨周刷新、
 *   可选通知（每日简报 / 截止提醒 / 周一值日 / 安排到点前提醒 / 去重 / 重启不重发）、整周计划回滚、容量修剪、
 *   宿主原版 zod 清单解析；
 * - 新增 v2.1.0 检查：清单页面化（2 面板 + 2 桌面小组件 entry，无 schema）、页面静态约束
 *   （无内联脚本 / 内联事件 / fetch / localStorage / 外链，相对资源存在）、班级事务台页面 API
 *   （load 契约 + 四视图 + 全部写动作 + 过去周只读 + 推送）、班级周历 isPast/canEdit/canAddTask
 *   与本周过去天可删除、桌面小组件 load/add/toggle/delete 与推送。
 *
 * 运行：node dev/test-plugin.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const PLUGIN = path.join(ROOT, 'class-management')
const main = require(path.join(PLUGIN, 'main.js'))
const timeLib = require(path.join(PLUGIN, 'lib', 'time.js'))
const stateLib = require(path.join(PLUGIN, 'lib', 'state.js'))

const PLUGIN_ID = 'com.classmanagement.board'
const PANEL_ID = 'board'
const CALENDAR_PANEL_ID = 'calendar'
const PANEL_IDS = [PANEL_ID, CALENDAR_PANEL_ID]
const WIDGETS = ['week-overview', 'week-tasks']
const EVENT = 'board.changed'
const TODAY = '2026-10-21'
const BASE_NOW = new Date(2026, 9, 21, 10, 0, 0, 0) // 2026-10-21（周三）10:00，本地时区

const PAGE_GROUPS = {
  board: ['ui/board.html', 'ui/board.css', 'ui/board.js'],
  calendar: ['ui/calendar.html', 'ui/calendar.css', 'ui/calendar.js'],
  widgets: [
    'ui/widget-overview.html',
    'ui/widget-overview.js',
    'ui/widget-tasks.html',
    'ui/widget-tasks.js',
    'ui/widget.css',
  ],
}
const PAGE_HTMLS = ['ui/board.html', 'ui/calendar.html', 'ui/widget-overview.html', 'ui/widget-tasks.html']
const PAGE_JSES = ['ui/board.js', 'ui/calendar.js', 'ui/widget-overview.js', 'ui/widget-tasks.js']
const PAGE_CSSES = ['ui/board.css', 'ui/calendar.css', 'ui/widget.css']

const results = { checks: 0, failures: [] }

function header(title) {
  process.stdout.write(`\n── ${title} ──\n`)
}

function ok(label) {
  results.checks += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

function fail(label, error) {
  results.checks += 1
  results.failures.push({ label, error })
  process.stdout.write(
    `  ✗ ${label}\n      ${String(error && error.stack ? error.stack.split('\n')[0] : error)}\n`,
  )
}

async function test(label, fn) {
  try {
    await fn()
    ok(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// ───────────────────────── 宿主清单解析器 ─────────────────────────

const HOST_CACHE = path.join(__dirname, '.cache', 'host')

function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const headerBuffer = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuffer, 0, headerSize, 16)
  return {
    fd,
    index: JSON.parse(headerBuffer.toString('utf8')),
    dataStart: 16 + Math.ceil(headerSize / 4) * 4,
  }
}

function readOpenAsarEntry(handle, parts) {
  let node = handle.index
  for (const part of parts) {
    if (!node.files || node.files[part] === undefined) return null
    node = node.files[part]
  }
  if (node.files !== undefined) return null
  const buffer = Buffer.alloc(Number(node.size))
  fs.readSync(handle.fd, buffer, 0, Number(node.size), handle.dataStart + Number(node.offset))
  return buffer
}

function walkAsarFiles(node, parts, out, filter) {
  for (const [name, value] of Object.entries(node.files || {})) {
    const next = [...parts, name]
    if (value.files) walkAsarFiles(value, next, out, filter)
    else if (filter(next)) out.push({ parts: next, entry: value })
  }
}

/**
 * 用宿主安装器同一份 zod schema 解析清单（比任何离线近似校验都严格）。
 * 做法：从 app.asar 提取 @aurora/shared/dist/plugin + zod v3 到 dev/.cache/host，
 * 再按宿主的相对导入关系动态 import。找不到 Aurora 时返回 null。
 */
async function loadHostManifestParser() {
  const asarPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Aurora', 'resources', 'app.asar')
    : ''
  if (asarPath === '' || !fs.existsSync(asarPath)) return null
  const handle = openAsar(asarPath)
  try {
    const entries = []
    const zodRoot = handle.index.files.node_modules.files.zod
    if (zodRoot === undefined) return null
    walkAsarFiles(zodRoot, ['node_modules', 'zod'], entries, (parts) => {
      const name = parts[parts.length - 1]
      return (
        !parts.includes('src') &&
        !name.endsWith('.d.ts') &&
        !name.endsWith('.cts') &&
        !name.endsWith('.mts') &&
        (name.endsWith('.js') || name.endsWith('.json'))
      )
    })
    const sharedRoot = handle.index.files.node_modules.files['@aurora'].files.shared.files.dist.files.plugin
    walkAsarFiles(sharedRoot, ['node_modules', '@aurora', 'shared', 'dist', 'plugin'], entries, (parts) =>
      parts[parts.length - 1].endsWith('.js'),
    )

    fs.rmSync(HOST_CACHE, { recursive: true, force: true })
    fs.mkdirSync(HOST_CACHE, { recursive: true })
    fs.writeFileSync(
      path.join(HOST_CACHE, 'package.json'),
      JSON.stringify({ name: 'aurora-host-validation', private: true, type: 'module' }),
    )
    for (const { parts } of entries) {
      const buffer = readOpenAsarEntry(handle, parts)
      if (buffer === null) continue
      const target =
        parts[1] === 'zod'
          ? path.join(HOST_CACHE, 'node_modules', 'zod', ...parts.slice(2))
          : path.join(HOST_CACHE, 'shared', 'plugin', parts[parts.length - 1])
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer)
    }
    // 用自己的 ESM 入口覆盖 zod 的 package.json（宿主也是 ESM 导入 z.record 等 API）
    fs.writeFileSync(
      path.join(HOST_CACHE, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: '3.25.76', type: 'module', main: './index.js', exports: './index.js' }),
    )
    const module = await import(
      pathToFileURL(path.join(HOST_CACHE, 'shared', 'plugin', 'manifest.js')).href
    )
    return typeof module.parsePluginManifest === 'function' ? module.parsePluginManifest : null
  } catch (error) {
    process.stdout.write(`  ! 宿主清单解析器加载失败：${String(error)}\n`)
    return null
  } finally {
    fs.closeSync(handle.fd)
  }
}

// ───────────────────────── mock 宿主 ─────────────────────────

function createContext(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const store = new Map()
  const pushes = []
  const logs = []
  const opened = []
  const toasts = []
  const notifications = []
  const banners = []
  // 宿主 notify() / banner() 的返回值；默认成功，false 用于覆盖投递失败路径
  const notifyResult = settings.notifyResult !== false
  const bannerResult = settings.bannerResult !== false
  const config = {
    className: '高二(15)班',
    teacher: '王老师',
    termStartDate: '',
    showCompleted: false,
    notifyDaily: false,
    notifyTime: '07:30',
    notifyDue: false,
    notifyDueLead: 10,
    notifyDuty: false,
    notifySchedule: false,
    notifyScheduleLead: 10,
    ...(settings.config || {}),
  }
  const ctx = {
    plugin: { id: PLUGIN_ID, version: '2.2.1', root: PLUGIN, dataDir: PLUGIN, isDev: true },
    config,
    storage: {
      async get(key) {
        return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined
      },
      async set(key, value) {
        const json = JSON.stringify(value)
        assert(Buffer.byteLength(json, 'utf8') <= 256 * 1024, `单个存储值超过 256 KB：${key}`)
        store.set(key, JSON.parse(json))
      },
      async delete(key) {
        store.delete(key)
      },
      async list() {
        return [...store.keys()]
      },
    },
    net: {
      async fetch() {
        throw new Error('测试中不允许联网')
      },
    },
    notify: async (payload) => {
      const input = payload !== null && typeof payload === 'object' ? payload : {}
      notifications.push({ title: input.title, body: input.body })
      return notifyResult
    },
    // 流光提醒是 Aurora 0.5.6+ 能力；noBanner 用来模拟旧宿主（没有 ctx.banner）
    ...(settings.noBanner === true
      ? {}
      : {
          banner: async (payload) => {
            const input = payload !== null && typeof payload === 'object' ? payload : {}
            banners.push({ title: input.title, body: input.body, speak: input.speak })
            return bannerResult
          },
        }),
    log(level, message, detail) {
      logs.push({ level, message, detail })
    },
    emitEvent: async () => {},
    ui: {
      async openPanel(id) {
        opened.push(id)
      },
      async toast(message) {
        toasts.push(message)
      },
      async panelEvent(input) {
        pushes.push(JSON.parse(JSON.stringify(input)))
      },
    },
    signal: new AbortController().signal,
  }
  return { ctx, store, pushes, logs, opened, toasts, notifications, banners }
}

function pushCount(env) {
  return env.pushes.length
}

function assertPushInvariants(env, since, label) {
  const slice = env.pushes.slice(since)
  for (const push of slice) {
    const targetKeys = ['panelId', 'widgetId'].filter((key) => push[key] !== undefined)
    assertEqual(targetKeys.length, 1, `${label} 推送必须 panelId / widgetId 二选一`)
    if (push.panelId !== undefined) {
      assert(PANEL_IDS.includes(push.panelId), `${label} 面板目标非法：${push.panelId}`)
    }
    if (push.widgetId !== undefined) {
      assert(WIDGETS.includes(push.widgetId), `${label} 小组件目标非法：${push.widgetId}`)
    }
    assert(/^[a-z][a-z0-9_.-]{0,63}$/.test(push.event), `${label} 事件名非法：${push.event}`)
    assert(bytes(push.payload ?? null) <= 64 * 1024, `${label} payload 超过 64 KB`)
  }
  assert(slice.length <= 5, `${label} 一次变更推送超过 5 条：${slice.length}`)
}

/** pushAll 固定推 4 条：2 个面板（board + calendar）+ 2 个小组件，低于宿主 5 条上限。 */
function assertPushAllSlice(env, since, label) {
  assertPushInvariants(env, since, label)
  const slice = env.pushes.slice(since)
  assertEqual(slice.length, 4, `${label} 应推送 4 条（2 面板 + 2 小组件），实际 ${slice.length}`)
  const panelIds = slice.filter((push) => push.panelId !== undefined).map((push) => push.panelId).sort()
  const widgetIds = slice.filter((push) => push.widgetId !== undefined).map((push) => push.widgetId).sort()
  assertEqual(panelIds.join(','), PANEL_IDS.slice().sort().join(','), `${label} 面板推送应覆盖 board 与 calendar`)
  assertEqual(widgetIds.join(','), WIDGETS.slice().sort().join(','), `${label} 小组件推送应覆盖 2 个小组件`)
  for (const push of slice) assertEqual(push.event, EVENT, `${label} 推送事件名应为 ${EVENT}`)
  return slice
}

function assertNoPush(env, since, label) {
  assertEqual(pushCount(env), since, `${label} 不应产生推送`)
}

async function withEnv(options, fn) {
  main.__test.setNow(BASE_NOW.getTime())
  const env = createContext(options)
  await main.activate(env.ctx)
  try {
    return await fn(env)
  } finally {
    await main.deactivate()
  }
}

async function withSeededEnv(seed, fn) {
  main.__test.setNow(BASE_NOW.getTime())
  const env = createContext()
  for (const [key, value] of Object.entries(seed || {})) {
    await env.ctx.storage.set(key, value)
  }
  await main.activate(env.ctx)
  try {
    return await fn(env)
  } finally {
    await main.deactivate()
  }
}

function invokeTool(env, name, input) {
  return main.invokeTool(name, input, env.ctx)
}

function invokeCommand(env, name, args) {
  return main.invokeCommand(name, args || '', env.ctx)
}

function invokePanelRaw(env, panelId, method, params) {
  return main.invokePanel(panelId, method, params !== null && typeof params === 'object' ? params : {}, env.ctx)
}

// ───────────────────────── 页面型班级事务台 helper ─────────────────────────

/** 页面型面板的 params 是直接对象，不要再套 `{ params, values }`。 */
function invokeBoard(env, method, params) {
  return invokePanelRaw(env, PANEL_ID, method, params)
}

function expectBoardOk(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assertEqual(result.error, undefined, `${label} 失败：${result.error}`)
  assert(result.data !== null && typeof result.data === 'object', `${label} 缺少最新数据 data`)
  return result.data
}

/** 失败返回 `{ data, error }`：既要有 error，也要带最新数据供页面回填。 */
function expectBoardError(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assert(
    typeof result.error === 'string' && result.error !== '',
    `${label} 应返回 error，实际：${JSON.stringify(result)}`,
  )
  assert(result.data !== null && typeof result.data === 'object', `${label} 失败时应返回最新数据 data`)
  return result.data
}

async function loadBoard(env, params) {
  return expectBoardOk(await invokeBoard(env, 'load', params), `board load ${JSON.stringify(params || {})}`)
}

async function saveBoardView(env, view, weekOffset) {
  const params = weekOffset === undefined ? { view } : { view, weekOffset }
  return expectBoardOk(await invokeBoard(env, 'save-view', params), `board save-view ${view}`)
}

function boardTaskByText(data, text) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  return tasks.find((task) => task.text === text) || null
}

function boardScheduleByTitle(data, title) {
  const schedule = Array.isArray(data.schedule) ? data.schedule : []
  return schedule.find((entry) => entry.title === title) || null
}

// ───────────────────────── 页面型班级周历 helper ─────────────────────────

function invokeCalendar(env, method, params) {
  return invokePanelRaw(env, CALENDAR_PANEL_ID, method, params)
}

function expectCalendarOk(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assertEqual(result.error, undefined, `${label} 失败：${result.error}`)
  assert(result.data !== null && typeof result.data === 'object', `${label} 缺少最新数据 data`)
  return result.data
}

function expectCalendarError(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assert(
    typeof result.error === 'string' && result.error !== '',
    `${label} 应返回 error，实际：${JSON.stringify(result)}`,
  )
  assert(result.data !== null && typeof result.data === 'object', `${label} 失败时应返回最新数据 data`)
  return result.data
}

async function loadCalendar(env, params) {
  return expectCalendarOk(await invokeCalendar(env, 'load', params), 'calendar load')
}

function calendarDayOf(data, date) {
  assert(Array.isArray(data.days), 'calendar data.days 不是数组')
  const day = data.days.find((item) => item.date === date)
  assert(day !== undefined, `calendar data.days 缺少日期 ${date}`)
  return day
}

function calendarTaskById(data, id) {
  for (const day of data.days || []) {
    const task = day.tasks.find((item) => item.id === id)
    if (task !== undefined) return task
  }
  return null
}

function calendarTaskByText(data, text) {
  for (const day of data.days || []) {
    const task = day.tasks.find((item) => item.text === text)
    if (task !== undefined) return task
  }
  return null
}

function calendarScheduleById(data, id) {
  for (const day of data.days || []) {
    const entry = day.schedule.find((item) => item.id === id)
    if (entry !== undefined) return entry
  }
  return null
}

// ───────────────────────── 页面型桌面小组件 helper ─────────────────────────

function invokeWidget(env, widgetId, method, params) {
  return main.invokeWidget(widgetId, method, params !== null && typeof params === 'object' ? params : {}, env.ctx)
}

function expectWidgetOk(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assertEqual(result.error, undefined, `${label} 失败：${result.error}`)
  assert(result.data !== null && typeof result.data === 'object', `${label} 缺少最新数据 data`)
  return result.data
}

function expectWidgetError(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assert(
    typeof result.error === 'string' && result.error !== '',
    `${label} 应返回 error，实际：${JSON.stringify(result)}`,
  )
  assert(result.data !== null && typeof result.data === 'object', `${label} 失败时应返回最新数据 data`)
  return result.data
}

async function loadWidget(env, widgetId) {
  return expectWidgetOk(await invokeWidget(env, widgetId, 'load', {}), `widget ${widgetId} load`)
}

function widgetTaskByText(data, text) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  return tasks.find((task) => task.text === text) || null
}

function widgetTaskById(data, id) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  return tasks.find((task) => task.id === id) || null
}

/** TaskSummary 严格契约：核心字段 + dueLabel 字符串 + overdue 布尔。 */
function assertTaskSummary(task, label) {
  assert(task !== null && typeof task === 'object', `${label} task 不是对象`)
  for (const key of ['id', 'text', 'date', 'priority', 'category', 'dueDate', 'dueTime', 'assignee', 'createdAt']) {
    assert(hasOwn(task, key), `${label} 事务缺少字段 ${key}`)
  }
  assert(typeof task.id === 'string' && task.id !== '', `${label} 事务 id 非法`)
  assert(typeof task.text === 'string' && task.text !== '', `${label} 事务 text 非法`)
  assert(typeof task.done === 'boolean', `${label} 事务 done 应为布尔`)
  assert(typeof task.dueLabel === 'string', `${label} 事务 dueLabel 应为字符串`)
  assert(typeof task.overdue === 'boolean', `${label} 事务 overdue 应为布尔`)
}

function assertWidgetShape(data, widgetId, label) {
  assertEqual(data.widgetId, widgetId, `${label} widgetId 错误`)
  assert(typeof data.className === 'string', `${label} className 应为字符串`)
  assert(typeof data.teacher === 'string', `${label} teacher 应为字符串`)
  assert(typeof data.weekLabel === 'string' && data.weekLabel !== '', `${label} weekLabel 缺失`)
  assert(typeof data.weekRange === 'string' && data.weekRange !== '', `${label} weekRange 缺失`)
  assert(Number.isInteger(data.weekNumber) && data.weekNumber >= 1, `${label} weekNumber 非法：${data.weekNumber}`)
  assertEqual(data.today, TODAY, `${label} today 错误`)
  assertEqual(data.todayLabel, '10/21 周三', `${label} todayLabel 错误`)
  assertEqual(data.taskDateLabel, data.todayLabel, `${label} taskDateLabel 应与 todayLabel 一致（v2.0 口径）`)
  assertEqual(data.todayWeekday, 3, `${label} todayWeekday 错误`)
  assert(data.counts !== null && typeof data.counts === 'object', `${label} counts 缺失`)
  for (const key of ['total', 'pending', 'done', 'high', 'overdue']) {
    assert(Number.isInteger(data.counts[key]) && data.counts[key] >= 0, `${label} counts.${key} 非法`)
  }
  assert(
    Number.isInteger(data.completion) && data.completion >= 0 && data.completion <= 100,
    `${label} completion 非法：${data.completion}`,
  )
  assert(Array.isArray(data.tasks), `${label} tasks 应为数组`)
  assert(Array.isArray(data.schedule), `${label} schedule 应为数组`)
  assert(Number.isInteger(data.scheduleCount), `${label} scheduleCount 应为整数`)
  assertEqual(data.scheduleCount, data.schedule.length, `${label} scheduleCount 与 schedule 长度不一致`)
  assert(data.duty !== null && typeof data.duty === 'object', `${label} duty 缺失`)
  assert(typeof data.duty.groupName === 'string' && data.duty.groupName !== '', `${label} duty.groupName 缺失`)
  assert(Array.isArray(data.duty.members), `${label} duty.members 应为数组`)
  assert(typeof data.duty.note === 'string', `${label} duty.note 应为字符串`)
  assert(typeof data.announcement === 'string', `${label} announcement 应为字符串`)
  assert(typeof data.showCompleted === 'boolean', `${label} showCompleted 应为布尔`)
  for (const task of data.tasks) assertTaskSummary(task, label)
}

// ───────────────────────── 页面静态检查 helper ─────────────────────────

function readPageFile(relativePath) {
  const file = path.join(PLUGIN, relativePath)
  assert(fs.existsSync(file), `缺少页面文件：${relativePath}`)
  const text = fs.readFileSync(file, 'utf8')
  assert(text.trim() !== '', `页面文件为空：${relativePath}`)
  return text
}

/** 去掉注释后再做「禁止 token」扫描：注释里提到 localStorage 不算违规，代码里用才算。 */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1 ')
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function assertNoOutsideAccess(relativePath, kind) {
  const raw = readPageFile(relativePath)
  const code = kind === 'js' ? stripJsComments(raw) : stripCssComments(raw)
  assert(!/\bfetch\s*\(/.test(code), `${relativePath} 不应调用 fetch(`)
  assert(!/XMLHttpRequest/.test(code), `${relativePath} 不应使用 XMLHttpRequest`)
  assert(!/\blocalStorage\b/.test(code), `${relativePath} 不应访问 localStorage`)
  assert(!/\bsessionStorage\b/.test(code), `${relativePath} 不应访问 sessionStorage`)
  assert(!/https?:\/\//i.test(code), `${relativePath} 不应包含 http(s) 外链`)
  if (kind === 'js') assert(!/\beval\s*\(/.test(code), `${relativePath} 不应调用 eval(`)
}

function assertPageRpc(relativePath) {
  const js = readPageFile(relativePath)
  assert(js.includes('auroraPlugin.request'), `${relativePath} 缺少 auroraPlugin.request`)
  assert(js.includes('auroraPlugin.onEvent'), `${relativePath} 缺少 auroraPlugin.onEvent`)
  // 宿主 preload 的签名是 onEvent(listener(event, payload))；字符串首参 + handler 的旧写法不会生效。
  assert(
    /onEvent\(\s*function\s*\(/.test(js) || /onEvent\(\s*\([^)]*\)\s*=>/.test(js),
    `${relativePath} 未以 listener 形式调用 auroraPlugin.onEvent`,
  )
  assert(!/onEvent\(\s*['"]/.test(js), `${relativePath} 不应使用 onEvent("board.changed", handler) 字符串首参形式`)
  assert(js.includes('board.changed'), `${relativePath} 未监听 board.changed 推送事件`)
}

// ───────────────────────── 测试主体 ─────────────────────────

function allTasksOf(env) {
  const board = env.store.get('board.v1')
  if (board === undefined) return []
  return Object.values(board.weeks).flatMap((week) => week.tasks)
}

function taskByText(env, text) {
  return allTasksOf(env).find((task) => task.text === text) || null
}

function seedTask(id, date, text) {
  return {
    id,
    text,
    done: false,
    date,
    priority: 'normal',
    category: '事务',
    dueDate: '',
    dueTime: '',
    assignee: '',
    createdAt: '2026-10-19T00:00:00.000Z',
  }
}

function seedSchedule(id, weekday, title) {
  return {
    id,
    weekday,
    time: '08:00',
    title,
    place: '',
    note: '',
    createdAt: '2026-10-19T00:00:00.000Z',
  }
}

function seedWeek(tasks, schedule) {
  return {
    duty: {},
    tasks,
    schedule: schedule || [],
    announcement: '',
    updatedAt: '2026-10-19T00:00:00.000Z',
  }
}

/** 目标周（2026-10-26 那周）已塞满 80 条事务、源周有 1 条待移动事务的种子板。 */
function capacityBoard() {
  const fullWeekTasks = Array.from({ length: 80 }, (_, index) =>
    seedTask(`tfill${index + 1}`, '2026-10-26', `目标周填充 ${index + 1}`),
  )
  return {
    version: stateLib.BOARD_VERSION,
    anchorMonday: '2026-10-19',
    duty: { groups: stateLib.seedGroups(), order: ['g1', 'g2', 'g3', 'g4'] },
    weeks: {
      '2026-10-19': seedWeek([seedTask('tmove', '2026-10-21', '容量移动源事务')]),
      '2026-10-26': seedWeek(fullWeekTasks),
    },
  }
}

/** 固定时钟 + 未激活的 context：避免 activate 立即补发通知污染“只发一次”断言。 */
function atTime(date, config) {
  main.__test.setNow(date.getTime())
  return createContext({ config })
}

async function checkNotifications(env) {
  if (typeof main.__test.checkNotifications !== 'function') {
    throw new Error('main.__test.checkNotifications 尚未实现（等实现分片就绪后复跑）')
  }
  await main.__test.checkNotifications(env.ctx)
}

async function addTask(env, input) {
  const result = await invokeTool(env, 'add_task', input)
  assertEqual(result.isError, undefined, `预置事务失败：${result.content}`)
  return result
}

async function addSchedule(env, input) {
  const result = await invokeTool(env, 'add_schedule', input)
  assertEqual(result.isError, undefined, `预置安排失败：${result.content}`)
  return result
}

async function mainTest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'))
  const hostManifestParser = await loadHostManifestParser()
  process.stdout.write(
    `清单解析器：${hostManifestParser === null ? '未找到 Aurora（跳过宿主 zod 解析）' : 'Aurora 宿主原版 zod schema'}\n`,
  )

  // ═════════════════════════ 清单 ═════════════════════════

  header('清单与页面化声明')
  await test('清单基础字段（版本 2.2.1 / 入口 / 激活方式）', async () => {
    assertEqual(manifest.id, PLUGIN_ID)
    assertEqual(manifest.version, '2.2.1')
    assertEqual(manifest.apiVersion, 1)
    assertEqual(manifest.minAuroraVersion, '0.5.3')
    assertEqual(manifest.main, 'main.js')
    assertEqual(manifest.activation, 'startup')
    assertEqual(manifest.license, 'MIT')
    assert(manifest.description.length <= 300, 'description 超过 300')
    assert(fs.existsSync(path.join(PLUGIN, 'main.js')), '缺少 main.js')
  })
  await test('权限最小集（含 notifications，无多余权限）', async () => {
    const expected = [
      'tools',
      'skills',
      'commands',
      'storage',
      'config',
      'logging',
      'ui.panels',
      'ui.widgets',
      'notifications',
    ]
    assertEqual([...manifest.permissions].sort().join(','), [...expected].sort().join(','))
  })
  await test('工具数量与命名/参数/只读标记（13 个不变）', async () => {
    assertEqual(manifest.contributes.tools.length, 13)
    const expectedNames = [
      'add_schedule',
      'add_task',
      'apply_week_plan',
      'complete_task',
      'delete_schedule',
      'delete_task',
      'get_overview',
      'list_tasks',
      'set_announcement',
      'set_duty_groups',
      'set_duty_week',
      'set_routines',
      'update_task',
    ]
    const names = new Set()
    for (const tool of manifest.contributes.tools) {
      assert(/^[a-z][a-z0-9_]{0,24}$/.test(tool.name), `工具名非法：${tool.name}`)
      assert(!names.has(tool.name), `工具名重复：${tool.name}`)
      names.add(tool.name)
      assert(`plugin.${PLUGIN_ID}.${tool.name}`.length <= 64, `最终工具名过长：${tool.name}`)
      assertEqual(tool.parameters.type, 'object', `${tool.name} 参数不是 object`)
      assert(tool.description.length > 0 && tool.description.length <= 500, `${tool.name} 描述过长`)
      assertEqual(tool.sensitivity, tool.readonly === true ? 'safe' : 'confirm', `${tool.name} 敏感度与只读标记不一致`)
    }
    assertEqual([...names].sort().join(','), expectedNames.slice().sort().join(','))
    assert(!names.has('set_duty_day'), '按天值日工具应已删除')
    const readonly = manifest.contributes.tools.filter((tool) => tool.readonly === true).map((tool) => tool.name)
    assertEqual(readonly.sort().join(','), ['get_overview', 'list_tasks'].sort().join(','))
  })
  await test('命令 3 个（class / week-plan / calendar，模式正确）', async () => {
    assertEqual(manifest.contributes.commands.length, 3)
    const byName = new Map(manifest.contributes.commands.map((command) => [command.name, command]))
    assertEqual([...byName.keys()].sort().join(','), ['class', 'week-plan', 'calendar'].sort().join(','))
    assertEqual(byName.get('class').mode, 'action', '/class 应为 action')
    assertEqual(byName.get('calendar').mode, 'action', '/calendar 应为 action')
    assertEqual(byName.get('week-plan').mode, 'prompt', '/week-plan 应为 prompt')
    for (const command of manifest.contributes.commands) {
      assert(typeof command.title === 'string' && command.title !== '', `${command.name} 缺少标题`)
      assert(typeof command.description === 'string' && command.description !== '', `${command.name} 缺少描述`)
    }
  })
  await test('配置字段 11 个（含通知相关项）', async () => {
    const keys = manifest.config.fields.map((field) => field.key)
    assertEqual(keys.length, 11)
    const expected = [
      'className',
      'teacher',
      'termStartDate',
      'showCompleted',
      'notifyDaily',
      'notifyTime',
      'notifyDue',
      'notifyDueLead',
      'notifyDuty',
      'notifySchedule',
      'notifyScheduleLead',
    ]
    assertEqual([...keys].sort().join(','), expected.slice().sort().join(','))
    for (const field of manifest.config.fields) {
      assert(typeof field.label === 'string' && field.label !== '', `${field.key} 缺少 label`)
      assert(
        ['text', 'boolean', 'number', 'select'].includes(field.type),
        `${field.key} 类型非法：${field.type}`,
      )
    }
  })
  await test('Skill 声明与 SKILL.md 存在', async () => {
    assert(Array.isArray(manifest.contributes.skills) && manifest.contributes.skills.length >= 1, '缺少 skills 声明')
    assertEqual(manifest.contributes.skills[0], 'skills/class-board')
    assert(fs.existsSync(path.join(PLUGIN, 'skills', 'class-board', 'SKILL.md')), '缺少 SKILL.md')
  })
  await test('面板 2 个均为页面型（board / calendar 的 entry）', async () => {
    assertEqual(manifest.contributes.panels.length, 2)
    const board = manifest.contributes.panels.find((panel) => panel.id === PANEL_ID)
    const calendar = manifest.contributes.panels.find((panel) => panel.id === CALENDAR_PANEL_ID)
    assert(board !== undefined, '缺少 board 面板')
    assert(calendar !== undefined, '缺少 calendar 面板')
    assertEqual(board.entry, 'ui/board.html', 'board 面板 entry 应为 ui/board.html')
    assertEqual(calendar.entry, 'ui/calendar.html', 'calendar 面板 entry 应为 ui/calendar.html')
    for (const panel of [board, calendar]) {
      assert(!hasOwn(panel, 'schema'), `${panel.id} 面板不应再声明 schema（已页面化）`)
      assert(typeof panel.title === 'string' && panel.title !== '', `${panel.id} 面板缺少标题`)
      assert(typeof panel.icon === 'string' && panel.icon !== '', `${panel.id} 面板缺少图标`)
    }
    assertEqual(
      manifest.contributes.panels.map((panel) => panel.id).sort().join(','),
      PANEL_IDS.slice().sort().join(','),
    )
  })
  await test('桌面小组件 2 个均为页面型（entry + desktop + material none）', async () => {
    assertEqual(manifest.contributes.widgets.length, 2)
    for (const widget of manifest.contributes.widgets) {
      assert(WIDGETS.includes(widget.id), `小组件 id 非法：${widget.id}`)
      assertEqual(widget.slot, 'desktop', `${widget.id} slot 应为 desktop`)
      assertEqual(widget.windowLevel, 'desktop', `${widget.id} windowLevel 应为 desktop`)
      assertEqual(widget.windowMaterial, 'none', `${widget.id} windowMaterial 应为 none（已去掉毛玻璃）`)
      assertEqual(widget.hideCloseButton, true, `${widget.id} 应隐藏宿主右上角关闭按钮`)
      assert(typeof widget.entry === 'string' && widget.entry.startsWith('ui/') && widget.entry.endsWith('.html'), `${widget.id} 应声明 entry 页面`)
      assert(!hasOwn(widget, 'schema'), `${widget.id} 不应再声明 schema（已页面化）`)
      assert(typeof widget.title === 'string' && widget.title !== '', `${widget.id} 缺少标题`)
      assert(typeof widget.icon === 'string' && widget.icon !== '', `${widget.id} 缺少图标`)
      assert(widget.defaultSize.width >= 120 && widget.defaultSize.width <= 1200, `${widget.id} 宽度越界`)
      assert(widget.defaultSize.height >= 80 && widget.defaultSize.height <= 900, `${widget.id} 高度越界`)
    }
    assertEqual(
      manifest.contributes.widgets.map((widget) => widget.id).sort().join(','),
      WIDGETS.slice().sort().join(','),
    )
    const overview = manifest.contributes.widgets.find((widget) => widget.id === 'week-overview')
    const tasks = manifest.contributes.widgets.find((widget) => widget.id === 'week-tasks')
    assertEqual(overview.entry, 'ui/widget-overview.html', 'week-overview entry 错误')
    assertEqual(tasks.entry, 'ui/widget-tasks.html', 'week-tasks entry 错误')
  })
  await test('清单引用的页面文件真实存在', async () => {
    const entries = [
      ...manifest.contributes.panels.map((panel) => panel.entry),
      ...manifest.contributes.widgets.map((widget) => widget.entry),
    ]
    for (const entry of entries) {
      assert(typeof entry === 'string' && entry !== '', '清单存在空 entry')
      assert(fs.existsSync(path.join(PLUGIN, entry)), `清单引用的页面不存在：${entry}`)
    }
  })
  await test('清单与入口不再引用声明式 schema / lib/panel / lib/widgets', async () => {
    const contributesText = JSON.stringify(manifest.contributes)
    assert(!contributesText.includes('panel.json'), '清单仍引用 ui/panel.json')
    assert(!contributesText.includes('widget-overview.json'), '清单仍引用 widget-overview.json')
    assert(!contributesText.includes('widget-tasks.json'), '清单仍引用 widget-tasks.json')
    const mainSource = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8')
    assert(!/require\(\s*['"]\.\/lib\/panel['"]\s*\)/.test(mainSource), 'main.js 仍在引用 lib/panel.js')
    assert(!/require\(\s*['"]\.\/lib\/widgets['"]\s*\)/.test(mainSource), 'main.js 仍在引用 lib/widgets.js')
    assert(mainSource.includes('./lib/board-page'), 'main.js 未接线页面型事务台处理器 lib/board-page')
    assert(mainSource.includes('./lib/widget-page'), 'main.js 未接线页面型小组件处理器 lib/widget-page')
  })
  await test('宿主原版 zod 清单解析通过', async () => {
    if (hostManifestParser === null) {
      process.stdout.write('  ! 未找到 Aurora，跳过宿主 zod 清单解析\n')
      return
    }
    const result = hostManifestParser(manifest)
    assert(result.ok === true, `宿主清单解析失败：${result.errors.join('；')}`)
    assertEqual(result.manifest.id, PLUGIN_ID)
  })
  await test('清单校验使用宿主原版解析器（而非离线近似）', async () => {
    const asarPath = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Aurora', 'resources', 'app.asar')
      : ''
    if (asarPath === '' || !fs.existsSync(asarPath)) {
      process.stdout.write('  ! 未找到 Aurora，当前仅做结构检查\n')
      return
    }
    assert(hostManifestParser !== null, '已安装 Aurora 但未能加载宿主清单解析器')
  })
  await test('main.__test 已移除声明式渲染入口（renderPanel / widgetSchema）', async () => {
    assertEqual(main.__test.renderPanel, undefined, 'main.__test.renderPanel 应已移除')
    assertEqual(main.__test.widgetSchema, undefined, 'main.__test.widgetSchema 应已移除')
    for (const key of ['setNow', 'resetNow', 'tick', 'checkNotifications', 'purgeHistory', 'nowMs']) {
      assertEqual(typeof main.__test[key], 'function', `main.__test.${key} 应保留`)
    }
  })

  // ═════════════════════════ 页面静态约束 ═════════════════════════

  header('页面静态约束')
  await test('班级事务台页面三文件存在且非空', async () => {
    for (const file of PAGE_GROUPS.board) readPageFile(file)
  })
  await test('班级周历页面三文件存在且非空', async () => {
    for (const file of PAGE_GROUPS.calendar) readPageFile(file)
  })
  await test('两张桌面小组件页面文件存在且非空（含共用 widget.css）', async () => {
    for (const file of PAGE_GROUPS.widgets) readPageFile(file)
  })
  await test('四个页面 HTML 的 <script> 均为 src 外链、无内联代码', async () => {
    for (const file of PAGE_HTMLS) {
      const html = readPageFile(file)
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      const openings = html.match(/<script\b/gi) || []
      assertEqual(openings.length, scripts.length, `${file} 存在未闭合的 <script>`)
      assert(scripts.length >= 1, `${file} 缺少带 src 的 <script>`)
      for (const match of scripts) {
        assert(/\bsrc\s*=/i.test(match[1]), `${file} 存在缺少 src 的内联 <script>`)
        assertEqual(match[2].trim(), '', `${file} 的 <script> 不能包含内联代码`)
      }
    }
  })
  await test('四个页面 HTML 无内联事件属性', async () => {
    for (const file of PAGE_HTMLS) {
      const html = readPageFile(file)
      assert(!/<[^>]*\son[a-z]+\s*=/i.test(html), `${file} 不应包含 on* 内联事件属性`)
    }
  })
  await test('四个页面 HTML 无 http(s) 外链', async () => {
    for (const file of PAGE_HTMLS) {
      assert(!/https?:\/\//i.test(readPageFile(file)), `${file} 不应包含 http:// 或 https:// 外链`)
    }
  })
  await test('HTML 引用的相对 css / js 文件都存在', async () => {
    for (const file of PAGE_HTMLS) {
      const html = readPageFile(file)
      for (const attr of ['src', 'href']) {
        const pattern = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'gi')
        for (const match of html.matchAll(pattern)) {
          const value = match[1].trim()
          if (value === '' || /^(https?:|data:|mailto:|#|\/)/i.test(value)) continue
          const clean = value.split('?')[0].split('#')[0]
          assert(
            fs.existsSync(path.join(PLUGIN, 'ui', clean)),
            `${file} 引用的相对资源不存在：${value}`,
          )
        }
      }
    }
  })
  await test('页面 JS 无 fetch / XMLHttpRequest / localStorage / sessionStorage / 外链', async () => {
    for (const file of PAGE_JSES) assertNoOutsideAccess(file, 'js')
  })
  await test('页面 CSS 无网络访问与外链', async () => {
    for (const file of PAGE_CSSES) assertNoOutsideAccess(file, 'css')
  })
  await test('事务台页面使用页面 RPC（request + listener 形式 onEvent）', async () => {
    assertPageRpc('ui/board.js')
  })
  await test('周历页面使用页面 RPC（request + listener 形式 onEvent）', async () => {
    assertPageRpc('ui/calendar.js')
  })
  await test('两张小组件页面使用页面 RPC（request + listener 形式 onEvent）', async () => {
    assertPageRpc('ui/widget-overview.js')
    assertPageRpc('ui/widget-tasks.js')
  })

  // ═════════════════════════ 时间运算 ═════════════════════════

  header('时间运算')
  await test('本地日期解析与周计算', async () => {
    assertEqual(timeLib.dateKeyOf(new Date(2026, 9, 21)), '2026-10-21')
    assertEqual(timeLib.dateKeyOf(timeLib.mondayOf(new Date(2026, 9, 21))), '2026-10-19')
    assertEqual(timeLib.dateKeyOf(timeLib.mondayOf(new Date(2026, 9, 25))), '2026-10-19')
    assertEqual(timeLib.dateKeyOf(timeLib.mondayOf(new Date(2026, 9, 26))), '2026-10-26')
    assertEqual(timeLib.parseDateKey('2026-02-31'), null)
    assertEqual(timeLib.parseDateKey('2026-10-21') instanceof Date, true)
    assertEqual(timeLib.dateLabel('2026-10-21'), '10/21 周三')
    assertEqual(timeLib.dateLabel('2026-02-31'), '')
  })
  await test('学期起始 / 周次 / 时间格式', async () => {
    assertEqual(timeLib.weekNumberOf('2026-10-19', '2026-09-07'), 7)
    assertEqual(timeLib.weekNumberOf('2026-10-19', '2026-10-19'), 1)
    assertEqual(timeLib.weekNumberOf('2026-10-19', '2026-10-26'), 0)
    assert(timeLib.weekLabel('2026-10-19', '2026-10-26').startsWith('未开学'), 'pre-anchor 周应显示未开学')
    assertEqual(timeLib.normalizeTime('8:05'), '08:05')
    assertEqual(timeLib.normalizeTime('24:00'), '')
    assertEqual(timeLib.weekdayLabel(1), '周一')
    assertEqual(timeLib.weekdayLabel(7), '周日')
    assertEqual(timeLib.dateKeyOfWeekday({ monday: new Date(2026, 9, 19) }, 5), '2026-10-23')
    assertEqual(timeLib.dateKeyOfWeekday({ monday: new Date(2026, 9, 19) }, 9), '')
  })

  // ═════════════════════════ 激活、存储与迁移 ═════════════════════════

  header('激活、存储与迁移')
  await withEnv({}, async (env) => {
    await test('激活种子：4 个值日组 + schema v2 + 空周数据', async () => {
      const board = await env.ctx.storage.get('board.v1')
      assertEqual(board.version, 2)
      assertEqual(board.duty.groups.length, 4)
      assertEqual(board.duty.order.length, 4)
      assertEqual(Object.keys(board.weeks).length, 0)
      const ui = await env.ctx.storage.get('ui.v1')
      assert(ui === undefined || ui.view === 'board', 'ui 默认状态异常')
      const data = await loadBoard(env)
      assertEqual(data.view, 'board')
      assertEqual(data.weekOffset, 0)
      assertEqual(data.groups.length, 4)
      assertEqual(data.boardEmpty, true)
    })
  })

  await test('损坏数据可自愈且不抛错', async () => {
    await withEnv({}, async (env) => {
      await env.ctx.storage.set('board.v1', { version: 1, duty: { groups: '坏的' }, weeks: { '不是日期': 1 } })
      const data = await loadBoard(env)
      assertEqual(data.groups.length, 4, '损坏数据未回落到 4 个种子组')
      assertEqual(data.view, 'board')
      await invokeTool(env, 'add_task', { text: '修复后写入' })
      const board = await env.ctx.storage.get('board.v1')
      assertEqual(board.version, 2)
      assertEqual(board.duty.groups.length, 4)
      assertEqual(Object.keys(board.weeks).includes('不是日期'), false)
    })
  })

  await test('安排提醒字段净化：严格布尔、可选提前量、未知键丢弃', async () => {
    const strict = stateLib.sanitizeSchedule({
      weekday: 3,
      title: '班会',
      time: '08:00',
      remind: 'yes',
      remindLead: '25',
      foo: 'bar',
    })
    assertEqual(strict.remind, false, 'remind 只认真正的 true')
    assertEqual(strict.remindLead, 25, '数字字符串应被接受')
    assertEqual(hasOwn(strict, 'foo'), false, '未知键必须丢弃')
    const blank = stateLib.sanitizeSchedule({ weekday: 3, title: '班会', remind: true, remindLead: '' })
    assertEqual(blank.remind, true)
    assertEqual(hasOwn(blank, 'remindLead'), false, '留空的提前量不该落成 0，否则失去「用默认」语义')
    assertEqual(stateLib.sanitizeSchedule({ weekday: 3, title: '班会', remind: true, remindLead: 999 }).remindLead, 120)
    assertEqual(stateLib.sanitizeSchedule({ weekday: 3, title: '班会', remind: true, remindLead: -5 }).remindLead, 0)
  })

  await test('基础安排净化：星期去重升序、缺省周一~周五、id 唯一、往返不变', async () => {
    const board = stateLib.createBoard()
    board.routines = [
      { title: '早读', time: '07:40', weekdays: [1, 2, 3, 4, 5] },
      { title: '早读', time: '07:40' },
      { title: '   ', time: '09:00' },
      { title: '眼保健操', time: '10:00', weekdays: [7, 3, 3, '4', 8] },
    ]
    const clean = stateLib.sanitizeBoard(board).board
    assertEqual(clean.routines.length, 3, '空标题应被丢弃，其余保留')
    assertEqual(clean.routines[2].weekdays.join(','), '3,4,7', '星期应过滤非法值、去重并升序')
    assertEqual(clean.routines[1].weekdays.join(','), '1,2,3,4,5', '缺省星期应为周一~周五')
    assertEqual(new Set(clean.routines.map((item) => item.id)).size, 3, 'id 必须唯一')
    assertEqual(stateLib.sanitizeBoard(clean).changed, false, '净化后的 board 往返不应再被判为已变更')
  })

  await test('旧数据缺 routines 时启动补齐并落盘', async () => {
    await withEnv({}, async (env) => {
      await env.ctx.storage.set('board.v1', {
        version: 2,
        anchorMonday: '2026-10-19',
        duty: { groups: stateLib.seedGroups(), order: ['g1', 'g2', 'g3', 'g4'] },
        weeks: {},
      })
      const board = await stateLib.ensureBoard(env.ctx)
      assert(Array.isArray(board.routines), '未补齐 routines 字段')
      assertEqual(board.routines.length, 0)
      assertEqual(env.store.get('board.v1').routines.length, 0, '补齐结果未落盘')
    })
  })

  await test('旧版数据迁移：无 date 事务落到今天、按天值日被丢弃、旧视图回落', async () => {
    const oldBoard = {
      version: 1,
      anchorMonday: '2026-10-19',
      duty: {
        groups: [
          { id: 'g1', name: '第1组', members: ['张三'] },
          { id: 'g2', name: '第2组', members: ['李四'] },
        ],
        order: ['g1', 'g2'],
      },
      weeks: {
        '2026-10-19': {
          duty: { days: { '3': { names: ['小明'], area: '走廊' } }, groupId: 'g2', note: '旧备注' },
          tasks: [
            { id: 'told', text: '旧任务', done: false, priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '' },
          ],
          schedule: [],
          announcement: '旧通知',
        },
      },
    }
    await withSeededEnv({ 'board.v1': oldBoard, 'ui.v1': { view: 'notice', weekOffset: 4 } }, async (env) => {
      const board = await env.ctx.storage.get('board.v1')
      assertEqual(board.version, 2)
      const week = board.weeks['2026-10-19']
      assertEqual(week.tasks[0].date, TODAY)
      assertEqual(week.duty.groupId, 'g2')
      assertEqual(week.duty.note, '旧备注')
      assertEqual(week.duty.days, undefined)
      const data = await loadBoard(env)
      assertEqual(data.view, 'board', '旧 notice 视图未回落到今日')
      assertEqual(data.weekOffset, 0, '今日视图周偏移应固定 0')
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('旧任务'), '迁移后旧任务不可见')
      assert(overview.content.includes('旧通知'), '迁移后通知丢失')
    })
  })

  await test('串行写入：并发 8 条事务全部落盘', async () => {
    await withEnv({}, async (env) => {
      const inputs = Array.from({ length: 8 }, (_, index) => ({ text: `并发事务 ${index + 1}` }))
      const results = await Promise.all(inputs.map((input) => invokeTool(env, 'add_task', input)))
      assert(results.every((result) => result.isError !== true), '存在失败结果')
      const overview = await invokeTool(env, 'get_overview', {})
      for (let index = 1; index <= 8; index += 1) {
        assert(overview.content.includes(`并发事务 ${index}`), `缺少并发事务 ${index}`)
      }
    })
  })

  // ═════════════════════════ Agent 工具 ═════════════════════════

  header('Agent 工具 · 今日事务')
  await withEnv({}, async (env) => {
    await test('add_task 默认今天 / get_overview / list_tasks', async () => {
      const before = pushCount(env)
      const added = await invokeTool(env, 'add_task', {
        text: '收数学作业',
        dueDate: TODAY,
        dueTime: '08:00',
        priority: 'high',
        category: '作业',
        assignee: '课代表',
      })
      assertEqual(added.isError, undefined)
      assert(added.content.includes('已添加事务'), '返回文案异常')
      assert(added.content.includes(TODAY), '返回未带日期')
      assertPushInvariants(env, before, 'add_task')
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('收数学作业'), '总览缺少事务')
      assert(overview.content.includes('值日组'), '总览缺少值日')
      assert(/id=t[A-Za-z0-9_-]+/.test(overview.content), '总览缺少 id')
      const pending = await invokeTool(env, 'list_tasks', { status: 'pending' })
      assert(pending.content.includes('收数学作业'), '待办列表缺少事务')
      const done = await invokeTool(env, 'list_tasks', { status: 'done' })
      assert(!done.content.includes('收数学作业'), '已完成列表不应包含待办')
      const task = taskByText(env, '收数学作业')
      assertEqual(task.date, TODAY)
    })
    await test('add_task 未来日期 / get_overview date / 不提前显示', async () => {
      const added = await invokeTool(env, 'add_task', { text: '明天交实验报告', date: '2026-10-22' })
      assertEqual(added.isError, undefined)
      const current = await invokeTool(env, 'get_overview', {})
      assert(!current.content.includes('明天交实验报告'), '未来事务不应出现在今天')
      const tomorrow = await invokeTool(env, 'get_overview', { date: '2026-10-22' })
      assert(tomorrow.content.includes('明天交实验报告'), '未来事务未按日期显示')
      const listed = await invokeTool(env, 'list_tasks', { date: '2026-10-22', status: 'all' })
      assert(listed.content.includes('明天交实验报告'), 'list_tasks 未按日期查询')
      const nextWeek = await invokeTool(env, 'get_overview', { weekOffset: 1 })
      assert(nextWeek.content.includes('10/26 周一'), '下周总览应默认看该周周一')
      assert(!nextWeek.content.includes('收数学作业'), '下周总览不应混入今天的任务')
    })
    await test('add_task 过去日期会报错', async () => {
      const result = await invokeTool(env, 'add_task', { text: '补记昨天', date: '2026-10-20' })
      assertEqual(result.isError, true)
      assert(result.content.includes('过去'), '过去日期提示不明确')
    })
    await test('update_task / complete_task / delete_task（按 id）', async () => {
      const listed = await invokeTool(env, 'list_tasks', { status: 'pending' })
      const id = /id=([A-Za-z0-9_-]+)/.exec(listed.content)[1]
      const updated = await invokeTool(env, 'update_task', { id, priority: 'low', text: '收数学作业（改）' })
      assert(updated.content.includes('收数学作业（改）'), '更新未生效')
      const completed = await invokeTool(env, 'complete_task', { id })
      assert(completed.content.includes('已标记完成'), '完成文案异常')
      const deleted = await invokeTool(env, 'delete_task', { id })
      assert(deleted.content.includes('已删除事务'), '删除文案异常')
      const listedAfter = await invokeTool(env, 'list_tasks', { status: 'all' })
      assert(!listedAfter.content.includes(id), '删除后仍存在')
    })
    await test('模糊匹配歧义会报错并要求用 id', async () => {
      await invokeTool(env, 'add_task', { text: '交作业 A' })
      await invokeTool(env, 'add_task', { text: '交作业 B' })
      const result = await invokeTool(env, 'complete_task', { text: '交作业' })
      assertEqual(result.isError, true)
      assert(result.content.includes('匹配到'), '歧义文案异常')
    })
    await test('文本匹配限定日期：昨天同名事务不参与今天的歧义', async () => {
      await invokeTool(env, 'add_task', { text: '交作业 今天', date: TODAY })
      await invokeTool(env, 'add_task', { text: '交作业 今天', date: '2026-10-22' })
      const result = await invokeTool(env, 'complete_task', { text: '交作业 今天', date: TODAY })
      assertEqual(result.isError, undefined)
    })
    await test('输入校验：空文本 / 非法日期 / 非法优先级 / 未知 id / 未知工具', async () => {
      const empty = await invokeTool(env, 'add_task', { text: '   ' })
      assertEqual(empty.isError, true)
      const badDate = await invokeTool(env, 'add_task', { text: '测试', dueDate: '2026-13-01' })
      assertEqual(badDate.isError, true)
      const badTaskDate = await invokeTool(env, 'add_task', { text: '测试', date: '2026-02-31' })
      assertEqual(badTaskDate.isError, true)
      const badPriority = await invokeTool(env, 'add_task', { text: '非法优先级事务', priority: 'urgent' })
      assertEqual(badPriority.isError, undefined, '非法优先级应按 normal 归一化而不是报错')
      const normalized = taskByText(env, '非法优先级事务')
      assert(normalized !== null, '非法优先级事务未写入')
      assertEqual(normalized.priority, 'normal', '非法优先级应归一化为 normal')
      const missing = await invokeTool(env, 'update_task', { id: 't-not-exist' })
      assertEqual(missing.isError, true)
      const unknown = await invokeTool(env, 'no_such_tool', {})
      assertEqual(unknown.isError, true)
      const noDayTool = await invokeTool(env, 'set_duty_day', { weekday: 3 })
      assertEqual(noDayTool.isError, true)
      const badOffset = await invokeTool(env, 'get_overview', { weekOffset: 99 })
      assertEqual(badOffset.isError, true)
      assert(badOffset.content.includes('-12'), '越界 weekOffset 提示不明确')
      const noText = await invokeTool(env, 'set_announcement', {})
      assertEqual(noText.isError, true)
    })
    await test('apply_week_plan 失败不留下半写数据', async () => {
      const before = await invokeTool(env, 'get_overview', {})
      const failed = await invokeTool(env, 'apply_week_plan', {
        plan: {
          tasks: [{ text: '本应被回滚的事务' }, { text: '   ' }],
          schedule: [{ weekday: 2, title: '本应被回滚的安排' }],
        },
      })
      assertEqual(failed.isError, true)
      const after = await invokeTool(env, 'get_overview', {})
      assertEqual(after.content, before.content, '失败的整周计划不应写入任何内容')
    })
    await test('超长文本截断', async () => {
      const long = '很长的内容'.repeat(200)
      await invokeTool(env, 'add_task', { text: long })
      const overview = await invokeTool(env, 'get_overview', {})
      assert(!overview.content.includes(long), '文本未截断')
    })
    await test('事务容量上限 80 条', async () => {
      await withEnv({}, async (env2) => {
        for (let index = 0; index < 80; index += 1) {
          const result = await invokeTool(env2, 'add_task', { text: `批量 ${index + 1}` })
          if (result.isError) throw new Error(`第 ${index + 1} 条写入失败：${result.content}`)
        }
        const overflow = await invokeTool(env2, 'add_task', { text: '第 81 条' })
        assertEqual(overflow.isError, true)
        assert(overflow.content.includes('上限'), '超限文案异常')
        const overview = await invokeTool(env2, 'get_overview', {})
        assertEqual(overview.isError, undefined)
        assert(Buffer.byteLength(overview.content, 'utf8') <= 100 * 1024, '工具结果超过 100 KB')
        assert(overview.content.includes('… 还有'), '大量事务应提示截断/分页')
      })
    })
  })

  // ═════════════════════════ 值日 · 整周轮换 ═════════════════════════

  header('值日 · 整周轮换')
  await withEnv({}, async (env) => {
    await test('set_duty_groups 分组与按周轮换', async () => {
      const result = await invokeTool(env, 'set_duty_groups', {
        groups: [
          { name: '第1组', members: ['张三', '李四'] },
          { name: '第2组', members: ['王五', '赵六'] },
          { name: '第3组', members: ['钱七'] },
        ],
        order: ['第2组', '第3组', '第1组'],
      })
      assertEqual(result.isError, undefined)
      const week1 = await invokeTool(env, 'get_overview', {})
      assert(week1.content.includes('第2组 → 第3组 → 第1组'), '轮换顺序未生效')
      assert(week1.content.includes('王五 赵六'), '本周轮换组名单未生效')
      const week2 = await invokeTool(env, 'get_overview', { weekOffset: 1 })
      assert(week2.content.includes('值日组：第3组'), '第二周未按顺序轮换')
      const week3 = await invokeTool(env, 'get_overview', { weekOffset: 2 })
      assert(week3.content.includes('值日组：第1组'), '第三周未按顺序轮换')
    })
    await test('set_duty_week 指定本周组 / 恢复自动轮换', async () => {
      const assigned = await invokeTool(env, 'set_duty_week', { groupName: '第3组', note: '本周值日' })
      assertEqual(assigned.isError, undefined)
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('（本周指定）'), '指定组未生效')
      assert(overview.content.includes('值日备注：本周值日'), '备注未生效')
      const cleared = await invokeTool(env, 'set_duty_week', { clear: true })
      assert(cleared.isError !== true, 'clear 不应失败')
      assert(cleared.content.includes('恢复自动轮换'), '恢复轮换文案异常')
    })
    await test('值日数据不再有按天 days 字段', async () => {
      const board = await env.ctx.storage.get('board.v1')
      for (const week of Object.values(board.weeks)) {
        assertEqual(week.duty.days, undefined)
      }
      const overview = await invokeTool(env, 'get_overview', {})
      assert(!overview.content.includes('周一：'), '值日仍按天输出')
    })
    await test('无效组会报错；set_duty_day 已不存在', async () => {
      const noGroup = await invokeTool(env, 'set_duty_week', { groupName: '第99组' })
      assertEqual(noGroup.isError, true)
      const removed = await invokeTool(env, 'set_duty_day', { weekday: 3, names: ['张三'] })
      assertEqual(removed.isError, true)
    })
    await test('apply_week_plan 传 duty.days 会报错并回滚', async () => {
      const before = await invokeTool(env, 'get_overview', {})
      const result = await invokeTool(env, 'apply_week_plan', {
        plan: {
          tasks: [{ text: '不该写入' }],
          duty: { days: { '1': { names: ['李四'] } } },
        },
      })
      assertEqual(result.isError, true)
      const after = await invokeTool(env, 'get_overview', {})
      assertEqual(after.content, before.content, '失败的整周计划不应写入')
    })
  })

  // ═════════════════════════ 安排与通知 ═════════════════════════

  header('安排与通知')
  await withEnv({}, async (env) => {
    await test('add_schedule / delete_schedule', async () => {
      const before = pushCount(env)
      const added = await invokeTool(env, 'add_schedule', { weekday: 3, time: '16:00', title: '班会', place: '教室' })
      assertEqual(added.isError, undefined)
      assertPushInvariants(env, before, 'add_schedule')
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('周三 16:00 班会 @ 教室'), '安排未生效')
      const deleted = await invokeTool(env, 'delete_schedule', { weekday: 3, title: '班会' })
      assert(deleted.content.includes('已删除安排'), '删除安排失败')
      const missing = await invokeTool(env, 'delete_schedule', { weekday: 4, title: '不存在' })
      assertEqual(missing.isError, true)
    })
    await test('set_announcement 保存 / 清空并同步小组件数据', async () => {
      const saved = await invokeTool(env, 'set_announcement', { text: '周五下午大扫除' })
      assertEqual(saved.isError, undefined)
      const overviewWidget = await loadWidget(env, 'week-overview')
      assert(overviewWidget.announcement.includes('周五下午大扫除'), '速览未显示通知')
      const cleared = await invokeTool(env, 'set_announcement', { text: '' })
      assertEqual(cleared.isError, undefined)
      const after = await loadWidget(env, 'week-overview')
      assert(!after.announcement.includes('周五下午大扫除'), '清空通知失败')
    })
    await test('整周计划 apply_week_plan 原子写入', async () => {
      const before = pushCount(env)
      const result = await invokeTool(env, 'apply_week_plan', {
        weekOffset: 1,
        plan: {
          tasks: [{ text: '下周数学测验', date: '2026-10-28', priority: 'high' }],
          schedule: [{ weekday: 2, title: '月考动员', time: '08:00' }],
          duty: { groupName: '第2组', note: '下周值日' },
          announcement: '下周有数学测验',
          replaceTasks: true,
          replaceSchedule: true,
        },
      })
      assertEqual(result.isError, undefined)
      assertPushInvariants(env, before, 'apply_week_plan')
      assert(result.content.includes('事务 +1'), '摘要缺少事务')
      assert(result.content.includes('安排 +1'), '摘要缺少安排')
      assert(result.content.includes('值日组 第2组'), '摘要缺少值日组')
      const next = await invokeTool(env, 'get_overview', { weekOffset: 1, date: '2026-10-28' })
      assert(next.content.includes('下周数学测验'), '整周计划缺少事务')
      assert(next.content.includes('月考动员'), '整周计划缺少安排')
      assert(next.content.includes('下周有数学测验'), '整周计划缺少通知')
      assert(next.content.includes('值日组：第2组'), '整周计划缺少值日组')
    })
    await test('整周计划任务日期必须在目标周内', async () => {
      const result = await invokeTool(env, 'apply_week_plan', {
        weekOffset: 1,
        plan: { tasks: [{ text: '日期越界', date: TODAY }] },
      })
      assertEqual(result.isError, true)
      assert(result.content.includes('目标周'), '日期越界提示不明确')
    })
  })

  // ═════════════════════════ 基础安排（每天例行）═════════════════════════

  header('基础安排（每天例行）')
  await withEnv({}, async (env) => {
    await test('set_routines 整表写入、进总览并推送 4 条', async () => {
      const before = pushCount(env)
      const result = await invokeTool(env, 'set_routines', {
        routines: [
          { time: '07:40', title: '早读', place: '教室', weekdays: [1, 2, 3, 4, 5] },
          { time: '16:30', title: '教室通风与关灯', note: '最后离开的一组负责', weekdays: [1, 2, 3, 4, 5, 6] },
        ],
      })
      assertEqual(result.isError, undefined)
      assertPushInvariants(env, before, 'set_routines')
      assert(result.content.includes('已保存 2 条基础安排'), `工具摘要不明确：${result.content}`)
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('早读'), '总览缺少基础安排')
      assert(overview.content.includes('周一~周五'), '总览缺少适用星期')
    })
    await test('set_routines 空数组清空、超上限报错且不落盘', async () => {
      await invokeTool(env, 'set_routines', { routines: [{ title: '眼保健操', time: '10:00' }] })
      const tooMany = await invokeTool(env, 'set_routines', {
        routines: Array.from({ length: 31 }, (_item, index) => ({ title: `例行 ${index}` })),
      })
      assertEqual(tooMany.isError, true, '超过 30 条应报错')
      assertEqual(env.store.get('board.v1').routines.length, 1, '失败的整表写入不应落盘')
      const cleared = await invokeTool(env, 'set_routines', { routines: [] })
      assertEqual(cleared.isError, undefined)
      assertEqual(env.store.get('board.v1').routines.length, 0, '空数组应清空基础安排')
    })
    await test('周历按星期把基础安排铺到对应日卡', async () => {
      await invokeTool(env, 'set_routines', {
        routines: [
          { time: '07:40', title: '早读', weekdays: [1, 3, 5] },
          { time: '16:30', title: '关灯', weekdays: [7] },
        ],
      })
      const grid = await loadCalendar(env, {})
      assertEqual(calendarDayOf(grid, '2026-10-19').routines.length, 1, '周一应有一条例行')
      assertEqual(calendarDayOf(grid, '2026-10-19').routines[0].title, '早读')
      assertEqual(calendarDayOf(grid, '2026-10-20').routines.length, 0, '周二没有排到例行')
      assertEqual(calendarDayOf(grid, '2026-10-25').routines[0].title, '关灯', '周日应拿到自己的例行事项')
      assertEqual(grid.routines.length, 2, '整周数据应带上全部基础安排')
    })
    await test('事务台与小组件只拿到今天（周三）的基础安排', async () => {
      const data = await loadBoard(env, { view: 'board' })
      assertEqual(data.routines.length, 2)
      assertEqual(data.todayRoutines.length, 1, '今天只有早读')
      assertEqual(data.todayRoutines[0].title, '早读')
      const widget = await loadWidget(env, 'week-overview')
      assertEqual(widget.routines.length, 1, '速览应只显示今天的例行')
      assertEqual(widget.routines[0].title, '早读')
    })
    await test('面板逐条增改删基础安排并回显', async () => {
      const before = pushCount(env)
      const added = await invokeBoard(env, 'add-routine', {
        time: '09:10',
        title: '课间操',
        place: '操场',
        weekdays: [1, 2, 3, 4, 5],
      })
      expectBoardOk(added, 'add-routine')
      assertPushAllSlice(env, before, 'add-routine')
      const created = added.data.routines.find((item) => item.title === '课间操')
      assert(created !== undefined, '新增的基础安排未回显')
      const updated = await invokeBoard(env, 'update-routine', { id: created.id, time: '09:20', weekdays: [2, 4] })
      expectBoardOk(updated, 'update-routine')
      const changed = updated.data.routines.find((item) => item.id === created.id)
      assertEqual(changed.time, '09:20')
      assertEqual(changed.weekdays.join(','), '2,4')
      assertEqual(updated.data.todayRoutines.length, 1, '课间操改到周二/周四后，今天只剩早读')
      assertEqual(updated.data.todayRoutines[0].title, '早读')
      const deleted = await invokeBoard(env, 'delete-routine', { id: created.id })
      expectBoardOk(deleted, 'delete-routine')
      assertEqual(deleted.data.routines.length, 2, '删除后应剩两条')
    })
    await test('面板基础安排动作的非法输入不落盘', async () => {
      const before = pushCount(env)
      const noTitle = await invokeBoard(env, 'add-routine', { time: '07:00' })
      expectBoardError(noTitle, 'add-routine 空标题')
      const noId = await invokeBoard(env, 'update-routine', { id: ' ', time: '07:00' })
      expectBoardError(noId, 'update-routine 缺 id')
      const missing = await invokeBoard(env, 'delete-routine', { id: 'r-not-exist' })
      expectBoardError(missing, 'delete-routine 未知 id')
      assertEqual(pushCount(env), before, '失败的写动作不应推送')
      assertEqual(env.store.get('board.v1').routines.length, 2, '失败的写动作不应改数据')
    })
  })

  // ═════════════════════════ 每日清空与 7 天历史 ═════════════════════════

  header('每日清空与 7 天历史')
  await withEnv({}, async (env) => {
    await test('跨天后今日清空，昨天可查回', async () => {
      await invokeTool(env, 'add_task', { text: '昨天做的事', date: TODAY })
      await invokeTool(env, 'add_task', { text: '今天做的事', date: '2026-10-22' })
      main.__test.setNow(new Date(2026, 9, 22, 9, 0, 0, 0).getTime())
      await main.__test.tick(env.ctx)
      const today = await invokeTool(env, 'get_overview', {})
      assert(today.content.includes('今天做的事'), '新一天事务缺失')
      assert(!today.content.includes('昨天做的事'), '昨天事务不应出现在今天')
      const history = await invokeTool(env, 'list_tasks', { date: TODAY, status: 'all' })
      assert(history.content.includes('昨天做的事'), '历史事务查不到')
    })
    await test('超过 7 天后旧事务自动清理且拒绝查询', async () => {
      main.__test.setNow(new Date(2026, 9, 29, 9, 0, 0, 0).getTime())
      await main.__test.tick(env.ctx)
      const board = await env.ctx.storage.get('board.v1')
      const dates = Object.values(board.weeks).flatMap((week) => week.tasks.map((task) => task.date))
      assert(!dates.includes(TODAY), '7 天前的历史事务未清理')
      const result = await invokeTool(env, 'list_tasks', { date: TODAY })
      assertEqual(result.isError, true)
      assert(result.content.includes('7 天'), '过期历史提示不明确')
    })
    await test('最新一天仍可写事务', async () => {
      const result = await invokeTool(env, 'add_task', { text: '清理后的新事务' })
      assertEqual(result.isError, undefined)
      const today = await invokeTool(env, 'get_overview', {})
      assert(today.content.includes('清理后的新事务'), '清理后无法继续写')
    })
  })

  // ═════════════════════════ 通知与定时提醒 ═════════════════════════

  header('通知与定时提醒')
  await test('三类通知默认全关：不发送、不写 notify.v1', async () => {
    // 周一 08:00：每日简报、值日提醒、08:00 截止提醒三者同时“满足时间条件”，最能验证开关
    const env = atTime(new Date(2026, 9, 19, 8, 0, 0, 0), {})
    await addTask(env, { text: '周一 08:00 截止的作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '默认全关时不应产生任何通知')
    assertEqual(env.banners.length, 0, '默认全关时不应产生任何流光提醒')
    assertEqual(env.store.has('notify.v1'), false, '默认全关时不应写入 notify.v1')
  })
  await test('每日简报到时后只发一次', async () => {
    const early = atTime(new Date(2026, 9, 21, 7, 29, 0, 0), { notifyDaily: true })
    await checkNotifications(early)
    assertEqual(early.notifications.length, 0, '未到 notifyTime 不应发每日简报')

    const env = atTime(new Date(2026, 9, 21, 7, 31, 0, 0), { notifyDaily: true }) // 周三 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '到时后应发一条每日简报')
    assertEqual(env.notifications[0].title, '今日班级事务')
    assert(
      typeof env.notifications[0].body === 'string' && env.notifications[0].body !== '',
      '每日简报正文为空',
    )
    const saved = env.store.get('notify.v1')
    assert(
      saved !== undefined && typeof saved.dailyDate === 'string' && saved.dailyDate !== '',
      '未记录当天简报已发送',
    )
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '重复调用不应重复发送每日简报')
  })
  await test('每日简报跨天重新提醒（第二天再发一条）', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 31, 0, 0), { notifyDaily: true }) // 周三 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '当天首次检查应发一条每日简报')
    main.__test.setNow(new Date(2026, 9, 22, 7, 31, 0, 0).getTime()) // 周四 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 2, '跨天后应重新发送每日简报')
    assertEqual(env.notifications[1].title, '今日班级事务')
    main.__test.setNow(new Date(2026, 9, 22, 7, 40, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.notifications.length, 2, '同一天内仍不应重复发送每日简报')
  })
  await test('截止提醒走流光：未到提醒点不发，到时只发一次', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 49, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    await addTask(env, { text: '交英语作业', dueTime: '08:00' }) // 提前 10 分钟 = 07:50
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '未到 08:00 - 10 分钟不应提醒')

    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '已到提醒点应发一条截止流光提醒')
    assertEqual(env.notifications.length, 0, '准点类提醒不该再走系统通知中心')
    assertEqual(env.banners[0].title, '事务即将截止')
    assertEqual(env.banners[0].speak, true, '截止提醒应请求朗读（由宿主总闸决定是否朗读）')
    const task = taskByText(env, '交英语作业')
    assert(task !== null, '找不到预置事务')
    const saved = env.store.get('notify.v1')
    assert(saved !== undefined && saved.due !== null && typeof saved.due === 'object', '未记录截止提醒去重状态')
    assert(hasOwn(saved.due, task.id), '未记录该事务今天已提醒')
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '重复调用不应重复发送截止提醒')
  })
  await test('notifyDueLead 为 0 时按 0 分钟提醒（不回落成 10）', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 0 })
    await addTask(env, { text: '交化学作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '提前量为 0 时 07:55 不应提醒')
    main.__test.setNow(new Date(2026, 9, 21, 8, 0, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '提前量为 0 时 08:00 应提醒')
  })
  await test('多条同时到点的截止任务合并为一条摘要', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    const texts = ['交数学作业', '交英语作业', '交物理作业']
    for (const text of texts) {
      await addTask(env, { text, dueTime: '08:00' })
    }
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '多条任务应合并成一条摘要，而不是逐条发送')
    assertEqual(env.banners[0].title, '事务即将截止')
    for (const text of texts) {
      assert(env.banners[0].body.includes(text), `截止摘要缺少「${text}」：${env.banners[0].body}`)
    }
  })
  await test('截止提醒摘要最多汇总 3 条，第 4 条下个检查补发', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    const texts = ['摘要事务 A', '摘要事务 B', '摘要事务 C', '摘要事务 D']
    const times = ['08:00', '08:01', '08:02', '08:03']
    for (let index = 0; index < texts.length; index += 1) {
      await addTask(env, { text: texts[index], dueTime: times[index] })
    }
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '同一轮到点任务应合并为一条摘要')
    const first = env.banners[0]
    assertEqual(first.title, '事务即将截止')
    for (const text of texts.slice(0, 3)) {
      assert(first.body.includes(text), `首条摘要应包含前 3 条事务「${text}」：${first.body}`)
    }
    assert(!first.body.includes(texts[3]), `首条摘要最多 3 条，不应包含第 4 条：${first.body}`)
    await checkNotifications(env)
    assertEqual(env.banners.length, 2, '第 4 条应在下一轮检查补发')
    const second = env.banners[1]
    assert(second.body.includes(texts[3]), `补发摘要应包含第 4 条：${second.body}`)
    for (const text of texts.slice(0, 3)) {
      assert(!second.body.includes(text), `已提醒的事务不应重复汇总「${text}」：${second.body}`)
    }
  })
  await test('周一值日提醒本周只发一次', async () => {
    const env = atTime(new Date(2026, 9, 19, 7, 31, 0, 0), { notifyDuty: true }) // 周一 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '周一到时后应发一条本周值日提醒')
    assertEqual(env.notifications[0].title, '本周值日')
    const saved = env.store.get('notify.v1')
    assert(
      saved !== undefined && typeof saved.dutyWeek === 'string' && saved.dutyWeek !== '',
      '未记录本周值日已提醒',
    )
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '重复调用不应重复发送值日提醒')
  })
  await test('周一值日提醒跨周重新提醒（下周一再发一条）', async () => {
    const env = atTime(new Date(2026, 9, 19, 7, 31, 0, 0), { notifyDuty: true }) // 周一 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '首个周一到时应发一条本周值日提醒')
    assertEqual(env.notifications[0].title, '本周值日')
    main.__test.setNow(new Date(2026, 9, 26, 7, 31, 0, 0).getTime()) // 下周一 07:31
    await checkNotifications(env)
    assertEqual(env.notifications.length, 2, '进入下一周后应重新发送值日提醒')
    assertEqual(env.notifications[1].title, '本周值日')
    main.__test.setNow(new Date(2026, 9, 28, 7, 31, 0, 0).getTime()) // 下周三
    await checkNotifications(env)
    assertEqual(env.notifications.length, 2, '同一周内（非周一）不应重复发送值日提醒')
  })
  await test('非周一不发值日提醒', async () => {
    const env = atTime(new Date(2026, 9, 20, 7, 31, 0, 0), { notifyDuty: true }) // 周二
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '非周一不应发值日提醒')
  })
  await test('非法配置回退与截断（readSettings）', async () => {
    const defaults = stateLib.readSettings({})
    assertEqual(defaults.notifyDaily, false)
    assertEqual(defaults.notifyTime, '07:30')
    assertEqual(defaults.notifyDue, false)
    assertEqual(defaults.notifyDueLead, 10)
    assertEqual(defaults.notifyDuty, false)
    assertEqual(defaults.notifySchedule, false)
    assertEqual(defaults.notifyScheduleLead, 10)
    assertEqual(stateLib.readSettings({ notifySchedule: 'yes' }).notifySchedule, false)
    assertEqual(stateLib.readSettings({ notifyScheduleLead: 999 }).notifyScheduleLead, 120)
    assertEqual(stateLib.readSettings({ notifyScheduleLead: -5 }).notifyScheduleLead, 0)
    assertEqual(stateLib.readSettings({ notifyScheduleLead: 0 }).notifyScheduleLead, 0)
    assertEqual(stateLib.readSettings({ notifyScheduleLead: '' }).notifyScheduleLead, 10)
    assertEqual(stateLib.readSettings({ notifyTime: '25:99' }).notifyTime, '07:30')
    assertEqual(stateLib.readSettings({ notifyTime: 'not-a-time' }).notifyTime, '07:30')
    assertEqual(stateLib.readSettings({ notifyTime: '08:05' }).notifyTime, '08:05')
    assertEqual(stateLib.readSettings({ notifyDueLead: 999 }).notifyDueLead, 120)
    assertEqual(stateLib.readSettings({ notifyDueLead: -5 }).notifyDueLead, 0)
    assertEqual(stateLib.readSettings({ notifyDueLead: 0 }).notifyDueLead, 0)
  })
  await test('明天截止的任务今天不提醒', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    await addTask(env, { text: '明天交实验报告', dueDate: '2026-10-22', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '明天截止的任务不应今天提醒')
  })
  await test('过了截止时间不再提醒', async () => {
    const env = atTime(new Date(2026, 9, 21, 8, 5, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    await addTask(env, { text: '已经过期的作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '08:05 不应再提醒 08:00 截止的任务')
  })
  await test('昨天登记、今天截止的任务仍会提醒', async () => {
    main.__test.setNow(new Date(2026, 9, 20, 9, 0, 0, 0).getTime())
    const env = createContext({ config: { notifyDue: true, notifyDueLead: 10 } })
    await addTask(env, { text: '昨天登记今天交', dueDate: TODAY, dueTime: '08:00' })
    const task = taskByText(env, '昨天登记今天交')
    assert(task !== null, '找不到预置事务')
    assertEqual(task.date, '2026-10-20')
    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '昨天登记、今天截止的任务应被提醒')
  })
  await test('ctx.notify 返回 false：不抛错并记录 warn', async () => {
    main.__test.setNow(new Date(2026, 9, 21, 7, 31, 0, 0).getTime())
    const env = createContext({ config: { notifyDaily: true }, notifyResult: false })
    await checkNotifications(env) // 抛错会让本测试直接失败
    assertEqual(env.notifications.length, 1, '通知失败路径也应尝试发送一次')
    assert(env.logs.some((entry) => entry.level === 'warn'), '通知发送失败应记录 warn 日志')
  })
  await test('插件重启后（同一存储）不重复发通知', async () => {
    const clock = new Date(2026, 9, 21, 7, 31, 0, 0).getTime()
    main.__test.setNow(clock)
    const first = createContext({ config: { notifyDaily: true } })
    await checkNotifications(first)
    assertEqual(first.notifications.length, 1, '首次运行应发一条每日简报')
    const snapshot = new Map(first.store)
    const second = createContext({ config: { notifyDaily: true } })
    for (const [key, value] of snapshot) await second.ctx.storage.set(key, value)
    await checkNotifications(second)
    assertEqual(second.notifications.length, 0, '重启后同一存储不应重复发送当天简报')
  })
  await test('安排提醒总开关关闭：不发送也不写 notify.v1', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifySchedule: false, notifyScheduleLead: 10 })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '班会', remind: true })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '未开启安排提醒时不应发送')
    assertEqual(env.store.has('notify.v1'), false, '未开启安排提醒时不应写入去重状态')
  })
  await test('安排到点前只提醒一次（走流光，沿用全局默认提前量）', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 49, 0, 0), { notifySchedule: true, notifyScheduleLead: 10 })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '班会', place: '教室', remind: true })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '07:49 还没进入提前 10 分钟窗口')
    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '进入窗口应发一条安排流光提醒')
    assertEqual(env.notifications.length, 0, '准点类提醒不该再走系统通知中心')
    assertEqual(env.banners[0].title, '安排即将开始')
    assertEqual(env.banners[0].speak, true, '安排提醒应请求朗读')
    assert(
      env.banners[0].body.includes('08:00 班会') && env.banners[0].body.includes('教室'),
      `安排提醒正文不完整：${env.banners[0].body}`,
    )
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '同一条安排同一天不应重复提醒')
  })
  await test('单条 remindLead 覆盖全局默认提前量', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 45, 0, 0), { notifySchedule: true, notifyScheduleLead: 5 })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '升旗仪式', remind: true, remindLead: 20 })
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, 'remindLead=20 时 07:45 就该提醒，不能被全局 5 分钟挡住')
    assert(env.banners[0].body.includes('升旗仪式'), '正文缺少该安排')
  })
  await test('未勾选 / 全天 / 已过点 / 非当天周几都不提醒', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifySchedule: true, notifyScheduleLead: 10 })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '没开提醒的安排' })
    await addSchedule(env, { weekday: 3, time: '', title: '全天安排', remind: true })
    await addSchedule(env, { weekday: 3, time: '07:00', title: '已过点安排', remind: true })
    await addSchedule(env, { weekday: 5, time: '08:00', title: '周五安排', remind: true })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, `四种情况都不该提醒：${JSON.stringify(env.banners)}`)
  })
  await test('多条到点安排合并为一条摘要，第 4 条下轮补发', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifySchedule: true, notifyScheduleLead: 10 })
    const titles = ['到点安排 A', '到点安排 B', '到点安排 C', '到点安排 D']
    const times = ['08:00', '08:01', '08:02', '08:03']
    for (let index = 0; index < titles.length; index += 1) {
      await addSchedule(env, { weekday: 3, time: times[index], title: titles[index], remind: true })
    }
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '同一轮到点的安排应合并成一条摘要')
    const first = env.banners[0]
    assertEqual(first.title, '安排即将开始')
    for (const title of titles.slice(0, 3)) {
      assert(first.body.includes(title), `首条摘要应包含「${title}」：${first.body}`)
    }
    assert(!first.body.includes(titles[3]), `摘要最多 3 条，不应包含第 4 条：${first.body}`)
    await checkNotifications(env)
    assertEqual(env.banners.length, 2, '第 4 条应在下一轮检查补发')
    assert(env.banners[1].body.includes(titles[3]), '补发摘要应包含第 4 条')
  })
  await test('安排提醒不产生额外推送', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifySchedule: true, notifyScheduleLead: 10 })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '推送检查安排', remind: true })
    const before = pushCount(env)
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '预置安排应触发一次提醒')
    assertEqual(pushCount(env), before, '通知检查不应产生任何推送')
  })
  await test('旧宿主没有 ctx.banner：准点提醒回落系统通知中心', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifySchedule: true, notifyScheduleLead: 10 })
    delete env.ctx.banner
    await addSchedule(env, { weekday: 3, time: '08:00', title: '回落检查安排', remind: true })
    await checkNotifications(env)
    assertEqual(env.banners.length, 0, '旧宿主不该被调用 banner')
    assertEqual(env.notifications.length, 1, '回落时应发一条系统通知')
    assertEqual(env.notifications[0].title, '安排即将开始')
    assert(env.logs.some((entry) => entry.message === '宿主不支持流光提醒，已回落系统通知'), '回落未记 info 日志')
  })
  await test('ctx.banner 返回 false：不抛错、记 warn 且不重试', async () => {
    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    const env = createContext({
      bannerResult: false,
      config: { notifySchedule: true, notifyScheduleLead: 10 },
    })
    await addSchedule(env, { weekday: 3, time: '08:00', title: '未显示安排', remind: true })
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '未显示也只尝试一次，不重试')
    assert(env.logs.some((entry) => entry.level === 'warn' && entry.message === '流光提醒未显示'), '未记录 warn 日志')
    await checkNotifications(env)
    assertEqual(env.banners.length, 1, '已记录去重，不应再次尝试')
  })
  await test('安排提醒跨重启不重发（notify.v1.sched）', async () => {
    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    const first = createContext({ config: { notifySchedule: true, notifyScheduleLead: 10 } })
    await addSchedule(first, { weekday: 3, time: '08:00', title: '重启检查安排', remind: true })
    await checkNotifications(first)
    assertEqual(first.banners.length, 1, '首次检查应提醒一次')
    const saved = first.store.get('notify.v1')
    assert(saved !== undefined && saved.sched !== null && typeof saved.sched === 'object', '未写入 sched 去重表')
    assertEqual(Object.keys(saved.sched).length, 1, 'sched 应只记录这一条安排')
    const snapshot = new Map(first.store)
    const second = createContext({ config: { notifySchedule: true, notifyScheduleLead: 10 } })
    for (const [key, value] of snapshot) await second.ctx.storage.set(key, value)
    await checkNotifications(second)
    assertEqual(second.banners.length, 0, '重启后同一条安排不应重复提醒')
  })
  await test('activate 时立即补发一次，且不重复', async () => {
    main.__test.setNow(new Date(2026, 9, 21, 7, 31, 0, 0).getTime())
    const env = createContext({ config: { notifyDaily: true } })
    await main.activate(env.ctx)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      assertEqual(env.notifications.length, 1, '激活后应立即补发一条每日简报')
      await checkNotifications(env)
      assertEqual(env.notifications.length, 1, '激活补发后再次检查不应重复发送')
    } finally {
      await main.deactivate()
    }
  })
  main.__test.resetNow()

  // ═════════════════════════ 班级事务台（页面 API）═════════════════════════

  header('班级事务台 · load 与视图状态')
  await withEnv({}, async (env) => {
    await test('board load 返回完整契约字段', async () => {
      const data = await loadBoard(env, {})
      for (const key of [
        'view',
        'weekOffset',
        'isCurrentWeek',
        'isPastWeek',
        'canEdit',
        'weekLabel',
        'weekNumber',
        'weekRange',
        'today',
        'taskDate',
        'taskDateLabel',
        'settings',
        'counts',
        'completion',
        'tasks',
        'schedule',
        'announcement',
        'duty',
        'dutyGroupId',
        'groups',
        'groupsText',
        'orderText',
        'rotationPreview',
        'stats',
        'boardEmpty',
      ]) {
        assert(hasOwn(data, key), `board load 缺少契约字段 ${key}`)
      }
      assertEqual(data.view, 'board')
      assertEqual(data.weekOffset, 0)
      assertEqual(data.isCurrentWeek, true)
      assertEqual(data.isPastWeek, false)
      assertEqual(data.canEdit, true)
      assertEqual(data.today, TODAY)
      assertEqual(data.taskDate, TODAY)
      assertEqual(data.taskDateLabel, '10/21 周三')
      assert(data.weekLabel.includes('第 1 周'), `weekLabel 异常：${data.weekLabel}`)
      assertEqual(data.weekNumber, 1)
      assert(data.weekRange.includes('–'), `weekRange 异常：${data.weekRange}`)
      assertEqual(data.settings.className, '高二(15)班')
      assertEqual(data.settings.teacher, '王老师')
      assertEqual(data.settings.termStartDate, '')
    })
    await test('board load 空状态：计数 / 完成度 / 列表 / boardEmpty', async () => {
      const data = await loadBoard(env, {})
      assertEqual(data.counts.total, 0)
      assertEqual(data.counts.pending, 0)
      assertEqual(data.counts.done, 0)
      assertEqual(data.counts.high, 0)
      assertEqual(data.counts.overdue, 0)
      assertEqual(data.completion, 0)
      assertEqual(data.tasks.length, 0)
      assertEqual(data.schedule.length, 0)
      assertEqual(data.announcement, '')
      assertEqual(data.boardEmpty, true)
      assertEqual(data.stats.weeks, 0)
      assertEqual(data.stats.tasks, 0)
    })
    await test('board load 轮换预览 / 统计 / 值日分组形状', async () => {
      const data = await loadBoard(env, {})
      assert(Array.isArray(data.groups), 'groups 应为数组')
      assertEqual(data.groups.length, 4)
      for (const group of data.groups) {
        assert(typeof group.id === 'string' && group.id !== '', 'group 缺少 id')
        assert(typeof group.name === 'string' && group.name !== '', 'group 缺少 name')
        assert(Array.isArray(group.members), 'group.members 应为数组')
      }
      assert(Array.isArray(data.rotationPreview), 'rotationPreview 应为数组')
      assertEqual(data.rotationPreview.length, 4, 'rotationPreview 应固定 4 行')
      for (const row of data.rotationPreview) {
        assert(typeof row.week === 'string' && row.week !== '', 'rotationPreview 行缺少 week')
        assert(typeof row.group === 'string' && row.group !== '', 'rotationPreview 行缺少 group')
      }
      assert(data.rotationPreview[0].week.includes('（本周）'), '轮换预览首行应标记本周')
      assertEqual(data.rotationPreview[0].group, '第1组', '本周轮换组应为第1组')
      assert(Array.isArray(data.duty.orderNames) && data.duty.orderNames.length === 4, 'duty.orderNames 异常')
      assert(typeof data.duty.groupName === 'string' && data.duty.groupName !== '', 'duty.groupName 缺失')
      assert(Array.isArray(data.duty.members), 'duty.members 应为数组')
      assertEqual(data.duty.hasOverrideGroup, false)
      assertEqual(data.dutyGroupId, '')
      assert(typeof data.groupsText === 'string' && data.groupsText.includes('第1组'), 'groupsText 缺失')
      assert(typeof data.orderText === 'string' && data.orderText.includes('第1组'), 'orderText 缺失')
      assert(Number.isInteger(data.stats.bytes) && data.stats.bytes > 0, 'stats.bytes 异常')
    })
    await test('board load 带 view / weekOffset 会持久化到 ui.v1', async () => {
      const data = await loadBoard(env, { view: 'schedule', weekOffset: 2 })
      assertEqual(data.view, 'schedule')
      assertEqual(data.weekOffset, 2)
      assertEqual(data.isCurrentWeek, false)
      assertEqual(data.isPastWeek, false)
      assertEqual(data.canEdit, true)
      const ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.view, 'schedule')
      assertEqual(ui.weekOffset, 2)
      const reloaded = await loadBoard(env, {})
      assertEqual(reloaded.view, 'schedule')
      assertEqual(reloaded.weekOffset, 2)
    })
    await test('board save-view 四视图切换并持久化', async () => {
      for (const view of ['board', 'duty', 'schedule', 'settings']) {
        const data = await saveBoardView(env, view)
        assertEqual(data.view, view, `save-view ${view} 返回视图错误`)
        const ui = await env.ctx.storage.get('ui.v1')
        assertEqual(ui.view, view, `save-view ${view} 未持久化`)
        const reloaded = await loadBoard(env, {})
        assertEqual(reloaded.view, view)
      }
    })
    await test('board 周切换持久化：duty/schedule 记住 weekOffset，board/settings 回本周', async () => {
      let data = await saveBoardView(env, 'duty', -2)
      assertEqual(data.weekOffset, -2)
      assertEqual(data.isPastWeek, true)
      assertEqual(data.canEdit, false)
      data = await loadBoard(env, {})
      assertEqual(data.view, 'duty')
      assertEqual(data.weekOffset, -2, 'duty 视图未记住周偏移')
      data = await saveBoardView(env, 'schedule')
      assertEqual(data.view, 'schedule')
      assertEqual(data.weekOffset, -2, 'schedule 视图应沿用 ui.weekOffset')
      data = await saveBoardView(env, 'board')
      assertEqual(data.view, 'board')
      assertEqual(data.weekOffset, 0, '今日视图应固定回本周')
      data = await saveBoardView(env, 'settings')
      assertEqual(data.view, 'settings')
      assertEqual(data.weekOffset, 0, '设置视图应固定回本周')
    })
    await test('board save-view 不推送', async () => {
      const before = pushCount(env)
      await saveBoardView(env, 'duty', 1)
      assertNoPush(env, before, 'board save-view')
      await saveBoardView(env, 'board', 0)
      assertNoPush(env, before, 'board save-view 切回今日')
    })
    await test('board 未知方法按刷新返回数据、不推送', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'not-a-real-method', {})
      const data = expectBoardOk(result, 'board 未知方法')
      assertEqual(result.message, undefined, '未知方法不应返回 message')
      assertEqual(pushCount(env), before, '未知方法不应推送')
      assertEqual(data.view, 'board')
    })
    await test('board weekOffset 越界：load 与写动作都返回 error', async () => {
      const before = pushCount(env)
      const loaded = await invokeBoard(env, 'load', { weekOffset: 99 })
      expectBoardError(loaded, 'board 越界 load')
      assert(loaded.error.includes('12'), `越界提示不明确：${loaded.error}`)
      const added = await invokeBoard(env, 'add-task', { weekOffset: 99, text: '越界写入' })
      expectBoardError(added, 'board 越界 add-task')
      assert(added.error.includes('12'), `越界写提示不明确：${added.error}`)
      assertEqual(pushCount(env), before, '越界写动作不应推送')
      assertEqual(taskByText(env, '越界写入'), null, '越界写动作不应落盘')
    })
    await test('board 过去周 load 标记只读（isPastWeek / canEdit）', async () => {
      const data = await saveBoardView(env, 'duty', -1)
      assertEqual(data.weekOffset, -1)
      assertEqual(data.isCurrentWeek, false)
      assertEqual(data.isPastWeek, true)
      assertEqual(data.canEdit, false)
      const loaded = await loadBoard(env, {})
      assertEqual(loaded.weekOffset, -1)
      assertEqual(loaded.isPastWeek, true)
      assertEqual(loaded.canEdit, false)
      await saveBoardView(env, 'board', 0)
    })
  })

  header('班级事务台 · 今日视图写动作')
  await withEnv({}, async (env) => {
    await test('board add-task 添加今日事务并推送 4 条', async () => {
      await saveBoardView(env, 'board', 0)
      const before = pushCount(env)
      const result = await invokeBoard(env, 'add-task', {
        weekOffset: 0,
        text: '面板事务A',
        dueDate: TODAY,
        dueTime: '18:00',
        priority: 'high',
        category: '作业',
        assignee: '课代表',
      })
      const data = expectBoardOk(result, 'board add-task')
      assertEqual(result.message, '已添加事务')
      assertPushAllSlice(env, before, 'board add-task 推送')
      const task = boardTaskByText(data, '面板事务A')
      assert(task !== null, 'add-task 返回数据缺少新事务')
      assertEqual(task.date, TODAY)
      assertEqual(task.done, false)
      assertEqual(task.priority, 'high')
      assertEqual(task.category, '作业')
      assertEqual(task.assignee, '课代表')
      assertEqual(task.dueTime, '18:00')
      assertEqual(data.boardEmpty, false, '有数据后 boardEmpty 应为 false')
      assertEqual(data.counts.total, 1)
      assertEqual(data.counts.pending, 1)
      assertEqual(data.counts.high, 1)
      assertEqual(data.counts.overdue, 0)
      assertEqual(data.completion, 0)
    })
    await test('board load 每条 task 严格符合 TaskSummary（含 dueLabel / overdue）', async () => {
      const data = await loadBoard(env, {})
      assert(data.tasks.length >= 1, '缺少前置事务')
      for (const task of data.tasks) assertTaskSummary(task, 'board load')
      const task = boardTaskByText(data, '面板事务A')
      assert(task !== null, '找不到前置事务')
      assert(task.dueLabel.includes('18:00'), `dueLabel 未反映截止时间：${task.dueLabel}`)
      assertEqual(task.overdue, false, '18:00 截止的事务在 10:00 不应逾期')
    })
    await test('board 逾期事务 overdue 与 dueLabel 口径', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'add-task', {
        weekOffset: 0,
        text: '逾期事务',
        dueDate: '2026-10-20',
        dueTime: '08:00',
      })
      const data = expectBoardOk(result, 'board 逾期事务 add-task')
      assertPushAllSlice(env, before, 'board 逾期事务推送')
      const task = boardTaskByText(data, '逾期事务')
      assert(task !== null, '找不到逾期事务')
      assertEqual(task.overdue, true, '昨天截止的未完成事务应为逾期')
      assert(task.dueLabel.includes('08:00'), `dueLabel 异常：${task.dueLabel}`)
      assertEqual(data.counts.overdue, 1)
    })
    await test('board add-task 空文本返回 error 且不推送', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'add-task', { weekOffset: 0, text: '   ' })
      expectBoardError(result, 'board add-task 空文本')
      assert(result.error.includes('输入'), `空文本提示不明确：${result.error}`)
      assertEqual(result.message, undefined)
      assertNoPush(env, before, 'board add-task 空文本')
    })
    await test('board update-task 修改文本 / 优先级 / 截止 / 负责人', async () => {
      const data = await loadBoard(env, {})
      const task = boardTaskByText(data, '面板事务A')
      const before = pushCount(env)
      const result = await invokeBoard(env, 'update-task', {
        weekOffset: 0,
        id: task.id,
        text: '面板事务A（改）',
        priority: 'low',
        dueDate: '2026-10-22',
        dueTime: '20:00',
        assignee: '班长',
      })
      const updated = expectBoardOk(result, 'board update-task')
      assertEqual(result.message, '事务已更新')
      assertPushAllSlice(env, before, 'board update-task 推送')
      const changed = updated.tasks.find((item) => item.id === task.id)
      assert(changed !== undefined, 'update-task 后找不到事务')
      assertEqual(changed.text, '面板事务A（改）')
      assertEqual(changed.priority, 'low')
      assertEqual(changed.dueDate, '2026-10-22')
      assertEqual(changed.dueTime, '20:00')
      assertEqual(changed.assignee, '班长')
      assert(changed.dueLabel.includes('20:00'), `dueLabel 未更新：${changed.dueLabel}`)
    })
    await test('board update-task 空文本 / 未知 id / 无修改内容均返回 error', async () => {
      const data = await loadBoard(env, {})
      const task = boardTaskByText(data, '面板事务A（改）')
      const before = pushCount(env)
      const emptyText = await invokeBoard(env, 'update-task', { weekOffset: 0, id: task.id, text: '' })
      expectBoardError(emptyText, 'board update-task 空文本')
      const unknown = await invokeBoard(env, 'update-task', { weekOffset: 0, id: 't-not-exist', text: 'x' })
      expectBoardError(unknown, 'board update-task 未知 id')
      const noop = await invokeBoard(env, 'update-task', { weekOffset: 0, id: task.id })
      expectBoardError(noop, 'board update-task 无修改内容')
      assert(noop.error.includes('没有要修改'), `无修改内容提示不明确：${noop.error}`)
      assertNoPush(env, before, 'board update-task 失败')
    })
    await test('board toggle-task 完成与恢复', async () => {
      const data = await loadBoard(env, {})
      const task = boardTaskByText(data, '面板事务A（改）')
      const before = pushCount(env)
      const done = await invokeBoard(env, 'toggle-task', { weekOffset: 0, id: task.id })
      const doneData = expectBoardOk(done, 'board toggle-task 完成')
      assertEqual(done.message, '已完成')
      assertPushAllSlice(env, before, 'board toggle-task 推送')
      assertEqual(doneData.tasks.find((item) => item.id === task.id).done, true)
      const restored = await invokeBoard(env, 'toggle-task', { weekOffset: 0, id: task.id })
      const restoredData = expectBoardOk(restored, 'board toggle-task 恢复')
      assertEqual(restored.message, '已恢复为待办')
      assertEqual(restoredData.tasks.find((item) => item.id === task.id).done, false)
      assertEqual(restoredData.counts.done, 0)
    })
    await test('board delete-task 可删除已完成事务', async () => {
      const data = await loadBoard(env, {})
      const task = boardTaskByText(data, '面板事务A（改）')
      await invokeBoard(env, 'toggle-task', { weekOffset: 0, id: task.id })
      const doneData = await loadBoard(env, {})
      assertEqual(boardTaskByText(doneData, '面板事务A（改）').done, true, '前置：事务应为已完成')
      const before = pushCount(env)
      const deleted = await invokeBoard(env, 'delete-task', { weekOffset: 0, id: task.id })
      const deletedData = expectBoardOk(deleted, 'board delete-task 已完成事务')
      assertEqual(deleted.message, '已删除事务')
      assertPushAllSlice(env, before, 'board delete-task 推送')
      assertEqual(deletedData.tasks.some((item) => item.id === task.id), false, '已完成事务删除后仍存在')
      assertEqual(taskByText(env, '面板事务A（改）'), null, '已完成事务未从存储删除')
    })
    await test('board delete-task 支持 text + date（id 缺省）', async () => {
      await invokeBoard(env, 'add-task', { weekOffset: 0, text: '按文本删除事务' })
      const data = await loadBoard(env, {})
      const task = boardTaskByText(data, '按文本删除事务')
      assert(task !== null, '前置事务未写入')
      const deleted = await invokeBoard(env, 'delete-task', { weekOffset: 0, text: '按文本删除', date: TODAY })
      const deletedData = expectBoardOk(deleted, 'board delete-task 按文本')
      assertEqual(deleted.message, '已删除事务')
      assertEqual(boardTaskByText(deletedData, '按文本删除事务'), null)
    })
    await test('board add-schedule 添加安排并推送 4 条', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'add-schedule', {
        weekOffset: 0,
        weekday: 4,
        time: '10:00',
        title: '安排A',
        place: '报告厅',
        note: '带材料',
      })
      const data = expectBoardOk(result, 'board add-schedule')
      assertEqual(result.message, '已添加安排')
      assertPushAllSlice(env, before, 'board add-schedule 推送')
      const entry = boardScheduleByTitle(data, '安排A')
      assert(entry !== null, 'add-schedule 返回数据缺少安排')
      assertEqual(entry.weekday, 4)
      assertEqual(entry.time, '10:00')
      assertEqual(entry.place, '报告厅')
      assertEqual(entry.note, '带材料')
    })
    await test('board update-schedule 修改安排', async () => {
      let data = await loadBoard(env, {})
      const entry = boardScheduleByTitle(data, '安排A')
      const before = pushCount(env)
      const result = await invokeBoard(env, 'update-schedule', {
        weekOffset: 0,
        id: entry.id,
        weekday: 5,
        time: '14:30',
        title: '安排B',
        place: '报告厅2',
      })
      const updated = expectBoardOk(result, 'board update-schedule')
      assertEqual(result.message, '安排已更新')
      assertPushAllSlice(env, before, 'board update-schedule 推送')
      const changed = updated.schedule.find((item) => item.id === entry.id)
      assert(changed !== undefined, 'update-schedule 后找不到安排')
      assertEqual(changed.title, '安排B')
      assertEqual(changed.weekday, 5)
      assertEqual(changed.time, '14:30')
      assertEqual(changed.place, '报告厅2')
    })
    await test('board 安排的提醒设置可保存、可改回默认、可关闭', async () => {
      const added = await invokeBoard(env, 'add-schedule', {
        weekOffset: 0,
        weekday: 3,
        time: '08:00',
        title: '提醒检查',
        remind: true,
        remindLead: 15,
      })
      const data = expectBoardOk(added, 'board add-schedule 提醒')
      const entry = boardScheduleByTitle(data, '提醒检查')
      assert(entry !== null, '返回数据缺少这条安排')
      assertEqual(entry.remind, true, 'add-schedule 未保存 remind')
      assertEqual(entry.remindLead, 15, 'add-schedule 未保存 remindLead')

      const toDefault = await invokeBoard(env, 'update-schedule', { weekOffset: 0, id: entry.id, remindLead: '' })
      const backToDefault = expectBoardOk(toDefault, 'board update-schedule 提前量改默认')
      const clearedLead = backToDefault.schedule.find((item) => item.id === entry.id)
      assertEqual(clearedLead.remind, true, '只清提前量不应关掉提醒')
      assertEqual(hasOwn(clearedLead, 'remindLead'), false, 'remindLead 未被清除，无法回落全局默认')

      const off = await invokeBoard(env, 'update-schedule', { weekOffset: 0, id: entry.id, remind: false })
      const offData = expectBoardOk(off, 'board update-schedule 关闭提醒')
      assertEqual(offData.schedule.find((item) => item.id === entry.id).remind, false)
    })
    await test('add_schedule 工具的提醒设置进总览文本', async () => {
      await addSchedule(env, { weekday: 3, time: '14:00', title: '家长开放日', remind: true, remindLead: 30 })
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('家长开放日'), '总览缺少这条安排')
      assert(overview.content.includes('提前 30 分钟提醒'), `总览未标出提前量：${overview.content}`)
      const added = await invokeTool(env, 'add_schedule', { weekday: 3, time: '15:00', title: '无提醒安排' })
      assert(!added.content.includes('到点提醒'), '未开提醒的安排不应声称会提醒')
    })
    await test('board delete-schedule 按 id / 按 weekday + title 删除', async () => {
      let data = await loadBoard(env, {})
      const entry = boardScheduleByTitle(data, '安排B')
      const before = pushCount(env)
      const byId = await invokeBoard(env, 'delete-schedule', { weekOffset: 0, id: entry.id })
      const byIdData = expectBoardOk(byId, 'board delete-schedule 按 id')
      assertEqual(byId.message, '已删除安排')
      assertPushAllSlice(env, before, 'board delete-schedule 推送')
      assertEqual(byIdData.schedule.some((item) => item.id === entry.id), false)

      await invokeBoard(env, 'add-schedule', { weekOffset: 0, weekday: 2, title: '临时安排' })
      const byTitle = await invokeBoard(env, 'delete-schedule', {
        weekOffset: 0,
        weekday: 2,
        title: '临时',
      })
      const byTitleData = expectBoardOk(byTitle, 'board delete-schedule 按标题')
      assertEqual(byTitle.message, '已删除安排')
      assertEqual(byTitleData.schedule.some((item) => item.title === '临时安排'), false)
      const missing = await invokeBoard(env, 'delete-schedule', { weekOffset: 0, weekday: 3, title: '不存在' })
      expectBoardError(missing, 'board delete-schedule 不存在')
    })
    await test('board set-duty-week 指定组 + 备注', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'set-duty-week', {
        weekOffset: 0,
        groupId: 'g2',
        note: '第2组值日',
      })
      const data = expectBoardOk(result, 'board set-duty-week')
      assertEqual(result.message, '值日轮换已保存')
      assertPushAllSlice(env, before, 'board set-duty-week 推送')
      assertEqual(data.duty.groupName, '第2组')
      assertEqual(data.duty.hasOverrideGroup, true)
      assertEqual(data.dutyGroupId, 'g2')
      assertEqual(data.duty.note, '第2组值日')
    })
    await test('board set-duty-week 恢复自动轮换（groupId 空串）', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'set-duty-week', { weekOffset: 0, groupId: '' })
      const data = expectBoardOk(result, 'board set-duty-week 清空')
      assertPushAllSlice(env, before, 'board set-duty-week 清空推送')
      assertEqual(data.duty.hasOverrideGroup, false)
      assertEqual(data.dutyGroupId, '')
      assertEqual(data.duty.groupName, '第1组')
      assertEqual(data.duty.note, '第2组值日', '清空指定组不应顺带清掉备注')
    })
    await test('board save-duty-groups 保存分组与轮换顺序', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'save-duty-groups', {
        weekOffset: 0,
        groups: [
          { name: '第1组', members: ['张三', '李四'] },
          { name: '第2组', members: ['王五'] },
        ],
        order: ['第2组', '第1组'],
      })
      const data = expectBoardOk(result, 'board save-duty-groups')
      assertEqual(result.message, '值日分组已保存')
      assertPushAllSlice(env, before, 'board save-duty-groups 推送')
      assertEqual(data.groups.length, 2)
      assertEqual(data.groups.map((group) => group.name).join(','), '第1组,第2组')
      assertEqual(data.groups[0].members.join(','), '张三,李四')
      assertEqual(data.groupsText, '第1组: 张三, 李四\n第2组: 王五')
      assertEqual(data.orderText, '第2组，第1组')
      assertEqual(data.duty.orderNames.join(','), '第2组,第1组')
      assertEqual(data.rotationPreview[0].group, '第2组', '轮换预览未按新顺序计算')
    })
    await test('board save-announcement 保存 / 清空', async () => {
      const before = pushCount(env)
      const saved = await invokeBoard(env, 'save-announcement', { weekOffset: 0, text: '本周五下午大扫除' })
      const savedData = expectBoardOk(saved, 'board save-announcement')
      assertEqual(saved.message, '通知已保存')
      assertPushAllSlice(env, before, 'board save-announcement 推送')
      assertEqual(savedData.announcement, '本周五下午大扫除')
      const cleared = await invokeBoard(env, 'save-announcement', { weekOffset: 0, text: '' })
      const clearedData = expectBoardOk(cleared, 'board save-announcement 清空')
      assertEqual(cleared.message, '通知已清空')
      assertEqual(clearedData.announcement, '')
    })
  })

  header('班级事务台 · 清理与示例周')
  await test('board clear-scope tasks 只清理今天的事务', async () => {
    await withEnv({}, async (env) => {
      await invokeBoard(env, 'add-task', { weekOffset: 0, text: '待清理今日事务' })
      await invokeTool(env, 'add_task', { text: '明天的保留事务', date: '2026-10-22' })
      const before = pushCount(env)
      const result = await invokeBoard(env, 'clear-scope', { weekOffset: 0, scope: 'tasks' })
      const data = expectBoardOk(result, 'board clear-scope tasks')
      assertEqual(result.message, '已清理所选数据')
      assertPushAllSlice(env, before, 'board clear-scope tasks 推送')
      assertEqual(data.tasks.length, 0, '今日事务未被清理')
      const tomorrow = await invokeTool(env, 'get_overview', { date: '2026-10-22' })
      assert(tomorrow.content.includes('明天的保留事务'), '未来事务不应被清理')
    })
  })
  await test('board clear-scope schedule', async () => {
    await withEnv({}, async (env) => {
      await invokeBoard(env, 'add-schedule', { weekOffset: 0, weekday: 2, title: '待清理安排A' })
      await invokeBoard(env, 'add-schedule', { weekOffset: 0, weekday: 3, title: '待清理安排B' })
      const before = pushCount(env)
      const result = await invokeBoard(env, 'clear-scope', { weekOffset: 0, scope: 'schedule' })
      const data = expectBoardOk(result, 'board clear-scope schedule')
      assertEqual(result.message, '已清理所选数据')
      assertPushAllSlice(env, before, 'board clear-scope schedule 推送')
      assertEqual(data.schedule.length, 0, '本周安排未被清理')
      const board = await env.ctx.storage.get('board.v1')
      const stored = Object.values(board.weeks).reduce((sum, week) => sum + week.schedule.length, 0)
      assertEqual(stored, 0)
    })
  })
  await test('board clear-scope duty', async () => {
    await withEnv({}, async (env) => {
      await invokeBoard(env, 'set-duty-week', { weekOffset: 0, groupId: 'g3', note: '待清理备注' })
      const before = pushCount(env)
      const result = await invokeBoard(env, 'clear-scope', { weekOffset: 0, scope: 'duty' })
      const data = expectBoardOk(result, 'board clear-scope duty')
      assertEqual(result.message, '已清理所选数据')
      assertPushAllSlice(env, before, 'board clear-scope duty 推送')
      assertEqual(data.duty.hasOverrideGroup, false)
      assertEqual(data.duty.note, '')
      assertEqual(data.dutyGroupId, '')
    })
  })
  await test('board clear-scope all', async () => {
    await withEnv({}, async (env) => {
      await invokeTool(env, 'add_task', { text: '全部清理事务' })
      await invokeBoard(env, 'add-schedule', { weekOffset: 0, weekday: 1, title: '全部清理安排' })
      await invokeBoard(env, 'set-duty-week', { weekOffset: 0, groupId: 'g2', note: '全部清理备注' })
      await invokeBoard(env, 'save-announcement', { weekOffset: 0, text: '全部清理通知' })
      const before = pushCount(env)
      const result = await invokeBoard(env, 'clear-scope', { weekOffset: 0, scope: 'all' })
      const data = expectBoardOk(result, 'board clear-scope all')
      assertEqual(result.message, '已清理所选数据')
      assertPushAllSlice(env, before, 'board clear-scope all 推送')
      assertEqual(data.tasks.length, 0)
      assertEqual(data.schedule.length, 0)
      assertEqual(data.announcement, '')
      assertEqual(data.duty.hasOverrideGroup, false)
      assertEqual(data.duty.note, '')
      assertEqual(data.boardEmpty, true, '全部清理后应回到空周')
    })
  })
  await withEnv({}, async (env) => {
    await test('board load-demo 仅空周可用', async () => {
      const empty = await loadBoard(env, {})
      assertEqual(empty.boardEmpty, true, '前置：新环境应为空周')
      const before = pushCount(env)
      const result = await invokeBoard(env, 'load-demo', {})
      const data = expectBoardOk(result, 'board load-demo')
      assertEqual(result.message, '示例数据已写入')
      assertPushAllSlice(env, before, 'board load-demo 推送')
      assertEqual(data.tasks.length, 4, '示例事务数量异常')
      assertEqual(data.schedule.length, 3, '示例安排数量异常')
      assert(data.announcement !== '', '示例通知缺失')
      assertEqual(data.boardEmpty, false)
      assertEqual(data.counts.total, 4)
      const again = await invokeBoard(env, 'load-demo', {})
      expectBoardError(again, 'board load-demo 非空周')
      assert(again.error.includes('已经有数据'), `非空周提示不明确：${again.error}`)
      const wrongWeek = await invokeBoard(env, 'load-demo', { weekOffset: 1 })
      expectBoardError(wrongWeek, 'board load-demo 非本周')
      assert(wrongWeek.error.includes('本周'), `非本周提示不明确：${wrongWeek.error}`)
    })
  })

  header('班级事务台 · 过去周只读')
  await withEnv({}, async (env) => {
    await test('过去周只读：15 个写动作全部返回 error', async () => {
      const cases = [
        ['add-task', { text: '过去周事务' }],
        ['update-task', { id: 't-not-exist', text: 'x' }],
        ['toggle-task', { id: 't-not-exist' }],
        ['delete-task', { id: 't-not-exist' }],
        ['add-schedule', { weekday: 2, title: '过去周安排' }],
        ['update-schedule', { id: 's-not-exist', title: 'x' }],
        ['delete-schedule', { id: 's-not-exist' }],
        ['add-routine', { title: '过去周例行' }],
        ['update-routine', { id: 'r-not-exist', title: 'x' }],
        ['delete-routine', { id: 'r-not-exist' }],
        ['set-duty-week', { groupId: 'g1' }],
        ['save-duty-groups', { groups: [{ name: '第1组', members: [] }] }],
        ['save-announcement', { text: '过去周通知' }],
        ['clear-scope', { scope: 'all' }],
        ['load-demo', {}],
      ]
      assertEqual(cases.length, 15, '写动作清单应覆盖 15 个方法')
      for (const [method, params] of cases) {
        const result = await invokeBoard(env, method, { weekOffset: -1, ...params })
        expectBoardError(result, `过去周 ${method}`)
        assert(
          result.error.includes('过去周只读'),
          `过去周 ${method} 未返回只读提示：${result.error}`,
        )
        assertEqual(result.message, undefined, `过去周 ${method} 不应返回成功提示`)
      }
    })
    await test('过去周只读：写拒绝不推送、不落盘', async () => {
      const snapshot = JSON.stringify(env.store.get('board.v1'))
      const before = pushCount(env)
      await invokeBoard(env, 'add-task', { weekOffset: -1, text: '过去周不应写入' })
      await invokeBoard(env, 'clear-scope', { weekOffset: -1, scope: 'all' })
      await invokeBoard(env, 'save-announcement', { weekOffset: -1, text: '过去周通知' })
      assertNoPush(env, before, '过去周写保护')
      assertEqual(JSON.stringify(env.store.get('board.v1')), snapshot, '过去周写保护不应改写数据')
      const past = await loadBoard(env, { weekOffset: -1 })
      assertEqual(past.weekOffset, -1)
      assertEqual(past.tasks.some((task) => task.text === '过去周不应写入'), false)
      assertEqual(past.announcement, '')
    })
    await test('本周仍可写（weekOffset 0 对照）', async () => {
      const before = pushCount(env)
      const result = await invokeBoard(env, 'add-task', { weekOffset: 0, text: '本周可写事务' })
      const data = expectBoardOk(result, 'board 本周可写')
      assertEqual(result.message, '已添加事务')
      assertPushAllSlice(env, before, 'board 本周可写推送')
      assertEqual(boardTaskByText(data, '本周可写事务') !== null, true)
    })
  })

  // ═════════════════════════ 班级周历（页面 API）═════════════════════════

  header('班级周历 · load 与可编辑标记')
  await withEnv({}, async (env) => {
    await test('calendar load 固定返回 7 天与 isPast / canEdit / canAddTask', async () => {
      const data = await loadCalendar(env)
      assertEqual(data.days.length, 7, 'days 必须固定 7 项')
      assertEqual(data.days[0].date, '2026-10-19', '第一天应为本周一')
      assertEqual(data.days[6].date, '2026-10-25', '最后一天应为本周日')
      assertEqual(data.days.map((day) => day.weekday).join(','), '1,2,3,4,5,6,7', 'weekday 应依次为 1..7')
      assertEqual(data.days[0].label, '10/19 周一', 'day.label 应为日期标签')
      assertEqual(data.days[2].isToday, true, '周三应为今天')
      assertEqual(data.days.filter((day) => day.isToday).length, 1, '有且只有一天是今天')
      assertEqual(data.todayKey, TODAY)
      assertEqual(data.weekOffset, 0)
      assertEqual(data.isCurrentWeek, true)
      assertEqual(data.canEdit, true)
      assert(typeof data.weekLabel === 'string' && data.weekLabel.includes('10/19'), `weekLabel 异常：${data.weekLabel}`)
      assert(Number.isInteger(data.weekNumber) && data.weekNumber >= 1, `weekNumber 异常：${data.weekNumber}`)
      assert(Array.isArray(data.groups) && data.groups.length >= 1, 'groups 应为非空数组')
      assert(Array.isArray(data.duty.members), 'duty.members 应为数组')
      assert(typeof data.duty.groupName === 'string' && data.duty.groupName !== '', 'duty.groupName 缺失')
      assert(
        data.days.every((day) => Array.isArray(day.tasks) && Array.isArray(day.schedule)),
        '每天的 tasks / schedule 应为数组',
      )
      // 本周：过去天只读「新增」，但可编辑/删除；今天与未来天可新增。
      assertEqual(data.days[0].isPast, true, '周一应标记已过去')
      assertEqual(data.days[0].canEdit, true, '本周已过去的天仍可编辑/删除')
      assertEqual(data.days[0].canAddTask, false, '本周已过去的天不能新增事务')
      assertEqual(data.days[1].isPast, true, '周二应标记已过去')
      assertEqual(data.days[1].canEdit, true, '周二仍可编辑/删除')
      assertEqual(data.days[1].canAddTask, false, '周二不能新增事务')
      assertEqual(data.days[2].isPast, false, '今天不应标记已过去')
      assertEqual(data.days[2].canAddTask, true, '今天应可新增事务')
      assertEqual(data.days[6].canEdit, true, '未来天应可编辑')
      assertEqual(data.days[6].canAddTask, true, '未来天应可新增事务')
    })
    await test('calendar 本周过去天不能新增事务（后端仍拒绝）', async () => {
      const result = await invokeCalendar(env, 'add-task', {
        date: '2026-10-20',
        text: '过去天新增',
        weekOffset: 0,
      })
      expectCalendarError(result, 'calendar 本周过去天 add-task')
      assert(result.error.includes('过去'), `过去天新增提示不明确：${result.error}`)
      const data = await loadCalendar(env)
      assertEqual(calendarTaskByText(data, '过去天新增'), null)
    })
    await test('calendar load 今日：事务摘要 / 安排 / 值日 / 通知 / 统计', async () => {
      await invokeTool(env, 'add_task', {
        text: '周历今日作业',
        date: TODAY,
        dueDate: TODAY,
        dueTime: '18:00',
        priority: 'high',
        category: '作业',
        assignee: '课代表',
      })
      await invokeTool(env, 'add_schedule', { weekday: 3, time: '16:00', title: '周历班会', place: '教室' })
      await invokeTool(env, 'set_duty_week', { groupName: '第2组', note: '周历值日备注' })
      await invokeTool(env, 'set_announcement', { text: '周历班级通知' })

      const data = await loadCalendar(env)
      const today = calendarDayOf(data, TODAY)
      assertEqual(today.weekday, 3, '周三的 weekday 应为 3')
      const task = today.tasks.find((item) => item.text === '周历今日作业')
      assert(task !== undefined, '今日事务未出现在今天')
      assertTaskSummary(task, 'calendar task')
      assertEqual(task.date, TODAY)
      assertEqual(task.done, false)
      assertEqual(task.priority, 'high')
      assertEqual(task.category, '作业')
      assertEqual(task.assignee, '课代表')
      assert(task.dueLabel.includes('18:00'), `dueLabel 未包含截止时间：${task.dueLabel}`)
      assertEqual(task.overdue, false, '18:00 截止的任务 10:00 时不应算逾期')
      assert(
        today.schedule.some((entry) => entry.title === '周历班会' && entry.time === '16:00'),
        '对应 weekday 的安排未出现在周三',
      )
      assertEqual(data.duty.groupName, '第2组')
      assertEqual(data.duty.note, '周历值日备注')
      assertEqual(data.announcement, '周历班级通知')
      const allTasks = data.days.flatMap((day) => day.tasks)
      assertEqual(data.stats.total, allTasks.length, 'stats.total 与 7 天事务数不一致')
      assertEqual(data.stats.pending, allTasks.filter((item) => !item.done).length, 'stats.pending 与 7 天待办数不一致')
      assert(data.stats.pending >= 1, 'stats.pending 应包含今日事务')
    })
    await test('calendar 过去周：isPast 全 true、canEdit / canAddTask 全 false', async () => {
      const data = await loadCalendar(env, { weekOffset: -1 })
      assertEqual(data.weekOffset, -1)
      assertEqual(data.isCurrentWeek, false)
      assertEqual(data.canEdit, false, '过去周顶层 canEdit 应为 false')
      assertEqual(data.days.length, 7)
      assertEqual(data.days[0].date, '2026-10-12')
      assertEqual(data.days[6].date, '2026-10-18')
      assert(data.days.every((day) => day.canEdit === false), '过去周每天 canEdit 都应为 false')
      assert(data.days.every((day) => day.canAddTask === false), '过去周每天 canAddTask 都应为 false')
      assert(data.days.every((day) => day.isPast === true), '过去周每天 isPast 都应为 true')
      assert(data.days.every((day) => day.isToday === false), '过去周不应包含今天')
      assertEqual(data.todayKey, TODAY)
    })
    await test('calendar 未来周：isPast 全 false、canEdit / canAddTask 全 true', async () => {
      const data = await loadCalendar(env, { weekOffset: 1 })
      assertEqual(data.weekOffset, 1)
      assertEqual(data.canEdit, true, '未来周应可编辑')
      assertEqual(data.days[0].date, '2026-10-26')
      assertEqual(data.days[6].date, '2026-11-01')
      assert(data.days.every((day) => day.isPast === false), '未来周每天 isPast 都应为 false')
      assert(data.days.every((day) => day.canEdit === true), '未来周每天 canEdit 都应为 true')
      assert(data.days.every((day) => day.canAddTask === true), '未来周每天 canAddTask 都应为 true')
    })
    await test('calendar 事务动作：add / update / toggle / delete 均落盘', async () => {
      const added = await invokeCalendar(env, 'add-task', {
        text: '周历新增事务',
        date: TODAY,
        priority: 'high',
        category: '作业',
        dueTime: '17:00',
        weekOffset: 0,
      })
      const addedData = expectCalendarOk(added, 'calendar add-task')
      assert(typeof added.message === 'string' && added.message !== '', 'add-task 应返回 message')
      const created = calendarTaskByText(addedData, '周历新增事务')
      assert(created !== null, 'add-task 返回数据里找不到新事务')
      const id = created.id
      assertEqual(created.date, TODAY)
      assertEqual(created.done, false)

      const tomorrow = await invokeCalendar(env, 'add-task', {
        text: '周历明日事务',
        date: '2026-10-22',
        weekOffset: 0,
      })
      const tomorrowData = expectCalendarOk(tomorrow, 'calendar add-task 明天')
      assert(typeof tomorrow.message === 'string' && tomorrow.message !== '', 'add-task 明天应返回 message')
      assert(
        calendarDayOf(tomorrowData, '2026-10-22').tasks.some((task) => task.text === '周历明日事务'),
        '明天的事务未落到对应天',
      )

      let data = await loadCalendar(env)
      const persisted = calendarTaskById(data, id)
      assert(persisted !== null, 'load 找不到新增事务')
      assertEqual(persisted.date, TODAY)
      assert(calendarDayOf(data, TODAY).tasks.some((task) => task.id === id), '今日事务不在今天')

      const updated = await invokeCalendar(env, 'update-task', {
        id,
        text: '周历事务（改）',
        priority: 'low',
        dueTime: '09:30',
        weekOffset: 0,
      })
      const updatedData = expectCalendarOk(updated, 'calendar update-task')
      assert(typeof updated.message === 'string' && updated.message !== '', 'update-task 应返回 message')
      const updatedTask = calendarTaskById(updatedData, id)
      assert(updatedTask !== null, 'update-task 后找不到事务')
      assertEqual(updatedTask.text, '周历事务（改）')
      assertEqual(updatedTask.priority, 'low')
      assertEqual(updatedTask.dueTime, '09:30')

      const toggled = await invokeCalendar(env, 'toggle-task', { id, weekOffset: 0 })
      const toggledData = expectCalendarOk(toggled, 'calendar toggle-task')
      assertEqual(calendarTaskById(toggledData, id).done, true, 'toggle-task 未标记完成')
      const restored = await invokeCalendar(env, 'toggle-task', { id, weekOffset: 0 })
      const restoredData = expectCalendarOk(restored, 'calendar toggle-task 恢复')
      assertEqual(calendarTaskById(restoredData, id).done, false, '再次 toggle 未恢复为待办')

      const deleted = await invokeCalendar(env, 'delete-task', { id, weekOffset: 0 })
      const deletedData = expectCalendarOk(deleted, 'calendar delete-task')
      assert(typeof deleted.message === 'string' && deleted.message !== '', 'delete-task 应返回 message')
      assertEqual(calendarTaskById(deletedData, id), null, 'delete-task 返回数据仍含该事务')
      data = await loadCalendar(env)
      assertEqual(calendarTaskById(data, id), null, 'delete-task 后 load 仍能找到事务')
      assert(calendarTaskByText(data, '周历明日事务') !== null, '删除事务不应误删其他事务')
    })
    await test('calendar move-task：同周移动', async () => {
      const added = await invokeCalendar(env, 'add-task', {
        text: '周历移动事务',
        date: TODAY,
        weekOffset: 0,
      })
      const id = calendarTaskByText(expectCalendarOk(added, 'move-task 前置 add-task'), '周历移动事务').id
      const sameWeek = await invokeCalendar(env, 'move-task', { id, date: '2026-10-22', weekOffset: 0 })
      const sameWeekData = expectCalendarOk(sameWeek, 'calendar 同周 move-task')
      assert(typeof sameWeek.message === 'string' && sameWeek.message !== '', 'move-task 应返回 message')
      const moved = calendarTaskById(sameWeekData, id)
      assert(moved !== null, '同周移动后返回数据缺少事务')
      assertEqual(moved.date, '2026-10-22', '同周移动未更新 task.date')
      assert(
        !calendarDayOf(sameWeekData, TODAY).tasks.some((task) => task.id === id),
        '同周移动后原天仍保留事务',
      )
      assert(
        calendarDayOf(sameWeekData, '2026-10-22').tasks.some((task) => task.id === id),
        '同周移动后目标天缺少事务',
      )
    })
    await test('calendar move-task：跨周移动', async () => {
      const data = await loadCalendar(env)
      const moved = data.days.flatMap((day) => day.tasks).find((task) => task.text === '周历移动事务')
      assert(moved !== undefined, '找不到待移动事务')
      const crossWeek = await invokeCalendar(env, 'move-task', { id: moved.id, date: '2026-10-27', weekOffset: 0 })
      expectCalendarOk(crossWeek, 'calendar 跨周 move-task')
      const currentWeek = await loadCalendar(env, { weekOffset: 0 })
      assertEqual(calendarTaskById(currentWeek, moved.id), null, '跨周移动后原周仍能找到事务')
      const nextWeek = await loadCalendar(env, { weekOffset: 1 })
      assertEqual(nextWeek.weekOffset, 1)
      assertEqual(nextWeek.isCurrentWeek, false)
      const nextTask = calendarTaskById(nextWeek, moved.id)
      assert(nextTask !== null, '跨周移动后下周找不到事务')
      assertEqual(nextTask.date, '2026-10-27')
      assertEqual(nextWeek.canEdit, true, '下周应可编辑')
    })
    await test('calendar move-task：拖到本周过去天被拒绝且不半写', async () => {
      const added = await invokeCalendar(env, 'add-task', { text: '拖拽目标事务', date: TODAY, weekOffset: 0 })
      const id = calendarTaskByText(expectCalendarOk(added, '拖拽前置 add-task'), '拖拽目标事务').id
      const bad = await invokeCalendar(env, 'move-task', { id, date: '2026-10-20', weekOffset: 0 })
      expectCalendarError(bad, 'calendar 过去天 move-task')
      assert(bad.error.includes('过去'), `过去天拖拽提示不明确：${bad.error}`)
      const after = await loadCalendar(env, { weekOffset: 0 })
      const kept = calendarTaskById(after, id)
      assert(kept !== null, '非法移动导致事务丢失')
      assertEqual(kept.date, TODAY, '非法移动后事务日期被改写（半写）')
    })
    await test('calendar 安排动作：add / update / delete 均出现在对应天', async () => {
      const added = await invokeCalendar(env, 'add-schedule', {
        weekday: 4,
        time: '10:00',
        title: '周历安排',
        place: '报告厅',
        weekOffset: 0,
      })
      const addedData = expectCalendarOk(added, 'calendar add-schedule')
      assert(typeof added.message === 'string' && added.message !== '', 'add-schedule 应返回 message')
      const entry = calendarDayOf(addedData, '2026-10-22').schedule.find((item) => item.title === '周历安排')
      assert(entry !== undefined, '周四缺少新安排')
      assertEqual(entry.time, '10:00')
      assertEqual(entry.place, '报告厅')
      const id = entry.id

      const updated = await invokeCalendar(env, 'update-schedule', {
        id,
        title: '周历安排（改）',
        time: '14:30',
        weekOffset: 0,
      })
      const updatedData = expectCalendarOk(updated, 'calendar update-schedule')
      assert(typeof updated.message === 'string' && updated.message !== '', 'update-schedule 应返回 message')
      const updatedEntry = calendarScheduleById(updatedData, id)
      assert(updatedEntry !== null, 'update-schedule 后找不到安排')
      assertEqual(updatedEntry.title, '周历安排（改）')
      assertEqual(updatedEntry.time, '14:30')

      const deleted = await invokeCalendar(env, 'delete-schedule', { id, weekOffset: 0 })
      const deletedData = expectCalendarOk(deleted, 'calendar delete-schedule')
      assert(typeof deleted.message === 'string' && deleted.message !== '', 'delete-schedule 应返回 message')
      assertEqual(calendarScheduleById(deletedData, id), null, 'delete-schedule 返回数据仍含安排')
      const after = await loadCalendar(env)
      assertEqual(calendarScheduleById(after, id), null, 'delete-schedule 后 load 仍能找到安排')
    })
    await test('calendar set-duty-week / save-announcement 落盘并出现在 load', async () => {
      const duty = await invokeCalendar(env, 'set-duty-week', {
        groupName: '第3组',
        note: '周历值日备注',
        weekOffset: 0,
      })
      const dutyData = expectCalendarOk(duty, 'calendar set-duty-week')
      assert(typeof duty.message === 'string' && duty.message !== '', 'set-duty-week 应返回 message')
      assertEqual(dutyData.duty.groupName, '第3组')
      assertEqual(dutyData.duty.note, '周历值日备注')
      const afterDuty = await loadCalendar(env)
      assertEqual(afterDuty.duty.groupName, '第3组')
      assertEqual(afterDuty.duty.note, '周历值日备注')

      const saved = await invokeCalendar(env, 'save-announcement', {
        text: '周历通知：周五大扫除',
        weekOffset: 0,
      })
      const savedData = expectCalendarOk(saved, 'calendar save-announcement')
      assert(typeof saved.message === 'string' && saved.message !== '', 'save-announcement 应返回 message')
      assertEqual(savedData.announcement, '周历通知：周五大扫除')
      const afterNotice = await loadCalendar(env)
      assertEqual(afterNotice.announcement, '周历通知：周五大扫除')
    })
    await test('calendar 非法输入：未知事务 id / 未知 method 不写数据且不抛错', async () => {
      await invokeCalendar(env, 'add-task', { text: '周历保留事务', date: TODAY, weekOffset: 0 })
      const before = await loadCalendar(env)
      const beforeDays = JSON.stringify(before.days)
      assert(calendarTaskByText(before, '周历保留事务') !== null, '前置事务缺失')

      for (const method of ['toggle-task', 'delete-task']) {
        const result = await invokeCalendar(env, method, { id: 't-not-exist', weekOffset: 0 })
        const data = expectCalendarError(result, `calendar ${method} 未知 id`)
        assertEqual(result.message, undefined, `${method} 失败时不应返回 message`)
        assertEqual(JSON.stringify(data.days), beforeDays, `${method} 未知 id 不应改写数据`)
      }

      const unknown = await invokeCalendar(env, 'not-a-real-method', { weekOffset: 0 })
      assert(unknown !== null && typeof unknown === 'object', '未知 method 未返回对象')
      assert(unknown.data !== null && typeof unknown.data === 'object', '未知 method 缺少 data')
      assertEqual(unknown.error, undefined, '未知 method 不应返回 error')
      assertEqual(unknown.message, undefined, '未知 method 不应返回 message')

      const after = await loadCalendar(env)
      assertEqual(JSON.stringify(after.days), beforeDays, '非法输入后数据被改写')
    })
    await test('calendar dueLabel：未来日期只填时间按事务日期解释，今天仍显示今天', async () => {
      await addTask(env, { text: '周五只填时间', date: '2026-10-23', dueTime: '18:00' })
      await addTask(env, { text: '今天只填时间', dueTime: '18:00' })
      const data = await loadCalendar(env)
      const friday = calendarTaskByText(data, '周五只填时间')
      assert(friday !== null, '找不到周五事务')
      assertEqual(friday.dueDate, '', '前置条件：该事务不应有 dueDate')
      assertEqual(friday.dueLabel, '周五 18:00', `周五事务 dueLabel 错误：${friday.dueLabel}`)
      const today = calendarTaskByText(data, '今天只填时间')
      assert(today !== null, '找不到今天事务')
      assertEqual(today.dueLabel, '今天 18:00', `今天事务 dueLabel 错误：${today.dueLabel}`)
    })
    await test('页面请求 invokePanel("calendar","load") 返回 7 天数据', async () => {
      const result = await main.invokePanel(CALENDAR_PANEL_ID, 'load', {}, env.ctx)
      const data = expectCalendarOk(result, '页面 calendar load')
      assertEqual(data.days.length, 7, '页面 load 应返回 7 天')
      assertEqual(data.days.map((day) => day.weekday).join(','), '1,2,3,4,5,6,7', 'weekday 应依次为 1..7')
      assertEqual(data.days[0].date, '2026-10-19', '第一天应为本周一')
      assertEqual(data.days[6].date, '2026-10-25', '最后一天应为本周日')
      assertEqual(data.isCurrentWeek, true)
      assertEqual(data.canEdit, true)
      assertEqual(data.days[0].canEdit, true, '本周过去天应可编辑（删除）')
      assertEqual(data.days[0].canAddTask, false, '本周过去天不能新增')
    })
  })

  header('班级周历 · 推送与写保护')
  await withEnv({}, async (env) => {
    await test('周历写动作成功后推送 4 条；load 不推送', async () => {
      const before = pushCount(env)
      const added = await invokeCalendar(env, 'add-task', {
        date: TODAY,
        text: '周历推送校验',
        weekOffset: 0,
      })
      expectCalendarOk(added, 'calendar add-task 推送')
      assertEqual(pushCount(env) - before, 4, '周历写动作应推送 2 个面板 + 2 个小组件')
      const slice = assertPushAllSlice(env, before, '周历 add-task 推送')
      assertEqual(slice.filter((push) => push.panelId === PANEL_ID).length, 1, '应恰好推送 1 次 board')
      assertEqual(
        slice.filter((push) => push.panelId === CALENDAR_PANEL_ID).length,
        1,
        '应恰好推送 1 次 calendar',
      )
      assertEqual(slice.filter((push) => push.widgetId !== undefined).length, 2, '应推送 2 个小组件')

      const afterWrite = pushCount(env)
      const loaded = await invokeCalendar(env, 'load', { weekOffset: 0 })
      expectCalendarOk(loaded, 'calendar load 不推送')
      assertEqual(pushCount(env), afterWrite, 'load 不应产生推送')
    })
    await test('过去周只读：set-duty-week 与 add-task 被拒且不落盘、不推送', async () => {
      const before = pushCount(env)
      const duty = await invokeCalendar(env, 'set-duty-week', {
        groupName: '第1组',
        note: '过去周备注',
        weekOffset: -1,
      })
      expectCalendarError(duty, '过去周 set-duty-week')
      assert(duty.error.includes('过去周只读'), `过去周写保护提示不明确：${duty.error}`)
      assertEqual(pushCount(env), before, '被拒绝的过去周写不应推送')

      const added = await invokeCalendar(env, 'add-task', {
        date: TODAY,
        text: '过去周不应写入',
        weekOffset: -1,
      })
      expectCalendarError(added, '过去周 add-task')
      assert(added.error.includes('过去周只读'), `过去周 add-task 提示不明确：${added.error}`)
      assertEqual(pushCount(env), before, '过去周 add-task 不应推送')

      const past = await loadCalendar(env, { weekOffset: -1 })
      assert(!String(past.duty.note ?? '').includes('过去周备注'), '过去周值日备注不应落盘')
      assertEqual(calendarTaskByText(past, '过去周不应写入'), null, '过去周 add-task 不应写入历史周')
      const current = await loadCalendar(env, { weekOffset: 0 })
      assertEqual(calendarTaskByText(current, '过去周不应写入'), null, '过去周 add-task 不应写入本周')
    })
    await test('非法 weekOffset：load 返回 error，写动作被拒且不落盘', async () => {
      const loaded = await invokeCalendar(env, 'load', { weekOffset: 99 })
      expectCalendarError(loaded, '非法 weekOffset load')
      assert(loaded.error.includes('12'), `越界 weekOffset 提示不明确：${loaded.error}`)

      const before = pushCount(env)
      const added = await invokeCalendar(env, 'add-task', {
        weekOffset: 99,
        date: TODAY,
        text: '不应写入',
      })
      expectCalendarError(added, '非法 weekOffset add-task')
      assert(added.error.includes('12'), `越界 weekOffset 写提示不明确：${added.error}`)
      assertEqual(pushCount(env), before, '非法 weekOffset 写动作不应推送')
      const data = await loadCalendar(env)
      assertEqual(calendarTaskByText(data, '不应写入'), null, '非法 weekOffset 不应写入事务')
    })
  })

  header('班级周历 · 本周过去天可删除')
  await withSeededEnv(
    {
      'board.v1': {
        version: stateLib.BOARD_VERSION,
        anchorMonday: '2026-10-19',
        duty: { groups: stateLib.seedGroups(), order: ['g1', 'g2', 'g3', 'g4'] },
        weeks: {
          '2026-10-19': seedWeek(
            [seedTask('tPastDay', '2026-10-19', '周一的事务')],
            [seedSchedule('sPastDay', 1, '周一的安排')],
          ),
        },
      },
    },
    async (env) => {
      await test('本周过去天（周一）可删除事务', async () => {
        let data = await loadCalendar(env, { weekOffset: 0 })
        const monday = calendarDayOf(data, '2026-10-19')
        assertEqual(monday.isPast, true, '周一应为已过去')
        assertEqual(monday.canEdit, true, '本周过去天应可编辑/删除')
        assertEqual(monday.canAddTask, false, '本周过去天不能新增')
        assert(monday.tasks.some((task) => task.id === 'tPastDay'), '种子事务缺失')
        const before = pushCount(env)
        const deleted = await invokeCalendar(env, 'delete-task', { id: 'tPastDay', weekOffset: 0 })
        const deletedData = expectCalendarOk(deleted, 'calendar 删除本周过去天事务')
        assert(typeof deleted.message === 'string' && deleted.message !== '', 'delete-task 应返回 message')
        assertPushAllSlice(env, before, '删除本周过去天事务推送')
        assert(
          !calendarDayOf(deletedData, '2026-10-19').tasks.some((task) => task.id === 'tPastDay'),
          '删除后返回数据仍含该事务',
        )
        data = await loadCalendar(env, { weekOffset: 0 })
        assertEqual(calendarTaskById(data, 'tPastDay'), null, '删除后 load 仍能找到事务')
      })
      await test('本周过去天（周一）可删除安排', async () => {
        const before = pushCount(env)
        const deleted = await invokeCalendar(env, 'delete-schedule', { id: 'sPastDay', weekOffset: 0 })
        const deletedData = expectCalendarOk(deleted, 'calendar 删除本周过去天安排')
        assert(typeof deleted.message === 'string' && deleted.message !== '', 'delete-schedule 应返回 message')
        assertPushAllSlice(env, before, '删除本周过去天安排推送')
        assertEqual(calendarScheduleById(deletedData, 'sPastDay'), null, '删除后返回数据仍含该安排')
        const data = await loadCalendar(env, { weekOffset: 0 })
        assertEqual(calendarScheduleById(data, 'sPastDay'), null, '删除后 load 仍能找到安排')
      })
      await test('过去周（-1）删除事务仍被拒绝', async () => {
        const before = pushCount(env)
        const result = await invokeCalendar(env, 'delete-task', { id: 't-not-exist', weekOffset: -1 })
        expectCalendarError(result, '过去周 delete-task')
        assert(result.error.includes('过去周只读'), `过去周删除提示不明确：${result.error}`)
        assertEqual(pushCount(env), before, '过去周删除不应推送')
      })
    },
  )

  await withSeededEnv({ 'board.v1': capacityBoard() }, async (env) => {
    await test('move-task：目标周已满 80 条时拒绝跨周移动', async () => {
      const before = pushCount(env)
      const result = await invokeCalendar(env, 'move-task', {
        id: 'tmove',
        date: '2026-10-27',
        weekOffset: 0,
      })
      expectCalendarError(result, 'move-task 目标周容量已满')
      assert(result.error.includes('上限'), `容量已满提示不明确：${result.error}`)
      assertEqual(pushCount(env), before, '失败的移动不应推送')
      const source = await loadCalendar(env, { weekOffset: 0 })
      const kept = calendarTaskById(source, 'tmove')
      assert(kept !== null, '目标周已满时源周事务不应丢失')
      assertEqual(kept.date, TODAY, '目标周已满时源周事务日期不应被改写')
      const target = await loadCalendar(env, { weekOffset: 1 })
      const targetCount = target.days.reduce((sum, day) => sum + day.tasks.length, 0)
      assertEqual(targetCount, 80, '目标周事务数不应变化')
    })
    await test('move-task：超过 +12 周拒绝且不移动', async () => {
      const result = await invokeCalendar(env, 'move-task', {
        id: 'tmove',
        date: '2027-03-01',
        weekOffset: 0,
      })
      expectCalendarError(result, 'move-task 超出 12 周')
      assert(result.error.includes('12'), `超出范围提示不明确：${result.error}`)
      const source = await loadCalendar(env, { weekOffset: 0 })
      const kept = calendarTaskById(source, 'tmove')
      assert(kept !== null, '超范围移动不应丢失事务')
      assertEqual(kept.date, TODAY, '超范围移动不应改写事务日期')
    })
    await test('move-task：非法日期格式拒绝且不移动', async () => {
      const result = await invokeCalendar(env, 'move-task', {
        id: 'tmove',
        date: '2026/10/22',
        weekOffset: 0,
      })
      expectCalendarError(result, 'move-task 非法日期格式')
      assert(result.error.includes('格式'), `非法日期提示不明确：${result.error}`)
      const source = await loadCalendar(env, { weekOffset: 0 })
      const kept = calendarTaskById(source, 'tmove')
      assert(kept !== null, '非法日期移动不应丢失事务')
      assertEqual(kept.date, TODAY, '非法日期移动不应改写事务日期')
    })
  })

  // ═════════════════════════ 桌面小组件（页面 API）═════════════════════════

  header('桌面小组件 · load 与写动作')
  await withEnv({}, async (env) => {
    await test('week-overview load 返回完整 WidgetData 形状', async () => {
      const data = await loadWidget(env, 'week-overview')
      assertWidgetShape(data, 'week-overview', 'week-overview load')
      assertEqual(data.className, '高二(15)班')
      assertEqual(data.teacher, '王老师')
      assert(data.weekLabel.includes('第 1 周'), `weekLabel 异常：${data.weekLabel}`)
      assertEqual(data.weekRange, '10/19–10/25')
      assertEqual(data.weekNumber, 1)
      assertEqual(data.counts.total, 0)
      assertEqual(data.completion, 0)
      assertEqual(data.tasks.length, 0)
      assertEqual(data.schedule.length, 0)
      assertEqual(data.scheduleCount, 0)
      assertEqual(data.duty.groupName, '第1组')
      assertEqual(data.announcement, '')
      assertEqual(data.showCompleted, false)
    })
    await test('week-tasks load 今日事务 / 安排 / 计数与 TaskSummary 契约', async () => {
      await addTask(env, { text: '浮窗事务1', dueTime: '18:00' })
      await addTask(env, { text: '浮窗事务2', priority: 'high' })
      await invokeTool(env, 'add_schedule', { weekday: 5, time: '15:30', title: '浮窗大扫除', place: '教室' })
      await invokeTool(env, 'set_duty_week', { groupName: '第2组', note: '浮窗值日备注' })
      await invokeTool(env, 'set_announcement', { text: '浮窗班级通知' })

      const data = await loadWidget(env, 'week-tasks')
      assertWidgetShape(data, 'week-tasks', 'week-tasks load')
      assertEqual(data.todayWeekday, 3)
      assertEqual(data.tasks.length, 2, '今日事务数量异常')
      assertEqual(data.counts.total, 2)
      assertEqual(data.counts.pending, 2)
      assertEqual(data.counts.high, 1)
      assertEqual(data.scheduleCount, 1)
      assertEqual(data.schedule[0].title, '浮窗大扫除')
      assertEqual(data.duty.groupName, '第2组')
      assertEqual(data.duty.note, '浮窗值日备注')
      assertEqual(data.announcement, '浮窗班级通知')
      const task = widgetTaskByText(data, '浮窗事务1')
      assert(task !== null, '找不到浮窗事务1')
      assertEqual(task.dueLabel, '今天 18:00', `dueLabel 今天口径错误：${task.dueLabel}`)
      assertEqual(task.overdue, false)
      const high = widgetTaskByText(data, '浮窗事务2')
      assertEqual(high.priority, 'high')
    })
    await test('widget load 不推送', async () => {
      const before = pushCount(env)
      await loadWidget(env, 'week-overview')
      await loadWidget(env, 'week-tasks')
      assertNoPush(env, before, 'widget load')
    })
    await test('widget 不再提供 add-task（按刷新返回、不写入不推送）', async () => {
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'add-task', { text: '浮窗不应新增' })
      const data = expectWidgetOk(result, 'widget 已移除 add-task')
      assertEqual(result.message, undefined, '已移除的 add-task 不应返回 message')
      assertNoPush(env, before, 'widget 已移除 add-task')
      assertEqual(widgetTaskByText(data, '浮窗不应新增'), null, 'add-task 不应再写入事务')
      assertEqual(taskByText(env, '浮窗不应新增'), null, 'add-task 不应落盘')
    })
    await test('widget toggle-task 完成 / 恢复', async () => {
      let data = await loadWidget(env, 'week-tasks')
      const task = widgetTaskByText(data, '浮窗事务1')
      assert(task !== null, '找不到浮窗事务1')
      const before = pushCount(env)
      const done = await invokeWidget(env, 'week-tasks', 'toggle-task', { id: task.id })
      const doneData = expectWidgetOk(done, 'widget toggle-task 完成')
      assertEqual(done.message, '已完成')
      assertPushAllSlice(env, before, 'widget toggle-task 推送')
      assertEqual(widgetTaskById(doneData, task.id).done, true)
      const restored = await invokeWidget(env, 'week-tasks', 'toggle-task', { id: task.id })
      const restoredData = expectWidgetOk(restored, 'widget toggle-task 恢复')
      assertEqual(restored.message, '已恢复为待办')
      assertEqual(widgetTaskById(restoredData, task.id).done, false)
    })
    await test('widget delete-task 删除今日事务', async () => {
      const data = await loadWidget(env, 'week-tasks')
      const task = widgetTaskByText(data, '浮窗事务2')
      assert(task !== null, '找不到浮窗事务2')
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'delete-task', { id: task.id })
      const after = expectWidgetOk(result, 'widget delete-task')
      assertEqual(result.message, '已删除事务')
      assertPushAllSlice(env, before, 'widget delete-task 推送')
      assertEqual(widgetTaskById(after, task.id), null, '删除后返回数据仍含该事务')
      assertEqual(taskByText(env, '浮窗事务2'), null, '删除后存储仍有该事务')
    })
    await test('widget delete-task 未知 id 返回 error 且不推送', async () => {
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'delete-task', { id: 't-not-exist' })
      expectWidgetError(result, 'widget delete-task 未知 id')
      assert(result.error.includes('不存在'), `未知 id 提示不明确：${result.error}`)
      assertNoPush(env, before, 'widget delete-task 未知 id')
    })
    await test('两个 widgetId 都可用（week-overview 也可写）', async () => {
      const overview = await loadWidget(env, 'week-overview')
      assertWidgetShape(overview, 'week-overview', 'week-overview 二次 load')
      const task = widgetTaskByText(overview, '浮窗事务1')
      assert(task !== null, '找不到浮窗事务1')
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-overview', 'delete-task', { id: task.id })
      const data = expectWidgetOk(result, 'week-overview delete-task')
      assertEqual(result.message, '已删除事务')
      assertEqual(data.widgetId, 'week-overview')
      assertPushAllSlice(env, before, 'week-overview delete-task 推送')
      assertEqual(widgetTaskById(data, task.id), null)
    })
    await test('widget 未知方法按刷新返回数据、不推送', async () => {
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-overview', 'not-a-method', {})
      const data = expectWidgetOk(result, 'widget 未知方法')
      assertEqual(result.message, undefined, '未知方法不应返回 message')
      assertNoPush(env, before, 'widget 未知方法')
      assertEqual(data.widgetId, 'week-overview')
    })
  })
  await test('widget showCompleted 跟随配置', async () => {
    await withEnv({ config: { showCompleted: true } }, async (env) => {
      const overview = await loadWidget(env, 'week-overview')
      assertEqual(overview.showCompleted, true, 'showCompleted 未跟随配置（week-overview）')
      const tasks = await loadWidget(env, 'week-tasks')
      assertEqual(tasks.showCompleted, true, 'showCompleted 未跟随配置（week-tasks）')
    })
  })

  // ═════════════════════════ 命令与推送 ═════════════════════════

  header('命令与推送')
  await withEnv({}, async (env) => {
    await test('命令 /class 只打开 board 面板且只推送 1 条 board', async () => {
      const before = pushCount(env)
      const opened = await invokeCommand(env, 'class')
      assertEqual(opened.summary, '已打开班级事务台')
      assertEqual(env.opened.at(-1), PANEL_ID)
      const slice = env.pushes.slice(before)
      assertEqual(slice.length, 1, `/class 只应推送 1 条，实际 ${slice.length} 条`)
      assertEqual(slice[0].panelId, PANEL_ID, '/class 推送目标应为 board')
      assertEqual(slice[0].widgetId, undefined, '/class 不应推送小组件')
      assertEqual(slice[0].event, EVENT, `/class 推送事件名应为 ${EVENT}`)
    })
    await test('命令 /week-plan 返回提示词、未知命令报错', async () => {
      const prompted = await invokeCommand(env, 'week-plan', '只看今天')
      assert(typeof prompted.prompt === 'string' && prompted.prompt.includes('get_overview'), 'prompt 缺少工具名')
      assert(prompted.prompt.includes('今天'), 'prompt 未强调今天')
      assert(prompted.prompt.includes('只看今天'), 'prompt 丢失用户补充')
      let threw = false
      try {
        await invokeCommand(env, 'not-a-command')
      } catch {
        threw = true
      }
      assert(threw, '未知命令应报错')
    })
    await test('命令 /calendar 打开班级周历页面并返回摘要', async () => {
      const result = await invokeCommand(env, 'calendar', '')
      assertEqual(result.summary, '已打开班级周历')
      assertEqual(env.opened.at(-1), CALENDAR_PANEL_ID)
    })
    await test('工具写入 pushAll：4 条（board + calendar + 2 个小组件）', async () => {
      const before = pushCount(env)
      const added = await invokeTool(env, 'add_task', { text: 'pushAll 推送校验' })
      assertEqual(added.isError, undefined, `工具写入失败：${added.content}`)
      const slice = assertPushAllSlice(env, before, '工具写入 pushAll')
      assertEqual(slice.filter((push) => push.panelId === PANEL_ID).length, 1, '应恰好推送 1 次 board')
      assertEqual(
        slice.filter((push) => push.panelId === CALENDAR_PANEL_ID).length,
        1,
        '应恰好推送 1 次 calendar',
      )
      assertEqual(slice.filter((push) => push.widgetId !== undefined).length, 2, '应推送 2 个小组件')
    })
    await test('所有推送目标/事件名/payload 合法且单次 ≤5 条', async () => {
      await invokeTool(env, 'add_task', { text: '推送校验小组件事务' })
      const widgetData = await loadWidget(env, 'week-tasks')
      const widgetTask = widgetTaskByText(widgetData, '推送校验小组件事务')
      assert(widgetTask !== null, '推送校验小组件前置事务创建失败')
      for (const action of [
        () => invokeTool(env, 'add_task', { text: '推送校验事务' }),
        () => invokeWidget(env, 'week-tasks', 'toggle-task', { id: widgetTask.id }),
        () => invokeTool(env, 'set_announcement', { text: '推送校验通知' }),
        () => invokeBoard(env, 'add-schedule', { weekOffset: 0, weekday: 2, title: '推送校验安排' }),
      ]) {
        const before = pushCount(env)
        await action()
        assertPushInvariants(env, before, '推送校验')
      }
      for (const push of env.pushes) {
        const targets = ['panelId', 'widgetId'].filter((key) => push[key] !== undefined)
        assertEqual(targets.length, 1, `推送目标必须二选一：${JSON.stringify(push)}`)
        if (push.panelId !== undefined) {
          assert(PANEL_IDS.includes(push.panelId), `面板目标非法：${push.panelId}`)
        }
        if (push.widgetId !== undefined) assert(WIDGETS.includes(push.widgetId))
        assert(/^[a-z][a-z0-9_.-]{0,63}$/.test(push.event), `事件名非法：${push.event}`)
        assert(bytes(push.payload ?? null) <= 64 * 1024, 'payload 超过 64 KB')
      }
      assert(env.pushes.length > 0, '应该产生推送')
    })
  })

  // ═════════════════════════ 跨天刷新与配置 ═════════════════════════

  header('跨天刷新与配置')
  await withEnv({}, async (env) => {
    await test('同一天 tick 不推送，跨天 tick 推送 4 条', async () => {
      const beforeSame = pushCount(env)
      await main.__test.tick(env.ctx)
      assertEqual(pushCount(env), beforeSame, '同一天不应推送')
      main.__test.setNow(new Date(2026, 9, 22, 9, 0, 0, 0).getTime())
      const beforeNext = pushCount(env)
      await main.__test.tick(env.ctx)
      assertPushAllSlice(env, beforeNext, '跨天 tick')
    })
    await test('跨周后小组件显示新周且周次递增', async () => {
      main.__test.setNow(new Date(2026, 9, 26, 9, 0, 0, 0).getTime()) // 下周一
      const widget = await loadWidget(env, 'week-overview')
      assert(widget.weekLabel.includes('第 2 周'), `周次未递增：${widget.weekLabel}`)
      assertEqual(widget.todayWeekday, 1, '下周一 todayWeekday 应为 1')
    })
    await test('配置变化推送并更新班级名', async () => {
      const before = pushCount(env)
      env.ctx.config.className = '高二(16)班'
      main.onConfigChanged(env.ctx.config, env.ctx)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assertEqual(pushCount(env) - before, 4, '配置变化应推送 2 个面板 + 2 个小组件')
      assertPushAllSlice(env, before, '配置变化推送')
      main.__test.setNow(BASE_NOW.getTime())
      const widget = await loadWidget(env, 'week-overview')
      assertEqual(widget.className, '高二(16)班', '班级名未更新')
    })
  })

  // ═════════════════════════ 存储与容量 ═════════════════════════

  header('存储与容量')
  await test('40 周修剪只保留最近 40 周', async () => {
    const board = stateLib.createBoard()
    for (let index = 0; index < 45; index += 1) {
      const key = timeLib.dateKeyOf(timeLib.addDays(new Date(2026, 0, 5), index * 7))
      board.weeks[key] = stateLib.emptyWeek()
    }
    stateLib.pruneToFit(board)
    assertEqual(Object.keys(board.weeks).length, 40)
    const keys = Object.keys(board.weeks).sort()
    assertEqual(keys[0], timeLib.dateKeyOf(timeLib.addDays(new Date(2026, 0, 5), 5 * 7)))
  })
  await test('历史保留窗口为 7 天', async () => {
    const board = stateLib.createBoard()
    board.weeks['2026-10-19'] = stateLib.emptyWeek()
    board.weeks['2026-10-19'].tasks = [
      { id: 't1', text: '今天', done: false, date: TODAY, priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
      { id: 't2', text: '六天前', done: false, date: '2026-10-15', priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
      { id: 't3', text: '七天前', done: false, date: '2026-10-14', priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
    ]
    const result = stateLib.purgeTaskHistory(board, TODAY)
    assertEqual(result.removed, 1)
    assertEqual(board.weeks['2026-10-19'].tasks.map((task) => task.id).join(','), 't1,t2')
  })

  const summary = `\n${results.checks - results.failures.length}/${results.checks} 项检查通过。`
  if (results.failures.length > 0) {
    process.stdout.write(`\n失败 ${results.failures.length} 项：\n`)
    for (const failure of results.failures) {
      process.stdout.write(
        `- ${failure.label}\n  ${String(failure.error && failure.error.message ? failure.error.message : failure.error)}\n`,
      )
    }
    process.stdout.write(`${summary}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`${summary}\n`)
}

mainTest().catch((error) => {
  process.stderr.write(`测试异常：${String(error && error.stack ? error.stack : error)}\n`)
  process.exitCode = 1
})
