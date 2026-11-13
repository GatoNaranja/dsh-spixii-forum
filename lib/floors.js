/**
 * floors —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'

import { TEMP_DIR } from './config.js'
import { bskPage } from './session.js'
import { errText, noteDiag } from './util.js'

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


/** 缩略图宽度。480 以下小字会糊，640 只多几 KB，取 640。 */
const THUMB_WIDTH = 640

const THUMB_QUALITY = 0.72

/** 单次最多缩几张（视觉模型可读全部，纯文本模型单层上限 5）。 */
const THUMB_MAX_VISUAL = 999

const THUMB_MAX_TEXT = 5


export { readFloors, readFloorsSimple, hydrateReplyQuotes, formatFloorsBudget, FLOOR_LOCATOR_SRC, ensureTempDir, cleanTemp, makeThumbnails, saveThumbnails, THUMB_WIDTH, THUMB_QUALITY, THUMB_MAX_VISUAL, THUMB_MAX_TEXT }
