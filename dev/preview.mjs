#!/usr/bin/env node
/**
 * 视觉预览：用本机 Aurora 的宿主 CSS + 一个只读渲染器，把 2 个浮窗与 4 个面板视图
 * 渲染成静态页面，并（可选）调用 Chrome headless 截图。
 *
 * 产物在 dev/.cache/ 下，不随插件发布。
 *
 * 运行：node dev/preview.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const PLUGIN_DIR = path.join(ROOT, 'class-management')
const CACHE = path.join(__dirname, '.cache')

const main = require(path.join(PLUGIN_DIR, 'main.js'))
const time = require(path.join(PLUGIN_DIR, 'lib', 'time.js'))
const BASE_NOW = new Date(2026, 9, 21, 10, 0, 0, 0)

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'))

// ───────────────────────── asar / CSS ─────────────────────────

function asarFiles() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Aurora', 'resources', 'app.asar') : '',
  ].filter(Boolean)
  for (const file of candidates) if (fs.existsSync(file)) return file
  return null
}

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuffer, 0, headerSize, 16)
    return { headerSize, index: JSON.parse(headerBuffer.toString('utf8')) }
  } finally {
    fs.closeSync(fd)
  }
}

function readAsarEntry(asarPath, parts) {
  const { headerSize, index } = readAsarHeader(asarPath)
  let node = index
  for (const part of parts) {
    if (!node.files || node.files[part] === undefined) return null
    node = node.files[part]
  }
  if (node.files !== undefined) return null
  const size = Number(node.size)
  const buffer = Buffer.alloc(size)
  const fd = fs.openSync(asarPath, 'r')
  try {
    fs.readSync(fd, buffer, 0, size, 16 + Math.ceil(headerSize / 4) * 4 + Number(node.offset))
  } finally {
    fs.closeSync(fd)
  }
  return buffer
}

function walkAsarFiles(node, prefix, out) {
  if (!node || node.files === undefined) return
  for (const [name, child] of Object.entries(node.files)) {
    const parts = [...prefix, name]
    if (child.files !== undefined) walkAsarFiles(child, parts, out)
    else out.push(parts.join('/'))
  }
}

/** 列出 asar 内指定目录下的全部文件路径（用 `/` 分隔）。仅用于按文件名模式发现构建哈希。 */
function listAsarFiles(asarPath, parts = ['out', 'renderer', 'assets']) {
  const { index } = readAsarHeader(asarPath)
  let node = index
  for (const part of parts) {
    if (!node.files || node.files[part] === undefined) return []
    node = node.files[part]
  }
  const files = []
  walkAsarFiles(node, parts, files)
  return files
}

/** 在 asar 资源里按正则找到唯一目标；找不到时抛错并列出已见资源，绝不静默回退到旧哈希。 */
function findAsset(asarPath, pattern, label) {
  const files = listAsarFiles(asarPath)
  const found = files.find((file) => pattern.test(file))
  if (found === undefined) {
    throw new Error(
      `app.asar 中缺少预览所需的样式文件（${label}）：没有匹配 ${String(pattern)} 的资源。已见资源：\n${files.join('\n')}`,
    )
  }
  return found.split('/')
}

function findBlock(source, openIndex) {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return { start: openIndex + 1, end: index }
    }
  }
  return null
}

function extractLightRoot(themeCss) {
  const mediaIndex = themeCss.indexOf('@media (prefers-color-scheme: light)')
  if (mediaIndex < 0) return { mediaIndex: -1, bodyStart: -1, bodyEnd: -1, declarations: '' }
  const open = themeCss.indexOf('{', mediaIndex)
  const block = findBlock(themeCss, open)
  if (block === null) return { mediaIndex: -1, bodyStart: -1, bodyEnd: -1, declarations: '' }
  const body = themeCss.slice(block.start, block.end)
  const rootIndex = body.indexOf(':root')
  const rootOpen = rootIndex >= 0 ? body.indexOf('{', rootIndex) : -1
  const rootBlock = rootOpen >= 0 ? findBlock(body, rootOpen) : null
  return {
    mediaIndex,
    bodyStart: block.start,
    bodyEnd: block.end,
    declarations: rootBlock === null ? '' : body.slice(rootBlock.start, rootBlock.end),
  }
}

function themeVariants(themeCss) {
  const light = extractLightRoot(themeCss)
  let darkCss = themeCss
  if (light.bodyStart >= 0) {
    darkCss = `${themeCss.slice(0, light.mediaIndex)}${themeCss.slice(light.bodyEnd + 1)}`
  }
  const lightCss = `${themeCss}\n:root {${light.declarations}}`
  return { darkCss, lightCss }
}

