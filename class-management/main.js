'use strict'

/**
 * 班级事务台 · Aurora 插件入口。
 *
 * 只负责装配：工具 / 命令 / 面板 / 小组件 / 配置变化 / 跨天定时刷新。
 * 业务规则在 lib/ 下，数据只写插件私有存储（board.v1 / ui.v1）。
 */

const { clip } = require('./lib/util')
const { nowMs, setNowForTests, resetNowForTests, todayKey, weekKeyFromOffset, weekdayLabel } = require('./lib/time')
const { VIEWS, DataError, ensureBoard } = require('./lib/state')
const ops = require('./lib/ops')
const { overViewText, taskListText, planSummaryText } = require('./lib/text')
const { pushAll, pushPanel } = require('./lib/push')
const { WIDGET_IDS, PANEL_ID } = require('./lib/push')
const { widgetSchema } = require('./lib/widgets')
const { renderPanel, handlePanelAction } = require('./lib/panel')

let ticker = null
let lastDayKey = ''
let lastWeekKey = ''

function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function ok(content, summary) {
  return { content, ...(summary === undefined ? {} : { summary }) }
}

function fail(content) {
  return { content, isError: true }
}

function validName(name) {
  return typeof name === 'string' && name !== ''
}

function extractParams(params) {
  const raw = params !== null && typeof params === 'object' ? params : {}
  return {
    actionParams: raw.params !== null && typeof raw.params === 'object' ? raw.params : {},
    values: raw.values !== null && typeof raw.values === 'object' ? raw.values : {},
  }
}

