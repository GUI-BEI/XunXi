// 词表体检（2026-11-27）——只读，不改任何东西
//   node scripts/audit-prefs.mjs
// 复刻 feed.mjs 的学习逻辑，把 learnedTokens 摊开看：词都从哪来、像不像口味
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || '.'
const DSH = path.join(HOME, '.dsh')
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }

const cfg = readJson(path.join(DSH, 'bili-whale.config.json'), {})
const ownerName = String(cfg.owner?.name ?? '')
const prefs = [...(cfg.preferences?.like ?? [])]

const STOP_WORDS = new Set(['我为', '添加', '开屏', '广告', '这个', '那个', '什么', '自己', '可以', '就是', '一个'])

function learnTokens(text) {
  const out = new Set()
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

const fb = readJson(path.join(HOME, '.bili-ai', 'feedback.json'), { events: [] })
const likedEvents = (fb.events ?? [])
  .filter((e) => e && (e.kind === 'like' || (typeof e.note === 'string' && /BV[0-9A-Za-z]{10}/.test(e.note))))
  .filter((e) => String(e.videoTitle ?? '').trim())

const favItems = (readJson(path.join(HOME, '.bili-ai', 'favorites.json'), { items: [] }).items ?? []).filter((x) => x && x.bv)

const sources = [
  ...likedEvents.map((e) => ({ kind: 'like', title: String(e.videoTitle ?? ''), comment: String(e.comment ?? ''), words: learnTokens(String(e.videoTitle ?? '') + ' ' + String(e.comment ?? '')) })),
  ...favItems.map((x) => ({ kind: 'fav', title: String(x.title ?? ''), comment: String(x.reason ?? ''), words: learnTokens(String(x.title ?? '') + ' ' + String(x.reason ?? '')) })),
]

const all = new Set(sources.flatMap((s) => s.words))
const freq = new Map()
for (const s of sources) for (const w of s.words) freq.set(w, (freq.get(w) ?? 0) + 1)

console.log(`素材：${sources.length} 条（like ${likedEvents.length} · 收藏 ${favItems.length}）`)
console.log(`词表：${all.size} 个（学习逻辑：中文取 3–4 字连续片段 + 英文词）`)
console.log(`平均每条素材贡献 ${(sources.length ? (all.size / sources.length) : 0).toFixed(1)} 个词\n`)

// 来源逐条
console.log('每条的贡献：')
for (const s of sources) console.log(`  [${s.kind}] ${s.words.length.toString().padStart(2)} 词 · ${s.title.slice(0, 46)}`)

// 与配置词的重叠
const overlap = prefs.filter((p) => all.has(p) || [...all].some((w) => w.includes(p.toLowerCase()) || p.includes(w)))
console.log(`\n与配置词（${prefs.join(' / ')}）有交集的：${overlap.length ? overlap.join('、') : '（没有）'}`)

// 长度分布
const lenDist = {}
for (const w of all) lenDist[w.length] = (lenDist[w.length] ?? 0) + 1
console.log('词长分布：', Object.entries(lenDist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}字 ${v}`).join(' · '))

// 真正像"话题"的：出现在 ≥2 条素材里（跨视频复现）
const repeated = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
console.log(`\n跨 ≥2 条素材复现的词：${repeated.length} 个`)
console.log('  ' + repeated.slice(0, 20).map(([w, n]) => `${w}(${n})`).join(' · '))

// 单条出现的（多为碎片）
const single = [...all].filter((w) => (freq.get(w) ?? 0) === 1)
console.log(`\n只在 1 条里出现的词：${single.length} 个（占 ${Math.round((single.length / all.size) * 100)}%）`)
console.log('  抽样：' + single.slice(0, 24).join(' · '))
