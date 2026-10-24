#!/usr/bin/env node
/**
 * 页面型「班级周历」预览 / 截图。
 *
 * v2.1.0 起事务台与两张小组件也改为页面型（由 dev/preview.mjs 预览）；本脚本只负责
 * 周历页：把真实的 ui/calendar.html、ui/calendar.css、ui/calendar.js 合成一份
 * 可直接用 file:// 打开的预览页，并注入只读 mock window.auroraPlugin，
 * 再交给本机 Chrome/Edge headless 截图。
 *
 * 产物全部写在 dev/.cache/ 下，只用于开发与文档配图，不进入插件包。
 *
 * 运行：node dev/preview-calendar.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const UI_DIR = path.join(ROOT, 'class-management', 'ui')
const CACHE = path.join(__dirname, '.cache')

const HTML_FILE = path.join(UI_DIR, 'calendar.html')
const CSS_FILE = path.join(UI_DIR, 'calendar.css')
const JS_FILE = path.join(UI_DIR, 'calendar.js')

// ───────────────────────── Chrome / Edge ─────────────────────────

function findChrome() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

/** 同步等待文件出现且非空；Chrome 写截图是「临时文件 + 重命名」，需要避开瞬时窗口。 */
function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false })
    if (stat !== undefined && stat.size > 0) return stat
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return null
}