async function runTool(name, input, ctx) {
  const settings = ops.readWeekOffset(input.weekOffset, 0)

  if (name === 'get_overview') {
    const data = await ops.loadWeek(ctx, settings)
    return ok(
      overViewText(data, { includeDone: input.includeDone !== false }),
      `${data.weekCtx.label}：待办 ${data.counts.pending} 条，值日 ${data.duty.groupName}`,
    )
  }

  if (name === 'list_tasks') {
    const result = await ops.listTasks(ctx, input)
    return ok(
      taskListText(result.data, result.tasks, result.total, result.status),
      `${result.total} 条事务（${result.status}）`,
    )
  }

  if (name === 'add_task') {
    const result = await ops.addTask(ctx, input)
    await pushAll(ctx, 'tool-add-task')
    return ok(
      `已添加事务：${result.task.text}（${result.weekCtx.label}）\nid=${result.task.id}${
        result.task.dueLabel === '' ? '' : `｜截止 ${result.task.dueLabel}`
      }`,
      `已添加「${clip(result.task.text, 20)}」`,
    )
  }

  if (name === 'update_task') {
    const result = await ops.updateTask(ctx, input)
    await pushAll(ctx, 'tool-update-task')
    return ok(
      `已更新事务：${result.task.text}（${result.weekCtx.label}）\nid=${result.task.id}${
        result.task.dueLabel === '' ? '' : `｜截止 ${result.task.dueLabel}`
      }｜${result.task.done ? '已完成' : '待办'}`,
      `已更新「${clip(result.task.text, 20)}」`,
    )
  }

  if (name === 'complete_task') {
    const result = await ops.completeTask(ctx, input)
    await pushAll(ctx, 'tool-complete-task')
    return ok(
      `${result.task.done ? '已标记完成' : '已恢复为待办'}：${result.task.text}（${result.weekCtx.label}）`,
      result.task.done ? '事务已完成' : '事务已恢复',
    )
  }

  if (name === 'delete_task') {
    const result = await ops.deleteTask(ctx, input)
    await pushAll(ctx, 'tool-delete-task')
    return ok(`已删除事务：${result.task.text}（${result.weekCtx.label}）`, '事务已删除')
  }

  if (name === 'set_duty_day') {
    const result = await ops.setDutyDay(ctx, input)
    await pushAll(ctx, 'tool-set-duty-day')
    const day = weekdayLabel(result.weekday)
    if (result.cleared === true) {
      return ok(`已清除 ${result.weekCtx.label} ${day} 的值日覆盖，恢复为值日组轮换。`, '值日覆盖已清除')
    }
    return ok(
      `已设置 ${result.weekCtx.label} ${day} 的值日：${result.names.join(' ')}${result.area === '' ? '' : `｜${result.area}`}${
        result.note === '' ? '' : `｜${result.note}`
      }`,
      '值日已更新',
    )
  }

  if (name === 'set_duty_week') {
    const result = await ops.setDutyWeek(ctx, input)
    await pushAll(ctx, 'tool-set-duty-week')
    return ok(
      `已更新 ${result.weekCtx.label} 的值日轮换组：${
        result.groupName === undefined || result.groupName === '' ? '恢复自动轮换' : result.groupName
      }。`,
      '值日轮换已更新',
    )
  }

  if (name === 'set_duty_groups') {
    const result = await ops.setDutyGroups(ctx, input)
    await pushAll(ctx, 'tool-set-duty-groups')
    return ok(`已保存 ${result.groups} 个值日组，轮换顺序包含 ${result.order} 个组。`, '值日分组已更新')
  }

  if (name === 'add_schedule') {
    const result = await ops.addSchedule(ctx, input)
    await pushAll(ctx, 'tool-add-schedule')
    const time = result.entry.time === '' ? '' : ` ${result.entry.time}`
    return ok(
      `已添加安排：${result.weekCtx.label} ${weekdayLabel(result.entry.weekday)}${time} ${result.entry.title}${
        result.entry.place === '' ? '' : ` @ ${result.entry.place}`
      }\nid=${result.entry.id}`,
      '安排已添加',
    )
  }

  if (name === 'delete_schedule') {
    const result = await ops.deleteSchedule(ctx, input)
    await pushAll(ctx, 'tool-delete-schedule')
    return ok(`已删除安排：${result.entry.title}（${result.weekCtx.label}）`, '安排已删除')
  }

  if (name === 'set_announcement') {
    const result = await ops.setAnnouncement(ctx, input)
    await pushAll(ctx, 'tool-set-announcement')
    return ok(
      result.announcement === ''
        ? `已清空 ${result.weekCtx.label} 的班级通知。`
        : `已保存 ${result.weekCtx.label} 的班级通知：${clip(result.announcement, 80)}`,
      result.announcement === '' ? '通知已清空' : '通知已保存',
    )
  }

  if (name === 'apply_week_plan') {
    const result = await ops.applyWeekPlan(ctx, input)
    await pushAll(ctx, 'tool-apply-week-plan')
    return ok(planSummaryText(result.summary), '整周计划已写入')
  }

  return fail(`未知工具：${name}`)
}

