/**
 * session —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */

import { runBsk } from './bsk.js'
import { escapeRegExp, sleep } from './util.js'

/* 这些 bsk 命令属于「shared-tab 动作」，bsk 0.4.0 起必须先 cooperate sync
 * 拿到一次性的 context_id，再用 --context 附带上去，否则一律报
 * 「This action requires the context returned by the latest cooperate sync」。
 * 只读命令（observe / get-html / console / network / screenshot / session start 等）
 * 不在表里，免得白白多跑一次 sync。 */
const CONTEXT_ACTIONS = new Set([
  'navigate',
  'navigate-back',
  'navigate-forward',
  'reload',
  'click',
  'hover',
  'focus',
  'blur',
  'fill',
  'select',
  'press',
  'wheel',
  'drag',
  'scroll-to',
  'evaluate',
  'upload',
  'download',
])


function pickSessionId(output) {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    const queue = [parsed]
    while (queue.length) {
      const node = queue.shift()
      if (!node || typeof node !== 'object') continue
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string' && /^(session_?id|id)$/i.test(key) && /^[A-Za-z0-9_-]{2,64}$/.test(value)) {
          if (!/^\d+$/.test(value)) return value
        }
        if (value && typeof value === 'object') queue.push(value)
      }
    }
  } catch {
    /* 非 JSON */
  }
  const named = output.match(/"session_?id"\s*:\s*"([^"]+)"/i)
  if (named) return named[1]
  const spoken = output.match(/session\s+([A-Za-z0-9_-]{2,64})/i)
  return spoken ? spoken[1] : null
}


async function ensureSession(fresh = false, bin = 'bsk') {
  if (!fresh) {
    const listed = await runBsk(bin, ['session', 'list', '--json'], 20000)
    if (listed.code === 0) {
      const existing = pickSessionId(listed.stdout)
      if (existing) return { ok: true, session: existing, reused: true }
    }
  }
  // --no-focus：Agent Window 在后台开，不抢用户焦点。逛论坛是「静默」的，
  // 不该把人正在做的事顶掉。
  const started = await runBsk(bin, ['session', 'start', '--json', '--no-focus'], 90000)
  const created = pickSessionId(started.stdout) || pickSessionId(started.stderr)
  if (created) return { ok: true, session: created, reused: false }
  return {
    ok: false,
    error: '建立浏览器会话失败（bsk session start 没返回会话号）。',
    detail: `${started.stdout}\n${started.stderr}`.trim().slice(0, 800),
  }
}


/**
 * 取一次协同上下文。拿不到就返回 null，由调用方按原样重试（保持旧版行为）。
 *
 * bsk 0.4.2 收紧了控制协议：除了 context_id，**共享标签页的脚本/无目标动作
 * 还额外要求一个 observation_id**，而且必须是 sync 响应**顶层**的那个
 * （`observation_id`），不是 `observation.observation_id`——两个字段长得一模一样，
 * 拿错会报 "This action needs an explicit current observation"。
 *
 * 实测三种组合：
 *   只 --context                     → needs an explicit current observation
 *   只 --observation                 → control_context_invalid
 *   --context + --observation 同时传 → 通过
 *
 * 两个值都来自**同一次** sync，且都是一次性的：用完即废，下个动作要重新 sync。
 */
async function cooperateContext(session, timeoutMs = 30000) {
  const result = await runBsk('bsk', ['cooperate', 'sync', '--session', session, '--json'], timeoutMs)
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout)
    if (!parsed || typeof parsed.context_id !== 'string' || !parsed.context_id) return null
    return {
      context: parsed.context_id,
      // 只认顶层；嵌套的那个是陷阱（bsk 自己的 hint 都特意标注了）。
      observation: typeof parsed.observation_id === 'string' ? parsed.observation_id : null,
    }
  } catch {
    /* 不是 JSON 就当没拿到 */
  }
  return null
}


