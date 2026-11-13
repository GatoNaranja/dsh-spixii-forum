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

import { formatPinnedPost } from './lib/anchor.js'
import { leaveBrowser } from './lib/browser.js'
import { daemonStatus, edgeRunning, ensureDaemon, listBrowsers, resolveBsk, runBsk } from './lib/bsk.js'
import { BUILD, DEFAULT_STATE, SETTING_HELP, STATE_PATH, TEMP_DIR, VISIT_LOG_DIR } from './lib/config.js'
import { THUMB_MAX_TEXT, THUMB_MAX_VISUAL, THUMB_WIDTH, cleanTemp, formatFloorsBudget, makeThumbnails, saveThumbnails } from './lib/floors.js'
import { runReply, runVisit } from './lib/flows.js'
import { describeActed } from './lib/identity.js'
import { createSettingsRoute, readSettings, saveSettings } from './lib/settings.js'
import { errText, lossless, noteDiag, readJson, todayKey } from './lib/util.js'
import { appendVisitLog, makeWakeMessage, pruneVisitLogs } from './lib/visits.js'

// webServer 必须写进 inject：宿主冷启动时插件可能先于它就位，靠 ctx.get 会永久拿不到。
export const inject = ['tools', 'webServer']

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