module.exports = {
  async activate(ctx) {
    const board = await ensureBoard(ctx)
    lastDayKey = todayKey()
    lastWeekKey = weekKeyFromOffset(0)
    ctx.log('info', '班级事务台已激活', {
      weeks: Object.keys(board.weeks).length,
      groups: board.duty.groups.length,
    })
    if (ticker !== null) clearInterval(ticker)
    ticker = setInterval(() => {
      void tick(ctx).catch((error) => {
        ctx.log('warn', '跨天刷新失败', { error: String(error) })
      })
    }, 60 * 1000)
  },

  async deactivate() {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  },

  async invokeTool(name, input, ctx) {
    if (!validName(name)) return fail('缺少工具名')
    try {
      return await runTool(name, input !== null && typeof input === 'object' ? input : {}, ctx)
    } catch (error) {
      if (error instanceof DataError) return fail(error.message)
      ctx.log('error', '工具执行失败', { name, error: String(error) })
      return fail(`工具执行失败：${messageOf(error)}`)
    }
  },

  async invokeCommand(name, args, ctx) {
    if (name === 'class') {
      await saveView(ctx, 'board')
      await ctx.ui.openPanel(PANEL_ID)
      await pushPanel(ctx, 'command-open')
      return { summary: '已打开班级事务台' }
    }
    if (name === 'week-plan') {
      const extra = typeof args === 'string' && args.trim() !== '' ? `用户的补充要求：${args.trim()}` : ''
      return {
        prompt:
          '请先调用工具 plugin.com.classmanagement.board.get_overview（weekOffset=0）读取本周数据，' +
          '然后用三条要点回答：①今天/本周最重要的待办；②今天谁值日；③最近一项安排或班级通知。' +
          '不要编造数据；如果需要修改，先说明将要改什么，再调用对应工具。' +
          (extra === '' ? '' : `\n${extra}`),
      }
    }
    throw new Error(`未知命令：${name}`)
  },

  async invokePanel(panelId, method, params, ctx) {
    if (panelId !== PANEL_ID) return {}
    return handlePanelAction(panelId, method, params, ctx)
  },

  async invokeWidget(widgetId, method, params, ctx) {
    if (!WIDGET_IDS.includes(widgetId)) return {}
    const { actionParams, values } = extractParams(params)
    const name = typeof method === 'string' ? method : ''
    try {
      if (name === 'quick-add') {
        const data = await ops.loadWeek(ctx, 0)
        const bind = `quickTask_${data.ui.quickRev}`
        const text = clip(values[bind], 200) || clip(values.quickTask, 200) || clip(actionParams.text, 200)
        if (text === '') {
          return { schema: widgetSchema(widgetId, data), toast: '请先输入事务内容' }
        }
        await ops.addTask(ctx, { text, weekOffset: 0 })
        await ops.bumpQuickRev(ctx)
        await pushAll(ctx, 'widget-quick-add')
        return { schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)), toast: '已添加事务' }
      }
      if (name === 'toggle-task') {
        const data = await ops.loadWeek(ctx, 0)
        const task = data.tasks.find((item) => item.id === clip(actionParams.id, 40))
        if (task === undefined) {
          return { schema: widgetSchema(widgetId, data), toast: '这条事务已不存在' }
        }
        await ops.updateTask(ctx, { id: task.id, done: !task.done, weekOffset: 0 })
        await pushAll(ctx, 'widget-toggle-task')
        return {
          schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)),
          toast: task.done ? '已恢复为待办' : '已完成',
        }
      }
      if (name === 'open-panel') {
        const view = VIEWS.includes(actionParams.view) ? actionParams.view : 'board'
        await ops.saveUi(ctx, { view, weekOffset: 0 })
        await ctx.ui.openPanel(PANEL_ID)
        await pushPanel(ctx, 'widget-open')
        return { schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)) }
      }
      return { schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)) }
    } catch (error) {
      if (error instanceof DataError) {
        try {
          return { schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)), toast: error.message }
        } catch {
          return { toast: error.message }
        }
      }
      ctx.log('error', '小组件处理失败', { widgetId, method: name, error: String(error) })
      try {
        return {
          schema: widgetSchema(widgetId, await ops.loadWeek(ctx, 0)),
          toast: '操作失败，请重试',
        }
      } catch {
        return { toast: '操作失败，请重试' }
      }
    }
  },

  onConfigChanged(config, ctx) {
    ctx.log('info', '班级事务台配置已更新', { className: config.className })
    void pushAll(ctx, 'config-changed')
  },

  /** 仅供离线测试与预览使用；宿主不会调用。 */
  __test: {
    setNow: setNowForTests,
    resetNow: resetNowForTests,
    tick: async (ctx) => tick(ctx),
    renderPanel: async (ctx) => renderPanel(ctx),
    widgetSchema,
    nowMs,
  },
}

async function tick(ctx) {
  const day = todayKey()
  const week = weekKeyFromOffset(0)
  if (day === lastDayKey && week === lastWeekKey) return
  lastDayKey = day
  lastWeekKey = week
  await pushAll(ctx, 'date-rollover')
}

async function saveView(ctx, view) {
  await ops.saveUi(ctx, { view, weekOffset: 0 })
}
