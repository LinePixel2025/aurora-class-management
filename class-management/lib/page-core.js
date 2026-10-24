'use strict'

/**
 * 页面型面板 / 页面型小组件共用的请求处理小工具。
 *
 * 页面 RPC 的 params 是**直接对象**（不像声明式面板的 `{ params, values }`），
 * 因此这里统一做参数归一、错误信息、以及「动作成功后带最新数据返回」的封装。
 * 业务规则仍在 lib/ops.js；本文件不读写存储。
 */

const { DataError } = require('./state')

/** 把任意 params 归一成普通对象。 */
function asParams(params) {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}
}

/** 错误信息压缩成一行，避免把整段堆栈塞进页面状态条。 */
function messageOf(error, fallback) {
  const text = error instanceof Error ? error.message : String(error)
  const trimmed = text.trim()
  if (trimmed === '') return fallback === undefined ? '操作失败，请重试' : fallback
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed
}

/** 安全读取最新数据；读取失败时退化成只有 error 的结果，保证页面不至于白屏。 */
async function readOrNull(reader) {
  try {
    return await reader()
  } catch (error) {
    return null
  }
}

/**
 * 统一执行页面动作：
 * - 成功：返回 `{ data: <最新数据>, message? }`；
 * - `DataError`：返回 `{ data?: <最新数据>, error }`（尽量带 data，页面可回填）；
 * - 其他异常：写 warning 日志并返回通用错误。
 *
 * @param {object} ctx 插件上下文
 * @param {() => Promise<object>} readData 读取页面最新全量数据
 * @param {() => Promise<string>} action 执行动作，返回成功提示（空字符串表示无提示）
 * @param {object} [options] `{ logLabel }`
 */
async function runPageAction(ctx, readData, action, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  try {
    const message = await action()
    const data = await readOrNull(readData)
    return {
      ...(data === null ? {} : { data }),
      ...(message === undefined || message === '' ? {} : { message }),
    }
  } catch (error) {
    if (error instanceof DataError) {
      const data = await readOrNull(readData)
      return { ...(data === null ? {} : { data }), error: error.message }
    }
    ctx.log('warn', opts.logLabel === undefined ? '页面操作失败' : String(opts.logLabel), {
      error: String(error),
    })
    const data = await readOrNull(readData)
    return { ...(data === null ? {} : { data }), error: messageOf(error, '操作失败，请重试') }
  }
}

/**
 * 读取一个可选字符串参数：缺省返回 undefined（表示“不修改”），
 * 空字符串按原样返回（用于清空字段）。
 */
function optionalText(params, key) {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  return String(value)
}

module.exports = {
  asParams,
  messageOf,
  readOrNull,
  runPageAction,
  optionalText,
}
