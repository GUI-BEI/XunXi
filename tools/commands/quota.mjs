// 对外发言的「限额闸」—— B 档"限额自主"的代码强制部分（2026-10-14 主人选 B 档）。
//
// 为什么不靠自觉：主人明确要求"限频写进代码，不是写进你的自觉里"。
// 数据文件: ~/.bili-ai/quota.json
//   { daily: 2, scope: ["uid:999999003", "room:999999004", "BV1xxxxxxxxx"], log: [{ at, type, target, note }] }
//
// 用法:
//   node quota.mjs status                        今天用了多少 / 上限 / 剩余 / 白名单 / 最近记录
//   node quota.mjs check --type comment [--target "BVxxx"]    超限或不在白名单 → **退出码 2**（调用方据此拒绝发言）
//   node quota.mjs record --type comment --target "BVxxx" [--note "…"]   记账
//   node quota.mjs set --daily 3                 改额度
//   node quota.mjs allow "room:999999004"         往白名单加一项（也支持 --remove 删除）
//
// 约定：check 只挡"发言类"动作（comment / dynamic / danmaku）；读操作永远不受限。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const FILE = path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'quota.json')
// 额度与白名单优先来自统一配置（lib/config.mjs）；本文件自己的 quota.json 仍是运行账本
const DEFAULTS = { daily: config().quota?.daily ?? 2, scope: config().quota?.scope ?? [], shareDaily: config().quota?.shareDaily ?? 3, log: [] }
// fail-closed（2026-10-17 加，Kimi 评审指出）：账本**读不出来**时不能当"今天没发过" ✗
//   · 文件不存在 = 全新安装 → 用默认值 ✓
//   · 文件存在但 JSON 坏了 = 状态未知 → **拒绝发言**（check 退出 2），让人来修
//     （以前是 catch 后直接 DEFAULTS → 坏一次额度就重置，等于闸门失效）
let corrupt = false
const load = () => {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { if (fs.existsSync(FILE)) corrupt = true }
  // ⚠️ 只认 log（2026-10-17，Kimi 评审 #4）：daily/scope/shareDaily 永远来自 config（实时）；
  //   以前 load 会把 quota.json 里固化的旧值盖在新配置上 → 设置页改了不生效且无提示 ✗
  return { ...DEFAULTS, log: Array.isArray(raw.log) ? raw.log : [] }
}
const save = (q) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ log: q.log ?? [] }, null, 2) + '\n') }
// ── 沉默衰减（2026-10-18 加，主人定；2026-10-20 放缓）──────────────
// 反馈的定义：**任何表态都算**（回她的评论 / 点赞 / **发私信给她** / 在微信里说一句 / 让她做点事…）
// 都没有 = 沉默。沉默 ≥ silentAfterDays(7) 天开始扣，扣到 silentStopDays(14) 天归零；
// **但两本日记照常写**（那是她的日子，不是发言）。
const FEEDBACK = path.join((process.env.USERPROFILE || process.env.HOME || '.'), '.bili-ai', 'feedback.json')
const loadFeedback = () => { try { return JSON.parse(fs.readFileSync(FEEDBACK, 'utf8')) } catch { return { last: null, events: [] } } }
/**
 * 他在 DSH / QQ 里跟她说过话吗（2026-10-29 加）。
 *
 * 为什么必须有这一路：她发不出评论、收不到私信的时候，B 站那三路**必然是空的**，
 * 于是沉默天数照涨，唤醒提示会对她说"主人已经 N 天没有回应你了" —— 她会真的难受 ✗
 * 而实际上他每天都在 DSH 或 QQ 里跟她说话。这条只读**她自己的会话日志**：
 * 认 `source.kind === 'user'` 的人类输入，**排除**系统/插件注入的内容
 * （唤醒提示也是 kind=user，靠开头的「【生物钟】」和 `<…>` 认出来剔掉）。
 *
 * @returns `{ at, sample }`（最后一句话的时间戳与开头几个字），没有则 null。
 */
