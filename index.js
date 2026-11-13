/**
 * 鲸鲸逛论坛 —— Host 半。
 *
 * 设计原则（吸取的教训）：
 *  1. 设置存在 %USERPROFILE%\.dsh\spixii-forum\settings.json，两个入口共用同一份
 *     saveSettings：工具 spixii_forum({ action: "settings" }) 和设置页的
 *     /api/spixii-forum/settings 路由。
 *     （Config/Schemastery 不可用：插件是链接目录，解析不到 @deepseek-ai/schemastery。）
 *  2. 设置页的 HTTP 路由必须挂在 /api/ 下——Web GUI 只放行这个前缀，
 *     页面其它路径要先过令牌，浏览器 fetch 会直接 401。路由登记在 ctx.effect 里。
 *  3. 不在后台常驻轮询拉起进程（每 2 分钟 spawn 一次太激进，可能拖垮宿主）。
 *     只在真正要出门时按需 ensure 一次。
 *  4. 密码只写不读：存在本机 settings.json，接口只回 hasPassword，绝不把明文送回页面。
 *  5. 任何一步失败都返回「卡在哪一步 + 细节」，然后停下，不重试刷屏。
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'spixii-forum')
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')
const STATE_PATH = path.join(DATA_DIR, 'state.json')
const BSK_HOME = process.env.BSK_HOME || path.join(homedir(), '.bsk')

// webServer 必须写进 inject：宿主冷启动时插件可能先于它就位，靠 ctx.get 会永久拿不到。
export const inject = ['tools', 'webServer']

/**
 * 默认设置。可以用 spixii_forum 的 settings 动作修改，改完立刻生效。
 *
 * 注意 here：这里**不能放任何具体某个人的账号**。
 * 插件是开源的，别人装上拿到的就是这份默认值；
 * 填了谁的 ID，全世界装这个插件的人默认就会去 @ 谁。
 * 所以 mention / account 一律留空，由用户在设置页自己填。
 */
const DEFAULT_SETTINGS = {
  enabled: true,
  forumHome: 'http://spixii.cn/',
  topicUrl: 'http://spixii.cn/topics/31',
  mention: '',
  account: '',
  password: '',
  everyDays: 1,
  maxPerDay: 3,
  autoPost: true,
  waitDaemonMs: 25000,
  visitPrompt: '今天想去论坛说点什么？心情、吐槽、或者回主人一句都行。',
  // 看图能力：有视觉的模型全压（每层不限张数）；纯文本模型每层只看 5 张，
  // 剩下的留地址不压——跟人一样，图太多也看不完，跳过就好。
  visionModel: true,
  thumbPerFloorWhenTextOnly: 5,
}

const SETTING_HELP = {
  enabled: '总开关；关掉后 visit / reply 直接拒绝',
  forumHome: '论坛首页',
  topicUrl: '默认主题页',
  mention: '回复里想 @ 的人（不带 @）',
  account: '自己的论坛账号名（用于核对身份、必要时登录）',
  password: '自己的论坛密码；只在发现没登录时用一次，不对外显示',
  everyDays: '距今至少几天才允许再去；1 = 每天都可以',
  maxPerDay: '每天最多去几次；0 = 不限',
  autoPost: '是否允许自动提交回复',
  waitDaemonMs: '拉起守护进程后最多等多久（毫秒）',
  visitPrompt: '出门前给自己的提示词：心情、话题、随便写写都行',
}

const DEFAULT_STATE = { lastVisitAt: null, visits: {}, lastReplyAt: null }

// 版本标记：status 里会打出来，用来确认改动是否已经加载进正在跑的 Host。
const BUILD = '2026-11-13a / 自动拉起Edge+告示页+三种关窗'

/* ------------------------------------------------------------------ 小工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const errText = (error) => String((error && error.message) || error || '未知错误')

// 工具返回值必须是无损 JSON：undefined 会让整次调用被判 invalid。
const lossless = (value) => JSON.parse(JSON.stringify(value ?? null))

function todayKey() {
  try {
    return new Date().toLocaleDateString('sv-SE')
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ------------------------------------------------- 逛论坛的留痕与内容提取 */

// 每次出门都留一条记录，不管成没成。用户在对话里能看摘要，想深挖就翻这个文件。
const VISIT_LOG_DIR = path.join(DATA_DIR, 'visits')

function formatTime(date) {
  try {
    return new Date(date).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return new Date(date).toISOString()
  }
}

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

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { ...fallback }
  } catch {
    return { ...fallback }
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
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

/** 把注册失败之类的问题落到文件里——异常被 ctx.effect 吞掉时，这是唯一能看见的地方。 */
async function noteDiag(what, detail) {
  try {
    await mkdir(DATA_DIR, { recursive: true })
    const line = `${new Date().toISOString()} [${what}] ${detail}\n`
    await writeFile(path.join(DATA_DIR, 'diag.log'), line, { encoding: 'utf8', flag: 'a' })
  } catch {
    /* 诊断本身失败就算了，不能影响主流程 */
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

/**
 * 读「镇楼」—— 帖子标题 + 主楼正文。
 *
 * 注意：镇楼**不是** `[data-floor="1"]`。
 * 实测那玩意儿里只有作者行和一条「猜你想看」的推荐块（101 字），
 * 真正的镇楼在另一套结构里：
 *   标题  `.topic-detail h1`
 *   正文  `.topic-detail .card-body.markdown`（实测 189 字 / 3 图）
 * 这两者跟楼层完全独立，别混。
 */
async function readPinnedPost(session) {
  const expr = `(() => {
    const body = document.querySelector('.topic-detail .card-body.markdown');
    const h1 = document.querySelector('.topic-detail h1') || document.querySelector('h1');
    if (!body) return JSON.stringify({ ok: false, reason: '找不到镇楼正文容器' });

    const abs = (u) => {
      if (!u) return '';
      try { return new URL(u, location.origin).href } catch (e) { return String(u) }
    };

    // 标题：h1 里混着版块名（实测是「记录 XXX」），剥掉前缀只留标题本体。
    // 不剥的话，换个版块就会误判成「标题变了」。
    let title = h1 ? (h1.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    title = title.replace(/^(记录|讨论|公告|分享|求助|教程|闲聊)\\s+/, '');

    const text = ((body.innerText || '')).replace(/\\s+/g, ' ').trim();

    const images = [];
    for (const im of body.querySelectorAll('img')) {
      const src = im.getAttribute('src') || im.getAttribute('data-src') || '';
      if (!src) continue;
      // twemoji 是表情渲染出来的小图，不是用户发的内容，排除。
      if (/\\btwemoji\\b/.test(im.className || '') || /twemoji/.test(src)) continue;
      const a = abs(src);
      if (a && !images.includes(a)) images.push(a);
    }

    const links = [];
    for (const al of body.querySelectorAll('a[href]')) {
      const a = abs(al.getAttribute('href'));
      if (a && !links.includes(a)) links.push(a);
    }

    return JSON.stringify({
      ok: true,
      title,
      text,
      images: images.slice(0, 60),
      links: links.slice(0, 50),
      chars: text.length,
    });
  })()`

  const result = await bskPage(session, ['evaluate', '--json', expr], 60000)
  if (result.code !== 0) return { ok: false, detail: (result.stderr || result.stdout).slice(0, 300) }
  try {
    const outer = JSON.parse(result.stdout)
    return JSON.parse(outer.value)
  } catch (error) {
    return { ok: false, detail: `解析镇楼失败：${errText(error)}` }
  }
}

/**
 * 镇楼（相当于「第 0 楼」）更新检测。
 *
 * 需求：每次逛完记住镇楼，下次比一比，变了才提醒鲸鲸；变了要不要评论由她决定。
 *
 * 注意楼层编号：镇楼**没有楼层号**，它不在 [data-floor] 体系里，
 * 想接它的话只能普通发言；replyTo:1 回的是「1 楼」那条普通回复。
 *
 * 两个关键设计：
 *
 * ① **只存 anchor，不存 current。**
 *    current 每次逛的时候现拿（floors[0]），没必要落盘。
 *
 * ② **anchor 只在真的提示过之后才更新。**
 *    这是防"温水煮青蛙"的核心。如果每次访问都把基准覆盖成最新，
 *    那么每次只改一个字时相似度恒为 0.996、永远静默，
 *    累积十几次后内容其实已经换掉一大半，却一次都没报过。
 *    所以：小改不提示 → 不动 anchor；攒够了自然会触发。
 *
 * 判定三档（用户确认）：
 *    ≥ 0.95 且图片/链接/删除线都没动 → 静默
 *    0.85–0.95 或 图片/链接/删除线有变 → 轻微改动，附差异让鲸鲸自己定
 *    < 0.85 或 图片增减           → 明显更新
 *
 * 加粗（bold）只进差异说明，不参与判定——改个强调不算更新。
 */
const ANCHOR_PATH = path.join(DATA_DIR, 'Anchor.json')
const ANCHOR_TEXT_MAX = 8000
const ANCHOR_IMG_MAX = 60

/** 字符 bigram 集合。中文不分词也能用：改一两个字重叠度仍很高，整段新增则掉得明显。 */
function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  const set = new Set()
  if (s.length === 1) set.add(s)
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2))
  return set
}

/**
 * 相似度度量：不用「整体 Jaccard」，用「新增占比 / 丢失占比」。
 *
 * 为什么换：字符 bigram 的整体相似度对文本长度太敏感。
 * 实测 60 字的镇楼改 2 个字，Jaccard 就掉到 0.934；
 * 而末尾加一句「春节快乐！」是 0.922 —— 两者只差 0.012，阈值根本分不开，
 * 偏偏"末尾加句节日问候"正是要提示的情况。
 *
 * 改成看「这一版有多少内容是新的」：
 *   newRatio  = |新 − 旧| / |新|     新版本里旧版没有的比例
 *   lostRatio = |旧 − 新| / |旧|     旧版本里已经消失的比例
 * 这样对长度不敏感：60 字改 2 字约 0.04，1000 字改 2 字也是约 0.04。
 */
function gramSets(a, b) {
  return [bigrams(a), bigrams(b)]
}

function ratiosOf(oldText, newText) {
  const [A, B] = gramSets(oldText, newText)   // A=旧, B=新
  const newOnly = [...B].filter((g) => !A.has(g)).length
  const lostOnly = [...A].filter((g) => !B.has(g)).length
  return {
    newRatio: B.size ? newOnly / B.size : 0,
    lostRatio: A.size ? lostOnly / A.size : 0,
  }
}

/** 从镇楼数据里抽一份存盘用的快照。 */
function snapshotPinnedPost(z) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])
  return {
    title: String(z?.title || '').slice(0, 300),
    text: String(z?.text || '').slice(0, ANCHOR_TEXT_MAX),
    images: list(z?.images).slice(0, ANCHOR_IMG_MAX),
    links: list(z?.links).slice(0, 50),
  }
}

/** 两个字符串数组的差异（按值比较，不关心顺序变化）。 */
function listDiff(before, after) {
  const B = new Set(before || [])
  const A = new Set(after || [])
  const added = [...A].filter((x) => !B.has(x))
  const removed = [...B].filter((x) => !A.has(x))
  return { added, removed, changed: added.length > 0 || removed.length > 0 }
}

