'use strict'

/**
 * 页面型「班级事务台」前端脚本（v2.1.0）。
 *
 * 页面运行在 Aurora 的页面沙箱里，只使用 window.auroraPlugin.request 与
 * window.auroraPlugin.onEvent；不访问宿主其它对象，也不使用网络、存储或外链。
 *
 * 结构约定：
 * - 后端每个写动作都返回整份 BoardPageData，动作成功后直接 applyData 重绘；
 * - load 做单飞 + 序号丢弃，旧响应不会覆盖新视图；
 * - 切视图 / 切周先 save-view 持久化（后端返回全量 data），失败再回落 load；
 * - board.changed 事件只触发一次 200ms 去抖后的重新加载；
 * - 所有用户内容都通过 createElement / textContent / value 写入，不拼 HTML。
 */
;(function () {
  'use strict'

  const VIEWS = ['board', 'duty', 'schedule', 'settings']
  const WEEK_VIEWS = ['duty', 'schedule']
  const MIN_WEEK_OFFSET = -12
  const MAX_WEEK_OFFSET = 12
  const RELOAD_DEBOUNCE_MS = 200
  const STATUS_OK_MS = 3000
  const STATUS_ERROR_MS = 5000
  const PREVIEW_SCHEDULE_LIMIT = 5

  const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const PRIORITY_VALUES = ['high', 'normal', 'low']
  const PRIORITY_LABELS = { high: '高优先级', normal: '', low: '低优先级' }
  const CATEGORY_VALUES = ['作业', '活动', '通知', '事务', '其他']
  const CLEAR_SCOPE_LABELS = {
    tasks: '今日事务',
    schedule: '本周安排',
    duty: '本周值日设置',
    all: '今日事务 + 本周安排/值日/通知',
  }

  const elements = {}
  const state = {
    booted: false,
    view: 'board',
    weekOffset: 0,
    data: null,
    dataVersion: 0,
    latestLoadId: 0,
    loadInFlight: false,
    loadQueued: false,
    navSeq: 0,
    busyCount: 0,
    reloadTimer: null,
    statusTimer: null,
    focusReturn: null,
    taskEditorId: '',
    scheduleEditorId: '',
    confirm: null,
    confirmReturn: null,
    confirmBusy: false,
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

  function clampOffset(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.min(MAX_WEEK_OFFSET, Math.max(MIN_WEEK_OFFSET, Math.trunc(number)))
  }

  function objectOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  function asArray(value) {
    return Array.isArray(value) ? value : []
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

  /** BoardPageData 的最小形状校验：宁可拒绝半截数据，也不渲染出错乱的页面。 */
  function validData(data) {
    return (
      data !== null &&
      typeof data === 'object' &&
      Array.isArray(data.tasks) &&
      Array.isArray(data.schedule) &&
      Array.isArray(data.groups)
    )
  }

  function isEditable() {
    return validData(state.data) && state.data.canEdit !== false
  }

  function effectiveWeekOffset() {
    return WEEK_VIEWS.includes(state.view) ? state.weekOffset : 0
  }

  function clearChildren(node) {
    if (node === null || node === undefined) return
    while (node.firstChild !== null) node.removeChild(node.firstChild)
  }

  function focusElement(node) {
    if (node === null || node === undefined) return
    if (typeof node.focus !== 'function' || node.disabled === true) return
    try {
      node.focus()
    } catch (error) {
      // 节点已离开文档时浏览器可能拒绝聚焦，忽略即可。
    }
  }

  function setText(node, value) {
    if (node === null || node === undefined) return
    node.textContent = textOf(value)
  }

  function setValue(node, value) {
    if (node === null || node === undefined) return
    node.value = value === undefined || value === null ? '' : String(value)
  }

  function setInlineError(node, message) {
    if (node === null || node === undefined) return
    node.textContent = message === undefined || message === null ? '' : String(message)
    node.hidden = node.textContent === ''
  }

  function setDisabled(nodes, disabled) {
    for (const node of asArray(nodes)) {
      if (node !== null && node !== undefined) node.disabled = disabled === true
    }
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
      return
    }
    status.textContent = text
    status.setAttribute('data-kind', kind === 'error' ? 'error' : 'ok')
    state.statusTimer = window.setTimeout(
      function () {
        state.statusTimer = null
        if (status.textContent !== text) return
        status.textContent = ''
        status.removeAttribute('data-kind')
      },
      kind === 'error' ? STATUS_ERROR_MS : STATUS_OK_MS,
    )
  }

  function setAppBusy(busy) {
    if (elements.app === null || elements.app === undefined) return
    if (busy) elements.app.setAttribute('aria-busy', 'true')
    else elements.app.removeAttribute('aria-busy')
  }

  function beginBusy() {
    state.busyCount += 1
    setAppBusy(true)
  }

  function endBusy() {
    state.busyCount = Math.max(0, state.busyCount - 1)
    if (state.busyCount === 0) setAppBusy(false)
  }

  function clipText(value, max) {
    const text = textOf(value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return text.length > max ? text.slice(0, max) : text
  }

  function weekdayOfDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(textOf(date).trim())
    if (match === null) return 0
    const value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
    if (Number.isNaN(value.getTime())) return 0
    return ((value.getDay() + 6) % 7) + 1
  }

  function isModalOpen(modal) {
    return modal !== null && modal !== undefined && modal.hidden === false
  }

  // ───────────────────────── 宿主通信 ─────────────────────────

  /**
   * 统一调用宿主 request：同步异常、Promise reject、空结果都归一成 `{ error }`，
   * 页面其它分支只需要读 result.error / result.data。
   */
  function request(method, params) {
    if (!window.auroraPlugin || typeof window.auroraPlugin.request !== 'function') {
      return Promise.resolve({ error: '页面通信不可用，请重新打开班级事务台' })
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
      // 宿主页面 preload 的签名是 onEvent(listener(event, payload))，返回取消函数。
      const unsubscribe = window.auroraPlugin.onEvent(function (event) {
        if (event === 'board.changed') scheduleReload()
      })
      if (typeof unsubscribe === 'function') {
        state.unsubscribe = unsubscribe
        window.addEventListener('pagehide', function () {
          try {
            unsubscribe()
          } catch (error) {
            void error
          }
        })
      }
    } catch (error) {
      showStatus('订阅页面事件失败：' + messageOf(error), 'error')
    }
  }

  // ───────────────────────── 加载 / 切换 ─────────────────────────

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

  /** 发起一次加载；已有 load 在飞时只记录「还欠一次」，保证串行。 */
  function requestLoadNow() {
    state.latestLoadId += 1
    const loadId = state.latestLoadId
    if (state.loadInFlight) {
      state.loadQueued = true
      return
    }
    startLoad(loadId)
  }

  function startLoad(loadId) {
    state.loadInFlight = true
    beginBusy()
    const viewAtStart = state.view
    const offsetAtStart = state.weekOffset
    const versionAtStart = state.dataVersion

    // 首次加载不带 view / weekOffset：让后端沿用 ui.v1 里保存的上次视图与周；
    // 之后的加载显式带上当前状态，保证事件刷新与页面一致。
    const params = {}
    if (state.data !== null) {
      params.view = viewAtStart
      if (WEEK_VIEWS.includes(viewAtStart)) params.weekOffset = offsetAtStart
    }

    request('load', params)
      .then(function (result) {
        // 请求期间用户切了视图 / 周，或有新动作数据落地：这份结果已经过期。
        if (loadId !== state.latestLoadId) return
        if (state.view !== viewAtStart) return
        if (state.weekOffset !== offsetAtStart) return
        if (state.dataVersion !== versionAtStart) return

        const error = resultError(result)
        const loaded = validData(result.data) ? applyData(result.data, false) : false
        if (error !== '') showStatus(error, 'error')
        else if (resultMessage(result) !== '') showStatus(resultMessage(result), 'ok')
        else if (!loaded) showStatus('未能加载班级事务数据，请重试', 'error')
      })
      .catch(function (error) {
        if (loadId !== state.latestLoadId) return
        if (state.view !== viewAtStart || state.weekOffset !== offsetAtStart) return
        if (state.dataVersion !== versionAtStart) return
        showStatus('加载班级事务失败：' + messageOf(error), 'error')
      })
      .then(finishLoad)
  }

  function finishLoad() {
    state.loadInFlight = false
    endBusy()
    if (state.loadQueued) {
      state.loadQueued = false
      requestLoadNow()
    }
  }

  function applyData(data, fromAction) {
    if (!validData(data)) return false
    if (VIEWS.includes(data.view)) state.view = data.view
    if (Number.isFinite(Number(data.weekOffset))) state.weekOffset = clampOffset(data.weekOffset)
    state.data = data
    if (fromAction) state.dataVersion += 1
    render()
    return true
  }

  /**
   * 切视图 / 切周：先把 ui 状态写回后端（save-view），成功后用返回的全量 data 重绘；
   * 后端没有返回 data 或请求失败时回落一次 load。
   */
  function persistNavigation() {
    state.navSeq += 1
    const navId = state.navSeq
    const payload = {
      view: state.view,
      weekOffset: WEEK_VIEWS.includes(state.view) ? state.weekOffset : 0,
    }
    beginBusy()
    request('save-view', payload)
      .then(function (result) {
        if (navId !== state.navSeq) return
        const error = resultError(result)
        if (error !== '') {
          showStatus(error, 'error')
          requestLoadNow()
          return
        }
        const applied = validData(result.data) ? applyData(result.data, true) : false
        if (!applied) requestLoadNow()
      })
      .catch(function (error) {
        if (navId !== state.navSeq) return
        showStatus(messageOf(error), 'error')
        requestLoadNow()
      })
      .then(function () {
        if (navId === state.navSeq) endBusy()
      })
  }

  function goToView(nextView) {
    if (!VIEWS.includes(nextView)) return
    if (nextView === state.view) {
      cancelReloadTimer()
      requestLoadNow()
      return
    }
    cancelReloadTimer()
    closeAllModals(false)
    state.view = nextView
    if (!WEEK_VIEWS.includes(nextView)) state.weekOffset = 0
    renderHeader(state.data)
    persistNavigation()
  }

  function goToWeek(delta) {
    if (!WEEK_VIEWS.includes(state.view)) return
    const next = clampOffset(state.weekOffset + delta)
    if (next === state.weekOffset) return
    cancelReloadTimer()
    closeAllModals(false)
    state.weekOffset = next
    renderHeader(state.data)
    persistNavigation()
  }

  function goToThisWeek() {
    if (!WEEK_VIEWS.includes(state.view)) return
    if (state.weekOffset === 0) {
      cancelReloadTimer()
      requestLoadNow()
      return
    }
    cancelReloadTimer()
    closeAllModals(false)
    state.weekOffset = 0
    renderHeader(state.data)
    persistNavigation()
  }

  // ───────────────────────── 写动作 ─────────────────────────

  /**
   * 执行一个写动作：
   * - 请求期间禁用相关按钮；
   * - 响应到达时只有「视图 + 周」都没变才 applyData，避免旧响应覆盖新视图；
   * - 成功显示 message、失败显示 error；没有 data 时回填 load。
   */
  function runAction(method, params, options) {
    const opts = objectOf(options)
    const viewAtStart = state.view
    const offsetAtStart = state.weekOffset
    if (opts.errorTarget !== undefined) setInlineError(opts.errorTarget, '')

    const buttons = asArray(opts.buttons).filter(function (button) {
      return button !== null && button !== undefined
    })
    const previousDisabled = buttons.map(function (button) {
      return button.disabled === true
    })
    setDisabled(buttons, true)

    const requestParams = params !== null && typeof params === 'object' ? Object.assign({}, params) : {}

    return request(method, requestParams)
      .then(function (result) {
        const error = resultError(result)
        const message = resultMessage(result)
        const sameContext = state.view === viewAtStart && state.weekOffset === offsetAtStart
        const allowed =
          sameContext && (typeof opts.shouldApply === 'function' ? opts.shouldApply() !== false : true)
        let applied = false

        if (allowed && validData(result.data)) applied = applyData(result.data, true)

        if (error !== '') {
          setInlineError(opts.errorTarget, error)
          showStatus(error, 'error')
          if (opts.reloadOnError === true) requestLoadNow()
          if (typeof opts.onError === 'function') opts.onError(error, result)
        } else {
          if (message !== '') showStatus(message, 'ok')
          if (!applied && allowed) requestLoadNow()
          if (typeof opts.onSuccess === 'function') opts.onSuccess(result, applied)
        }

        return { error, message, applied, data: validData(result.data) ? result.data : null }
      })
      .catch(function (error) {
        const text = messageOf(error)
        setInlineError(opts.errorTarget, text)
        showStatus(text, 'error')
        if (opts.reloadOnError === true) requestLoadNow()
        if (typeof opts.onError === 'function') opts.onError(text, null)
        return { error: text, message: '', applied: false, data: null }
      })
      .then(function (outcome) {
        // 数据重绘后旧按钮已离开文档，只恢复仍在文档里的按钮。
        buttons.forEach(function (button, index) {
          if (!button.isConnected) return
          button.disabled = previousDisabled[index] === true
        })
        return outcome
      })
  }

  // ───────────────────────── 渲染：页头 ─────────────────────────

  function renderHeader(data) {
    if (!validData(data)) return
    const settings = objectOf(data.settings)
    const canEdit = data.canEdit !== false
    const view = VIEWS.includes(state.view) ? state.view : 'board'
    const weekVisible = WEEK_VIEWS.includes(view)
    const weekLabel = trimmedOf(data.weekLabel)

    const parts = []
    const className = trimmedOf(settings.className)
    parts.push(className === '' ? '未设置班级名称' : className)
    // 值日 / 安排视图的周信息只由 #week-meta 展示，避免页头出现两遍；
    // 今日 / 设置视图没有周信息行，班级信息行继续带周次。
    if (!weekVisible && weekLabel !== '') parts.push(weekLabel)
    const teacher = trimmedOf(settings.teacher)
    if (teacher !== '') parts.push('班主任 ' + teacher)
    setText(elements.classMeta, parts.join(' · '))

    if (elements.weekMeta !== null && elements.weekMeta !== undefined) {
      elements.weekMeta.hidden = !weekVisible
      if (weekVisible) {
        let meta = weekLabel === '' ? '第 ' + countOf(data.weekNumber) + ' 周' : weekLabel
        if (data.isCurrentWeek === true) meta += ' · 本周'
        else if (data.isPastWeek === true || Number(data.weekOffset) < 0 || !canEdit) meta += ' · 过去周'
        else meta += ' · 未来周'
        if (!canEdit) meta += '（只读）'
        setText(elements.weekMeta, meta)
      }
    }

    for (const button of elements.tabButtons) {
      const active = button.getAttribute('data-view') === view
      button.setAttribute('aria-selected', active ? 'true' : 'false')
      button.tabIndex = active ? 0 : -1
      button.classList.toggle('is-active', active)
    }

    if (elements.weekNav !== null && elements.weekNav !== undefined) {
      elements.weekNav.hidden = !weekVisible
    }
    if (elements.readonlyNote !== null && elements.readonlyNote !== undefined) {
      elements.readonlyNote.hidden = canEdit
    }
    updateNavDisabled()
  }

  function updateNavDisabled() {
    if (elements.prevWeek !== null && elements.prevWeek !== undefined) {
      elements.prevWeek.disabled = state.weekOffset <= MIN_WEEK_OFFSET
    }
    if (elements.nextWeek !== null && elements.nextWeek !== undefined) {
      elements.nextWeek.disabled = state.weekOffset >= MAX_WEEK_OFFSET
    }
    if (elements.thisWeek !== null && elements.thisWeek !== undefined) {
      elements.thisWeek.disabled = false
    }
  }

  // ───────────────────────── 渲染：视图分发 ─────────────────────────

  function render() {
    if (!validData(state.data)) return
    renderHeader(state.data)
    renderActiveView(state.data)
  }

  function renderActiveView(data) {
    const view = VIEWS.includes(state.view) ? state.view : 'board'
    for (const name of VIEWS) {
      const panel = elements.panels[name]
      if (panel === undefined || panel === null) continue
      panel.hidden = name !== view
    }
    if (view === 'duty') renderDuty(data)
    else if (view === 'schedule') renderSchedule(data)
    else if (view === 'settings') renderSettings(data)
    else renderBoard(data)
  }

  function appendEmpty(container, text) {
    if (container === null || container === undefined) return
    const empty = document.createElement('p')
    empty.className = 'cal-empty'
    empty.textContent = text
    container.appendChild(empty)
  }

  function appendCount(container, text, kind) {
    if (container === null || container === undefined) return
    const chip = document.createElement('span')
    chip.className = 'board-count' + (kind === '' || kind === undefined ? '' : ' ' + kind)
    chip.textContent = text
    container.appendChild(chip)
  }

  function renderKv(container, rows) {
    if (container === null || container === undefined) return
    clearChildren(container)
    for (const row of rows) {
      const line = document.createElement('div')
      line.className = 'board-kv-row'
      const label = document.createElement('span')
      label.className = 'board-kv-label'
      label.textContent = row[0]
      const value = document.createElement('span')
      value.className = 'board-kv-value'
      value.textContent = row[1]
      line.appendChild(label)
      line.appendChild(value)
      container.appendChild(line)
    }
  }

  // ───────────────────────── 渲染：今日 ─────────────────────────

  function renderBoard(data) {
    const counts = objectOf(data.counts)
    const canEdit = data.canEdit !== false
    const total = countOf(counts.total)
    const done = countOf(counts.done)
    const completion = Math.min(100, Math.max(0, countOf(data.completion)))

    setText(elements.todayLabel, trimmedOf(data.taskDateLabel) || textOf(data.taskDate))
    let sub = '共 ' + total + ' 条事务'
    if (total > 0) sub += ' · 已完成 ' + done + ' 条'
    setText(elements.todaySub, sub)

    if (elements.todayCounts !== null && elements.todayCounts !== undefined) {
      clearChildren(elements.todayCounts)
      appendCount(elements.todayCounts, '待办 ' + countOf(counts.pending), '')
      appendCount(elements.todayCounts, '完成 ' + done, done > 0 ? 'is-ok' : '')
      appendCount(elements.todayCounts, '逾期 ' + countOf(counts.overdue), countOf(counts.overdue) > 0 ? 'is-danger' : '')
      appendCount(
        elements.todayCounts,
        '高优先级 ' + countOf(counts.high),
        countOf(counts.high) > 0 ? 'is-accent' : '',
      )
    }

    if (elements.progress !== null && elements.progress !== undefined) {
      elements.progress.setAttribute('aria-valuenow', String(completion))
    }
    if (elements.progressFill !== null && elements.progressFill !== undefined) {
      elements.progressFill.style.width = completion + '%'
    }
    setText(elements.progressLabel, total === 0 ? '今天还没有事务' : '完成 ' + completion + '%')

    renderDutyPill(data, canEdit)

    setDisabled(
      [
        elements.addTaskText,
        elements.addTaskDueDate,
        elements.addTaskDueTime,
        elements.addTaskPriority,
        elements.addTaskCategory,
        elements.addTaskAssignee,
        elements.addTaskSubmit,
      ],
      !canEdit,
    )

    const tasks = asArray(data.tasks)
    const pending = tasks.filter(function (task) {
      return task !== null && typeof task === 'object' && task.done !== true
    })
    const doneTasks = tasks.filter(function (task) {
      return task !== null && typeof task === 'object' && task.done === true
    })

    setText(elements.pendingCount, String(pending.length))
    if (elements.pendingTasks !== null && elements.pendingTasks !== undefined) {
      clearChildren(elements.pendingTasks)
      if (pending.length === 0) appendEmpty(elements.pendingTasks, '今天没有未完成的事务。')
      else {
        for (const task of pending) {
          elements.pendingTasks.appendChild(buildTaskRow(task, canEdit, false))
        }
      }
    }

    setText(elements.doneCount, String(doneTasks.length))
    if (elements.doneTasks !== null && elements.doneTasks !== undefined) {
      clearChildren(elements.doneTasks)
      if (doneTasks.length === 0) appendEmpty(elements.doneTasks, '还没有已完成的事务。')
      else {
        for (const task of doneTasks) {
          elements.doneTasks.appendChild(buildTaskRow(task, canEdit, true))
        }
      }
    }

    renderSchedulePreview(data)
    renderAnnouncement(data, canEdit)
  }

  function renderDutyPill(data, canEdit) {
    if (elements.dutyPill === null || elements.dutyPill === undefined) return
    const duty = objectOf(data.duty)
    const parts = []
    const groupName = trimmedOf(duty.groupName)
    parts.push(groupName === '' ? '待安排' : groupName)
    const members = asArray(duty.members)
      .map(function (member) {
        return trimmedOf(member)
      })
      .filter(function (member) {
        return member !== ''
      })
    if (members.length > 0) parts.push(members.join('、'))
    const note = trimmedOf(duty.note)
    if (note !== '') parts.push(note)
    const prefix = data.isCurrentWeek === true ? '本周值日：' : '该周值日：'
    elements.dutyPill.textContent = prefix + parts.join(' · ')
    elements.dutyPill.disabled = !canEdit
  }

  function buildTaskRow(task, canEdit, doneArea) {
    const taskId = textOf(task.id)
    const done = task.done === true
    const row = document.createElement('div')
    row.className = 'cal-task board-task'
    row.setAttribute('data-task-id', taskId)
    if (done) row.classList.add('is-done')

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'cal-task-toggle'
    toggle.textContent = done ? '✓' : '○'
    toggle.title = done ? '恢复为待办' : '标记完成'
    toggle.setAttribute('aria-label', (done ? '恢复为待办：' : '标记完成：') + textOf(task.text))
    toggle.disabled = !canEdit
    toggle.addEventListener('click', function () {
      toggleTask(taskId, toggle)
    })
    row.appendChild(toggle)

    const text = document.createElement('span')
    text.className = 'cal-task-text'
    text.textContent = textOf(task.text)
    row.appendChild(text)

    const meta = document.createElement('span')
    meta.className = 'cal-task-meta'
    meta.textContent = taskMetaText(task)
    row.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'board-task-actions'
    if (!doneArea) {
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'board-task-btn'
      edit.textContent = '编辑'
      edit.disabled = !canEdit
      edit.addEventListener('click', function () {
        openTaskEditor(taskId, edit)
      })
      actions.appendChild(edit)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'board-task-btn is-danger'
    remove.textContent = '删除'
    remove.disabled = !canEdit
    remove.addEventListener('click', function () {
      requestTaskDelete(taskId, remove)
    })
    actions.appendChild(remove)
    row.appendChild(actions)

    return row
  }

  function taskMetaText(task) {
    const parts = []
    if (trimmedOf(task.dueLabel) !== '') parts.push(textOf(task.dueLabel))
    const priorityLabel = PRIORITY_LABELS[task.priority]
    if (priorityLabel !== undefined && priorityLabel !== '') parts.push(priorityLabel)
    if (trimmedOf(task.assignee) !== '') parts.push(textOf(task.assignee))
    if (task.overdue === true) parts.push('已逾期')
    return parts.join(' · ')
  }

  function renderSchedulePreview(data) {
    const schedule = asArray(data.schedule)
    setText(elements.previewCount, String(schedule.length))
    if (elements.previewSchedule === null || elements.previewSchedule === undefined) return
    clearChildren(elements.previewSchedule)
    if (schedule.length === 0) {
      appendEmpty(elements.previewSchedule, '本周还没有安排。')
    } else {
      for (const entry of schedule.slice(0, PREVIEW_SCHEDULE_LIMIT)) {
        if (entry === null || typeof entry !== 'object') continue
        elements.previewSchedule.appendChild(buildPreviewRow(entry, data))
      }
    }
    if (elements.previewMore !== null && elements.previewMore !== undefined) {
      const rest = schedule.length - PREVIEW_SCHEDULE_LIMIT
      if (rest > 0) {
        elements.previewMore.hidden = false
        elements.previewMore.textContent = '还有 ' + rest + ' 项，切换到安排视图查看。'
      } else {
        elements.previewMore.hidden = true
        elements.previewMore.textContent = ''
      }
    }
  }

  function buildPreviewRow(entry, data) {
    const weekday = Number(entry.weekday)
    const time = trimmedOf(entry.time)
    const row = document.createElement('div')
    row.className = 'board-preview-row'
    const isToday =
      data.isCurrentWeek === true && weekday === weekdayOfDate(data.today) && weekday >= 1 && weekday <= 7
    if (isToday) row.classList.add('is-today')

    const when = document.createElement('span')
    when.className = 'board-preview-when'
    const dayName = WEEKDAY_NAMES[weekday - 1] === undefined ? '' : WEEKDAY_NAMES[weekday - 1]
    when.textContent = dayName + ' ' + (time === '' ? '全天' : time)
    row.appendChild(when)

    if (isToday) {
      const badge = document.createElement('span')
      badge.className = 'board-preview-badge'
      badge.textContent = '今天'
      row.appendChild(badge)
    }

    const title = document.createElement('span')
    title.className = 'board-preview-title'
    title.textContent = textOf(entry.title)
    row.appendChild(title)

    const place = trimmedOf(entry.place)
    if (place !== '') {
      const placeNode = document.createElement('span')
      placeNode.className = 'board-preview-place'
      placeNode.textContent = place
      row.appendChild(placeNode)
    }

    return row
  }

  function renderAnnouncement(data, canEdit) {
    // 通知只有一个可编辑 textarea（不再额外渲染静态文本，避免同一段通知出现两次）。
    const input = elements.announcementInput
    if (input === null || input === undefined) return
    input.disabled = !canEdit
    if (!canEdit && document.activeElement === input) input.blur()
    // 输入框聚焦时绝不覆盖，避免打断正在编辑的通知。
    if (document.activeElement !== input) input.value = textOf(data.announcement)
    if (elements.saveAnnouncement !== null && elements.saveAnnouncement !== undefined) {
      elements.saveAnnouncement.disabled = !canEdit
    }
  }

  // ───────────────────────── 渲染：值日 ─────────────────────────

  function renderDuty(data) {
    const canEdit = data.canEdit !== false
    const duty = objectOf(data.duty)
    setText(elements.dutyTitle, data.isCurrentWeek === true ? '本周值日' : '该周值日')

    renderKv(elements.dutyInfo, [
      ['值日组', trimmedOf(duty.groupName) === '' ? '待安排' : textOf(duty.groupName)],
      ['轮换方式', duty.hasOverrideGroup === true ? '本周指定' : '按周自动轮换'],
      ['备注', trimmedOf(duty.note) === '' ? '—' : textOf(duty.note)],
    ])

    const members = asArray(duty.members)
      .map(function (member) {
        return trimmedOf(member)
      })
      .filter(function (member) {
        return member !== ''
      })
    if (elements.dutyMembers !== null && elements.dutyMembers !== undefined) {
      elements.dutyMembers.textContent =
        members.length === 0
          ? '这个组还没有成员，可在「分组与轮换顺序」里填写。'
          : '成员：' + members.join('、')
    }

    if (elements.editDuty !== null && elements.editDuty !== undefined) {
      elements.editDuty.textContent = data.isCurrentWeek === true ? '修改本周值日' : '修改该周值日'
      elements.editDuty.disabled = !canEdit
    }

    const preview = asArray(data.rotationPreview)
    if (elements.rotationList !== null && elements.rotationList !== undefined) {
      clearChildren(elements.rotationList)
      if (preview.length === 0) appendEmpty(elements.rotationList, '还没有轮换预览。')
      else {
        for (const row of preview) {
          if (row === null || typeof row !== 'object') continue
          const line = document.createElement('div')
          line.className = 'board-rot-row'
          const week = document.createElement('span')
          week.className = 'board-rot-week'
          week.textContent = textOf(row.week)
          const group = document.createElement('span')
          group.className = 'board-rot-group'
          group.textContent = textOf(row.group) === '' ? '未分组' : textOf(row.group)
          line.appendChild(week)
          line.appendChild(group)
          elements.rotationList.appendChild(line)
        }
      }
    }

    const orderNames = asArray(duty.orderNames)
      .map(function (name) {
        return trimmedOf(name)
      })
      .filter(function (name) {
        return name !== ''
      })
    if (elements.rotationOrder !== null && elements.rotationOrder !== undefined) {
      elements.rotationOrder.textContent =
        orderNames.length === 0 ? '还没有设置轮换顺序。' : '轮换顺序：' + orderNames.join(' → ')
    }

    const groups = asArray(data.groups)
    const groupRows = []
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue
      const name = trimmedOf(group.name)
      if (name === '') continue
      const groupMembers = asArray(group.members)
        .map(function (member) {
          return trimmedOf(member)
        })
        .filter(function (member) {
          return member !== ''
        })
      groupRows.push([name, groupMembers.length === 0 ? '未填写成员' : groupMembers.join('、')])
    }
    if (groupRows.length === 0) groupRows.push(['分组', '还没有值日组，点击「编辑分组与轮换」创建。'])
    renderKv(elements.groupsSummary, groupRows)

    if (elements.editGroups !== null && elements.editGroups !== undefined) {
      elements.editGroups.disabled = !canEdit
    }
  }

  // ───────────────────────── 渲染：安排 ─────────────────────────

  function renderSchedule(data) {
    const canEdit = data.canEdit !== false
    const schedule = asArray(data.schedule)

    setText(elements.scheduleTitle, data.isCurrentWeek === true ? '本周安排' : '该周安排')
    setText(elements.scheduleCount, String(schedule.length))

    if (elements.addScheduleCard !== null && elements.addScheduleCard !== undefined) {
      elements.addScheduleCard.hidden = !canEdit
    }
    setDisabled(
      [
        elements.addScheduleWeekday,
        elements.addScheduleTime,
        elements.addScheduleTitle,
        elements.addSchedulePlace,
        elements.addScheduleNote,
        elements.addScheduleSubmit,
      ],
      !canEdit,
    )

    if (elements.scheduleList === null || elements.scheduleList === undefined) return
    clearChildren(elements.scheduleList)
    if (schedule.length === 0) {
      appendEmpty(elements.scheduleList, canEdit ? '本周还没有安排，可以在上面添加。' : '该周没有安排。')
      return
    }
    for (const entry of schedule) {
      if (entry === null || typeof entry !== 'object') continue
      elements.scheduleList.appendChild(buildScheduleRow(entry, canEdit))
    }
  }

  function buildScheduleRow(entry, canEdit) {
    const entryId = textOf(entry.id)
    const weekday = Number(entry.weekday)
    const time = trimmedOf(entry.time)
    const item = document.createElement('div')
    item.className = 'board-schedule-item'
    item.setAttribute('data-schedule-id', entryId)

    const head = document.createElement('div')
    head.className = 'board-schedule-head'

    const when = document.createElement('span')
    when.className = 'board-schedule-when'
    const dayName = WEEKDAY_NAMES[weekday - 1] === undefined ? '' : WEEKDAY_NAMES[weekday - 1]
    when.textContent = dayName + ' ' + (time === '' ? '全天' : time)
    head.appendChild(when)

    const name = document.createElement('span')
    name.className = 'board-schedule-name'
    name.textContent = textOf(entry.title)
    head.appendChild(name)

    const place = trimmedOf(entry.place)
    if (place !== '') {
      const placeNode = document.createElement('span')
      placeNode.className = 'board-schedule-place'
      placeNode.textContent = place
      head.appendChild(placeNode)
    }
    item.appendChild(head)

    const note = trimmedOf(entry.note)
    if (note !== '') {
      const noteNode = document.createElement('div')
      noteNode.className = 'board-schedule-note'
      noteNode.textContent = note
      item.appendChild(noteNode)
    }

    const actions = document.createElement('div')
    actions.className = 'board-schedule-actions'

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'board-task-btn'
    edit.textContent = '编辑'
    edit.disabled = !canEdit
    edit.addEventListener('click', function () {
      openScheduleEditor(entryId, edit)
    })
    actions.appendChild(edit)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'board-task-btn is-danger'
    remove.textContent = '删除'
    remove.disabled = !canEdit
    remove.addEventListener('click', function () {
      requestScheduleDelete(entryId, remove)
    })
    actions.appendChild(remove)
    item.appendChild(actions)

    return item
  }

  // ───────────────────────── 渲染：设置 ─────────────────────────

  function renderSettings(data) {
    const settings = objectOf(data.settings)
    renderKv(elements.settingsInfo, [
      ['班级名称', trimmedOf(settings.className) === '' ? '未设置' : textOf(settings.className)],
      ['班主任', trimmedOf(settings.teacher) === '' ? '未设置' : textOf(settings.teacher)],
      [
        '学期起始',
        trimmedOf(settings.termStartDate) === '' ? '未设置（以第 1 周为起始）' : textOf(settings.termStartDate),
      ],
    ])

    const stats = objectOf(data.stats)
    const bytes = countOf(stats.bytes)
    renderKv(elements.settingsStats, [
      ['已保存周数', String(countOf(stats.weeks))],
      ['事务总数', countOf(stats.tasks) + '（完成 ' + countOf(stats.done) + '）'],
      ['安排总数', String(countOf(stats.schedule))],
      ['占用空间', Math.ceil(bytes / 1024) + ' KB（上限 240 KB）'],
    ])

    const empty = data.boardEmpty === true
    const canEdit = data.canEdit !== false
    if (elements.loadDemo !== null && elements.loadDemo !== undefined) {
      elements.loadDemo.disabled = !empty || !canEdit
    }
    if (elements.loadDemoHint !== null && elements.loadDemoHint !== undefined) {
      let hint = ''
      if (!empty) hint = '本周已有数据；先用下方「清理范围」清空后再写入示例。'
      else if (!canEdit) hint = '过去周只读，不能写入示例。'
      else hint = '本周为空，可写入示例值日 / 事务 / 安排 / 通知。'
      elements.loadDemoHint.textContent = hint
    }
    setDisabled([elements.clearScope, elements.clearButton], false)
  }

  // ───────────────────────── 事务动作 ─────────────────────────

  function findTaskById(id) {
    if (!validData(state.data)) return null
    const target = textOf(id)
    const tasks = asArray(state.data.tasks)
    for (const task of tasks) {
      if (task !== null && typeof task === 'object' && textOf(task.id) === target) return task
    }
    return null
  }

  function findScheduleById(id) {
    if (!validData(state.data)) return null
    const target = textOf(id)
    const schedule = asArray(state.data.schedule)
    for (const entry of schedule) {
      if (entry !== null && typeof entry === 'object' && textOf(entry.id) === target) return entry
    }
    return null
  }

  function toggleTask(taskId, button) {
    const task = findTaskById(taskId)
    if (task === null) {
      showStatus('这条事务已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isEditable()) {
      showStatus('过去周只读，不能修改事务', 'error')
      return
    }
    runAction('toggle-task', { id: textOf(task.id) }, { buttons: [button], reloadOnError: true })
  }

  function requestTaskDelete(taskId, trigger) {
    const task = findTaskById(taskId)
    if (task === null) {
      showStatus('这条事务已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isEditable()) {
      showStatus('过去周只读，不能删除事务', 'error')
      return
    }
    const id = textOf(task.id)
    const label = trimmedOf(task.text)
    openConfirm({
      trigger,
      title: '删除事务',
      message: '确定删除「' + (label === '' ? '这条事务' : label) + '」？\n删除后无法恢复。',
      confirmLabel: '删除事务',
      action: function () {
        return runAction('delete-task', { id }, {})
      },
      onSuccess: focusAfterDelete,
    })
  }

  function openTaskEditor(taskId, trigger) {
    const task = findTaskById(taskId)
    if (task === null) {
      showStatus('这条事务已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isEditable()) {
      showStatus('过去周只读，不能编辑事务', 'error')
      return
    }
    const previousFocus = trigger !== undefined && trigger !== null ? trigger : document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== undefined && previousFocus !== document.body
        ? previousFocus
        : null
    state.taskEditorId = textOf(task.id)
    setValue(elements.taskEditorText, task.text)
    setValue(elements.taskEditorDueDate, task.dueDate)
    setValue(elements.taskEditorDueTime, task.dueTime)
    setSelectValue(elements.taskEditorPriority, task.priority, 'normal', PRIORITY_VALUES)
    setSelectValue(elements.taskEditorCategory, task.category, '事务', CATEGORY_VALUES)
    setValue(elements.taskEditorAssignee, task.assignee)
    if (elements.taskEditorDone !== null && elements.taskEditorDone !== undefined) {
      elements.taskEditorDone.checked = task.done === true
    }
    setInlineError(elements.taskEditorError, '')
    setDisabled([elements.taskEditorSave, elements.taskEditorDelete], false)
    elements.taskEditorModal.hidden = false
    focusElement(elements.taskEditorText)
  }

  function setSelectValue(select, value, fallback, allowed) {
    if (select === null || select === undefined || select.tagName !== 'SELECT') return
    const target = textOf(value)
    if (target === '' || (Array.isArray(allowed) && !allowed.includes(target))) {
      select.value = fallback
      return
    }
    let exists = false
    for (const option of select.options) {
      if (option.value === target) {
        exists = true
        break
      }
    }
    if (!exists) {
      const option = document.createElement('option')
      option.value = target
      option.textContent = target
      select.appendChild(option)
    }
    select.value = target
  }

  function saveTaskEditor() {
    const taskId = state.taskEditorId
    if (taskId === '') return
    const task = findTaskById(taskId)
    if (task === null) {
      const error = '这条事务已不存在，请刷新后重试'
      setInlineError(elements.taskEditorError, error)
      showStatus(error, 'error')
      return
    }
    if (!isEditable()) {
      const error = '过去周只读，不能编辑事务'
      setInlineError(elements.taskEditorError, error)
      showStatus(error, 'error')
      return
    }
    const text = elements.taskEditorText === undefined || elements.taskEditorText === null ? '' : elements.taskEditorText.value.trim()
    if (text === '') {
      setInlineError(elements.taskEditorError, '请填写事务内容')
      focusElement(elements.taskEditorText)
      return
    }
    const priorityValue = elements.taskEditorPriority === undefined || elements.taskEditorPriority === null ? 'normal' : elements.taskEditorPriority.value
    const payload = {
      id: taskId,
      text,
      dueDate: elements.taskEditorDueDate === undefined || elements.taskEditorDueDate === null ? '' : elements.taskEditorDueDate.value.trim(),
      dueTime: elements.taskEditorDueTime === undefined || elements.taskEditorDueTime === null ? '' : elements.taskEditorDueTime.value.trim(),
      priority: PRIORITY_VALUES.includes(priorityValue) ? priorityValue : 'normal',
      category:
        elements.taskEditorCategory === undefined || elements.taskEditorCategory === null
          ? '事务'
          : elements.taskEditorCategory.value.trim(),
      assignee:
        elements.taskEditorAssignee === undefined || elements.taskEditorAssignee === null
          ? ''
          : elements.taskEditorAssignee.value.trim(),
      done: Boolean(elements.taskEditorDone !== null && elements.taskEditorDone !== undefined && elements.taskEditorDone.checked),
    }
    const focusId = taskId
    runAction('update-task', payload, {
      buttons: [elements.taskEditorSave, elements.taskEditorDelete],
      errorTarget: elements.taskEditorError,
      onSuccess: function () {
        closeTaskEditor(false)
        focusTaskRow(focusId)
      },
    })
  }

  function requestTaskDeleteFromEditor() {
    const taskId = state.taskEditorId
    if (taskId === '') return
    const task = findTaskById(taskId)
    if (task === null) {
      setInlineError(elements.taskEditorError, '这条事务已不存在，请刷新后重试')
      return
    }
    if (!isEditable()) {
      setInlineError(elements.taskEditorError, '过去周只读，不能删除事务')
      return
    }
    const label = trimmedOf(task.text)
    openConfirm({
      trigger: elements.taskEditorDelete,
      title: '删除事务',
      message: '确定删除「' + (label === '' ? '这条事务' : label) + '」？\n删除后无法恢复。',
      confirmLabel: '删除事务',
      action: function () {
        return runAction('delete-task', { id: taskId }, {})
      },
      onSuccess: function () {
        closeTaskEditor(false)
        focusAfterDelete()
      },
    })
  }

  function closeTaskEditor(restore) {
    const modal = elements.taskEditorModal
    if (modal === null || modal === undefined) return
    const wasOpen = modal.hidden === false
    modal.hidden = true
    state.taskEditorId = ''
    setInlineError(elements.taskEditorError, '')
    if (!wasOpen) return
    const target = state.focusReturn
    state.focusReturn = null
    if (restore === true) restoreFocusOrFallback(target)
  }

  function findTaskRow(taskId) {
    const target = textOf(taskId)
    if (target === '') return null
    const containers = [elements.pendingTasks, elements.doneTasks]
    for (const container of containers) {
      if (container === null || container === undefined) continue
      const rows = container.querySelectorAll('.board-task')
      for (const row of rows) {
        if (row.getAttribute('data-task-id') === target) return row
      }
    }
    return null
  }

  function focusTaskRow(taskId) {
    const row = findTaskRow(taskId)
    if (row === null) {
      focusAfterDelete()
      return
    }
    const toggle = row.querySelector('.cal-task-toggle')
    focusElement(toggle === null ? row.querySelector('.board-task-btn') : toggle)
  }

  // ───────────────────────── 安排动作 ─────────────────────────

  function addSchedule() {
    if (!isEditable()) {
      showStatus('过去周只读，不能添加安排', 'error')
      return
    }
    const title = elements.addScheduleTitle === undefined || elements.addScheduleTitle === null ? '' : elements.addScheduleTitle.value.trim()
    if (title === '') {
      setInlineError(elements.addScheduleError, '请填写安排事项')
      focusElement(elements.addScheduleTitle)
      return
    }
    const weekdayValue = elements.addScheduleWeekday === undefined || elements.addScheduleWeekday === null ? '' : elements.addScheduleWeekday.value
    const weekday = Number(weekdayValue)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      setInlineError(elements.addScheduleError, '请选择周几')
      focusElement(elements.addScheduleWeekday)
      return
    }
    const payload = {
      weekday,
      time: elements.addScheduleTime === undefined || elements.addScheduleTime === null ? '' : elements.addScheduleTime.value.trim(),
      title,
      place:
        elements.addSchedulePlace === undefined || elements.addSchedulePlace === null
          ? ''
          : elements.addSchedulePlace.value.trim(),
      note:
        elements.addScheduleNote === undefined || elements.addScheduleNote === null
          ? ''
          : elements.addScheduleNote.value.trim(),
      weekOffset: state.weekOffset,
    }
    runAction('add-schedule', payload, {
      buttons: [elements.addScheduleSubmit],
      errorTarget: elements.addScheduleError,
      onSuccess: function () {
        setValue(elements.addScheduleTitle, '')
        setValue(elements.addSchedulePlace, '')
        setValue(elements.addScheduleNote, '')
        setInlineError(elements.addScheduleError, '')
        focusElement(elements.addScheduleTitle)
      },
    })
  }

  function openScheduleEditor(entryId, trigger) {
    const entry = findScheduleById(entryId)
    if (entry === null) {
      showStatus('这条安排已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isEditable()) {
      showStatus('过去周只读，不能编辑安排', 'error')
      return
    }
    const previousFocus = trigger !== undefined && trigger !== null ? trigger : document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== undefined && previousFocus !== document.body
        ? previousFocus
        : null
    state.scheduleEditorId = textOf(entry.id)
    setSelectValue(elements.scheduleEditorWeekday, String(entry.weekday), '1', null)
    setValue(elements.scheduleEditorTime, entry.time)
    setValue(elements.scheduleEditorTitleInput, entry.title)
    setValue(elements.scheduleEditorPlace, entry.place)
    setValue(elements.scheduleEditorNote, entry.note)
    setInlineError(elements.scheduleEditorError, '')
    setDisabled([elements.scheduleEditorSave], false)
    elements.scheduleEditorModal.hidden = false
    focusElement(elements.scheduleEditorTitleInput)
  }

  function saveScheduleEditor() {
    const entryId = state.scheduleEditorId
    if (entryId === '') return
    const entry = findScheduleById(entryId)
    if (entry === null) {
      setInlineError(elements.scheduleEditorError, '这条安排已不存在，请刷新后重试')
      return
    }
    if (!isEditable()) {
      setInlineError(elements.scheduleEditorError, '过去周只读，不能编辑安排')
      return
    }
    const title = elements.scheduleEditorTitleInput === undefined || elements.scheduleEditorTitleInput === null ? '' : elements.scheduleEditorTitleInput.value.trim()
    if (title === '') {
      setInlineError(elements.scheduleEditorError, '请填写安排事项')
      focusElement(elements.scheduleEditorTitleInput)
      return
    }
    const weekdayValue = elements.scheduleEditorWeekday === undefined || elements.scheduleEditorWeekday === null ? '' : elements.scheduleEditorWeekday.value
    const weekday = Number(weekdayValue)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      setInlineError(elements.scheduleEditorError, '请选择周几')
      focusElement(elements.scheduleEditorWeekday)
      return
    }
    const payload = {
      id: entryId,
      weekday,
      time:
        elements.scheduleEditorTime === undefined || elements.scheduleEditorTime === null
          ? ''
          : elements.scheduleEditorTime.value.trim(),
      title,
      place:
        elements.scheduleEditorPlace === undefined || elements.scheduleEditorPlace === null
          ? ''
          : elements.scheduleEditorPlace.value.trim(),
      note:
        elements.scheduleEditorNote === undefined || elements.scheduleEditorNote === null
          ? ''
          : elements.scheduleEditorNote.value.trim(),
      weekOffset: state.weekOffset,
    }
    const focusId = entryId
    runAction('update-schedule', payload, {
      buttons: [elements.scheduleEditorSave],
      errorTarget: elements.scheduleEditorError,
      onSuccess: function () {
        closeScheduleEditor(false)
        focusScheduleRow(focusId)
      },
    })
  }

  function requestScheduleDelete(entryId, trigger) {
    const entry = findScheduleById(entryId)
    if (entry === null) {
      showStatus('这条安排已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isEditable()) {
      showStatus('过去周只读，不能删除安排', 'error')
      return
    }
    const weekday = Number(entry.weekday)
    const dayName = WEEKDAY_NAMES[weekday - 1] === undefined ? '' : WEEKDAY_NAMES[weekday - 1]
    const time = trimmedOf(entry.time)
    openConfirm({
      trigger,
      title: '删除安排',
      message:
        '确定删除「' +
        dayName +
        ' ' +
        (time === '' ? '全天' : time) +
        ' ' +
        textOf(entry.title) +
        '」？\n删除后无法恢复。',
      confirmLabel: '删除安排',
      action: function () {
        return runAction('delete-schedule', { id: textOf(entry.id), weekOffset: state.weekOffset }, {})
      },
      onSuccess: focusAfterDelete,
    })
  }

  function closeScheduleEditor(restore) {
    const modal = elements.scheduleEditorModal
    if (modal === null || modal === undefined) return
    const wasOpen = modal.hidden === false
    modal.hidden = true
    state.scheduleEditorId = ''
    setInlineError(elements.scheduleEditorError, '')
    if (!wasOpen) return
    const target = state.focusReturn
    state.focusReturn = null
    if (restore === true) restoreFocusOrFallback(target)
  }

  function findScheduleRow(entryId) {
    if (elements.scheduleList === null || elements.scheduleList === undefined) return null
    const rows = elements.scheduleList.querySelectorAll('.board-schedule-item')
    for (const row of rows) {
      if (row.getAttribute('data-schedule-id') === textOf(entryId)) return row
    }
    return null
  }

  function focusScheduleRow(entryId) {
    const row = findScheduleRow(entryId)
    if (row === null) {
      focusAfterDelete()
      return
    }
    const buttons = row.querySelectorAll('.board-task-btn')
    focusElement(buttons.length > 0 ? buttons[0] : row)
  }

  // ───────────────────────── 值日动作 ─────────────────────────

  function openDutyEditor(trigger) {
    if (!isEditable()) {
      showStatus('过去周只读，不能修改值日', 'error')
      return
    }
    const previousFocus = trigger !== undefined && trigger !== null ? trigger : document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== undefined && previousFocus !== document.body
        ? previousFocus
        : null
    fillDutyGroupOptions(state.data)
    const duty = objectOf(state.data.duty)
    setValue(elements.dutyEditorNote, duty.note)
    setText(elements.dutyEditorTitle, state.data.isCurrentWeek === true ? '本周值日' : '该周值日')
    setInlineError(elements.dutyEditorError, '')
    setDisabled([elements.dutyEditorSave], false)
    elements.dutyEditorModal.hidden = false
    focusElement(elements.dutyEditorGroup)
  }

  function fillDutyGroupOptions(data) {
    const select = elements.dutyEditorGroup
    if (select === null || select === undefined) return
    clearChildren(select)
    const auto = document.createElement('option')
    auto.value = ''
    auto.textContent = '自动轮换（按顺序）'
    select.appendChild(auto)
    const groups = asArray(data.groups)
    const names = []
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue
      const id = textOf(group.id)
      const name = trimmedOf(group.name)
      if (id === '' || name === '') continue
      names.push(id)
      const option = document.createElement('option')
      option.value = id
      option.textContent = name
      select.appendChild(option)
    }
    const current = textOf(data.dutyGroupId)
    select.value = names.includes(current) ? current : ''
  }

  function saveDutyEditor() {
    if (!isEditable()) {
      setInlineError(elements.dutyEditorError, '过去周只读，不能修改值日')
      return
    }
    const groupId = elements.dutyEditorGroup === undefined || elements.dutyEditorGroup === null ? '' : elements.dutyEditorGroup.value
    const note = elements.dutyEditorNote === undefined || elements.dutyEditorNote === null ? '' : elements.dutyEditorNote.value.trim()
    runAction(
      'set-duty-week',
      { groupId: textOf(groupId), note, weekOffset: effectiveWeekOffset() },
      {
        buttons: [elements.dutyEditorSave],
        errorTarget: elements.dutyEditorError,
        onSuccess: function () {
          closeDutyEditor(false)
          focusElement(elements.editDuty)
        },
      },
    )
  }

  function closeDutyEditor(restore) {
    const modal = elements.dutyEditorModal
    if (modal === null || modal === undefined) return
    const wasOpen = modal.hidden === false
    modal.hidden = true
    setInlineError(elements.dutyEditorError, '')
    if (!wasOpen) return
    const target = state.focusReturn
    state.focusReturn = null
    if (restore === true) restoreFocusOrFallback(target)
  }

  function openGroupsEditor(trigger) {
    if (!isEditable()) {
      showStatus('过去周只读，不能修改值日分组', 'error')
      return
    }
    const previousFocus = trigger !== undefined && trigger !== null ? trigger : document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== undefined && previousFocus !== document.body
        ? previousFocus
        : null
    setValue(elements.groupsEditorText, state.data.groupsText)
    setValue(elements.groupsEditorOrder, state.data.orderText)
    setInlineError(elements.groupsEditorError, '')
    setDisabled([elements.groupsEditorSave], false)
    elements.groupsEditorModal.hidden = false
    focusElement(elements.groupsEditorText)
  }

  function saveGroupsEditor() {
    if (!isEditable()) {
      setInlineError(elements.groupsEditorError, '过去周只读，不能修改值日分组')
      return
    }
    const parsed = parseDutyGroupsText(elements.groupsEditorText === undefined || elements.groupsEditorText === null ? '' : elements.groupsEditorText.value)
    if (parsed.issues.length > 0) {
      setInlineError(elements.groupsEditorError, parsed.issues.slice(0, 3).join('；'))
      focusElement(elements.groupsEditorText)
      return
    }
    if (parsed.groups.length === 0) {
      setInlineError(elements.groupsEditorError, '请至少填写一个值日组')
      focusElement(elements.groupsEditorText)
      return
    }
    const order = parseOrderText(
      elements.groupsEditorOrder === undefined || elements.groupsEditorOrder === null
        ? ''
        : elements.groupsEditorOrder.value,
    )
    const payload = { groups: parsed.groups }
    if (order.length > 0) payload.order = order
    runAction('save-duty-groups', payload, {
      buttons: [elements.groupsEditorSave],
      errorTarget: elements.groupsEditorError,
      onSuccess: function () {
        closeGroupsEditor(false)
        focusElement(elements.editGroups)
      },
    })
  }

  function closeGroupsEditor(restore) {
    const modal = elements.groupsEditorModal
    if (modal === null || modal === undefined) return
    const wasOpen = modal.hidden === false
    modal.hidden = true
    setInlineError(elements.groupsEditorError, '')
    if (!wasOpen) return
    const target = state.focusReturn
    state.focusReturn = null
    if (restore === true) restoreFocusOrFallback(target)
  }

  function splitNames(value) {
    const names = []
    const raw = Array.isArray(value) ? value : textOf(value).split(/[,，、/\s]+/)
    for (const item of raw) {
      const name = clipText(item, 20)
      if (name !== '' && !names.includes(name)) names.push(name)
      if (names.length >= 12) break
    }
    return names
  }

  /** 与 lib/duty.js 的 parseDutyGroupsText 同口径：每行「组名: 成员, 成员」。 */
  function parseDutyGroupsText(value) {
    const groups = []
    const issues = []
    const names = new Set()
    const lines = textOf(value).split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*·•]\s*/, '').trim()
      if (line === '' || line.startsWith('#')) continue
      const half = line.indexOf(':')
      const full = line.indexOf('：')
      const separator = half >= 0 && full >= 0 ? Math.min(half, full) : Math.max(half, full)
      const rawName = separator >= 0 ? line.slice(0, separator) : line
      const rawMembers = separator >= 0 ? line.slice(separator + 1) : ''
      const name = clipText(rawName, 20)
      if (name === '') {
        issues.push('分组缺少名称：' + clipText(line, 24))
        continue
      }
      if (names.has(name)) {
        issues.push('分组名重复：' + name)
        continue
      }
      names.add(name)
      groups.push({ name, members: splitNames(rawMembers) })
      if (groups.length >= 8) break
    }
    return { groups, issues }
  }

  /** 与 lib/duty.js 的 parseOrderText 同口径：逗号 / 顿号 / 空白分隔组名。 */
  function parseOrderText(value) {
    return splitNames(textOf(value).replace(/[，、]/g, ','))
      .map(function (name) {
        return clipText(name, 20)
      })
      .filter(function (name) {
        return name !== ''
      })
  }

  // ───────────────────────── 通知 / 设置动作 ─────────────────────────

  function saveAnnouncement() {
    if (!isEditable()) {
      showStatus('过去周只读，不能修改通知', 'error')
      return
    }
    if (elements.announcementInput === null || elements.announcementInput === undefined) return
    runAction(
      'save-announcement',
      { text: elements.announcementInput.value, weekOffset: effectiveWeekOffset() },
      { buttons: [elements.saveAnnouncement] },
    )
  }

  function requestClearScope() {
    const scopeValue = elements.clearScope === undefined || elements.clearScope === null ? 'tasks' : elements.clearScope.value
    const scope = Object.prototype.hasOwnProperty.call(CLEAR_SCOPE_LABELS, scopeValue) ? scopeValue : 'tasks'
    openConfirm({
      trigger: elements.clearButton,
      title: '清理数据',
      message: '将删除「' + CLEAR_SCOPE_LABELS[scope] + '」的数据。\n删除后无法恢复。',
      confirmLabel: '确认清理',
      action: function () {
        return runAction('clear-scope', { scope, weekOffset: effectiveWeekOffset() }, {})
      },
      onSuccess: function () {
        setInlineError(elements.clearError, '')
        focusAfterDelete()
      },
    })
  }

  function requestLoadDemo() {
    if (!isEditable()) {
      showStatus('过去周只读，不能写入示例', 'error')
      return
    }
    if (!validData(state.data) || state.data.boardEmpty !== true) {
      showStatus('本周已有数据；先清理后才能写入示例', 'error')
      return
    }
    openConfirm({
      trigger: elements.loadDemo,
      title: '写入示例周',
      message: '把示例值日、事务、安排与通知写入本周？\n只在当前周为空时可用。',
      confirmLabel: '写入示例',
      danger: false,
      action: function () {
        return runAction('load-demo', {}, {})
      },
      onSuccess: function () {
        focusAfterDelete()
      },
    })
  }

  // ───────────────────────── 确认弹层 ─────────────────────────

  function openConfirm(config) {
    const cfg = objectOf(config)
    if (state.confirm !== null) closeConfirm(false)
    state.confirm = cfg
    const fallback = document.activeElement
    state.confirmReturn =
      cfg.trigger !== undefined && cfg.trigger !== null
        ? cfg.trigger
        : fallback !== null && fallback !== undefined && fallback !== document.body
          ? fallback
          : null
    setText(elements.confirmTitle, trimmedOf(cfg.title) === '' ? '确认操作' : cfg.title)
    setText(elements.confirmMessage, cfg.message)
    if (elements.confirmOk !== null && elements.confirmOk !== undefined) {
      elements.confirmOk.textContent = trimmedOf(cfg.confirmLabel) === '' ? '确认' : cfg.confirmLabel
      elements.confirmOk.className = 'cal-btn ' + (cfg.danger === false ? 'cal-btn-primary' : 'cal-btn-danger')
      elements.confirmOk.disabled = false
    }
    if (elements.confirmCancel !== null && elements.confirmCancel !== undefined) {
      elements.confirmCancel.disabled = false
    }
    setInlineError(elements.confirmError, '')
    elements.confirmModal.hidden = false
    // 危险操作默认把焦点放在「取消」上，避免误触。
    focusElement(elements.confirmCancel)
  }

  function closeConfirm(restore) {
    const modal = elements.confirmModal
    if (modal === null || modal === undefined) return
    const wasOpen = modal.hidden === false
    modal.hidden = true
    setInlineError(elements.confirmError, '')
    const target = state.confirmReturn
    state.confirmReturn = null
    state.confirm = null
    if (!wasOpen) return
    if (restore === true) restoreFocusOrFallback(target)
  }

  function proceedConfirm() {
    const cfg = state.confirm
    if (cfg === null || state.confirmBusy) return
    state.confirmBusy = true
    const buttons = [elements.confirmOk, elements.confirmCancel]
    const previousDisabled = buttons.map(function (button) {
      return button !== null && button !== undefined && button.disabled === true
    })
    setDisabled(buttons, true)
    setInlineError(elements.confirmError, '')
    Promise.resolve()
      .then(function () {
        if (typeof cfg.action !== 'function') return null
        return cfg.action()
      })
      .then(function (outcome) {
        const error = outcome !== null && typeof outcome === 'object' ? resultError(outcome) : ''
        if (error !== '') {
          setInlineError(elements.confirmError, error)
          showStatus(error, 'error')
          return
        }
        const onSuccess = cfg.onSuccess
        closeConfirm(true)
        if (typeof onSuccess === 'function') onSuccess(outcome)
      })
      .catch(function (error) {
        const text = messageOf(error)
        setInlineError(elements.confirmError, text)
        showStatus(text, 'error')
      })
      .then(function () {
        state.confirmBusy = false
        buttons.forEach(function (button, index) {
          if (button === null || button === undefined || !button.isConnected) return
          button.disabled = previousDisabled[index] === true
        })
      })
  }

  // ───────────────────────── 焦点与弹层公共 ─────────────────────────

  function restoreFocusOrFallback(node) {
    if (node !== null && node !== undefined && node.isConnected && node.disabled !== true) {
      focusElement(node)
      return
    }
    focusActiveTab()
  }

  function focusActiveTab() {
    for (const button of elements.tabButtons) {
      if (button.getAttribute('aria-selected') === 'true') {
        focusElement(button)
        return
      }
    }
    if (elements.tabButtons.length > 0) focusElement(elements.tabButtons[0])
  }

  function focusAfterDelete() {
    if (!validData(state.data)) {
      focusActiveTab()
      return
    }
    if (state.view === 'board') {
      focusElement(elements.addTaskText)
      return
    }
    if (state.view === 'schedule') {
      if (elements.addScheduleCard !== null && elements.addScheduleCard !== undefined && elements.addScheduleCard.hidden === false) {
        focusElement(elements.addScheduleTitle)
        return
      }
    }
    if (state.view === 'duty') {
      focusElement(elements.editDuty)
      return
    }
    focusActiveTab()
  }

  function closeAllModals(restore) {
    closeConfirm(false)
    closeGroupsEditor(false)
    closeDutyEditor(false)
    closeScheduleEditor(false)
    closeTaskEditor(false)
    if (restore === true) focusActiveTab()
  }

  function handleEscape(event) {
    if (event.key !== 'Escape') return
    if (isModalOpen(elements.confirmModal)) {
      event.preventDefault()
      closeConfirm(true)
      return
    }
    if (isModalOpen(elements.groupsEditorModal)) {
      event.preventDefault()
      closeGroupsEditor(true)
      return
    }
    if (isModalOpen(elements.dutyEditorModal)) {
      event.preventDefault()
      closeDutyEditor(true)
      return
    }
    if (isModalOpen(elements.scheduleEditorModal)) {
      event.preventDefault()
      closeScheduleEditor(true)
      return
    }
    if (isModalOpen(elements.taskEditorModal)) {
      event.preventDefault()
      closeTaskEditor(true)
    }
  }

  function handleTabKeys(event) {
    const key = event.key
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
    const buttons = elements.tabButtons
    if (buttons.length === 0) return
    const currentIndex = buttons.indexOf(document.activeElement)
    if (currentIndex < 0) return
    event.preventDefault()
    let nextIndex = currentIndex
    if (key === 'Home') nextIndex = 0
    else if (key === 'End') nextIndex = buttons.length - 1
    else if (key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length
    else nextIndex = (currentIndex - 1 + buttons.length) % buttons.length
    const target = buttons[nextIndex]
    focusElement(target)
    const view = target.getAttribute('data-view')
    if (view !== null) goToView(view)
  }

  function bindModalBackdrop(modal, close) {
    if (modal === null || modal === undefined) return
    modal.addEventListener('click', function (event) {
      if (event.target === modal) close(true)
    })
  }

  // ───────────────────────── 初始化 ─────────────────────────

  function byId(id) {
    return document.getElementById(id)
  }

  function cacheElements() {
    elements.app = byId('board-app')
    elements.classMeta = byId('class-meta')
    elements.weekMeta = byId('week-meta')
    elements.weekNav = byId('week-nav')
    elements.prevWeek = byId('prev-week')
    elements.thisWeek = byId('this-week')
    elements.nextWeek = byId('next-week')
    elements.tabs = byId('tabs')
    elements.tabButtons = elements.tabs === null ? [] : Array.prototype.slice.call(elements.tabs.querySelectorAll('.board-tab'))
    elements.readonlyNote = byId('readonly-note')
    elements.status = byId('status')

    elements.panels = {
      board: byId('view-board'),
      duty: byId('view-duty'),
      schedule: byId('view-schedule'),
      settings: byId('view-settings'),
    }

    elements.todayLabel = byId('today-label')
    elements.todaySub = byId('today-sub')
    elements.todayCounts = byId('today-counts')
    elements.progress = byId('progress')
    elements.progressFill = byId('progress-fill')
    elements.progressLabel = byId('progress-label')
    elements.dutyPill = byId('duty-pill')
    elements.addTaskForm = byId('add-task-form')
    elements.addTaskText = byId('add-task-text')
    elements.addTaskDueDate = byId('add-task-due-date')
    elements.addTaskDueTime = byId('add-task-due-time')
    elements.addTaskPriority = byId('add-task-priority')
    elements.addTaskCategory = byId('add-task-category')
    elements.addTaskAssignee = byId('add-task-assignee')
    elements.addTaskSubmit = byId('add-task-submit')
    elements.addTaskError = byId('add-task-error')
    elements.pendingCount = byId('pending-count')
    elements.pendingTasks = byId('pending-tasks')
    elements.doneCount = byId('done-count')
    elements.doneTasks = byId('done-tasks')
    elements.previewCount = byId('preview-count')
    elements.previewSchedule = byId('preview-schedule')
    elements.previewMore = byId('preview-more')
    elements.gotoSchedule = byId('goto-schedule')
    elements.announcementInput = byId('announcement-input')
    elements.saveAnnouncement = byId('save-announcement')

    elements.dutyTitle = byId('duty-title')
    elements.dutyInfo = byId('duty-info')
    elements.dutyMembers = byId('duty-members')
    elements.editDuty = byId('edit-duty')
    elements.rotationList = byId('rotation-list')
    elements.rotationOrder = byId('rotation-order')
    elements.groupsSummary = byId('groups-summary')
    elements.editGroups = byId('edit-groups')

    elements.addScheduleCard = byId('add-schedule-card')
    elements.addScheduleForm = byId('add-schedule-form')
    elements.addScheduleWeekday = byId('add-schedule-weekday')
    elements.addScheduleTime = byId('add-schedule-time')
    elements.addScheduleTitle = byId('add-schedule-title')
    elements.addSchedulePlace = byId('add-schedule-place')
    elements.addScheduleNote = byId('add-schedule-note')
    elements.addScheduleSubmit = byId('add-schedule-submit')
    elements.addScheduleError = byId('add-schedule-error')
    elements.scheduleTitle = byId('schedule-title')
    elements.scheduleCount = byId('schedule-count')
    elements.scheduleList = byId('schedule-list')

    elements.settingsInfo = byId('settings-info')
    elements.settingsStats = byId('settings-stats')
    elements.loadDemo = byId('load-demo')
    elements.loadDemoHint = byId('load-demo-hint')
    elements.clearScope = byId('clear-scope')
    elements.clearButton = byId('clear-button')
    elements.clearError = byId('clear-error')

    elements.taskEditorModal = byId('task-editor')
    elements.taskEditorText = byId('task-editor-text')
    elements.taskEditorDueDate = byId('task-editor-due-date')
    elements.taskEditorDueTime = byId('task-editor-due-time')
    elements.taskEditorPriority = byId('task-editor-priority')
    elements.taskEditorCategory = byId('task-editor-category')
    elements.taskEditorAssignee = byId('task-editor-assignee')
    elements.taskEditorDone = byId('task-editor-done')
    elements.taskEditorError = byId('task-editor-error')
    elements.taskEditorSave = byId('task-editor-save')
    elements.taskEditorDelete = byId('task-editor-delete')
    elements.taskEditorCancel = byId('task-editor-cancel')

    elements.scheduleEditorModal = byId('schedule-editor')
    elements.scheduleEditorWeekday = byId('schedule-editor-weekday')
    elements.scheduleEditorTime = byId('schedule-editor-time')
    elements.scheduleEditorTitleInput = byId('schedule-editor-title-input')
    elements.scheduleEditorPlace = byId('schedule-editor-place')
    elements.scheduleEditorNote = byId('schedule-editor-note')
    elements.scheduleEditorError = byId('schedule-editor-error')
    elements.scheduleEditorSave = byId('schedule-editor-save')
    elements.scheduleEditorCancel = byId('schedule-editor-cancel')

    elements.dutyEditorModal = byId('duty-editor')
    elements.dutyEditorTitle = byId('duty-editor-title')
    elements.dutyEditorGroup = byId('duty-editor-group')
    elements.dutyEditorNote = byId('duty-editor-note')
    elements.dutyEditorError = byId('duty-editor-error')
    elements.dutyEditorSave = byId('duty-editor-save')
    elements.dutyEditorCancel = byId('duty-editor-cancel')

    elements.groupsEditorModal = byId('groups-editor')
    elements.groupsEditorText = byId('groups-editor-text')
    elements.groupsEditorOrder = byId('groups-editor-order')
    elements.groupsEditorError = byId('groups-editor-error')
    elements.groupsEditorSave = byId('groups-editor-save')
    elements.groupsEditorCancel = byId('groups-editor-cancel')

    elements.confirmModal = byId('confirm-modal')
    elements.confirmTitle = byId('confirm-title')
    elements.confirmMessage = byId('confirm-message')
    elements.confirmError = byId('confirm-error')
    elements.confirmOk = byId('confirm-ok')
    elements.confirmCancel = byId('confirm-cancel')
  }

  function addTask() {
    if (!isEditable()) {
      showStatus('当前视图只读，不能添加事务', 'error')
      return
    }
    const text = elements.addTaskText === undefined || elements.addTaskText === null ? '' : elements.addTaskText.value.trim()
    if (text === '') {
      setInlineError(elements.addTaskError, '请先输入事务内容')
      focusElement(elements.addTaskText)
      return
    }
    const priorityValue = elements.addTaskPriority === undefined || elements.addTaskPriority === null ? 'normal' : elements.addTaskPriority.value
    const payload = {
      text,
      dueDate: elements.addTaskDueDate === undefined || elements.addTaskDueDate === null ? '' : elements.addTaskDueDate.value.trim(),
      dueTime: elements.addTaskDueTime === undefined || elements.addTaskDueTime === null ? '' : elements.addTaskDueTime.value.trim(),
      priority: PRIORITY_VALUES.includes(priorityValue) ? priorityValue : 'normal',
      category:
        elements.addTaskCategory === undefined || elements.addTaskCategory === null
          ? '作业'
          : elements.addTaskCategory.value.trim(),
      assignee:
        elements.addTaskAssignee === undefined || elements.addTaskAssignee === null
          ? ''
          : elements.addTaskAssignee.value.trim(),
    }
    runAction('add-task', payload, {
      buttons: [elements.addTaskSubmit],
      errorTarget: elements.addTaskError,
      onSuccess: function () {
        setValue(elements.addTaskText, '')
        setValue(elements.addTaskDueDate, '')
        setValue(elements.addTaskDueTime, '')
        setValue(elements.addTaskAssignee, '')
        setInlineError(elements.addTaskError, '')
        focusElement(elements.addTaskText)
      },
    })
  }

  function listen(node, type, handler) {
    if (node === null || node === undefined) return
    node.addEventListener(type, handler)
  }

  function bindEvents() {
    for (const button of elements.tabButtons) {
      listen(button, 'click', function () {
        const view = button.getAttribute('data-view')
        if (view !== null) goToView(view)
      })
    }
    listen(elements.tabs, 'keydown', handleTabKeys)

    listen(elements.prevWeek, 'click', function () {
      goToWeek(-1)
    })
    listen(elements.thisWeek, 'click', goToThisWeek)
    listen(elements.nextWeek, 'click', function () {
      goToWeek(1)
    })

    listen(elements.dutyPill, 'click', function () {
      openDutyEditor(elements.dutyPill)
    })
    listen(elements.editDuty, 'click', function () {
      openDutyEditor(elements.editDuty)
    })
    listen(elements.editGroups, 'click', function () {
      openGroupsEditor(elements.editGroups)
    })
    listen(elements.gotoSchedule, 'click', function () {
      goToView('schedule')
    })
    listen(elements.saveAnnouncement, 'click', saveAnnouncement)

    listen(elements.addTaskForm, 'submit', function (event) {
      event.preventDefault()
      addTask()
    })
    listen(elements.addScheduleForm, 'submit', function (event) {
      event.preventDefault()
      addSchedule()
    })

    listen(elements.loadDemo, 'click', requestLoadDemo)
    listen(elements.clearButton, 'click', requestClearScope)

    listen(elements.taskEditorSave, 'click', saveTaskEditor)
    listen(elements.taskEditorDelete, 'click', requestTaskDeleteFromEditor)
    listen(elements.taskEditorCancel, 'click', function () {
      closeTaskEditor(true)
    })

    listen(elements.scheduleEditorSave, 'click', saveScheduleEditor)
    listen(elements.scheduleEditorCancel, 'click', function () {
      closeScheduleEditor(true)
    })

    listen(elements.dutyEditorSave, 'click', saveDutyEditor)
    listen(elements.dutyEditorCancel, 'click', function () {
      closeDutyEditor(true)
    })

    listen(elements.groupsEditorSave, 'click', saveGroupsEditor)
    listen(elements.groupsEditorCancel, 'click', function () {
      closeGroupsEditor(true)
    })

    listen(elements.confirmOk, 'click', proceedConfirm)
    listen(elements.confirmCancel, 'click', function () {
      closeConfirm(true)
    })

    bindModalBackdrop(elements.taskEditorModal, closeTaskEditor)
    bindModalBackdrop(elements.scheduleEditorModal, closeScheduleEditor)
    bindModalBackdrop(elements.dutyEditorModal, closeDutyEditor)
    bindModalBackdrop(elements.groupsEditorModal, closeGroupsEditor)
    bindModalBackdrop(elements.confirmModal, closeConfirm)

    document.addEventListener('keydown', handleEscape)
  }

  function boot() {
    if (state.booted) return
    state.booted = true
    cacheElements()

    if (elements.app === null && elements.status === null) return
    if (elements.status !== null && elements.status !== undefined) {
      elements.status.setAttribute('role', 'status')
      elements.status.setAttribute('aria-live', 'polite')
    }

    bindEvents()
    updateNavDisabled()
    subscribeBoardEvents()
    requestLoadNow()
  }

  // defer 会保证 DOM 就绪后再执行；若脚本被其它方式提前载入，则等 DOMContentLoaded。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
