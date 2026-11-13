/**
 * anchor —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { ANCHOR_PATH, DATA_DIR } from './config.js'
import { bskPage } from './session.js'
import { errText } from './util.js'

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


const ANCHOR_TEXT_MAX = 8000

const ANCHOR_IMG_MAX = 60


export { readPinnedPost, bigrams, gramSets, ratiosOf, snapshotPinnedPost, listDiff, readAnchors, writeAnchors, loadAnchor, saveAnchor, judgePinnedPost, formatPinnedPost, ANCHOR_TEXT_MAX, ANCHOR_IMG_MAX }
