/**
 * visits —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

import { DEFAULT_STATE, STATE_PATH, VISIT_LOG_DIR } from './config.js'
import { readJson, todayKey, writeJson } from './util.js'

/**
 * 追加一条逛论坛记录到 %USERPROFILE%\.dsh\spixii-forum\visits\YYYY-MM-DD.jsonl
 *
 * 只记「干了什么」，不存楼层原文。
 * 帖子会长到几千楼，每趟都把全文抄一遍，日志很快就会失控；
 * 想看内容就当场看，留痕只留轨迹（去了哪、看了多少、说了什么、回了谁）。
 * 这里做了硬限制：任何调用方都别想把整篇楼层塞进来。
 */
const VISIT_LOG_MAX_TEXT = 300


async function appendVisitLog(entry) {
  try {
    await mkdir(VISIT_LOG_DIR, { recursive: true })
    const file = path.join(VISIT_LOG_DIR, `${todayKey()}.jsonl`)

    // 只允许白名单字段落盘，且文本一律截断。
    const safe = { at: new Date(entry.at || Date.now()).toISOString() }
    const textFields = ['reason', 'detail', 'hint', 'account', 'name', 'acted', 'url', 'via', 'author', 'prompt']
    const numFields = ['visitsToday', 'totalFloors', 'maxFloor', 'page', 'target', 'floor', 'count']
    for (const key of textFields) {
      const value = entry[key]
      if (value === undefined || value === null || value === '') continue
      safe[key] = String(value).slice(0, VISIT_LOG_MAX_TEXT)
    }
    for (const key of numFields) {
      const value = entry[key]
      if (value === undefined || value === null) continue
      const n = Number(value)
      if (Number.isFinite(n)) safe[key] = n
    }
    if (entry.ok !== undefined) safe.ok = Boolean(entry.ok)
    if (entry.posted) safe.posted = String(entry.posted).slice(0, VISIT_LOG_MAX_TEXT)
    if (entry.repliedTo && typeof entry.repliedTo === 'object') {
      safe.repliedTo = {
        floor: Number(entry.repliedTo.floor) || null,
        author: entry.repliedTo.author ? String(entry.repliedTo.author).slice(0, 80) : null,
      }
    }
    // 明确不进日志：floors / posts / 页面 HTML 等大块内容。

    const line = JSON.stringify(safe) + '\n'
    await writeFile(file, line, { encoding: 'utf8', flag: 'a' })
  } catch {
    /* 记日志失败不能影响主流程 */
  }
}


/**
 * 把旧版留痕里的「整篇楼层」清掉，只留摘要。
 * 早期版本会把每层原文写进日志，一天就几十 KB；几千楼时会失控。
 * 这里逐行重写成摘要格式，原作仍可从会话记录找回，留痕只需要轨迹。
 */
async function pruneVisitLogs() {
  let files = []
  try {
    files = (await readdir(VISIT_LOG_DIR)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { files: 0, linesBefore: 0, linesAfter: 0, summary: '没有留痕目录，不用清。' }
  }

  let before = 0
  let after = 0
  let bytesBefore = 0
  let bytesAfter = 0

  for (const name of files) {
    const full = path.join(VISIT_LOG_DIR, name)
    let raw = ''
    try {
      raw = await readFile(full, 'utf8')
    } catch {
      continue
    }
    bytesBefore += Buffer.byteLength(raw, 'utf8')
    const out = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      before += 1
      let entry = null
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      // 复用同一套白名单逻辑，重新落一遍
      const safe = { at: new Date(entry.at || Date.now()).toISOString() }
      const textFields = ['reason', 'detail', 'hint', 'account', 'name', 'acted', 'url', 'via', 'author', 'prompt']
      const numFields = ['visitsToday', 'totalFloors', 'maxFloor', 'page', 'target', 'floor', 'count']
      for (const key of textFields) {
        const value = entry[key]
        if (value === undefined || value === null || value === '') continue
        safe[key] = String(value).slice(0, VISIT_LOG_MAX_TEXT)
      }
      for (const key of numFields) {
        const n = Number(entry[key])
        if (Number.isFinite(n)) safe[key] = n
      }
      if (entry.ok !== undefined) safe.ok = Boolean(entry.ok)
      if (entry.posted) safe.posted = String(entry.posted).slice(0, VISIT_LOG_MAX_TEXT)
      if (entry.floors || entry.posts) safe.dropped = '旧版曾把楼层原文写进日志，已清掉'
      out.push(JSON.stringify(safe))
      after += 1
    }
    const next = out.length ? `${out.join('\n')}\n` : ''
    bytesAfter += Buffer.byteLength(next, 'utf8')
    await writeFile(full, next, 'utf8')
  }

  return {
    files: files.length,
    linesBefore: before,
    linesAfter: after,
    bytesBefore,
    bytesAfter,
    summary: `清完了：${files.length} 个文件，${before} 条记录 → ${after} 条，${Math.round(bytesBefore / 1024)} KB → ${Math.round(bytesAfter / 1024)} KB。`,
  }
}