function screenshot(chrome, htmlPath, pngPath, width, height) {
  // 先删旧图：避免截图失败时旧文件让等待逻辑误判成功。
  fs.rmSync(pngPath, { force: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3000',
    '--run-all-compositor-stages-before-draw',
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ]
  const result = spawnSync(chrome, args, { stdio: 'ignore', timeout: 60000 })
  if (result.status !== 0) return null
  return waitForFile(pngPath)
}

// ───────────────────────── 演示数据 ─────────────────────────

/**
 * 只读演示数据，形状与 ops.loadWeekGrid 对齐：
 * 固定 2026-10-19（周一）~ 2026-10-25（周日），today = 2026-10-21（周三）。
 * 覆盖：7 天卡片、3 天以上事务（含已完成 / 高优先级 + 截止时间 / 逾期）、
 * 2 天以上安排、值日组 + 成员 + 备注、班级通知、stats、isToday、canEdit。
 */
const DEMO_DATA = {
  weekOffset: 0,
  weekLabel: '第 8 周 · 10/19–10/25',
  weekNumber: 8,
  isCurrentWeek: true,
  todayKey: '2026-10-21',
  canEdit: true,
  duty: {
    group: { id: 'g1', name: '第1组', members: ['张三', '李四', '王五'] },
    groupId: 'g1',
    groupName: '第1组',
    members: ['张三', '李四', '王五'],
    note: '本周五放学后大扫除，请带好清洁工具',
    hasOverrideGroup: false,
    orderNames: ['第1组', '第2组', '第3组', '第4组'],
    orderIds: ['g1', 'g2', 'g3', 'g4'],
  },
  groups: [
    { id: 'g1', name: '第1组', members: ['张三', '李四', '王五'] },
    { id: 'g2', name: '第2组', members: ['赵六', '钱七', '孙八'] },
    { id: 'g3', name: '第3组', members: ['周九', '吴十', '郑一'] },
    { id: 'g4', name: '第4组', members: ['王二', '冯三', '陈四'] },
  ],
  announcement: '本周五下午大扫除，请各组带好清洁工具；周五放学前交校运会报名表。',
  stats: { total: 9, pending: 6, done: 3, high: 2, overdue: 1 },
  days: [
    {
      date: '2026-10-19',
      weekday: 1,
      label: '10/19 周一',
      isToday: false,
      canEdit: true,
      isPast: true,
      canAddTask: false,
      tasks: [
        {
          id: 't1',
          text: '收数学作业',
          done: false,
          date: '2026-10-19',
          priority: 'high',
          category: '作业',
          dueDate: '2026-10-19',
          dueTime: '08:00',
          assignee: '数学课代表',
          createdAt: '2026-10-17T08:00:00.000Z',
          dueLabel: '周一 08:00',
          overdue: true,
        },
        {
          id: 't2',
          text: '班会材料整理',
          done: true,
          date: '2026-10-19',
          priority: 'normal',
          category: '活动',
          dueDate: '2026-10-19',
          dueTime: '12:00',
          assignee: '班长',
          createdAt: '2026-10-17T08:05:00.000Z',
          dueLabel: '周一 12:00',
          overdue: false,
        },
      ],
      schedule: [
        {
          id: 's1',
          weekday: 1,
          time: '08:00',
          title: '升旗仪式',
          place: '操场',
          note: '',
          createdAt: '2026-10-16T08:00:00.000Z',
        },
      ],
    },
    {
      date: '2026-10-20',
      weekday: 2,
      label: '10/20 周二',
      isToday: false,
      canEdit: true,
      isPast: true,
      canAddTask: false,
      tasks: [
        {
          id: 't3',
          text: '英语单词默写',
          done: false,
          date: '2026-10-20',
          priority: 'normal',
          category: '作业',
          dueDate: '2026-10-20',
          dueTime: '07:40',
          assignee: '英语课代表',
          createdAt: '2026-10-18T08:00:00.000Z',
          dueLabel: '周二 07:40',
          overdue: false,
        },
        {
          id: 't4',
          text: '黑板报更新',
          done: true,
          date: '2026-10-20',
          priority: 'low',
          category: '活动',
          dueDate: '2026-10-20',
          dueTime: '18:00',
          assignee: '宣传委员',
          createdAt: '2026-10-18T08:05:00.000Z',
          dueLabel: '周二 18:00',
          overdue: false,
        },
      ],
      schedule: [],
    },
    {
      date: '2026-10-21',
      weekday: 3,
      label: '10/21 周三',
      isToday: true,
      canEdit: true,
      isPast: false,
      canAddTask: true,
      tasks: [
        {
          id: 't5',
          text: '物理实验报告',
          done: false,
          date: '2026-10-21',
          priority: 'high',
          category: '作业',
          dueDate: '2026-10-21',
          dueTime: '20:00',
          assignee: '学习委员',
          createdAt: '2026-10-19T08:00:00.000Z',
          dueLabel: '周三 20:00',
          overdue: false,
        },
        {
          id: 't6',
          text: '班会主题征集',
          done: true,
          date: '2026-10-21',
          priority: 'low',
          category: '活动',
          dueDate: '2026-10-21',
          dueTime: '',
          assignee: '班长',
          createdAt: '2026-10-19T08:05:00.000Z',
          dueLabel: '周三',
          overdue: false,
        },
        {
          id: 't7',
          text: '校运会报名表',
          done: false,
          date: '2026-10-21',
          priority: 'normal',
          category: '通知',
          dueDate: '2026-10-23',
          dueTime: '17:00',
          assignee: '体育委员',
          createdAt: '2026-10-19T08:10:00.000Z',
          dueLabel: '周五 17:00',
          overdue: false,
        },
      ],
      schedule: [
        {
          id: 's2',
          weekday: 3,
          time: '16:00',
          title: '班会',
          place: '教室',
          note: '主题：秋日运动会动员',
          createdAt: '2026-10-16T08:05:00.000Z',
        },
      ],
    },
    {
      date: '2026-10-22',
      weekday: 4,
      label: '10/22 周四',
      isToday: false,
      canEdit: true,
      isPast: false,
      canAddTask: true,
      tasks: [
        {
          id: 't8',
          text: '化学错题整理',
          done: false,
          date: '2026-10-22',
          priority: 'normal',
          category: '作业',
          dueDate: '2026-10-22',
          dueTime: '21:00',
          assignee: '化学课代表',
          createdAt: '2026-10-20T08:00:00.000Z',
          dueLabel: '周四 21:00',
          overdue: false,
        },
      ],
      schedule: [],
    },
    {
      date: '2026-10-23',
      weekday: 5,
      label: '10/23 周五',
      isToday: false,
      canEdit: true,
      isPast: false,
      canAddTask: true,
      tasks: [
        {
          id: 't9',
          text: '大扫除分组表',
          done: false,
          date: '2026-10-23',
          priority: 'normal',
          category: '事务',
          dueDate: '2026-10-23',
          dueTime: '15:30',
          assignee: '卫生委员',
          createdAt: '2026-10-20T08:05:00.000Z',
          dueLabel: '周五 15:30',
          overdue: false,
        },
      ],
      schedule: [
        {
          id: 's3',
          weekday: 5,
          time: '15:30',
          title: '大扫除',
          place: '教室',
          note: '带清洁工具',
          createdAt: '2026-10-16T08:10:00.000Z',
        },
      ],
    },
    {
      date: '2026-10-24',
      weekday: 6,
      label: '10/24 周六',
      isToday: false,
      canEdit: true,
      isPast: false,
      canAddTask: true,
      tasks: [],
      schedule: [],
    },
    {
      date: '2026-10-25',
      weekday: 7,
      label: '10/25 周日',
      isToday: false,
      canEdit: true,
      isPast: false,
      canAddTask: true,
      tasks: [],
      schedule: [],
    },
  ],
}

/** 生成 mock 脚本：只读 window.auroraPlugin，request 异步返回演示数据。 */
function mockScript() {
  const json = JSON.stringify(DEMO_DATA).replace(/</g, '\\u003c')
  return `(() => {
  'use strict'
  const DEMO_DATA = ${json}
  const clone = (value) => JSON.parse(JSON.stringify(value))

  // 与宿主页面沙箱同形：request(method, params) 返回 Promise<{ data, message? }>。
  // 演示只覆盖本周（weekOffset = 0）；其他周视角也返回同一份数据，便于截图不断档。
  const plugin = {
    request(method, params) {
      const name = typeof method === 'string' ? method : ''
      const requested = params !== null && typeof params === 'object' ? params.weekOffset : 0
      const data = clone(DEMO_DATA)
      if (Number.isInteger(requested)) data.weekOffset = requested
      if (name === 'load') return Promise.resolve({ data })
      return Promise.resolve({ data, message: '演示模式' })
    },
    onEvent(listener) {
      // 与宿主页面 preload 的真实签名一致：onEvent(listener(event, payload)) → 返回取消函数。
      // 演示不推送事件；记录 listener 以便调试，但返回 noop 取消函数。
      if (typeof listener !== 'function') return () => {}
      return () => {}
    },
  }

  Object.defineProperty(window, 'auroraPlugin', {
    value: Object.freeze(plugin),
    writable: false,
    configurable: false,
    enumerable: true,
  })
})()`
}

/** 编辑弹层驱动：页面加载后点击第一条事务的编辑按钮，失败时兜底直接打开 #editor。 */
const EDITOR_DRIVER = `(() => {
  'use strict'
  const startedAt = Date.now()
  const DEADLINE = 2500

  function findEditButton() {
    return (
      document.querySelector('.cal-task-edit') ||
      document.querySelector('[data-action="edit-task"]') ||
      document.querySelector('[data-method="edit-task"]')
    )
  }

  function openEditorFallback() {
    const editor = document.getElementById('editor')
    if (editor === null) return false
    editor.hidden = false
    editor.removeAttribute('hidden')
    editor.removeAttribute('aria-hidden')
    editor.classList.remove('hidden', 'is-hidden')
    return true
  }

  function attempt() {
    const button = findEditButton()
    if (button !== null) {
      button.click()
      return
    }
    if (Date.now() - startedAt >= DEADLINE) {
      openEditorFallback()
      return
    }
    setTimeout(attempt, 50)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(attempt, 50), { once: true })
  } else {
    setTimeout(attempt, 50)
  }
})()`

// ───────────────────────── CSS 主题 ─────────────────────────

/**
 * 找出所有 `@media (prefers-color-scheme: light)` 块（含嵌套花括号）。
 * 页面默认是暗色，浅色写在媒体查询里；headless 默认 color-scheme 不确定，
 * 因此暗色截图删掉浅色块、浅色截图把浅色块展开后追加，保证两张图稳定可复现。
 */
function findLightMediaBlocks(css) {
  const blocks = []
  const marker = '@media (prefers-color-scheme: light)'
  let cursor = 0
  while (true) {
    const start = css.indexOf(marker, cursor)
    if (start < 0) break
    const open = css.indexOf('{', start)
    if (open < 0) break
    let depth = 0
    let end = -1
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    if (end < 0) break
    blocks.push({ start, open, end })
    cursor = end + 1
  }
  return blocks
}

function themeCss(css) {
  const blocks = findLightMediaBlocks(css)
  let darkCss = ''
  let lightRules = ''
  let cursor = 0
  for (const block of blocks) {
    darkCss += css.slice(cursor, block.start)
    lightRules += `\n${css.slice(block.open + 1, block.end)}`
    cursor = block.end + 1
  }
  darkCss += css.slice(cursor)
  const lightCss = blocks.length === 0 ? darkCss : `${darkCss}\n/* 预览：展开 @media (prefers-color-scheme: light) */${lightRules}`
  return { darkCss, lightCss, lightBlockCount: blocks.length }
}

/** 给 <html> 加 data-theme（已有则覆盖），兼顾用属性切换主题的页面。 */
function withThemeAttribute(html, theme) {
  return html.replace(/<html\b([^>]*)>/i, (_match, attrs) => {
    const cleaned = String(attrs).replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*')/i, '')
    return `<html${cleaned} data-theme="${theme}">`
  })
}

// ───────────────────────── 预览 HTML ─────────────────────────

/** 只替换一次，找不到就报错，避免页面结构变化时静默输出错误预览。 */
function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`calendar.html 中找不到${label}`)
  return source.replace(pattern, replacement)
}

