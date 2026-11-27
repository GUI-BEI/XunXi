// 词表体检（第二段）：这些词在当前候选池里到底命中什么
//   node scripts/audit-prefs2.mjs   （先跑一次 feed --dump 生成 ~/.dsh/feed-dump.json）
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || '.'
const DSH = path.join(HOME, '.dsh')
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }

const cfg = readJson(path.join(DSH, 'bili-whale.config.json'), {})
const ownerName = String(cfg.owner?.name ?? '')
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
const liked = (fb.events ?? []).filter((e) => e && (e.kind === 'like' || (typeof e.note === 'string' && /BV[0-9A-Za-z]{10}/.test(e.note)))).filter((e) => String(e.videoTitle ?? '').trim())
const favs = (readJson(path.join(HOME, '.bili-ai', 'favorites.json'), { items: [] }).items ?? []).filter((x) => x && x.bv)
const tokens = new Set([
  ...liked.flatMap((e) => learnTokens(String(e.videoTitle ?? '') + ' ' + String(e.comment ?? ''))),
  ...favs.flatMap((x) => learnTokens(String(x.title ?? '') + ' ' + String(x.reason ?? ''))),
])
const prefs = [...(cfg.preferences?.like ?? [])]

const rows = readJson(path.join(DSH, 'feed-dump.json'), null)
if (!rows) { console.error('没有 feed-dump.json —— 先跑：node bili.mjs feed --dump --n 1'); process.exit(2) }

console.log(`候选池 ${rows.length} 条 · 学习词 ${tokens.size} 个 · 配置词 ${prefs.length} 个\n`)

const hitCount = new Map()
for (const r of rows) {
  const title = String(r.t ?? '').toLowerCase()
  for (const w of tokens) if (title.includes(w.toLowerCase())) hitCount.set(w, (hitCount.get(w) ?? 0) + 1)
}
const active = [...hitCount.entries()].sort((a, b) => b[1] - a[1])
console.log(`候选标题里真的命中了的词：${active.length} 个`)
if (active.length) console.log('  ' + active.slice(0, 15).map(([w, n]) => `${w}(${n})`).join(' · '))

// 有多少条候选会被"碎片词"加分（boost = min(7.5, hits*2.5)）
let boosted = 0
let boostedByJunk = 0
for (const r of rows) {
  const title = String(r.t ?? '').toLowerCase()
  const hits = [...tokens].filter((w) => title.includes(w.toLowerCase()))
  if (!hits.length) continue
  boosted += 1
  const real = hits.filter((w) => prefs.some((p) => w.includes(p.toLowerCase()) || p.toLowerCase().includes(w)))
  if (!real.length) {
    boostedByJunk += 1
    if (boostedByJunk <= 5) console.log(`  [只靠碎片加分] ${hits.slice(0, 4).join('/')} ← ${String(r.t).slice(0, 44)}`)
  }
}
console.log(`\n会被学习词加分的候选：${boosted} 条，其中**只靠碎片**的：${boostedByJunk} 条`)
