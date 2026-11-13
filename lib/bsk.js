/**
 * bsk —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { homedir } from 'node:os'
import { readFile, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { BSK_HOME } from './config.js'
import { errText, sleep } from './util.js'

function runBsk(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: errText(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({ code: -2, stdout, stderr: `${stderr}\n[超时 ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}${errText(error)}` }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}


/** 跑一个系统命令（和 runBsk 同一套超时/收尾逻辑，只是不叫 bsk）。 */
function runCmd(bin, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: errText(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({ code: -2, stdout, stderr: `${stderr}\n[超时 ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (c) => (stdout += c))
    child.stderr?.on('data', (c) => (stderr += c))
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}${errText(error)}` }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}


async function daemonStatus(bin) {
  const result = await runBsk(bin, ['status', '--json'], 15000)
  return {
    alive: result.code === 0,
    code: result.code,
    detail: (result.stderr || result.stdout || '').slice(0, 400),
  }
}


async function daemonLogTail(lines = 20) {
  try {
    const entries = await readdir(BSK_HOME)
    const logs = entries.filter((name) => name.startsWith('daemon.log')).sort()
    if (!logs.length) return ''
    const raw = await readFile(path.join(BSK_HOME, logs[logs.length - 1]), 'utf8')
    return raw.trim().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}


/** 守护进程没在跑就拉一次；拉起后轮询等待就绪，超时就如实放弃。 */
async function ensureDaemon(config) {
  const bin = await resolveBsk(config)
  if (!bin.ok) return { ok: false, error: bin.error, stage: 'bsk-missing', detail: bin.detail }

  const first = await daemonStatus(bin.path)
  if (first.alive) return { ok: true, started: false, bin: bin.path, detail: '守护进程已在运行' }

  let pid = null
  try {
    const child = spawn(bin.path, ['daemon', 'start', '--foreground'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
    pid = child.pid ?? null
  } catch (error) {
    return {
      ok: false,
      error: `拉不起 bsk 守护进程：${errText(error)}`,
      detail: first.detail,
      log: await daemonLogTail(),
    }
  }

  const budget = Number(config.waitDaemonMs) > 0 ? Number(config.waitDaemonMs) : 25000
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    await sleep(1000)
    const now = await daemonStatus(bin.path)
    if (now.alive) return { ok: true, started: true, pid, bin: bin.path, detail: `已自动拉起守护进程（pid=${pid}）` }
  }
  return {
    ok: false,
    error: `守护进程在 ${Math.round(budget / 1000)} 秒内没就绪，已放弃本次操作。`,
    pid,
    detail: first.detail,
    log: await daemonLogTail(),
  }
}

/* ------------------------------------------------------- bsk 可执行文件定位 */


/**
 * 找到 bsk 到底在哪。
 *
 * 为什么不直接写 'bsk'：宿主进程的 PATH 是启动 DSH 那一刻的环境，
 * 用户后来装了 bsk、或者它只落在 ~/.local/bin，PATH 里都可能没有。
 * spawn 一个不存在的名字只会得到 ENOENT，报错又会含糊。
 * 所以按「设置里指定的 → PATH → 常见安装位置」依次试，命中即用。
 */
async function resolveBsk(config) {
  const tried = []

  const candidates = []
  const configured = String((config && config.bskPath) || '').trim()
  // 设置里写 'bsk' 等于没指定（那是历史默认值），交给后面的 PATH 探测。
  if (configured && configured.toLowerCase() !== 'bsk' && configured.toLowerCase() !== 'bsk.exe') {
    candidates.push(configured)
  }
  candidates.push('bsk')
  if (process.platform === 'win32') {
    candidates.push(path.join(homedir(), '.local', 'bin', 'bsk.exe'))
    candidates.push(path.join(homedir(), '.local', 'bin', 'bsk'))
  } else {
    candidates.push(path.join(homedir(), '.local', 'bin', 'bsk'))
  }

  for (const candidate of candidates) {
    // 带路径分隔符的，先确认文件真在；纯名字交给 spawn 去 PATH 里找。
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        const info = await stat(candidate)
        if (!info.isFile()) {
          tried.push(`${candidate}（不是文件）`)
          continue
        }
      } catch {
        tried.push(`${candidate}（不存在）`)
        continue
      }
    }
    tried.push(candidate)
    const probe = await runBsk(candidate, ['--version'], 10000)
    if (probe.code === 0) {
      return { ok: true, path: candidate, detail: (probe.stdout || '').trim().slice(0, 80) }
    }
  }

  return {
    ok: false,
    error: '找不到 bsk 可执行文件，没法操作浏览器。',
    detail: `查过这些位置：\n${tried.map((t) => `  · ${t}`).join('\n')}\n装好 BrowserSkill CLI（bsk）后重试，或在设置里把 bskPath 指到它的完整路径。`,
  }
}

/* ------------------------------------------------------------ 浏览器与 Edge */


/**
 * 当前有没有浏览器连上守护进程。
 *
 * 直接问 bsk 要，不听缓存：用户可能刚把 Edge 关掉，或者扩展刚掉线，
 * 「上次还连着」这种记忆在这里比没有更危险。
 */
async function listBrowsers(bin) {
  const result = await runBsk(bin, ['browsers', '--json'], 15000)
  if (result.code !== 0) {
    return { ok: false, count: 0, detail: (result.stderr || result.stdout || '').trim().slice(0, 300) }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const list = Array.isArray(parsed) ? parsed : []
    // unresponsive 的浏览器不算可用：它连着但卡住了，派活给它只会超时。
    const usable = list.filter((b) => b && !b.unresponsive)
    return { ok: true, count: usable.length, all: list, detail: `${list.length} 个已连接` }
  } catch {
    return { ok: false, count: 0, detail: `browsers --json 输出不是 JSON：${result.stdout.slice(0, 200)}` }
  }
}


/** Edge 进程在不在跑（只查，不起）。 */
async function edgeRunning(bin) {
  // 用 bsk 的 doctor/status 拿不到进程表，这里退到系统命令；失败就当「不知道」。
  const result = await runCmd('tasklist', ['/FI', 'IMAGENAME eq msedge.exe', '/NH'], 15000)
  if (result.code !== 0) return { known: false, running: false }
  const running = /msedge\.exe/i.test(result.stdout)
  return { known: true, running }
}


/** 关掉整个 Edge 进程树（只用于「我们自己起的、用户没动过」的那个）。 */
async function killLaunchedEdge(pid) {
  // /T 连子进程一起关：Edge 主进程下挂着十几个渲染/GPU 进程，只杀主进程会留孤儿。
  const result = await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], 25000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr || '').trim().slice(0, 300) }
}