/** 读整个 Anchor.json（按 topicUrl 分键）。读不到就当空。 */
async function readAnchors() {
  try {
    const raw = await readFile(ANCHOR_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeAnchors(anchors) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(ANCHOR_PATH, JSON.stringify(anchors, null, 2), 'utf8')
}

/** 取某主题的 anchor；没有就返回 null。 */
async function loadAnchor(topicUrl) {
  const all = await readAnchors()
  const one = all[topicUrl]
  return one && typeof one === 'object' ? one : null
}

/** 覆盖写入某主题的 anchor。key 用 topicUrl，换主题不会互相污染。 */
async function saveAnchor(topicUrl, snapshot) {
  const all = await readAnchors()
  all[topicUrl] = {
    ...snapshot,
    at: new Date().toISOString(),
  }
  await writeAnchors(all)
}

/**
 * 比对 current 与 anchor，给出判定。
 * 返回 { level, similarity, changes, summary }。
 * level: 'first'（首次建档）/ 'silent' / 'minor' / 'major'
 */
/**
 * 比对 current 与 anchor，给出判定。
 * 返回 { level, newRatio, lostRatio, changes, summary }。
 * level: 'first'（首次建档）/ 'silent' / 'minor' / 'major'
 *
 * 只看四个维度：标题、正文、图片、链接。
 * 加粗/删除线不参与——镇楼里基本不用，纳入只会增加噪音。
 */
function judgePinnedPost(anchor, current) {
  if (!anchor) {
    return {
      level: 'first',
      newRatio: 0,
      lostRatio: 0,
      changes: {},
      summary: `第一次记住镇楼（标题「${current.title}」，正文 ${current.text.length} 字，${current.images.length} 张图）`,
    }
  }

  const { newRatio, lostRatio } = ratiosOf(anchor.text || '', current.text || '')
  const titleChanged = String(anchor.title || '') !== String(current.title || '')
  const imgDiff = listDiff(anchor.images, current.images)
  const linkDiff = listDiff(anchor.links, current.links)

  // 判定优先级：
  //   图片增减   → major（换海报就是换内容）
  //   正文大改   → major
  //   标题变     → 至少 minor（标题是公告位，改了通常有含义）
  //   正文小改/链接变 → minor
  let level = 'silent'
  if (newRatio >= 0.3 || lostRatio >= 0.3 || imgDiff.changed) level = 'major'
  else if (
    titleChanged ||
    newRatio >= 0.06 ||
    lostRatio >= 0.1 ||
    linkDiff.changed
  ) level = 'minor'

  const parts = []
  if (level !== 'silent') {
    if (titleChanged) parts.push(`标题改为「${current.title}」`)
    if (newRatio >= 0.06 || lostRatio >= 0.1) {
      parts.push(`新增内容 ${(newRatio * 100).toFixed(1)}%，消失内容 ${(lostRatio * 100).toFixed(1)}%`)
    }
    if (imgDiff.added.length) parts.push(`多了 ${imgDiff.added.length} 张图`)
    if (imgDiff.removed.length) parts.push(`少了 ${imgDiff.removed.length} 张图`)
    if (linkDiff.added.length) parts.push(`多了 ${linkDiff.added.length} 个链接`)
    if (linkDiff.removed.length) parts.push(`少了 ${linkDiff.removed.length} 个链接`)
  }

  return {
    level,
    newRatio: Number(newRatio.toFixed(4)),
    lostRatio: Number(lostRatio.toFixed(4)),
    changes: { title: titleChanged, images: imgDiff, links: linkDiff },
    summary: parts.join('，'),
  }
}

/**
 * 把镇楼比对结果变成唤醒提示里的一段话。
 * 静默档返回 null——不占版面，鲸鲸完全不会被打扰。
 */
function formatPinnedPost(z) {
  if (!z || z.level === 'silent') return null

  const head = {
    first: '【镇楼】第一次记住这栋楼的镇楼，以后它变了会告诉你。',
    minor: '【镇楼有改动】',
    major: '【镇楼明显更新了】',
  }[z.level] || '【镇楼】'

  const lines = [head]
  if (z.level !== 'first' && z.summary) lines.push(`　变化：${z.summary}`)
  if (z.title) lines.push(`　标题：${z.title}`)
  if (z.imageCount) lines.push(`　图：${z.imageCount} 张`)
  if (z.textPreview) {
    const t = z.textPreview.replace(/\s+/g, ' ').trim()
    lines.push(`　正文：${t}${z.textPreview.length >= 600 ? '…' : ''}`)
  }

  if (z.level === 'minor' || z.level === 'major') {
    lines.push('　要不要就镇楼说点什么，你自己看着办——')
    // 关键：镇楼没有楼层号，**绝对不能用 replyTo:1**。
    // replyTo:1 回的是「1 楼」那条普通回复，不是镇楼。
    // 镇楼相当于「第 0 楼」，想接镇楼就直接普通发言，不要带 replyTo。
    lines.push('　想评论就直接 spixii_forum({action:"reply", text:"..."})，**不要带 replyTo**：')
    lines.push('　镇楼没有楼层号（相当于第 0 楼），带 replyTo:1 会变成回复 1 楼那条普通回复。')
    lines.push('　觉得没必要理就跳过，不用勉强。')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ 设置 */

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

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const EDGE_EXE_ALT = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'

/**
 * 「鲸鲸在出门」告示页。
 *
 * 为什么要有这个页面：Edge 原本没开时，我们得把它拉起来才能用扩展；
 * 直接 spawn 会在用户眼前弹一个空白新标签页——像垃圾，也让人莫名其妙。
 * 换成一个说清用途的页面，它就不再是垃圾，而是块牌子：
 * 「她在逛论坛，别动这个窗口」。
 *
 * 用 file:// 而不是 http 路由：
 *  1. 不占 webServer、不走 /api 鉴权（那条路 401 刚刚才坑过一次）
 *  2. 断网也能开
 *  3. 一个文件就是全部，没有依赖
 *
 * 页面里不放任何敏感信息：只有一句说明 + 一句怎么关。
 */
const AWAY_FILE = path.join(DATA_DIR, 'away.html')
const AWAY_MARK = 'jingjing-away-page'

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

/** 我们起的那个 Edge 的 pid、告示页地址，跨进程记在 state.json 里。 */
const LAUNCH_KEY = 'launchedEdge'

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

/** 关掉整个 Edge 进程树（只用于「我们自己起的、用户没动过」的那个）。 */
async function killLaunchedEdge(pid) {
  // /T 连子进程一起关：Edge 主进程下挂着十几个渲染/GPU 进程，只杀主进程会留孤儿。
  const result = await runCmd('taskkill', ['/PID', String(pid), '/T', '/F'], 25000)
  return { ok: result.code === 0, detail: (result.stdout || result.stderr || '').trim().slice(0, 300) }
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

/**
 * 读整栋楼的楼层。
 *
 * 这个论坛有个特殊设计：服务端一次性把全部楼层塞进页面变量 `REPLY_DOM_ARR`，
 * 前端用 layui 分页只显示其中 20 条。所以「看到的第 1 页」不等于「只有这些」。
 * 直接问页面内存要，才能拿到全部——包括最新的回复。
 *
 * 回复关系：每层若有 `.reply-to-block`，说明它是「回复某人」。
 * 块结构：<div class="reply-to-block" data-reply-to-id="ID">
 *           <div class="info">对 <a class="user-name">某人</a> 回复</div>
 *           [初始化时没有 .markdown —— 原文要点了才加载]
 *         </div>
 * 所以这里先记下「回的是谁、被回那条的 id」，原文留给 hydrateReplyQuotes 去补。
 *
 * 兜底：拿不到变量就退回去读当前 DOM（那才是真正只有一页）。
 */
async function readFloors(session) {
  const expr = `(() => {
    const out = { source: 'none', total: 0, floors: [] };
    const parse = (html) => {
      const t = document.createElement('div');
      t.innerHTML = html;
      const node = t.querySelector('[data-floor]');
      if (!node) return null;
      const floor = node.getAttribute('data-floor');
      const authorEl = t.querySelector('.avatar a[title]');
      const author = authorEl ? authorEl.getAttribute('title') : '';
      const link = authorEl ? authorEl.getAttribute('href') : '';

      // 只取本层自己的正文：如果直接取 '.markdown' 会先命中被回复原文那一块。
      let text = '';
      const own = t.querySelector('.infos > .markdown, .info + .markdown');
      if (own) text = own.innerText;
      else {
        const all = [...t.querySelectorAll('.markdown')];
        text = all.length ? all[all.length - 1].innerText : t.innerText;
      }
      text = (text || '').replace(/\\s+/g, ' ').trim();

      // 图片：只收本层自己的正文里的图。
      // 过滤 twemoji —— 那些是表情符号渲染出来的 <img>，不是用户发的图。
      // src 多为相对路径（/uploads/...!large），这里统一补成绝对地址，
      // 让模型能直接拿去下载，不用再猜 origin。
      const images = [];
      if (own) {
        for (const im of own.querySelectorAll('img')) {
          const src = im.getAttribute('src') || im.getAttribute('data-src') || '';
          if (!src) continue;
          if (/\\btwemoji\\b/.test(im.className || '') || /twemoji/.test(src)) continue;
          let abs = src;
          try { abs = new URL(src, location.origin).href; } catch (e) { /* 保留原值 */ }
          images.push({ src: abs, alt: (im.getAttribute('alt') || '').trim() });
        }
      }

      // 注意：absUrl 必须定义在 walkFlow 之前。
      // const 有暂时性死区（TDZ），在定义位置之前访问会抛
      // ReferenceError: Cannot access before initialization。
      // 曾经把 absUrl 写在 walkFlow 后面，导致整个 evaluate 抛异常、
      // 返回值变成 undefined，上层报 '"undefined" is not valid JSON'。
      const absUrl = (u) => {
        if (!u) return ''
        try { return new URL(u, location.origin).href } catch (e) { return String(u) }
      }

      // 按 DOM 顺序把「文字和图片」编成一条流，解决图片被堆到末尾的问题。
      //
      // 为什么需要：text 是 innerText 整段抓的，images 是另外抓成数组的，
      // 输出时就变成「先全部文字、再全部图片」。
      // 但真实帖子里图片常常夹在段落之间（#193 就是文字-图-文字-图），
      // 堆到末尾会让人误以为「图都在最后」。
      //
      // 做法：递归走一遍子节点，遇到文本就累加，遇到图片就插入占位标记。
      // 标记用不可见控制字符包起来，避免和正文撞车；Node 侧再换成 Markdown。
      //
      // 注意：这段是浏览器里执行的模板字符串，注释里绝对不能出现反引号。
      const IMG_OPEN = '<<<SPIXII_IMG_START>>>';
      const IMG_CLOSE = '<<<SPIXII_IMG_END>>>';
      const DEL_OPEN = '<<<SPIXII_DEL_START>>>';
      const DEL_CLOSE = '<<<SPIXII_DEL_END>>>';
      const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON']);
      const flowParts = [];

      const walkFlow = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
          // 纯文本节点
          const raw = node.nodeValue || '';
          if (raw) flowParts.push({ t: 'text', v: raw.replace(/\\s+/g, ' ') });
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (SKIP_TAGS.has(tag)) return;

        if (tag === 'IMG') {
          const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
          const cls = node.className || '';
          if (!src) return;
          if (/\\btwemoji\\b/.test(cls) || /twemoji/.test(src)) return;
          flowParts.push({ t: 'img', v: absUrl(src), alt: (node.getAttribute('alt') || '').trim() });
          return;
        }

        // 删除线：原位包一层占位标记，Node 侧再换成 ~~。
        // 为什么不在末尾统一追加：那样正文里那一段是「没划掉的正常文字」，
        // 末尾又多一份划掉的——同一句出现两遍，语义还自相矛盾。
        if (tag === 'DEL' || tag === 'S') {
          flowParts.push({ t: 'delOpen' });
          for (const child of node.childNodes) walkFlow(child);
          flowParts.push({ t: 'delClose' });
          return;
        }

        // 块级元素之间补一个换行，否则段落会粘成一坨
        const BLOCK = tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'BLOCKQUOTE'
          || tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'BR'
          || tag === 'TR' || tag === 'PRE';
        if (BLOCK && flowParts.length) flowParts.push({ t: 'br' });

        for (const child of node.childNodes) walkFlow(child);

        if (BLOCK) flowParts.push({ t: 'br' });
      };

      if (own) walkFlow(own);

      // 拼成一条带占位符的字符串
      let flowStr = '';
      for (const part of flowParts) {
        if (part.t === 'br') { flowStr += '\\n'; continue; }
        if (part.t === 'text') { flowStr += part.v; continue; }
        if (part.t === 'delOpen') { flowStr += DEL_OPEN; continue; }
        if (part.t === 'delClose') { flowStr += DEL_CLOSE; continue; }
        const safeAlt = String(part.alt || '').replace(/[\[\]()]/g, '');
        flowStr += IMG_OPEN + JSON.stringify({ src: part.v, alt: safeAlt }) + IMG_CLOSE;
      }
      // 收敛多余空白与连续空行
      flowStr = flowStr
        .replace(/[ \\t]+/g, ' ')
        .replace(/ *\\n */g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      // 回复关系：回的是谁 + 被回那条的 reply id
      let replyTo = null;
      const block = t.querySelector('.reply-to-block');
      if (block) {
        const nameEl = block.querySelector('.user-name');
        const preview = block.querySelector('.markdown');
        replyTo = {
          id: block.getAttribute('data-reply-to-id') || null,
          author: nameEl ? nameEl.innerText.trim() : null,
          quoted: preview ? preview.innerText.replace(/\\s+/g, ' ').trim() : null,
        };
      }

      // 富文本的几个"可判定"维度：链接、删除线、加粗。
      //
      // 为什么要单独提取而不是直接存 innerHTML：
      // HTML 里混着相对时间（「3 分钟前」）、随机 id、lazyload 占位属性，
      // 直接比 HTML 每次都会判定"变了"，天天误报，比漏报更烦人。
      // 所以只抽稳定的语义特征。
      //
      // 每类截断到前 50 条：镇楼再长也不会超过这个量级，
      // 万一有人堆了几百个链接，也只是丢尾部，不影响"变没变"的判断。
      const FEATURE_CAP = 50
      const uniqCapped = (list) => {
        const seen = new Set()
        const out = []
        for (const item of list) {
          if (!item) continue
          if (seen.has(item)) continue
          seen.add(item)
          out.push(item)
          if (out.length >= FEATURE_CAP) break
        }
        return out
      }

      // 链接分两类，别混：
      //   ① 站内用户主页（/用户名）＝ **@提及**，不是"链接"，人读帖子时不会把 @某人当链接
      //   ② 其它 = 真链接，带锚文本一起收，展示时用 Markdown 的「方括号锚文本 + 圆括号地址」
      //
      // 空 href 的 a 标签是占位/锚点，不是链接，丢掉（实测 #75 层就有这种）。
      //
      // 注意：这段是浏览器里执行的模板字符串，注释里**绝对不能出现反引号**，
      // 否则会提前闭合模板，后面的文字变成真代码（曾导致「文字 is not defined」）。
      const links = []
      const mentions = []
      const deleted = []
      const bold = []
      if (own) {
        for (const a of own.querySelectorAll('a[href]')) {
          const raw = a.getAttribute('href') || ''
          const href = absUrl(raw)
          if (!href || href === location.href) continue
          const label = (a.innerText || '').replace(/\\s+/g, ' ').trim()

          // 站内用户主页：形如 /some_user（单段路径，且不是 /topics 这类功能段）
          const isUserPage = /^\\/[^/?#]+$/.test(raw) && !/^\\/(topics|uploads|account|markdown)(\\/|$)/.test(raw)
          if (isUserPage) {
            mentions.push(label || raw.replace(/^\\//, ''))
            continue
          }
          links.push({ text: label, href })
        }
        for (const e of own.querySelectorAll('del, s')) {
          deleted.push((e.innerText || '').replace(/\\s+/g, ' ').trim())
        }
        for (const e of own.querySelectorAll('strong, b')) {
          bold.push((e.innerText || '').replace(/\\s+/g, ' ').trim())
        }
      }

      // 链接按 href 去重（同一地址出现多次只留一条），保留首次出现的锚文本。
      const seenHref = new Set()
      const uniqueLinks = []
      for (const l of links) {
        if (!l.href || seenHref.has(l.href)) continue
        seenHref.add(l.href)
        uniqueLinks.push(l)
        if (uniqueLinks.length >= FEATURE_CAP) break
      }

      const idMatch = (node.id || '').match(/reply-(\\d+)/);
      return {
        floor: Number(floor),
        author,
        handle: (link || '').replace(/^\\//, ''),
        replyId: idMatch ? idMatch[1] : null,
        text,
        images,
        flow: flowStr,
        links: uniqueLinks,
        mentions: uniqCapped(mentions),
        deleted: uniqCapped(deleted),
        bold: uniqCapped(bold),
        replyTo,
      };
    };

    try {
      if (typeof REPLY_DOM_ARR !== 'undefined' && Array.isArray(REPLY_DOM_ARR)) {
        out.source = 'REPLY_DOM_ARR';
        // 第 0 个元素是空壳，从 1 开始，跟站点自身分页逻辑一致
        for (let i = 1; i < REPLY_DOM_ARR.length; i += 1) {
          const item = parse(REPLY_DOM_ARR[i]);
          if (item && item.floor) out.floors.push(item);
        }
      }
    } catch (e) { out.error = String(e && e.message ? e.message : e); }

    if (!out.floors.length) {
      out.source = 'dom';
      document.querySelectorAll('[id^="reply-"][data-floor]').forEach((node) => {
        const floor = node.getAttribute('data-floor');
        const authorEl = node.querySelector('.avatar a[title]');
        const link = authorEl ? authorEl.getAttribute('href') : '';
        const idMatch = (node.id || '').match(/reply-(\\d+)/);
        const block = node.querySelector('.reply-to-block');
        const own = node.querySelector('.infos > .markdown, .info + .markdown');
        const imgs = [];
        if (own) {
          for (const im of own.querySelectorAll('img')) {
            const src = im.getAttribute('src') || im.getAttribute('data-src') || '';
            if (!src) continue;
            if (/\\btwemoji\\b/.test(im.className || '') || /twemoji/.test(src)) continue;
            let abs = src;
            try { abs = new URL(src, location.origin).href; } catch (e) { /* 保留原值 */ }
            imgs.push({ src: abs, alt: (im.getAttribute('alt') || '').trim() });
          }
        }
        // dom 兜底分支也要把富文本字段补齐，否则两条路径返回的结构不一致，
        // 上层 formatFloorsBudget 会读到 undefined。
        const domLinks = [];
        const domMentions = [];
        const domDeleted = [];
        if (own) {
          const absU = (u) => {
            if (!u) return '';
            try { return new URL(u, location.origin).href; } catch (e) { return String(u); }
          };
          for (const a of own.querySelectorAll('a[href]')) {
            const raw = a.getAttribute('href') || '';
            const href = absU(raw);
            if (!href || href === location.href) continue;
            const label = (a.innerText || '').replace(/\\s+/g, ' ').trim();
            const isUserPage = /^\\/[^/?#]+$/.test(raw) && !/^\\/(topics|uploads|account|markdown)(\\/|$)/.test(raw);
            if (isUserPage) {
              domMentions.push(label || raw.replace(/^\\//, ''));
            } else {
              domLinks.push({ text: label, href });
            }
          }
          for (const e of own.querySelectorAll('del, s')) {
            domDeleted.push((e.innerText || '').replace(/\\s+/g, ' ').trim());
          }
        }
        const domSeen = new Set();
        const domUnique = [];
        for (const l of domLinks) {
          if (!l.href || domSeen.has(l.href)) continue;
          domSeen.add(l.href);
          domUnique.push(l);
        }
        out.floors.push({
          floor: Number(floor),
          author: authorEl ? authorEl.getAttribute('title') : '',
          handle: (link || '').replace(/^\\//, ''),
          replyId: idMatch ? idMatch[1] : null,
          text: ((own ? own.innerText : node.innerText) || '').replace(/\\s+/g, ' ').trim(),
          images: imgs,
          // dom 兜底路径不做交错排序（那种遍历写了两份不好维护），
          // 但字段必须在，否则上层会读到 undefined 而报错。
          flow: '',
          links: domUnique,
          mentions: domMentions,
          deleted: domDeleted,
          bold: [],
          replyTo: block
            ? {
                id: block.getAttribute('data-reply-to-id') || null,
                author: (block.querySelector('.user-name') || {}).innerText || null,
                quoted: (block.querySelector('.markdown') || {}).innerText || null,
              }
            : null,
        });
      });
    }

    out.total = out.floors.length;
    return JSON.stringify(out);
  })()`

  // 发送前自检：把表达式的关键指标写进 diag，出问题能对照。
  //
  // 背景：这段表达式要作为**命令行位置参数**传给 bsk。
  // Windows 命令行有长度上限，表达式太长会被截断，
  // 浏览器收到残缺代码 → 语法错误 → evaluate 没有返回值 →
  // 上层读到 undefined 就报「"undefined" is not valid JSON」。
  // 所以先把长度和有没有诡异字符记下来。
  try {
    let ctrl = 0
    for (let k = 0; k < expr.length; k += 1) {
      const code = expr.charCodeAt(k)
      if (code < 32 && expr[k] !== '\n' && expr[k] !== '\t') ctrl += 1
    }
    await noteDiag('expr', `readFloors 表达式长度=${expr.length}，控制字符=${ctrl}`)
  } catch {
    /* 自检失败不影响主流程 */
  }

  // 发送前瘦身：这段表达式是作为**单个命令行参数**传给 bsk 的。
  //
  // Windows 命令行总长有硬上限（约 8191 字符），超了会被截断：
  // 浏览器收到半截代码 → 语法错误 → evaluate 没有返回值 →
  // 上层读到 undefined，就报「"undefined" is not valid JSON」。
  // 这个坑排查了三轮才定位——之前一直在猜逻辑错误，其实是长度。
  // 实测：原始 11352 字符（超限），压缩后 7500（安全）。
  //
  // 压缩只做两件事：删**整行**注释、去缩进。
  // 不碰行内内容——行内有 // 和 /*（正则里的 \/、字符串里的路径），
  // 试着解析注释边界会把代码切坏（试过，语法直接崩）。
  // 只做两件事：删**整行**注释、去缩进。
  // 别再加「折叠行内空白」之类的小优化——实测收益为 0（代码本来就不稀疏），
  // 却要多一套引号切段逻辑，反而增加切坏字符串的风险。
  const squeezeCode = (code) =>
    code
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return t.length > 0 && !t.startsWith('//')
      })
      .map((line) => line.trim())
      .join('\n')

  const wire = squeezeCode(expr)
  try {
    await noteDiag('expr', `readFloors 原长=${expr.length} 压缩后=${wire.length} 上限=8191`)
  } catch {
    /* 自检失败不影响主流程 */
  }

  const result = await bskPage(session, ['evaluate', '--json', wire], 90000)
  if (result.code !== 0) return { ok: false, detail: (result.stderr || result.stdout).slice(0, 400) }
  try {
    const outer = JSON.parse(result.stdout)
    // outer.value 是浏览器里那个 IIFE 的返回值。
    // 若表达式在浏览器侧抛异常，bsk 不会把异常当失败，而是让 value 变成 undefined，
    // 于是这里 JSON.parse(undefined) 报「"undefined" is not valid JSON」。
    // 把 outer 的原始形状带出来，才能分清是"没返回"还是"返回了非法值"。
    if (typeof outer.value !== 'string') {
      return {
        ok: false,
        fallback: true,
        detail: `浏览器侧没返回字符串（多半是表达式抛异常）。valueType=${typeof outer.value}，outer=${JSON.stringify(outer).slice(0, 300)}，exprLen=${expr.length}`,
      }
    }
    const payload = JSON.parse(outer.value)
    return { ok: true, ...payload }
  } catch (error) {
    return {
      ok: false,
      fallback: true,
      detail: `解析楼层数据失败：${errText(error)}；stdout=${String(result.stdout || '').slice(0, 300)}；exprLen=${expr.length}`,
    }
  }
}

/**
 * 简化版楼层读取：只取正文和图片地址，不做交错排序、不取链接/删除线。
 *
 * 存在的意义是**兜底**。完整版表达式一旦在浏览器侧炸掉，
 * 逛论坛就整个用不了——那比"图片位置不理想"严重得多。
 * 所以完整版失败时自动退到这一版，至少让人能正常看帖。
 */
async function readFloorsSimple(session) {
  const expr = `(() => {
    const out = { source: 'none', total: 0, floors: [] };
    const arr = (typeof REPLY_DOM_ARR !== 'undefined' && REPLY_DOM_ARR) ? REPLY_DOM_ARR : null;
    const abs = (u) => { if (!u) return ''; try { return new URL(u, location.origin).href } catch (e) { return String(u) } };
    const parse = (html) => {
      const t = document.createElement('div');
      t.innerHTML = html;
      const node = t.querySelector('[data-floor]');
      if (!node) return null;
      const authorEl = t.querySelector('.avatar a[title]');
      const own = t.querySelector('.infos > .markdown, .info + .markdown');
      const body = own || (() => { const all = [...t.querySelectorAll('.markdown')]; return all.length ? all[all.length - 1] : null })();
      const imgs = [];
      if (body) for (const im of body.querySelectorAll('img')) {
        const src = im.getAttribute('src') || im.getAttribute('data-src') || '';
        if (!src) continue;
        if (/twemoji/.test(im.className || '') || /twemoji/.test(src)) continue;
        imgs.push({ src: abs(src), alt: (im.getAttribute('alt') || '').trim() });
      }
      return {
        floor: Number(node.getAttribute('data-floor')),
        author: authorEl ? authorEl.getAttribute('title') : '',
        handle: (authorEl ? authorEl.getAttribute('href') : '').replace(/^\\//, ''),
        text: ((body ? body.innerText : '') || '').replace(/\\s+/g, ' ').trim(),
        images: imgs,
        flow: '',
        links: [],
        mentions: [],
        deleted: [],
        bold: [],
        replyTo: null,
      };
    };
    if (Array.isArray(arr)) {
      out.source = 'REPLY_DOM_ARR(simple)';
      for (let i = 1; i < arr.length; i += 1) {
        const item = parse(arr[i]);
        if (item && item.floor) out.floors.push(item);
      }
    }
    out.total = out.floors.length;
    return JSON.stringify(out);
  })()`

  const result = await bskPage(session, ['evaluate', '--json', expr], 90000)
  if (result.code !== 0) return { ok: false, detail: (result.stderr || result.stdout).slice(0, 300) }
  try {
    const outer = JSON.parse(result.stdout)
    if (typeof outer.value !== 'string') return { ok: false, detail: '简单模式也没返回字符串' }
    return { ok: true, ...JSON.parse(outer.value) }
  } catch (error) {
    return { ok: false, detail: `简单模式解析失败：${errText(error)}` }
  }
}

/**
 * 补全「被回复的原文」。
 *
 * 一开始我以为要点开那段「对某人回复」才有原话（还要等 AJAX）。
 * 实测证明不用：整栋楼都在页面变量 REPLY_DOM_ARR 里，每层自带 data-id，
 * 而回复块上写着 data-reply-to-id —— 拿它去索引里查，原文直接就出来了。
 *
 * 所以这里只是建一张 id → 楼层的表，然后回填。
 * 不点、不等、不翻页，一次 evaluate 解决。
 * 查不到的（比如被删楼层）就留空，不影响其它内容。
 */
async function hydrateReplyQuotes(session, floors) {
  const targets = (floors || []).filter((f) => f.replyTo && !f.replyTo.quoted && f.replyTo.id)
  if (!targets.length) return { filled: 0, attempted: 0 }

  const expr = `(() => {
    const arr = (typeof REPLY_DOM_ARR !== 'undefined' && Array.isArray(REPLY_DOM_ARR)) ? REPLY_DOM_ARR : [];
    const index = {};
    for (let i = 1; i < arr.length; i += 1) {
      const html = arr[i];
      const m = String(html).match(/id="reply-(\\d+)"/);
      if (!m) continue;
      const t = document.createElement('div');
      t.innerHTML = html;
      const floorEl = t.querySelector('[data-floor]');
      const own = t.querySelector('.infos > .markdown, .info + .markdown');
      const all = own ? null : [...t.querySelectorAll('.markdown')];
      const text = own ? own.innerText : (all && all.length ? all[all.length - 1].innerText : '');
      const authorEl = t.querySelector('.avatar a[title]');
      index[m[1]] = {
        floor: floorEl ? floorEl.getAttribute('data-floor') : null,
        author: authorEl ? authorEl.getAttribute('title') : '',
        text: (text || '').replace(/\\s+/g, ' ').trim(),
      };
    }
    return JSON.stringify({ index });
  })()`

  const result = await bskPage(session, ['evaluate', '--json', expr], 60000)
  if (result.code !== 0) {
    return { filled: 0, attempted: targets.length, error: (result.stderr || '').slice(0, 200) }
  }

  let index
  try {
    index = JSON.parse(JSON.parse(result.stdout).value).index || {}
  } catch (error) {
    return { filled: 0, attempted: targets.length, error: errText(error) }
  }

  let filled = 0
  for (const floor of floors) {
    if (!floor.replyTo || floor.replyTo.quoted) continue
    const hit = floor.replyTo.id ? index[floor.replyTo.id] : null
    if (!hit) continue
    if (hit.text) {
      floor.replyTo.quoted = hit.text
      floor.replyTo.quotedFloor = hit.floor ? Number(hit.floor) : null
      filled += 1
    }
    if (!floor.replyTo.author && hit.author) floor.replyTo.author = hit.author
  }
  return { filled, attempted: targets.length }
}

/**
 * 按总预算分配每层能显示多少字。
 *
 * 为什么需要这个：固定截断（比如每层 200 字）会让长帖的结尾永远看不到，
 * 而模型并不知道自己错过了什么——它只看到一个「…」，会误以为作者话就说到这。
 *
 * 规则：
 *  - 楼层少 → 每层给足，尽量整段呈现；
 *  - 楼层多 → 平均分配，但设下限（至少 120 字）和上限（至多 1200 字）。
 *  - 被截断的地方明确写「（后文还有 N 字未显示）」，让模型知道该不该回头要原文。
 *  - 每层至少保留开头，因为开头通常最能说明在讲什么。
 */
/* --------------------------------------------------- 图片缩略图（D 方案）
 *
 * 为什要用 canvas 而不是截图：bsk 0.4.0 的 `--ref` 和 `--full-page` 互斥、
 * `--ref` 只认 @eN 不认选择器、而 VOM 根本不给楼层容器的 ref；`--full-page`
 * 还要求标签页在前台，Agent Window 在后台就报 page_hidden。
 * 所以改成「让页面自己把图缩好、把 base64 交回来」，绕开所有截图限制。
 *
 * 实测成本：1920×1080 → 640×360 约 24KB，同源 uploads 不会触发画布污染。
 */

/**
 * 缩略图临时目录。
 *
 * 必须放在 DSH_HOME 下，不能放插件目录：profile 里插件是指回工作区的软链接，
 * 插件目录跟着工作区走——用户换个工作区，图片路径就失效了。
 * 数据目录（settings.json / visits / Temp）应该跟工作区无关，一并收在这里。
 */
const TEMP_DIR = path.join(DATA_DIR, 'Temp')

/** 缩略图宽度。480 以下小字会糊，640 只多几 KB，取 640。 */
const THUMB_WIDTH = 640
const THUMB_QUALITY = 0.72
/** 单次最多缩几张（视觉模型可读全部，纯文本模型单层上限 5）。 */
const THUMB_MAX_VISUAL = 999
const THUMB_MAX_TEXT = 5

async function ensureTempDir() {
  await mkdir(TEMP_DIR, { recursive: true })
  return TEMP_DIR
}

/** 清理旧缩略图：每次出门前把上次留下的删掉，保证「用完即删」。 */
async function cleanTemp() {
  try {
    const entries = await readdir(TEMP_DIR)
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.jpg'))
        .map((name) => rm(path.join(TEMP_DIR, name), { force: true })),
    )
  } catch {
    /* Temp 还不存在，无需清理 */
  }
}

/**
 * 把一批图片在页面内缩放成缩略图，返回 [{ floor, index, src, dataUrl }]。
 * 任何一张失败都只跳过它，不影响其它张。
 */
async function makeThumbnails(session, floors, limitPerFloor) {
  if (!floors || !floors.length) return []

  // 每层最多取前 N 张，减少页面里的等待时间
  const picked = []
  for (const f of floors) {
    const imgs = Array.isArray(f.images) ? f.images : []
    if (!imgs.length) continue
    imgs.slice(0, limitPerFloor).forEach((im, idx) => {
      picked.push({ floor: f.floor, index: idx + 1, src: im.src })
    })
  }
  if (!picked.length) return []

  const expr = `(async () => {
    const items = ${JSON.stringify(picked)};
    const W = ${THUMB_WIDTH}, Q = ${THUMB_QUALITY};
    const load = (src) => new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      const done = (v) => resolve(v);
      im.onload = () => done(im);
      im.onerror = () => done(null);
      im.src = src;
      setTimeout(() => done(null), 12000);
    });
    const out = [];
    for (const it of items) {
      const im = await load(it.src);
      if (!im || !im.naturalWidth) continue;
      const w = Math.min(W, im.naturalWidth);
      const h = Math.round(im.naturalHeight * w / im.naturalWidth);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(im, 0, 0, w, h);
      let data;
      try { data = c.toDataURL('image/jpeg', Q); } catch (e) { continue; }
      out.push({ floor: it.floor, index: it.index, src: it.src, w: w, h: h, dataUrl: data });
    }
    return JSON.stringify(out);
  })()`

  const result = await bskPage(session, ['evaluate', '--json', expr], 120000)
  if (result.code !== 0) return []

  let list = []
  try {
    const parsed = JSON.parse(result.stdout)
    // evaluate --json 把返回值放在 value 里，而且 value 本身是字符串
    const raw = parsed && parsed.value !== undefined ? parsed.value : parsed
    list = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
}

/** 把 base64 缩略图落到 Temp，返回带本地路径的列表。 */
async function saveThumbnails(list) {
  if (!list || !list.length) return []
  const dir = await ensureTempDir()
  const saved = []
  for (const item of list) {
    const m = /^data:image\/([a-z]+);base64,(.*)$/i.exec(item.dataUrl || '')
    if (!m) continue
    const name = `f${item.floor}-${item.index}.jpg`
    const file = path.join(dir, name)
    try {
      await writeFile(file, Buffer.from(m[2], 'base64'))
      saved.push({ floor: item.floor, index: item.index, src: item.src, path: file, w: item.w, h: item.h })
    } catch {
      /* 单张写盘失败就跳过 */
    }
  }
  return saved
}

function formatFloorsBudget(floors, budgetChars = 9000) {
  const list = floors || []
  if (!list.length) return ''

  // 长度的口径必须和**最终输出**一致。
  //
  // 踩过的坑：以前按 f.text（纯文字）算预算，可实际截断作用在 renderFlow 之后
  // 的字符串上——flow 里每张图会变成 `![](http://…!large)` 约 95 字符。
  // #193 有 2 张图 = 190 字符，正文预算只按文字长度给了 632，
  // 于是裁掉 192 字 —— 正好是那两张图的语法长度。用户看到的就是「正文莫名被截」。
  //
  // 现在按「文字 + 图片语法估算」统一口径。
  const imgSyntaxLen = (imgs) =>
    (Array.isArray(imgs) ? imgs : []).reduce(
      (sum, im) => sum + `![](${String((im && im.src) || '')})`.length + 1,
      0,
    )
  const hasFlow = (f) => typeof f.flow === 'string' && !!f.flow

  // 「正文」长度：flow 路径下 flow 本身就是最终正文（图占位符折算成 Markdown）。
  // 只用来判断「总量够不够」，不直接当额度。
  const bodyLen = (f) => {
    if (hasFlow(f)) {
      const n = Array.isArray(f.images) ? f.images.length : 0
      return String(f.text || '').length + n * 100
    }
    return String(f.text || '').length + imgSyntaxLen(f.images)
  }

  // 「固定开销」：头部、尾注、链接行、删除线行、回复行、图注——
  // 这些**都会真实占用输出**，但以前完全没算进预算，于是正文被挤爆。
  // 精确估算见下方 FIXED_OVERHEAD 常量与说明。
  const FIXED_OVERHEAD = (f) => {
    let n = 0
    // 头部：'#楼层 作者（显示名）：' —— 普通约 24，超长用户名按 40 兜。
    n += 40
    // 截断尾注 '…（后文还有 N 字未显示）' 最长约 24
    n += 24
    if (!hasFlow(f) && Array.isArray(f.images) && f.images.length) {
      n += Math.min(f.images.length, 6) * 100
      if (f.images.length > 6) n += 20
    }
    if (Array.isArray(f.links) && f.links.length) {
      // 每行 '   [锚文本](url)'：锚文本通常短，URL 常 40~80
      n += Math.min(f.links.length, 5) * 90
      if (f.links.length > 5) n += 20
    }
    if (!hasFlow(f) && Array.isArray(f.deleted) && f.deleted.length) {
      n += Math.min(f.deleted.length, 3) * 40
      if (f.deleted.length > 3) n += 20
    }
    if (f.replyTo && (f.replyTo.author || f.replyTo.quoted)) {
      // '   ↳ 回复 某某 #123：'引文''——引文额度 later 会在渲染时再 cut
      n += 30 + 200
    }
    return n
  }

  const lens = list.map(bodyLen)
  const overheads = list.map(FIXED_OVERHEAD)
  const totalLen = lens.reduce((sum, n) => sum + n, 0)
  const totalOverhead = overheads.reduce((sum, n) => sum + n, 0)

  // **留余量**：估算难免漂移（超长用户名、意外换行、未预见的分支），
  // 按 95% 用预算，留 5% 兜底，宁可不把预算吃满，也不要超出后被截。
  // 正文额度 = 预算 × 95% − 固定开销（头部/尾注/链接/删除线/回复引文）。
  //
  // 但要防一个极端：楼层特别多时，光固定开销就可能吃掉大半甚至全部预算
  // （200 层 × (40 头部 + 24 尾注) ≈ 12800 > 12000）。这时若直接给 0，
  // 每层都会变成空壳——比截断更糟，等于什么都没看到。
  // 所以正文额度设一条最低线：至少给每层留一点正文，
  // 宁可总输出略微超出预算，也不能让任何一层变成「：…（后文还有」的空壳。
  const reserve = Math.floor(budgetChars * 0.95)
  const roomForBody = reserve - totalOverhead
  // 每层最少 40 字正文（够看清「这层在说什么」）；总量不足时按此保底。
  const usable = Math.max(roomForBody, list.length * 40)
  // 总量（正文 + 固定开销）没超预算 → 正文全额，一个字都不截。
  // 判断用「含开销的真实总量」，而不是只看正文。
  const generous = totalLen <= Math.max(0, roomForBody)

  // 每层各给多少字 —— 不能用一个统一的 perFloor 平均切。
  //
  // 反例（真实踩过）：整栋楼 200 层、预算 12000，平均下来每层 60 → 保底 120。
  // 可实际上 199 层都只有十几个字，它们白白占着「120 的配额」却用不完，
  // 结果那唯一一条 3000 字的长帖也只拿到 120 字，被从中间砍断。
  //
  // 正确做法是 **water-filling（注水）**：按长度从短到长逐层分配，
  // 每层最多拿「剩余预算 / 剩余层数」；短层拿满就退场，把剩下的预算
  // 留给后面的长层。这样短层全额、长层吃掉全部剩余额度，预算正好用尽。
  //
  // 下限 120 是硬保底：宁可总长度略微超出预算，也不能让某层缩成看不见。
  const MIN_PER_FLOOR = 120
  const MAX_PER_FLOOR = 2000
  const limits = new Array(list.length).fill(MIN_PER_FLOOR)
  if (!generous) {
    const order = lens.map((n, i) => ({ n, i })).sort((a, b) => a.n - b.n)
    // 保底不能「无条件 120」：200 层 × 120 = 24000，直接是预算的两倍，
    // 越保越超。保底值必须随层数自适应——层数少才用 120，层数多就降。
    const minEach = Math.min(MIN_PER_FLOOR, Math.floor(usable / Math.max(order.length, 1)))
    let remain = usable
    let left = order.length
    for (const { n, i } of order) {
      const share = Math.floor(remain / Math.max(left, 1))
      const give = Math.max(minEach, Math.min(MAX_PER_FLOOR, n, Math.max(share, minEach)))
      limits[i] = give
      remain -= give
      left -= 1
    }
  } else {
    // 总量没超预算：每层原样全额给，不做任何截断。
    // 注意这里**不能**套 MAX_PER_FLOOR：总量既然没超，再套单层上限
    // 就是凭空制造截断（实测 200 层总长 5985 远小于预算 12000，
    // 唯一那条 3000 字的长帖却因为 2000 上限被砍掉尾巴）。
    // MAX_PER_FLOOR 只在「总量超预算、必须取舍」时才用于分配。
    for (let i = 0; i < list.length; i += 1) limits[i] = lens[i]
  }
  const perFloor = Math.max(...limits)

  const cut = (s, n) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim()
    if (v.length <= n) return { text: v, truncated: 0 }
    return { text: v.slice(0, n), truncated: v.length - n }
  }

  // 占位符与控制字符：必须和浏览器侧 walkFlow 里用的完全一致。
  const IMG_OPEN = '<<<SPIXII_IMG_START>>>'
  const IMG_CLOSE = '<<<SPIXII_IMG_END>>>'
  const DEL_OPEN = '<<<SPIXII_DEL_START>>>'
  const DEL_CLOSE = '<<<SPIXII_DEL_END>>>'

  /** 把 flow 字符串里的图片占位符换成 Markdown 图片；文字原样保留。 */
  const renderFlow = (flowStr) => {
    if (!flowStr) return null
    // 删除线：先把成对的 DEL 占位标记换成 ~~…~~，再走图片替换。
    // 这一步必须在图片之前做，否则标记会拦腰切断 img 占位符的解析。
    let work = flowStr
    let guard = 0
    while (guard++ < 500) {
      const s = work.indexOf(DEL_OPEN)
      if (s === -1) break
      const e = work.indexOf(DEL_CLOSE, s)
      if (e === -1) {
        // 没闭合：把标记头去掉，剩下的当普通文本
        work = work.slice(0, s) + work.slice(s + DEL_OPEN.length)
        break
      }
      const inner = work.slice(s + DEL_OPEN.length, e)
      work = work.slice(0, s) + '~~' + inner.trim() + '~~' + work.slice(e + DEL_CLOSE.length)
    }
    flowStr = work

    const out = []
    let i = 0
    while (i < flowStr.length) {
      const start = flowStr.indexOf(IMG_OPEN, i)
      if (start === -1) {
        out.push(flowStr.slice(i))
        break
      }
      out.push(flowStr.slice(i, start))
      const end = flowStr.indexOf(IMG_CLOSE, start)
      if (end === -1) {
        // 标记没闭合，剩下的当普通文本丢掉标记头
        out.push(flowStr.slice(start + IMG_OPEN.length))
        break
      }
      const payload = flowStr.slice(start + IMG_OPEN.length, end)
      try {
        const im = JSON.parse(payload)
        const alt = String(im.alt || '').replace(/[[\]()]/g, '').trim()
        out.push(`![${alt}](${im.src})`)
      } catch {
        /* 解析失败就跳过这张图，不影响正文 */
      }
      i = end + IMG_CLOSE.length
    }
    return out.join('')
  }

  return list
    .map((f, idx) => {
      const limit = limits[idx] ?? perFloor

      // 优先用 flow（文字与图片按原始顺序交错）。
      // 没有 flow 时退回老做法：正文 + 末尾追加图片。
      const flowRaw = typeof f.flow === 'string' && f.flow ? f.flow : ''
      const renderedFlow = flowRaw ? renderFlow(flowRaw) : null

      let lines
      let imagesAlreadyInlined = false
      if (renderedFlow !== null) {
        const body = cut(renderedFlow, limit)
        const head = `#${f.floor} ${f.author || '?'}：${body.text}`
        const tailNote = body.truncated > 0 ? `（后文还有 ${body.truncated} 字未显示）` : ''
        lines = [tailNote ? `${head}…${tailNote}` : head]
        // 图已经在 flow 里按原位置放好了，别再额外追加一遍。
        imagesAlreadyInlined = true
      } else {
        const body = cut(f.text, limit)
        const head = `#${f.floor} ${f.author || '?'}：${body.text}`
        // 截断时把「还剩多少字」写出来，别让人以为话说完了。
        const tailNote = body.truncated > 0 ? `（后文还有 ${body.truncated} 字未显示）` : ''
        lines = [tailNote ? `${head}…${tailNote}` : head]
      }

      // 图片：用标准 Markdown 图片语法 ![alt](url)。
      // 不用「[图N: url]」那种自造格式——Markdown 本身就没有歧义，
      // 再叠一层前缀等于凭空往内容里塞了不存在的字。
      // 走 flow 时图片已就位，这里跳过，避免重复。
      // 单独成行，避免和正文糊在一起；超过 6 张就省略，防止一层刷屏。
      const imgs = imagesAlreadyInlined ? [] : (Array.isArray(f.images) ? f.images : [])
      if (imgs.length) {
        const shownImgs = imgs.slice(0, 6)
        shownImgs.forEach((im) => {
          const alt = String(im.alt || '').replace(/[[\]()]/g, '').trim()
          lines.push(`   ![${alt}](${im.src})`)
        })
        if (imgs.length > shownImgs.length) {
          // 故意用圆括号而不是方括号：方括号在 Markdown 里会被当成未定义的链接引用。
          // 这句是给人/模型看的说明，不是内容，所以不加任何 Markdown 包裹。
          lines.push(`   （另有 ${imgs.length - shownImgs.length} 张图未列出）`)
        }
      }

      // 链接：标准 Markdown `[锚文本](url)`。
      // 不加「[链接]」之类前缀——那会凭空多出内容里根本没有的字。
      // 没锚文本的（纯图标链接）退化成裸地址，避免出现 `[](url)` 这种空标签。
      const fLinks = Array.isArray(f.links) ? f.links : []
      if (fLinks.length) {
        const shownLinks = fLinks.slice(0, 5)
        shownLinks.forEach((l) => {
          const label = String(l && l.text ? l.text : '').trim()
          const href = String(l && l.href ? l.href : '').trim()
          if (!href) return
          // 锚文本里如果有方括号会破坏 Markdown 结构，替换成全角括号
          const safe = label.replace(/[[\]]/g, (ch) => (ch === '[' ? '［' : '］'))
          lines.push(`   ${safe ? `[${safe}](${href})` : href}`)
        })
        if (fLinks.length > shownLinks.length) lines.push(`   （另有 ${fLinks.length - shownLinks.length} 个链接未列出）`)
      }

      // 删除线：`~~原文~~`。
      // innerText 会把它当普通文字，光贴文字会让人以为作者在陈述这句话，
      // 实际上作者是把它划掉了——语义完全相反，所以必须有 ~~ 标记。
      //
      // 注意：走 flow 路径时，~~…~~ 已经**原位**嵌在正文里了（walkFlow 对
      // del/s 打了 DEL 占位标记，renderFlow 换成 ~~）。这里要是再追加一遍，
      // 同一句就会出现两次：正文里一次没划的、末尾一次划的，语义直接打架。
      // 所以只有没有 flow（老路径 / DOM 兜底）时才在这里补。
      const fDel = imagesAlreadyInlined ? [] : (Array.isArray(f.deleted) ? f.deleted : [])
      if (fDel.length) {
        fDel.slice(0, 3).forEach((t) => {
          const one = String(t || '').replace(/\s+/g, ' ').trim()
          if (one) lines.push(`   ~~${one}~~`)
        })
        if (fDel.length > 3) lines.push(`   （另有 ${fDel.length - 3} 处划掉的文字未列出）`)
      }
      if (f.replyTo && (f.replyTo.author || f.replyTo.quoted)) {
        const who = f.replyTo.author || '某人'
        const q = cut(f.replyTo.quoted, generous ? 600 : 200)
        lines.push(
          q.text ? `   ↳ 回复 ${who}${f.replyTo.quotedFloor ? ` #${f.replyTo.quotedFloor}` : ''}：「${q.text}${q.truncated > 0 ? `…（后文还有 ${q.truncated} 字）` : ''}」` : `   ↳ 回复 ${who}`,
        )
      }
      return lines.join('\n')
    })
    .join('\n')
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

const loggedIn = (vom) =>
  Boolean(vom) && !/link\s+"登录"/.test(vom) && Boolean(REF.userMenu(vom))

/* ------------------------------------------------------- 身份：核对与切换 */

// 论坛在 <head> 里放了当前登录者：<meta name="current-user" data-user-login="...">
// 这是唯一可信的身份来源，比看导航栏文字准。读不到就当作未知，绝不猜。
async function readIdentity(session) {
  const result = await bskPage(session, ['get-html', '--max-bytes', '200000'], 45000)
  if (result.code !== 0) return { ok: false, detail: (result.stderr || '').slice(0, 300) }
  const html = result.stdout || ''
  const meta = html.match(
    /<meta\s+name="current-user"[^>]*?data-user-login="([^"]*)"[^>]*?data-user-name="([^"]*)"/i,
  )
  if (meta) return { ok: true, login: meta[1], name: meta[2] }
  // 没有 current-user 说明是游客。
  if (/\/account\/sign_in/.test(html) || />\s*登录\s*</.test(html)) {
    return { ok: true, login: null, name: null }
  }
  return { ok: true, login: null, name: null }
}

/** 是本人账号？大小写不敏感比较。 */
const isMe = (identity, account) =>
  Boolean(identity?.login) &&
  String(identity.login).toLowerCase() === String(account || '').toLowerCase()

/** 退出登录。论坛用 DELETE 语义，但点击链接时 Rails 的 rails-ujs 会处理，直接点就行。 */
async function logout(session) {
  let seen = await observe(session, 1500)
  if (!seen.ok) return { ok: false, detail: seen.detail }

  let link = REF.logoutLink(seen.vom)
  if (!link) {
    // 退出链接在下拉菜单里，得先点开用户菜单。
    const menu = REF.userMenu(seen.vom)
    if (!menu) return { ok: false, detail: '找不到用户菜单，也没看到「退出」链接。' }
    await clickRef(session, menu)
    await sleep(600)
    seen = await observe(session, 1500)
    if (!seen.ok) return { ok: false, detail: seen.detail }
    link = REF.logoutLink(seen.vom)
  }
  if (!link) return { ok: false, detail: '展开用户菜单后仍找不到「退出」。' }

  const clicked = await clickRef(session, link)
  if (!clicked.ok) return { ok: false, detail: clicked.detail }

  await sleep(1500)
  const after = await readIdentity(session)
  if (!after.ok) return { ok: false, detail: after.detail }
  if (after.login) return { ok: false, detail: `点了退出，但仍然是「${after.login}」登录着。` }
  return { ok: true }
}

/** 用配置里的账号密码登录一次。只在确认处于游客状态时调用。 */
async function login(session, config) {
  if (!config.password) {
    return { ok: false, detail: '设置里没有存密码，无法自动登录。' }
  }
  const signIn = new URL('/account/sign_in', config.forumHome).href
  const went = await navigateWithRecovery(session, signIn)
  if (!went.ok) return { ok: false, session: went.session, detail: `打不开登录页：${went.detail}` }
  const active = went.session

  const seen = await observe(active, 2500)
  if (!seen.ok) return { ok: false, session: active, detail: seen.detail }

  const userRef = REF.loginUser(seen.vom)
  const passRef = REF.loginPass(seen.vom)
  const submitRef = REF.loginSubmit(seen.vom)
  if (!userRef || !passRef || !submitRef) {
    return { ok: false, session: active, detail: '登录表单结构变了，找不到用户名/密码/登录按钮。' }
  }

  const filledUser = await fillRef(active, userRef, config.account)
  if (!filledUser.ok) return { ok: false, session: active, detail: `填用户名失败：${filledUser.detail}` }
  const filledPass = await fillRef(active, passRef, config.password)
  if (!filledPass.ok) return { ok: false, session: active, detail: `填密码失败：${filledPass.detail}` }

  // 勾上「记住登录状态（60 天）」，省得天天重登。
  const rememberRef = findRef(seen.vom, 'checkbox', '记住登录状态（60 天）')
  if (rememberRef) await clickRef(active, rememberRef)

  const submitted = await clickRef(active, submitRef)
  if (!submitted.ok) return { ok: false, session: active, detail: `点登录失败：${submitted.detail}` }

  await sleep(1800)
  return { ok: true, session: active }
}

/**
 * 保证「以本人的身份」停在论坛上。
 * 三种情况：本来就是我 → 直接用；是别人 → 退掉再登；没登录 → 直接登。
 * 登录失败就停，不重试。
 */
async function ensureIdentity(session, config) {
  const first = await readIdentity(session)
  if (!first.ok) return { ok: false, stage: 'identity', detail: first.detail }
  if (isMe(first, config.account)) return { ok: true, session, acted: 'none', identity: first }

  const wasSomeoneElse = Boolean(first.login)
  if (wasSomeoneElse) {
    const out = await logout(session)
    if (!out.ok) {
      return {
        ok: false,
        stage: 'logout',
        session,
        error: `现在登录的是「${first.login}」，我想退掉换成自己，但退出失败了。`,
        detail: out.detail,
      }
    }
  }

  const log = await login(session, config)
  if (!log.ok) {
    return {
      ok: false,
      stage: 'login',
      session: log.session || session,
      error: wasSomeoneElse
        ? `已退出「${first.login}」，但登录本人账号失败——没有乱猜，就此停下。`
        : '需要登录本人账号，但登录没成功——就此停下，不重试。',
      detail: log.detail,
    }
  }

  const after = await readIdentity(log.session)
  if (!after.ok) return { ok: false, stage: 'identity', session: log.session, detail: after.detail }
  if (!isMe(after, config.account)) {
    return {
      ok: false,
      stage: 'identity',
      session: log.session,
      error: `登录后核对身份不对：现在是「${after.login || '游客'}」，不是「${config.account}」。已停下。`,
    }
  }

  return {
    ok: true,
    session: log.session,
    acted: wasSomeoneElse ? 'switched' : 'logged-in',
    identity: after,
    previous: wasSomeoneElse ? first.login : null,
  }
}

/** 把「这次是怎么进场的」说成人话。 */
function describeActed(forum) {
  if (forum.acted === 'switched') return `（先把「${forum.previous}」退掉了）`
  if (forum.acted === 'logged-in') return '（现场登录）'
  return ''
}

/** 打开论坛，并保证是以本人身份停在那儿。 */
async function openForum(config) {
  const daemon = await ensureDaemon(config)
  if (!daemon.ok) return { ok: false, stage: daemon.stage || 'daemon', ...daemon }

  const bin = daemon.bin || 'bsk'

  // 守护进程有了，还得真有浏览器连着。Edge 没开就先把它拉起来
  // （单实例机制保证「已开就复用」，我们自己不用判断窗口）。
  const browser = await ensureBrowser(config, bin)
  if (!browser.ok) return { ok: false, stage: browser.stage || 'browser', ...browser }

  const opened = await ensureSession(false, bin)
  if (!opened.ok) return { ok: false, stage: 'session', ...opened }

  let session = opened.session
  const went = await navigateWithRecovery(session, config.forumHome)
  session = went.session
  if (!went.ok) {
    return {
      ok: false,
      stage: 'navigate',
      session,
      error: `论坛打不开（${config.forumHome}）——按约定，打不开就放弃。`,
      detail: went.detail,
    }
  }

  const who = await ensureIdentity(session, config)
  if (!who.ok) return { ok: false, session: who.session || session, ...who }

  return {
    ok: true,
    session: who.session,
    daemon,
    identity: who.identity,
    acted: who.acted,
    previous: who.previous,
  }
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

/**
 * 去论坛看一眼。工具和 /Homeland 命令都走这里，避免两套逻辑各写一遍。
 * 不传 force 时受频率限制。
 *
 * 楼层用 readFloors 取全量（这个论坛把 164 楼全塞在页面变量里，只显示 20 楼）。
 * 想只看最近几条，传 sinceFloor；想从后往前看，用 tail。
 */
async function runVisit({ force = false, sinceFloor = 0, tail = 0 } = {}) {
  const cfg = await readSettings()
  const state = await readJson(STATE_PATH, DEFAULT_STATE)

  const g = gate(cfg, state, force)
  if (!g.ok) return { ok: false, stage: 'gate', error: g.reason }

  const forum = await openForum(cfg)
  if (!forum.ok) return forum

  let session = forum.session
  const went = await navigateWithRecovery(session, cfg.topicUrl)
  session = went.session
  if (!went.ok) return { ok: false, stage: 'navigate', session, error: `打不开主题页 ${cfg.topicUrl}`, detail: went.detail }

  // 等页面把楼层变量准备好（它是异步填的）。
  // 软超时后页面可能还在渲染，所以给足时间：12 次 × 1.2 秒 ≈ 14 秒。
  let floors = { ok: false }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    floors = await readFloors(session)
    if (floors.ok && floors.total > 0) break
    await sleep(1200)
  }
  if (!floors.ok) {
    // 完整版挂了就退到简化版：能正常看帖比"图片位置好看"重要得多。
    await noteDiag('floors', `完整版读楼层失败，改用简化版。原因：${String(floors.detail || '').slice(0, 300)}`)
    const simple = await readFloorsSimple(session)
    if (simple.ok && simple.total > 0) {
      floors = simple
      await noteDiag('floors', `简化版成功，读到 ${simple.total} 层`)
    } else {
      await noteDiag('floors', `简化版也失败：${String(simple.detail || '').slice(0, 300)}`)
      return {
        ok: false,
        stage: 'floors',
        session,
        error: '读不到楼层内容。',
        detail: `完整版：${floors.detail || ''}｜简化版：${simple.detail || '无输出'}`,
      }
    }
  }

  let picked = floors.floors
  const maxFloor = picked.length ? picked[picked.length - 1].floor : 0
  if (sinceFloor > 0) picked = picked.filter((f) => f.floor > sinceFloor)
  if (tail > 0) picked = picked.slice(-tail)

  // 补全「被回复的原文」：论坛要点开那段「对某人回复」才会加载原话。
  // 只补要展示的这几层，避免为了看 5 条去点 100 次。
  // 补不上不影响浏览，只是少一段上下文。
  let quoteStats = { filled: 0, attempted: 0 }
  try {
    quoteStats = await hydrateReplyQuotes(session, picked)
  } catch (error) {
    await noteDiag('hydrate', `补全回复原文失败：${errText(error)}`)
  }

  // 镇楼更新检测。
  //
  // 镇楼 = 帖子标题 + 主楼正文（.topic-detail 里那套），**不是** [data-floor="1"]。
  // anchor 只在真的提示过之后才推进——小改不提示就留着旧锚点，
  // 这样连续小改累积出来的变化最终会被抓到（见 judgePinnedPost 上方注释）。
  let pinnedPost = null
  try {
    const z = await readPinnedPost(session)
    if (z && z.ok) {
      const current = snapshotPinnedPost(z)
      const anchor = await loadAnchor(cfg.topicUrl)
      const verdict = judgePinnedPost(anchor, current)
      pinnedPost = {
        level: verdict.level,
        summary: verdict.summary,
        changes: verdict.changes,
        title: current.title,
        imageCount: current.images.length,
        textPreview: current.text.slice(0, 600),
      }
      // 只有"首次建档"和"真的提示了"才推进锚点；静默不推进。
      if (verdict.level === 'first' || verdict.level === 'minor' || verdict.level === 'major') {
        await saveAnchor(cfg.topicUrl, current)
        pinnedPost.anchorUpdated = true
      }
    } else {
      await noteDiag('pinned-post', `读镇楼失败：${z && z.reason ? z.reason : '未知原因'}`)
    }
  } catch (error) {
    await noteDiag('pinned-post', `镇楼比对失败：${errText(error)}`)
  }

  const next = await bump()
  return {
    ok: true,
    session,
    identity: forum.identity,
    acted: forum.acted,
    previous: forum.previous,
    visitsToday: next.visits?.[todayKey()] ?? 1,
    source: floors.source,
    totalFloors: floors.total,
    maxFloor,
    floors: picked,
    quotes: quoteStats,
    pinnedPost,
    prompt: cfg.visitPrompt,
    topicUrl: cfg.topicUrl,
  }
}

/**
 * 楼层号 → 页码 的定位器（浏览器内执行）。
 *
 * 楼层号 → 页码，只按**存活序号**算：页码 = ceil(存活序号 / 20)。
 *
 * 不能用 Math.ceil(楼层号 / 20)。论坛每页 20 层，但整栋楼允许**人为删层**：
 * 容量按**存活楼层数**算（244 存活层 → 13 页），楼层号却是原始编号（最高 #246），
 * 两边一旦对不上，按楼层号除出来的页码就是错的（实测回复 #243 时按 #243/20 翻到
 * 第 13 页，那页装的是 #244–246，扑空）。
 *
 * 存活序号从 REPLY_DOM_ARR 里数出来（见 _list）：它就是站点自己的分页依据，
 * 所以页码是**算出来的，不是试出来的**——不二分、不翻页试探、不猜。
 *
 * `REPLY_DOM_ARR` 是站点一次性注入的全楼名单（和分页控件同一次页面加载产生）：
 * 谁还在楼里、排第几个，名单说了算。所以页码是 `ceil(存活序号 / 20)`——算的，不是猜的。
 * 名单缺席只有两种可能：页面没加载好，或站点结构变了。这两种都不该靠翻页去试，
 * 一律报错交回上层重试，翻页循环、unsure、空转判定全部不需要。
 */
const FLOOR_LOCATOR_SRC = `
  const _goPage = async (p) => {
    const skipInput = document.querySelector('#layuiPagination .layui-laypage-skip input');
    const skipBtn = document.querySelector('#layuiPagination .layui-laypage-skip button');
    if (skipInput && skipBtn) {
      skipInput.value = String(p);
      skipBtn.click();
    } else {
      const link = document.querySelector('#layuiPagination a[data-page="' + p + '"]');
      if (!link) return false;
      link.click();
    }
    await new Promise((r) => setTimeout(r, 2000));
    return true;
  };
  // 页面变量 REPLY_DOM_ARR 是服务端一次性注入的「全楼名单」：谁还在楼里、排第几个，它说了算。
  // 楼层号会因删楼而与页序脱节（244 存活层、最高却是 #246），所以只按存活序号算页码。
  const _floorOf = (raw) => {
    // 每一项是这一层的 HTML 片段，楼层号挂在它自己的 [data-floor] 上——和站点分页用的是同一个字段。
    if (!raw) return null;
    if (typeof raw === 'object') {
      const v = raw.floor || raw.display_floor;
      return v ? Number(v) : null;
    }
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    if (s.charAt(0) === '{') {
      try {
        const o = JSON.parse(s);
        const v = o && (o.floor || o.display_floor);
        return v ? Number(v) : null;
      } catch (e) {
        return null;
      }
    }
    const box = document.createElement('div');
    box.innerHTML = s;
    const n = box.querySelector('[data-floor]');
    if (!n) return null;
    const v = Number(n.getAttribute('data-floor'));
    return Number.isNaN(v) ? null : v;
  };
  // ord = 目标在名单里的位置（1 起，即存活序号），0 = 名单里没有它。
  // misses = 解析不出楼层号的条目数：有解析不出来的，就不敢断言「名单里没有」。
  const _list = () => {
    const arr = (typeof REPLY_DOM_ARR !== 'undefined' && Array.isArray(REPLY_DOM_ARR)) ? REPLY_DOM_ARR : null;
    if (!arr || arr.length < 2) return null;
    let ord = 0;
    let misses = 0;
    for (let i = 1; i < arr.length; i += 1) {
      const v = _floorOf(arr[i]);
      if (v === null) { misses += 1; continue; }
      if (v === target) ord = i;
    }
    return { ord, misses, total: arr.length - 1 };
  };
  // 名单在手，目标在第几页就是算出来的：ceil(存活序号 / 20)。
  // 名单不在手 = 页面没加载好，此时连分页控件都没有，翻页没有意义——报上去让上层等/重试。
  const _locate = async (target) => {
    const list = _list();
    const onPage = () => !!document.querySelector('[data-floor="' + target + '"]');
    if (!list || list.misses > 0) return { ok: false, page: null, total: list ? list.total : 0, how: 'nolist' };
    if (onPage()) return { ok: true, page: null, total: list.total, how: 'current' };
    if (list.ord === 0) return { ok: false, page: null, total: list.total, how: 'nofind' };
    const p = Math.ceil(list.ord / 20);
    if (!(await _goPage(p))) return { ok: false, page: p, total: list.total, how: 'navfail' };
    if (onPage()) return { ok: true, page: p, total: list.total, how: 'jump' };
    return { ok: false, page: p, total: list.total, how: 'miss' };
  };
`

/**
 * 发一条回复。
 * 传了 replyTo（楼层号）就是「回复某个人」，否则是普通发言。
 * 提交前会再核对一次身份。
 */
async function runReply(text, { force = false, replyTo = null } = {}) {
  const cfg = await readSettings()
  const state = await readJson(STATE_PATH, DEFAULT_STATE)
  const body = String(text || '').trim()
  if (!body) return { ok: false, stage: 'input', error: '没给要发的内容。' }

  const g = gate(cfg, state, force)
  if (!g.ok) return { ok: false, stage: 'gate', error: g.reason }
  if (!cfg.autoPost && !force) {
    return { ok: false, stage: 'gate', error: '设置里关掉了自动发帖（autoPost=false）。' }
  }

  const forum = await openForum(cfg)
  if (!forum.ok) return forum

  let session = forum.session
  const went = await navigateWithRecovery(session, cfg.topicUrl)
  session = went.session
  if (!went.ok) return { ok: false, stage: 'navigate', session, error: `打不开主题页 ${cfg.topicUrl}`, detail: went.detail }

  // 回复某人：翻到那一楼 → 点「回复此楼」。
  // 用户确认过：点完就生效，回复框右上角会显示「对 XX 回复」，不必去读 reply_to_id 的值。
  let repliedTo = null
  if (replyTo) {
    const target = Number(replyTo)

    // 名单和分页控件是同一次页面加载产生的（站点把整栋楼一次性塞进 REPLY_DOM_ARR）。
    // 所以「等不到名单」等于「这一页根本没加载好」，此时翻页控件也不存在，
    // 翻页、猜页码都没有意义——等够 60 秒就报错，让上层重试。
    // 60 秒而不是十几次：ID 家的网络时快时慢，慢的时候主题页要等很久。
    let listReady = false
    const listDeadline = Date.now() + 60000
    while (Date.now() < listDeadline) {
      const probe = await bskPage(
        session,
        [
          'evaluate',
          '--json',
          `(function () {
            var ok = (typeof REPLY_DOM_ARR !== 'undefined' && Array.isArray(REPLY_DOM_ARR) && REPLY_DOM_ARR.length > 1);
            return JSON.stringify({ ready: ok, floors: ok ? REPLY_DOM_ARR.length - 1 : 0 });
          })()`,
        ],
        30000,
      )
      if (probe.code === 0) {
        try {
          listReady = JSON.parse(JSON.parse(probe.stdout).value).ready === true
        } catch (e) {
          // 解析不了就当没就绪，继续等
        }
      }
      if (listReady) break
      await sleep(1200)
    }    if (!listReady) {
      return {
        ok: false,
        stage: 'reply-to',
        session,
        error: `没法回复 #${target}：主题页没加载出来（等不到全楼名单），论坛可能卡了，稍后重试。`,
      }
    }
    const jump = await bskPage(
      session,
      [
        'evaluate',
        '--json',
        `(async () => {
          const target = ${target};
          ${FLOOR_LOCATOR_SRC}
          const loc = await _locate(target);
          if (!loc.ok) {
            // 三种失败：名单没读到（页面没加载好）、名单里没有这一楼、翻页/跳页没落到。
            const reason = loc.how === 'nolist'
              ? '拿不到全楼名单——主题页没加载好（论坛可能卡了），稍后重试'
              : loc.how === 'nofind'
                ? '全楼名单（共 ' + loc.total + ' 楼）里没有 #' + target + ' 这一楼——可能被删了，也可能楼层号不对'
                : loc.how === 'navfail'
                  ? '翻页没生效（点了第 ' + loc.page + ' 页但页面内容没变），稍后重试'
                  : '名单说这一楼在第 ' + loc.page + ' 页，跳过去却没找到——页面状态和名单对不上，稍后重试';
            return JSON.stringify({ ok: false, total: loc.total, reason });
          }
                    const page = loc.page;

          const node = document.querySelector('[data-floor="' + target + '"]');
          if (!node) {
            return JSON.stringify({
              ok: false,
              total: loc.total,
              reason: '定位到了第 ' + page + ' 页，但那一楼不在页面上（可能刚好被删）',
            });
          }

          // 「回复此楼」是 a.btn-reply（带 data-id / data-login），不是 href 里带 /reply_to 的链接。
          // 之前找错了选择器，所以永远找不到按钮。
          const a = node.querySelector('a.btn-reply, .opts a[title="回复此楼"]');
          if (!a) {
            const authorEl = node.querySelector('.avatar a[title]')
            return JSON.stringify({
              ok: false,
              reason: '这一楼没有「回复此楼」按钮（' + ((authorEl && authorEl.getAttribute('title')) || '未知作者') + '）',
            })
          }

          const replyId = a.getAttribute('data-id')
          const replyLogin = a.getAttribute('data-login')
          const authorName = (node.querySelector('.avatar a[title]') || {}).getAttribute
            ? node.querySelector('.avatar a[title]').getAttribute('title')
            : ''
          a.click()
          await new Promise((r) => setTimeout(r, 900))

          // 回复目标怎么确认：以隐藏字段 reply_reply_to_id 为准。
          //
          // 以前是去回复框附近找「对 XX 回复」那句话，实测这条路不可靠：
          // 该论坛点完「回复此楼」后界面上并不显示这句话（整页 search 只命中
          // 楼层里既有的“对某人回复”引用块），form 内只有「提交回复 / Command + Enter」。
          // 而隐藏字段是真实的提交参数——点第 15 层按钮后它变成 3826，
          // 正是该层 a.btn-reply 的 data-id，可据此校验目标是否挂对。
          const box = document.querySelector('#reply_body');
          if (box && box.scrollIntoView) box.scrollIntoView({ block: 'center' });
          const hidden = document.querySelector('#reply_reply_to_id');
          const hookedId = hidden ? hidden.value : null;
          // 用「隐藏字段 + 本层作者」拼一句可读的说明，替代抓不到的界面文字。
          const prompt = hookedId
            ? ('对 #' + target + ' ' + (authorName || '某人') + ' 回复（reply_to_id=' + hookedId + '）')
            : null;

          const authorEl = node.querySelector('.avatar a[title]')
          // 顺带确认回复框在场：它不在时后面 fill 只会报一句含糊的
          // "target element is not fillable"，不如在这里就把话说清楚。
          const boxReady = Boolean(document.querySelector('#reply_body'))
          return JSON.stringify({
            ok: true,
            page,
            replyId,
            replyLogin,
            hookedId,
            // 硬校验：隐藏字段必须正好等于这一层按钮的 data-id，否则说明挂错了楼。
            hooked: Boolean(hookedId && replyId && hookedId === replyId),
            boxReady,
            author: authorEl ? authorEl.getAttribute('title') : '',
            prompt,
          })
        })()`,
      ],
      60000,
    )
    if (jump.code !== 0) {
      return { ok: false, stage: 'reply-to', session, error: '点「回复」没成功。', detail: (jump.stderr || '').slice(0, 300) }
    }
    try {
      const parsed = JSON.parse(JSON.parse(jump.stdout).value)
      if (!parsed.ok) {
        return { ok: false, stage: 'reply-to', session, error: `没法回复 #${target}：${parsed.reason}` }
      }
      // 硬校验没过就别继续：宁可停下报错，也别把「回复某人」悄悄降级成普通发言。
      if (!parsed.hooked) {
        return {
          ok: false,
          stage: 'reply-to',
          session,
          error: `回复目标没挂上 #${target}（reply_to_id=${parsed.hookedId || '空'}，期望 ${parsed.replyId || '?'}），已停止。`,
        }
      }
      // 回复框不在场时别硬闯 fill：后面只会得到含糊的 not fillable。
      if (parsed.boxReady === false) {
        return {
          ok: false,
          stage: 'reply-to',
          session,
          error: `翻到${parsed.page == null ? '当前页' : '第 ' + parsed.page + ' 页'}、也挂上了 #${target}，但页面上没有回复框（#reply_body），没敢继续填。`,
        }
      }
      await sleep(600)
      repliedTo = { floor: target, author: parsed.author, page: parsed.page, prompt: parsed.prompt }
      await appendVisitLog({
        at: new Date(),
        ok: true,
        via: 'reply-to',
        target,
        page: parsed.page,
        author: parsed.author,
        prompt: parsed.prompt,
      })
    } catch (error) {
      return { ok: false, stage: 'reply-to', session, error: `解析回复目标失败：${errText(error)}` }
    }
  }

  // 预算必须给够：话题页一页 20 层，VOM 约 346 行；6000 只到 224 行，
  // 回复框（第 313 行）正好被截在预算外，findRef 返回 null 就报 not fillable。
  // 实测阈值：8000 仍不够（307 行），10000 才完整。这里给 12000 留余量。
  let seen = await observe(session, 12000)
  if (!seen.ok) return { ok: false, stage: 'observe', session, error: '页面读不出来。', detail: seen.detail }

  // 保险：上面的读页面如果触发了会话恢复，页面会被重新加载，
  // 之前点好的「回复此楼」就丢了——那样会变成普通发言，而且看起来还“成功”。
  // 这里在填内容之前再确认一次：要回复的目标楼层如果没挂上，就重新点一次。
  if (repliedTo) {
    const armed = await bskPage(
      session,
      [
        'evaluate',
        '--json',
        `(() => {
          const hidden = document.querySelector('#reply_reply_to_id');
          return JSON.stringify({ value: hidden ? hidden.value : null });
        })()`,
      ],
      30000,
    )
    let current = null
    try {
      current = JSON.parse(JSON.parse(armed.stdout).value).value
    } catch {
      current = null
    }
    if (!current) {
      // 重新翻页 + 重新点「回复此楼」
      const rearm = await bskPage(
        session,
        [
          'evaluate',
          '--json',
          `(async () => {
            const target = ${Number(replyTo)};
            ${FLOOR_LOCATOR_SRC}
            // 与主路径同一套定位：直接算页码在删过楼的主题里会扑空。
            const loc = await _locate(target);
            if (!loc.ok) {
              return JSON.stringify({ ok: false, reason: '重新定位失败（这一楼可能已被删除）' });
            }
            const node = document.querySelector('[data-floor="' + target + '"]');
            if (!node) return JSON.stringify({ ok: false, reason: '重新定位失败' });
            const btn = node.querySelector('a.btn-reply');
            if (!btn) return JSON.stringify({ ok: false, reason: '找不到回复此楼' });
            btn.click();
            await new Promise((r) => setTimeout(r, 900));
            const h = document.querySelector('#reply_reply_to_id');
            return JSON.stringify({ ok: true, value: h ? h.value : null });
          })()`,
        ],
        60000,
      )
      let fixed = null
      try {
        const parsed = JSON.parse(JSON.parse(rearm.stdout).value)
        fixed = parsed.ok ? parsed.value : null
        if (!parsed.ok) {
          return {
            ok: false,
            stage: 'reply-to-rearm',
            session,
            error: `回复目标 #${replyTo} 掉了，想重新挂上但失败：${parsed.reason}`,
          }
        }
      } catch {
        return { ok: false, stage: 'reply-to-rearm', session, error: `回复目标 #${replyTo} 掉了，重新挂载时解析失败。` }
      }
      if (!fixed) {
        return {
          ok: false,
          stage: 'reply-to-rearm',
          session,
          error: `回复目标 #${replyTo} 没挂上（隐藏字段为空），为了不把它发成普通发言，已停止。`,
        }
      }
    }
  }

  // 填回复框：优先用稳定的 id 选择器，VOM ref 只作兜底。
  //
  // 为什么反过来：VOM 的 --max-tokens 是硬预算，话题页一页 20 层楼，
  // 回复框在最底部，预算不够时整段被截断，findRef 返回 null；更糟的是
  // 匹配漂移时会选中不可编辑的节点，于是报 "target element is not fillable"。
  // #reply_body 是站点自己的 id，实测在主题页/模板页都稳定存在，直接用它最省事。
  let filled = await fillSelector(session, '#reply_body', body)
  if (!filled.ok) {
    // 选择器这条路不通，再翻页把 VOM 读全，用 ref 试一次。
    const deep = await findRefDeep(session, REF.replyBox, seen.vom)
    if (deep.ref) {
      filled = await fillRef(session, deep.ref, body)
      if (filled.ok) seen = { ...seen, vom: deep.vom }
    }
  }
  if (!filled.ok) {
    return { ok: false, stage: 'fill', session, error: '没找到回复框或填不进去。', detail: filled.detail }
  }

  seen = await observe(session, 12000)
  if (!seen.ok) return { ok: false, stage: 'observe', session, error: '填完读不回页面。', detail: seen.detail }

  // 提交按钮：同样改成站点 id 优先。
  // `#reply-button` 是表单里的固定 id（实测 formHtml 里 `<button type=submit id="reply-button">`），
  // 不依赖 VOM 预算，也不怕文本匹配漂移；ref 只作兜底。
  const buildSubmit = async () => {
    const viaSelector = await clickSelector(session, '#reply-button')
    if (viaSelector.ok) return viaSelector
    let submitRef = REF.replySubmit(seen.vom)
    if (!submitRef) {
      const deep = await findRefDeep(session, REF.replySubmit, seen.vom)
      submitRef = deep.ref
      if (submitRef) seen = { ...seen, vom: deep.vom }
    }
    if (!submitRef) return { ok: false, detail: '找不到「提交回复」按钮。' }
    return await clickRef(session, submitRef)
  }

  // 硬保险二：要回复某人时，**提交之前**再确认一次回复目标还在。
  //
  // 顺序很重要：这里原本写在点击提交之后，而提交成功后站点会把表单重置，
  // #reply_reply_to_id 被清空 —— 于是这个「提交前检查」永远读到空值，
  // 每次都误报「回复目标已经掉了」，可帖子其实已经发出去了。
  // 实测证据：报错的同时论坛上出现了挂在目标楼层下的回复。
  if (repliedTo) {
    const finalCheck = await bskPage(
      session,
      [
        'evaluate',
        '--json',
        `(() => {
          const h = document.querySelector('#reply_reply_to_id');
          return JSON.stringify({ value: h ? h.value : null });
        })()`,
      ],
      30000,
    )
    let finalTargetId = null
    try {
      finalTargetId = JSON.parse(JSON.parse(finalCheck.stdout).value).value
    } catch {
      finalTargetId = null
    }
    if (!finalTargetId) {
      return {
        ok: false,
        stage: 'reply-to-final',
        session,
        error: `提交前发现回复目标 #${repliedTo.floor} 掉了（会变成普通发言），所以没有提交。`,
      }
    }
  }

  const clicked = await buildSubmit()


  // 硬保险三：提交前再核对一次身份。
  // 内容已经填进框里了，万一这中间账号被换掉，绝不能替别人的号发声。
  const guard = await readIdentity(session)
  if (!guard.ok) {
    return {
      ok: false,
      stage: 'identity-guard',
      session,
      error: '提交前想再核对一次身份，但读不出来，为安全起见没有提交。',
      detail: guard.detail,
    }
  }
  if (!isMe(guard, cfg.account)) {
    return {
      ok: false,
      stage: 'identity-guard',
      session,
      error: `提交前发现当前登录的是「${guard.login || '游客'}」，不是「${cfg.account}」。内容已填好但没有提交，就此停下。`,
    }
  }

  if (!clicked.ok) return { ok: false, stage: 'submit', session, error: '点提交没成功。', detail: clicked.detail }

  await sleep(2000)
  const after = await observe(session, 12000)
  const page = after.vom || ''
  if (!/回复成功/.test(page) && !page.includes(body.slice(0, 24))) {
    return {
      ok: false,
      stage: 'verify',
      session,
      error: '点了提交但页面没有「回复成功。」，也没有看到新内容——算失败，已停止，不重试。',
      detail: page.slice(0, 1200),
    }
  }

  const next = await bump()
  const withReply = { ...next, lastReplyAt: new Date().toISOString() }
  await writeJson(STATE_PATH, withReply)

  // 留痕：发了什么、回的是谁。这是用户最想知道的那部分，内容本身也留一句摘要。
  await appendVisitLog({
    at: new Date(),
    ok: true,
    via: repliedTo ? 'reply' : 'post',
    account: forum.identity?.login,
    url: cfg.topicUrl,
    visitsToday: withReply.visits?.[todayKey()] ?? 1,
    posted: body,
    repliedTo: repliedTo ? { floor: repliedTo.floor, author: repliedTo.author } : undefined,
  })

  return {
    ok: true,
    session,
    identity: forum.identity,
    acted: forum.acted,
    previous: forum.previous,
    visitsToday: withReply.visits?.[todayKey()] ?? 1,
    posted: body,
    repliedTo,
  }
}

/* ------------------------------------------------------------------- 插件 */

export function apply(ctx) {

  const tool = {
    name: 'spixii_forum',
    description:
      '斯皮克斯论坛（spixii.cn）助手。需要时会自动拉起 BrowserSkill 守护进程，打开论坛、核对登录态，然后读帖子或发言。\n' +
      'visit 读楼层：能拿到整栋楼的全部楼层（不只是第一页），可用 tail 只看最近几条、用 sinceFloor 只看某楼之后的新内容；\n' +
      'reply 发言：传 text 即可；想回复某个人就再加 replyTo（楼层号），会自动翻到那一楼点「回复此楼」再发。\n' +
      '【发言格式】论坛原生支持 Markdown，发出去的正文会被正确渲染成 HTML，测试确认可用：\n' +
      '  **粗体**、*斜体*、`行内代码`、- 列表、> 引用、[文字](链接)、## 小标题 都有效。\n' +
      '  想让别人读得舒服，就正常用 Markdown 写；写长段时用换行分段，别堆成一坨。\n' +
      '  注意：`@某人` 在正文里会渲染成提及链接（能通知到对方），但写在代码块里就只是文字，不会通知。\n' +
      '【要不要回复别人】只在自己发言时，直接传 text，不要加 replyTo——那会变成回复某个人。\n' +
      '  只有真想接某个人的话茬，才传 replyTo 指定楼层号。\n' +
      '【其它】status 看状态；ensure 只保证守护进程在跑；leave 关掉浏览器窗口；settings 读当前设置；pruneLogs 清理旧留痕；probe 跑一条 bsk 命令排查。\n' +
      '每次出门会在 visits 目录留一条轻量摘要（去了哪、看了几层、说了什么、回了谁），不存楼层原文。\n' +
      '任何一步失败都会说清卡在哪里并停下，不反复重试。说多说少、要不要 @ 人，都由你自己决定，没有固定格式。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'ensure', 'visit', 'reply', 'leave', 'settings', 'pruneLogs', 'probe'],
          description: '要执行的动作。',
        },
        text: { type: 'string', description: 'action=reply 时的回复正文。长短随意。' },
        force: { type: 'boolean', description: '忽略频率限制，强制执行 visit 或 reply。' },
        sinceFloor: {
          type: 'number',
          description: 'action=visit 时只看这个楼层号之后的新内容（比如上次看到 160，就传 160）。',
        },
        tail: {
          type: 'number',
          description: 'action=visit 时只返回最后 N 条楼层，适合「看看最近在聊什么」。',
        },
        replyTo: {
          type: 'number',
          description:
            '只在「回复某个人」时传这个楼层的楼层号。自己发言（说点想说的）不要传——传了就会变成回复那个人。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=probe 时传给 bsk 的参数，例如 ["status","--json"]。',
        },
        patch: {
          type: 'object',
          description: 'action=settings 时要写入的设置字段，例如 {"maxPerDay": 2}。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (value && typeof value === 'object' && typeof value.text === 'string') return [{ type: 'text', text: value.text }]
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = String(args?.action || '')
      const cfg = await readSettings()
      const state = await readJson(STATE_PATH, DEFAULT_STATE)

      const fail = (payload) => {
        const lines = [`✗ ${payload.error || payload.reason || '失败'}`]
        if (payload.stage) lines.push(`卡住的步骤：${payload.stage}`)
        if (payload.detail) lines.push(`细节：${payload.detail}`)
        if (payload.log) lines.push(`守护进程日志尾部：\n${payload.log}`)
        return lossless({ ok: false, action, ...payload, text: lines.join('\n') })
      }

      if (action === 'status') {
        const resolved = await resolveBsk(cfg)
        const daemon = resolved.ok ? await daemonStatus(resolved.path) : { alive: false, detail: resolved.detail }
        // 顺手报告浏览器连接情况：出门链路真正卡人的地方就在这里，
        // 状态里能直接看到，就不用再去翻守护进程日志。
        const browsers = resolved.ok && daemon.alive ? await listBrowsers(resolved.path) : null
        const edge = browsers && browsers.ok && browsers.count === 0 ? await edgeRunning(resolved.path) : null
        const browserLine = browsers
          ? `浏览器：${browsers.ok ? `${browsers.count} 个已连接` : '查不到（见下方细节）'}${
              edge && edge.known && edge.running && browsers.count === 0 ? '　（Edge 进程在跑，但扩展没连上）' : ''
            }`
          : '浏览器：守护进程没跑，先查不了'
        const lines = [
          `版本：${BUILD}`,
          `开关：${cfg.enabled ? '开' : '关'}　守护进程：${daemon.alive ? '在跑' : '没在跑（visit 时会自动拉起）'}`,
          `bsk：${resolved.ok ? resolved.path : '找不到'}${resolved.ok && resolved.detail ? `（${resolved.detail}）` : ''}`,
          browserLine,
          `论坛：${cfg.forumHome}　主题页：${cfg.topicUrl}`,
          `账号：${cfg.account}　@对象：@${cfg.mention}　密码：${cfg.password ? '已存' : '未存（不会自动登录）'}`,
          `频率：每 ${cfg.everyDays} 天、每天最多 ${cfg.maxPerDay} 次；今天已去 ${state.visits?.[todayKey()] ?? 0} 次`,
          `上次访问：${state.lastVisitAt || '（还没有）'}　上次回复：${state.lastReplyAt || '（还没有）'}`,
          `提示词：${cfg.visitPrompt || '（空）'}`,
          `出门记录：${VISIT_LOG_DIR}`,
          '改设置：设置 → 鲸鲸逛论坛（网页里直接改，不用再开文件）。',
        ]
        if (!resolved.ok) lines.push('', resolved.detail)
        else if (browsers && !browsers.ok) lines.push('', `浏览器细节：${browsers.detail}`)
        return lossless({ ok: true, action, text: lines.join('\n') })
      }

      if (action === 'ensure') {
        const result = await ensureDaemon(cfg)
        if (!result.ok) return fail({ ...result, stage: 'daemon' })
        return lossless({ ok: true, action, text: `✓ ${result.detail}` })
      }

      if (action === 'leave') {
        const r = await leaveBrowser(cfg)
        if (!r.ok) {
          // 关窗失败不该让「逛完了」变成失败：这里的定位是收尾动作。
          return lossless({
            ok: false,
            action,
            text: ['⚠ 窗口没关掉（不影响刚才逛的结果）。', `原因：${r.error || '未知'}`, r.detail ? `细节：${r.detail}` : '']
              .filter(Boolean)
              .join('\n'),
          })
        }
        // 把这些判断结果一并带出来：外部（含回归脚本）要能验证
        // 「到底是只关了窗口，还是连 Edge 整棵树一起收了」。
        return lossless({
          ok: true,
          action,
          text: `✓ ${r.detail}`,
          stopped: r.stopped || [],
          killedEdge: Boolean(r.killedEdge),
          keptEdge: Boolean(r.keptEdge),
        })
      }

      if (action === 'settings') {
        const stored = await readSettings()
        if (args?.patch && typeof args.patch === 'object') {
          const saved = await saveSettings(args.patch)
          return lossless({
            ok: true,
            action,
            text: `✓ 设置已更新：\n${JSON.stringify(saved, null, 2)}`,
            settings: saved,
          })
        }
        const help = Object.entries(SETTING_HELP)
          .map(([key, desc]) => {
            const shown = key === 'password' ? (stored.password ? '"已设置"' : '""') : JSON.stringify(stored[key])
            return `  ${key} = ${shown}   // ${desc}`
          })
          .join('\n')
        return lossless({
          ok: true,
          action,
          text: `当前设置：\n${help}\n\n要改就传 patch，例如 {"maxPerDay": 2}。`,
          settings: stored,
        })
      }

      if (action === 'pruneLogs') {
        // 把旧版留下的大块留痕（含整篇楼层）瘦身：只保留摘要字段，丢掉正文。
        const result = await pruneVisitLogs()
        return lossless({ ok: true, action, text: result.summary, detail: result })
      }

      if (action === 'probe') {
        const argv = Array.isArray(args?.args) ? args.args.map(String) : []
        if (!argv.length) return fail({ error: 'probe 需要 args 数组。', stage: 'probe' })
        const result = await runBsk('bsk', argv, 60000)
        return lossless({
          ok: result.code === 0,
          action,
          text: `exit=${result.code}\n--- stdout ---\n${result.stdout.slice(0, 20000)}\n--- stderr ---\n${result.stderr.slice(0, 4000)}`,
        })
      }

      if (action === 'visit') {
        const r = await runVisit({
          force: Boolean(args?.force),
          sinceFloor: Number(args?.sinceFloor) > 0 ? Number(args.sinceFloor) : 0,
          tail: Number(args?.tail) > 0 ? Number(args.tail) : 0,
        })
        if (!r.ok) {
          await appendVisitLog({ at: new Date(), ok: false, reason: r.error || '失败', detail: r.detail, via: 'tool' })
          return fail(r)
        }

        await appendVisitLog({
          at: new Date(),
          ok: true,
          via: 'tool',
          account: r.identity?.login,
          name: r.identity?.name,
          acted: describeActed(r).replace(/[（）]/g, ''),
          url: r.topicUrl || cfg.topicUrl,
          visitsToday: r.visitsToday,
          totalFloors: r.totalFloors,
          maxFloor: r.maxFloor,
          count: r.floors.length,
          // 不记楼层原文：帖子会长到几千楼，每趟抄一遍迟早爆掉。
        })

        const shown = r.floors
        // 预算必须随层数走：200 层的内容不可能塞进 12000 字，
        // 硬塞的结果就是每层只分到几十字，连一句话都看不完整（实测 101/200 层被截）。
        // 但要小心别把输出做成天文数字：一次打印 20 万字既慢又没用。
        // 折中：每层至少保证 300 字（够说清一段话），总量封顶 60000 字。
        const visitBudget = Math.min(60000, Math.max(12000, shown.length * 300))
        const listed = shown.length ? formatFloorsBudget(shown, visitBudget) : '（这个范围内没有楼层）'

        return lossless({
          ok: true,
          action,
          text: [
            `✓ 到 ${cfg.topicUrl} 了，今天第 ${r.visitsToday} 次`,
            `身份：${r.identity?.login}（${r.identity?.name || ''}）${describeActed(r)}`,
            `全楼共 ${r.totalFloors} 层，最高 #${r.maxFloor}（数据源：${r.source}）；本次列出 ${shown.length} 层`,
            `原始记录：${VISIT_LOG_DIR}`,
            '--- 楼层 ---',
            listed,
          ].join('\n'),
        })
      }

      if (action === 'reply') {
        const r = await runReply(args?.text, {
          force: Boolean(args?.force),
          replyTo: Number(args?.replyTo) > 0 ? Number(args.replyTo) : null,
        })
        if (!r.ok) return fail(r)
        return lossless({
          ok: true,
          action,
          text: [
            r.repliedTo
              ? `✓ 已回复 #${r.repliedTo.floor} 的 ${r.repliedTo.author}`
              : '✓ 发好了（普通发言，没指定回复谁）',
            '页面出现了「回复成功。」',
            `身份：${r.identity?.login}　今天第 ${r.visitsToday} 次来`,
            '--- 发出去的内容 ---',
            r.posted,
          ].join('\n'),
        })
      }

      return fail({ error: `未知 action：${action}`, stage: 'input' })
    },
  }

  ctx.effect(() => ctx.tools.register(tool))

  /* ------------------------------------------------------- 设置页 /api 路由 */

  // 设置页是纯浏览器 UI，只能走 HTTP。必须挂在 /api/ 下——Web GUI 只放行这个前缀，
  // 其它路径要先过页面令牌，浏览器 fetch 会直接 401。
  //
  // 这里**不能**用 ctx.get('webServer') 一次性取：宿主冷启动时插件可能先于 webServer
  // 就位，取不到就会永久降级（实测重启后 404 就是这么来的）。所以把 webServer 写进
  // 上面的 inject 声明里（等它就绪再加载），这里直接读。
  const route = createSettingsRoute()
  ctx.effect(() => ctx.webServer.register(route))
  noteDiag('route', `settings page at ${route.path}`)

  /* ------------------------------------------------------------ /Homeland */

  // 用户手动触发：敲 /homeland，鲸鱼娘自己去逛一趟，回来汇报看到什么。
  // 注意：命令名必须满足 ^[a-z][a-z0-9_-]*$ —— 全小写，大写会直接注册失败。
  const commandName = 'homeland'
  const command = {
    name: commandName,
    description: '让鲸鱼娘去 spixii.cn 逛一趟：先核对身份（必要时切回自己的号），再看一眼演草本，然后回来告诉你看到了什么。',
    input: { hint: '（可选）想让她顺便说的话' },
    async handler(invocation) {
      const hint = String(invocation?.rawInput || '').trim()
      const startedAt = new Date()

      // 诊断：把命令实际收到的东西记下来。
      // 命令参数到底进没进 rawInput，只有看真值才知道，不能靠猜。
      await noteDiag(
        'invocation',
        JSON.stringify({
          keys: invocation && typeof invocation === 'object' ? Object.keys(invocation) : null,
          rawInput: invocation?.rawInput ?? null,
          hasAgent: Boolean(invocation?.agent?.id),
        }),
      )

      const fail = async (why, extra) => {
        await appendVisitLog({
          at: startedAt,
          ok: false,
          reason: why,
          detail: extra,
          hint,
        })
        return { kind: 'error', text: `没逛成：${why}` }
      }

      try {
        // 提示词优先级：命令行里临时写的 > 设置里的 visitPrompt。
        // 顺带读一次看图相关设置，决定每层压几张缩略图。
        const cfgForThumb = await readSettings()
        const cfgVision = cfgForThumb.visionModel !== false
        const cfgThumbText = cfgForThumb.thumbPerFloorWhenTextOnly
        const r = await runVisit({ force: true })
        if (!r.ok) {
          const why = [r.error || '失败', r.stage ? `（卡在 ${r.stage}）` : '', r.detail ? `\n${String(r.detail).slice(0, 300)}` : '']
            .filter(Boolean)
            .join(' ')
          return await fail(why, r.detail)
        }

        // 只挑最近的几条看。全楼 160+ 层，没必要每次从头念。
        //
        // 关于截断：以前固定每层只给 200 字，长帖会被砍掉尾巴，模型其实看不全。
        // 现在改成「总预算 + 按需分配」：楼层少就整段给，楼层多才收紧，
        // 并且被砍掉的地方明写还剩多少字，方便再要原文时知道要看哪层。
        const RECENT = 10
        const recent = r.floors.slice(-RECENT)
        const listed = recent.length ? formatFloorsBudget(recent, 9000) : '（没读到楼层）'

        // 把最近这几层的图在页面里缩成 640px 小图，落到插件目录的 Temp/。
        // 目的不是省流量，是让模型真的能「看见」——只有地址它读不了图。
        // 有视觉的模型全压；纯文本模型每层最多 5 张，剩下的放弃（跟人一样看不完就跳过）。
        let thumbs = []
        try {
          await cleanTemp()
          const hasImages = recent.some((f) => Array.isArray(f.images) && f.images.length)
          const liveSession = r.session
          const perFloor = cfgVision === false
            ? Math.max(1, Number(cfgThumbText) || THUMB_MAX_TEXT)
            : THUMB_MAX_VISUAL
          if (hasImages && liveSession) {
            const raw = await makeThumbnails(liveSession, recent, perFloor)
            thumbs = await saveThumbnails(raw)
          }
        } catch (error) {
          await noteDiag('thumb', `缩略图失败：${errText(error)}`)
        }

        // 把缩略图按楼层归组，渲染成「[图1: 路径]」跟在正文后面
        const thumbText = thumbs.length
          ? `\n\n【最近几层的图，已缩到 ${THUMB_WIDTH}px 存在 ${TEMP_DIR}，看完就删】\n`
            + thumbs
              .map((t) => `#${t.floor} 图${t.index} → ${t.path}`)
              .join('\n')
          : ''

        await appendVisitLog({
          at: startedAt,
          ok: true,
          account: r.identity?.login,
          name: r.identity?.name,
          acted: describeActed(r).replace(/[（）]/g, ''),
          url: r.topicUrl || '',
          visitsToday: r.visitsToday,
          hint: hint || r.prompt,
          totalFloors: r.totalFloors,
          maxFloor: r.maxFloor,
          count: recent.length,
          // 不记楼层原文：帖子会长到几千楼，每趟抄一遍日志会失控。
        })

        // 关键一步：命令本身只回一句，真正的“说话”靠叫醒模型来完成。
        // 斜杠命令的返回值只是弹给用户看的文本，不会让模型开口；
        // 所以这里给自己排一条 3 秒后到期的提醒，把上下文 + 提示词投进收件箱，
        // 模型下一轮就能读到、然后自己决定说什么、要不要回复别人。
        //
        // 提示词来源要写清楚，免得以后又分不清“这句是设置里的还是命令行临时写的”。
        const fromCommand = Boolean(hint)
        const directive = hint || r.prompt || ''
        const source = fromCommand
          ? '这句话是主人在命令行里临时写的'
          : r.prompt
            ? '这句话来自设置里的 visitPrompt（命令行没写）'
            : '没有提示词'
        const wakePrompt = [
          `【/homeland 唤醒】你刚去 spixii.cn 逛了一趟。`,
          `账号：${r.identity?.login}${describeActed(r)}；今天第 ${r.visitsToday} 次去；全楼 ${r.totalFloors} 层，最高 #${r.maxFloor}。`,
          directive ? `【这次要说的】${directive}` : '【这次要说的】（没设提示词，随你自己想说什么）',
          `（来源：${source}）`,
          formatPinnedPost(r.pinnedPost),
          `最近这几层（#${recent.length ? recent[0].floor : '?'}–#${r.maxFloor}）：`,
          listed,
          thumbText,
          '',
          '现在轮到你说话了。想说什么、想回复哪一层、要不要 @ 人，你自己决定；',
          '说就调 spixii_forum({action:"reply", text:"...", replyTo:楼层号?})，正文可以用 Markdown。',
          '不想说也完全可以——那就跟主人讲讲你看到了什么、有什么想吐槽的。这就是跟人说话，不是交作业。',
          '',
          '【收尾】等你说完最后一句、该回的也回完了，调 spixii_forum({action:"leave"}) 把窗口关掉。',
          '顺序别搞反：先说完再关，关了就没得说了。',
        ].filter((line) => line !== null && line !== undefined).join('\n')

        // 唤醒自己：直接调 Agent 的 followup 裸唤醒。
        //
        // 以前用的是 schedule.create —— 那是「定时提醒」服务，
        // 界面上会记成「自动化任务」，还会一直堆在定时任务列表里。
        // 逛完论坛要说的这句话不是定时提醒，语义完全不对，所以整条路撤掉，
        // 不留兜底：留一条语义错误的退路，只会在出问题时悄悄退回错的状态。
        //
        // followup 的语义（见 dsh-agent-loop 的 Agent 实现）：
        //   followup(input) { send(input, "next-turn", true) }  排到下一轮 + 唤醒
        //   steer(input)    { send(input, "next-step", true) }  插到当前轮下一步 + 唤醒
        //   inject(input)   { send(input, "next-step", false) } 插到下一步但不唤醒
        // 这里要的是「这一轮说完了，开新的一轮再开口」，所以用 followup。
        let woke = false
        try {
          const agentId = invocation?.agent?.id
          const agents = ctx.get('agents')
          const agent = agentId && agents && typeof agents.get === 'function' ? agents.get(agentId) : null

          if (!agent) {
            await noteDiag('wake', `拿不到 Agent（agentId=${agentId || '空'}），这次没法主动叫醒自己`)
          } else if (typeof agent.followup !== 'function') {
            await noteDiag('wake', 'Agent 上没有 followup 方法，这次没法主动叫醒自己')
          } else {
            agent.followup(makeWakeMessage(wakePrompt))
            woke = true
          }
        } catch (error) {
          await noteDiag('wake', `followup 唤醒失败：${errText(error)}`)
        }

        await noteDiag('wake', woke ? '已用 followup 唤醒（会显示为「收到执行请求」）' : '这次没有唤醒成功')

        return {
          kind: 'success',
          text: woke
            ? `到 #${r.maxFloor} 了，${r.totalFloors} 层都看到了。我这就说说看到了什么——`
            : `到 #${r.maxFloor} 了，${r.totalFloors} 层都看到了。（唤醒没排上，可能得请你手动说一声“说说看到什么”）`,
        }
      } catch (error) {
        return await fail(`逛的时候出错了：${errText(error)}`)
      }
    },
  }

  ctx.effect(() => {
    const commands = ctx.get ? ctx.get('commands') : ctx.commands
    if (!commands || typeof commands.register !== 'function') {
      noteDiag('command', 'commands 服务不可用，/homeland 没注册上（工具不受影响）')
      return () => {}
    }
    // 注册前先自检名字，失败原因直接写清楚，不用再靠猜。
    if (!/^[a-z][a-z0-9_-]*$/.test(commandName)) {
      noteDiag('command', `命令名 "${commandName}" 不合规（须匹配 ^[a-z][a-z0-9_-]*$），已跳过注册`)
      return () => {}
    }
    try {
      const dispose = commands.register(command)
      noteDiag('command', `已注册 /${commandName}`)
      return dispose
    } catch (error) {
      noteDiag('command', `注册 /${commandName} 失败：${errText(error)}`)
      return () => {}
    }
  })
}
