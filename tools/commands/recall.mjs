// 翻旧账（2026-10-23 加，主人定：她要"长期记忆"，但上下文不能被日记撑爆）
//
// 为什么要它：日记是无限追加的，她每轮若全文读两本 → 上下文随时间线性涨，
//   几周后就会被压缩（连日记一起被摘要）✗
//   → 平时只读最近 7 天（`diary recent`），"远的事"改成**按需搜索** ✓
//
// 用法:
//   node bili.mjs recall "猫咪"                 # 全部来源里搜（日记 / 记忆卷 / 事件流 / 收藏）
//   node bili.mjs recall "猫咪 大肥鱼" --days 60 # 多个词 = 同一个段落里都要出现 ✓
//   node bili.mjs recall --recent 7d            # 不搜，列最近 7 天都有哪些段（看"我这几天过了什么"）
//   node bili.mjs recall "..." --limit 5 --json # 给脚本/她自己处理
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = process.env.DSH_HOME || path.join(HOME, '.dsh')
const SOURCES = [
  { label: 'whale-diary.md', file: path.join(DSH, 'whale-diary.md'), kind: 'md' },
  { label: 'whale-diary-private.md', file: path.join(DSH, 'whale-diary-private.md'), kind: 'md' },
  { label: 'whale-log.jsonl', file: path.join(DSH, 'whale-log.jsonl'), kind: 'jsonl' },
  { label: 'favorites.json', file: path.join(HOME, '.bili-ai', 'favorites.json'), kind: 'json' },
]
// 记忆卷（按月归档的旧日记，若有）
const MEM_DIR = path.join(DSH, 'memory')
try {
  for (const f of fs.readdirSync(MEM_DIR)) {
    if (/^\d{4}-\d{2}\.md$/.test(f)) SOURCES.push({ label: `memory/${f}`, file: path.join(MEM_DIR, f), kind: 'md' })
  }
} catch {}

const argv = process.argv.slice(2)
const opt = {}
const words = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[k] = true
    else { opt[k] = v; i += 1 }
  } else words.push(a)
}
const LIMIT = Math.max(1, Number(opt.limit) || 8)
const terms = words.join(' ').trim().toLowerCase().split(/[\s,，、]+/).filter(Boolean)
/** "30d" / "7" / "2026-10-01" → 最早时间戳（null = 不限） */
function sinceTs(v) {
  if (!v || v === true) return null
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00').getTime()
  const m = s.match(/^(\d+)\s*d$/i)
  if (m) return Date.now() - Number(m[1]) * 86400000
  if (/^\d+$/.test(s)) return Date.now() - Number(s) * 86400000
  return null
}
const since = sinceTs(opt.days ?? opt.since ?? (opt.recent && opt.recent !== true ? opt.recent : null))
const dayOf = (t) => new Date(t).toLocaleDateString('sv-SE')

/** 把一篇 markdown 切成"按日期"的段落：`## 2026-10-19 · 夜` 起头 ✓ */
function mdBlocks(text, label) {
  const out = []
  let cur = { label, date: null, heading: '(开头)', lines: [] }
  for (const line of text.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(\d{4}-\d{2}-\d{2})(.*)$/)
    if (h2) {
      if (cur.lines.some((l) => l.trim())) out.push(cur)
      cur = { label, date: h2[1], heading: (h2[2] || '').replace(/^[\s·—-]+/, '').trim() || h2[1], lines: [] }
    } else if (/^#\s/.test(line) && cur.date === null) {
      cur.heading = line.replace(/^#\s*/, '').trim()
    } else {
      cur.lines.push(line)
    }
  }
  if (cur.lines.some((l) => l.trim())) out.push(cur)
  return out
}

function jsonlBlocks(text, label) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      const at = o.at ? new Date(o.at) : null
      out.push({ label, date: at ? dayOf(at.getTime()) : null, heading: `${o.kind ?? 'event'}${o.target ? ' → ' + o.target : ''}`, lines: [String(o.note ?? '')] })
    } catch {}
  }
  return out
}