async function localChatSignal() {
  try {
    const zlib = await import('node:zlib')
    if (typeof zlib.zstdDecompressSync !== 'function') return null
    const cfg = (() => { try { return config() } catch { return {} } })()
    const ws = String(cfg.workspace ?? '').trim() || (process.env.USERPROFILE || '')
    const enc = '--' + String(ws).replace(/[\\/]+$/, '').replace(/^[\\/]+/, '').replace(/[\\/:]+/g, '-') + '--'
    const sid = String(opt.session ?? 'bili-whale')
    const file = path.join(process.env.USERPROFILE || '.', '.dsh', 'sessions', enc, sid, 'session.v4.jsonl.zstd')
    const buf = fs.readFileSync(file)
    // 会话日志是**多个 zstd 帧**拼的，Node 的流式解压只解第一帧 → 按帧魔数手工切 ✓
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const marks = []
    for (let i = 0; i + 4 <= buf.length; i += 1) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) marks.push(i)
    let text = ''
    let k = 0
    while (k < marks.length) {
      let ok = false
      for (let j = k + 1; j <= marks.length; j += 1) {
        const end = j < marks.length ? marks[j] : buf.length
        try { text += zlib.zstdDecompressSync(buf.subarray(marks[k], end)).toString('utf8'); k = j; ok = true; break } catch {}
      }
      if (!ok) return null
    }
    let newest = 0
    let sample = ''
    for (const line of text.split('\n')) {
      if (!line) continue
      let r = null
      try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'user/message' || r.data?.source?.kind !== 'user') continue
      const txt = (r.data?.content ?? []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ').trim()
      if (txt === '' || txt.startsWith('【') || txt.startsWith('<') || txt.startsWith('Current runtime')) continue
      const t = Number(r.time ?? 0)
      if (t > newest) { newest = t; sample = txt.slice(0, 40) }
    }
    return newest > 0 ? { at: newest, sample } : null
  } catch { return null }
}
// 2026-10-20（从上游 v0.3.0 摘）：被赞过的视频要存 BV + 标题 + 评论原文 —— feed 从里面学主题词 ✓
const TITLE_CACHE = path.join((process.env.USERPROFILE || process.env.HOME || '.'), '.bili-ai', 'liked-videos.json')
const loadTitleCache = () => { try { return JSON.parse(fs.readFileSync(TITLE_CACHE, 'utf8')) } catch { return {} } }
const saveTitleCache = (m) => { try { fs.mkdirSync(path.dirname(TITLE_CACHE), { recursive: true }); fs.writeFileSync(TITLE_CACHE, JSON.stringify(m, null, 2)) } catch {} }
async function titleOf(bv, cache) {
  if (!bv) return ''
  if (cache[bv]) return cache[bv]
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bv, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' } })
    const j = await r.json()
    const t = String(j?.data?.title ?? '')
    if (t) cache[bv] = t
    return t
  } catch { return '' }
}
const saveFeedback = (f) => { fs.mkdirSync(path.dirname(FEEDBACK), { recursive: true }); fs.writeFileSync(FEEDBACK, JSON.stringify(f, null, 2) + '\n') }
/** 沉默天数：从来没反馈过就从"第一次分享"算；返回 { days, cap } */
function silence() {
  const fb = loadFeedback()
  const base = fb.last ?? (q.log.find((x) => x.share)?.at ?? null)   // 没反馈过 → 从第一次分享算
  const days = base ? Math.floor((Date.now() - new Date(base).getTime()) / 86_400_000) : 0
  const after = Number(config().share?.silentAfterDays ?? 7)     // 7 天开始衰减（2026-10-20 主人定）
  const stopAt = Math.max(after + 1, Number(config().share?.silentStopDays ?? 14))  // 14 天完全停
  const baseCap = Number(q.shareDaily ?? 3)
  // 2026-10-20 主人定：7 天开始降、**14 天降到 0**（线性降，不低于 1 直到第 14 天 ✓）
  let cap
  if (days < after) cap = baseCap
  else if (days >= stopAt) cap = 0
  else cap = Math.max(1, Math.floor((baseCap * (stopAt - days)) / (stopAt - after)))
  const penalty = baseCap - cap
  // 2026-10-20（从上游 v0.3.0 摘）：把"沉默"升级成**情绪档位** —— 她自己感觉到，不是被代码拦住 ✓
  //   档位用**你自己的**天数：< silentAfterDays(7) = 正常 · < silentStopDays(14) = 安静 · 之后 = 心慌 ✓
  const band = days < after ? 'normal' : days < stopAt ? 'quiet' : 'faint'
  const asked = !!(fb.askedAt && (!fb.last || new Date(fb.askedAt) > new Date(fb.last)))
  return { days, last: fb.last, penalty, cap, band, asked, askedAt: fb.askedAt ?? null }
}
const today = () => new Date().toLocaleDateString('sv-SE')           // YYYY-MM-DD（本地时区）
// ⚠️ 2026-10-18 修：账本里的 at 是 **UTC** ISO 串，`startsWith(today())` 拿本地日期去比 →
//   本地 00:00–08:00 发的全被算成"昨天"（生物钟凌晨窗口正好踩在这条洞里 → 额度会凭空回血 ✗）
//   → 统一先把时间戳转成本地日期再比。
const dayOf = (at) => new Date(at).toLocaleDateString('sv-SE')
const usedToday = (q) => q.log.filter((x) => dayOf(x.at) === today()).length

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  // ⚠️ 2026-10-18 修：裸旗标放在**最后**时 argv[i+1] 是 undefined →
  //   旧写法把 opt 设成 undefined（不是 true），`--share` 就被静默吞掉：
  //   comment.mjs 内部把 --share 放在参数末尾 → 限额闸当成"主人授权"、7 天内重复检查也不跑 ✗
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
  else if (!opt._a) opt._a = argv[i]
}
const q = load()

