#!/usr/bin/env node
/**
 * 页面型「班级事务台 + 桌面小组件」预览 / 截图（v2.1.0）。
 *
 * 与旧的声明式预览不同：v2.1.0 的 4 个视图与 2 张小组件都是纯 HTML/CSS/JS 页面，
 * 因此这里直接读取真实的页面文件，按宿主页面的加载方式拼成可用 file:// 打开的
 * 静态页面，再交给本机 Chrome/Edge headless 截图：
 *
 *   1. 读取 ui/board.html|board.css|board.js、ui/widget-*.html|js、ui/widget.css；
 *   2. 内联 calendar.css（设计系统）+ 页面自有 CSS / JS；
 *   3. 注入只读 mock window.auroraPlugin：request 返回契约 §5 / §7 形状的演示数据，
 *      onEvent 返回空取消函数（不推送事件）；
 *   4. 用 html[data-theme="dark"|"light"] 强制主题（不依赖系统主题）；
 *   5. 面板截图宽度固定 470px（与 README 旧图一致），高度先渲染量 scrollHeight 再截图；
 *      小组件按宿主真实可视区域 320×(300-28) / 360×(460-28) 放进模拟的 28px 宿主标题栏里，
 *      另出一组放大到 640×520 / 720×900 的「课堂投屏」预览，验证字号随窗口宽度缩放；
 *   6. 产物全部写到 dev/.cache/（gitignore），只用于开发与 docs/images 配图。
 *
 * 运行：node dev/preview.mjs
 * 找不到 Chrome/Edge 时只生成预览 HTML、打印提示并退出 0（与旧脚本一致）。
 * 脚本零依赖，只用 node 内置模块。
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

// 右栏面板截图宽度：与 README 旧图 / 宿主右栏右边界口径一致。
const PANEL_WIDTH = 470
// 宿主小组件窗口自绘标题栏高度（页面可用高度 = defaultSize.height - 28）。
const WIDGET_TITLE_BAR = 28
// 面板弹层截图用固定视口高度：弹层是 position: fixed，需要给一个像真机的可视高度。
const MODAL_VIEWPORT_HEIGHT = 1500
// 量高失败时的兜底高度（只用于异常兜底，正常情况都走 scrollHeight）。
const FALLBACK_HEIGHTS = {
  'panel-board-full-dark': 1650,
  'panel-board-empty-dark': 900,
  'panel-duty-dark': 900,
  'panel-schedule-dark': 1100,
  'panel-settings-dark': 1150,
  'panel-board-light': 1650,
  'panel-schedule-past-dark': 1000,
}

const FILES = {
  boardHtml: path.join(UI_DIR, 'board.html'),
  boardCss: path.join(UI_DIR, 'board.css'),
  boardJs: path.join(UI_DIR, 'board.js'),
  overviewHtml: path.join(UI_DIR, 'widget-overview.html'),
  overviewJs: path.join(UI_DIR, 'widget-overview.js'),
  tasksHtml: path.join(UI_DIR, 'widget-tasks.html'),
  tasksJs: path.join(UI_DIR, 'widget-tasks.js'),
  widgetCss: path.join(UI_DIR, 'widget.css'),
  calendarCss: path.join(UI_DIR, 'calendar.css'),
}

// manifest 里的两张桌面小组件（defaultSize 与宿主可视区域换算用）；
// classroom 是「教室一体机 / 投屏」预览用的放大尺寸，用来验证字号随窗口缩放。
const WIDGETS = [
  {
    id: 'week-overview',
    title: '班级速览',
    file: 'widget-overview',
    width: 320,
    height: 300,
    classroom: { width: 640, height: 520 },
  },
  {
    id: 'week-tasks',
    title: '今日事务',
    file: 'widget-tasks',
    width: 360,
    height: 460,
    classroom: { width: 720, height: 900 },
  },
]

// 小组件并排预览页的外框尺寸：卡片 + 28px 模拟宿主标题栏 + 页面留白。
const SHOWCASE_GAP = 22
const SHOWCASE_PADDING_X = 24
const SHOWCASE_PADDING_TOP = 22
const SHOWCASE_PADDING_BOTTOM = 26

function showcaseSize(widgets) {
  return {
    width:
      widgets.reduce((total, widget) => total + widget.width, 0) +
      SHOWCASE_GAP * (widgets.length - 1) +
      SHOWCASE_PADDING_X * 2,
    height:
      Math.max.apply(
        null,
        widgets.map((widget) => widget.height),
      ) +
      SHOWCASE_PADDING_TOP +
      SHOWCASE_PADDING_BOTTOM,
  }
}

// ───────────────────────── Chrome / Edge ─────────────────────────

function findChrome() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function fileUrl(filePath) {
  return `file:///${path.resolve(filePath).replace(/\\/g, '/')}`
}

/** 同步等待文件出现且非空；Chrome 写截图是「临时文件 + 重命名」，需要避开瞬时窗口。 */
function waitForFile(filePath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false })
    if (stat !== undefined && stat.size > 0) return stat
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return null
}

