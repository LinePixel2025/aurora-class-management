'use strict'

/**
 * 页面型桌面小组件「今日事务」前端脚本。
 *
 * 页面运行在 Aurora 的页面沙箱里，只通过 window.auroraPlugin.request /
 * window.auroraPlugin.onEvent 与宿主通信；不访问网络、文件或浏览器持久化存储。
 *
 * 结构约定：
 * - load 单飞 + 序号丢弃：同一时间只有一个 load 在飞，过期响应不会覆盖新数据；
 * - 写动作（add-task / toggle-task / delete-task）成功后直接用返回的整份数据重绘，
 *   并递增 dataVersion，让动作之前发出的 load 结果自动作废；
 * - board.changed 事件只负责触发一次去抖（200ms）后的重新加载；
 * - 删除用页面内二次确认：第一次点「删除」进入「确认删除？」状态，4s 后自动复原；
 * - 所有用户内容一律通过 createElement / textContent / value 写入，不拼 HTML。
 */
;(function () {
  'use strict'

  const RELOAD_DEBOUNCE_MS = 200
  const STATUS_CLEAR_MS = 3000
  const DELETE_ARM_MS = 4000
  const SCHEDULE_LIMIT = 4
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
    statusFromLoad: false,
    actionInFlight: false,
    armingTaskId: '',
    armingButton: null,
    armingTimer: null,
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

  function focusElement(node) {
    if (node === null || node === undefined) return
    if (typeof node.focus !== 'function' || node.disabled === true) return
    try {
      node.focus()
    } catch (error) {
      // 输入框已从文档移除时浏览器可能拒绝聚焦，忽略即可。
    }
  }

  /** 从 YYYY-MM-DD 推周几（1=周一…7=周日），仅作 todayWeekday 缺失时的兜底。 */
  function weekdayOf(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedOf(dateKey))
    if (match === null) return 0
    const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    const day = new Date(stamp).getUTCDay()
    return day === 0 ? 7 : day
  }

  function dateLabelOf(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedOf(dateKey))
    if (match === null) return ''
    const weekday = weekdayOf(dateKey)
    const suffix = weekday >= 1 ? ' ' + WEEKDAY_NAMES[weekday - 1] : ''
    return Number(match[2]) + '/' + Number(match[3]) + suffix
  }

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

  function clearStatus() {
    showStatus('')
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
      state.statusFromLoad = false
      return
    }
    const nextKind = kind === 'error' ? 'error' : 'ok'
    status.textContent = text
    status.setAttribute('data-kind', nextKind)
    state.statusKind = nextKind
    state.statusFromLoad = false
    // 成功提示约 3s 后自动消失；错误提示保留到下一次动作或加载成功。
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
      return Promise.resolve({ error: '页面通信不可用，请重新打开今日事务' })
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
        if (loadId !== state.latestLoadId) return
        if (state.dataVersion !== versionAtStart) return

        const error = resultError(result)
        const loaded = validData(result.data) ? applyData(result.data) : false
        if (error !== '') {
          showStatus(error, 'error')
          // showStatus 会重置来源标记，这里补回：加载错误在下次加载成功后清除。
          state.statusFromLoad = true
        } else if (!loaded) {
          showStatus('未能加载今日事务，请稍后重试', 'error')
          state.statusFromLoad = true
        } else if (state.statusKind === 'error' && state.statusFromLoad === true) {
          clearStatus()
        }
      })
      .catch(function (error) {
        if (loadId !== state.latestLoadId) return
        showStatus('加载今日事务失败：' + messageOf(error), 'error')
        state.statusFromLoad = true
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
    if (!state.actionInFlight) setBusy(false)
  }

  function applyData(data, fromAction) {
    if (!validData(data)) return false
    state.data = data
    if (fromAction === true) state.dataVersion += 1
    renderAll(data)
    return true
  }

  // ───────────────────────── 写动作 ─────────────────────────

  /**
   * 执行一个写操作：成功时用返回的整份数据重绘并显示 message；失败时在状态条
   * 显示后端 error 并保留页面现有数据。动作期间禁止再发起第二个动作。
   */
  function runAction(method, params, fallbackMessage) {
    if (state.actionInFlight) return Promise.resolve({ error: '', skipped: true })
    state.actionInFlight = true
    setBusy(true)
    clearStatus()

    return request(method, params)
      .then(function (result) {
        const error = resultError(result)
        const message = resultMessage(result)
        const applied = validData(result.data) ? applyData(result.data, true) : false

        if (error !== '') {
          showStatus(error, 'error')
          if (!applied) requestLoadNow()
          return { error: error, applied: applied }
        }
        if (message !== '') showStatus(message, 'ok')
        else if (trimmedOf(fallbackMessage) !== '') showStatus(fallbackMessage, 'ok')
        if (!applied) requestLoadNow()
        return { error: '', applied: applied }
      })
      .catch(function (error) {
        const text = messageOf(error)
        showStatus(text, 'error')
        return { error: text, applied: false }
      })
      .then(function (outcome) {
        state.actionInFlight = false
        if (!state.loadInFlight) setBusy(false)
        return outcome
      })
  }

  function handleQuickSubmit(event) {
    if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    if (state.actionInFlight) return
    if (elements.quickInput === null || elements.quickInput === undefined) return

    const text = trimmedOf(elements.quickInput.value)
    if (text === '') {
      showStatus('先输入事务内容，再点添加', 'error')
      focusElement(elements.quickInput)
      return
    }

    const input = elements.quickInput
    runAction('add-task', { text: text }, '已添加事务').then(function (outcome) {
      if (outcome.error !== '') return
      // 仅在用户没有继续改动输入框时清空，避免吞掉刚输入的下一条。
      if (trimmedOf(input.value) === text) input.value = ''
      focusElement(input)
    })
  }

  function toggleTask(task) {
    if (state.actionInFlight) return
    disarmDelete()
    runAction('toggle-task', { id: task.id }, task.done ? '已恢复为待办' : '已完成')
  }

  function deleteTask(task) {
    if (state.actionInFlight) return
    runAction('delete-task', { id: task.id }, '已删除事务')
  }

  // ───────────────────────── 删除：页面内二次确认 ─────────────────────────

  function armDelete(button, task) {
    disarmDelete()
    state.armingTaskId = task.id
    state.armingButton = button
    button.classList.add('is-arming')
    button.textContent = '确认删除？'
    button.setAttribute('aria-label', '再次点击确认删除事务：' + (task.text === '' ? '这条事务' : task.text))
    state.armingTimer = window.setTimeout(function () {
      state.armingTimer = null
      disarmDelete()
    }, DELETE_ARM_MS)
  }

  function disarmDelete() {
    if (state.armingTimer !== null) {
      window.clearTimeout(state.armingTimer)
      state.armingTimer = null
    }
    const button = state.armingButton
    if (button !== null && button !== undefined && button.isConnected === true) {
      button.classList.remove('is-arming')
      button.textContent = '删除'
      button.setAttribute('aria-label', '删除事务')
    }
    state.armingTaskId = ''
    state.armingButton = null
  }

  function handleDeleteClick(button, task) {
    if (state.actionInFlight) return
    if (state.armingTaskId !== task.id) {
      armDelete(button, task)
      return
    }
    disarmDelete()
    deleteTask(task)
  }

  // ───────────────────────── 渲染 ─────────────────────────

  function renderAll(data) {
    disarmDelete()
    renderHead(data)
    renderTasks(data)
    renderRoutines(data)
    renderSchedule(data)
  }

  function renderHead(data) {
    const todayLabel = trimmedOf(data.todayLabel) || trimmedOf(data.taskDateLabel) || dateLabelOf(data.today)
    setText(elements.todayLabel, todayLabel)
    renderStats(data)
  }

  function readTasks(data) {
    const list = []
    if (Array.isArray(data.tasks)) {
      for (const item of data.tasks) {
        if (item !== null && typeof item === 'object') list.push(item)
      }
    }
    return list
  }

  function readCounts(data, tasks) {
    const raw = data.counts !== null && typeof data.counts === 'object' ? data.counts : {}
    let pending = 0
    let done = 0
    let overdue = 0
    for (const task of tasks) {
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
    const tasks = readTasks(data)
    const counts = readCounts(data, tasks)

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

  function taskMetaText(task) {
    const parts = []
    if (task.dueLabel !== '') {
      parts.push(task.done !== true && task.overdue === true ? '逾期 ' + task.dueLabel : task.dueLabel)
    }
    if (task.assignee !== '') parts.push('负责人 ' + task.assignee)
    return parts.join(' · ')
  }

  function normalizeTask(raw) {
    return {
      id: trimmedOf(raw.id),
      text: trimmedOf(raw.text),
      done: raw.done === true,
      priority: trimmedOf(raw.priority),
      dueLabel: trimmedOf(raw.dueLabel),
      overdue: raw.overdue === true,
      assignee: trimmedOf(raw.assignee),
    }
  }

  function buildTaskItem(rawTask) {
    const task = normalizeTask(rawTask)
    const item = document.createElement('li')
    item.className = 'cal-task wd-task'
    if (task.done) item.classList.add('is-done')
    if (task.id !== '') item.setAttribute('data-task-id', task.id)

    const toggle = document.createElement('button')
    toggle.className = 'cal-task-toggle'
    toggle.type = 'button'
    toggle.textContent = '✓'
    toggle.setAttribute('aria-pressed', task.done ? 'true' : 'false')
    toggle.setAttribute('aria-label', (task.done ? '恢复为待办：' : '标记完成：') + (task.text === '' ? '这条事务' : task.text))
    toggle.addEventListener('click', function () {
      toggleTask(task)
    })

    const main = document.createElement('div')
    main.className = 'wd-task-main'

    const line = document.createElement('div')
    line.className = 'wd-task-line'
    if (task.done !== true && task.priority === 'high') {
      const high = document.createElement('span')
      high.className = 'wd-high'
      high.textContent = '高'
      high.setAttribute('title', '高优先级')
      line.appendChild(high)
    }

    const text = document.createElement('span')
    text.className = 'cal-task-text wd-task-text'
    text.textContent = task.text === '' ? '（无内容）' : task.text
    line.appendChild(text)
    main.appendChild(line)

    const metaText = taskMetaText(task)
    if (metaText !== '') {
      const meta = document.createElement('span')
      meta.className = 'cal-task-meta wd-task-meta'
      meta.textContent = metaText
      if (task.done !== true && task.overdue === true) meta.classList.add('is-overdue')
      main.appendChild(meta)
    }

    const remove = document.createElement('button')
    remove.className = 'cal-task-edit wd-task-del'
    remove.type = 'button'
    remove.textContent = '删除'
    remove.setAttribute('aria-label', '删除事务：' + (task.text === '' ? '这条事务' : task.text))
    remove.addEventListener('click', function (event) {
      if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
        event.stopPropagation()
      }
      handleDeleteClick(remove, task)
    })

    item.appendChild(toggle)
    item.appendChild(main)
    item.appendChild(remove)
    return item
  }

  function renderTasks(data) {
    const rawTasks = readTasks(data)
    const pending = []
    const done = []
    for (const task of rawTasks) {
      if (task.done === true) done.push(task)
      else pending.push(task)
    }

    // 未完成事务
    const pendingList = elements.pendingList
    if (pendingList !== null && pendingList !== undefined) {
      clearChildren(pendingList)
      if (pending.length === 0) {
        const empty = document.createElement('li')
        empty.className = 'cal-empty wd-empty'
        if (rawTasks.length === 0) empty.textContent = '今天还没有事务，在上面快速加一条。'
        else if (done.length > 0) empty.textContent = '今天的待办清空了，已完成 ' + done.length + ' 条。'
        else empty.textContent = '今天还没有待办事务。'
        pendingList.appendChild(empty)
      } else {
        const fragment = document.createDocumentFragment()
        for (const task of pending) fragment.appendChild(buildTaskItem(task))
        pendingList.appendChild(fragment)
      }
    }
    setText(elements.pendingBadge, pending.length > 0 ? String(pending.length) : '')

    // 已完成事务：showCompleted 打开且确实有已完成项时才显示
    const showCompleted =
      data.showCompleted === true ||
      (data.settings !== null && typeof data.settings === 'object' && data.settings.showCompleted === true)
    const doneSection = elements.doneSection
    const doneList = elements.doneList
    const visible = showCompleted && done.length > 0
    if (doneSection !== null && doneSection !== undefined) doneSection.hidden = !visible
    setText(elements.doneBadge, visible ? String(done.length) : '')
    if (doneList !== null && doneList !== undefined) {
      clearChildren(doneList)
      if (visible) {
        const fragment = document.createDocumentFragment()
        for (const task of done) fragment.appendChild(buildTaskItem(task))
        doneList.appendChild(fragment)
      }
    }
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
    for (const routine of routines) {
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
      list.appendChild(item)
    }
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
    return entries
  }

  /**
   * 小组件空间有限：今天的安排排最前，其次未来几天，最后才是本周已过去的几天，
   * 同组内按周几、时间升序，保证“最多 4 条”里优先出现还能做的安排。
   */
  function orderSchedule(entries, todayWeekday) {
    function rank(weekday) {
      if (todayWeekday < 1) return 0
      if (weekday === todayWeekday) return 0
      if (weekday > todayWeekday) return 1
      return 2
    }
    const indexed = entries.map(function (entry, index) {
      return { entry: entry, index: index }
    })
    indexed.sort(function (left, right) {
      const rankLeft = rank(left.entry.weekday)
      const rankRight = rank(right.entry.weekday)
      if (rankLeft !== rankRight) return rankLeft - rankRight
      if (left.entry.weekday !== right.entry.weekday) return left.entry.weekday - right.entry.weekday
      if (left.entry.time !== right.entry.time) return left.entry.time < right.entry.time ? -1 : 1
      return left.index - right.index
    })
    return indexed.map(function (item) {
      return item.entry
    })
  }

  function buildScheduleRow(entry, todayWeekday) {
    const item = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'cal-schedule-row wd-sched-row'

    const isToday = todayWeekday >= 1 && entry.weekday === todayWeekday
    if (isToday) row.classList.add('is-today')
    else if (todayWeekday >= 1 && entry.weekday < todayWeekday) row.classList.add('is-past')

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
    const entries = orderSchedule(readSchedule(data), todayWeekday)
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

  // ───────────────────────── 启动与清理 ─────────────────────────

  function cacheElements() {
    elements.app = document.getElementById('tasks-app')
    elements.status = document.getElementById('status')
    elements.todayLabel = document.getElementById('today-label')
    elements.pendingCount = document.getElementById('pending-count')
    elements.doneCount = document.getElementById('done-count')
    elements.overdueChip = document.getElementById('overdue-chip')
    elements.overdueCount = document.getElementById('overdue-count')
    elements.completionLabel = document.getElementById('completion-label')
    elements.progress = document.getElementById('progress')
    elements.progressFill = document.getElementById('progress-fill')
    elements.quickForm = document.getElementById('quick-form')
    elements.quickInput = document.getElementById('quick-input')
    elements.pendingBadge = document.getElementById('pending-badge')
    elements.pendingList = document.getElementById('pending-list')
    elements.doneSection = document.getElementById('done-section')
    elements.doneBadge = document.getElementById('done-badge')
    elements.doneList = document.getElementById('done-list')
    elements.scheduleList = document.getElementById('schedule-list')
    elements.scheduleMore = document.getElementById('schedule-more')
    elements.routineSection = document.getElementById('routine-section')
    elements.routineList = document.getElementById('routine-list')
  }

  function bindEvents() {
    if (elements.quickForm !== null && elements.quickForm !== undefined) {
      elements.quickForm.addEventListener('submit', handleQuickSubmit)
    }

    // 点到删除按钮以外的地方、或按 Esc 时，取消“确认删除？”状态。
    document.addEventListener('pointerdown', function (event) {
      if (state.armingTaskId === '') return
      const target = event !== null && event !== undefined ? event.target : null
      if (target !== null && typeof target.closest === 'function' && target.closest('.wd-task-del') !== null) {
        return
      }
      disarmDelete()
    })

    document.addEventListener('keydown', function (event) {
      if (state.armingTaskId === '' || event === null || event === undefined) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      disarmDelete()
    })
  }

  function cleanup() {
    cancelReloadTimer()
    disarmDelete()
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
    bindEvents()
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