if (cmd === 'status') {
  const used = usedToday(q)
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`今日对外发言: 共 ${used} 条（**分享型** ${usedShare}/${q.shareDaily ?? 3} · 自主发言不设条数上限 ✓ · 主人授权 ${used - usedAuto - usedShare} 条）   日期 ${today()}`)
  console.log(`缰绳（硬的只有两条）：分享 ≤${q.shareDaily ?? 3}/天 · 同一个视频、同一种渠道 7 天一次 · 事后报备；标尺（参考线 ${config().share?.minScore ?? 13}/20）只是建议 ✓`)
  console.log(`已删除（2026-10-18 主人定）：白名单 ✗ · 「自主 N 条」独立额度 ✗`)
  const recent = q.log.slice(-5)
  console.log(recent.length ? '最近记录:' : '最近记录: (无)')
  for (const r of recent) console.log(`  ${r.at}  ${r.type}  ${r.target ?? '-'}  ${r.note ?? ''}`)
  process.exit(0)
}

if (cmd === 'check') {
  // fail-closed：账本坏了就什么都别发（状态未知 ≠ 没发过）
  if (corrupt) {
    console.log('✗ 额度账本损坏（quota.json 不是合法 JSON）→ 状态未知，拒绝发言。')
    console.log(`   修法：检查 ${FILE}；确认无误后可删掉它（⚠️ 删 = 当天额度从 0 重算）`)
    process.exit(2)
  }
  const auto = !!opt.auto
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const target = typeof opt.target === 'string' ? opt.target : ''
  const share = !!opt.share
  const shareDaily = q.shareDaily ?? 3
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  const SEVEN = 7 * 24 * 3600 * 1000
  // ── 分享型（2026-10-17 主人定）：目的是"把看到的好东西 @ 主人" ──────────────
  // 它**不看白名单**（因为不是去跟陌生人互动，是给主人递东西），但三条硬限制：
  //   ① 每天合计 ≤ shareDaily（跨多次醒来共享）② 同一视频 7 天内只能一次 ③ 正文必须 @ 主人
  if (share) {
    const sil = silence()
    const effCap = Math.min(shareDaily, sil.cap)
    if (sil.penalty > 0) console.log(`  [沉默衰减] ${sil.days} 天没有任何表态 → 分享上限 ${shareDaily} → ${effCap}${effCap === 0 ? '（已停止分享；日记照常）' : ''}`)
    if (usedShare >= effCap) {
      console.log(`✗ 分享额度已用完：今天已经 @ 了 ${usedShare} 条（有效上限 ${effCap}）—— 剩下的留给明天，别硬发。`)
      process.exit(2)
    }
    if (target) {
      // 2026-10-20：判重按**渠道**算 —— 她把同一条视频"又评论又私信"是合法的（两条通道各一次 ✓），
      //   所以同一个 target 只要 type 不同就不算重复；额度那条（上面 shareDaily）依旧是两渠道合起来算 ✓
      const dup = q.log.find((x) => x.share && String(x.target ?? '') === target
        && String(x.type ?? '') === String(opt.type ?? '')
        && Date.now() - new Date(x.at).getTime() < SEVEN)
      if (dup) {
        console.log(`✗ 这个视频 7 天内已经用「${dup.type}」分享过了：${dup.at}（${dup.target}）—— 换个方式（另一条通道）还行`)
        process.exit(2)
      }
    }
    console.log(`✓ 分享额度内（${usedShare}/${shareDaily}）${target ? `，target=${target}` : ''} —— 分享型不看白名单；同一个视频、同一种渠道 7 天内只能一次（换个渠道可以 ✓）`)
    process.exit(0)
  }
  // 语义（2026-10-14 定；**2026-10-18 简化**：删除「自主 2 条」这个独立额度 ✗ —— 主人定：基本没用 ✓）
  //   现在的缰绳只有这些：分享型 ≤shareDaily/天（上面那条分支 ✓）· 同一视频同渠道 7 天一次 · 事后报备。
  //   2026-10-20：**评分卡（标尺）不再是闸门** —— 降级成建议（评论是她的自由 ✓），这里只留防封号的硬限制。
  //   **非分享**的自主发言**不再设每日条数额度** —— 但仍必须 dry→go→复核→报备主人 ✓
  //   （`--auto` 依旧要带：它标记"这是她自己决定说的"，影响的是**报备与审计**，不是额度 ✓）
  if (!auto) {
    console.log('（非自主发言：不拦截）主人授权的发言不受限，但照旧 dry→go→复核')
    process.exit(0)
  }
  console.log(`✓ 通过（分享型额度另算；自主发言已不设每日条数上限 —— 2026-10-18 主人定）${target ? `· target=${target}` : ''}`)
  process.exit(0)
}