function buildHtml({ html, css, js, theme, driver, width }) {
  const usedCss = theme === 'light' ? css.lightCss : css.darkCss
  // Chrome headless 在 Windows 上有 500px 的最小窗口宽度，但 --screenshot 会按
  // --window-size 的 470px 裁图；把 html/body 显式锁到截图宽度，避免右侧 30px 被裁掉。
  const styleBlock = `<style>\n${usedCss}\nhtml, body { width: ${width}px; }\n</style>`
  // 内联脚本里若出现 </script> 会提前结束标签；转义后字符串语义不变。
  const inlineJs = js.replace(/<\/script>/gi, '<\\/script>')
  const scriptBlock = `<script>\n${mockScript()}\n</script>\n<script>\n${inlineJs}\n</script>`

  let page = html
  page = replaceRequired(
    page,
    /<link\b[^>]*href=(["'])calendar\.css\1[^>]*>/i,
    () => styleBlock,
    ' <link href="calendar.css">',
  )
  page = replaceRequired(
    page,
    /<script\b[^>]*\bsrc=(["'])calendar\.js\1[^>]*>\s*<\/script>/i,
    () => '',
    ' <script src="calendar.js">',
  )
  if (!/<\/body>/i.test(page)) throw new Error('calendar.html 缺少 </body>')
  // 放在 </body> 前执行，等价于原 defer 脚本在 DOM 就绪后运行。
  page = page.replace(/<\/body>/i, `${scriptBlock}\n</body>`)
  // 页面本身提供了 html[data-theme="dark"] / light 的预览锁定钩子，显式指定主题。
  page = withThemeAttribute(page, theme)
  if (driver) page = page.replace(/<\/body>/i, `<script>\n${EDITOR_DRIVER}\n</script>\n</body>`)
  return page
}

// ───────────────────────── 入口 ─────────────────────────

async function mainRun() {
  fs.mkdirSync(CACHE, { recursive: true })

  const missing = [HTML_FILE, CSS_FILE, JS_FILE].filter((file) => !fs.existsSync(file))
  if (missing.length > 0) {
    process.stderr.write(`缺少页面文件：\n${missing.map((file) => `  · ${file}`).join('\n')}\n`)
    process.exitCode = 1
    return
  }

  const html = fs.readFileSync(HTML_FILE, 'utf8')
  const css = themeCss(fs.readFileSync(CSS_FILE, 'utf8'))
  const js = fs.readFileSync(JS_FILE, 'utf8')
  if (css.lightBlockCount === 0) {
    process.stdout.write('提示：calendar.css 未使用 prefers-color-scheme: light，浅色截图依赖 data-theme="light"。\n')
  }

  const previews = [
    { name: 'calendar-preview.html', theme: 'dark', driver: false, png: 'calendar-preview.png', width: 470, height: 1500 },
    { name: 'calendar-preview-light.html', theme: 'light', driver: false, png: 'calendar-preview-light.png', width: 470, height: 1500 },
    { name: 'calendar-preview-editor.html', theme: 'dark', driver: true, png: 'calendar-preview-editor.png', width: 470, height: 1500 },
  ]

  const htmlPaths = []
  for (const preview of previews) {
    const target = path.join(CACHE, preview.name)
    fs.writeFileSync(target, buildHtml({ html, css, js, theme: preview.theme, driver: preview.driver, width: preview.width }), 'utf8')
    htmlPaths.push(target)
    process.stdout.write(`  · ${target}\n`)
  }

  const chrome = findChrome()
  if (chrome === null) {
    process.stdout.write('没有找到 Chrome/Edge，跳过截图。\n')
    return
  }

  process.stdout.write('\n截图：\n')
  const pngPaths = []
  for (const preview of previews) {
    const htmlPath = path.join(CACHE, preview.name)
    const pngPath = path.join(CACHE, preview.png)
    const stat = screenshot(chrome, htmlPath, pngPath, preview.width, preview.height)
    const done = stat !== null
    process.stdout.write(`  ${done ? '✓' : '✗'} ${pngPath}\n`)
    if (!done) process.exitCode = 1
    else pngPaths.push({ pngPath, size: stat.size })
  }

  if (process.exitCode !== 1) {
    process.stdout.write(`\n生成完成（${htmlPaths.length} 个预览页，${pngPaths.length} 张截图）：\n`)
    for (const { pngPath, size } of pngPaths) {
      process.stdout.write(`  · ${pngPath}（${Math.round(size / 1024)} KB）\n`)
    }
  }
}

mainRun().catch((error) => {
  process.stderr.write(`页面预览生成失败：${String(error && error.stack ? error.stack : error)}\n`)
  process.exitCode = 1
})