/** 固定窗口尺寸截图；返回 PNG stat 或 null。 */
function screenshot(chrome, htmlPath, pngPath, width, height) {
  // 先删旧图：截图失败时不会让等待逻辑误判成功。
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
    fileUrl(htmlPath),
  ]
  const result = spawnSync(chrome, args, { stdio: 'ignore', timeout: 90000 })
  if (result.status !== 0) return null
  return waitForFile(pngPath)
}

/**
 * 先渲染量页面内容高度：用 --dump-dom 取回测量脚本写进 <title> 的 CONTENT_HEIGHT。
 * 页面宽度固定，视口高度不影响换行，所以量高窗口用保守的 500px 即可
 * （body 有 min-height: 100vh，视口越低越不会把短页面量高）。
 */
function measureContentHeight(chrome, htmlPath, width, fallback) {
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=3000',
      `--window-size=${width},500`,
      '--dump-dom',
      fileUrl(htmlPath),
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 90000 },
  )
  const stdout = String(result.stdout === undefined || result.stdout === null ? '' : result.stdout)
  const match = /<title[^>]*>CONTENT_HEIGHT:(\d+)<\/title>/i.exec(stdout)
  if (match === null) return fallback
  const height = Number(match[1])
  if (!Number.isFinite(height) || height < 300) return fallback
  // 上限防止异常页面（例如量到 1 万像素）生成超大图。
  return Math.min(4000, Math.max(480, Math.ceil(height)))
}

// ───────────────────────── 演示数据（契约 §5 / §7） ─────────────────────────

const WEEK = {
  className: '高二(15)班',
  teacher: '王老师',
  termStartDate: '2026-09-01',
  today: '2026-10-21',
  todayLabel: '10/21 周三',
  todayWeekday: 3,
  weekOffset: 0,
  weekNumber: 8,
  weekLabel: '第 8 周 · 10/19–10/25',
  weekRange: '10/19–10/25',
  announcement: '本周五下午大扫除，请各组带好清洁工具；周五放学前交校运会报名表。',
}

const GROUPS = [
  { id: 'g1', name: '第1组', members: ['张三', '李四', '王五'] },
  { id: 'g2', name: '第2组', members: ['赵六', '钱七', '孙八'] },
  { id: 'g3', name: '第3组', members: ['周九', '吴十', '郑一'] },
  { id: 'g4', name: '第4组', members: ['王二', '冯三', '陈四'] },
]

/** 今日事务：覆盖未完成 / 已完成 / 逾期 / 高优先级 / 有截止 / 无截止。 */
const DEMO_TASKS = [
  {
    id: 't1',
    text: '收数学作业',
    done: false,
    date: WEEK.today,
    priority: 'high',
    category: '作业',
    dueDate: WEEK.today,
    dueTime: '08:00',
    assignee: '数学课代表',
    createdAt: '2026-10-19T08:00:00.000Z',
    dueLabel: '今天 08:00',
    overdue: true,
  },
  {
    id: 't2',
    text: '物理实验报告',
    done: false,
    date: WEEK.today,
    priority: 'high',
    category: '作业',
    dueDate: WEEK.today,
    dueTime: '20:00',
    assignee: '学习委员',
    createdAt: '2026-10-19T08:05:00.000Z',
    dueLabel: '今天 20:00',
    overdue: false,
  },
  {
    id: 't3',
    text: '校运会报名表',
    done: false,
    date: WEEK.today,
    priority: 'normal',
    category: '通知',
    dueDate: '2026-10-23',
    dueTime: '17:00',
    assignee: '体育委员',
    createdAt: '2026-10-19T08:10:00.000Z',
    dueLabel: '周五 17:00',
    overdue: false,
  },
  {
    id: 't4',
    text: '班会主题征集',
    done: false,
    date: WEEK.today,
    priority: 'low',
    category: '活动',
    dueDate: '',
    dueTime: '',
    assignee: '班长',
    createdAt: '2026-10-20T08:00:00.000Z',
    dueLabel: '',
    overdue: false,
  },
  {
    id: 't5',
    text: '英语单词默写',
    done: true,
    date: WEEK.today,
    priority: 'normal',
    category: '作业',
    dueDate: WEEK.today,
    dueTime: '07:40',
    assignee: '英语课代表',
    createdAt: '2026-10-19T08:15:00.000Z',
    doneAt: '2026-10-21T07:55:00.000Z',
    dueLabel: '今天 07:40',
    overdue: false,
  },
  {
    id: 't6',
    text: '黑板报更新',
    done: true,
    date: WEEK.today,
    priority: 'low',
    category: '活动',
    dueDate: '',
    dueTime: '',
    assignee: '宣传委员',
    createdAt: '2026-10-18T08:00:00.000Z',
    doneAt: '2026-10-20T18:00:00.000Z',
    dueLabel: '',
    overdue: false,
  },
]

