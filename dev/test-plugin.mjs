#!/usr/bin/env node
'use strict'

/**
 * 离线全链路测试（零依赖）。
 *
 * - 用 mock ctx 精确复刻宿主的 `{ params, values }` 形状与 `refresh / event` 调用；
 * - 从本机 Aurora 0.5.1 的 app.asar 提取宿主原版 `validatePanelSchema`，校验每一份
 *   静态与动态 schema（找不到 Aurora 时降级为内置结构检查并打印警告）；
 * - 覆盖时间、存储、旧数据迁移、每日清空与 7 天历史、整周值日、工具、2 个浮窗、
 *   4 个面板视图、推送与跨天刷新。
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
const WIDGETS = ['week-overview', 'week-tasks']
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
  const config = {
    className: '高二(15)班',
    teacher: '王老师',
    termStartDate: '',
    showCompleted: false,
    ...(settings.config || {}),
  }
  const ctx = {
    plugin: { id: PLUGIN_ID, version: '1.1.0', root: PLUGIN, dataDir: PLUGIN, isDev: true },
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
    notify: async () => false,
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
  return { ctx, store, pushes, logs, opened, toasts }
}

function pushCount(env) {
  return env.pushes.length
}

function assertPushInvariants(env, since, label) {
  const slice = env.pushes.slice(since)
  for (const push of slice) {
    const targetKeys = ['panelId', 'widgetId'].filter((key) => push[key] !== undefined)
    assertEqual(targetKeys.length, 1, `${label} 推送必须 panelId / widgetId 二选一`)
    if (push.panelId !== undefined) assertEqual(push.panelId, PANEL_ID, `${label} 面板目标非法`)
    if (push.widgetId !== undefined) assert(WIDGETS.includes(push.widgetId), `${label} 小组件目标非法：${push.widgetId}`)
    assert(/^[a-z][a-z0-9_.-]{0,63}$/.test(push.event), `${label} 事件名非法：${push.event}`)
    assert(bytes(push.payload ?? null) <= 64 * 1024, `${label} payload 超过 64 KB`)
  }
  assert(slice.length <= 3, `${label} 一次变更推送超过 5 条：${slice.length}`)
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

async function mainTest() {
  hostValidator = await loadHostValidator()
  process.stdout.write(`校验器：${validatorMode}\n`)

  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'))

  header('清单与静态文件')
  await test('清单基础字段', async () => {
    assertEqual(manifest.id, PLUGIN_ID)
    assertEqual(manifest.version, '1.1.0')
    assertEqual(manifest.apiVersion, 1)
    assertEqual(manifest.minAuroraVersion, '0.5.1')
    assertEqual(manifest.main, 'main.js')
    assertEqual(manifest.activation, 'startup')
    assert(manifest.description.length <= 300, 'description 超过 300')
  })
  await test('权限最小集（无多余权限）', async () => {
    const expected = ['tools', 'skills', 'commands', 'storage', 'config', 'logging', 'ui.panels', 'ui.widgets']
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
  await test('小组件：2 个桌面声明式、尺寸合法', async () => {
    assertEqual(manifest.contributes.widgets.length, 2)
    for (const widget of manifest.contributes.widgets) {
      assertEqual(widget.slot, 'desktop')
      assert(widget.schema !== undefined && widget.entry === undefined, '小组件必须且只能声明 schema')
      assert(widget.defaultSize.width >= 120 && widget.defaultSize.width <= 1200, '宽度越界')
      assert(widget.defaultSize.height >= 80 && widget.defaultSize.height <= 900, '高度越界')
    }
    assertEqual(
      manifest.contributes.widgets.map((widget) => widget.id).sort().join(','),
      WIDGETS.slice().sort().join(','),
    )
  })
  await test('面板 / 命令 / Skill / 配置', async () => {
    assertEqual(manifest.contributes.panels.length, 1)
    assertEqual(manifest.contributes.panels[0].id, PANEL_ID)
    assertEqual(manifest.contributes.panels[0].schema !== undefined, true)
    assertEqual(manifest.contributes.commands.map((command) => command.name).sort().join(','), ['class', 'week-plan'].sort().join(','))
    assertEqual(manifest.contributes.skills[0], 'skills/class-board')
    assert(fs.existsSync(path.join(PLUGIN, 'skills', 'class-board', 'SKILL.md')), '缺少 SKILL.md')
    assertEqual(manifest.config.fields.length, 4)
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
    await test('浮窗快速添加（values）→ 3 条推送且其他浮窗同步', async () => {
      const before = pushCount(env)
      const result = await invokeWidget(env, 'week-tasks', 'quick-add', undefined, { quickTask: '收英语作业' })
      validateSchema('快速添加后的浮窗', result.schema)
      assertPushInvariants(env, before, 'quick-add')
      assertEqual(pushCount(env) - before, 3, '快速添加应推送面板 + 2 个浮窗')
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

  header('命令与推送')
  await withEnv({}, async (env) => {
    await test('命令 /class 打开面板、/week-plan 返回提示词', async () => {
      const opened = await invokeCommand(env, 'class')
      assertEqual(opened.summary, '已打开班级事务台')
      assertEqual(env.opened.at(-1), PANEL_ID)
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
    await test('所有推送目标/事件名/payload 合法且单次 ≤3 条', async () => {
      await invokeTool(env, 'add_task', { text: '推送校验事务' })
      await invokeWidget(env, 'week-tasks', 'quick-add', undefined, { quickTask: '推送校验快速添加' })
      await invokeTool(env, 'set_announcement', { text: '推送校验通知' })
      for (const push of env.pushes) {
        const targets = ['panelId', 'widgetId'].filter((key) => push[key] !== undefined)
        assertEqual(targets.length, 1, `推送目标必须二选一：${JSON.stringify(push)}`)
        if (push.panelId !== undefined) assertEqual(push.panelId, PANEL_ID)
        if (push.widgetId !== undefined) assert(WIDGETS.includes(push.widgetId))
        assert(/^[a-z][a-z0-9_.-]{0,63}$/.test(push.event), `事件名非法：${push.event}`)
        assert(bytes(push.payload ?? null) <= 64 * 1024, 'payload 超过 64 KB')
      }
      assert(env.pushes.length > 0, '应该产生推送')
    })
  })

  header('跨天刷新与配置')
  await withEnv({}, async (env) => {
    await test('同一天 tick 不推送，跨天 tick 推送 3 条', async () => {
      const beforeSame = pushCount(env)
      await main.__test.tick(env.ctx)
      assertEqual(pushCount(env), beforeSame, '同一天不应推送')
      main.__test.setNow(new Date(2026, 9, 22, 9, 0, 0, 0).getTime())
      const beforeNext = pushCount(env)
      await main.__test.tick(env.ctx)
      assertEqual(pushCount(env) - beforeNext, 3, '跨天应推送 3 条')
      assertPushInvariants(env, beforeNext, '跨天刷新')
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
