'use strict'

/**
 * 推送：只发给本插件清单里声明过的目标。
 * 目标：面板 `board` / `calendar` + 2 个桌面小组件；事件名 `board.changed`；
 * 每次业务变更最多 4 条（2 面板 + 2 小组件），低于宿主单次 5 条上限。
 */

const PANEL_ID = 'board'
const PANEL_IDS = ['board', 'calendar']
const WIDGET_IDS = ['week-overview', 'week-tasks']
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

/** 推送到指定面板；panelId 必须是清单里声明过的面板。 */
async function pushPanel(ctx, panelId, reason) {
  try {
    await ctx.ui.panelEvent({ panelId, event: EVENT, payload: { reason: String(reason ?? '') } })
  } catch (error) {
    ctx.log('warn', '推送面板事件失败', { panelId, error: String(error) })
  }
}

async function pushAll(ctx, reason) {
  await pushWidgets(ctx, reason)
  for (const panelId of PANEL_IDS) {
    await pushPanel(ctx, panelId, reason)
  }
}

module.exports = {
  PANEL_ID,
  PANEL_IDS,
  WIDGET_IDS,
  EVENT,
  pushWidgets,
  pushPanel,
  pushAll,
}