/** 本周 3 条安排：周一升旗、周三（今天）班会、周五大扫除。 */
const DEMO_SCHEDULE = [
  {
    id: 's1',
    weekday: 1,
    time: '08:00',
    title: '升旗仪式',
    place: '操场',
    note: '',
    createdAt: '2026-10-16T08:00:00.000Z',
  },
  {
    id: 's2',
    weekday: 3,
    time: '16:00',
    title: '班会',
    place: '教室',
    note: '主题：秋日运动会动员',
    createdAt: '2026-10-16T08:05:00.000Z',
  },
  {
    id: 's3',
    weekday: 5,
    time: '15:30',
    title: '大扫除',
    place: '教室',
    note: '带清洁工具',
    createdAt: '2026-10-16T08:10:00.000Z',
  },
]

const DEMO_DUTY = {
  groupName: '第1组',
  members: ['张三', '李四', '王五'],
  note: '本周五放学后大扫除，请带好清洁工具。',
}

const DEMO_ROTATION = [
  { week: '第 6 周', group: '第3组' },
  { week: '第 7 周', group: '第4组' },
  { week: '第 8 周（本周）', group: '第1组' },
  { week: '第 9 周', group: '第2组' },
]

/** 过去周（canEdit: false）的安排：用于验证只读态。 */
const PAST_SCHEDULE = [
  {
    id: 'ps1',
    weekday: 1,
    time: '08:00',
    title: '升旗仪式',
    place: '操场',
    note: '',
    createdAt: '2026-10-09T08:00:00.000Z',
  },
  {
    id: 'ps2',
    weekday: 4,
    time: '16:00',
    title: '阶段测验',
    place: '教室',
    note: '数学：必修一 3~4 章',
    createdAt: '2026-10-09T08:05:00.000Z',
  },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function countsOf(tasks) {
  let pending = 0
  let done = 0
  let high = 0
  let overdue = 0
  for (const task of tasks) {
    if (task === null || typeof task !== 'object') continue
    if (task.done === true) {
      done += 1
      continue
    }
    pending += 1
    if (task.priority === 'high') high += 1
    if (task.overdue === true) overdue += 1
  }
  return { total: tasks.length, pending, done, high, overdue }
}

function completionOf(counts) {
  if (counts.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((counts.done / counts.total) * 100)))
}

/** 构造一份形状与 ops.loadBoard 输出一致的 BoardPageData。 */
function createBoardData(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : clone(DEMO_TASKS)
  const schedule = Array.isArray(cfg.schedule) ? cfg.schedule : clone(DEMO_SCHEDULE)
  const groups = Array.isArray(cfg.groups) ? cfg.groups : clone(GROUPS)
  const duty = Object.assign({}, DEMO_DUTY, cfg.duty === undefined || cfg.duty === null ? {} : cfg.duty)
  const orderNames = Array.isArray(cfg.orderNames)
    ? cfg.orderNames
    : groups.map(function (group) {
        return group.name
      })
  const counts = countsOf(tasks)
  return {
    view: typeof cfg.view === 'string' ? cfg.view : 'board',
    weekOffset: Number.isInteger(cfg.weekOffset) ? cfg.weekOffset : WEEK.weekOffset,
    isCurrentWeek: cfg.isCurrentWeek !== false,
    isPastWeek: cfg.isPastWeek === true,
    canEdit: cfg.canEdit !== false,
    weekLabel: typeof cfg.weekLabel === 'string' ? cfg.weekLabel : WEEK.weekLabel,
    weekNumber: Number.isInteger(cfg.weekNumber) ? cfg.weekNumber : WEEK.weekNumber,
    weekRange: typeof cfg.weekRange === 'string' ? cfg.weekRange : WEEK.weekRange,
    today: WEEK.today,
    taskDate: WEEK.today,
    taskDateLabel: WEEK.todayLabel,
    settings: {
      className: typeof cfg.className === 'string' ? cfg.className : WEEK.className,
      teacher: typeof cfg.teacher === 'string' ? cfg.teacher : WEEK.teacher,
      termStartDate: typeof cfg.termStartDate === 'string' ? cfg.termStartDate : WEEK.termStartDate,
    },
    counts,
    completion: completionOf(counts),
    tasks,
    schedule,
    announcement: typeof cfg.announcement === 'string' ? cfg.announcement : WEEK.announcement,
    duty: {
      groupName: typeof duty.groupName === 'string' ? duty.groupName : '',
      members: Array.isArray(duty.members) ? duty.members : [],
      note: typeof duty.note === 'string' ? duty.note : '',
      hasOverrideGroup: duty.hasOverrideGroup === true,
      orderNames,
    },
    dutyGroupId: typeof cfg.dutyGroupId === 'string' ? cfg.dutyGroupId : '',
    groups,
    groupsText:
      typeof cfg.groupsText === 'string'
        ? cfg.groupsText
        : groups
            .map(function (group) {
              return group.name + ': ' + group.members.join(', ')
            })
            .join('\n'),
    orderText: typeof cfg.orderText === 'string' ? cfg.orderText : orderNames.join('，'),
    rotationPreview: Array.isArray(cfg.rotationPreview) ? cfg.rotationPreview : clone(DEMO_ROTATION),
    stats:
      cfg.stats !== undefined && cfg.stats !== null
        ? cfg.stats
        : { weeks: 6, tasks: 52, done: 39, schedule: 21, bytes: 61440 },
    boardEmpty: cfg.boardEmpty === true,
  }
}

