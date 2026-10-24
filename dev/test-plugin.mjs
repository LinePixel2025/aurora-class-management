#!/usr/bin/env node
'use strict'

/**
 * 离线全链路测试（零依赖）。
 *
 * - 用 mock ctx 精确复刻宿主的 `{ params, values }` 形状与 `refresh / event` 调用；
 * - 从本机 Aurora 0.5.2 的 app.asar 提取宿主原版 `validatePanelSchema`，校验每一份
 *   静态与动态 schema（找不到 Aurora 时降级为内置结构检查并打印警告）；
 * - 覆盖时间、存储、旧数据迁移、每日清空与 7 天历史、整周值日、工具、2 个浮窗、
 *   4 个面板视图、推送、跨天刷新、三类可选通知（每日简报 / 截止提醒 / 周一值日）
 *   与页面型「班级周历」的后端行为、页面静态约束和命令接线。
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
const PAGE_FILES = ['ui/calendar.html', 'ui/calendar.css', 'ui/calendar.js']
const BASE_NOW = new Date(2026, 9, 21, 10, 0, 0, 0) // 2026-10-21（周三）10:00，本地时区

const results = { checks: 0, failures: [] }
let hostValidator = null
let validatorMode = ''

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
  process.stdout.write(`  ✗ ${label}\n      ${String(error && error.stack ? error.stack.split('\n')[0] : error)}\n`)
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

// ───────────────────────── 宿主校验器 ─────────────────────────

function asarLookup(index, parts) {
  let node = index
  for (const part of parts) {
    if (!node.files || node.files[part] === undefined) return null
    node = node.files[part]
  }
  return node && node.files === undefined ? node : null
}

function readAsarEntry(asarPath, parts) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuffer, 0, headerSize, 16)
    const index = JSON.parse(headerBuffer.toString('utf8'))
    const entry = asarLookup(index, parts)
    if (entry === null) return null
    const size = Number(entry.size)
    const buffer = Buffer.alloc(size)
    // asar 的 JSON 头按 4 字节对齐后再放文件内容
    fs.readSync(fd, buffer, 0, size, 16 + Math.ceil(headerSize / 4) * 4 + Number(entry.offset))
    return buffer
  } finally {
    fs.closeSync(fd)
  }
}

function localFallbackValidator(raw) {
  const nodeTypes = new Set([
    'stack', 'row', 'grid', 'card', 'divider', 'heading', 'text', 'badge', 'progress', 'image',
    'list', 'table', 'keyValue', 'button', 'input', 'textarea', 'select', 'toggle', 'number', 'slider',
  ])
  const errors = []
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.nodes)) {
    return { ok: false, errors: ['schema 必须是 { version, nodes }'] }
  }
  if (bytes(raw) > 256 * 1024) errors.push('schema 超过 256 KB')
  let count = 0
  const walk = (node, depth) => {
    count += 1
    if (count > 500) return errors.push('节点超过 500')
    if (depth > 20) return errors.push('嵌套超过 20 层')
    if (node === null || typeof node !== 'object') return errors.push('节点不是对象')
    if (!nodeTypes.has(node.type)) errors.push(`未知节点类型 ${node.type}`)
    if (node.type === 'select' && !Array.isArray(node.options)) errors.push('select 缺少 options')
    if (node.action !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/.test(String(node.action.method))) {
      errors.push('action.method 非法')
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, depth + 1)
  }
  for (const node of raw.nodes) walk(node, 1)
  return { ok: errors.length === 0, errors }
}

async function loadHostValidator() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Aurora', 'resources', 'app.asar') : '',
  ].filter(Boolean)
  for (const asarPath of candidates) {
    if (!fs.existsSync(asarPath)) continue
    try {
      const buffer = readAsarEntry(asarPath, ['node_modules', '@aurora', 'shared', 'dist', 'plugin', 'ui.js'])
      if (buffer === null) continue
      const module = await import(`data:text/javascript;base64,${buffer.toString('base64')}`)
      if (typeof module.validatePanelSchema === 'function') {
        validatorMode = `Aurora 宿主校验器（${asarPath}）`
        return module.validatePanelSchema
      }
    } catch (error) {
      process.stdout.write(`  ! 提取宿主校验器失败：${String(error)}\n`)
    }
  }
  validatorMode = '内置降级校验（未找到 Aurora 安装）'
  return localFallbackValidator
}

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
 * 用宿主安装器同一份 zod schema 解析清单（比工具包的离线校验更严格）。
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

const KNOWN_ACTIONS = new Set([
  'view',
  'apply-nav',
  'add-task',
  'select-task',
  'update-task',
  'toggle-task',
  'delete-task',
  'save-duty-groups',
  'save-duty-week',
  'add-schedule',
  'update-schedule',
  'delete-schedule',
  'save-announcement',
  'clear-scope',
  'load-demo',
  'quick-add',
])

function walkActions(nodes, callback) {
  for (const node of nodes || []) {
    if (node.action !== undefined) callback(node.action.method)
    walkActions(node.children, callback)
  }
}

function findBind(schema, prefix) {
  let found = null
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (typeof node.bind === 'string' && node.bind.startsWith(prefix)) {
        found = node.bind
        return
      }
      walk(node.children)
      if (found !== null) return
    }
  }
  walk(schema.nodes)
  return found
}

function validateSchema(label, schema) {
  const result = hostValidator(schema)
  assert(result.ok === true, `${label} schema 非法：${result.errors.slice(0, 4).join('；')}`)
  walkActions(schema.nodes, (method) => {
    assert(KNOWN_ACTIONS.has(method), `${label} 出现未实现的动作方法：${method}`)
  })
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
  // 宿主 notify() 的返回值；默认成功，false 用于覆盖通知失败路径
  const notifyResult = settings.notifyResult !== false
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
    ...(settings.config || {}),
  }
  const ctx = {
    plugin: { id: PLUGIN_ID, version: '2.0.0', root: PLUGIN, dataDir: PLUGIN, isDev: true },
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
  return { ctx, store, pushes, logs, opened, toasts, notifications }
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
    if (push.widgetId !== undefined) assert(WIDGETS.includes(push.widgetId), `${label} 小组件目标非法：${push.widgetId}`)
    assert(/^[a-z][a-z0-9_.-]{0,63}$/.test(push.event), `${label} 事件名非法：${push.event}`)
    assert(bytes(push.payload ?? null) <= 64 * 1024, `${label} payload 超过 64 KB`)
  }
  assert(slice.length <= 5, `${label} 一次变更推送超过 5 条：${slice.length}`)
}

/** pushAll 固定推 4 条：2 个面板（board + calendar）+ 2 个小组件，低于宿主 5 条上限。 */
function assertPushAllSlice(env, since, label) {
  assertPushInvariants(env, since, label)
  const slice = env.pushes.slice(since)
  assertEqual(slice.length, 4, `${label} 应推送 4 条（2 面板 + 2 浮窗），实际 ${slice.length}`)
  const panelIds = slice.filter((push) => push.panelId !== undefined).map((push) => push.panelId).sort()
  const widgetIds = slice.filter((push) => push.widgetId !== undefined).map((push) => push.widgetId).sort()
  assertEqual(panelIds.join(','), PANEL_IDS.slice().sort().join(','), `${label} 面板推送应覆盖 board 与 calendar`)
  assertEqual(widgetIds.join(','), WIDGETS.slice().sort().join(','), `${label} 浮窗推送应覆盖 2 个小组件`)
  for (const push of slice) assertEqual(push.event, EVENT, `${label} 推送事件名应为 ${EVENT}`)
  return slice
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

function invokeTool(env, name, input) {
  return main.invokeTool(name, input, env.ctx)
}

function invokePanel(env, method, params, values) {
  return main.invokePanel(PANEL_ID, method, { params, values: values || {} }, env.ctx)
}

function invokeCommand(env, name, args) {
  return main.invokeCommand(name, args || '', env.ctx)
}

function invokeWidget(env, widgetId, method, params, values) {
  return main.invokeWidget(widgetId, method, { params, values: values || {} }, env.ctx)
}

async function refreshWidget(env, widgetId) {
  return invokeWidget(env, widgetId, 'refresh', undefined)
}

async function refreshPanel(env) {
  return invokePanel(env, 'refresh')
}

// ───────────────────────── 页面型面板 helper（班级周历） ─────────────────────────

/** 页面型面板的 params 是直接对象，不要再套 `{ params, values }`。 */
function invokeCalendar(env, method, params) {
  return main.invokePanel(CALENDAR_PANEL_ID, method, params !== null && typeof params === 'object' ? params : {}, env.ctx)
}

/** 读取页面静态文件；缺失或为空时给出可读失败信息。 */
function readPageFile(relativePath) {
  const file = path.join(PLUGIN, relativePath)
  assert(fs.existsSync(file), `缺少页面文件：${relativePath}`)
  const text = fs.readFileSync(file, 'utf8')
  assert(text.trim() !== '', `页面文件为空：${relativePath}`)
  return text
}

/** 成功返回 `{ data, message? }`；把契约检查集中在这里，失败时给出可读原因。 */
function expectCalendarOk(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assertEqual(result.error, undefined, `${label} 失败：${result.error}`)
  assert(result.data !== null && typeof result.data === 'object', `${label} 缺少最新数据 data`)
  return result.data
}

/** 失败返回 `{ data, error }`：既要有 error，也要带最新数据供页面回填。 */
function expectCalendarError(result, label) {
  assert(result !== null && typeof result === 'object', `${label} 未返回对象`)
  assert(typeof result.error === 'string' && result.error !== '', `${label} 应返回 error，实际：${JSON.stringify(result)}`)
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

// ───────────────────────── 测试主体 ─────────────────────────

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

function allTasksOf(env) {
  const board = env.store.get('board.v1')
  if (board === undefined) return []
  return Object.values(board.weeks).flatMap((week) => week.tasks)
}

function taskByText(env, text) {
  return allTasksOf(env).find((task) => task.text === text) || null
}

/** 固定时钟 + 未激活的 context：避免 activate 立即补发通知污染“只发一次”断言。 */
function atTime(date, config) {
  main.__test.setNow(date.getTime())
  return createContext({ config })
}

/** 调一次通知检查；实现缺失时给出明确失败信息，而不是每个用例都只报 TypeError。 */
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

async function mainTest() {
  hostValidator = await loadHostValidator()
  process.stdout.write(`校验器：${validatorMode}\n`)

  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'))

  header('清单与静态文件')
  await test('清单基础字段', async () => {
    assertEqual(manifest.id, PLUGIN_ID)
    assertEqual(manifest.version, '2.0.0')
    assertEqual(manifest.apiVersion, 1)
    assertEqual(manifest.minAuroraVersion, '0.5.2')
    assertEqual(manifest.main, 'main.js')
    assertEqual(manifest.activation, 'startup')
    assert(manifest.description.length <= 300, 'description 超过 300')
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
  await test('工具数量与命名/参数/只读标记', async () => {
    assertEqual(manifest.contributes.tools.length, 12)
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
    assert(!names.has('set_duty_day'), '按天值日工具应已删除')
    const readonly = manifest.contributes.tools.filter((tool) => tool.readonly === true).map((tool) => tool.name)
    assertEqual(readonly.sort().join(','), ['get_overview', 'list_tasks'].sort().join(','))
  })
  await test('小组件：2 个桌面声明式、桌面层 + 亚克力、尺寸合法', async () => {
    assertEqual(manifest.contributes.widgets.length, 2)
    for (const widget of manifest.contributes.widgets) {
      assertEqual(widget.slot, 'desktop')
      assertEqual(widget.windowLevel, 'desktop', `${widget.id} 默认窗口层级应为 desktop`)
      assertEqual(widget.windowMaterial, 'acrylic', `${widget.id} 默认窗口材质应为 acrylic`)
      assert(widget.schema !== undefined && widget.entry === undefined, '小组件必须且只能声明 schema')
      assert(widget.defaultSize.width >= 120 && widget.defaultSize.width <= 1200, '宽度越界')
      assert(widget.defaultSize.height >= 80 && widget.defaultSize.height <= 900, '高度越界')
    }
    assertEqual(
      manifest.contributes.widgets.map((widget) => widget.id).sort().join(','),
      WIDGETS.slice().sort().join(','),
    )
  })
  await test('面板 2 个（board/calendar）/ 命令 3 个 / Skill / 配置', async () => {
    assertEqual(manifest.contributes.panels.length, 2)
    const board = manifest.contributes.panels.find((panel) => panel.id === PANEL_ID)
    assert(board !== undefined, '缺少 board 声明式面板')
    assertEqual(board.schema, 'ui/panel.json', 'board 面板应声明 schema ui/panel.json')
    const calendar = manifest.contributes.panels.find((panel) => panel.id === CALENDAR_PANEL_ID)
    assert(calendar !== undefined, '缺少 calendar 页面型面板')
    assertEqual(calendar.entry, 'ui/calendar.html', 'calendar 面板 entry 应为 ui/calendar.html')
    assertEqual(
      manifest.contributes.panels.map((panel) => panel.id).sort().join(','),
      PANEL_IDS.slice().sort().join(','),
    )
    assertEqual(
      manifest.contributes.commands.map((command) => command.name).sort().join(','),
      ['class', 'week-plan', 'calendar'].sort().join(','),
    )
    const calendarCommand = manifest.contributes.commands.find((command) => command.name === CALENDAR_PANEL_ID)
    assert(calendarCommand !== undefined, '缺少 calendar 命令')
    assertEqual(calendarCommand.mode, 'action', 'calendar 命令应为 action')
    assertEqual(manifest.contributes.skills[0], 'skills/class-board')
    assert(fs.existsSync(path.join(PLUGIN, 'skills', 'class-board', 'SKILL.md')), '缺少 SKILL.md')
    const configKeys = manifest.config.fields.map((field) => field.key)
    assertEqual(configKeys.length, 9)
    for (const key of ['notifyDaily', 'notifyTime', 'notifyDue', 'notifyDueLead', 'notifyDuty']) {
      assert(configKeys.includes(key), `配置字段缺少 ${key}`)
    }
  })
  await test('静态 schema 通过宿主校验', async () => {
    for (const file of ['ui/panel.json', 'ui/widget-overview.json', 'ui/widget-tasks.json']) {
      validateSchema(file, JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8')))
    }
  })
  await test('宿主原版 zod 清单解析通过', async () => {
    const parse = await loadHostManifestParser()
    if (parse === null) {
      process.stdout.write('  ! 未找到 Aurora，跳过宿主 zod 清单解析\n')
      return
    }
    const result = parse(manifest)
    assert(result.ok === true, `宿主清单解析失败：${result.errors.join('；')}`)
    assertEqual(result.manifest.id, PLUGIN_ID)
  })
  await test('schema 校验使用宿主原版（而非降级校验）', async () => {
    const asarPath = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Aurora', 'resources', 'app.asar')
      : ''
    if (asarPath === '' || !fs.existsSync(asarPath)) {
      process.stdout.write('  ! 未找到 Aurora，当前为降级校验\n')
      return
    }
    assert(validatorMode.includes('Aurora'), `校验器未使用宿主原版：${validatorMode}`)
  })

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
      validateSchema('board 初始', (await refreshPanel(env)).schema)
    })
  })

  await test('损坏数据可自愈且不抛错', async () => {
    await withEnv({}, async (env) => {
      await env.ctx.storage.set('board.v1', { version: 1, duty: { groups: '坏的' }, weeks: { '不是日期': 1 } })
      const panel = await refreshPanel(env)
      validateSchema('修复后的面板', panel.schema)
      await invokeTool(env, 'add_task', { text: '修复后写入' })
      const board = await env.ctx.storage.get('board.v1')
      assertEqual(board.version, 2)
      assertEqual(board.duty.groups.length, 4)
      assertEqual(Object.keys(board.weeks).includes('不是日期'), false)
    })
  })

  await test('旧版数据迁移：无 date 事务落到今天、按天值日被丢弃', async () => {
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
          tasks: [{ id: 'told', text: '旧任务', done: false, priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '' }],
          schedule: [],
          announcement: '旧通知',
        },
      },
    }
    await withSeededEnv({ 'board.v1': oldBoard, 'ui.v1': { view: 'notice', weekOffset: 4 } }, async (env) => {
      const board = await env.ctx.storage.get('board.v1')
      assertEqual(board.version, 2)
      const week = board.weeks['2026-10-19']
      assertEqual(week.tasks[0].date, '2026-10-21')
      assertEqual(week.duty.groupId, 'g2')
      assertEqual(week.duty.note, '旧备注')
      assertEqual(week.duty.days, undefined)
      const ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.view, 'notice')
      const panel = await refreshPanel(env)
      const viewNode = panel.schema.nodes.find((node) => node.bind === 'viewChoice')
      assertEqual(viewNode.value, 'board', '旧 notice 视图未回落到今日')
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

  header('桌面浮窗')
  await withEnv({}, async (env) => {
    await test('2 个浮窗初始 schema 通过校验，空状态可行动', async () => {
      for (const widgetId of WIDGETS) {
        const result = await refreshWidget(env, widgetId)
        validateSchema(`浮窗 ${widgetId}`, result.schema)
        assertEqual(result.schema.version, 1)
      }
      const overview = JSON.stringify((await refreshWidget(env, 'week-overview')).schema)
      assert(overview.includes('待设置'), '值日空状态缺失')
      const tasks = JSON.stringify((await refreshWidget(env, 'week-tasks')).schema)
      assert(tasks.includes('快速加一条今日事务'), '缺少快速添加输入框')
      assert(tasks.includes('本周安排'), '缺少本周安排区块')
    })
    await test('班级速览合并值日与通知', async () => {
      await invokeTool(env, 'set_duty_groups', {
        groups: [{ name: '第1组', members: ['张三', '李四'] }],
        order: ['第1组'],
      })
      await invokeTool(env, 'set_announcement', { text: '周五大扫除' })
      await invokeTool(env, 'add_schedule', { weekday: 5, time: '15:30', title: '大扫除', place: '教室' })
      const schema = (await refreshWidget(env, 'week-overview')).schema
      const text = JSON.stringify(schema)
      assert(text.includes('高二(15)班'), '速览缺少班级名')
      assert(text.includes('第1组') && text.includes('张三'), '速览缺少本周值日组/成员')
      assert(text.includes('周五大扫除'), '速览缺少通知')
      validateSchema('班级速览', schema)
    })
    await test('浮窗快速添加（values）→ 4 条推送且其他浮窗同步', async () => {
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'quick-add', undefined, { quickTask: '收英语作业' })
      validateSchema('快速添加后的浮窗', result.schema)
      assertPushInvariants(env, before, 'quick-add')
      assertEqual(pushCount(env) - before, 4, '快速添加应推送 2 个面板 + 2 个浮窗')
      const overview = await invokeTool(env, 'list_tasks', { status: 'pending' })
      assert(overview.content.includes('收英语作业'), '快速添加未落盘')
      const overviewWidget = await refreshWidget(env, 'week-overview')
      validateSchema('快速添加后的速览浮窗', overviewWidget.schema)
    })
    await test('浮窗快速添加带修订号：添加后输入框换绑', async () => {
      const beforeSchema = (await refreshWidget(env, 'week-tasks')).schema
      const bind = findBind(beforeSchema, 'quickTask_')
      assert(bind !== null, '缺少带修订号的快速添加输入框')
      const result = await invokeWidget(env, 'week-tasks', 'quick-add', undefined, {
        [bind]: '修订号快速添加',
      })
      validateSchema('修订号快速添加后的浮窗', result.schema)
      const nextBind = findBind((await refreshWidget(env, 'week-tasks')).schema, 'quickTask_')
      assert(nextBind !== bind, '快速添加后输入框没有换绑，旧文字会残留')
      const overview = await invokeTool(env, 'list_tasks', { status: 'pending' })
      assert(overview.content.includes('修订号快速添加'), '修订号快速添加未落盘')
    })
    await test('浮窗完成事务（params.id）可撤销', async () => {
      const listed = await invokeTool(env, 'list_tasks', { status: 'pending' })
      const match = /id=([A-Za-z0-9_-]+)/.exec(listed.content)
      assert(match !== null, '没有可完成的事务 id')
      const id = match[1]
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'toggle-task', { id })
      validateSchema('完成后的浮窗', result.schema)
      assertPushInvariants(env, before, 'toggle-task')
      const done = await invokeTool(env, 'list_tasks', { status: 'done' })
      assert(done.content.includes(id), '事务未标记完成')
      await invokeWidget(env, 'week-tasks', 'toggle-task', { id })
      const pending = await invokeTool(env, 'list_tasks', { status: 'pending' })
      assert(pending.content.includes(id), '事务未恢复')
    })
    await test('浮窗不含“打开班级事务台”或 open-panel 动作', async () => {
      for (const widgetId of WIDGETS) {
        const schema = (await refreshWidget(env, widgetId)).schema
        const text = JSON.stringify(schema)
        assert(!text.includes('打开班级事务台'), `${widgetId} 仍有冗余按钮`)
        walkActions(schema.nodes, (method) => assert(method !== 'open-panel', `${widgetId} 仍有 open-panel`))
      }
    })
    await test('浮窗 event 方法可重渲染', async () => {
      const result = await invokeWidget(env, 'week-overview', 'event', { event: 'board.changed', payload: {} })
      validateSchema('event 重渲染', result.schema)
    })
  })

  header('Agent 工具 · 今日事务')
  await withEnv({}, async (env) => {
    await test('add_task 默认今天 / get_overview / list_tasks', async () => {
      const before = pushCount(env)
      const added = await invokeTool(env, 'add_task', {
        text: '收数学作业',
        dueDate: '2026-10-21',
        dueTime: '08:00',
        priority: 'high',
        category: '作业',
        assignee: '课代表',
      })
      assertEqual(added.isError, undefined)
      assert(added.content.includes('已添加事务'), '返回文案异常')
      assert(added.content.includes('2026-10-21'), '返回未带日期')
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
      assertEqual(task.date, '2026-10-21')
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
      await invokeTool(env, 'add_task', { text: '交作业 今天', date: '2026-10-21' })
      await invokeTool(env, 'add_task', { text: '交作业 今天', date: '2026-10-22' })
      const result = await invokeTool(env, 'complete_task', { text: '交作业 今天', date: '2026-10-21' })
      assertEqual(result.isError, undefined)
    })
    await test('输入校验：空文本 / 非法日期 / 非法优先级 / 未知 id', async () => {
      const empty = await invokeTool(env, 'add_task', { text: '   ' })
      assertEqual(empty.isError, true)
      const badDate = await invokeTool(env, 'add_task', { text: '测试', dueDate: '2026-13-01' })
      assertEqual(badDate.isError, true)
      const badTaskDate = await invokeTool(env, 'add_task', { text: '测试', date: '2026-02-31' })
      assertEqual(badTaskDate.isError, true)
      const badPriority = await invokeTool(env, 'add_task', { text: '测试', priority: 'urgent' })
      assert(badPriority.content.length > 0)
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

  header('每日清空与 7 天历史')
  await withEnv({}, async (env) => {
    await test('跨天后今日清空，昨天可查回', async () => {
      await invokeTool(env, 'add_task', { text: '昨天做的事', date: '2026-10-21' })
      await invokeTool(env, 'add_task', { text: '今天做的事', date: '2026-10-22' })
      main.__test.setNow(new Date(2026, 9, 22, 9, 0, 0, 0).getTime())
      await main.__test.tick(env.ctx)
      const today = await invokeTool(env, 'get_overview', {})
      assert(today.content.includes('今天做的事'), '新一天事务缺失')
      assert(!today.content.includes('昨天做的事'), '昨天事务不应出现在今天')
      const history = await invokeTool(env, 'list_tasks', { date: '2026-10-21', status: 'all' })
      assert(history.content.includes('昨天做的事'), '历史事务查不到')
    })
    await test('超过 7 天后旧事务自动清理且拒绝查询', async () => {
      main.__test.setNow(new Date(2026, 9, 29, 9, 0, 0, 0).getTime())
      await main.__test.tick(env.ctx)
      const board = await env.ctx.storage.get('board.v1')
      const dates = Object.values(board.weeks).flatMap((week) => week.tasks.map((task) => task.date))
      assert(!dates.includes('2026-10-21'), '7 天前的历史事务未清理')
      const result = await invokeTool(env, 'list_tasks', { date: '2026-10-21' })
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
    await test('set_announcement 保存 / 清空并同步班级速览', async () => {
      const saved = await invokeTool(env, 'set_announcement', { text: '周五下午大扫除' })
      assertEqual(saved.isError, undefined)
      const overviewWidget = await refreshWidget(env, 'week-overview')
      assert(JSON.stringify(overviewWidget.schema).includes('周五下午大扫除'), '速览未显示通知')
      const cleared = await invokeTool(env, 'set_announcement', { text: '' })
      assertEqual(cleared.isError, undefined)
      const after = await refreshWidget(env, 'week-overview')
      assert(!JSON.stringify(after.schema).includes('周五下午大扫除'), '清空通知失败')
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
        plan: { tasks: [{ text: '日期越界', date: '2026-10-21' }] },
      })
      assertEqual(result.isError, true)
      assert(result.content.includes('目标周'), '日期越界提示不明确')
    })
  })

  header('通知与定时提醒')
  await test('三类通知默认全关：不发送、不写 notify.v1', async () => {
    // 周一 08:00：每日简报、值日提醒、08:00 截止提醒三者同时“满足时间条件”，最能验证开关
    const env = atTime(new Date(2026, 9, 19, 8, 0, 0, 0), {})
    await addTask(env, { text: '周一 08:00 截止的作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '默认全关时不应产生任何通知')
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
  await test('截止提醒：未到提醒点不发，到时只发一次', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 49, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    await addTask(env, { text: '交英语作业', dueTime: '08:00' }) // 提前 10 分钟 = 07:50
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '未到 08:00 - 10 分钟不应提醒')

    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '已到提醒点应发一条截止提醒')
    assertEqual(env.notifications[0].title, '事务即将截止')
    const task = taskByText(env, '交英语作业')
    assert(task !== null, '找不到预置事务')
    const saved = env.store.get('notify.v1')
    assert(
      saved !== undefined && saved.due !== null && typeof saved.due === 'object',
      '未记录截止提醒去重状态',
    )
    assert(
      Object.prototype.hasOwnProperty.call(saved.due, task.id),
      '未记录该事务今天已提醒',
    )
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '重复调用不应重复发送截止提醒')
  })
  await test('notifyDueLead 为 0 时按 0 分钟提醒（不回落成 10）', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 0 })
    await addTask(env, { text: '交化学作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '提前量为 0 时 07:55 不应提醒')
    main.__test.setNow(new Date(2026, 9, 21, 8, 0, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '提前量为 0 时 08:00 应提醒')
  })
  await test('多条同时到点的截止任务合并为一条摘要', async () => {
    const env = atTime(new Date(2026, 9, 21, 7, 55, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    for (const text of ['交数学作业', '交英语作业', '交物理作业']) {
      await addTask(env, { text, dueTime: '08:00' })
    }
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '多条任务应合并成一条摘要，而不是逐条发送')
    assertEqual(env.notifications[0].title, '事务即将截止')
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
    assertEqual(env.notifications.length, 0, '明天截止的任务不应今天提醒')
  })
  await test('过了截止时间不再提醒', async () => {
    const env = atTime(new Date(2026, 9, 21, 8, 5, 0, 0), { notifyDue: true, notifyDueLead: 10 })
    await addTask(env, { text: '已经过期的作业', dueTime: '08:00' })
    await checkNotifications(env)
    assertEqual(env.notifications.length, 0, '08:05 不应再提醒 08:00 截止的任务')
  })
  await test('昨天登记、今天截止的任务仍会提醒', async () => {
    main.__test.setNow(new Date(2026, 9, 20, 9, 0, 0, 0).getTime())
    const env = createContext({ config: { notifyDue: true, notifyDueLead: 10 } })
    await addTask(env, { text: '昨天登记今天交', dueDate: '2026-10-21', dueTime: '08:00' })
    const task = taskByText(env, '昨天登记今天交')
    assert(task !== null, '找不到预置事务')
    assertEqual(task.date, '2026-10-20')
    main.__test.setNow(new Date(2026, 9, 21, 7, 55, 0, 0).getTime())
    await checkNotifications(env)
    assertEqual(env.notifications.length, 1, '昨天登记、今天截止的任务应被提醒')
  })
  await test('ctx.notify 返回 false：不抛错并记录 warn', async () => {
    main.__test.setNow(new Date(2026, 9, 21, 7, 31, 0, 0).getTime())
    const env = createContext({ config: { notifyDaily: true }, notifyResult: false })
    await checkNotifications(env) // 抛错会让本测试直接失败
    assertEqual(env.notifications.length, 1, '通知失败路径也应尝试发送一次')
    assert(
      env.logs.some((entry) => entry.level === 'warn'),
      '通知发送失败应记录 warn 日志',
    )
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

  header('管理台面板')
  await withEnv({}, async (env) => {
    await test('四个视图均通过宿主校验', async () => {
      for (const view of ['board', 'duty', 'schedule', 'settings']) {
        await invokePanel(env, 'view', { view })
        const result = await refreshPanel(env)
        validateSchema(`面板 ${view}`, result.schema)
        assertEqual((await env.ctx.storage.get('ui.v1')).view, view)
      }
    })
    await test('周导航：值日/安排可切周，今日/设置回到本周', async () => {
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'duty', weekChoice: '1' })
      let ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.view, 'duty')
      assertEqual(ui.weekOffset, 1)
      let panel = await refreshPanel(env)
      assert(JSON.stringify(panel.schema).includes('下周'), '未显示下周')
      await invokePanel(env, 'apply-nav')
      ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.weekOffset, 1, '未改周时点应用应保留当前周')
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'board' })
      ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.view, 'board')
      assertEqual(ui.weekOffset, 0)
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'schedule', weekChoice: '-1' })
      ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.weekOffset, -1)
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'settings' })
      ui = await env.ctx.storage.get('ui.v1')
      assertEqual(ui.weekOffset, 0)
    })
    await test('今日页添加 / 卡片内编辑 / 完成 / 删除事务', async () => {
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'board' })
      const before = pushCount(env)
      let panel = await refreshPanel(env)
      const addTextBind = findBind(panel.schema, 'taskText_')
      assert(addTextBind !== null, '缺少添加事务输入框')
      const addRev = addTextBind.slice('taskText_'.length)
      const added = await invokePanel(env, 'add-task', undefined, {
        [addTextBind]: '面板添加的事务',
        [`taskDue_${addRev}`]: '18:00',
        [`taskPriority_${addRev}`]: 'high',
        [`taskCategory_${addRev}`]: '作业',
      })
      assertEqual(added.toast, '已添加事务')
      assertPushInvariants(env, before, '面板 add-task')
      validateSchema('面板添加事务后', added.schema)
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('面板添加的事务'), '面板添加未落盘')
      const task = taskByText(env, '面板添加的事务')
      assert(task !== null, '找不到面板添加的事务')
      assertEqual(task.dueDate, '2026-10-21')
      assertEqual(task.dueTime, '18:00')

      await invokePanel(env, 'select-task', { id: task.id })
      panel = await refreshPanel(env)
      const textBind = findBind(panel.schema, `taskText_${task.id}_`)
      const dueBind = findBind(panel.schema, `taskDue_${task.id}_`)
      const priorityBind = findBind(panel.schema, `taskPriority_${task.id}_`)
      assert(textBind !== null && dueBind !== null && priorityBind !== null, '点击事务后缺少预填编辑字段')
      const updated = await invokePanel(env, 'update-task', { id: task.id }, {
        [textBind]: '卡片内改过的事务',
        [dueBind]: '2026-10-22 20:00',
        [priorityBind]: 'low',
      })
      assertEqual(updated.toast, '事务已更新')
      const afterUpdate = await invokeTool(env, 'get_overview', {})
      assert(afterUpdate.content.includes('卡片内改过的事务｜截止 2026-10-22 20:00'), '卡片内编辑未生效')
      assert(afterUpdate.content.includes('低优先级'), '优先级未更新')

      panel = await refreshPanel(env)
      const dueBind2 = findBind(panel.schema, `taskDue_${task.id}_`)
      const cleared = await invokePanel(env, 'update-task', { id: task.id }, { [dueBind2]: '' })
      assertEqual(cleared.toast, '事务已更新')
      const afterClear = await invokeTool(env, 'get_overview', {})
      assert(!afterClear.content.includes('截止 2026-10-22 20:00'), '清空截止未生效')

      const toggled = await invokePanel(env, 'toggle-task', { id: task.id })
      assertEqual(toggled.toast, '已完成')
      const restored = await invokePanel(env, 'toggle-task', { id: task.id })
      assertEqual(restored.toast, '已恢复为待办')
      const deleted = await invokePanel(env, 'delete-task', { id: task.id })
      assertEqual(deleted.toast, '已删除事务')
    })
    await test('今日页通知：不碰输入框不会清空，留空保存会清空', async () => {
      await invokeTool(env, 'set_announcement', { text: '原通知' })
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'board' })
      let panel = await refreshPanel(env)
      const bind = findBind(panel.schema, 'announcementText_')
      assert(bind !== null, '缺少通知输入框')
      const kept = await invokePanel(env, 'save-announcement')
      assertEqual(kept.toast, '通知已保存')
      let overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('原通知'), '未编辑通知时不应清空')
      panel = await refreshPanel(env)
      const bind2 = findBind(panel.schema, 'announcementText_')
      const cleared = await invokePanel(env, 'save-announcement', undefined, { [bind2]: '' })
      assertEqual(cleared.toast, '通知已保存')
      overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('班级通知：（无）'), '通知未被清空')
      panel = await refreshPanel(env)
      const bind3 = findBind(panel.schema, 'announcementText_')
      await invokePanel(env, 'save-announcement', undefined, { [bind3]: '新通知' })
      overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('新通知'), '通知未保存')
    })
    await test('安排页卡片内编辑 / 删除', async () => {
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'schedule', weekChoice: '0' })
      const addRev = (await env.ctx.storage.get('ui.v1')).formRev
      const added = await invokePanel(env, 'add-schedule', undefined, {
        [`scheduleDay_${addRev}`]: '2',
        [`scheduleTitle_${addRev}`]: '待修改安排',
        [`scheduleTime_${addRev}`]: '10:00',
      })
      assertEqual(added.toast, '已添加安排')
      const entry = Object.values((await env.ctx.storage.get('board.v1')).weeks)
        .flatMap((week) => week.schedule)
        .find((item) => item.title === '待修改安排')
      assert(entry !== undefined, '找不到新安排')
      const panel = await refreshPanel(env)
      const titleBind = findBind(panel.schema, `scheduleTitle_${entry.id}_`)
      const placeBind = findBind(panel.schema, `schedulePlace_${entry.id}_`)
      const dayBind = findBind(panel.schema, `scheduleDay_${entry.id}_`)
      assert(titleBind !== null && placeBind !== null && dayBind !== null, '安排卡片缺少预填字段')
      const updated = await invokePanel(env, 'update-schedule', { id: entry.id }, {
        [titleBind]: '修改后的安排',
        [placeBind]: '报告厅',
        [dayBind]: '4',
      })
      assertEqual(updated.toast, '安排已更新')
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('周四 10:00 修改后的安排 @ 报告厅'), '安排未更新')
      const removed = await invokePanel(env, 'delete-schedule', { id: entry.id })
      assertEqual(removed.toast, '已删除安排')
    })
    await test('值日页：分组 / 本周换组 / 轮换预览，无按天覆盖', async () => {
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'duty', weekChoice: '0' })
      let panel = await refreshPanel(env)
      const groupsBind = findBind(panel.schema, 'dutyGroupsText_')
      const orderBind = findBind(panel.schema, 'dutyOrderText_')
      assert(groupsBind !== null && orderBind !== null, '值日页缺少分组编辑')
      const groupsRev = groupsBind.slice('dutyGroupsText_'.length)
      const saved = await invokePanel(env, 'save-duty-groups', undefined, {
        [groupsBind]: '第1组: 张三, 李四\n第2组: 王五',
        [`dutyOrderText_${groupsRev}`]: '第1组，第2组',
      })
      assertEqual(saved.toast, '值日分组已保存')
      assert(!JSON.stringify(saved.schema).includes('按天覆盖'), '值日页仍有按天覆盖')
      panel = await refreshPanel(env)
      const pickBind = findBind(panel.schema, 'dutyGroupPick_')
      const noteBind = findBind(panel.schema, 'dutyNoteText_')
      const groups = (await env.ctx.storage.get('board.v1')).duty.groups
      const target = groups.find((group) => group.name === '第2组')
      const dutyRev = pickBind.slice('dutyGroupPick_'.length)
      const assigned = await invokePanel(env, 'save-duty-week', undefined, {
        [pickBind]: target.id,
        [`dutyNoteText_${dutyRev}`]: '本周由第2组值日',
      })
      assertEqual(assigned.toast, '本周轮换已保存')
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('（本周指定）'), '指定组未生效')
      assert(overview.content.includes('本周由第2组值日'), '值日备注未生效')
      assert(JSON.stringify((await refreshPanel(env)).schema).includes('轮换预览'), '缺少轮换预览')
    })
    await test('设置页：清理今日事务 / 示例周', async () => {
      await withEnv({}, async (env2) => {
        await invokeTool(env2, 'add_task', { text: '待清理事务' })
        await invokeTool(env2, 'add_task', { text: '明天的保留事务', date: '2026-10-22' })
        await invokePanel(env2, 'apply-nav', undefined, { viewChoice: 'settings' })
        const cleared = await invokePanel(env2, 'clear-scope', undefined, { clearScope: 'tasks' })
        assertEqual(cleared.toast, '已清理所选数据')
        const overview = await invokeTool(env2, 'get_overview', {})
        assert(!overview.content.includes('待清理事务'), '今日事务清理未生效')
        const tomorrow = await invokeTool(env2, 'get_overview', { date: '2026-10-22' })
        assert(tomorrow.content.includes('明天的保留事务'), '未来事务不应被清理')

        await invokePanel(env2, 'apply-nav', undefined, { viewChoice: 'settings' })
        await withEnv({}, async (env3) => {
          const demo = await invokePanel(env3, 'load-demo')
          assertEqual(demo.toast, '示例数据已写入')
          validateSchema('示例周面板', demo.schema)
          const demoOverview = await invokeTool(env3, 'get_overview', {})
          assert(demoOverview.content.includes('收数学作业'), '示例事务缺失')
          assert(demoOverview.content.includes('升旗仪式'), '示例安排缺失')
          const again = await invokePanel(env3, 'load-demo')
          assert(again.toast.includes('没有保存'), '重复写入示例应失败')
          await invokePanel(env3, 'apply-nav', undefined, { viewChoice: 'schedule', weekChoice: '1' })
          const wrongWeek = await invokePanel(env3, 'load-demo')
          assert(wrongWeek.toast.includes('本周'), '非本周写示例应失败')
        })
      })
    })
    await test('表单修订号：动作后旧输入不会覆盖新数据', async () => {
      await invokePanel(env, 'apply-nav', undefined, { viewChoice: 'board' })
      const panel = await refreshPanel(env)
      const addBind = findBind(panel.schema, 'taskText_')
      const revision = addBind.slice('taskText_'.length)
      await invokePanel(env, 'add-task', undefined, {
        [addBind]: '动态绑定事务',
        [`taskPriority_${revision}`]: 'low',
        [`taskCategory_${revision}`]: '活动',
      })
      const overview = await invokeTool(env, 'get_overview', {})
      assert(overview.content.includes('动态绑定事务｜活动｜低优先级'), '修订号绑定的输入没有生效')
      const nextAddBind = findBind((await refreshPanel(env)).schema, 'taskText_')
      assert(nextAddBind !== addBind, '动作后表单修订号未递增')
    })
    await test('面板未知动作不抛错', async () => {
      const result = await invokePanel(env, 'not-a-real-action')
      validateSchema('未知动作后 schema', result.schema)
    })
  })

  header('班级周历后端')
  await withEnv({}, async (env) => {
    await test('load 固定返回 7 天：周一到周日、今日与可编辑标记', async () => {
      const data = await loadCalendar(env)
      assertEqual(data.days.length, 7, 'days 必须固定 7 项')
      assertEqual(data.days[0].date, '2026-10-19', '第一天应为本周一')
      assertEqual(data.days[6].date, '2026-10-25', '最后一天应为本周日')
      assertEqual(data.days.map((day) => day.weekday).join(','), '1,2,3,4,5,6,7', 'weekday 应依次为 1..7')
      assertEqual(data.days[0].label, '10/19 周一', 'day.label 应为日期标签')
      assertEqual(data.days[2].isToday, true, '周三应为今天')
      assertEqual(data.days.filter((day) => day.isToday).length, 1, '有且只有一天是今天')
      assertEqual(data.todayKey, '2026-10-21')
      assertEqual(data.weekOffset, 0)
      assertEqual(data.isCurrentWeek, true)
      assertEqual(data.canEdit, true)
      assert(typeof data.weekLabel === 'string' && data.weekLabel.includes('10/19'), `weekLabel 异常：${data.weekLabel}`)
      assert(Number.isInteger(data.weekNumber) && data.weekNumber >= 1, `weekNumber 异常：${data.weekNumber}`)
      assert(Array.isArray(data.groups) && data.groups.length >= 1, 'groups 应为非空数组')
      assert(data.groups.every((group) => typeof group.name === 'string' && group.name !== ''), 'groups 项缺少 name')
      assert(Array.isArray(data.duty.members), 'duty.members 应为数组')
      assert(typeof data.duty.groupName === 'string' && data.duty.groupName !== '', 'duty.groupName 缺失')
      assert(
        data.days.every((day) => Array.isArray(day.tasks) && Array.isArray(day.schedule)),
        '每天的 tasks / schedule 应为数组',
      )
      assertEqual(data.days[0].canEdit, false, '本周已过去的天不应可编辑')
      assertEqual(data.days[2].canEdit, true, '今天应可编辑')
      assertEqual(data.days[6].canEdit, true, '未来天应可编辑')
    })

    await test('load 今日：事务摘要 / 安排 / 值日 / 通知 / 统计', async () => {
      await invokeTool(env, 'add_task', {
        text: '周历今日作业',
        date: '2026-10-21',
        dueDate: '2026-10-21',
        dueTime: '18:00',
        priority: 'high',
        category: '作业',
        assignee: '课代表',
      })
      await invokeTool(env, 'add_schedule', { weekday: 3, time: '16:00', title: '周历班会', place: '教室' })
      await invokeTool(env, 'set_duty_week', { groupName: '第2组', note: '周历值日备注' })
      await invokeTool(env, 'set_announcement', { text: '周历班级通知' })

      const data = await loadCalendar(env)
      const today = calendarDayOf(data, '2026-10-21')
      assertEqual(today.weekday, 3, '周三的 weekday 应为 3')
      const task = today.tasks.find((item) => item.text === '周历今日作业')
      assert(task !== undefined, '今日事务未出现在今天')
      for (const key of ['id', 'text', 'done', 'date', 'priority', 'category', 'assignee', 'dueLabel', 'overdue']) {
        assert(Object.prototype.hasOwnProperty.call(task, key), `taskSummary 缺少字段 ${key}`)
      }
      assertEqual(task.date, '2026-10-21')
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

    await test('过去周只读：顶层与每天的 canEdit 均为 false', async () => {
      const data = await loadCalendar(env, { weekOffset: -1 })
      assertEqual(data.weekOffset, -1)
      assertEqual(data.isCurrentWeek, false)
      assertEqual(data.canEdit, false, '过去周顶层 canEdit 应为 false')
      assertEqual(data.days.length, 7)
      assertEqual(data.days[0].date, '2026-10-12')
      assertEqual(data.days[6].date, '2026-10-18')
      assert(data.days.every((day) => day.canEdit === false), '过去周每天 canEdit 都应为 false')
      assert(data.days.every((day) => day.isToday === false), '过去周不应包含今天')
      assertEqual(data.todayKey, '2026-10-21')
    })

    await test('事务动作：add / update / toggle / delete 均落盘', async () => {
      const added = await invokeCalendar(env, 'add-task', {
        text: '周历新增事务',
        date: '2026-10-21',
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
      assertEqual(created.date, '2026-10-21')
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
      assertEqual(persisted.date, '2026-10-21')
      assert(calendarDayOf(data, '2026-10-21').tasks.some((task) => task.id === id), '今日事务不在今天')
      assert(
        calendarDayOf(data, '2026-10-22').tasks.some((task) => task.text === '周历明日事务'),
        '明日事务不在明天',
      )

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
      assert(updatedTask.dueLabel.includes('09:30'), `dueLabel 未反映新的截止时间：${updatedTask.dueLabel}`)

      const toggled = await invokeCalendar(env, 'toggle-task', { id, weekOffset: 0 })
      const toggledData = expectCalendarOk(toggled, 'calendar toggle-task')
      assert(typeof toggled.message === 'string' && toggled.message !== '', 'toggle-task 应返回 message')
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

    await test('move-task：同周移动、跨周移动、过去日期回滚', async () => {
      const added = await invokeCalendar(env, 'add-task', {
        text: '周历移动事务',
        date: '2026-10-21',
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
        !calendarDayOf(sameWeekData, '2026-10-21').tasks.some((task) => task.id === id),
        '同周移动后原天仍保留事务',
      )
      assert(
        calendarDayOf(sameWeekData, '2026-10-22').tasks.some((task) => task.id === id),
        '同周移动后目标天缺少事务',
      )

      const crossWeek = await invokeCalendar(env, 'move-task', { id, date: '2026-10-27', weekOffset: 0 })
      expectCalendarOk(crossWeek, 'calendar 跨周 move-task')
      const currentWeek = await loadCalendar(env, { weekOffset: 0 })
      assertEqual(calendarTaskById(currentWeek, id), null, '跨周移动后原周仍能找到事务')
      const nextWeek = await loadCalendar(env, { weekOffset: 1 })
      assertEqual(nextWeek.weekOffset, 1)
      assertEqual(nextWeek.isCurrentWeek, false)
      const nextTask = calendarTaskById(nextWeek, id)
      assert(nextTask !== null, '跨周移动后下周找不到事务')
      assertEqual(nextTask.date, '2026-10-27')
      assertEqual(nextWeek.canEdit, true, '下周应可编辑')
      assert(
        calendarDayOf(nextWeek, '2026-10-27').tasks.some((task) => task.id === id),
        '下周目标天缺少事务',
      )

      const bad = await invokeCalendar(env, 'move-task', { id, date: '2026-10-20', weekOffset: 0 })
      expectCalendarError(bad, 'calendar 过去日期 move-task')
      assert(bad.error.includes('过去'), `过去日期错误提示不明确：${bad.error}`)
      const nextAfter = await loadCalendar(env, { weekOffset: 1 })
      const kept = calendarTaskById(nextAfter, id)
      assert(kept !== null, '非法移动导致事务丢失')
      assertEqual(kept.date, '2026-10-27', '非法移动后事务位置被改写（半写）')
    })

    await test('安排动作：add / update / delete 均出现在对应天', async () => {
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

    await test('set-duty-week / save-announcement 落盘并出现在 load', async () => {
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

    await test('非法输入：未知事务 id / 未知 method 不写数据且不抛错', async () => {
      await invokeCalendar(env, 'add-task', {
        text: '周历保留事务',
        date: '2026-10-21',
        weekOffset: 0,
      })
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
  })

  header('页面型周历')
  await test('页面三文件存在且非空', async () => {
    for (const file of PAGE_FILES) readPageFile(file)
  })
  await test('calendar.html 无内联脚本 / 外链 / 内联事件', async () => {
    const html = readPageFile('ui/calendar.html')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    assert(scripts.length >= 1, 'calendar.html 缺少带 src 的 <script>')
    for (const match of scripts) {
      assert(/\bsrc\s*=/i.test(match[1]), 'calendar.html 存在缺少 src 的内联 <script>')
      assertEqual(match[2].trim(), '', 'calendar.html 的 <script> 不能包含内联代码')
    }
    const openings = html.match(/<script\b/gi) || []
    assertEqual(openings.length, scripts.length, 'calendar.html 存在未闭合的 <script>')
    assert(!/https?:\/\//i.test(html), 'calendar.html 不应包含 http:// 或 https:// 外链')
    assert(!/<[^>]*\son[a-z]+\s*=/i.test(html), 'calendar.html 不应包含 on* 内联事件属性')
  })
  await test('calendar.js 通过 auroraPlugin.request/onEvent 通信且不含 fetch/eval', async () => {
    const js = readPageFile('ui/calendar.js')
    assert(js.includes('auroraPlugin.request'), 'calendar.js 缺少 auroraPlugin.request')
    assert(js.includes('auroraPlugin.onEvent'), 'calendar.js 缺少 auroraPlugin.onEvent')
    assert(!/\bfetch\s*\(/.test(js), 'calendar.js 不应调用 fetch(')
    assert(!/\beval\s*\(/.test(js), 'calendar.js 不应调用 eval(')
  })
  await withEnv({}, async (env) => {
    await test('页面请求 invokePanel("calendar", "load") 返回 7 天数据', async () => {
      const result = await main.invokePanel(CALENDAR_PANEL_ID, 'load', {}, env.ctx)
      const data = expectCalendarOk(result, '页面 calendar load')
      assertEqual(data.days.length, 7, '页面 load 应返回 7 天')
      assertEqual(data.days.map((day) => day.weekday).join(','), '1,2,3,4,5,6,7', 'weekday 应依次为 1..7')
      assertEqual(data.days[0].date, '2026-10-19', '第一天应为本周一')
      assertEqual(data.days[6].date, '2026-10-25', '最后一天应为本周日')
      assertEqual(data.isCurrentWeek, true)
      assertEqual(data.canEdit, true)
    })
  })

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
    await test('工具写入 pushAll：4 条（board + calendar + 2 个浮窗）', async () => {
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
      for (const action of [
        () => invokeTool(env, 'add_task', { text: '推送校验事务' }),
        () => invokeWidget(env, 'week-tasks', 'quick-add', undefined, { quickTask: '推送校验快速添加' }),
        () => invokeTool(env, 'set_announcement', { text: '推送校验通知' }),
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
    await test('跨周后浮窗显示新周且周次递增', async () => {
      main.__test.setNow(new Date(2026, 9, 26, 9, 0, 0, 0).getTime()) // 下周一
      const widget = await refreshWidget(env, 'week-overview')
      validateSchema('跨周浮窗', widget.schema)
      assert(JSON.stringify(widget.schema).includes('第 2 周'), '周次未递增')
    })
    await test('配置变化推送并更新班级名', async () => {
      const before = pushCount(env)
      env.ctx.config.className = '高二(16)班'
      main.onConfigChanged(env.ctx.config, env.ctx)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert(pushCount(env) - before >= 3, '配置变化未推送')
      main.__test.setNow(BASE_NOW.getTime())
      const widget = await refreshWidget(env, 'week-overview')
      assert(JSON.stringify(widget.schema).includes('高二(16)班'), '班级名未更新')
    })
  })

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
      { id: 't1', text: '今天', done: false, date: '2026-10-21', priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
      { id: 't2', text: '六天前', done: false, date: '2026-10-15', priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
      { id: 't3', text: '七天前', done: false, date: '2026-10-14', priority: 'normal', category: '事务', dueDate: '', dueTime: '', assignee: '', createdAt: '' },
    ]
    const result = stateLib.purgeTaskHistory(board, '2026-10-21')
    assertEqual(result.removed, 1)
    assertEqual(board.weeks['2026-10-19'].tasks.map((task) => task.id).join(','), 't1,t2')
  })

  const summary = `\n${results.checks - results.failures.length}/${results.checks} 项检查通过。`
  if (results.failures.length > 0) {
    process.stdout.write(`\n失败 ${results.failures.length} 项：\n`)
    for (const failure of results.failures) {
      process.stdout.write(`- ${failure.label}\n  ${String(failure.error && failure.error.message ? failure.error.message : failure.error)}\n`)
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