// ───────────────────────── 数据 ─────────────────────────

function createEnv() {
  const store = new Map()
  const ctx = {
    plugin: { id: manifest.id, version: manifest.version, root: PLUGIN_DIR, dataDir: PLUGIN_DIR, isDev: true },
    config: { className: '高二(15)班', teacher: '王老师', termStartDate: '', showCompleted: false },
    storage: {
      async get(key) {
        return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined
      },
      async set(key, value) {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key) {
        store.delete(key)
      },
      async list() {
        return [...store.keys()]
      },
    },
    net: { async fetch() { throw new Error('preview: no net') } },
    notify: async () => false,
    log() {},
    emitEvent: async () => {},
    ui: {
      async openPanel() {},
      async toast() {},
      async panelEvent() {},
    },
    signal: new AbortController().signal,
  }
  return { ctx, store }
}

async function invokeTool(env, name, input) {
  return main.invokeTool(name, input, env.ctx)
}

async function invokePanel(env, method, params, values) {
  return main.invokePanel('board', method, { params, values: values || {} }, env.ctx)
}

async function invokeWidget(env, widgetId, method, params, values) {
  return main.invokeWidget(widgetId, method, { params, values: values || {} }, env.ctx)
}

async function buildWidgets(env) {
  const widgets = {}
  for (const widget of manifest.contributes.widgets) {
    const result = await invokeWidget(env, widget.id, 'refresh', undefined)
    widgets[widget.id] = result.schema
  }
  return widgets
}

async function buildPanels(env) {
  const panels = {}
  for (const view of ['board', 'duty', 'schedule', 'settings']) {
    await invokePanel(env, 'view', { view })
    panels[view] = (await invokePanel(env, 'refresh')).schema
  }
  return panels
}

async function buildDemo() {
  main.__test.setNow(BASE_NOW.getTime())
  const env = createEnv()
  await main.activate(env.ctx)
  await invokeTool(env, 'set_duty_groups', {
    groups: [
      { name: '第1组', members: ['张三', '李四', '王五'] },
      { name: '第2组', members: ['赵六', '钱七', '孙八'] },
      { name: '第3组', members: ['周九', '吴十', '郑一'] },
      { name: '第4组', members: ['王二', '冯三', '陈四'] },
    ],
    order: ['第1组', '第2组', '第3组', '第4组'],
  })
  await invokeTool(env, 'apply_week_plan', {
    plan: {
      replaceTasks: true,
      replaceSchedule: true,
      tasks: [
        { text: '收数学作业', date: '2026-10-21', dueDate: '2026-10-21', dueTime: '08:00', priority: 'high', category: '作业', assignee: '数学课代表' },
        { text: '物理实验报告', date: '2026-10-21', dueDate: '2026-10-22', dueTime: '20:00', priority: 'normal', category: '作业' },
        { text: '班会主题征集', date: '2026-10-21', dueDate: '2026-10-21', priority: 'low', category: '活动', assignee: '班长' },
        { text: '校运会报名表', date: '2026-10-21', dueDate: '2026-10-23', dueTime: '17:00', priority: 'normal', category: '通知', assignee: '体育委员' },
        { text: '英语单词默写', date: '2026-10-21', dueDate: '2026-10-22', dueTime: '07:40', priority: 'normal', category: '作业' },
      ],
      schedule: [
        { weekday: 1, time: '08:00', title: '升旗仪式', place: '操场' },
        { weekday: 3, time: '16:00', title: '班会', place: '教室' },
        { weekday: 5, time: '15:30', title: '大扫除', place: '教室', note: '带清洁工具' },
      ],
      duty: {
        note: '本周五放学后大扫除',
      },
      announcement: '本周五下午大扫除，请各组带好清洁工具；周五放学前交校运会报名表。',
    },
  })
  const pending = await invokeTool(env, 'list_tasks', { status: 'pending' })
  const idMatch = /id=([A-Za-z0-9_-]+)/.exec(pending.content)
  if (idMatch !== null) await invokeTool(env, 'complete_task', { id: idMatch[1] })
  const widgets = await buildWidgets(env)
  const panels = await buildPanels(env)
  const pendingAfter = await invokeTool(env, 'list_tasks', { status: 'pending' })
  const editMatch = /id=([A-Za-z0-9_-]+)/.exec(pendingAfter.content)
  if (editMatch !== null) {
    await invokePanel(env, 'select-task', { id: editMatch[1] })
    await invokePanel(env, 'view', { view: 'board' })
    panels.boardEdit = (await invokePanel(env, 'refresh')).schema
  }
  await main.deactivate()
  return { widgets, panels }
}