/** 空今日：没有任何事务 / 安排 / 通知 / 值日组（首次打开的空态）。 */
function createEmptyBoardData() {
  return createBoardData({
    tasks: [],
    schedule: [],
    groups: [],
    duty: { groupName: '', members: [], note: '' },
    announcement: '',
    rotationPreview: [],
    stats: { weeks: 0, tasks: 0, done: 0, schedule: 0, bytes: 0 },
    boardEmpty: true,
  })
}

/** 过去周只读：安排视图 / weekOffset = -1。 */
function createPastWeekBoardData() {
  return createBoardData({
    view: 'schedule',
    weekOffset: -1,
    isCurrentWeek: false,
    isPastWeek: true,
    canEdit: false,
    weekNumber: 7,
    weekLabel: '第 7 周 · 10/12–10/18',
    weekRange: '10/12–10/18',
    tasks: [],
    schedule: PAST_SCHEDULE,
    duty: { groupName: '第4组', members: ['王二', '冯三', '陈四'], note: '上周值日：擦窗、倒垃圾。' },
    rotationPreview: [
      { week: '第 6 周', group: '第3组' },
      { week: '第 7 周（该周）', group: '第4组' },
      { week: '第 8 周（本周）', group: '第1组' },
      { week: '第 9 周', group: '第2组' },
    ],
    stats: { weeks: 7, tasks: 52, done: 39, schedule: 21, bytes: 61440 },
  })
}

/** 构造一份形状与 widget 处理器输出一致的 WidgetData（契约 §7.1）。 */
function createWidgetData(widgetId, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : clone(DEMO_TASKS)
  const schedule = Array.isArray(cfg.schedule) ? cfg.schedule : clone(DEMO_SCHEDULE)
  const duty = Object.assign({}, DEMO_DUTY, cfg.duty === undefined || cfg.duty === null ? {} : cfg.duty)
  const counts = countsOf(tasks)
  return {
    widgetId,
    className: typeof cfg.className === 'string' ? cfg.className : WEEK.className,
    teacher: typeof cfg.teacher === 'string' ? cfg.teacher : WEEK.teacher,
    weekLabel: typeof cfg.weekLabel === 'string' ? cfg.weekLabel : WEEK.weekLabel,
    weekRange: typeof cfg.weekRange === 'string' ? cfg.weekRange : WEEK.weekRange,
    weekNumber: Number.isInteger(cfg.weekNumber) ? cfg.weekNumber : WEEK.weekNumber,
    today: WEEK.today,
    todayLabel: WEEK.todayLabel,
    taskDateLabel: WEEK.todayLabel,
    todayWeekday: WEEK.todayWeekday,
    counts,
    completion: completionOf(counts),
    tasks,
    schedule,
    scheduleCount: schedule.length,
    duty: {
      groupName: typeof duty.groupName === 'string' ? duty.groupName : '',
      members: Array.isArray(duty.members) ? duty.members : [],
      note: typeof duty.note === 'string' ? duty.note : '',
    },
    announcement: typeof cfg.announcement === 'string' ? cfg.announcement : WEEK.announcement,
    showCompleted: cfg.showCompleted === true,
  }
}

// ───────────────────────── 页面组装 ─────────────────────────

/** 只替换一次；页面结构变化时直接报错，避免静默产出错误预览。 */
function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`页面结构已变化，找不到${label}`)
  return source.replace(pattern, replacement)
}