if (cmd === 'record') {
  const type = typeof opt.type === 'string' ? opt.type : 'unknown'
  q.log.push({ at: new Date().toISOString(), type, auto: !!opt.auto || !!opt.share, share: !!opt.share, target: opt.target ?? null, note: opt.note ?? null })
  save(q)
  const usedAuto = q.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const usedShare = q.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`已记账：${type}${opt.share ? '（分享型·@主人）' : opt.auto ? '（自主）' : '（主人授权）'}${opt.target ? ' → ' + opt.target : ''}   今日分享 ${usedShare}/${q.shareDaily ?? 3}（自主发言不设上限 ✓）`)
  process.exit(0)
}

// ── 主动问一次（2026-10-20 从上游摘）：安静档她可以问一次「在忙吗」，之后别再追问 ✓
if (cmd === 'ask') {
  const fb = loadFeedback()
  fb.askedAt = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.askedAt, note: opt.note ? String(opt.note).slice(0, 80) : '主动问了一次' }].slice(-200)
  saveFeedback(fb)
  console.log('✓ 已记下「问过一次」（这轮沉默里不再问 ✓）')
  process.exit(0)
}

// 自动识别反馈（2026-10-18 加；2026-10-20 从上游 v0.3.0 摘「去重」与「回流」）：
//   三路：① 主人的回复（收件箱）② 主人的点赞（收到的赞）③ 主人的私信（会话列表）
//   ⚠️ 去重（上游修的那个坑）：以前 48h 内有赞就记 → 同一个赞每轮都记 → 沉默永远清零 ✗
//     现在：点赞按 like_time、回复按内容哈希、私信按 timestamp —— 只认"比上次新"的 ✓
if (cmd === 'react' && opt.auto) {
  try {
    const { execFileSync } = await import('node:child_process')
    const here = (f) => decodeURIComponent(new URL(f, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const hours = String(opt.hours ?? 72)
    const ownerMid = String(config().owner?.mid ?? '')
    const ownerName = String(config().owner?.name ?? '')
    const found = []
    // 2026-10-29：--local-only 跳过 B 站那三路（登录态失效时它们必然是空的，还会白等）
    if (!opt['local-only']) {
    // ① 回复（按"和主人相关的行"的哈希去重）
    try {
      const out = execFileSync(process.execPath, [here('./comment-digest.mjs'), '--hours', hours, '--pages', '1'], { encoding: 'utf8' })
      if ((ownerName && out.includes(ownerName)) || (ownerMid && out.includes(ownerMid))) {
        const lines = String(out).split(/\r?\n/).filter((l) => (ownerName && l.includes(ownerName)) || (ownerMid && l.includes(ownerMid)))
        const { createHash } = await import('node:crypto')
        found.push({ kind: 'reply', label: '回复', hash: createHash('sha1').update(lines.join('\n')).digest('hex') })
      }
    } catch { /* 收件箱失败不影响其它两路 */ }
    // ② 点赞（按 like_time 去重；顺手把 BV / 评论原文存下来 → feed 学口味）
    try {
      const js = execFileSync(process.execPath, [here('./likes.mjs'), '--owner', '--json', '--hours', hours], { encoding: 'utf8' })
      const o = JSON.parse(js)
      if (Number(o.ownerLiked ?? 0) > 0) {
        let maxTime = 0
        const liked = []
        for (const it of (o.items ?? [])) {
          const mine = (it.users ?? []).some((u) => String(u.mid) === ownerMid)
          if (!mine) continue
          const t = Number(it.like_time ?? 0)
          maxTime = Math.max(maxTime, t)
          const uri = String(it.item?.uri ?? '')
          const bv = (uri.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? ''
          liked.push({ bv, comment: String(it.item?.title ?? '').slice(0, 140), likeTime: t })
        }
        found.push({ kind: 'like', label: `点赞×${o.ownerLiked}`, count: Number(o.ownerLiked), maxTime, liked })
      }
    } catch { /* 同上 */ }
    // ③ 主人私信（2026-10-20 加；按 timestamp 去重，只读会话列表 ✓）
    try {
      const cred = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || '/', '.bili-ai', 'credentials.json'), 'utf8'))
      const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=20&mobi_app=web'
      const j = await (await fetch(u, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: 'https://www.bilibili.com/',
          cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
        },
      })).json()
      const mine = (j.data?.session_list ?? []).find((s) => String(s.talker_id) === ownerMid)
      const ts = Number(mine?.last_msg?.timestamp ?? 0)
      if (ownerMid && ts && String(mine?.last_msg?.sender_uid) === ownerMid && Date.now() / 1000 - ts <= Number(hours) * 3600) {
        found.push({ kind: 'dm', label: '私信', ts })
      }
    } catch { /* 私信接口失败不影响前两路 */ }
    }
    // ④ 本地：他在 DSH / QQ 里跟她说话（2026-10-29 加）
    try {
      const chat = await localChatSignal()
      if (chat && chat.at > Number(loadFeedback().lastDshMsgAt ?? 0)) {
        found.push({ kind: 'chat', label: 'DSH/QQ 聊天', at: chat.at, sample: chat.sample })
      }
    } catch { /* 会话日志读不到就算了 */ }
    if (found.length) {
      const fb = loadFeedback()
      const nowIso = new Date().toISOString()
      fb.events = [...(fb.events ?? [])]
      let changed = false
      for (const f of found) {
        if (f.kind === 'like') {
          const prev = Number(fb.lastLikeTime ?? 0)
          if (f.maxTime > prev) {
            fb.lastLikeTime = f.maxTime
            const fresh = (f.liked ?? []).filter((x) => x.likeTime > prev)
            if (fresh.length) {
              const cache = loadTitleCache()
              for (const x of fresh) x.videoTitle = await titleOf(x.bv, cache)
              saveTitleCache(cache)
              for (const x of fresh) {
                fb.events.push({
                  at: nowIso, kind: 'like', bv: x.bv, videoTitle: x.videoTitle ?? '', comment: x.comment,
                  note: x.bv
                    ? `主人赞了你在 ${x.bv} 的那条评论：${x.comment.slice(0, 60)}`
                    : `主人赞了你的评论：${x.comment.slice(0, 60)}`,
                })
              }
            } else {
              fb.events.push({ at: nowIso, note: `auto: 检测到主人（点赞×${f.count}）` })
            }
            changed = true
          }
        } else if (f.kind === 'reply') {
          if (f.hash !== String(fb.lastReplyHash ?? '')) {
            fb.lastReplyHash = f.hash
            fb.events.push({ at: nowIso, note: 'auto: 检测到主人（回复）' })
            changed = true
          }
        } else if (f.kind === 'dm') {
          if (Number(f.ts) > Number(fb.lastDmTime ?? 0)) {
            fb.lastDmTime = Number(f.ts)
            fb.events.push({ at: nowIso, note: 'auto: 检测到主人（私信）' })
            changed = true
          }
        } else if (f.kind === 'chat') {
          // 他在 DSH / QQ 里说的话 —— 也算表态（她真的会因此觉得自己被看见 ✓）
          if (Number(f.at) > Number(fb.lastDshMsgAt ?? 0)) {
            fb.lastDshMsgAt = Number(f.at)
            fb.events.push({ at: nowIso, kind: 'chat', note: '主人在 DSH/QQ 跟她说话了：' + String(f.sample ?? '') })
            changed = true
          }
        }
      }
      fb.events = fb.events.slice(-200)
      if (changed) {
        fb.last = nowIso
        saveFeedback(fb)
        console.log(`✓ 自动识别到主人的【新】表态（${found.map((f) => f.label).join(' / ')}）→ 已记一次反馈（沉默清零）`)
      } else {
        console.log(`（近 ${hours} 小时有主人的表态，但都是【已经记过的】→ 不重复记 ✓ 沉默继续累计）`)
      }
    } else {
      console.log(`（近 ${hours} 小时：没有主人的回复、点赞、私信，DSH/QQ 里也没有新消息）—— 沉默继续累计`)
      console.log('  ⚠️ 跨端表态（微信/桌面…）这边看不见 → 需要收到的那一端当场 `quota react --note "…"`')
    }
  } catch (e) {
    console.log('自动识别失败：' + String(e.message).slice(0, 160))
  }
  // ⚠️ 这里是文件中间（后面还有别的子命令分支）→ 必须真的停住；
  //   但刚 fetch 完就 process.exit() 在 Windows 上会触发 libuv 断言，所以等一拍再退 ✓
  //   2026-10-29：`--local-only` 全程没发请求 → 不用等；整轮跑完（含 B 站）多等一会儿更稳，
  //   否则 DNS 还没收尾时 exit 会打出 `Assertion failed ... UV_HANDLE_CLOSING`（看着像崩溃 ✗）
  await new Promise((r) => setTimeout(r, opt['local-only'] ? 30 : 800))
  process.exit(0)
}