/**
 * 造一条能被 Agent.inbox 接收的 user message。
 *
 * 为什么自己拼而不用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * 链接目录里的插件解析不到那个包（和 schemastery 是同一类问题），
 * 而 `agent/loop` 消费时走的是 `session.append("user/message", message, ...)`，
 * 消息对象是原样传入的、不再校验构造函数，所以字段对齐就够了：
 * `id` / `role` / `content` / `source`。
 *
 * source.kind 用一个客户端 switch 里没有分支的值：这样它会落到 default，
 * 显示成「收到执行请求」——语义是准的：**有东西请求我执行一轮**。
 *
 * 特意**不**冒充 `agent-message`：那个 kind 的契约是
 * `{ form: 'relay', senderSessionId }`，必须有真实的发送方。
 * 为了换个好看的标签去伪造一个不存在的 sender，属于伪造归属，不做。
 */
function makeWakeMessage(text, kind = 'spixii-forum-wake') {
  const message = {
    id: `spixii-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  }
  try {
    for (const block of message.content) Object.freeze(block)
    Object.freeze(message.content)
    Object.freeze(message.source)
    Object.freeze(message)
  } catch {
    /* 冻结失败不影响投递 */
  }
  return message
}

/* -------------------------------------------------------------- 镇楼锚点 */


function gate(config, state, force) {
  if (force) return { ok: true }
  if (!config.enabled) return { ok: false, reason: '插件在设置里被关掉了（enabled = false）。' }
  const key = todayKey()
  const used = Number(state.visits?.[key] ?? 0)
  if (Number(config.maxPerDay) > 0 && used >= Number(config.maxPerDay)) {
    return {
      ok: false,
      reason: `今天已经去过 ${used} 次，到了每日上限 ${config.maxPerDay} 次。真想现在去，就加 force: true。`,
    }
  }
  if (state.lastVisitAt && Number(config.everyDays) > 1) {
    const gap = (Date.now() - Date.parse(state.lastVisitAt)) / 86400000
    if (Number.isFinite(gap) && gap < Number(config.everyDays) - 0.02) {
      return { ok: false, reason: `距上次访问（${state.lastVisitAt}）还不到 ${config.everyDays} 天。` }
    }
  }
  return { ok: true }
}


async function bump() {
  const state = await readJson(STATE_PATH, DEFAULT_STATE)
  const key = todayKey()
  const visits = { ...(state.visits || {}) }
  visits[key] = Number(visits[key] ?? 0) + 1
  const next = { ...state, visits, lastVisitAt: new Date().toISOString() }
  await writeJson(STATE_PATH, next)
  return next
}

/* ------------------------------------------------- 共用流程（工具与命令） */


export { VISIT_LOG_MAX_TEXT, appendVisitLog, pruneVisitLogs, makeWakeMessage, gate, bump }