/** 给 <html> 加 data-theme（已有则覆盖）；calendar.css 用它锁定预览主题。 */
function withThemeAttribute(html, theme) {
  return html.replace(/<html\b([^>]*)>/i, (_match, attrs) => {
    const cleaned = String(attrs).replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*')/i, '')
    return `<html${cleaned} data-theme="${theme}">`
  })
}

/** 内联脚本里出现 </script> 会提前结束标签，转义后字符串语义不变。 */
function inlineScript(code) {
  return `<script>\n${String(code).replace(/<\/script>/gi, '<\\/script>')}\n</script>`
}

function scriptTagPattern(fileName) {
  return new RegExp(`<script\\b[^>]*\\bsrc=(["'])${fileName.replace(/\./g, '\\.')}\\1[^>]*>\\s*</script>`, 'i')
}

function linkTagPattern(fileName) {
  return new RegExp(`<link\\b[^>]*href=(["'])${fileName.replace(/\./g, '\\.')}\\1[^>]*>`, 'i')
}

/**
 * mock window.auroraPlugin：只读演示。
 * - load / save-view 返回当前演示数据（save-view 时把 view / weekOffset 回填，模拟后端持久化）；
 * - 其他写动作同样返回演示数据 + message（截图只打开弹层，不真正提交）；
 * - onEvent(listener) 返回取消函数，不推送 board.changed。
 */
