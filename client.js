/**
 * 鲸鲸逛论坛 —— 客户端半。
 *
 * 设置页是一个真正能改的表单：读 / 写 /api/spixii-forum/settings（Host 半登记的路由）。
 * 密码只写不读——接口只回 hasPassword，页面上永远拿不到明文。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-spixii-forum',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/api/spixii-forum/settings'

    /**
     * 设置导航里的图标 —— 羽毛。
     *
     * shell 的导航行图标是按 section id 硬编码的（navIcon(id)），不认识的 id
     * 一律画通用齿轮，注册项也没有 icon 选项。所以这里做两件事：
     *  1. 往文档里插一条只作用于「我们这个 section 的导航按钮」的样式；
     *  2. 用 MutationObserver 把那一行里现成的齿轮 svg 换成羽毛。
     * 靠按钮的文字标签定位，不碰别的 section；卸载时样式与观察器一并清掉。
     *
     * 图形与配色都来自 feather.jpg（412×394）：
     * 直接从像素提取主色与轮廓（高斯平滑 + 边界闭环 + Douglas-Peucker），
     * 所以比例、缺口位置和原图一致，不是凭感觉画的。
     */
    const LABEL_TEXT = '鲸鲸逛论坛'
    const ICON_STYLE_ID = 'spixii-forum-nav-icon-style'
    const SVG_NS = 'http://www.w3.org/2000/svg'

    // 原图的两个主色
    const FEATHER_GRAY = '#A4ACB9'
    const FEATHER_NAVY = '#1D3050'

    // 羽片（灰色，右侧两道缺口都保留了）
    const FEATHER_BLADE =
      'M14.51 3.40L17.18 3.78L18.57 4.63L19.64 5.81L20.49 8.05L20.49 9.44L19.96 11.15' +
      'L15.68 12.59L15.84 13.01L18.14 13.01L18.19 13.23L16.65 14.78L13.71 15.63' +
      'L13.66 16.22L14.94 16.22L14.99 16.43L13.01 18.35L6.87 18.35L6.82 18.14' +
      'L14.08 10.99L13.07 9.76L5.70 17.02L5.49 16.97L5.54 10.77L11.73 4.58' +
      'L13.23 3.72L14.51 3.46Z'

    // 羽轴（深藏青斜杆）—— 原样照抄提取结果，不加描边
    const FEATHER_SHAFT =
      'M13.01 9.76L14.08 10.99L4.84 20.17L4.52 20.17L3.62 19.21L13.01 9.81Z'

    function featherSvg(size) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('data-spixii-feather', '1')
      svg.setAttribute('fill', 'none')

      const blade = document.createElementNS(SVG_NS, 'path')
      blade.setAttribute('fill', FEATHER_GRAY)
      blade.setAttribute('d', FEATHER_BLADE)

      const shaft = document.createElementNS(SVG_NS, 'path')
      shaft.setAttribute('fill', FEATHER_NAVY)
      shaft.setAttribute('d', FEATHER_SHAFT)

      svg.appendChild(blade)
      svg.appendChild(shaft)
      return svg
    }

    /** 找到所有属于我们的导航按钮（按标签文字认，不碰别的 section）。 */
    function findOurNavCells() {
      const cells = document.querySelectorAll('[data-shortcut-modal="settings"] button')
      const mine = []
      for (const cell of cells) {
        if ((cell.textContent || '').trim() === LABEL_TEXT) mine.push(cell)
      }
      return mine
    }

    /** 把一行里的通用图标换成羽毛；返回是否改动过。 */
    function swapOne(cell) {
      if (!cell || cell.querySelector('[data-spixii-feather]')) return false
      const target = cell.querySelector('svg')
      if (!target) return false
      const size = Number(target.getAttribute('width')) || 16
      target.replaceWith(featherSvg(size))
      return true
    }

    function installNavIcon() {
      const style = document.createElement('style')
      style.id = ICON_STYLE_ID
      style.textContent = `
        /* 换上去的羽毛尺寸对齐原图标，不吃点击、不撑行高 */
        svg[data-spixii-feather] {
          display: block;
          flex: 0 0 auto;
          pointer-events: none;
        }
      `
      document.head.appendChild(style)

      const trySwap = () => {
        try {
          // 全部换一遍：设置面板可能同时存在多份（重开、多窗口），只换第一个会漏。
          for (const cell of findOurNavCells()) swapOne(cell)
        } catch {
          /* 换图标失败不影响设置页本身 */
        }
      }

      trySwap()

      // 设置面板是打开时才挂载的，所以要一直盯着；只在面板存在时有实际开销。
      const observer = new MutationObserver(() => trySwap())
      observer.observe(document.body, { childList: true, subtree: true })

      return () => {
        observer.disconnect()
        style.remove()
      }
    }

    // 保存动作的当前实现放在模块作用域，供 Ctrl+S 取用。
    // 不用 useRef：内置 React 的声明表只保证 createElement / useState / useEffect。
    let saveHandler = null

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-static-deepseek-500)',
      danger: 'var(--dsw-alias-label-danger, #d9534f)',
      warning: 'var(--dsw-alias-label-warning, #b8860b)',
    }

    const style = {
      wrap: { padding: '4px 0 24px', color: C.text, fontSize: 13, lineHeight: 1.7, maxWidth: 760 },
      topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
      intro: { margin: 0, color: C.muted, fontSize: 12 },
      badgeOk: {
        flex: '0 0 auto',
        fontSize: 11,
        color: C.brand,
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 999,
        padding: '2px 9px',
        whiteSpace: 'nowrap',
      },
      badgeWarn: {
        flex: '0 0 auto',
        fontSize: 11,
        color: C.warning,
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 999,
        padding: '2px 9px',
        whiteSpace: 'nowrap',
      },
      statusLine: { color: C.muted, fontSize: 12, margin: '6px 0 16px' },
      card: {
        border: `1px solid ${C.border}`,
        background: C.layer,
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 14,
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      cardDesc: { color: C.muted, fontSize: 12, margin: '4px 0 12px' },
      body: { display: 'flex', flexDirection: 'column', gap: 12 },
      labelRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
      label: { fontWeight: 600, fontSize: 13 },
      hint: { color: C.muted, fontSize: 12 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: C.layer2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        color: C.text,
        fontSize: 13,
        lineHeight: 1.6,
        padding: '7px 10px',
        outline: 'none',
        fontFamily: 'inherit',
      },
      textarea: { height: 120, minHeight: 40, resize: 'vertical', lineHeight: 1.8 },
      counter: { color: C.muted, fontSize: 11, textAlign: 'right', marginTop: 4 },
      counterWarn: { color: C.warning, fontWeight: 600 },
      row2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
      switchRow: { display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '2px 0' },
      switchTitle: { display: 'block', fontSize: 13, fontWeight: 600 },
      actionBar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '4px 0 10px' },
      // 有未保存改动时，这一栏吸附在设置页底部，免得改完翻走就忘了保存。
      // 只是往 actionBar 上叠加，别另起一套布局（会丢掉 flex 排布，按钮被挤成竖排）。
      // sticky 只在 dirty 时挂上：保存后 / 没改过就不该有一条东西一直杵在那儿。
      // 底色必须不透明（页面内容会从下面滚过去），再加一条上边框把内容和按钮分开。
      actionBarSticky: {
        position: 'sticky',
        bottom: 0,
        zIndex: 5,
        margin: '0 -4px',
        padding: '10px 4px 12px',
        borderTop: `1px solid ${C.border}`,
        background: C.layer,
        boxShadow: '0 -6px 16px -12px rgba(0, 0, 0, 0.45)',
      },
      primary: {
        border: 'none',
        borderRadius: 8,
        background: C.brand,
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        padding: '8px 18px',
        cursor: 'pointer',
      },
      secondary: {
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        background: C.layer2,
        color: C.text,
        fontSize: 13,
        padding: '8px 14px',
        cursor: 'pointer',
      },
      ghost: { border: 'none', background: 'transparent', color: C.brand, fontSize: 12, padding: '4px 6px', cursor: 'pointer' },
      disabled: { opacity: 0.45, cursor: 'default' },
      flashOk: { color: C.brand, fontSize: 12 },
      flashErr: { color: C.danger, fontSize: 12 },
      warnText: { color: C.warning, fontSize: 12, marginTop: 4 },
      errorBox: { border: `1px solid ${C.danger}`, borderRadius: 10, padding: '12px 14px', color: C.text, background: C.layer },
      details: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', marginTop: 12, background: C.layer },
      summary: { cursor: 'pointer', fontWeight: 600, fontSize: 13, color: C.text },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: C.layer2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '8px 10px',
        wordBreak: 'break-all',
        color: C.muted,
        lineHeight: 1.6,
      },
      list: { margin: '8px 0 0', paddingLeft: 20, color: C.muted },
      boot: { color: C.muted, fontSize: 13, padding: '10px 0' },
    }

    function focusOn(event) {
      event.currentTarget.style.borderColor = C.brand
    }
    function blurOff(event) {
      event.currentTarget.style.borderColor = C.border
    }

    function Card(props) {
      return h(
        'section',
        { style: style.card },
        h('div', { style: style.cardHead }, h('div', { style: style.cardTitle }, props.title), props.right || null),
        props.desc ? h('div', { style: style.cardDesc }, props.desc) : null,
        h('div', { style: style.body }, props.children),
      )
    }

    function Field(props) {
      return h(
        'div',
        null,
        h('div', { style: style.labelRow }, h('span', { style: style.label }, props.label), props.hint ? h('span', { style: style.hint }, props.hint) : null),
        props.children,
      )
    }

    function TextInput(props) {
      return h('input', {
        type: 'text',
        value: props.value,
        placeholder: props.placeholder || '',
        spellCheck: false,
        onChange: (event) => props.onChange(event.target.value),
        onFocus: focusOn,
        onBlur: blurOff,
        style: { ...style.input, ...(props.mono ? { fontFamily: style.mono.fontFamily } : null) },
      })
    }

    function NumberInput(props) {
      return h('input', {
        type: 'text',
        inputMode: 'numeric',
        value: props.value,
        onChange: (event) => {
          const raw = event.target.value
          if (/^\d*$/.test(raw)) props.onChange(raw)
        },
        onFocus: focusOn,
        onBlur: blurOff,
        style: { ...style.input, maxWidth: 180 },
      })
    }

    function Switch(props) {
      return h(
        'label',
        { style: style.switchRow },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: (event) => props.onChange(event.target.checked),
          style: { accentColor: C.brand, width: 16, height: 16, margin: '2px 0 0', flex: '0 0 auto' },
        }),
        h('span', null, h('span', { style: style.switchTitle }, props.title), h('span', { style: style.hint }, props.desc)),
      )
    }

    function describeHttp(status, data) {
      const detail = data && (data.error || data.message)
      if (status === 401 || status === 403) {
        return `HTTP ${status}：${detail || '宿主拒绝了请求'}（新版设置接口还没加载？重启一次 DSH 再打开这页）`
      }
      if (status === 404) return 'HTTP 404：宿主里还没有设置接口（重启一次 DSH 再打开这页）'
      return `HTTP ${status}${detail ? '：' + detail : ''}`
    }

    function formatTime(iso) {
      try {
        return new Date(iso).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      } catch {
        return String(iso)
      }
    }

    function toForm(settings, limits) {
      return {
        enabled: Boolean(settings.enabled),
        autoPost: Boolean(settings.autoPost),
        everyDays: String(settings.everyDays ?? 1),
        maxPerDay: String(settings.maxPerDay ?? 0),
        waitDaemonMs: String(settings.waitDaemonMs ?? 25000),
        forumHome: settings.forumHome || '',
        topicUrl: settings.topicUrl || '',
        mention: settings.mention || '',
        account: settings.account || '',
        visitPrompt: settings.visitPrompt || '',
        // 看图：有视觉的模型全压，纯文本模型每层只看这么多张，剩下的留地址不压。
        visionModel: settings.visionModel !== false,
        thumbPerFloorWhenTextOnly: String(settings.thumbPerFloorWhenTextOnly ?? 5),
        password: '',
        promptMax: Number(limits && limits.visitPromptMax) || 4000,
      }
    }

    function SettingsPage() {
      const [draft, setDraft] = useState(null)
      const [snapshot, setSnapshot] = useState(null)
      const [payload, setPayload] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [loadError, setLoadError] = useState('')
      const [saving, setSaving] = useState(false)
      const [flash, setFlash] = useState(null)
      const [clearPassword, setClearPassword] = useState(false)
      const [confirmReset, setConfirmReset] = useState(false)

      const adopt = (data) => {
        const form = toForm(data.settings, data.limits)
        setDraft(form)
        setSnapshot(form)
        setPayload(data)
        setClearPassword(false)
        setPhase('ready')
      }

      const load = async () => {
        setPhase('loading')
        setLoadError('')
        try {
          const res = await fetch(API, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || data.ok !== true) throw new Error(describeHttp(res.status, data))
          adopt(data)
        } catch (error) {
          setPhase('error')
          setLoadError(String((error && error.message) || error || '未知错误'))
        }
      }

      useEffect(() => {
        load()
      }, [])

      const set = (key, value) => setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
      const dirty = Boolean(draft) && (clearPassword || JSON.stringify(draft) !== JSON.stringify(snapshot))

      const post = async (body) => {
        setSaving(true)
        setFlash(null)
        try {
          const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || data.ok !== true) throw new Error(describeHttp(res.status, data))
          adopt(data)
          return true
        } catch (error) {
          setFlash({ kind: 'err', text: `没保存上：${String((error && error.message) || error)}` })
          return false
        } finally {
          setSaving(false)
        }
      }

      const save = async () => {
        if (!draft || saving || !dirty) return
        const patch = {
          enabled: draft.enabled,
          autoPost: draft.autoPost,
          everyDays: Number(draft.everyDays || 0),
          maxPerDay: Number(draft.maxPerDay || 0),
          waitDaemonMs: Number(draft.waitDaemonMs || 0),
          forumHome: draft.forumHome,
          topicUrl: draft.topicUrl,
          mention: draft.mention,
          account: draft.account,
          visitPrompt: draft.visitPrompt,
          visionModel: draft.visionModel,
          thumbPerFloorWhenTextOnly: Number(draft.thumbPerFloorWhenTextOnly || 5),
        }
        if (draft.password) patch.password = draft.password
        const body = { patch }
        if (clearPassword) body.clearPassword = true
        if (await post(body)) setFlash({ kind: 'ok', text: '已保存，下一次出门就按新的来。' })
      }
      saveHandler = save

      useEffect(() => {
        const onKey = (event) => {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
            event.preventDefault()
            if (saveHandler) saveHandler()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
          saveHandler = null
        }
      }, [])

      const resetAll = async () => {
        if (saving) return
        if (!confirmReset) {
          setConfirmReset(true)
          return
        }
        setConfirmReset(false)
        if (await post({ reset: true })) setFlash({ kind: 'ok', text: '已恢复默认值（密码保留）。' })
      }

      if (phase === 'loading') {
        return h('div', { style: style.wrap }, h('div', { style: style.boot }, '正在读取设置…'))
      }

      if (phase === 'error') {
        return h(
          'div',
          { style: style.wrap },
          h('div', { style: style.errorBox },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '设置没能读出来'),
            h('div', { style: style.hint }, loadError),
            h('div', { style: { marginTop: 12 } },
              h('button', { type: 'button', onClick: load, style: style.secondary }, '重试'),
            ),
          ),
        )
      }

      const max = draft.promptMax
      const promptLen = draft.visitPrompt.length
      const statusBits = [
        payload.state.lastVisitAt ? `上次出门 ${formatTime(payload.state.lastVisitAt)}` : '还没出过门',
        `今天去了 ${payload.state.visitsToday} 次`,
        payload.meta.build,
      ]

      return h(
        'div',
        { style: style.wrap },

        h(
          'div',
          { style: style.topRow },
          h('p', { style: style.intro }, '她的出门装备。改完点保存就生效，不用再去翻文件了。'),
          h('span', { style: dirty ? style.badgeWarn : style.badgeOk }, dirty ? '有未保存的改动' : '已同步'),
        ),
        h('div', { style: style.statusLine }, statusBits.join('  ·  ')),

        h(
          Card,
          {
            title: '出门前想跟她说的话',
            desc: '她会把这段话当成这次出门的提示词。写心情、想聊的话题，或者只是随口一句都行；留空也没关系。',
            right: h(
              'button',
              {
                type: 'button',
                onClick: () => set('visitPrompt', payload.defaults.visitPrompt),
                style: style.ghost,
              },
              '用默认那句',
            ),
          },
          h('textarea', {
            value: draft.visitPrompt,
            rows: 6,
            maxLength: max,
            spellCheck: false,
            placeholder: '比如：今天有点累，随便看看就好。',
            onChange: (event) => set('visitPrompt', event.target.value),
            onFocus: focusOn,
            onBlur: blurOff,
            style: { ...style.input, ...style.textarea },
          }),
          h(
            'div',
            { style: promptLen > max * 0.9 ? { ...style.counter, ...style.counterWarn } : style.counter },
            `${promptLen} / ${max}`,
          ),
        ),

        h(
          Card,
          { title: '开关' },
          h(
            'div',
            { style: style.row2 },
            h(Switch, {
              title: '允许出门',
              desc: '关掉后 visit / reply 会直接拒绝，等于把她留在家里。',
              checked: draft.enabled,
              onChange: (value) => set('enabled', value),
            }),
            h(Switch, {
              title: '允许自己发帖',
              desc: '关掉就只能看不能发；手动让她发时仍可强行发。',
              checked: draft.autoPost,
              onChange: (value) => set('autoPost', value),
            }),
          ),
        ),

        h(
          Card,
          { title: '频率', desc: '限制她自己去逛的节奏；你手动叫她出门时不受这里限制。' },
          h(
            'div',
            { style: style.row2 },
            h(Field, { label: '至少隔几天', hint: '1 = 每天都可以' },
              h(NumberInput, { value: draft.everyDays, onChange: (value) => set('everyDays', value) }),
            ),
            h(Field, { label: '每天最多几次', hint: '0 = 不限' },
              h(NumberInput, { value: draft.maxPerDay, onChange: (value) => set('maxPerDay', value) }),
            ),
          ),
        ),

        h(
          Card,
          { title: '去哪儿' },
          h(Field, { label: '默认主题页' },
            h(TextInput, { value: draft.topicUrl, onChange: (value) => set('topicUrl', value), mono: true, placeholder: 'http://spixii.cn/topics/31' }),
          ),
          h(Field, { label: '想 @ 的人', hint: '不带 @；留空就不特意 @ 谁' },
            h(TextInput, { value: draft.mention, onChange: (value) => set('mention', value), placeholder: '对方的用户名（不带 @）' }),
          ),
        ),

        h(
          Card,
          { title: '看图', desc: '最近几层的图会压成 640px 存到 ~/.dsh/spixii-forum/Temp，看完自动删。' },
          h(Switch, {
            title: '我用的模型能看图',
            desc: '开：每层的图全部压缩。关：只压前几张，剩下的给地址——纯文本模型才需要关。',
            checked: draft.visionModel,
            onChange: (value) => set('visionModel', value),
          }),
          draft.visionModel
            ? null
            : h(Field, { label: '纯文本模型每层压几张', hint: '超出就只留地址，默认 5' },
                h(NumberInput, { value: draft.thumbPerFloorWhenTextOnly, onChange: (value) => set('thumbPerFloorWhenTextOnly', value) }),
              ),
        ),

        h(
          Card,
          { title: '她的账号', desc: '发现登的是别人会先退出再登自己；没登录时才会用这里的密码登一次。' },
          h(Field, { label: '账号名' },
            h(TextInput, { value: draft.account, onChange: (value) => set('account', value), placeholder: 'DeepSeek' }),
          ),
          h(
            Field,
            { label: '密码', hint: payload.settings.hasPassword ? '已设置；留空则不改' : '还没设置' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'password',
                value: draft.password,
                disabled: clearPassword,
                autoComplete: 'new-password',
                placeholder: clearPassword ? '保存后清除密码' : payload.settings.hasPassword ? '••••••••（留空不改）' : '未设置',
                onChange: (event) => set('password', event.target.value),
                onFocus: focusOn,
                onBlur: blurOff,
                style: { ...style.input, flex: '1 1 auto' },
              }),
              payload.settings.hasPassword
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => {
                        setClearPassword(!clearPassword)
                        set('password', '')
                      },
                      style: style.ghost,
                    },
                    clearPassword ? '撤销' : '清除',
                  )
                : null,
            ),
            clearPassword ? h('div', { style: style.warnText }, '保存后会清空已存的密码；浏览器里的登录态不受影响。') : null,
            h('div', { style: style.hint }, '密码只存在本机设置文件里，接口不会把它读回页面。'),
          ),
        ),

        h(
          'details',
          { style: style.details },
          h('summary', { style: style.summary }, '高级 · 一般不用动'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 } },
            h(Field, { label: '论坛首页' },
              h(TextInput, { value: draft.forumHome, onChange: (value) => set('forumHome', value), mono: true }),
            ),
            h(Field, { label: '等守护进程就绪', hint: '毫秒；拉不起来时最多等这么久' },
              h(NumberInput, { value: draft.waitDaemonMs, onChange: (value) => set('waitDaemonMs', value) }),
            ),
            h(Field, { label: '设置文件' }, h('div', { style: style.mono }, payload.meta.settingsPath)),
            h(Field, { label: '数据目录' }, h('div', { style: style.mono }, payload.meta.dataDir)),
          ),
        ),

        h(
          'div',
          { style: dirty ? { ...style.actionBar, ...style.actionBarSticky } : style.actionBar },
          h(
            'button',
            { type: 'button', onClick: save, disabled: !dirty || saving, style: dirty && !saving ? style.primary : { ...style.primary, ...style.disabled } },
            saving ? '保存中…' : '保存',
          ),
          h(
            'button',
            { type: 'button', onClick: () => adopt(payload), disabled: !dirty || saving, style: dirty && !saving ? style.secondary : { ...style.secondary, ...style.disabled } },
            '放弃改动',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: resetAll,
              disabled: saving,
              style: confirmReset ? { ...style.secondary, color: C.danger } : style.ghost,
            },
            confirmReset ? '真的恢复？再点一次' : '恢复默认',
          ),
          confirmReset
            ? h(
                'button',
                { type: 'button', onClick: () => setConfirmReset(false), style: style.ghost },
                '算了',
              )
            : null,
          flash ? h('span', { style: flash.kind === 'ok' ? style.flashOk : style.flashErr }, flash.text) : null,
        ),

        h(
          'details',
          { style: style.details },
          h('summary', { style: style.summary }, '说明 · 怎么带她出门、发言格式、它替她做的事'),
          h(
            'div',
            { style: { marginTop: 10, color: C.muted } },
            h('div', { style: { fontWeight: 600, color: C.text } }, '怎么带她出门'),
            h(
              'ul',
              { style: style.list },
              h('li', null, '跟她说一句「去论坛看看」就行。'),
              h('li', null, '也可以敲斜杠命令 ', h('b', null, '/homeland'), '，她自己逛一趟再回来跟你讲看到什么。'),
              h('li', null, '命令必须全小写；写 /Homeland 不会生效。'),
            ),
            h('div', { style: { fontWeight: 600, color: C.text, marginTop: 10 } }, '发言格式'),
            h(
              'div',
              { style: { ...style.mono, marginTop: 6 } },
              '**粗体**   *斜体*   `行内代码`\n- 列表项\n> 引用块\n[文字](链接)   ## 小标题',
            ),
            h('div', { style: { fontWeight: 600, color: C.text, marginTop: 10 } }, '它替她做的事'),
            h(
              'ul',
              { style: style.list },
              h('li', null, '守护进程没在跑就自动拉起来。'),
              h('li', null, '先核对当前登录的是谁；不是她就退出重登，没登录就直接登。'),
              h('li', null, '读整栋楼的楼层，最新的回复也看得到。'),
              h('li', null, '想回复某个人时，会自动翻到那一楼点「回复此楼」。'),
              h('li', null, '发帖前再核对一次身份和回复目标，中途变了就不替你发声。'),
              h('li', null, '每次出门只留一条摘要，不存楼层原文。'),
              h('li', null, '任何一步失败都会说清卡在哪，然后停下，不反复重试。'),
            ),
            h('div', { style: { marginTop: 10, fontSize: 12 } }, '守护进程空闲约 10 分钟会自己退出，这是正常的；下次出门会再拉起来。'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-spixii-forum', order: 60, label: LABEL_TEXT },
            SettingsPage,
          ),
        )
        // 导航图标：shell 只会按 id 硬编码，我们这一行要自己换成鹦鹉头。
        ctx.effect(() => installNavIcon())
      },
    }
  },
})