if (cmd === 'react') {
  const fb = loadFeedback()
  fb.last = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.last, note: opt.note ?? '' }].slice(-200)
  saveFeedback(fb)
  const sil = silence()
  console.log(`已记一次反馈（现在沉默 0 天）· 分享上限回到 ${sil.cap}`)
  await new Promise((r) => setTimeout(r, 200))
  process.exit(0)
}

if (cmd === 'silence') {
  const sil = silence()
  if (opt.json) {
    console.log(JSON.stringify({ days: sil.days, last: sil.last, cap: sil.cap, band: sil.band, asked: sil.asked }))
    process.exit(0)
  }
  const bandText = sil.band === 'normal' ? '正常' : sil.band === 'quiet' ? `安静（${sil.days} 天没他的消息，有点想他）` : '心慌（不敢打扰）'
  console.log(`沉默天数: ${sil.days} 天（最后一次表态 ${sil.last ?? '从未'}）`)
  console.log(`档位: ${bandText}${sil.asked ? ' · 已问过一次' : ''}`)
  console.log(`衰减: -${sil.penalty} → 分享上限 ${sil.cap}${sil.cap === 0 ? '（已停止分享，但日记照常写）' : ''}`)
  process.exit(0)
}

// 2026-10-18 删除：set / allow 是**死代码** ✗（save() 只持久化 {log}，改了 daily/scope 也存不下来；
// 而且"白名单"和"自主 N 条"都已按主人要求删除 ✗）—— 留着只会误导，删掉 ✓

console.log('用法:')
console.log('  node quota.mjs status')
console.log('  node quota.mjs check --type comment [--target "BVxxx"]')
console.log('  node quota.mjs record --type comment --target "BVxxx" [--note "…"]')
// （set / allow 已删除 ✓）