function mockPluginScript(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `(() => {
  'use strict'
  const DEMO_DATA = ${json}
  const clone = (value) => JSON.parse(JSON.stringify(value))

  const plugin = {
    request(method, params) {
      const name = typeof method === 'string' ? method : ''
      const data = clone(DEMO_DATA)
      if (name === 'load' || name === 'save-view') {
        if (params !== null && typeof params === 'object') {
          if (typeof params.view === 'string') data.view = params.view
          if (Number.isInteger(params.weekOffset)) data.weekOffset = params.weekOffset
        }
        return Promise.resolve({ data })
      }
      return Promise.resolve({ data, message: '演示模式（预览不写数据）' })
    },
    onEvent(listener) {
      // 与宿主页面 preload 的真实签名一致：onEvent(listener(event, payload)) → 返回取消函数。
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

/**
 * 量高脚本：等首屏渲染完成后把内容高度写进 <title>，供 --dump-dom 取回。
 * 注意不能用 requestAnimationFrame：headless + --dump-dom 不会推进合成帧，
 * rAF 回调在 dump 之前不会执行；这里只用 setInterval / setTimeout。
 */
const MEASURE_SCRIPT = `(() => {
  'use strict'

  function measure() {
    const height = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
    document.title = 'CONTENT_HEIGHT:' + height
  }

  function ready() {
    const meta = document.getElementById('class-meta')
    return meta !== null && meta.textContent.trim() !== ''
  }

  let ticks = 0
  const timer = setInterval(function () {
    ticks += 1
    if (ready() || ticks >= 75) {
      clearInterval(timer)
      measure()
      // 渲染后的过渡 / 字体度量可能再微调一次高度，稍后再量一遍。
      setTimeout(measure, 80)
    }
  }, 40)
})()`

/** 打开页面里的某个弹层 / 点击某个按钮：轮询等元素出现后点一次。 */
function clickFirstScript(selector) {
  return `(() => {
  'use strict'
  const TARGET = ${JSON.stringify(selector)}
  const startedAt = Date.now()
  const timer = setInterval(function () {
    const node = document.querySelector(TARGET)
    if (node !== null) {
      clearInterval(timer)
      node.click()
      return
    }
    if (Date.now() - startedAt > 3000) clearInterval(timer)
  }, 40)
})()`
}

function buildBoardPage(options) {
  const html = options.html
  const theme = options.theme
  const data = options.data
  const driver = options.driver
  const calendarCss = options.calendarCss
  const boardCss = options.boardCss
  const boardJs = options.boardJs

  const styleCalendar = `<style>\n${calendarCss}\n</style>`
  // Chrome headless 在 Windows 上窗口最小宽度是 500px（截图再裁到 470），固定定位的弹层
  // 会按 500px 视口居中、在 470px 截图里偏右 15px；预览里把弹层锁到截图宽度。
  const styleBoard = `<style>\n${boardCss}\n\n/* 预览：锁死右栏面板宽度，避免 headless 最小窗口宽度影响布局 */\nhtml, body { width: ${PANEL_WIDTH}px; }\n.cal-modal { right: auto; width: ${PANEL_WIDTH}px; }\n</style>`

  let page = html
  page = replaceRequired(page, linkTagPattern('calendar.css'), () => styleCalendar, ' <link href="calendar.css">')
  page = replaceRequired(page, linkTagPattern('board.css'), () => styleBoard, ' <link href="board.css">')
  page = replaceRequired(page, scriptTagPattern('board.js'), () => '', ' <script src="board.js">')

  const blocks = [inlineScript(mockPluginScript(data)), inlineScript(boardJs), inlineScript(MEASURE_SCRIPT)]
  if (driver !== undefined) blocks.push(inlineScript(driver))
  if (!/<\/body>/i.test(page)) throw new Error('board.html 缺少 </body>')
  page = page.replace(/<\/body>/i, `${blocks.join('\n')}\n</body>`)
  return withThemeAttribute(page, theme)
}

function buildWidgetPage(options) {
  const html = options.html
  const js = options.js
  const data = options.data
  const theme = options.theme
  const width = options.width
  const height = options.height
  const calendarCss = options.calendarCss
  const widgetCss = options.widgetCss
  const jsFile = options.jsFile

  const styleCalendar = `<style>\n${calendarCss}\n</style>`
  // 页面本体在宿主里是透明底（不透明卡片由宿主窗口绘制）；iframe 预览同样保留透明，
  // 由外层模拟卡片的底色透出。宽高锁死为宿主可视区域，保证媒体查询与真机一致。
  const styleWidget = `<style>\n${widgetCss}\n</style>\n<style>\nhtml, body { width: ${width}px; height: ${height}px; }\n</style>`

  let page = html
  page = replaceRequired(page, linkTagPattern('calendar.css'), () => styleCalendar, ' <link href="calendar.css">')
  page = replaceRequired(page, linkTagPattern('widget.css'), () => styleWidget, ' <link href="widget.css">')
  page = replaceRequired(page, scriptTagPattern(jsFile), () => '', ` <script src="${jsFile}">`)

  const blocks = [inlineScript(mockPluginScript(data)), inlineScript(js)]
  if (!/<\/body>/i.test(page)) throw new Error(`${jsFile} 所在页面缺少 </body>`)
  page = page.replace(/<\/body>/i, `${blocks.join('\n')}\n</body>`)
  return withThemeAttribute(page, theme)
}

/** 并排两张桌面小组件：模拟宿主 28px 标题栏 + 真实可视区域的页面 iframe。 */
function buildWidgetsShowcase(options) {
  const theme = options.theme
  const innerFiles = options.innerFiles
  const calendarCss = options.calendarCss
  const widgets = options.widgets
  const size = showcaseSize(widgets)

  const showcaseCss = `
*,
*::before,
*::after { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  width: ${size.width}px;
  height: ${size.height}px;
  padding: ${SHOWCASE_PADDING_TOP}px ${SHOWCASE_PADDING_X}px ${SHOWCASE_PADDING_BOTTOM}px;
  overflow: hidden;
  background-color: var(--cal-bg);
  background-image:
    radial-gradient(120% 80% at 88% -8%, var(--cal-glow-a), transparent 58%),
    radial-gradient(110% 80% at -12% 104%, var(--cal-glow-b), transparent 60%);
  color: var(--cal-text);
  font: 12px/1.5 var(--cal-font-body);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.wd-showcase {
  display: flex;
  align-items: flex-start;
  gap: ${SHOWCASE_GAP}px;
}

/* 模拟宿主小组件窗口：不透明卡片 + 28px 标题栏（标题 + ×），页面内容在标题栏下方 */
.wd-host-card {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--cal-line-strong);
  border-radius: var(--cal-radius);
  background: var(--cal-surface-raised);
  box-shadow: 0 16px 36px -18px rgba(0, 0, 0, 0.55);
}

.wd-host-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  height: ${WIDGET_TITLE_BAR}px;
  padding: 0 8px 0 11px;
  border-bottom: 1px solid var(--cal-line);
  background: var(--cal-surface);
}

.wd-host-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--cal-muted);
  font-size: 11px;
  line-height: 1.4;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wd-host-close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--cal-faint);
  font-family: var(--cal-font-body);
  font-size: 15px;
  line-height: 1;
}

.wd-host-body {
  flex: 0 0 auto;
  background: var(--cal-surface-raised);
}

.wd-host-body iframe {
  display: block;
  border: 0;
  background: transparent;
}
`

  const cards = widgets.map(function (widget) {
    const bodyHeight = widget.height - WIDGET_TITLE_BAR
    const innerFile = innerFiles[widget.id]
    if (typeof innerFile !== 'string' || innerFile === '') {
      throw new Error(`缺少小组件 ${widget.id} 的内部预览页`)
    }
    return `<section class="wd-host-card" style="width:${widget.width}px">
  <header class="wd-host-head">
    <span class="wd-host-title">${widget.title}</span>
    <span class="wd-host-close" aria-hidden="true">×</span>
  </header>
  <div class="wd-host-body">
    <iframe src="${innerFile}" title="${widget.title}（${widget.width}×${bodyHeight}）" style="width:${widget.width}px;height:${bodyHeight}px"></iframe>
  </div>