async function buildEmpty() {
  main.__test.setNow(BASE_NOW.getTime())
  const env = createEnv()
  await main.activate(env.ctx)
  const widgets = await buildWidgets(env)
  const panels = await buildPanels(env)
  await main.deactivate()
  return { widgets, panels }
}

// ───────────────────────── HTML ─────────────────────────

const RENDERER = fs.readFileSync(path.join(__dirname, 'preview-renderer.js'), 'utf8')

function unscope(css) {
  return css.replace(/\[data-v-[a-z0-9]+\]/g, '')
}

const PREVIEW_CSS = `
html, body { margin: 0; padding: 0; }
body {
  padding: 20px;
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-ui, "HarmonyOS Sans SC", "HarmonyOS Sans", "Microsoft YaHei UI", "Segoe UI", sans-serif);
}
.preview-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 16px; }
.preview-head h1 { margin: 0; font-size: 17px; font-weight: 600; }
.preview-head span { color: var(--text-muted); font-size: 12px; }
.preview-grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
.tiny { font-size: var(--text-xs, 11px); }
.panel-host {
  width: 420px; height: 830px;
  border: 1px solid var(--border-strong); border-radius: 12px; overflow: hidden;
  background: var(--bg-base);
}
.panel-host .page-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; box-sizing: border-box; }
.panel-host .plugin-page { height: 100%; }
`

function page(title, css, body, script) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
<script>${RENDERER}</script>
<script>${script}</script>
</body>
</html>`
}

function widgetCard(widget, index) {
  const size = widget.defaultSize
  return `<section class="widget-card" style="width:${size.width}px;height:${size.height}px">
  <header class="widget-head">
    <span class="widget-title">${widget.title}</span>
    <button class="widget-hide" type="button">×</button>
  </header>
  <div class="widget-body" id="widget-${index}"></div>
</section>`
}

function widgetsHtml(data, label, css) {
  const cards = manifest.contributes.widgets
    .map((widget, index) => widgetCard(widget, index))
    .join('\n')
  const script = `
const widgets = ${JSON.stringify(data.widgets)};
${manifest.contributes.widgets
  .map(
    (widget, index) =>
      `window.PreviewRender.render(document.getElementById('widget-${index}'), widgets[${JSON.stringify(widget.id)}]);`,
  )
  .join('\n')}
`
  return page(
    `浮窗预览 · ${label}`,
    css,
    `<div class="preview-head"><h1>桌面浮窗 · ${label}</h1><span>宿主同款小节件窗口尺寸 ${manifest.contributes.widgets
      .map((widget) => `${widget.defaultSize.width}×${widget.defaultSize.height}`)
      .join(' / ')}</span></div>
<div class="preview-grid">
${cards}
</div>`,
    script,
  )
}

function panelHtml(view, schema, label, css, height = 830) {
  const title = {
    board: '今日',
    duty: '值日',
    schedule: '安排',
    settings: '设置',
  }[view]
  const script = `window.PreviewRender.render(document.getElementById('panel-root'), ${JSON.stringify(schema)});`
  return page(
    `班级事务台 · ${title}`,
    css,
    `<div class="preview-head"><h1>班级事务台 · ${title}</h1><span>${label} · 右栏宽度约 400px</span></div>
<section class="panel-host" style="height:${height}px">
  <div class="plugin-page">
    <div class="page-body"><div id="panel-root"></div></div>
  </div>
