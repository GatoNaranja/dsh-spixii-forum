/**
 * flows —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */

import { judgePinnedPost, loadAnchor, readPinnedPost, saveAnchor, snapshotPinnedPost } from './anchor.js'
import { ensureBrowser } from './browser.js'
import { ensureDaemon } from './bsk.js'
import { DEFAULT_STATE, STATE_PATH } from './config.js'
import { FLOOR_LOCATOR_SRC, hydrateReplyQuotes, readFloors, readFloorsSimple } from './floors.js'
import { ensureIdentity, isMe, login, readIdentity } from './identity.js'
import { REF, bskPage, clickRef, clickSelector, ensureSession, fillRef, fillSelector, findRef, findRefDeep, navigate, navigateWithRecovery, observe } from './session.js'
import { readSettings } from './settings.js'
import { errText, noteDiag, readJson, sleep, todayKey, writeJson } from './util.js'
import { appendVisitLog, bump, gate } from './visits.js'

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


export { openForum, runVisit, runReply }
