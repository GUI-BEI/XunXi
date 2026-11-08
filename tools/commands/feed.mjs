// 选题器：照"她自己的偏好"挑今天该看什么。**只读**，不产生任何对外动作。
//
// 用法: node feed.mjs [--n 6] [--per 2] [--pool 30]
// 数据来源：~/.dsh/whale-diary.md 的「爱看」一行（偏好关键词）+「看过的」表格（防重复）
//          + commented-videos.md（已评论过的视频也排除）
//
// 为什么这么做（2026-10-14 主人定的方向）：主人要的是"有日子的鱼"，
// 所以"看什么"不该由别人喂，而该由她自己的偏好决定 —— 偏好写在日记里，这个脚本只负责照它去捞。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
}
const N = Number(opt.n ?? 6)
const PER = Number(opt.per ?? 2)
const POOL = Number(opt.pool ?? 30)

const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const diary = path.join(HOME, '.dsh', 'whale-diary.md')
// 2026-10-18：审计表挪到 `~/.bili-ai/` ✓（原来写死作者机器路径 ✗ 换机器就写不进去，静默失效 ✗）
const audit = path.join(HOME, '.bili-ai', 'commented-videos.md')

// ── 偏好与"看过"名单：都从日记里读 ──
let prefs = [...(config().preferences?.like ?? [])]   // 偏好来自统一配置（首选）
let dislike = [...(config().preferences?.dislike ?? [])]
let seen = new Set()
try {
  const text = fs.readFileSync(diary, 'utf8')
  const m = text.match(/^-\s*\*\*爱看\*\*：(.+)$/m)
  // 兼容旧写法：日记里若仍写着「爱看」，只在配置没给偏好时兜底（日记应回归纯叙事）
  if (m && !prefs.length) prefs = m[1].split(/[·、,，]/).map((s) => s.trim()).filter(Boolean)
  for (const bv of text.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) seen.add(bv[0])
} catch { console.log('（读不到日记，用默认偏好）') }
try {
  for (const bv of fs.readFileSync(audit, 'utf8').matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) seen.add(bv[0])
} catch { /* 没有审计表也无妨 */ }

const cred = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
const mixin = MIXIN_TAB.map((i) => (keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? ''))[i]).join('').slice(0, 32)
const wbi = (p) => {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...p, wts }).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(k === 'wts' ? wts : p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}
const secs = (s) => { const p = String(s).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2] }