</section>`
  }).join('\n')

  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>桌面小组件预览</title>
<style>
${calendarCss}
</style>
<style>
${showcaseCss}
</style>
</head>
<body>
<main class="wd-showcase">
${cards}
</main>
</body>
</html>`
}

// ───────────────────────── 预览清单 ─────────────────────────

function panelPreviews() {
  return [
    {
      name: 'panel-board-full-dark',
      theme: 'dark',
      label: '今日视图 · 完整示例数据',
      data: createBoardData(),
    },
    {
      name: 'panel-board-empty-dark',
      theme: 'dark',
      label: '今日视图 · 空态',
      data: createEmptyBoardData(),
    },
    {
      name: 'panel-board-edit-dark',
      theme: 'dark',
      label: '今日视图 · 事务编辑弹层',
      data: createBoardData(),
      driver: clickFirstScript('#pending-tasks .board-task-btn'),
      height: MODAL_VIEWPORT_HEIGHT,
    },
    {
      name: 'panel-duty-dark',
      theme: 'dark',
      label: '值日视图',
      data: createBoardData({ view: 'duty' }),
    },
    {
      name: 'panel-schedule-dark',
      theme: 'dark',
      label: '安排视图',
      data: createBoardData({ view: 'schedule' }),
    },
    {
      name: 'panel-settings-dark',
      theme: 'dark',
      label: '设置视图',
      data: createBoardData({ view: 'settings' }),
    },
    {
      name: 'panel-board-light',
      theme: 'light',
      label: '今日视图 · 浅色',
      data: createBoardData(),
    },
    {
      name: 'board-confirm-dark',
      theme: 'dark',
      label: '今日视图 · 删除确认弹层',
      data: createBoardData(),
      driver: clickFirstScript('#pending-tasks .board-task-btn.is-danger'),
      height: MODAL_VIEWPORT_HEIGHT,
    },
    {
      name: 'panel-schedule-past-dark',
      theme: 'dark',
      label: '安排视图 · 过去周只读',
      data: createPastWeekBoardData(),
    },
  ]
}

function widgetPreviews() {
  return [
    { name: 'widgets-dark', theme: 'dark', variant: 'dark', label: '两张小组件并排 · 深色' },
    { name: 'widgets-light', theme: 'light', variant: 'light', label: '两张小组件并排 · 浅色' },
    { name: 'widgets-empty-dark', theme: 'dark', variant: 'empty-dark', label: '两张小组件并排 · 空态' },
    // 教室一体机 / 投屏：把窗口拉大后字号随宽度等比放大（640×520 / 720×900）
    { name: 'widgets-classroom-dark', theme: 'dark', variant: 'classroom-dark', label: '两张小组件放大 · 课堂投屏', classroom: true },
  ]
}

function widgetDataFor(variant, widgetId) {
  if (variant === 'empty-dark') {
    return createWidgetData(widgetId, {
      tasks: [],
      schedule: [],
      duty: { groupName: '', members: [], note: '' },
      announcement: '',
      showCompleted: false,
    })
  }
  // 预览开启「今日事务」小组件的已完成区（配置项 showCompleted），
  // 360×432 的可视区域里待办 + 已完成 + 本周安排刚好完整落位，不会裁掉半行。
  return createWidgetData(widgetId, { showCompleted: widgetId === 'week-tasks' })
}

// ───────────────────────── 入口 ─────────────────────────

function ensureHtmlFiles() {
  const missing = Object.values(FILES).filter((file) => !fs.existsSync(file))
  if (missing.length > 0) {
    process.stderr.write(`缺少页面文件，无法生成预览：\n${missing.map((file) => `  · ${file}`).join('\n')}\n`)
    return false
  }
  return true
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8')
  process.stdout.write(`  · ${filePath}\n`)
}

