/**
 * settings —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */

import { BUILD, DATA_DIR, DEFAULT_SETTINGS, SETTINGS_PATH, STATE_PATH } from './config.js'
import { errText, noteDiag, readJson, todayKey, writeJson } from './util.js'

/** 设置字段的类型表——工具、设置页、读盘校验共用，避免只改一边。 */
const TEXT_SETTING_KEYS = ['forumHome', 'topicUrl', 'mention', 'account', 'password', 'visitPrompt']

const BOOL_SETTING_KEYS = ['enabled', 'autoPost']

const NUM_SETTING_KEYS = ['everyDays', 'maxPerDay', 'waitDaemonMs']

const VISIT_PROMPT_MAX = 4000


/** 把外部送来的 patch 洗成「只含已知字段、类型正确、长度可控」的对象。 */
function sanitizeSettingsPatch(patch) {
  const clean = {}
  if (!patch || typeof patch !== 'object') return clean

  for (const key of TEXT_SETTING_KEYS) {
    if (!(key in patch) || typeof patch[key] !== 'string') continue
    const raw = patch[key].replace(/\r\n/g, '\n')
    // 密码原样保留（首尾空格也可能是密码的一部分），其余去掉首尾空白。
    clean[key] = key === 'password' ? raw.slice(0, 200) : raw.trim()
  }
  if (typeof clean.visitPrompt === 'string') {
    clean.visitPrompt = clean.visitPrompt.replace(/\n{4,}/g, '\n\n\n').slice(0, VISIT_PROMPT_MAX)
  }
  for (const key of BOOL_SETTING_KEYS) {
    if (typeof patch[key] === 'boolean') clean[key] = patch[key]
  }
  for (const key of NUM_SETTING_KEYS) {
    if (!(key in patch)) continue
    const n = Number(patch[key])
    if (Number.isFinite(n) && n >= 0) clean[key] = n
  }
  return clean
}


async function readSettings() {
  const stored = await readJson(SETTINGS_PATH, {})
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
}


async function saveSettings(patch) {
  const current = await readSettings()
  const next = { ...current, ...sanitizeSettingsPatch(patch) }
  for (const key of NUM_SETTING_KEYS) {
    const n = Number(next[key])
    next[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS[key]
  }
  for (const key of BOOL_SETTING_KEYS) {
    if (typeof next[key] !== 'boolean') next[key] = DEFAULT_SETTINGS[key]
  }
  await writeJson(SETTINGS_PATH, next)
  return next
}


/** 给浏览器的视图：密码换成布尔值，其余原样。 */
function publicSettings(settings) {
  const { password, ...rest } = settings
  return { ...rest, hasPassword: Boolean(password) }
}


/** 设置页首屏要的全部内容：当前值 + 默认值 + 最近状态 + 路径。 */
async function settingsPayload() {
  const cfg = await readSettings()
  const state = await readJson(STATE_PATH, {})
  const today = todayKey()
  const visits = state && typeof state.visits === 'object' ? state.visits : {}
  return {
    ok: true,
    settings: publicSettings(cfg),
    defaults: publicSettings(DEFAULT_SETTINGS),
    limits: { visitPromptMax: VISIT_PROMPT_MAX },
    state: {
      today,
      lastVisitAt: (state && state.lastVisitAt) || null,
      lastError: (state && state.lastError) || null,
      visitsToday: Number(visits[today]) || 0,
    },
    meta: { build: BUILD, dataDir: DATA_DIR, settingsPath: SETTINGS_PATH },
  }
}

/* --------------------------------------------------- 设置页的 HTTP 小工具 */


function isLoopback(req) {
  const address = String((req && req.socket && req.socket.remoteAddress) || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}


function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}


async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}


/**
 * 设置页唯一的读写入口。
 * 只接受回环来源，只吐公开视图；密码只能写（或显式清空），读不回去。
 */
function createSettingsRoute() {
  return {
    kind: 'exact',
    path: '/api/spixii-forum/settings',
    handler: async (req, res) => {
      try {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden: 只接受本机访问' })
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, await settingsPayload())
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: `不支持的 method：${method}` })

        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })

        if (body.reset === true) {
          // 恢复默认不动密码：重置表单不该顺手把账号凭据清掉。
          const { password, ...defaults } = DEFAULT_SETTINGS
          await saveSettings(defaults)
        } else {
          const patch = sanitizeSettingsPatch(body.patch)
          if (body.clearPassword === true) patch.password = ''
          if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: '没有可写入的字段' })
          await saveSettings(patch)
        }
        await noteDiag(
          'settings-ui',
          JSON.stringify({ reset: body.reset === true, keys: Object.keys(body.patch || {}) }),
        )
        return sendJson(res, 200, await settingsPayload())
      } catch (error) {
        await noteDiag('settings-ui-error', errText(error))
        return sendJson(res, 500, { ok: false, error: errText(error) })
      }
    },
  }
}

/* ------------------------------------------------------- bsk 子进程与守护进程 */


export { TEXT_SETTING_KEYS, BOOL_SETTING_KEYS, NUM_SETTING_KEYS, VISIT_PROMPT_MAX, sanitizeSettingsPatch, readSettings, saveSettings, publicSettings, settingsPayload, isLoopback, sendJson, readJsonBody, createSettingsRoute }
