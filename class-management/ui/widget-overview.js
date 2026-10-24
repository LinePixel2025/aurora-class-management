'use strict'

/**
 * 页面型桌面小组件「班级速览」前端脚本。
 *
 * 页面运行在 Aurora 的页面沙箱里，只通过 window.auroraPlugin.request /
 * window.auroraPlugin.onEvent 与宿主通信；不访问网络、文件或浏览器持久化存储。
 *
 * 结构约定：
 * - load 单飞 + 序号丢弃：同一时间只有一个 load 在飞，过期响应不会覆盖新数据；
 * - board.changed 事件只负责触发一次去抖（200ms）后的重新加载；
 * - 所有用户内容一律通过 createElement / textContent 写入，不拼 HTML 字符串；
 * - 只读页面：不提供任何写操作。
 */
;(function () {
  'use strict'

  const RELOAD_DEBOUNCE_MS = 200
  const STATUS_CLEAR_MS = 3000
  const SCHEDULE_LIMIT = 3
  const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

  const elements = {}
  const state = {
    booted: false,
    data: null,
    dataVersion: 0,
    latestLoadId: 0,
    loadInFlight: false,
    loadQueued: false,
    reloadTimer: null,
    statusTimer: null,
    statusKind: '',
    unsubscribe: null,
  }

  // ───────────────────────── 小工具 ─────────────────────────

  function textOf(value) {
    if (value === undefined || value === null) return ''
    return String(value)
  }

  function trimmedOf(value) {
    return textOf(value).trim()
  }

  function countOf(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.max(0, Math.trunc(number))
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function messageOf(error) {
    if (error instanceof Error && trimmedOf(error.message) !== '') return error.message
    if (typeof error === 'string' && error.trim() !== '') return error
    if (error !== undefined && error !== null) {
      const text = textOf(error).trim()
      if (text !== '') return text
    }
    return '操作失败，请重试'
  }

  function resultError(result) {
    if (result === null || typeof result !== 'object') return ''
    if (result.error === undefined || result.error === null) return ''
    return textOf(result.error).trim()
  }

  function resultMessage(result) {
    if (result === null || typeof result !== 'object') return ''
    if (result.message === undefined || result.message === null) return ''
    return textOf(result.message).trim()
  }

  function validData(data) {
    return data !== null && typeof data === 'object' && !Array.isArray(data)
  }

  function clearChildren(node) {
    if (node === null || node === undefined) return
    while (node.firstChild !== null) node.removeChild(node.firstChild)
  }

  function setText(node, value) {
    if (node === null || node === undefined) return
    node.textContent = textOf(value)
  }

  /** 从 YYYY-MM-DD 推周几（1=周一…7=周日），仅作 todayWeekday 缺失时的兜底。 */
  function weekdayOf(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedOf(dateKey))
    if (match === null) return 0
    const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    const day = new Date(stamp).getUTCDay()
    return day === 0 ? 7 : day
  }

  /** todayLabel 缺失时用 today 拼出「10/24 周六」。 */
  function dateLabelOf(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedOf(dateKey))
    if (match === null) return ''
    const weekday = weekdayOf(dateKey)
    const suffix = weekday >= 1 ? ' ' + WEEKDAY_NAMES[weekday - 1] : ''
    return Number(match[2]) + '/' + Number(match[3]) + suffix
  }

  /** todayWeekday 优先（宿主直接给出），缺失时按 today 推算。 */
  function todayWeekdayOf(data) {
    const weekday = countOf(data.todayWeekday)
    if (weekday >= 1 && weekday <= 7) return weekday
    return weekdayOf(data.today)
  }

  function setBusy(busy) {
    const app = elements.app
    if (app === null || app === undefined) return
    if (busy) app.setAttribute('aria-busy', 'true')
    else app.removeAttribute('aria-busy')
  }

  function showStatus(message, kind) {
    const status = elements.status
    if (status === null || status === undefined) return
    const text = trimmedOf(message)
    if (state.statusTimer !== null) {
      window.clearTimeout(state.statusTimer)
      state.statusTimer = null
    }
    if (text === '') {
      status.textContent = ''
      status.removeAttribute('data-kind')
      state.statusKind = ''
      return
    }
    const nextKind = kind === 'error' ? 'error' : 'ok'
    status.textContent = text
    status.setAttribute('data-kind', nextKind)
    state.statusKind = nextKind
    // 只读页面：错误提示留在状态条里，下一次加载成功后清除；成功提示 3s 自动消失。
    if (nextKind !== 'error') {
      state.statusTimer = window.setTimeout(function () {
        state.statusTimer = null
        if (status.textContent === text) {
          status.textContent = ''
          status.removeAttribute('data-kind')
          state.statusKind = ''
        }
      }, STATUS_CLEAR_MS)
    }
  }

  // ───────────────────────── 宿主通信 ─────────────────────────

  /**
   * 统一调用宿主 request：同步异常、Promise reject、空结果都转换成 `{ error }`，
   * 避免把错误漏到控制台。
   */
  function request(method, params) {
    if (!window.auroraPlugin || typeof window.auroraPlugin.request !== 'function') {
      return Promise.resolve({ error: '页面通信不可用，请重新打开班级速览' })
    }
    let pending
    try {
      pending = window.auroraPlugin.request(method, params)
    } catch (error) {
      return Promise.resolve({ error: messageOf(error) })
    }
    return Promise.resolve(pending).then(
      function (result) {
        if (result === null || typeof result !== 'object') {
          return { error: '页面返回了无效结果，请重试' }
        }
        return result
      },
      function (error) {
        return { error: messageOf(error) }
      },
    )
  }

  function subscribeBoardEvents() {
    if (!window.auroraPlugin || typeof window.auroraPlugin.onEvent !== 'function') {
      showStatus('页面事件订阅不可用，数据可能不会自动刷新', 'error')
      return
    }
    try {
      // 宿主 preload 的签名是 onEvent(listener(event, payload))，返回取消函数。
      const unsubscribe = window.auroraPlugin.onEvent(function (event) {
        if (event === 'board.changed') scheduleReload()
      })
      if (typeof unsubscribe === 'function') state.unsubscribe = unsubscribe
    } catch (error) {
      showStatus('订阅页面事件失败：' + messageOf(error), 'error')
    }
  }

  // ───────────────────────── 加载（单飞 + 序号丢弃） ─────────────────────────

  function cancelReloadTimer() {
    if (state.reloadTimer === null) return
    window.clearTimeout(state.reloadTimer)
    state.reloadTimer = null
  }

  function scheduleReload() {
    cancelReloadTimer()
    state.reloadTimer = window.setTimeout(function () {
      state.reloadTimer = null
      requestLoadNow()
    }, RELOAD_DEBOUNCE_MS)
  }

  /** 发起一次加载；已有 load 在飞时只记录“还欠一次”，保证串行。 */
  function requestLoadNow() {
    state.latestLoadId += 1
    if (state.loadInFlight) {
      state.loadQueued = true
      return
    }
    startLoad(state.latestLoadId)
  }

  function startLoad(loadId) {
    state.loadInFlight = true
    setBusy(true)
    const versionAtStart = state.dataVersion

    request('load', {})
      .then(function (result) {
        // 请求期间有更新的加载发起，或有动作数据落地：这份结果已经过期。
        if (loadId !== state.latestLoadId) return
        if (state.dataVersion !== versionAtStart) return

        const error = resultError(result)
        const loaded = validData(result.data) ? applyData(result.data) : false
        if (error !== '') {
          showStatus(error, 'error')
        } else if (!loaded) {
          showStatus('未能加载班级速览，请稍后重试', 'error')
        } else if (state.statusKind === 'error') {
          showStatus('')
        }
      })
      .catch(function (error) {
        if (loadId !== state.latestLoadId) return
        showStatus('加载班级速览失败：' + messageOf(error), 'error')
      })
      .then(finishLoad)
  }

  function finishLoad() {
    state.loadInFlight = false
    if (state.loadQueued) {
      state.loadQueued = false
      requestLoadNow()
      return
    }
    setBusy(false)
  }

  function applyData(data) {
    if (!validData(data)) return false
    state.data = data
    renderAll(data)
    return true
  }

  // ───────────────────────── 渲染 ─────────────────────────

  function renderAll(data) {
    renderHead(data)
    renderDuty(data)
    renderRoutines(data)
    renderSchedule(data)
    renderAnnouncement(data)
  }

  function renderHead(data) {
    setText(elements.className, trimmedOf(data.className) || '我的班级')

    const weekLabel = trimmedOf(data.weekLabel)
    const weekNumber = countOf(data.weekNumber)
    setText(elements.weekLabel, weekLabel !== '' ? weekLabel : weekNumber > 0 ? '第 ' + weekNumber + ' 周' : '')

    const teacher = trimmedOf(data.teacher)
    setText(elements.teacher, teacher === '' ? '' : '班主任 ' + teacher)

    renderStats(data)
  }

  function readCounts(data) {
    const raw = data.counts !== null && typeof data.counts === 'object' ? data.counts : {}
    const tasks = Array.isArray(data.tasks) ? data.tasks : []
    let done = 0
    let pending = 0
    let overdue = 0
    for (const task of tasks) {
      if (task === null || typeof task !== 'object') continue
      if (task.done === true) done += 1
      else {
        pending += 1
        if (task.overdue === true) overdue += 1
      }
    }
    return {
      total: raw.total === undefined ? tasks.length : countOf(raw.total),
      pending: raw.pending === undefined ? pending : countOf(raw.pending),
      done: raw.done === undefined ? done : countOf(raw.done),
      overdue: raw.overdue === undefined ? overdue : countOf(raw.overdue),
    }
  }

  function completionOf(data, counts) {
    const raw = Number(data.completion)
    if (Number.isFinite(raw)) return clamp(Math.round(raw), 0, 100)
    if (counts.total <= 0) return 0
    return clamp(Math.round((counts.done / counts.total) * 100), 0, 100)
  }

  function renderStats(data) {
    const counts = readCounts(data)

    setText(elements.pendingCount, String(counts.pending))
    if (elements.pendingCount !== null) {
      elements.pendingCount.classList.toggle('is-zero', counts.pending === 0)
    }
    setText(elements.doneCount, String(counts.done))
    if (elements.doneCount !== null) {
      elements.doneCount.classList.toggle('is-zero', counts.done === 0)
    }

    if (elements.overdueChip !== null && elements.overdueChip !== undefined) {
      const show = counts.overdue > 0
      elements.overdueChip.hidden = !show
      if (show) setText(elements.overdueCount, String(counts.overdue))
    }

    const completion = completionOf(data, counts)
    setText(elements.completionLabel, completion + '%')
    if (elements.progressFill !== null && elements.progressFill !== undefined) {
      elements.progressFill.style.width = completion + '%'
      elements.progressFill.classList.toggle('is-complete', completion >= 100)
    }
    if (elements.progress !== null && elements.progress !== undefined) {
      elements.progress.setAttribute('aria-valuenow', String(completion))
    }
  }

  function renderDuty(data) {
    const raw = data.duty !== null && typeof data.duty === 'object' ? data.duty : {}
    const groupName = trimmedOf(raw.groupName)
    const members = Array.isArray(raw.members)
      ? raw.members
          .map(function (member) {
            return trimmedOf(member)
          })
          .filter(function (member) {
            return member !== ''
          })
      : []
    const weekNumber = countOf(data.weekNumber)
    const weekTitle = (raw.isCurrentWeek === true ? '本周值日' : '该周值日') + (weekNumber > 0 ? ' · 第 ' + weekNumber + ' 周' : '')
    setText(elements.dutyTitle, weekTitle)

    if (elements.dutyGroup !== null && elements.dutyGroup !== undefined) {
      elements.dutyGroup.textContent = groupName === '' ? '待安排' : groupName
      elements.dutyGroup.classList.toggle('is-empty', groupName === '')
    }

    const override = raw.hasOverrideGroup === true
    if (elements.dutyFlag !== null && elements.dutyFlag !== undefined) {
      elements.dutyFlag.textContent = override === true ? '本周指定' : '按周轮换'
      elements.dutyFlag.classList.toggle('is-override', override === true)
    }

    if (elements.dutyMembers !== null && elements.dutyMembers !== undefined) {
      clearChildren(elements.dutyMembers)
      for (const member of members) {
        const chip = document.createElement('span')
        chip.className = 'wd-duty-person'
        chip.textContent = member
        elements.dutyMembers.appendChild(chip)
      }
      elements.dutyMembers.setAttribute('title', members.join('、'))
    }
    setText(elements.dutyNote, trimmedOf(raw.note))
  }

  function renderRoutines(data) {
    const section = elements.routineSection
    if (section === null || section === undefined) return
    const source = Array.isArray(data.routines) ? data.routines : []
    const routines = []
    for (const item of source) {
      if (item === null || typeof item !== 'object') continue
      const title = trimmedOf(item.title)
      if (title === '') continue
      routines.push({ time: trimmedOf(item.time), title: title, place: trimmedOf(item.place) })
    }
    section.hidden = routines.length === 0
    const list = elements.routineList
    if (list === null || list === undefined) return
    clearChildren(list)
    for (const routine of routines) list.appendChild(buildRoutineRow(routine))
  }

  function buildRoutineRow(routine) {
    const item = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'wd-routine'
    const time = document.createElement('span')
    time.className = 'wd-routine-time'
    time.textContent = routine.time === '' ? '例行' : routine.time
    row.appendChild(time)
    const title = document.createElement('span')
    title.className = 'wd-routine-title'
    title.textContent = routine.title
    row.appendChild(title)
    if (routine.place !== '') {
      const place = document.createElement('span')
      place.className = 'wd-routine-place'
      place.textContent = routine.place
      row.appendChild(place)
    }
    item.appendChild(row)
    return item
  }

  function readSchedule(data) {
    const source = Array.isArray(data.schedule) ? data.schedule : []
    const entries = []
    for (const item of source) {
      if (item === null || typeof item !== 'object') continue
      const weekday = countOf(item.weekday)
      if (weekday < 1 || weekday > 7) continue
      entries.push({
        weekday: weekday,
        time: trimmedOf(item.time),
        title: trimmedOf(item.title),
        place: trimmedOf(item.place),
        remind: item.remind === true,
        remindLead: typeof item.remindLead === 'number' && Number.isFinite(item.remindLead) ? Math.trunc(item.remindLead) : null,
      })
    }
    // 后端已按周几/时间排好序，这里再兜底排一次，保证“前 3 项”稳定。
    entries.sort(function (left, right) {
      if (left.weekday !== right.weekday) return left.weekday - right.weekday
      if (left.time === right.time) return 0
      return left.time < right.time ? -1 : 1
    })
    return entries
  }

  function buildScheduleRow(entry, todayWeekday) {
    const item = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'cal-schedule-row wd-sched-row'

    const isToday = todayWeekday >= 1 && entry.weekday === todayWeekday
    if (isToday) row.classList.add('is-today')

    const when = document.createElement('span')
    when.className = 'cal-schedule-time'
    const weekday = WEEKDAY_NAMES[entry.weekday - 1]
    when.textContent = entry.time === '' ? weekday : weekday + ' ' + entry.time

    row.appendChild(when)

    if (isToday) {
      const tag = document.createElement('span')
      tag.className = 'wd-today-tag'
      tag.textContent = '今天'
      row.appendChild(tag)
    }

    const title = document.createElement('span')
    title.className = 'cal-schedule-title'
    title.textContent = entry.title === '' ? '（未命名安排）' : entry.title
    row.appendChild(title)

    if (entry.place !== '') {
      const place = document.createElement('span')
      place.className = 'cal-schedule-place'
      place.textContent = entry.place
      row.appendChild(place)
    }

    if (entry.remind === true) {
      const remind = document.createElement('span')
      remind.className = 'wd-remind'
      remind.textContent = entry.remindLead === null ? '到点前提醒' : '提前 ' + entry.remindLead + ' 分钟'
      row.appendChild(remind)
    }

    item.appendChild(row)
    return item
  }

  function renderSchedule(data) {
    const list = elements.scheduleList
    if (list === null || list === undefined) return
    const todayWeekday = todayWeekdayOf(data)
    const entries = readSchedule(data)
    const shown = entries.slice(0, SCHEDULE_LIMIT)

    clearChildren(list)
    if (shown.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'cal-empty wd-empty'
      empty.textContent = '本周暂无安排。'
      list.appendChild(empty)
    } else {
      const fragment = document.createDocumentFragment()
      for (const entry of shown) fragment.appendChild(buildScheduleRow(entry, todayWeekday))
      list.appendChild(fragment)
    }

    const rest = entries.length - shown.length
    if (elements.scheduleMore !== null && elements.scheduleMore !== undefined) {
      if (rest > 0) {
        elements.scheduleMore.hidden = false
        elements.scheduleMore.textContent = '还有 ' + rest + ' 项安排'
      } else {
        elements.scheduleMore.hidden = true
        elements.scheduleMore.textContent = ''
      }
    }
  }

  function renderAnnouncement(data) {
    const node = elements.announcement
    if (node === null || node === undefined) return
    const announcement = trimmedOf(data.announcement)
    node.classList.toggle('is-empty', announcement === '')
    node.textContent = announcement === '' ? '本周暂无通知' : announcement
    if (announcement !== '') node.setAttribute('title', announcement)
    else node.removeAttribute('title')
  }

  // ───────────────────────── 启动与清理 ─────────────────────────

  function cacheElements() {
    elements.app = document.getElementById('overview-app')
    elements.className = document.getElementById('class-name')
    elements.weekLabel = document.getElementById('week-label')
    elements.teacher = document.getElementById('teacher')
    elements.pendingCount = document.getElementById('pending-count')
    elements.doneCount = document.getElementById('done-count')
    elements.overdueChip = document.getElementById('overdue-chip')
    elements.overdueCount = document.getElementById('overdue-count')
    elements.completionLabel = document.getElementById('completion-label')
    elements.progress = document.getElementById('progress')
    elements.progressFill = document.getElementById('progress-fill')
    elements.dutyTitle = document.getElementById('duty-title')
    elements.dutyGroup = document.getElementById('duty-group')
    elements.dutyFlag = document.getElementById('duty-flag')
    elements.dutyMembers = document.getElementById('duty-members')
    elements.dutyNote = document.getElementById('duty-note')
    elements.routineSection = document.getElementById('routine-section')
    elements.routineList = document.getElementById('routine-list')
    elements.scheduleList = document.getElementById('schedule-list')
    elements.scheduleMore = document.getElementById('schedule-more')
    elements.announcement = document.getElementById('announcement')
    elements.status = document.getElementById('status')
  }

  function cleanup() {
    cancelReloadTimer()
    if (state.statusTimer !== null) {
      window.clearTimeout(state.statusTimer)
      state.statusTimer = null
    }
    if (typeof state.unsubscribe === 'function') {
      try {
        state.unsubscribe()
      } catch (error) {
        void error
      }
      state.unsubscribe = null
    }
  }

  function boot() {
    if (state.booted) return
    state.booted = true
    cacheElements()
    subscribeBoardEvents()
    window.addEventListener('pagehide', cleanup)
    requestLoadNow()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