</section>`,
    script,
  )
}

// ───────────────────────── 截图 ─────────────────────────

function findChrome() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function screenshot(chrome, htmlPath, pngPath, width, height) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ]
  const result = spawnSync(chrome, args, { stdio: 'ignore', timeout: 60000 })
  return result.status === 0 && fs.existsSync(pngPath)
}

// ───────────────────────── 入口 ─────────────────────────

async function mainRun() {
  fs.mkdirSync(CACHE, { recursive: true })
  const asar = asarFiles()
  if (asar === null) {
    process.stderr.write('找不到 Aurora 的 app.asar，无法获得宿主同款样式。\n')
    process.exitCode = 1
    return
  }
  const theme = readAsarEntry(asar, findAsset(asar, /\/theme-[^/]+\.css$/, 'theme-*.css'))
  const rendererCss = readAsarEntry(asar, findAsset(asar, /\/PluginSchemaRenderer-[^/]+\.css$/, 'PluginSchemaRenderer-*.css'))
  const widgetCss = readAsarEntry(asar, findAsset(asar, /\/widget-[^/]+\.css$/, 'widget-*.css'))
  const pageCss = readAsarEntry(asar, findAsset(asar, /\/PluginPageFrame-[^/]+\.css$/, 'PluginPageFrame-*.css'))
  if (theme === null || rendererCss === null || widgetCss === null || pageCss === null) {
    process.stderr.write('app.asar 中缺少预览所需的样式文件，Aurora 版本可能已变化。\n')
    process.exitCode = 1
    return
  }
  const variants = themeVariants(theme.toString('utf8'))
  const scopedCss = `${unscope(rendererCss.toString('utf8'))}\n${unscope(widgetCss.toString('utf8'))}\n${unscope(pageCss.toString('utf8'))}`
  const baseCss = `${variants.darkCss}\n${scopedCss}`
  const lightCss = `${variants.lightCss}\n${scopedCss}`

  process.stdout.write('生成演示数据…\n')
  const demo = await buildDemo()
  const empty = await buildEmpty()

  const files = []
  function write(name, html) {
    const target = path.join(CACHE, name)
    fs.writeFileSync(target, html, 'utf8')
    files.push(target)
    process.stdout.write(`  · ${target}\n`)
  }

  const darkAll = `${baseCss}\n${PREVIEW_CSS}`
  const lightAll = `${lightCss}\n${PREVIEW_CSS}`

  write('widgets-dark.html', widgetsHtml(demo, '示例数据', darkAll))
  write('widgets-empty-dark.html', widgetsHtml(empty, '空数据', darkAll))
  write('widgets-light.html', widgetsHtml(demo, '示例数据 · 浅色', lightAll))
  const panelHeights = { board: 1450, duty: 1450, schedule: 1900, settings: 1200 }
  for (const view of ['board', 'duty', 'schedule', 'settings']) {
    write(
      `panel-${view}-dark.html`,
      panelHtml(view, demo.panels[view], '示例数据', darkAll, panelHeights[view]),
    )
  }
  write('panel-board-light.html', panelHtml('board', demo.panels.board, '示例数据 · 浅色', lightAll, 1450))
  write('panel-board-empty-dark.html', panelHtml('board', empty.panels.board, '空数据 · 首次打开', darkAll, 830))
  write('panel-board-full-dark.html', panelHtml('board', demo.panels.board, '示例数据 · 完整今日', darkAll, 1450))
  if (demo.panels.boardEdit !== undefined) {
    write(
      'panel-board-edit-dark.html',
      panelHtml('board', demo.panels.boardEdit, '示例数据 · 编辑卡片', darkAll, 1750),
    )
  }

  // 把主题里的字体文件一并放到预览目录，避免 @font-face 相对路径失效
  const fontNames = [...new Set([...theme.toString('utf8').matchAll(/url\('\.\/([^']+)'\)/g)].map((match) => match[1]))]
  for (const fontName of fontNames) {
    const font = readAsarEntry(asar, ['out', 'renderer', 'assets', fontName])
    if (font !== null) fs.writeFileSync(path.join(CACHE, fontName), font)
  }

  const chrome = findChrome()
  if (chrome === null) {
    process.stdout.write('没有找到 Chrome/Edge，跳过截图。\n')
    return
  }
  const jobs = [
    ['widgets-dark.html', 'widgets-dark.png', 800, 620],
    ['widgets-empty-dark.html', 'widgets-empty-dark.png', 800, 620],
    ['widgets-light.html', 'widgets-light.png', 800, 620],
    ['panel-board-dark.html', 'panel-board-dark.png', 470, 1550],
    ['panel-duty-dark.html', 'panel-duty-dark.png', 470, 1550],
    ['panel-schedule-dark.html', 'panel-schedule-dark.png', 470, 2000],
    ['panel-settings-dark.html', 'panel-settings-dark.png', 470, 1300],
    ['panel-board-light.html', 'panel-board-light.png', 470, 1550],
    ['panel-board-empty-dark.html', 'panel-board-empty-dark.png', 470, 900],
    ['panel-board-full-dark.html', 'panel-board-full-dark.png', 470, 1550],
    ['panel-board-edit-dark.html', 'panel-board-edit-dark.png', 470, 1850],
  ]
  process.stdout.write('\n截图：\n')
  for (const [htmlName, pngName, width, height] of jobs) {
    const htmlPath = path.join(CACHE, htmlName)
    const pngPath = path.join(CACHE, pngName)
    const done = screenshot(chrome, htmlPath, pngPath, width, height)
    process.stdout.write(`  ${done ? '✓' : '✗'} ${pngPath}\n`)
    if (!done) process.exitCode = 1
  }
}

mainRun().catch((error) => {
  process.stderr.write(`预览生成失败：${String(error && error.stack ? error.stack : error)}\n`)
  process.exitCode = 1
})