async function bskPage(session, args, timeoutMs = 45000) {
  const base = [...args, '--session', session]
  if (!CONTEXT_ACTIONS.has(args[0])) return runBsk('bsk', base, timeoutMs)

  // context/observation 都是一次性的：一次动作消耗一份，页面跳转还会让它立即作废。
  // 这里最多试三轮，每轮都重新 sync。被校验挡下的动作不会有任何副作用，
  // 所以重试是安全的；只有确认是 context 类拒绝才继续，别的错误立刻返回。
  let last = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await cooperateContext(session)
    if (!ctx) {
      // 拿不到上下文就按旧行为发一次，让调用方看到真实报错。
      //
      // 这一条也有正当用途：**新会话刚建出来时停在 about: 空白页**，
      // 页面不可观察 → sync 直接失败（frame_unobservable）。
      // 而首个 navigate 恰好不需要上下文就能通过——实测可行。
      // 所以「拿不到就裸发」不是降级，是空白页起步的正确路径。
      return attempt === 0 ? runBsk('bsk', base, timeoutMs) : last || runBsk('bsk', base, timeoutMs)
    }
    // 新版同时要 --context 与 --observation；旧版不认 --observation，
    // 所以拿不到顶层 id 时只传 context，保持向后兼容。
    const withCtx = ctx.observation
      ? [...base, '--context', ctx.context, '--observation', ctx.observation]
      : [...base, '--context', ctx.context]
    last = await runBsk('bsk', withCtx, timeoutMs)
    if (last.code === 0) return last
    const looksLikeContextProblem = /context|cooperate|permission_denied|observation|shared page control/i.test(
      `${last.stderr}${last.stdout}`,
    )
    if (!looksLikeContextProblem) return last
    // 稍等一下再取下一个上下文，给页面收敛留出时间
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return last
}


/**
 * 打开页面。
 *
 * 这里用 domcontentloaded 而不是 networkidle：
 * 这个论坛挂着 Google Analytics、layui 等外部脚本，外部请求经常一直挂着不断，
 * networkidle 会等到超时（用户就撞见过「reached=timeout」）。
 * 而且我们真正要的数据（REPLY_DOM_ARR）是页面自己填的，DOM 就绪后再多等一会儿即可，
 * 不需要网络完全静默。所以：先 domcontentloaded，再显式等楼层变量出现。
 */
async function navigate(session, url) {
  const result = await bskPage(
    session,
    ['navigate', url, '--wait-until', 'domcontentloaded', '--timeout', '30s'],
    60000,
  )
  // bsk 在超时时仍会返回 reached=timeout，但页面往往已经可用。
  // 只要不是硬失败（找不到会话、拒绝访问），就当“到了”，后面靠等楼层变量来兜底。
  const soft = /reached=(timeout|domcontentloaded|load)/.test(result.stdout || '')
  const ok = result.code === 0 || soft
  return {
    ok,
    soft: result.code !== 0 && soft,
    detail: (result.stdout || result.stderr).trim().slice(0, 300),
  }
}


/**
 * 上一会话卡住时（previous session command is still running）导航会被挡住。
 * 处理：停掉旧会话 → 建个干净的 → 只重试一次；再失败就退出。
 */
async function navigateWithRecovery(session, url) {
  let current = session
  let first = await navigate(current, url)

  // 软超时（reached=timeout）不算失败——页面通常已经能用了，交给后面等楼层变量去确认。
  if (first.ok) return { ok: true, session: current, soft: first.soft }

  const stuck = /unfinished command|still running|previous session command/i.test(first.detail || '')
  if (!stuck) return { ok: false, session: current, detail: first.detail }

  // 会话被上一个命令占着：停掉、重建、再试一次（最多两次）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runBsk('bsk', ['session', 'stop', current], 25000)
    await sleep(1200)
    const fresh = await ensureSession(true)
    if (!fresh.ok) {
      return { ok: false, session: current, detail: `${first.detail}｜重建会话失败：${fresh.error || ''}` }
    }
    current = fresh.session
    const again = await navigate(current, url)
    if (again.ok) return { ok: true, session: current, recovered: true, soft: again.soft }
    const stillStuck = /unfinished command|still running|previous session command/i.test(again.detail || '')
    if (!stillStuck) {
      return { ok: false, session: current, detail: `会话已重建但导航失败：${again.detail}` }
    }
    first = again
  }
  return { ok: false, session: current, detail: `连续两次重建会话后仍被占用：${first.detail}` }
}