function jsonBlocks(text, label) {
  try {
    const j = JSON.parse(text)
    return (j.items ?? []).map((x) => ({
      label, date: x.at ? dayOf(new Date(x.at).getTime()) : null,
      heading: `收藏 · ${x.kind ?? ''}`, lines: [`${x.bv ?? ''} 《${x.title ?? ''}》 ${x.reason ?? ''}`],
    }))
  } catch { return [] }
}

const blocks = []
for (const s of SOURCES) {
  let text = ''
  try { text = fs.readFileSync(s.file, 'utf8') } catch { continue }
  if (s.kind === 'md') blocks.push(...mdBlocks(text, s.label))
  else if (s.kind === 'jsonl') blocks.push(...jsonlBlocks(text, s.label))
  else blocks.push(...jsonBlocks(text, s.label))
}
const inRange = (b) => !since || !b.date || sinceTs(b.date) >= since
const visible = blocks.filter(inRange)

// ── --recent：不搜，只列"这几天都有哪些段"（用来找线索，再精确 recall）──
if (opt.recent) {
  const list = visible.slice().reverse().slice(0, LIMIT * 4)
  if (opt.json) { console.log(JSON.stringify(list.map((b) => ({ date: b.date, label: b.label, heading: b.heading })), null, 2)); process.exitCode = 0 }
  else {
    if (!list.length) console.log('（这段时间没有记录）')
    else {
      console.log(`最近 ${opt.recent === true ? '几' : opt.recent} 的段落（${list.length} 条，新→旧）：`)
      for (const b of list) {
        const first = (b.lines.find((l) => l.trim().replace(/^#+\s*/, '').length) ?? '').trim().slice(0, 46)
        console.log(`  ${b.date ?? '----'} · ${b.heading}${first ? '  —— ' + first : ''}`)
      }
      console.log('\n要细看某天：`recall "关键词" --days N`（N 天前到现在）')
    }
    process.exitCode = 0
  }
} else if (!terms.length) {
  console.error('用法: node bili.mjs recall "关键词" [--days 30] [--limit 8] [--json]\n       node bili.mjs recall --recent 7d')
  process.exitCode = 2
} else {
  // 段落级命中：多个词要求**同一段都出现**（比逐行更准，日记里一段就是一件事 ✓）
  const hits = []
  for (const b of visible) {
    const hay = (b.heading + '\n' + b.lines.join('\n')).toLowerCase()
    if (!terms.every((t) => hay.includes(t))) continue
    const idx = []
    b.lines.forEach((l, i) => { if (terms.some((t) => l.toLowerCase().includes(t))) idx.push(i) })
    hits.push({ b, idx, score: terms.reduce((n, t) => n + (hay.split(t).length - 1), 0) })
  }
  hits.sort((a, b) => String(b.b.date ?? '').localeCompare(String(a.b.date ?? '')))
  const top = hits.slice(0, LIMIT)
  if (opt.json) {
    console.log(JSON.stringify(top.map((h) => ({
      date: h.b.date, source: h.b.label, heading: h.b.heading,
      lines: h.idx.flatMap((i) => [h.b.lines[i - 1], h.b.lines[i], h.b.lines[i + 1]].filter((x) => x !== undefined && x.trim())).slice(0, 12),
    })), null, 2))
    process.exitCode = 0
  } else if (!top.length) {
    console.log(`（没找到「${terms.join(' ') }」${since ? `（近 ${opt.days ?? opt.since ?? opt.recent} 天内）` : ''}）`)
    console.log('  换个词试试，或者先 `recall --recent 30d` 看看那阵子都有什么')
    process.exitCode = 0
  } else {
    console.log(`找到 ${hits.length} 段，显示最近的 ${top.length} 段（新→旧）：\n`)
    for (const h of top) {
      console.log(`[${h.b.label} · ${h.b.date ?? '?'} · ${h.b.heading}]`)
      const shown = new Set()
      for (const i of h.idx.slice(0, 3)) {
        for (let k = Math.max(0, i - 1); k <= Math.min(h.b.lines.length - 1, i + 1); k += 1) {
          const l = h.b.lines[k]
          if (!l || !l.trim() || shown.has(k)) continue
          shown.add(k)
          console.log('  ' + l.trim().slice(0, 300))
        }
        if (shown.size > 8) break
      }
      console.log('')
    }
    process.exitCode = 0
  }
}
