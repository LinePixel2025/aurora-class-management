/**
 * Aurora 插件契约（手写副本，字段与 Aurora v0.5.2 `packages/shared/src/plugin/protocol.ts` 对齐）。
 *
 * 插件项目不依赖 Aurora 源码时用它获得编辑器补全；宿主升级 `apiVersion` 后以官方文档为准。
 */

export interface PluginInfo {
  id: string
  version: string
  root: string
  dataDir: string
  isDev: boolean
}

export interface PluginStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

export interface PluginNet {
  fetch(input: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<{ status: number; headers: Record<string, string>; body: string }>
}

export interface PluginUi {
  openPanel(panelId: string): Promise<void>
  toast(message: string, kind?: 'info' | 'error'): Promise<void>
  panelEvent(input: {
    panelId?: string
    widgetId?: string
    event: string
    payload?: unknown
  }): Promise<void>
}

export interface PluginContext {
  plugin: PluginInfo
  config: Readonly<Record<string, unknown>>
  storage: PluginStorage
  net: PluginNet
  notify(input: { title: string; body: string }): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void
  emitEvent(name: string, payload?: unknown): Promise<void>
  ui: PluginUi
  signal: AbortSignal
}

export interface PluginToolResult {
  content: string
  isError?: boolean
  summary?: string
}

export interface PluginCommandResult {
  prompt?: string
  summary?: string
}

export interface PluginAutomationActionResult {
  summary?: string
}

export interface PluginPanelResult {
  schema?: unknown
  toast?: string
  /** 页面型面板：原样交给 `auroraPlugin.request()` 的调用方 */
  data?: unknown
  /** 页面型面板动作结果提示（成功时） */
  message?: string
  /** 页面型面板动作失败原因（DataError / 其他异常） */
  error?: string
}

/** 小组件调用与面板同形。 */
export type PluginWidgetResult = PluginPanelResult

export interface PluginModule {
  activate?(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
  invokeTool?(
    name: string,
    input: Record<string, unknown>,
    ctx: PluginContext,
  ): PluginToolResult | Promise<PluginToolResult>
  invokeCommand?(
    name: string,
    args: string,
    ctx: PluginContext,
  ): PluginCommandResult | Promise<PluginCommandResult>
  invokeAutomationAction?(
    name: string,
    params: Record<string, unknown>,
    ctx: PluginContext,
  ): PluginAutomationActionResult | Promise<PluginAutomationActionResult>
  invokePanel?(
    panelId: string,
    method: string,
    params: unknown,
    ctx: PluginContext,
  ): PluginPanelResult | Promise<PluginPanelResult>
  invokeWidget?(
    widgetId: string,
    method: string,
    params: unknown,
    ctx: PluginContext,
  ): PluginWidgetResult | Promise<PluginWidgetResult>
  onEvent?(event: string, payload: unknown, ctx: PluginContext): void | Promise<void>
  onConfigChanged?(
    config: Readonly<Record<string, unknown>>,
    ctx: PluginContext,
  ): void | Promise<void>
}
