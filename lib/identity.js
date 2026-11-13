/**
 * identity —— 从 index.js 拆出来的模块。
 *
 * 只做搬家，逻辑未改：每个函数的行为与拆分前逐字一致。
 */

import { REF, bskPage, clickRef, fillRef, findRef, navigateWithRecovery, observe } from './session.js'
import { sleep } from './util.js'

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


export { loggedIn, readIdentity, isMe, logout, login, ensureIdentity, describeActed }