async function observe(session, maxTokens = 9000) {
  const result = await bskPage(session, ['observe', '--max-tokens', String(maxTokens)], 60000)
  return { ok: result.code === 0, vom: result.stdout, detail: (result.stderr || '').slice(0, 400) }
}


function findRef(vom, kind, label) {
  const found = String(vom).match(new RegExp(`(@e\\d+)\\s+${kind}\\s+"${escapeRegExp(label)}`))
  return found ? found[1] : null
}

const REF = {
  replyBox: (vom) => findRef(vom, 'textbox', 'Reply body'),
  replySubmit: (vom) => findRef(vom, 'button', '提交回复'),
  userMenu: (vom) => findRef(vom, 'button', 'Navbar user menu'),
  loginUser: (vom) => findRef(vom, 'textbox', '用户名 / Email'),
  loginPass: (vom) => findRef(vom, 'textbox', '密码'),
  loginSubmit: (vom) => findRef(vom, 'button', '登录'),
  logoutLink: (vom) => findRef(vom, 'link', '退出'),
}


async function clickRef(session, ref) {
  const result = await bskPage(session, ['click', '--ref', ref, '--timeout', '20s'], 40000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr).trim().slice(0, 300) }
}


/**
 * 按 CSS 选择器点击。
 *
 * 站点自己的 id 比 VOM ref 稳：`#reply-button` 是提交按钮的固定 id，
 * 不会因为 observe 预算被截断而找不到，也不受文本匹配漂移影响。
 */
async function clickSelector(session, selector) {
  const result = await bskPage(session, ['click', '--selector', selector, '--timeout', '20s'], 40000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr).trim().slice(0, 300) }
}


async function fillRef(session, ref, value) {
  const result = await bskPage(session, ['fill', '--ref', ref, '--value', value], 45000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr).trim().slice(0, 300) }
}


async function fillSelector(session, selector, value) {
  const result = await bskPage(session, ['fill', '--selector', selector, '--value', value], 45000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr).trim().slice(0, 300) }
}

/* ------------------------------------------------------------- 频率与状态 */


/**
 * 在 VOM 里找不到目标时，翻页把剩余部分读回来再找一次。
 *
 * 为什么需要：observe 的 --max-tokens 是硬预算，超出就直接截断成
 * 「@more observe --cursor ...」。一页 20 层楼的话题页，回复框在最底部，
 * 6000 的预算只够读到一半（实测 346 行只出来 225 行，Reply body 被砍掉）。
 * 这时候 findRef 返回 null，插件就以为页面上没有回复框。
 */
async function findRefDeep(session, finder, firstVom, maxPages = 4) {
  let vom = firstVom || ''
  if (finder(vom)) return { ref: finder(vom), vom }

  let cursor = (vom.match(/--cursor\s+([0-9a-f-]+)/i) || [])[1] || null
  for (let i = 0; i < maxPages && cursor; i += 1) {
    const more = await bskPage(session, ['observe', '--cursor', cursor, '--max-tokens', '9000'], 60000)
    if (more.code !== 0) break
    const chunk = more.stdout || ''
    vom += `\n${chunk}`
    const hit = finder(vom)
    if (hit) return { ref: hit, vom }
    cursor = (chunk.match(/--cursor\s+([0-9a-f-]+)/i) || [])[1] || null
  }
  return { ref: null, vom }
}


export { CONTEXT_ACTIONS, pickSessionId, ensureSession, cooperateContext, bskPage, navigate, navigateWithRecovery, observe, findRef, REF, clickRef, clickSelector, fillRef, fillSelector, findRefDeep }
