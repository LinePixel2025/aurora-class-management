'use strict'

/**
 * 推送：只发给本插件清单里声明过的目标。
 * 目标：面板 `board` + 4 个桌面小组件；事件名 `board.changed`；每次业务变更最多 5 条。
 */

const PANEL_ID = 'board'
const WIDGET_IDS = ['duty-week', 'week-tasks', 'week-schedule', 'week-overview']
const EVENT = 'board.changed'

async function pushWidgets(ctx, reason) {
  for (const widgetId of WIDGET_IDS) {
    try {
      await ctx.ui.panelEvent({ widgetId, event: EVENT, payload: { reason: String(reason ?? '') } })
    } catch (error) {
      ctx.log('warn', '推送小组件事件失败', { widgetId, error: String(error) })
    }
  }
}

async function pushPanel(ctx, reason) {
  try {
    await ctx.ui.panelEvent({ panelId: PANEL_ID, event: EVENT, payload: { reason: String(reason ?? '') } })
  } catch (error) {
    ctx.log('warn', '推送面板事件失败', { error: String(error) })
  }
}

async function pushAll(ctx, reason) {
  await pushWidgets(ctx, reason)
  await pushPanel(ctx, reason)
}

module.exports = {
  PANEL_ID,
  WIDGET_IDS,
  EVENT,
  pushWidgets,
  pushPanel,
  pushAll,
}
