/**
 * browser —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { daemonStatus, edgeRunning, killLaunchedEdge, listBrowsers, listUserTabs, resolveBsk, runBsk } from './bsk.js'
import { AWAY_FILE, AWAY_MARK, DATA_DIR, DEFAULT_STATE, EDGE_EXE, EDGE_EXE_ALT, LAUNCH_KEY, STATE_PATH } from './config.js'
import { errText, noteDiag, readJson, sleep, writeJson } from './util.js'

/** 找 Edge 的 msedge.exe。 */
async function resolveEdge() {
  for (const candidate of [EDGE_EXE, EDGE_EXE_ALT]) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { ok: true, path: candidate }
    } catch {
      /* 试下一个 */
    }
  }
  // 兜底：从环境变量拼（不同机器 %ProgramFiles(x86)% 可能不同）
  const pf86 = process.env['ProgramFiles(x86)']
  const pf = process.env['ProgramFiles']
  const fromEnv = [pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    .filter(Boolean)
  for (const candidate of fromEnv) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { ok: true, path: candidate }
    } catch {
      /* 试下一个 */
    }
  }
  return {
    ok: false,
    error: '找不到 Edge（msedge.exe）。',
    detail: `查过：\n  · ${EDGE_EXE}\n  · ${EDGE_EXE_ALT}\n  · %ProgramFiles(x86)% / %ProgramFiles% 下的 Edge\\Application\\msedge.exe\n如果 Edge 装在别处，请把它加到 PATH 或改这里。`,
  }
}