/**
 * 关掉 Agent Window（逛完就走）。
 *
 * 只停会话，不关整个 Edge：`bsk session stop` 关的是我们那个受控窗口，
 * 用户自己开的浏览窗口不动。这正是「静默浏览」要的效果。
 *
 * 幂等：本来就没会话，就当作已经是关着的，返回成功——调用方不必先查。
 */
/**
 * 列出「用户自己窗口里」的标签页。
 *
 * bsk 的 scope=user 明确指「不属于 Agent Window 的窗口」，
 * 返回字段实测为 {tabs:[{tab_id,title,url,window_id,active,scope}]}。
 * 拿它来回答一个很具体的问题：**这个 Edge 被用户动过吗**。
 */
async function listUserTabs(bin, session) {
  const result = await runBsk(bin, ['tab', 'list', '--session', session, '--scope', 'user', '--json'], 30000)
  if (result.code !== 0) {
    return { ok: false, tabs: [], detail: (result.stderr || result.stdout || '').trim().slice(0, 300) }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const tabs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tabs) ? parsed.tabs : []
    return { ok: true, tabs }
  } catch {
    return { ok: false, tabs: [], detail: `tab list 输出不是 JSON：${result.stdout.slice(0, 200)}` }
  }
}


export { runBsk, runCmd, daemonStatus, daemonLogTail, ensureDaemon, resolveBsk, listBrowsers, edgeRunning, killLaunchedEdge, listUserTabs }
