'use strict'

/**
 * 页面型「班级周历」前端脚本。
 *
 * 页面运行在 Aurora 的沙箱里，只使用 window.auroraPlugin.request 与
 * window.auroraPlugin.onEvent；不访问宿主其它对象，也不使用网络或文件系统。
 *
 * 结构约定：
 * - 服务端每次动作都返回整周数据，动作成功后直接使用返回值重绘；
 * - load 请求做单飞 + 序号丢弃：同一时间只有一个 load 在飞，旧响应不会
 *   覆盖新视图；
 * - board.changed 事件只负责触发一次去抖后的重新加载；
 * - 所有用户内容都通过 createElement / textContent / value 写入，不拼 HTML。
 */
;(function () {
  'use strict'

  const MIN_WEEK_OFFSET = -12
  const MAX_WEEK_OFFSET = 12
  const RELOAD_DEBOUNCE_MS = 200
  const STATUS_CLEAR_MS = 3000

  const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const PRIORITY_VALUES = ['high', 'normal', 'low']
  const PRIORITY_LABELS = { high: '高优先级', normal: '普通', low: '低优先级' }

  const elements = {}
  const state = {
    booted: false,
    weekOffset: 0,
    data: null,
    dataVersion: 0,
    latestLoadId: 0,
    loadInFlight: false,
    loadQueued: false,
    reloadTimer: null,
    statusTimer: null,
    draggingTaskId: '',
    editorTaskId: '',
    scheduleMode: '',
    scheduleId: '',
    focusReturn: null,
    unsubscribe: null,
  }

  // ───────────────────────── 小工具 ─────────────────────────

  function clampOffset(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.min(MAX_WEEK_OFFSET, Math.max(MIN_WEEK_OFFSET, Math.trunc(number)))
  }

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
    return data !== null && typeof data === 'object' && Array.isArray(data.days)
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
      // 输入框已从文档移除时浏览器可能拒绝聚焦，忽略即可。
    }
  }

  function restoreFocus(node) {
    if (node === null || node === undefined) return
    if (!document.documentElement.contains(node) || node.disabled === true) return
    focusElement(node)
  }

  function setInlineError(node, message) {
    if (node === null || node === undefined) return
    node.textContent = message === undefined || message === null ? '' : String(message)
    if (node.textContent === '') node.hidden = true
    else node.hidden = false
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
    if (kind === 'error') {
      state.statusTimer = window.setTimeout(function () {
        state.statusTimer = null
        if (status.textContent === text) {
          status.textContent = ''
          status.removeAttribute('data-kind')
        }
      }, STATUS_CLEAR_MS)
    }
  }

  function setAppBusy(busy) {
    if (elements.app === null || elements.app === undefined) return
    if (busy) elements.app.setAttribute('aria-busy', 'true')
    else elements.app.removeAttribute('aria-busy')
  }

  function findDayByDate(data, date) {
    if (!validData(data)) return null
    for (const day of data.days) {
      if (day !== null && typeof day === 'object' && day.date === date) return day
    }
    return null
  }

  function isDayEditable(data, day) {
    if (!validData(data) || day === null || day === undefined) return false
    // 周级可编辑：本周内过去天也能编辑/删除/完成，只有过去周整体只读。
    return data.canEdit !== false && day.canEdit !== false
  }

  /** 这一天能不能新增事务（过去天不能新增，但已有事务仍可编辑/删除）。 */
  function canAddTaskToDay(data, day) {
    if (!isDayEditable(data, day)) return false
    return day.canAddTask !== false
  }

  function findTaskInData(data, id) {
    if (!validData(data)) return null
    const target = textOf(id)
    for (const day of data.days) {
      if (day === null || typeof day !== 'object' || !Array.isArray(day.tasks)) continue
      for (const task of day.tasks) {
        if (task !== null && typeof task === 'object' && textOf(task.id) === target) {
          return { task, day }
        }
      }
    }
    return null
  }

  function findScheduleInData(data, id) {
    if (!validData(data)) return null
    const target = textOf(id)
    for (const day of data.days) {
      if (day === null || typeof day !== 'object' || !Array.isArray(day.schedule)) continue
      for (const entry of day.schedule) {
        if (entry !== null && typeof entry === 'object' && textOf(entry.id) === target) {
          return { entry, day }
        }
      }
    }
    return null
  }

  // ───────────────────────── 宿主通信 ─────────────────────────

  /**
   * 统一调用宿主 request：同步异常、Promise reject、空结果都转换成
   * `{ error }`，避免某个分支把错误漏到控制台。
   */
  function request(method, params) {
    if (!window.auroraPlugin || typeof window.auroraPlugin.request !== 'function') {
      return Promise.resolve({ error: '页面通信不可用，请重新打开班级周历' })
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

  // ───────────────────────── 周切换与加载 ─────────────────────────

  function setNavigationDisabled() {
    if (elements.prevWeek !== null && elements.prevWeek !== undefined) {
      elements.prevWeek.disabled = state.weekOffset <= MIN_WEEK_OFFSET
    }
    if (elements.nextWeek !== null && elements.nextWeek !== undefined) {
      elements.nextWeek.disabled = state.weekOffset >= MAX_WEEK_OFFSET
    }
    // “本周”始终可点：即使已经在第 0 周，也允许手动再拉一次最新数据。
    if (elements.thisWeek !== null && elements.thisWeek !== undefined) {
      elements.thisWeek.disabled = false
    }
  }

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
    const loadId = state.latestLoadId
    if (state.loadInFlight) {
      state.loadQueued = true
      return
    }
    startLoad(loadId)
  }

  function startLoad(loadId) {
    state.loadInFlight = true
    setAppBusy(true)
    const offsetAtStart = state.weekOffset
    const versionAtStart = state.dataVersion

    request('load', { weekOffset: offsetAtStart })
      .then(function (result) {
        // 请求期间用户切了周，或有新动作数据落地：这份结果已经过期。
        if (loadId !== state.latestLoadId) return
        if (state.weekOffset !== offsetAtStart) return
        if (state.dataVersion !== versionAtStart) return

        const error = resultError(result)
        const loaded = validData(result.data) ? applyData(result.data, false) : false
        if (error !== '') showStatus(error, 'error')
        else if (resultMessage(result) !== '') showStatus(resultMessage(result), 'ok')
        else if (!loaded) showStatus('未能加载周历数据，请重试', 'error')
      })
      .catch(function (error) {
        if (loadId !== state.latestLoadId) return
        if (state.weekOffset !== offsetAtStart) return
        if (state.dataVersion !== versionAtStart) return
        showStatus('加载周历失败：' + messageOf(error), 'error')
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
    setAppBusy(false)
  }

  function applyData(data, fromAction) {
    if (!validData(data)) return false
    state.data = data
    if (Number.isFinite(Number(data.weekOffset))) state.weekOffset = clampOffset(data.weekOffset)
    if (fromAction) state.dataVersion += 1
    renderAll()
    return true
  }

  function changeWeek(delta) {
    const next = clampOffset(state.weekOffset + delta)
    if (next === state.weekOffset) return
    switchWeek(next)
  }

  function goToThisWeek() {
    if (state.weekOffset === 0) {
      cancelReloadTimer()
      requestLoadNow()
      return
    }
    switchWeek(0)
  }

  function switchWeek(offset) {
    const next = clampOffset(offset)
    if (next === state.weekOffset) return
    cancelReloadTimer()
    closeAllModals(false)
    state.weekOffset = next
    setNavigationDisabled()
    requestLoadNow()
  }

  // ───────────────────────── 动作请求 ─────────────────────────

  /**
   * 执行一个写操作。参数里始终补上当前 weekOffset：后端用它来返回当前视图的
   * 整周数据（toggle/update/delete 也依赖它定位当前周）。事件带来的旧响应
   * 会被 applyData 的版本检查排除。
   */
  function runAction(method, params, options) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    const viewOffset = state.weekOffset
    const requestParams = {}
    if (params !== null && typeof params === 'object') {
      for (const key of Object.keys(params)) requestParams[key] = params[key]
    }
    requestParams.weekOffset = viewOffset

    if (opts.errorTarget) setInlineError(opts.errorTarget, '')
    const buttons = Array.isArray(opts.buttons)
      ? opts.buttons.filter(function (button) {
          return button !== null && button !== undefined
        })
      : []
    const previousDisabled = buttons.map(function (button) {
      return button.disabled === true
    })
    for (const button of buttons) button.disabled = true

    return request(method, requestParams)
      .then(function (result) {
        const error = resultError(result)
        const message = resultMessage(result)
        const viewUnchanged = state.weekOffset === viewOffset
        let applied = false

        if (viewUnchanged && validData(result.data)) {
          applied = applyData(result.data, true)
        }

        if (error !== '') {
          setInlineError(opts.errorTarget, error)
          showStatus(error, 'error')
          if (opts.reloadOnError === true) requestLoadNow()
          if (typeof opts.onError === 'function') opts.onError(error, result)
        } else {
          if (message !== '') showStatus(message, 'ok')
          if (!applied && viewUnchanged) requestLoadNow()
          if (typeof opts.onSuccess === 'function') opts.onSuccess(result, applied)
        }

        return {
          error,
          message,
          applied,
          data: validData(result.data) ? result.data : null,
        }
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
        // 只有仍在文档里的按钮才恢复；若期间数据重绘，旧按钮已经离开文档。
        buttons.forEach(function (button, index) {
          if (!button.isConnected) return
          if (button === elements.saveAnnouncement) {
            button.disabled = !(validData(state.data) && state.data.canEdit !== false)
            return
          }
          button.disabled = previousDisabled[index] === true
        })
        return outcome
      })
  }

  // ───────────────────────── 渲染 ─────────────────────────

  function renderAll() {
    if (!validData(state.data)) return
    renderHeader(state.data)
    renderDays(state.data)
  }

  function renderHeader(data) {
    const canEdit = data.canEdit !== false

    if (elements.weekMeta !== null && elements.weekMeta !== undefined) {
      let meta = textOf(data.weekLabel)
      if (meta === '') meta = '第 ' + countOf(data.weekNumber) + ' 周'
      if (data.isCurrentWeek === true) meta += ' · 本周'
      else if (data.weekOffset < 0 || !canEdit) meta += ' · 过去周'
      else meta += ' · 未来周'
      if (!canEdit) meta += '（只读）'
      elements.weekMeta.textContent = meta
    }

    if (elements.stats !== null && elements.stats !== undefined) {
      const stats = data.stats !== null && typeof data.stats === 'object' ? data.stats : {}
      // 拆成子元素，和 calendar.css 的 .cal-stats > * 规则配合，窄栏下可换行。
      const parts = [
        '待办 ' + countOf(stats.pending) + ' / ',
        '完成 ' + countOf(stats.done) + ' / ',
        '逾期 ' + countOf(stats.overdue),
      ]
      clearChildren(elements.stats)
      for (const part of parts) {
        const item = document.createElement('span')
        item.textContent = part
        elements.stats.appendChild(item)
      }
    }

    if (elements.dutySummary !== null && elements.dutySummary !== undefined) {
      elements.dutySummary.textContent = dutySummaryText(data)
      elements.dutySummary.disabled = !canEdit
    }

    if (elements.announcement !== null && elements.announcement !== undefined) {
      const announcement = textOf(data.announcement)
      elements.announcement.textContent = announcement.trim() === '' ? '暂无通知' : announcement
    }

    if (elements.announcementInput !== null && elements.announcementInput !== undefined) {
      elements.announcementInput.disabled = !canEdit
      if (!canEdit && document.activeElement === elements.announcementInput) {
        elements.announcementInput.blur()
      }
      // 输入框聚焦时绝不覆盖，避免打断用户正在编辑的通知。
      if (document.activeElement !== elements.announcementInput) {
        elements.announcementInput.value = textOf(data.announcement)
      }
    }
    if (elements.saveAnnouncement !== null && elements.saveAnnouncement !== undefined) {
      elements.saveAnnouncement.disabled = !canEdit
    }

    setNavigationDisabled()
  }

  function dutySummaryText(data) {
    const dutyRaw = data !== null && typeof data === 'object' ? data.duty : null
    const duty = dutyRaw !== null && typeof dutyRaw === 'object' ? dutyRaw : {}
    const parts = []
    const groupName = textOf(duty.groupName).trim()
    parts.push(groupName === '' ? '待安排' : groupName)

    if (Array.isArray(duty.members) && duty.members.length > 0) {
      const members = duty.members
        .map(function (member) {
          return textOf(member).trim()
        })
        .filter(function (member) {
          return member !== ''
        })
      if (members.length > 0) parts.push(members.join('、'))
    }

    const note = textOf(duty.note).trim()
    if (note !== '') parts.push(note)

    const prefix = data !== null && typeof data === 'object' && data.isCurrentWeek === true ? '本周值日：' : '该周值日：'
    return prefix + parts.join(' · ')
  }

  function renderDays(data) {
    const container = elements.days
    if (container === null || container === undefined) return
    const previousScrollTop = container.scrollTop
    const fragment = document.createDocumentFragment()
    for (const day of data.days) {
      if (day === null || typeof day !== 'object') continue
      fragment.appendChild(buildDayCard(data, day))
    }
    clearChildren(container)
    container.appendChild(fragment)
    container.scrollTop = previousScrollTop
  }

  function buildDayCard(data, day) {
    const canEditDay = isDayEditable(data, day)
    const canAddTask = canAddTaskToDay(data, day)
    const section = document.createElement('section')
    section.className = 'cal-day'
    if (day.isToday === true) section.classList.add('is-today')
    if (day.isToday !== true && day.isPast === true) section.classList.add('is-past')
    if (day.date !== undefined && day.date !== null) {
      section.setAttribute('data-date', textOf(day.date))
    }

    section.addEventListener('dragover', function (event) {
      handleDayDragOver(event, textOf(day.date))
    })
    section.addEventListener('drop', function (event) {
      handleDayDrop(event, textOf(day.date))
    })

    const header = document.createElement('header')
    header.className = 'cal-day-head'

    const label = document.createElement('span')
    label.className = 'cal-day-label'
    label.textContent = textOf(day.label) === '' ? textOf(day.date) : textOf(day.label)
    header.appendChild(label)

    const badge = document.createElement('span')
    badge.className = 'cal-day-badge'
    if (day.isToday === true) badge.textContent = '今天'
    else if (day.isPast === true) badge.textContent = '过去'
    header.appendChild(badge)

    const scheduleAdd = document.createElement('button')
    scheduleAdd.type = 'button'
    scheduleAdd.className = 'cal-schedule-add'
    scheduleAdd.textContent = '＋ 安排'
    scheduleAdd.disabled = !canEditDay
    scheduleAdd.addEventListener('click', function () {
      openScheduleEditorForDay(day.date)
    })
    header.appendChild(scheduleAdd)
    section.appendChild(header)

    const taskList = document.createElement('div')
    taskList.className = 'cal-day-tasks'
    const tasks = Array.isArray(day.tasks) ? day.tasks : []
    if (tasks.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'cal-empty'
      empty.textContent = '暂无事务'
      taskList.appendChild(empty)
    } else {
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue
        taskList.appendChild(buildTaskRow(task, canEditDay))
      }
    }
    section.appendChild(taskList)

    const scheduleList = document.createElement('div')
    scheduleList.className = 'cal-day-schedule'
    const schedule = Array.isArray(day.schedule) ? day.schedule : []
    for (const entry of schedule) {
      if (entry === null || typeof entry !== 'object') continue
      scheduleList.appendChild(buildScheduleRow(entry, canEditDay))
    }
    section.appendChild(scheduleList)

    section.appendChild(buildAddForm(day, canAddTask))
    return section
  }

  function buildTaskRow(task, canEditDay) {
    const taskId = textOf(task.id)
    const row = document.createElement('div')
    row.className = 'cal-task'
    row.setAttribute('data-task-id', taskId)
    if (task.done === true) row.classList.add('is-done')
    if (canEditDay) {
      row.classList.add('is-draggable')
      row.draggable = true
    } else {
      row.draggable = false
    }

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'cal-task-toggle'
    toggle.textContent = task.done === true ? '✓' : '○'
    toggle.disabled = !canEditDay
    toggle.title = task.done === true ? '恢复为待办' : '标记完成'
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
    const metaParts = []
    if (trimmedOf(task.dueLabel) !== '') metaParts.push(textOf(task.dueLabel))
    if (task.priority === 'high' || task.priority === 'low') {
      metaParts.push(PRIORITY_LABELS[task.priority])
    }
    if (trimmedOf(task.assignee) !== '') metaParts.push(textOf(task.assignee))
    if (task.overdue === true) metaParts.push('已逾期')
    meta.textContent = metaParts.join(' · ')
    row.appendChild(meta)

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cal-task-edit'
    edit.textContent = '编辑'
    edit.disabled = !canEditDay
    edit.addEventListener('click', function () {
      openTaskEditor(taskId)
    })
    row.appendChild(edit)

    if (canEditDay) {
      row.addEventListener('dragstart', function (event) {
        handleTaskDragStart(event, taskId)
      })
      row.addEventListener('dragend', function () {
        state.draggingTaskId = ''
      })
    } else {
      row.addEventListener('dragstart', function (event) {
        event.preventDefault()
      })
    }

    return row
  }

  function buildScheduleRow(entry, canEditDay) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'cal-schedule-row'
    row.disabled = !canEditDay
    row.setAttribute('data-schedule-id', textOf(entry.id))

    const time = document.createElement('span')
    time.className = 'cal-schedule-time'
    const timeText = trimmedOf(entry.time)
    time.textContent = timeText === '' ? '全天' : timeText
    row.appendChild(time)

    const title = document.createElement('span')
    title.className = 'cal-schedule-title'
    title.textContent = textOf(entry.title)
    row.appendChild(title)

    if (trimmedOf(entry.place) !== '') {
      const place = document.createElement('span')
      place.className = 'cal-schedule-place'
      place.textContent = textOf(entry.place)
      row.appendChild(place)
    }

    row.addEventListener('click', function () {
      openScheduleEditorForEntry(textOf(entry.id))
    })
    return row
  }

  function buildAddForm(day, canAddTask) {
    const form = document.createElement('form')
    form.className = 'cal-add-form'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'cal-add-input'
    input.placeholder = day.isToday === true ? '添加今天的事务…' : '添加 ' + textOf(day.label) + ' 的事务…'
    input.disabled = !canAddTask
    form.appendChild(input)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cal-add-btn'
    button.textContent = '添加'
    button.disabled = !canAddTask
    form.appendChild(button)

    let busy = false
    const submit = function () {
      if (busy) return
      const data = state.data
      const freshDay = findDayByDate(data, day.date)
      if (!canAddTaskToDay(data, freshDay)) return
      const content = input.value.trim()
      if (content === '') {
        showStatus('请先输入事务内容', 'error')
        focusElement(input)
        return
      }

      busy = true
      input.disabled = true
      button.disabled = true
      const viewOffset = state.weekOffset
      runAction('add-task', { date: textOf(day.date), text: content }).then(function (outcome) {
        busy = false
        if (input.isConnected) {
          const currentDay = findDayByDate(state.data, day.date)
          const editable = canAddTaskToDay(state.data, currentDay)
          input.disabled = !editable
          button.disabled = !editable
          if (outcome.error === '' && !editable) input.value = ''
        }
        if (outcome.error === '') {
          input.value = ''
          if (state.weekOffset === viewOffset) {
            const nextInput = findAddInput(day.date)
            focusElement(nextInput)
          }
        } else if (input.isConnected) {
          focusElement(input)
        }
      })
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault()
      submit()
    })
    button.addEventListener('click', function (event) {
      event.preventDefault()
      submit()
    })
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing) return
      event.preventDefault()
      submit()
    })

    return form
  }

  function findAddInput(date) {
    if (elements.days === null || elements.days === undefined) return null
    const sections = elements.days.querySelectorAll('.cal-day')
    for (const section of sections) {
      if (section.getAttribute('data-date') !== date) continue
      return section.querySelector('.cal-add-input')
    }
    return null
  }

  // ───────────────────────── 事务操作 ─────────────────────────

  function toggleTask(taskId, button) {
    const found = findTaskInData(state.data, taskId)
    if (found === null) {
      showStatus('这条事务已不存在，请刷新后重试', 'error')
      return
    }
    if (!isDayEditable(state.data, found.day)) {
      showStatus('该事务所在的日期不可编辑', 'error')
      return
    }
    runAction('toggle-task', { id: textOf(found.task.id) }, {
      buttons: [button],
    })
  }

  function openTaskEditor(taskId) {
    const found = findTaskInData(state.data, taskId)
    if (found === null) {
      showStatus('这条事务已不存在，请刷新后重试', 'error')
      return
    }
    if (!isDayEditable(state.data, found.day)) {
      showStatus('该事务所在的日期不可编辑', 'error')
      return
    }
    if (elements.editor === null || elements.editor === undefined) return

    const previousFocus = document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== document.body ? previousFocus : null
    state.editorTaskId = textOf(found.task.id)

    if (elements.editorTitle !== null && elements.editorTitle !== undefined) {
      elements.editorTitle.textContent = '编辑事务'
    }
    setValue(elements.editorText, textOf(found.task.text))
    setValue(elements.editorDueDate, textOf(found.task.dueDate))
    setValue(elements.editorDueTime, textOf(found.task.dueTime))
    const priority = PRIORITY_VALUES.includes(found.task.priority) ? found.task.priority : 'normal'
    setValue(elements.editorPriority, priority)
    setValue(elements.editorCategory, textOf(found.task.category))
    setValue(elements.editorAssignee, textOf(found.task.assignee))
    if (elements.editorDone !== null && elements.editorDone !== undefined) {
      elements.editorDone.checked = found.task.done === true
    }
    if (elements.editorSave !== null && elements.editorSave !== undefined) {
      elements.editorSave.disabled = false
    }
    if (elements.editorDelete !== null && elements.editorDelete !== undefined) {
      elements.editorDelete.hidden = false
      elements.editorDelete.disabled = false
    }
    setInlineError(elements.editorError, '')
    elements.editor.hidden = false
    focusElement(elements.editorText)
  }

  function setValue(node, value) {
    if (node === null || node === undefined) return
    node.value = value === undefined || value === null ? '' : String(value)
  }

  function closeEditor(restore) {
    const editor = elements.editor
    if (editor === null || editor === undefined) return
    const wasOpen = editor.hidden === false
    editor.hidden = true
    state.editorTaskId = ''
    setInlineError(elements.editorError, '')
    if (wasOpen && restore === true) {
      const target = state.focusReturn
      state.focusReturn = null
      restoreFocus(target)
    } else if (wasOpen) {
      state.focusReturn = null
    }
  }

  function saveTaskEditor() {
    const taskId = state.editorTaskId
    if (taskId === '') return
    const found = findTaskInData(state.data, taskId)
    if (found === null) {
      const error = '这条事务已不存在，请刷新后重试'
      setInlineError(elements.editorError, error)
      showStatus(error, 'error')
      return
    }
    if (!isDayEditable(state.data, found.day)) {
      const error = '该事务所在的日期不可编辑'
      setInlineError(elements.editorError, error)
      showStatus(error, 'error')
      return
    }

    const text = elements.editorText ? elements.editorText.value.trim() : ''
    if (text === '') {
      const error = '请填写事务内容'
      setInlineError(elements.editorError, error)
      showStatus(error, 'error')
      focusElement(elements.editorText)
      return
    }

    const priorityValue = elements.editorPriority ? elements.editorPriority.value : 'normal'
    const priority = PRIORITY_VALUES.includes(priorityValue) ? priorityValue : 'normal'
    const payload = {
      id: taskId,
      text,
      dueDate: elements.editorDueDate ? elements.editorDueDate.value.trim() : '',
      dueTime: elements.editorDueTime ? elements.editorDueTime.value.trim() : '',
      priority,
      category: elements.editorCategory ? elements.editorCategory.value.trim() : '',
      assignee: elements.editorAssignee ? elements.editorAssignee.value.trim() : '',
      done: Boolean(elements.editorDone && elements.editorDone.checked),
    }

    runAction('update-task', payload, {
      buttons: [elements.editorSave, elements.editorDelete],
      errorTarget: elements.editorError,
      onSuccess: function () {
        closeEditor(false)
      },
    })
  }

  function deleteTaskFromEditor() {
    const taskId = state.editorTaskId
    if (taskId === '') return
    const found = findTaskInData(state.data, taskId)
    if (found === null) {
      const error = '这条事务已不存在，请刷新后重试'
      setInlineError(elements.editorError, error)
      showStatus(error, 'error')
      return
    }
    if (!isDayEditable(state.data, found.day)) {
      const error = '该事务所在的日期不可编辑'
      setInlineError(elements.editorError, error)
      showStatus(error, 'error')
      return
    }
    runAction('delete-task', { id: taskId }, {
      buttons: [elements.editorSave, elements.editorDelete],
      errorTarget: elements.editorError,
      onSuccess: function () {
        closeEditor(false)
      },
    })
  }

  // ───────────────────────── 事务拖动 ─────────────────────────

  function handleTaskDragStart(event, taskId) {
    const found = findTaskInData(state.data, taskId)
    if (found === null || !isDayEditable(state.data, found.day)) {
      event.preventDefault()
      return
    }
    state.draggingTaskId = taskId
    if (!event.dataTransfer) return
    try {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', taskId)
    } catch (error) {
      // 部分宿主对 dataTransfer 写入有限制；拖拽 id 已保存在内存中，仍可完成放置。
    }
  }

  function handleDayDragOver(event, date) {
    if (state.draggingTaskId === '') return
    const day = findDayByDate(state.data, date)
    if (!canAddTaskToDay(state.data, day)) return
    event.preventDefault()
    if (event.dataTransfer) {
      try {
        event.dataTransfer.dropEffect = 'move'
      } catch (error) {
        // dropEffect 只是视觉提示，不可写时忽略。
      }
    }
  }

  function handleDayDrop(event, date) {
    const day = findDayByDate(state.data, date)
    if (!canAddTaskToDay(state.data, day)) return
    let taskId = state.draggingTaskId
    if (taskId === '' && event.dataTransfer) {
      try {
        taskId = event.dataTransfer.getData('text/plain')
      } catch (error) {
        taskId = ''
      }
    }
    if (taskId === '') return
    event.preventDefault()
    state.draggingTaskId = ''
    runAction('move-task', { id: taskId, date }, { reloadOnError: true })
  }

  // ───────────────────────── 安排弹层 ─────────────────────────

  function ensureWeekdayOptions(select) {
    if (select === null || select === undefined || select.tagName !== 'SELECT') return
    if (select.options.length > 0) return
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const option = document.createElement('option')
      option.value = String(weekday)
      option.textContent = WEEKDAY_NAMES[weekday - 1]
      select.appendChild(option)
    }
  }

  function setWeekdayValue(select, weekday) {
    if (select === null || select === undefined) return
    ensureWeekdayOptions(select)
    select.value = String(weekday)
    if (select.value === '' && select.tagName === 'SELECT') {
      const option = document.createElement('option')
      option.value = String(weekday)
      option.textContent = WEEKDAY_NAMES[weekday - 1] || ''
      select.appendChild(option)
      select.value = String(weekday)
    }
  }

  function openScheduleEditorForDay(date) {
    const data = state.data
    if (!validData(data) || data.canEdit === false) return
    const day = findDayByDate(data, date)
    if (!isDayEditable(data, day)) return
    showScheduleEditor('add', day, null)
  }

  function openScheduleEditorForEntry(entryId) {
    const data = state.data
    if (!validData(data) || data.canEdit === false) return
    const found = findScheduleInData(data, entryId)
    if (found === null) {
      showStatus('这条安排已不存在，请刷新后重试', 'error')
      requestLoadNow()
      return
    }
    if (!isDayEditable(data, found.day)) return
    showScheduleEditor('edit', found.day, found.entry)
  }

  function showScheduleEditor(mode, day, entry) {
    if (elements.scheduleEditor === null || elements.scheduleEditor === undefined) return
    const previousFocus = document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== document.body ? previousFocus : null
    state.scheduleMode = mode
    state.scheduleId = entry === null ? '' : textOf(entry.id)

    setWeekdayValue(elements.scheduleWeekday, entry === null ? day.weekday : entry.weekday)
    setValue(elements.scheduleTime, entry === null ? '' : textOf(entry.time))
    setValue(elements.scheduleTitle, entry === null ? '' : textOf(entry.title))
    setValue(elements.schedulePlace, entry === null ? '' : textOf(entry.place))

    if (elements.scheduleDelete !== null && elements.scheduleDelete !== undefined) {
      elements.scheduleDelete.hidden = mode !== 'edit'
      elements.scheduleDelete.disabled = false
    }
    if (elements.scheduleSave !== null && elements.scheduleSave !== undefined) {
      elements.scheduleSave.disabled = false
    }
    setInlineError(elements.scheduleError, '')
    elements.scheduleEditor.hidden = false
    focusElement(elements.scheduleTitle)
  }

  function closeScheduleEditor(restore) {
    const editor = elements.scheduleEditor
    if (editor === null || editor === undefined) return
    const wasOpen = editor.hidden === false
    editor.hidden = true
    state.scheduleMode = ''
    state.scheduleId = ''
    setInlineError(elements.scheduleError, '')
    if (wasOpen && restore === true) {
      const target = state.focusReturn
      state.focusReturn = null
      restoreFocus(target)
    } else if (wasOpen) {
      state.focusReturn = null
    }
  }

  function saveScheduleEditor() {
    const data = state.data
    if (!validData(data) || data.canEdit === false) {
      const error = '当前周为只读，不能修改安排'
      setInlineError(elements.scheduleError, error)
      showStatus(error, 'error')
      return
    }

    const title = elements.scheduleTitle ? elements.scheduleTitle.value.trim() : ''
    if (title === '') {
      const error = '请填写安排事项'
      setInlineError(elements.scheduleError, error)
      showStatus(error, 'error')
      focusElement(elements.scheduleTitle)
      return
    }
    const weekday = Number(elements.scheduleWeekday ? elements.scheduleWeekday.value : 0)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      const error = '请选择周几'
      setInlineError(elements.scheduleError, error)
      showStatus(error, 'error')
      focusElement(elements.scheduleWeekday)
      return
    }
    const targetDay = data.days.find(function (item) {
      return item !== null && typeof item === 'object' && item.weekday === weekday
    })
    if (targetDay === undefined || targetDay.canEdit === false) {
      const error = '不能把安排放到过去日期'
      setInlineError(elements.scheduleError, error)
      showStatus(error, 'error')
      return
    }

    const time = elements.scheduleTime ? elements.scheduleTime.value.trim() : ''
    const place = elements.schedulePlace ? elements.schedulePlace.value.trim() : ''
    const options = {
      buttons: [elements.scheduleSave, elements.scheduleDelete],
      errorTarget: elements.scheduleError,
      onSuccess: function () {
        closeScheduleEditor(false)
      },
    }

    if (state.scheduleMode === 'edit') {
      if (state.scheduleId === '') return
      runAction(
        'update-schedule',
        {
          id: state.scheduleId,
          weekday,
          time,
          title,
          place,
        },
        options,
      )
      return
    }

    runAction('add-schedule', { weekday, time, title, place }, options)
  }

  function deleteScheduleEntry() {
    if (state.scheduleMode !== 'edit' || state.scheduleId === '') return
    const data = state.data
    if (!validData(data) || data.canEdit === false) {
      const error = '当前周为只读，不能删除安排'
      setInlineError(elements.scheduleError, error)
      showStatus(error, 'error')
      return
    }
    runAction('delete-schedule', { id: state.scheduleId }, {
      buttons: [elements.scheduleSave, elements.scheduleDelete],
      errorTarget: elements.scheduleError,
      onSuccess: function () {
        closeScheduleEditor(false)
      },
    })
  }

  // ───────────────────────── 值日弹层 ─────────────────────────

  function openDutyEditor() {
    if (!validData(state.data) || state.data.canEdit === false) return
    if (elements.dutyEditor === null || elements.dutyEditor === undefined) return
    const previousFocus = document.activeElement
    closeAllModals(false)
    state.focusReturn =
      previousFocus !== null && previousFocus !== document.body ? previousFocus : null

    fillDutyGroups(state.data)
    setValue(elements.dutyNote, textOf(state.data.duty && state.data.duty.note))
    setInlineError(elements.dutyError, '')
    if (elements.dutySave !== null && elements.dutySave !== undefined) {
      elements.dutySave.disabled = false
    }
    elements.dutyEditor.hidden = false
    const dutyTitle = document.getElementById('duty-editor-title')
    if (dutyTitle !== null) {
      dutyTitle.textContent =
        state.data.isCurrentWeek === true ? '本周值日' : '该周值日'
    }
    focusElement(elements.dutyGroup)
  }

  function fillDutyGroups(data) {
    const select = elements.dutyGroup
    if (select === null || select === undefined) return
    clearChildren(select)
    const groups = Array.isArray(data.groups) ? data.groups : []
    const groupNames = []
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue
      const name = textOf(group.name)
      if (name === '') continue
      groupNames.push(name)
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }

    const auto = document.createElement('option')
    auto.value = ''
    auto.textContent = '自动轮换（按顺序）'
    select.appendChild(auto)

    const duty = data.duty !== null && typeof data.duty === 'object' ? data.duty : {}
    const selected =
      duty.hasOverrideGroup === true && groupNames.includes(textOf(duty.groupName))
        ? textOf(duty.groupName)
        : ''
    select.value = selected
  }

  function closeDutyEditor(restore) {
    const editor = elements.dutyEditor
    if (editor === null || editor === undefined) return
    const wasOpen = editor.hidden === false
    editor.hidden = true
    setInlineError(elements.dutyError, '')
    if (wasOpen && restore === true) {
      const target = state.focusReturn
      state.focusReturn = null
      restoreFocus(target)
    } else if (wasOpen) {
      state.focusReturn = null
    }
  }

  function saveDutyEditor() {
    if (!validData(state.data) || state.data.canEdit === false) {
      const error = '当前周为只读，不能修改值日'
      setInlineError(elements.dutyError, error)
      showStatus(error, 'error')
      return
    }
    const groupName = elements.dutyGroup ? elements.dutyGroup.value : ''
    const note = elements.dutyNote ? elements.dutyNote.value.trim() : ''
    runAction('set-duty-week', { groupName, note }, {
      buttons: [elements.dutySave],
      errorTarget: elements.dutyError,
      onSuccess: function () {
        closeDutyEditor(false)
      },
    })
  }

  // ───────────────────────── 通知 ─────────────────────────

  function saveAnnouncement() {
    if (!validData(state.data) || state.data.canEdit === false) {
      showStatus('当前周为只读，不能修改通知', 'error')
      return
    }
    if (elements.announcementInput === null || elements.announcementInput === undefined) return
    runAction(
      'save-announcement',
      { text: elements.announcementInput.value },
      {
        buttons: [elements.saveAnnouncement],
      },
    )
  }

  // ───────────────────────── 弹层公共 ─────────────────────────

  function closeAllModals(restore) {
    const target = state.focusReturn
    closeEditor(false)
    closeScheduleEditor(false)
    closeDutyEditor(false)
    state.focusReturn = null
    if (restore) restoreFocus(target)
  }

  function handleEscape(event) {
    if (event.key !== 'Escape') return
    if (elements.editor !== null && elements.editor !== undefined && elements.editor.hidden === false) {
      event.preventDefault()
      closeEditor(true)
      return
    }
    if (
      elements.scheduleEditor !== null &&
      elements.scheduleEditor !== undefined &&
      elements.scheduleEditor.hidden === false
    ) {
      event.preventDefault()
      closeScheduleEditor(true)
      return
    }
    if (elements.dutyEditor !== null && elements.dutyEditor !== undefined && elements.dutyEditor.hidden === false) {
      event.preventDefault()
      closeDutyEditor(true)
    }
  }

  // ───────────────────────── 初始化 ─────────────────────────

  function cacheElements() {
    elements.app = document.getElementById('calendar-app')
    elements.prevWeek = document.getElementById('prev-week')
    elements.thisWeek = document.getElementById('this-week')
    elements.nextWeek = document.getElementById('next-week')
    elements.weekMeta = document.getElementById('week-meta')
    elements.dutySummary = document.getElementById('duty-summary')
    elements.stats = document.getElementById('stats')
    elements.days = document.getElementById('days')
    elements.announcement = document.getElementById('announcement')
    elements.announcementInput = document.getElementById('announcement-input')
    elements.saveAnnouncement = document.getElementById('save-announcement')
    elements.status = document.getElementById('status')

    elements.editor = document.getElementById('editor')
    elements.editorTitle = document.getElementById('editor-title')
    elements.editorText = document.getElementById('editor-text')
    elements.editorDueDate = document.getElementById('editor-due-date')
    elements.editorDueTime = document.getElementById('editor-due-time')
    elements.editorPriority = document.getElementById('editor-priority')
    elements.editorCategory = document.getElementById('editor-category')
    elements.editorAssignee = document.getElementById('editor-assignee')
    elements.editorDone = document.getElementById('editor-done')
    elements.editorError = document.getElementById('editor-error')
    elements.editorSave = document.getElementById('editor-save')
    elements.editorDelete = document.getElementById('editor-delete')
    elements.editorCancel = document.getElementById('editor-cancel')

    elements.scheduleEditor = document.getElementById('schedule-editor')
    elements.scheduleWeekday = document.getElementById('schedule-weekday')
    elements.scheduleTime = document.getElementById('schedule-time')
    elements.scheduleTitle = document.getElementById('schedule-title')
    elements.schedulePlace = document.getElementById('schedule-place')
    elements.scheduleError = document.getElementById('schedule-error')
    elements.scheduleSave = document.getElementById('schedule-save')
    elements.scheduleDelete = document.getElementById('schedule-delete')
    elements.scheduleCancel = document.getElementById('schedule-cancel')

    elements.dutyEditor = document.getElementById('duty-editor')
    elements.dutyGroup = document.getElementById('duty-group')
    elements.dutyNote = document.getElementById('duty-note')
    elements.dutyError = document.getElementById('duty-error')
    elements.dutySave = document.getElementById('duty-save')
    elements.dutyCancel = document.getElementById('duty-cancel')
  }

  function listen(node, type, handler) {
    if (node === null || node === undefined) return
    node.addEventListener(type, handler)
  }

  function bindEvents() {
    listen(elements.prevWeek, 'click', function () {
      changeWeek(-1)
    })
    listen(elements.thisWeek, 'click', goToThisWeek)
    listen(elements.nextWeek, 'click', function () {
      changeWeek(1)
    })

    listen(elements.dutySummary, 'click', openDutyEditor)
    listen(elements.saveAnnouncement, 'click', saveAnnouncement)

    listen(elements.editorSave, 'click', saveTaskEditor)
    listen(elements.editorDelete, 'click', deleteTaskFromEditor)
    listen(elements.editorCancel, 'click', function () {
      closeEditor(true)
    })

    listen(elements.scheduleSave, 'click', saveScheduleEditor)
    listen(elements.scheduleDelete, 'click', deleteScheduleEntry)
    listen(elements.scheduleCancel, 'click', function () {
      closeScheduleEditor(true)
    })

    listen(elements.dutySave, 'click', saveDutyEditor)
    listen(elements.dutyCancel, 'click', function () {
      closeDutyEditor(true)
    })

    document.addEventListener('keydown', handleEscape)
  }

  function boot() {
    if (state.booted) return
    state.booted = true
    cacheElements()

    if (elements.app === null && elements.days === null && elements.status === null) return
    if (elements.status !== null && elements.status !== undefined) {
      elements.status.setAttribute('role', 'status')
      elements.status.setAttribute('aria-live', 'polite')
    }

    bindEvents()
    setNavigationDisabled()
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