async function ensureAwayPage() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🐋 鲸鲸出门了</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
    background: radial-gradient(circle at 50% 0%, #16305c 0%, #0b1220 55%, #070c16 100%);
    color: #e6edf7;
  }
  .card { text-align: center; padding: 48px 56px; max-width: 640px; }
  .whale { font-size: 76px; line-height: 1; animation: float 3.2s ease-in-out infinite; }
  @keyframes float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-10px) } }
  h1 { font-size: 26px; margin: 22px 0 10px; letter-spacing: .5px; }
  .sub { color: #8fa6c4; font-size: 14px; line-height: 1.9; }
  .hint {
    margin-top: 28px; padding: 14px 18px; border-radius: 12px;
    background: rgba(120, 170, 255, .08);
    border: 1px solid rgba(120, 170, 255, .22);
    font-size: 13px; color: #a9c0de; line-height: 1.8;
  }
  code { background: rgba(255,255,255,.08); padding: 1px 6px; border-radius: 5px; }
  .mark { margin-top: 30px; font-size: 11px; color: #42556f; }
</style>
<!-- ${AWAY_MARK} -->
</head>
<body>
  <div class="card">
    <div class="whale">🐋</div>
    <h1>鲸鲸正在逛论坛</h1>
    <p class="sub">
      这个窗口是她出门用的，开着就说明她还在路上。<br>
      请先别在这里操作，也别关掉它——会打断她。
    </p>
    <div class="hint">
      逛完她自己会把窗口关掉。<br>
      如果想提前收工，跟她说一句「回来吧」，或者调
      <code>spixii_forum({action:"leave"})</code>。
    </div>
    <div class="mark">${AWAY_MARK}</div>
  </div>
</body>
</html>
`
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(AWAY_FILE, html, 'utf8')
  // file:/// 需要正斜杠；盘符后面要三条斜杠。
  return 'file:///' + AWAY_FILE.replace(/\\/g, '/')
}


async function rememberLaunch(info) {
  const state = await readJson(STATE_PATH, DEFAULT_STATE)
  state[LAUNCH_KEY] = info
  await writeJson(STATE_PATH, state)
}


async function recallLaunch() {
  const state = await readJson(STATE_PATH, DEFAULT_STATE)
  return state[LAUNCH_KEY] || null
}


async function forgetLaunch() {
  const state = await readJson(STATE_PATH, DEFAULT_STATE)
  if (state[LAUNCH_KEY]) {
    delete state[LAUNCH_KEY]
    await writeJson(STATE_PATH, state)
  }
}


/**
 * 确保有浏览器可用；没有就把 Edge 拉起来。
 *
 * 关键点（都是实测/系统机制决定的，不是猜的）：
 *
 *  1. 已有连接就什么都不做。否则用户正在用 Edge 的时候，我们还会给他塞一个 Agent Window。
 *  2. **不传 --user-data-dir**。传了就是另一个空 profile：没有 cookie、没有登录态、
 *     也没有 browser-skill 扩展，等于白开。默认 profile 才有他的一切。
 *  3. Edge 是单实例程序：同一个 profile 下再执行 msedge.exe 不会起第二个进程，
 *     而是把请求转交给已在运行的实例。所以「已开就复用、没开就拉起」不需要我们判断，
 *     系统自己就做到了——我们只管无脑 spawn 一次。
 *  4. 但「Edge 进程在跑、扩展却没连上」是另一种情况：这时候 spawn 也没用，
 *     Edge 只会把请求转给那个没扩展的实例。这种要单独报错，让用户去点扩展图标。
 *  5. 拉起后只能轮询 browsers --json 等它连上：bsk 0.4.2 没有「等浏览器连接」这种命令
 *     （help 已逐条核对）。超时就如实报错，不无限等。
 */
async function ensureBrowser(config, bin) {
  const before = await listBrowsers(bin)
  if (before.ok && before.count > 0) {
    return { ok: true, launched: false, detail: `已有 ${before.count} 个浏览器连着（${before.detail}）` }
  }

  const edge = await resolveEdge()
  if (!edge.ok) return { ok: false, stage: 'edge-launch', error: edge.error, detail: edge.detail }

  // 进程在跑但没连接：起新进程也是白起（单实例会转交给没扩展的旧实例）。
  const proc = await edgeRunning(bin)
  if (proc.known && proc.running) {
    return {
      ok: false,
      stage: 'edge-running-no-ext',
      error: 'Edge 开着，但 browser-skill 扩展没连上守护进程。',
      detail: [
        '请在已打开的 Edge 里点一下工具栏的 browser-skill 扩展图标，确认它显示「已连接」，然后重试。',
        '（扩展连接状态：地址栏右侧的插件图标 → Connected / 已连接）',
        `守护进程侧现在看到：${before.detail || '0 个浏览器'}`,
      ].join('\n'),
    }
  }

  let pid = null
  let awayUrl = null
  try {
    // 带告示页 URL 启动：不让用户看到一个莫名其妙的空白标签页，
    // 而是看到「鲸鲸在逛论坛，先别动」——顺便也成了「这窗口是我开的」的标记。
    try {
      awayUrl = await ensureAwayPage()
    } catch (error) {
      await noteDiag('away', `告示页写不出来（不致命）：${errText(error)}`)
      awayUrl = null
    }
    const spawnArgs = awayUrl ? [awayUrl] : []
    // 不传 --user-data-dir：要的就是用户自己的 profile（登录态、扩展都在里面）。
    const child = spawn(edge.path, spawnArgs, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    pid = child.pid ?? null
    // 记住「这次是我起的」，leave 时才敢把手伸到进程层。
    await rememberLaunch({ pid, awayUrl, at: new Date().toISOString() })
  } catch (error) {
    return {
      ok: false,
      stage: 'edge-launch',
      error: `Edge 拉不起来：${errText(error)}`,
      detail: `尝试执行：${edge.path}\n系统错误：${errText(error)}`,
    }
  }

  // 等扩展连上来。Edge 冷启动 + 扩展注入实测在几秒内，给 20 秒足够；
  // 等不到就报错，不在这里赌。
  const budget = 20000
  const deadline = Date.now() + budget
  let last = before
  while (Date.now() < deadline) {
    await sleep(500)
    last = await listBrowsers(bin)
    if (last.ok && last.count > 0) {
      return { ok: true, launched: true, pid, detail: `已拉起 Edge（pid=${pid}），扩展 ${last.detail}` }
    }
  }

  return {
    ok: false,
    stage: 'browser-wait',
    error: `Edge 起来了，但 ${Math.round(budget / 1000)} 秒内 browser-skill 扩展没连上。`,
    pid,
    detail: [
      `Edge 路径：${edge.path}`,
      `守护进程现在看到：${last.detail || '0 个浏览器'}`,
      '可能原因：扩展被禁用/未登录 profile、Edge 启动卡在首启向导、或守护进程端口不是 52800。',
    ].join('\n'),
  }
}


/**
 * 关掉 Agent Window；如果这个 Edge 是我们起的、而且用户没碰过，连它一起关。
 *
 * 三种情形（这是和用户逐条对过的判定，别随手改）：
 *  1. Edge 本来开着          → 只关 Agent Window（那是用户的浏览器，不许碰）
 *  2. Edge 是我们起的、没动过 → 先关 Agent Window，再 taskkill 整树，零残留
 *  3. Edge 是我们起的、动过了 → 只关 Agent Window，用户开的页面留着
 *
 * 「动过」的判定不靠窗口标题猜：把 scope=user 的标签页列出来，
 * 去掉我们那张告示页，还剩东西就是用户加过页面。
 */
async function leaveBrowser(config) {
  const resolved = await resolveBsk(config)
  if (!resolved.ok) return { ok: false, error: resolved.error, detail: resolved.detail }

  const bin = resolved.path

  // 守护进程没在跑，就不可能存在 Agent Window（窗口是它建的，它一退会话就没了）。
  // 这时候再报错说「查不到会话」既难懂又没用——直接当成「已经没有要关的」。
  const daemon = await daemonStatus(bin)
  if (!daemon.alive) {
    // 但「Edge 是我起的、守护进程却没了」这种情形要顺手收拾掉，别留个孤儿窗口。
    const stray = await recallLaunch()
    if (stray && stray.pid) {
      const killed = await killLaunchedEdge(stray.pid)
      await forgetLaunch()
      return {
        ok: true,
        stopped: [],
        killedEdge: killed.ok,
        detail: killed.ok
          ? '守护进程没在跑，Agent Window 早已随它消失；顺手把之前拉起、没人用过的 Edge 也关了。'
          : `守护进程没在跑，本来就没有浏览器窗口；之前那个 Edge（pid=${stray.pid}）没能关掉：${killed.detail}`,
      }
    }
    return { ok: true, stopped: [], detail: '守护进程没在跑，本来就没有打开的浏览器窗口，不用关。' }
  }

  const listed = await runBsk(bin, ['session', 'list', '--json'], 20000)
  if (listed.code !== 0) {
    return {
      ok: false,
      error: '查不到当前有哪些浏览器会话，没法关窗。',
      detail: (listed.stderr || listed.stdout || '').trim().slice(0, 400),
    }
  }

  let sessions = []
  try {
    const parsed = JSON.parse(listed.stdout)
    if (Array.isArray(parsed)) sessions = parsed
    else if (parsed && Array.isArray(parsed.sessions)) sessions = parsed.sessions
  } catch {
    /* 交给下面的文本兜底 */
  }
  // JSON 解析不出来时退回正则：宁可多关一次也不要漏关（stop 是幂等的）。
  const ids = sessions
    .map((s) => (s && (s.session_id || s.sessionId || s.id)) || null)
    .filter((v) => typeof v === 'string' && v)

  if (!ids.length) {
    const spoken = listed.stdout.match(/"session_?id"\s*:\s*"([^"]+)"/gi) || []
    for (const line of spoken) {
      const m = line.match(/"([^"]+)"$/)
      if (m) ids.push(m[1])
    }
  }

  /* ---- 关窗之前先判断：这个 Edge 是不是我们起的、用户动没动过 ---- */

  const launched = await recallLaunch()
  let verdict = null // { ownEdge: boolean, touched: boolean, extras: [] }

  if (launched && launched.pid) {
    const probeSession = ids[0] || null
    if (probeSession) {
      const userTabs = await listUserTabs(bin, probeSession)
      if (userTabs.ok) {
        const awayUrl = launched.awayUrl || ''
        // 告示页本身不算「用户动的」；同源的其它页面也不算（用户可能刷新过）。
        const extras = userTabs.tabs.filter((t) => {
          const url = String(t.url || '')
          if (!url) return false
          if (url === awayUrl) return false
          if (url.startsWith('file:///') && url.includes('away.html')) return false
          return true
        })
        verdict = { ownEdge: true, touched: extras.length > 0, extras }
      } else {
        // 查不到就保守处理：当作「用户动过」，绝不动进程。
        verdict = { ownEdge: true, touched: true, extras: [], unknown: userTabs.detail }
      }
    } else {
      verdict = { ownEdge: true, touched: true, extras: [] }
    }
  }

  /* ------------------------------ 关 Agent Window ------------------------------ */

  const stopped = []
  const failed = []
  for (const id of ids) {
    const result = await runBsk(bin, ['session', 'stop', id], 25000)
    if (result.code === 0) stopped.push(id)
    else failed.push({ id, detail: (result.stderr || result.stdout || '').trim().slice(0, 200) })
  }

  /* ------------------- 情形 2：我们起的、没动过 → 顺手把 Edge 也收了 ------------------- */

  let edgeCleanup = null
  if (verdict && verdict.ownEdge && !verdict.touched) {
    await sleep(1200) // 等 Agent Window 真的关掉，再杀进程树，免得它把窗口又拉回来
    const killed = await killLaunchedEdge(launched.pid)
    edgeCleanup = killed
    if (killed.ok) await forgetLaunch()
    else await noteDiag('leave-edge', `清理 Edge 失败：${killed.detail}`)
  } else if (verdict && verdict.ownEdge && verdict.touched) {
    // 情形 3：用户在里面开了东西，把窗口和进程都留给他，只清掉我们的记录。
    await forgetLaunch()
    edgeCleanup = { ok: true, kept: true, extras: verdict.extras.length }
  } else if (launched && !launched.pid) {
    await forgetLaunch()
  }

  if (failed.length) {
    return {
      ok: stopped.length > 0,
      stopped,
      failed,
      error: stopped.length > 0 ? undefined : '关窗失败。',
      detail: failed.map((f) => `${f.id}: ${f.detail}`).join('\n'),
    }
  }

  /* --------------------------------- 组装结果 --------------------------------- */

  const parts = [`已关掉 ${stopped.length} 个 Agent Window`]
  if (edgeCleanup && edgeCleanup.ok && !edgeCleanup.kept) {
    parts.push('这个 Edge 是我为了出门临时拉起的、你没动过，整棵树一起关掉了，桌面不留东西。')
  } else if (edgeCleanup && edgeCleanup.kept) {
    parts.push(`这个 Edge 里有你自己开的 ${edgeCleanup.extras} 个页面，窗口留着给你，只关了 Agent Window。`)
  } else {
    parts.push('Edge 主窗口不受影响。')
  }

  return {
    ok: true,
    stopped,
    killedEdge: Boolean(edgeCleanup && edgeCleanup.ok && !edgeCleanup.kept),
    keptEdge: Boolean(edgeCleanup && edgeCleanup.kept),
    detail: parts.join(''),
  }
}

/* ------------------------------------------------------------- 会话与页面 */


export { resolveEdge, ensureAwayPage, rememberLaunch, recallLaunch, forgetLaunch, ensureBrowser, leaveBrowser }