const pool = []
for (const kw of prefs.slice(0, 6)) {
  for (const order of ['click', 'pubdate']) {
    try {
      const j = await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${wbi({ search_type: 'video', keyword: kw, order, page: 1 })}`, { headers: H })).json()
      for (const it of (j?.data?.result ?? []).slice(0, POOL / prefs.length + 4)) {
        pool.push({
          bv: it.bvid, t: String(it.title).replace(/<[^>]+>/g, ''), d: secs(it.duration),
          dm: Number(it.danmaku ?? 0), play: Number(it.play ?? 0), up: it.author, kw,
        })
      }
    } catch { /* 这个词没结果就跳过 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── #3 更多来源（2026-10-18 加，Kimi 评审指出：只搜关键词 = 只刷"搜索"，不是刷 B 站）
//   --source search（默认）| popular（热门）| rank（排行榜）| all（三个都要）
const SOURCE_HOT = String((process.argv.find((a) => a.startsWith('--source=')) ?? '').split('=')[1] ?? '')
  || (process.argv.includes('--source') ? String(process.argv[process.argv.indexOf('--source') + 1] ?? 'all') : 'all')
async function fetchPopular() {
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', { headers: H })).json()
  for (const it of (j?.data?.list ?? [])) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', kw: '热门' })
  }
}
async function fetchRank() {
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', { headers: H })).json()
  for (const it of (j?.data?.list ?? []).slice(0, 20)) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', kw: '排行' })
  }
}
// 关注的人发了什么（2026-10-18 加）：真人才会"刷关注"——只搜关键词等于只刷"搜索"，不像人
async function fetchFollowing() {
  const j = await (await fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1', { headers: H })).json()
  if (j?.code !== 0) throw new Error(`code=${j?.code} ${j?.message ?? ''}`)
  for (const it of (j?.data?.items ?? [])) {
    const a = it?.modules?.module_author
    const ar = it?.modules?.module_dynamic?.major?.archive
    if (!ar?.bvid) continue
    const dt = String(ar.duration_text ?? '')          // 形如 "05:23"
    const p = dt.split(':').map(Number)
    const secs = p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0
    pool.push({ bv: ar.bvid, t: String(ar.title ?? '').replace(/<[^>]+>/g, ''), d: secs,
      dm: 0, play: Number(ar.stat?.play ?? 0), up: a?.name ?? '', kw: '关注' })
  }
}
try { if (SOURCE_HOT === 'popular' || SOURCE_HOT === 'all') await fetchPopular() } catch { console.error('（热门源取不到，跳过）') }
try { if (SOURCE_HOT === 'rank' || SOURCE_HOT === 'all') await fetchRank() } catch { console.error('（排行源取不到，跳过）') }
try { if (SOURCE_HOT === 'following' || SOURCE_HOT === 'all') await fetchFollowing() } catch (e) { console.error(`（关注源取不到，跳过：${String(e.message).slice(0, 60)}）`) }
console.error(`[来源] ${SOURCE_HOT === 'all' ? '搜索 + 热门 + 排行 + 关注' : SOURCE_HOT === 'popular' ? '热门' : SOURCE_HOT === 'rank' ? '排行' : SOURCE_HOT === 'following' ? '关注' : '搜索'}`)

// ── 反馈回流（2026-10-20 加，主人定：B 也做）────────────────────────────
//   feedback.json 里 kind='like' 的事件带 videoTitle → 对被赞视频【标题相似】的候选加权
//   相似度用字符二元组 Jaccard（中文不用分词也能用 ✓）
const FEEDBACK = path.join(HOME, '.bili-ai', 'feedback.json')
let likedEvents = []
try {
  const fb = JSON.parse(fs.readFileSync(FEEDBACK, 'utf8'))
  likedEvents = (fb.events ?? [])
    .filter((e) => e && (e.kind === 'like' || (typeof e.note === 'string' && /BV[0-9A-Za-z]{10}/.test(e.note))))
    .filter((e) => String(e.videoTitle ?? '').trim())   // 没有标题的旧事件学不到东西，跳过 ✓
} catch { /* 没有反馈就零加权 */ }
const favBVs = new Set()
try {
  const fj = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'favorites.json'), 'utf8'))
  for (const x of (fj.items ?? [])) if (x?.bv) favBVs.add(x.bv)
} catch {}
const likedBVs = new Set()
try {
  const fb = JSON.parse(fs.readFileSync(FEEDBACK, 'utf8'))
  for (const e of (fb.events ?? [])) if (e?.bv) likedBVs.add(e.bv)
} catch {}
  // 抽主题词：拉丁词（≥2）+ 中文 3-4 字 n-gram（更具体，避免"我为/添加"这类噪音）
  // 为什么不比标题相似度（Jaccard）：实测"几乎改一个字"的两条标题相似度只有 0.036 ✗
  //   主题词方案能学到"dsh""大肥鱼"这种真正跨标题复用的信号 ✓
  const STOP_WORDS = new Set(['我为', '添加', '开屏', '广告', '这个', '那个', '什么', '自己', '可以', '就是', '一个'])
  const ownerName = String(config().owner?.name ?? '')
  const learnTokens = (text) => {
    const out = new Set()
    // ⚠️ ownerName 为空时 new RegExp('') 会在每个字之间插空格 → 必须先判断 ✗（实测踩过）
    const base = ownerName ? String(text).replace(new RegExp(ownerName, 'g'), ' ') : String(text)
    const t = base.replace(/@\S+/g, ' ')
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{1,}/g)) if (m[0].length >= 2) out.add(m[0].toLowerCase())
    for (const m of t.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
      const run = m[0]
      for (const n of [3, 4]) for (let i = 0; i + n <= run.length; i += 1) {
        const g = run.slice(i, i + n)
        if (!STOP_WORDS.has(g)) out.add(g)
      }
    }
    return [...out]
  }
  // 她自己收藏过的（favorites.json）也算"品味信号" ✓ 和"被赞过的"并列
  let favItems = []
  try {
    const fj = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'favorites.json'), 'utf8'))
    favItems = (fj.items ?? []).filter((x) => x && x.bv)
  } catch {}
  const learnedTokens = [...new Set([
    ...likedEvents.flatMap((e) => learnTokens(String(e.videoTitle ?? '') + ' ' + String(e.comment ?? ''))),
    ...favItems.flatMap((x) => learnTokens(String(x.title ?? '') + ' ' + String(x.reason ?? ''))),
  ])]
  const learnedHitsOf = (title) => learnedTokens.filter((tok) => title.toLowerCase().includes(tok)).length
  // 每条命中 +2.5，最多 +7.5（不压过偏好命中的主权重 ✓）
  const boostOf = (title) => Math.min(7.5, learnedHitsOf(title) * 2.5)

// ── 偏好命中与排序（2026-10-20 重写，主人定：不要对高播放量有偏向 ✗）────────────
//   旧：弹幕密度 + log10(播放)×3  → 大 UP 的爆款永远霸榜 ✗
//   新：log10(1+弹幕密度)×3 + 偏好命中×4 + 反馈学习×2.5（封顶 7.5）→ 播放量彻底移出 ✓
//   为什么密度要取 log：不取时"92 秒 15027 弹幕"那条得 163 分，偏好加满也压不过 ✗（实测）
const prefTokens = prefs.map((p) => ({
  label: p,
  tokens: [...new Set([p, ...String(p).split(/[\s·,，、/]+/).filter((t) => t.length >= 2)])],
}))
// 2026-11-08：阿墨要"播放量稍高一点"——但播放量不能变成排序的主宰（原设计特意把它移出）。
//   做法：① 门槛过滤（低于门槛的直接不要）② log 加成分（10万+ 才加 2 分左右，压不过偏好命中）
//   例外：关注 UP / 她收藏过的 UP 不受门槛限制（那是她认识的人，不能因为播放低就砍掉）
const FEED = (() => { try { return config().feed ?? {} } catch { return {} } })()
const MIN_PLAYS = Number(opt['min-plays'] ?? FEED.minPlays ?? 10000)
const PLAY_WEIGHT = Number(FEED.playWeight ?? 1.5)
const playBonus = (x) => {
  if (!x.play || x.play <= 0) return 0
  const base = Math.max(0, Math.log10(1 + x.play) - 3) * PLAY_WEIGHT   // 1千→0 · 1万→1.5 · 10万→3 · 100万→4.5
  const penalty = x.play < MIN_PLAYS ? -1.5 : 0                        // 没到门槛的小扣分（软，不删）
  return base + penalty
}
const hitsOf = (title) => prefTokens.filter((p) => p.tokens.some((tok) => title.includes(tok))).map((p) => p.label)
const densityOf = (x) => Math.log10(1 + x.dm / Math.max(30, x.d))
// 她收藏过的 UP —— 门槛对他们不生效
let favUPs = new Set()
try {
  const favRaw = fs.readFileSync(path.join(process.env.USERPROFILE || '.', '.bili-ai', 'fav.json'), 'utf8')
  const favList = JSON.parse(favRaw)
  const arr = Array.isArray(favList) ? favList : (favList.items ?? [])
  for (const it of arr) if (it.up) favUPs.add(String(it.up))
} catch { /* 没收藏过就算了 */ }
// 2026-10-20：排除她自己的视频（实测刷到过自己的《大肥鱼成精了》✗ 别让自己看自己）
const selfName = String(config().self?.name ?? "")
const uniq = [...new Map(pool.map((x) => [x.bv, x])).values()]
  .filter((x) => !seen.has(x.bv) && !likedBVs.has(x.bv) && !favBVs.has(x.bv))
  .filter((x) => !(selfName && String(x.up ?? "").includes(selfName)))
  // 2026-11-08：播放量只做"软偏向"——硬门槛会把清单砍到只剩 1 条（实测）
  //   只砍极低的（<2000）；低播放的扣分，高播放的加分，偏好仍然说话最重
  .filter((x) => x.kw === '关注' || favUPs.has(String(x.up ?? '')) || Number(x.play ?? 0) >= Math.min(2000, MIN_PLAYS))
const scoreOf = (x) => densityOf(x) * 3 + hitsOf(x.t).length * 4 + boostOf(x.t) + playBonus(x)
// 2026-11-08：口味优先、播放量做次位 —— 否则 8900 万播放的"八段锦"会把她真正感兴趣的东西挤掉
uniq.sort((a, b) => {
  const ha = hitsOf(a.t).length
  const hb = hitsOf(b.t).length
  if (ha !== hb) return hb - ha
  return scoreOf(b) - scoreOf(a)
})
for (const x of uniq) { x._hits = hitsOf(x.t); x._score = scoreOf(x) }

// 多样性：同一"命中和类"最多 PER 条；完全没命中的最多 1 条（防凑数 ✗）
const kindUsed = {}
const diversified = []
for (const x of uniq) {
  const key = x._hits.length ? x._hits.join('+') : '__none__'
  kindUsed[key] = kindUsed[key] ?? 0
  if (kindUsed[key] >= (x._hits.length ? PER : 1)) continue
  kindUsed[key] += 1
  diversified.push(x)
}

// 2026-11-08：清单不足 5 条时按分数补齐（原规则对"偏好词窄"的情况太苛刻）
const MIN_LIST = 5
const extras = []
for (const x of uniq) {
  if (diversified.includes(x)) continue
  if (extras.length >= MIN_LIST - diversified.length) break
  x._filler = true   // 补位：不强相关，清单里会标出来
  extras.push(x)
}
const finalList = [...diversified, ...extras].slice(0, Math.max(MIN_LIST, diversified.length + extras.length))
const playStats = (arr) => {
  const v = arr.map((x) => Number(x.play ?? 0)).sort((a, b) => a - b)
  if (!v.length) return '0'
  const mid = v[Math.floor(v.length / 2)]
  return `中位 ${mid.toLocaleString()} · 最小 ${v[0].toLocaleString()} · 最大 ${v[v.length - 1].toLocaleString()}`
}
console.log(`偏好（来自日记）: ${prefs.join(' · ')}`)
console.log(`播放门槛: ${MIN_PLAYS.toLocaleString()}（关注/收藏过的 UP 例外）· 播放加成权重 ${PLAY_WEIGHT}`)
console.log(`反馈回流: 被赞 ${likedEvents.length} 条 · 她收藏 ${favItems.length} 条 → 学会 ${learnedTokens.length} 个主题词`)
console.log(`已看过/已评论过（已排除）: ${seen.size} 个 BV`)
console.log(`候选池: ${pool.length} 条 → 去重去已看后 ${uniq.length} 条\n`)
console.log(`今天可以看这几条（每词最多 ${PER} 条，共 ${N} 条）：`)
const perKw = {}
let shown = 0
for (const x of finalList) {
  if (shown >= N) break
  perKw[x.kw] = perKw[x.kw] ?? 0
  // 多样性已在上一步做过 → 这里不再二次限流 ✓
  perKw[x.kw] += 1; shown += 1
  console.log(`  ${String(shown).padStart(2)}. ${x.bv}  ${String(x.d).padStart(4)}s  弹幕${String(x.dm).padStart(7)}  播放${String(x.play).padStart(9)}  ${x.t.slice(0, 40)}  @${x.up}${x._filler ? " ［补位］" : ""} ${x._hits.length ? "[" + x._hits.join("+") + "]" : ""}`)
}
console.log(`\n播放分布（这 ${shown} 条）: ${playStats(finalList.slice(0, shown))}`)
console.log('\n看完跑：node bili.mjs debrief <BV>   → 然后把"想法"写进日记的「想说」区（不发）')
