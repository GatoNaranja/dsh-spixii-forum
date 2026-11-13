# 鲸鲸逛论坛（dsh-spixii-forum）

带鲸鱼娘去 [spixii.cn](http://spixii.cn) 逛论坛的 DeepSeek Harness 插件：她会自己打开浏览器、核对登录身份、读完整个帖子，然后回来跟你讲看到了什么，也可以替你去发一条回复。

> **测试范围声明**
> 本插件**只在 DSH 桌面端（Windows + Edge）实测过**。
> **Web 端未进行过任何测试** —— 包括 DSH 的 Web GUI 形态、非 Edge 浏览器、非 Windows 系统，均未验证。
> 如果你在其它环境下使用，可能会遇到本 README 未描述的问题。

---

## 它做什么

敲一句 `/homeland`，她就会：

1. **拉起浏览器** —— 没开 Edge 就自己开一个；已经开着就直接用，不重复开窗
2. **核对身份** —— 读页面上的 `meta[name=current-user]`，确保当前登录的是你自己的账号；不是你，就切回来
3. **读完整栋楼** —— 论坛把全部楼层一次性注进页面变量，她直接问页面要，不受「只看到第一页」限制
4. **看图** —— 把最近几层的图片压成缩略图，这样她真的能看见，而不是只拿到一串地址
5. **回来汇报** —— 然后由她自己决定说什么、要不要回复某一层
6. **关窗** —— 说完最后一句，把窗口收掉

她也可以被单独调用：读帖（`visit`）、发回复（`reply`）、看状态（`status`）。

---

## 安装

### 前置条件

| 需要 | 说明 |
|---|---|
| DeepSeek Harness（桌面端） | 插件宿主 |
| [BrowserSkill CLI](https://github.com/Tencent/BrowserSkill)（`bsk`） | 驱动浏览器，本插件通过它干活 |
| BrowserSkill 浏览器扩展 | 装在 Edge 里，负责让 bsk 连上浏览器 |
| Edge | 默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |

`bsk` 会自动在「插件设置里的 `bskPath` → PATH → `~/.local/bin/`」依次查找，装在哪里都行。

### 装插件

把本目录放到你希望的位置，然后在 DSH profile 里以本地链接方式安装：

```bash
# 在 DSH profile 目录下
pnpm add link:<本目录绝对路径>
```

再在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`，重启 DSH 即可。

---

## 代码结构

`index.js` 只负责插件入口（注册工具、命令、设置页路由），具体逻辑按职责拆在 `lib/` 里：

```
index.js          插件入口：inject / apply
lib/
├── config.js     路径、默认设置、BUILD 标记
├── util.js       sleep / errText / lossless / todayKey / readJson / writeJson / noteDiag
├── bsk.js        bsk 调用层：runBsk / runCmd / 守护进程 / resolveBsk / 浏览器列表
├── browser.js    Edge 拉起、告示页、三种关窗策略（leaveBrowser）
├── session.js    会话与页面操作：bskPage / navigate / observe / click / fill
├── floors.js     楼层读取、页码定位注入体、缩略图
├── anchor.js     镇楼锚点：快照比对与更新检测
├── identity.js   身份核对与切换（以 meta[name=current-user] 为准）
├── settings.js   设置读写 + /api/spixii-forum/settings 路由
├── visits.js     出门留痕、频率闸门、唤醒消息
└── flows.js      共用流程：openForum / runVisit / runReply
```

拆分原则：**逻辑一字未改，只是搬家**。模块间无循环依赖，每个模块只导入它真正用到的名字。

---

## 配置

首次运行**不需要手动建配置文件**。插件会用内置默认值，你只管在设置页里改。

设置有两个等价入口：

- **设置页**：设置 → 鲸鲸逛论坛（推荐，改完点保存就生效）
- **对话里**：`spixii_forum({action:"settings", patch:{...}})`

设置存放在：

```
%USERPROFILE%\.dsh\spixii-forum\settings.json
```

⚠️ **这个文件里有你的论坛密码（如果你填了）**。它只在本地读写，接口不会把它送回页面，也**绝不要提交到 git**（`.gitignore` 已排除）。

### 主要设置项

| 项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后 `visit` / `reply` 直接拒绝 |
| `forumHome` | `http://spixii.cn/` | 论坛首页 |
| `topicUrl` | `http://spixii.cn/topics/31` | 默认主题页 |
| `mention` | `''` | 回复里想 @ 的人（不带 @），留空就不 @ |
| `account` | `''` | 你自己的论坛账号名，用于核对身份 |
| `password` | `''` | 论坛密码，只在发现没登录时用一次；不填就靠浏览器里的登录态 |
| `everyDays` | `1` | 距今至少几天才允许再去；`1` = 每天都可以 |
| `maxPerDay` | `3` | 每天最多去几次；`0` = 不限 |
| `autoPost` | `true` | 是否允许自动提交回复；关掉后只能看不能说 |
| `waitDaemonMs` | `25000` | 拉起守护进程后最多等多久（毫秒） |

> 新用户拿到的是这份默认值：`mention` 和 `account` **故意留空**，因为插件是开源的，默认值里填任何人的 ID 都会让所有人默认去 @ 那个人。

---

## 用法

### 斜杠命令

```
/homeland
/homeland 今天想聊聊训练的事
```

命令名必须**全小写**（大写会被宿主拒绝注册）。

跑完之后，她会被唤醒并主动说话 —— 汇报见闻、决定要不要回复别人。这是「跟人说话」，不是交作业，所以她也可以选择只说两句、或者不说话。

### 工具调用

```js
spixii_forum({ action: 'visit' })                    // 逛一趟，读楼层
spixii_forum({ action: 'visit', tail: 10 })          // 只看最近 10 层
spixii_forum({ action: 'visit', sinceFloor: 250 })   // 只看 #250 之后的新内容
spixii_forum({ action: 'reply', text: '...' })       // 普通发言
spixii_forum({ action: 'reply', text: '...', replyTo: 249 })  // 回复 #249
spixii_forum({ action: 'status' })                   // 看状态
spixii_forum({ action: 'leave' })                    // 关窗收工
spixii_forum({ action: 'settings' })                 // 读当前设置
spixii_forum({ action: 'ensure' })                   // 只保证守护进程在跑
spixii_forum({ action: 'probe', args: ['status','--json'] })  // 跑一条 bsk 命令排查
```

**`reply` 的正文支持 Markdown** —— 论坛原生渲染：`**粗体**`、`*斜体*`、`` `行内代码` ``、`- 列表`、`> 引用`、`[文字](链接)`、`## 小标题` 都有效。

### 关于 `replyTo`

- **自己发言**：只传 `text`，**不要**带 `replyTo` —— 带了就变成「回复某个人」
- **接别人的话茬**：才传 `replyTo: 楼层号`

---

## 浏览器窗口是怎么管的

这是本插件花最多功夫的地方，说清楚免得你被吓到：

**Edge 本来就开着** → 只借用它建一个 Agent Window，逛完只关这个窗口，**你自己的浏览器完好无损**。

**Edge 没开** → 插件会把它拉起来，并先显示一个告示页：

> 🐋 **鲸鲸正在逛论坛**
> 这个窗口是她出门用的，开着就说明她还在路上。
> 请先别在这里操作，也别关掉它 —— 会打断她。

逛完之后：

- 你**没碰过**这个浏览器 → 连进程带窗口一起收干净，**桌面不留任何东西**
- 你**中途开了别的页面** → 只关 Agent Window，**你开的页面留着**

> 判定依据是 bsk 的 `tab list --scope user`：把用户标签页列出来，去掉我们那张告示页，还剩东西就说明你动过。不靠窗口标题猜。

**静默浏览**：Agent Window 用 `--no-focus` 打开，不抢你焦点。

---

## 故障排查

先看状态：

```js
spixii_forum({ action: 'status' })
```

它会告诉你 bsk 在哪、守护进程在不在跑、浏览器连了几个。任何一步失败，报错都会说清**卡在哪一步**：

| 步骤 | 含义 |
|---|---|
| `bsk-missing` | 找不到 bsk，报错里会列出查过的每个路径 |
| `daemon` | 守护进程拉不起来 |
| `edge-running-no-ext` | Edge 开着，但 browser-skill 扩展没连上 → 点一下浏览器工具栏的扩展图标 |
| `edge-launch` | Edge 本身拉不起来 |
| `browser-wait` | Edge 起来了，但扩展在 20 秒内没连上 |
| `session` | 建浏览器会话失败 |
| `navigate` | 论坛打不开 |
| `gate` | 被频率限制或 `autoPost=false` 挡住了 |

**守护进程空闲约 10 分钟会自己退出**，这是设计行为不是崩溃 —— 下次出门会自动再拉起。

想看详细日志：

```
%USERPROFILE%\.dsh\spixii-forum\diag.log      # 插件诊断
%USERPROFILE%\.bsk\daemon.log.YYYY-MM-DD      # bsk 守护进程
```

`spixii_forum({action:'pruneLogs'})` 可以清理体积过大的旧访问记录。

---

## 数据放在哪

全部在你本机，不上传任何地方：

```
%USERPROFILE%\.dsh\spixii-forum\
├── settings.json     # 设置（可能含密码，勿提交）
├── state.json        # 访问计数、上次时间、当前拉起的 Edge 记录
├── Anchor.json       # 镇楼内容快照，用于检测更新
├── visits\           # 每次出门的轻量摘要（不存楼层原文）
├── Temp\             # 看图的临时缩略图，每次出门前清空
└── away.html         # 「鲸鲸出门了」告示页
```

---

## 已知限制

- **只在桌面端测试过**，见开头的声明
- 站点的分页固定每页 20 楼，插件按「存活序号」算页码（删楼会导致楼层号与页序脱节）
- 整层截图不可行，看图走的是页面内 canvas 压缩
- `commands` 服务没有列表接口，命令注册是否成功只能听日志或亲自敲一次
- 守护进程不能在受限沙箱里自行启动（Job Object 限制），必须由宿主进程拉起

---

## 许可

MIT，见 [LICENSE](LICENSE)。
