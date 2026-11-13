/**
 * config —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */
import path from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')

const DATA_DIR = path.join(DSH_HOME, 'spixii-forum')

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')

const STATE_PATH = path.join(DATA_DIR, 'state.json')

const BSK_HOME = process.env.BSK_HOME || path.join(homedir(), '.bsk')


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


// 每次出门都留一条记录，不管成没成。用户在对话里能看摘要，想深挖就翻这个文件。
const VISIT_LOG_DIR = path.join(DATA_DIR, 'visits')


/**
 * 缩略图临时目录。
 *
 * 必须放在 DSH_HOME 下，不能放插件目录：profile 里插件是指回工作区的软链接，
 * 插件目录跟着工作区走——用户换个工作区，图片路径就失效了。
 * 数据目录（settings.json / visits / Temp）应该跟工作区无关，一并收在这里。
 */
const TEMP_DIR = path.join(DATA_DIR, 'Temp')


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


/** 我们起的那个 Edge 的 pid、告示页地址，跨进程记在 state.json 里。 */
const LAUNCH_KEY = 'launchedEdge'


const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const EDGE_EXE_ALT = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'


export { DSH_HOME, DATA_DIR, SETTINGS_PATH, STATE_PATH, BSK_HOME, DEFAULT_SETTINGS, SETTING_HELP, DEFAULT_STATE, BUILD, VISIT_LOG_DIR, TEMP_DIR, ANCHOR_PATH, AWAY_FILE, AWAY_MARK, LAUNCH_KEY, EDGE_EXE, EDGE_EXE_ALT }