async function mainRun() {
  fs.mkdirSync(CACHE, { recursive: true })
  if (!ensureHtmlFiles()) {
    process.exitCode = 1
    return
  }

  const source = {
    calendarCss: fs.readFileSync(FILES.calendarCss, 'utf8'),
    boardHtml: fs.readFileSync(FILES.boardHtml, 'utf8'),
    boardCss: fs.readFileSync(FILES.boardCss, 'utf8'),
    boardJs: fs.readFileSync(FILES.boardJs, 'utf8'),
    overviewHtml: fs.readFileSync(FILES.overviewHtml, 'utf8'),
    overviewJs: fs.readFileSync(FILES.overviewJs, 'utf8'),
    tasksHtml: fs.readFileSync(FILES.tasksHtml, 'utf8'),
    tasksJs: fs.readFileSync(FILES.tasksJs, 'utf8'),
    widgetCss: fs.readFileSync(FILES.widgetCss, 'utf8'),
  }

  process.stdout.write('生成预览页（dev/.cache）：\n')

  // ── 面板：9 张图 ──
  const panels = panelPreviews()
  for (const preview of panels) {
    const html = buildBoardPage({
      html: source.boardHtml,
      calendarCss: source.calendarCss,
      boardCss: source.boardCss,
      boardJs: source.boardJs,
      data: preview.data,
      theme: preview.theme,
      driver: preview.driver,
    })
    writeFile(path.join(CACHE, `${preview.name}.html`), html)
  }

  // ── 小组件：先出 inner 页，再出并排展示页（默认 / 课堂放大两套尺寸）──
  const showcasePages = []
  for (const preview of widgetPreviews()) {
    const widgets = WIDGETS.map((widget) => {
      const size = preview.classroom === true ? widget.classroom : widget
      return { id: widget.id, title: widget.title, file: widget.file, width: size.width, height: size.height }
    })
    const innerFiles = {}
    for (const widget of widgets) {
      const innerName = `${widget.file}-${preview.variant}.inner.html`
      const innerHtml = buildWidgetPage({
        html: widget.id === 'week-overview' ? source.overviewHtml : source.tasksHtml,
        js: widget.id === 'week-overview' ? source.overviewJs : source.tasksJs,
        jsFile: `${widget.file}.js`,
        data: widgetDataFor(preview.variant, widget.id),
        theme: preview.theme,
        width: widget.width,
        height: widget.height - WIDGET_TITLE_BAR,
        calendarCss: source.calendarCss,
        widgetCss: source.widgetCss,
      })
      writeFile(path.join(CACHE, innerName), innerHtml)
      innerFiles[widget.id] = innerName
    }
    const showcaseHtml = buildWidgetsShowcase({
      theme: preview.theme,
      innerFiles,
      widgets,
      calendarCss: source.calendarCss,
    })
    writeFile(path.join(CACHE, `${preview.name}.html`), showcaseHtml)
    showcasePages.push({
      preview,
      size: showcaseSize(widgets),
      htmlName: `${preview.name}.html`,
      pngName: `${preview.name}.png`,
    })
  }

  const chrome = findChrome()
  if (chrome === null) {
    process.stdout.write('\n没有找到 Chrome/Edge，跳过截图；预览 HTML 已生成在 dev/.cache/。\n')
    return
  }

  process.stdout.write('\n截图：\n')
  const results = []
  let failures = 0

  for (const preview of panels) {
    const htmlPath = path.join(CACHE, `${preview.name}.html`)
    const pngPath = path.join(CACHE, `${preview.name}.png`)
    const height =
      preview.height === undefined
        ? measureContentHeight(chrome, htmlPath, PANEL_WIDTH, FALLBACK_HEIGHTS[preview.name] || 1200)
        : preview.height
    const stat = screenshot(chrome, htmlPath, pngPath, PANEL_WIDTH, height)
    const done = stat !== null
    process.stdout.write(
      `  ${done ? '✓' : '✗'} ${pngPath}（${PANEL_WIDTH}×${height}${done ? `，${Math.round(stat.size / 1024)} KB` : ''}）\n`,
    )
    if (!done) failures += 1
    else results.push({ file: pngPath, size: stat.size, width: PANEL_WIDTH, height })
  }

  for (const showcase of showcasePages) {
    const htmlPath = path.join(CACHE, showcase.htmlName)
    const pngPath = path.join(CACHE, showcase.pngName)
    const { width, height } = showcase.size
    const stat = screenshot(chrome, htmlPath, pngPath, width, height)
    const done = stat !== null
    process.stdout.write(
      `  ${done ? '✓' : '✗'} ${pngPath}（${width}×${height}${done ? `，${Math.round(stat.size / 1024)} KB` : ''}）\n`,
    )
    if (!done) failures += 1
    else results.push({ file: pngPath, size: stat.size, width, height })
  }

  if (failures > 0) {
    process.stderr.write(`\n有 ${failures} 张截图失败（详见上面的 ✗）。\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`\n生成完成：${panels.length + showcasePages.length} 张截图。\n`)
  process.stdout.write('把需要的 PNG 拷到 docs/images/ 即可更新 README 配图。\n')
}

mainRun().catch((error) => {
  process.stderr.write(`页面预览生成失败：${String(error && error.stack ? error.stack : error)}\n`)
  process.exitCode = 1
})
